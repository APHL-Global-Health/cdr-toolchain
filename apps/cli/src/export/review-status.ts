import type { TestDataHeader } from "disalab";
import { baseIndex } from "./obr-sets.js";
import type { BlobOffsets } from "../config/blob-offsets.js";
import { decodeLongDatetime, decodeShortDatetime } from "../compare/disa-datetime-candidates.js";

export interface ObrStatus {
  /** Null ⇒ undeterminable (deployment has no measured initials offset). */
  status: "X" | "I" | "F" | "R" | null;
  authorisedAt: Date | null;
  headerUndecodable: boolean;
}

export interface PanelIteration {
  panelCode: string;
  panelIndex: number;
  datestamp: Date | null;
  header: TestDataHeader | null;
}

export interface BuildStatusArgs {
  iterations: readonly PanelIteration[];
  obrOf: (panelCode: string, panelIndex: number) => number | null;
  /**
   * Observation count per obr_set_id, counted BEFORE any emit-time exclusion.
   * Zero ⇒ interim. See the `I` branch below for why the pre-exclusion count is
   * the only correct input.
   */
  obsCountByObr: ReadonlyMap<number, number>;
  /**
   * The obr_set_ids that carry a DISA rejection signal — PER OBR, not per
   * specimen. RJREA is an observation, so it belongs to the panel it was
   * recorded on; a rejected panel must not force `X` onto a sibling panel that
   * was tested and resulted. Pass an empty set when nothing was rejected.
   */
  rejectedObrs: ReadonlySet<number>;
  offsets: BlobOffsets;
}

/** Same precedence supersedePanelIterations uses: datestamp, then panelIndex. */
function isLater(a: PanelIteration, b: PanelIteration): boolean {
  const am = a.datestamp?.getTime() ?? -Infinity;
  const bm = b.datestamp?.getTime() ?? -Infinity;
  if (am !== bm) return am > bm;
  return a.panelIndex > b.panelIndex;
}

function decodeReviewedAt(header: TestDataHeader, offsets: BlobOffsets): Date | null {
  if (offsets.reviewedAt === null) return null;
  const { start, kind } = offsets.reviewedAt;
  const fn = kind === "long-datetime" ? decodeLongDatetime : decodeShortDatetime;
  return fn(header.raw, start, 2000, 2100);
}

/**
 * ⛔ Resolves the header PER OBR, not per panel code.
 *
 * supersedePanelIterations (compare/result-mapping.ts) keys its winner on
 * `panelCode` ALONE, while OBR grain is (panelCode, base(TESTINDEX)). Those
 * disagree whenever one panel code occupies two OBRs — reusing that winner
 * here would attach one panel's review state to a sibling OBR. This function
 * deliberately re-resolves per OBR using the same ordering rule.
 */
export function buildStatusByObr(args: BuildStatusArgs): Map<number, ObrStatus> {
  const { iterations, obrOf, obsCountByObr, rejectedObrs, offsets } = args;

  const winnerByObr = new Map<number, PanelIteration>();
  for (const it of iterations) {
    // baseIndex is applied here AND inside the real linkObsToObr lookup
    // (obr-sets.ts:122). That double application is deliberate and harmless —
    // baseIndex is idempotent (<=100 passes through) — and it keeps this
    // function correct against any obrOf, including test doubles that do not
    // collapse the +100 second-slot convention themselves.
    const obr = obrOf(it.panelCode, baseIndex(it.panelIndex));
    if (obr === null) continue;
    const cur = winnerByObr.get(obr);
    if (cur === undefined || isLater(it, cur)) winnerByObr.set(obr, it);
  }

  const out = new Map<number, ObrStatus>();
  const obrIds = new Set<number>([
    ...winnerByObr.keys(),
    ...obsCountByObr.keys(),
    // A rejection-only panel produces no observations at all (flattenDisa drops
    // the RJREA padding), so it can be absent from both maps above. Include it
    // or its `X` would be lost.
    ...rejectedObrs,
  ]);
  for (const obr of obrIds) {
    const winner = winnerByObr.get(obr) ?? null;
    const headerUndecodable = winner !== null && winner.header === null;

    if (rejectedObrs.has(obr)) {
      out.set(obr, { status: "X", authorisedAt: null, headerUndecodable });
      continue;
    }
    // ⛔ `I` means "this panel genuinely produced NO results" — never "we chose
    // not to emit its results". obsCountByObr MUST therefore be counted before
    // the emit-time exclusion (opts.excludeObs / documentation classification),
    // or a panel whose only observation is documentation is mislabelled interim
    // while v1 reports F. Measured 2026-08-02: 30 of 53 result_status
    // mismatches were exactly this (HIVPC panels, PARMDICT context 77).
    if ((obsCountByObr.get(obr) ?? 0) === 0) {
      out.set(obr, { status: "I", authorisedAt: null, headerUndecodable });
      continue;
    }
    const header = winner?.header ?? null;
    // Unconfigured deployment: X and I are STILL derivable above (rejection and
    // observation count need no offsets), but F-vs-R is not. Emit null rather
    // than defaulting to R — null is today's behaviour, R would be a false
    // claim that the panel was left unverified.
    if (offsets.reviewerInitials === null) {
      out.set(obr, { status: null, authorisedAt: null, headerUndecodable });
      continue;
    }
    const reviewed = header !== null && header.initialsAt(offsets.reviewerInitials) !== null;
    out.set(obr, {
      status: reviewed ? "F" : "R",
      authorisedAt: reviewed && header !== null ? decodeReviewedAt(header, offsets) : null,
      headerUndecodable,
    });
  }
  return out;
}

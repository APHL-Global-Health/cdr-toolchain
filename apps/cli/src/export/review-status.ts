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
  /** Kept observation count per obr_set_id. Zero ⇒ interim. */
  obsCountByObr: ReadonlyMap<number, number>;
  /** Request-level rejection from detectDisaRejection. */
  rejected: boolean;
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
  const { iterations, obrOf, obsCountByObr, rejected, offsets } = args;

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
  const obrIds = new Set<number>([...winnerByObr.keys(), ...obsCountByObr.keys()]);
  for (const obr of obrIds) {
    const winner = winnerByObr.get(obr) ?? null;
    const headerUndecodable = winner !== null && winner.header === null;

    if (rejected) {
      out.set(obr, { status: "X", authorisedAt: null, headerUndecodable });
      continue;
    }
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

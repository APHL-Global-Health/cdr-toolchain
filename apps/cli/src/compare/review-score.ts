/**
 * Pure scoring for the review-signal search. Kept separate from the command so
 * the arithmetic is unit-testable without a database.
 */

export interface LabelledPanel {
  /** TESTDATA_STATUS reviewer-initials slot is non-zero. */
  initialsPresent: boolean;
  /** v1 Requests.HL7ResultStatusCode — the ground truth label. */
  v1Status: string;
}

export interface FRMatrix {
  fCorrect: number;
  rCorrect: number;
  fMiss: number;
  rMiss: number;
  total: number;
  accuracy: number;
}

/**
 * Rule under test: initialsPresent ⇒ F, else R.
 * Only F and R rows are scorable — I comes from "no results" and X from the
 * rejection signal, so counting them here would measure the wrong thing.
 */
export function scoreFR(rows: readonly LabelledPanel[]): FRMatrix {
  let fCorrect = 0, rCorrect = 0, fMiss = 0, rMiss = 0;
  for (const r of rows) {
    const s = r.v1Status.trim().toUpperCase();
    if (s !== "F" && s !== "R") continue;
    if (s === "F") {
      if (r.initialsPresent) fCorrect++; else fMiss++;
    } else {
      if (r.initialsPresent) rMiss++; else rCorrect++;
    }
  }
  const total = fCorrect + rCorrect + fMiss + rMiss;
  return { fCorrect, rCorrect, fMiss, rMiss, total, accuracy: total === 0 ? 0 : (fCorrect + rCorrect) / total };
}

export interface TimestampRow {
  /** Candidate decode of the header bytes. Null when the candidate did not parse. */
  decoded: Date | null;
  /** v1 Requests.AuthorisedDateTime — the ground truth. */
  target: Date;
}

export interface TimestampScore {
  hits: number;
  total: number;
  rate: number;
}

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
}

/**
 * Extract wall-clock components from a Date, honoring the frame the caller
 * knows that side was produced in. Mirrors the technique in `toWallClock`
 * (compare/comparators.ts) — component comparison instead of instant
 * comparison — but review-score's two sides are BOTH `Date` objects built in
 * different, fixed frames, so (unlike comparators.ts) the extraction mode
 * must be picked per field rather than inferred from the value's type:
 *
 * - `decoded` timestamps come from the candidate decoders
 *   (decodeLongDatetime in disa-datetime-candidates.ts), which build the
 *   Date with the LOCAL constructor (`new Date(y, m, d, h, mi, 0)`). Local
 *   getters recover exactly the components that were passed in, on any host.
 * - `target` timestamps come from mssql (Requests.AuthorisedDateTime). The
 *   driver returns SQL DATETIME values as Date objects whose UTC-component
 *   getters equal the stored wall clock.
 *
 * Comparing both sides "as instants" (Math.abs(a.getTime() - b.getTime()))
 * conflates these two frames and introduces a spurious offset equal to the
 * host's UTC offset (a constant 3h on Africa/Dar_es_Salaam) — that was the
 * bug: correct decodes were being scored as misses.
 */
function wallClock(d: Date, frame: "local" | "utc"): WallClock {
  return frame === "local"
    ? { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds() }
    : {
        y: d.getUTCFullYear(),
        mo: d.getUTCMonth(),
        d: d.getUTCDate(),
        h: d.getUTCHours(),
        mi: d.getUTCMinutes(),
        s: d.getUTCSeconds(),
      };
}

/** Wall-clock components re-expressed as a UTC epoch, purely so two wall
 * clocks can be diffed in milliseconds without the host timezone leaking
 * back in. */
function wallClockEpochMs(w: WallClock): number {
  return Date.UTC(w.y, w.mo, w.d, w.h, w.mi, w.s);
}

/**
 * A null decode is a MISS, never a skipped row. Skipping would let a candidate
 * that parses 1% of rows perfectly report a 100% rate.
 *
 * Tolerance is in seconds and measures how far apart the two WALL CLOCKS may
 * be (see wallClock() above), not how far apart the two absolute instants
 * are. The comparison is inclusive: a difference exactly equal to the
 * tolerance counts as a hit.
 */
export function scoreTimestamp(rows: readonly TimestampRow[], toleranceSec: number): TimestampScore {
  let hits = 0;
  for (const r of rows) {
    if (r.decoded === null) continue;
    const decodedMs = wallClockEpochMs(wallClock(r.decoded, "local"));
    const targetMs = wallClockEpochMs(wallClock(r.target, "utc"));
    if (Math.abs(decodedMs - targetMs) <= toleranceSec * 1000) hits++;
  }
  const total = rows.length;
  return { hits, total, rate: total === 0 ? 0 : hits / total };
}

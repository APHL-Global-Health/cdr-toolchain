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

/**
 * A null decode is a MISS, never a skipped row. Skipping would let a candidate
 * that parses 1% of rows perfectly report a 100% rate.
 */
export function scoreTimestamp(rows: readonly TimestampRow[], toleranceSec: number): TimestampScore {
  let hits = 0;
  for (const r of rows) {
    if (r.decoded === null) continue;
    if (Math.abs(r.decoded.getTime() - r.target.getTime()) <= toleranceSec * 1000) hits++;
  }
  const total = rows.length;
  return { hits, total, rate: total === 0 ? 0 : hits / total };
}

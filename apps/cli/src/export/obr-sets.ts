/**
 * v1's grain is (RequestID, OBRSetID) — one row per ORDERED PANEL. This module
 * derives that grain from DISA.
 *
 * ⛔ obr_set_id is the 1-based POSITION in SpecimenRecpt.TestOrders[] — NOT
 * TESTINDEX. Measured 2026-07-17 on 3,874 random labs, graded on panel-code
 * SEQUENCE against v1:
 *
 *   raw TESTINDEX                93.6%   <- the claim this replaces
 *   dense rank of TESTINDEX      98.3%
 *   position in TestOrders[]     99.95%  <- this
 *
 * v1's OBRSetID is ALWAYS dense 1..N (not_1_based 0, non_contiguous 0); DISA's
 * TESTINDEX has gaps (HIVVL#2, HIVVL#4) and can start at 2, so TESTINDEX only
 * matched coincidentally, whenever it happened to already be dense.
 *
 * The residual 0.05% is v1's STALENESS, not a missing rule: v1 recorded RPR at
 * 18:26 while DISA re-ran it at 18:30 and 18:34. Do not encode it.
 *
 * See openldr_ce docs/superpowers/specs/2026-07-17-obr-set-id-design.md §2.
 */

/** One ordered panel = one OBR = one v2 lab_request. */
export interface ObrSet {
  /** 1-based position in TestOrders[]. v1's OBRSetID. */
  obr_set_id: number;
  /** DISA TESTCODE / v1 LIMSPanelCode for this OBR. */
  panelCode: string;
}

/**
 * DISA stores a panel's second slot at TESTINDEX + 100 (COL#1 -> COL#101).
 * Measured over the WHOLE population (TESTINDEX is a real TESTDATA column, not
 * a blob field): 397 of 191,121 rows are >100, ALL 397 have a base partner at
 * idx-100 with the SAME LABNO+TESTCODE, and NONE exceed 200 (max 113) — so the
 * offset is never applied twice.
 *
 * ⚠ WHAT it means (rerun? amendment? archive copy?) is UNKNOWN and deliberately
 * NOT encoded. We only need to know which OBR owns the row, and the structure
 * answers that on 397/397.
 */
export function baseIndex(testIndex: number): number {
  return testIndex > 100 ? testIndex - 100 : testIndex;
}

/**
 * Build the OBR list for a lab from its ordered panel codes, in sequence.
 *
 * ⚠ Order is PRESERVED, never regrouped by code: v1 keeps [HIVVL,VLID,HIVVL,
 * HIVVL] interleaved (TDS0068941). Grouping scored 99.64% vs this rule's 99.95%.
 *
 * ⚠ Ordered-but-unresulted panels are INCLUDED — they have zero TestResults and
 * still get a v1 row (status 'I' on 7/7 measured). This is why the source is
 * TestOrders and not TestResults: an OBR is an ORDER.
 */
export function deriveObrSets(testOrders: readonly unknown[]): ObrSet[] {
  const out: ObrSet[] = [];
  for (const raw of testOrders) {
    const panelCode = String(raw ?? "").trim();
    if (panelCode.length === 0) continue;
    out.push({ obr_set_id: out.length + 1, panelCode });
  }
  return out;
}

/** The identifying pair of a decoded panel iteration. `DisaObs` (and the
 *  `PanelGroup` built from it) both satisfy this structurally. */
export interface PanelIterationRef {
  panelCode: string;
  panelIndex: number;
}

/**
 * Build a lookup from (panelCode, panelIndex) to obr_set_id.
 *
 * RULE P — per-panel-code rank: the i-th distinct base(TESTINDEX) of code C maps
 * to the i-th occurrence of C in TestOrders.
 *
 * ⚠ Chosen over global rank as a JUDGEMENT, not a finding: both scored
 * 1425/1425 and disagreed 0 times on real data (spec §4.1), so the measurement
 * does not discriminate. P is preferred because global rank misfiles when the
 * results don't cover every order ([A,B] resulting only B files B under A) —
 * a shape no live lab exercises.
 *
 * Returns null for a pair that maps to no OBR (an unknown code, or a surplus
 * iteration beyond the number of times its code was ordered) — the caller must
 * decide, never guess.
 */
export function linkObsToObr(
  sets: readonly ObrSet[],
  iterations: readonly PanelIterationRef[],
): (panelCode: string, panelIndex: number) => number | null {
  // code -> the OBR ids ordered for it, in TestOrders sequence
  const slotsByCode = new Map<string, number[]>();
  for (const s of sets) {
    const arr = slotsByCode.get(s.panelCode) ?? [];
    arr.push(s.obr_set_id);
    slotsByCode.set(s.panelCode, arr);
  }

  // code -> its distinct base indexes, ascending
  const basesByCode = new Map<string, number[]>();
  for (const it of iterations) {
    const b = baseIndex(it.panelIndex);
    const arr = basesByCode.get(it.panelCode) ?? [];
    if (!arr.includes(b)) arr.push(b);
    basesByCode.set(it.panelCode, arr);
  }
  for (const arr of basesByCode.values()) arr.sort((a, b) => a - b);

  // (code, base) -> obr_set_id, positionally
  const lookup = new Map<string, number>();
  for (const [code, bases] of basesByCode) {
    const slots = slotsByCode.get(code) ?? [];
    bases.forEach((b, i) => {
      const obr = slots[i];
      if (obr !== undefined) lookup.set(`${code}\t${b}`, obr);
    });
  }

  return (panelCode, panelIndex) =>
    lookup.get(`${panelCode}\t${baseIndex(panelIndex)}`) ?? null;
}

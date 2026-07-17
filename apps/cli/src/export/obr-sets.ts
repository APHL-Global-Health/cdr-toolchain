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

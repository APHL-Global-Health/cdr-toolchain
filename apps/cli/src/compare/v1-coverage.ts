/**
 * Classification of every v1 column.
 *
 * The coverage guard (`v1-coverage.test.ts`) asserts this against the GENERATED
 * snapshot (`v1-schema.json`), not against our row types. `OpenLdrV1Request` is
 * the 26 columns `REQUEST_COLUMNS` bothers to SELECT; v1's Requests table has 60.
 * Grading the fetch and calling it "every v1 column" is the same
 * trust-a-derived-artifact error as `count(col)` and the blob layer: **a
 * TypeScript interface is not a schema.**
 */

/**
 * LIS-generated bookkeeping — stamped by OpenLDR when it ingests an HL7 message.
 * Nothing on the CDR side can or should produce them.
 *
 * ⚠ `LabResults` spells it `LIMSVersionStamp` (capital S) while `Requests` uses
 * `LIMSVersionstamp`. That is v1's own inconsistency, verified in both
 * INFORMATION_SCHEMA and `export/types.ts`. CE standardises on the capital-S form
 * in ITS OWN schema — but these lists must keep mirroring v1 exactly, because
 * `v1-transform` writes into v1's real tables. **Do not "fix" the typo here.**
 */
export const V1_REQUEST_BOOKKEEPING: readonly string[] = [
  "DateTimeStamp",
  "Versionstamp",
  "LIMSDateTimeStamp",
  "LIMSVersionstamp",
];

export const V1_RESULT_BOOKKEEPING: readonly string[] = [
  "DateTimeStamp",
  "Versionstamp",
  "LIMSDateTimeStamp",
  "LIMSVersionStamp",
];

/**
 * Not a v1 column at all: `fetchRequestByRequestId` synthesises it by aggregating
 * `LIMSPanelCode` across sibling OBR rows (`openldr.ts:114-124`). Excluded from
 * the snapshot guard because the snapshot only knows real columns — grading it
 * would grade our own aggregation, not the export.
 */
export const V1_REQUEST_DERIVED: readonly string[] = ["allPanelCodes"];

export interface NotCarried {
  column: string;
  /** The measurement behind the decision, WITH its date. Never "n/a". */
  measured: string;
  reason: string;
  decidedBy: string;
  /** YYYY-MM-DD. */
  decidedOn: string;
  /**
   * Set when the column is EXPECTED BACK, with what would bring it. "Dropped for
   * now" without this is a claim the next reader cannot distinguish from "dropped
   * forever" — and the stated plan is *"we will slowly add them back bit by bit"*.
   */
  revisit?: string;
}

const USER = "user";
const ON = "2026-07-17";
const REVISIT_SWEEP = "user: 'some of them may need to be revisited ... we will slowly add them back bit by bit'";

/**
 * ⛔ A DECISION, not a measurement.
 *
 * These are dropped because CE **chose not to model them** — NOT because they are
 * unpopulated. TDS is **1 site of 22**; a population count from Zambia does NOT
 * make an entry here wrong. **Do not "correct" one by pointing at a count** —
 * that is what `revisit` is for.
 */
export const V1_REQUEST_NOT_CARRIED: readonly NotCarried[] = [
  {
    column: "WorkUnits",
    measured: "0 non-zero of 174,261 (TDS, 2026-07-17)",
    reason: "dead; workload units are out of CE scope",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "CostUnits",
    measured: "36,374 non-zero of 174,261 = 20.9% (TDS, 2026-07-17)",
    reason:
      "billing/cost units are out of CE scope REGARDLESS of population. Asked explicitly rather than inferred: at ~20% the 'barely used' rationale that covers the rest of this table does NOT reach it. Its sibling WorkUnits is dead; CostUnits is not. Do not 'correct' this by pointing at the 36,374 — the number was known when the call was made.",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "Deceased",
    measured: "0 non-zero of 174,261 (TDS, 2026-07-17)",
    reason: "dead",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "TargetTimeDays",
    measured: "0 non-zero of 174,261 (TDS, 2026-07-17)",
    reason: "dead; turnaround targets are out of CE scope",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "TargetTimeMins",
    measured: "0 non-zero of 174,261 (TDS, 2026-07-17)",
    reason: "dead; turnaround targets are out of CE scope",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "LOINCPanelCode",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason:
      "CE resolves LOINC through its own terminology service; importing v1's empty LOINC column would import a problem CE already solved",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "LIMSPreReg_RegistrationDateTime",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason: "pre-registration workflow, never used",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "LIMSPreReg_ReceivedDateTime",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason: "pre-registration workflow, never used",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "LIMSPreReg_RegistrationFacilityCode",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason: "pre-registration workflow, never used",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "AdmitAttendDateTime",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason: "legacy admission timestamp; CE does not model encounters",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "ReferringRequestID",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason: "legacy referral linkage, unused",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "HL7EthnicGroupCode",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason: "unused AND sensitive — dropped on principle as well as on population",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "HL7SpecimenSourceCode",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason:
      "specimen SITE is never populated. ⚠ Specimen SOURCE *is* carried — see V2_REQUEST_FIELDS.specimen_code, which grades LIMSSpecimenSourceCode. Different concept, similar name.",
    decidedBy: USER,
    decidedOn: ON,
    revisit: REVISIT_SWEEP,
  },
  {
    column: "HL7SpecimenSiteCode",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason: "specimen site never populated",
    decidedBy: USER,
    decidedOn: ON,
    revisit: REVISIT_SWEEP,
  },
  {
    column: "LIMSSpecimenSiteCode",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason: "specimen site never populated",
    decidedBy: USER,
    decidedOn: ON,
    revisit: REVISIT_SWEEP,
  },
  {
    column: "LIMSSpecimenSiteDesc",
    measured: "0 of 174,261 (TDS, 2026-07-17)",
    reason: "specimen site never populated",
    decidedBy: USER,
    decidedOn: ON,
    revisit: REVISIT_SWEEP,
  },
  {
    column: "Newborn",
    measured: "6 non-zero of 174,261 (TDS, 2026-07-17) — NOISE, not zero",
    reason: "negligible; CE does not model it",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "Repeated",
    measured: "3 non-zero of 174,261 (TDS, 2026-07-17) — NOISE, not zero",
    reason: "negligible; CE does not model it",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "ReceivingFacilityCode",
    measured:
      "174,261 of 174,261 — a CONSTANT 'TDS' (TDS, 2026-07-17). POPULATED, not empty: filing this as 'empty' would be a false measurement.",
    reason:
      "duplicate of TestingFacilityCode, which IS graded — measured, both are 'TDS' on every row. Derivable from site config.",
    decidedBy: USER,
    decidedOn: ON,
    revisit: REVISIT_SWEEP,
  },
  {
    column: "EncryptedPatientID",
    measured:
      "88,115 of 174,261 = 50.6%; 44,829 DISTINCT values; one spanning 116 requests (TDS, 2026-07-17)",
    reason:
      "PHI-adjacent, and it is v1's OWN hash from v1's ingest — CE should not inherit another system's derivation. ⚠ NOT dropped as redundant: that premise was FALSIFIED by the measurement above, it is a working pseudonymous patient key. Its real home is v2's patients.encrypted_patient_id, a column CDR never populates. ⚠ NEVER add this to the SELECT: the gate prints values into diff rows and committed findings docs. Patient identity is deferred to LAST by decision; patient_guid = requestId is SETTLED (a commercial blocker, not a technical one).",
    decidedBy: USER,
    decidedOn: ON,
    revisit: "deferred, not closed — patient identity is its own workstream, taken last",
  },
];

export const V1_RESULT_NOT_CARRIED: readonly NotCarried[] = [
  {
    column: "WorkUnits",
    measured: "227 non-zero of 643,855 = 0.04% (TDS, 2026-07-17)",
    reason: "noise; workload units are out of CE scope",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "CostUnits",
    measured: "127,140 non-zero of 643,855 = 19.7% (TDS, 2026-07-17)",
    reason: "billing/cost units are out of CE scope REGARDLESS of population — see the Requests entry",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "Note",
    measured:
      "68,645 of 643,855 = 10.7% (TDS, 2026-07-17) — a BIT (0 x 575,210 / 1 x 68,645), NOT free text",
    reason: "legacy flag with undocumented meaning",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "DateTimeValue",
    measured: "33,004 of 643,855 = 5.1% (TDS, 2026-07-17)",
    reason:
      "a TYPED PROJECTION, not data: for 30,198 of its 33,004 rows LIMSRptResult already holds the same value as text ('01/03/2013' <-> 2013-03-01), which CDR emits as result_value. The exception was CHECKED, not assumed: the 2,806 rows where LIMSRptResult is empty are ALL one observation — TPT 'Tranportation Time' (v1's own typo) under panel COL. Logistics, not a clinical result. ⚠ It is NOT a per-result timestamp — measured (EQSED 'Expiration Date' / TPD 'Transportation Date', HL7ResultTypeCode='D'), so 'v1 has no per-result timestamp' STANDS.",
    decidedBy: USER,
    decidedOn: ON,
  },
  {
    column: "LOINCCode",
    measured: "2 of 643,855 (TDS, 2026-07-17)",
    reason: "dead; CE resolves LOINC through its own terminology service",
    decidedBy: USER,
    decidedOn: ON,
  },
];

/**
 * ⛔ Deliberately EMPTY — and it stays defined.
 *
 * Every column that would have landed here was swept into `not_carried` as a
 * SCOPE decision. The distinction is load-bearing and must not be collapsed:
 *
 *   measured_empty — "we observed no data, on ONE of 22 sites". Falsified by the
 *                    next site's data. If wrong, a REAL field is silently uncovered.
 *   not_carried    — "CE deliberately does not model this". Reversed only by a
 *                    person. If wrong, nothing.
 *
 * Conflating them is how "we have no evidence" becomes "we decided" without
 * anyone deciding.
 *
 * ⚠ NEITHER bucket is graded, so a mistake in either is INVISIBLE in the report.
 * These are the two to review by hand, not by test.
 */
export const V1_REQUEST_MEASURED_EMPTY: readonly NotCarried[] = [];
export const V1_RESULT_MEASURED_EMPTY: readonly NotCarried[] = [];

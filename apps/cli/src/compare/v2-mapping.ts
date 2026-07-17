import type { V2LabResult, V2Payload } from "../export/types.js";
import type { OpenLdrV1LabResult, OpenLdrV1Request } from "../openldr.js";
import {
  datetime,
  stringCi,
  stringCiLoose,
  stringCiStripV1Prefix,
  type CompareResult,
} from "./comparators.js";

/**
 * The V2 <-> v1 field-def table: the SECOND gate.
 *
 * The original table (`mapping.ts`) grades the disalab DECODER — SpecimenRecpt
 * against v1. It has never graded the EXPORT (`toV2`), so every export stub is
 * structurally invisible to it: it can be 100% green while `abnormal_flag` is
 * hardcoded null against 107,602 real v1 flags. This table closes that.
 *
 * NOTE WHAT IS ABSENT, deliberately:
 *  - **No candidate arrays.** The old table lets a field offer several sources
 *    and counts "a match on either" as a match — which is precisely why it could
 *    never discover WHICH source v1 means (see `collected_datetime` below).
 *  - **No `allowDisaEmpty`.** If we cannot say which v1 column a V2 field maps
 *    to, we do not know the mapping. That is the finding, not a licence to
 *    widen the assertion until it passes.
 *
 * Three mechanisms only, and they are NOT interchangeable:
 *  1. a **def** — strict, graded.
 *  2. a **conditional rule** (`emptyIsCorrectWhen`) — the correct value depends
 *     on v1's state. It IS the mapping, so it carries no tolerance count.
 *  3. an **exception** — a structural gap: one side has no counterpart at all.
 */
export interface V2FieldDef {
  field: string;
  /** The v1 column this field maps to. Typed against the real row shape so a
   *  renamed column is a compile error, and drives the coverage guard. */
  v1Column: keyof OpenLdrV1Request;
  /** ONE source. Returning an array is not supported — see the header. */
  getV2: (p: V2Payload) => unknown;
  /** ONE source. */
  getV1: (r: OpenLdrV1Request) => unknown;
  comparator: (v2: unknown, v1: unknown) => CompareResult;
  /**
   * A CONDITIONAL RULE, not a tolerance: when this predicate holds, an EMPTY V2
   * value is the CORRECT value and scores `match` instead of `only_v1`.
   *
   * Use ONLY where the correct value provably depends on v1's own state, and
   * cite the measurement. A predicate that is really "we tolerate this
   * mismatch" is an exception, and needs evidence — not a lambda that quietly
   * turns red into green. That is how `allowDisaEmpty` happened.
   */
  emptyIsCorrectWhen?: (v1: OpenLdrV1Request) => boolean;
}

/**
 * A STRUCTURAL gap: the field genuinely has no counterpart on the other side, so
 * there is nothing to compare and the gap is total and permanent by
 * construction.
 *
 * ⚠ DEVIATION FROM THE PLAN, stated so it is reviewable: the plan specified
 * `expected: number` ("the mismatch count we accept") on every exception, to
 * stop the registry becoming the next `allowDisaEmpty`. That model fits a
 * *tolerated mismatch* — "we accept exactly N known-bad rows, and N+1 fails".
 * It does not fit these: a column with no counterpart mismatches on EVERY row,
 * so the honest `expected` would be "the sample size", which changes with
 * --limit and would pin nothing.
 *
 * The anti-`allowDisaEmpty` guard is instead structural and enforced by tests:
 *  - every exception must carry real `evidence`, not an assertion;
 *  - no field may be both graded and excepted (an exception cannot silence a def);
 *  - every exception names a real v1 column (no phantoms).
 * When a genuine tolerated-mismatch case appears, add `maxNonMatch` then — with
 * the measured count. Day one there are none.
 */
export interface V2FieldException {
  field: string;
  v1Column: keyof OpenLdrV1Request;
  /** WHY V2 and v1 cannot agree. */
  reason: string;
  /** The measurement or citation that PROVES it — not an assertion. */
  evidence: string;
}

/**
 * v1 columns that are not data: bookkeeping, or derived by our own fetch layer.
 * `allPanelCodes` is not a column at all — `fetchRequestByRequestId` synthesises
 * it by aggregating LIMSPanelCode across sibling OBR rows (openldr.ts:114-124).
 * Grading it would grade our own aggregation, not the export.
 */
export const V1_REQUEST_BOOKKEEPING: readonly string[] = ["allPanelCodes"];

const lr = (p: V2Payload) => p.lab_request;

/** v1 prepends a "DISA" system prefix to facility codes; reuse the same rule the
 *  DISA<->v1 table uses (mapping.ts:95) rather than inventing a second one. */
const facilityCode = stringCiStripV1Prefix("DISA");

export const V2_REQUEST_FIELDS: readonly V2FieldDef[] = [
  {
    field: "request_id",
    v1Column: "RequestID",
    getV2: (p) => lr(p).request_id,
    getV1: (r) => r.RequestID,
    comparator: stringCi,
  },
  {
    field: "requesting_facility_code",
    v1Column: "RequestingFacilityCode",
    getV2: (p) => lr(p).requesting_facility_code?.concept_code ?? null,
    getV1: (r) => r.RequestingFacilityCode,
    comparator: facilityCode,
  },
  {
    field: "testing_facility_code",
    v1Column: "TestingFacilityCode",
    getV2: (p) => lr(p).testing_facility_code?.concept_code ?? null,
    getV1: (r) => r.TestingFacilityCode,
    comparator: facilityCode,
  },
  {
    field: "panel_code",
    v1Column: "LIMSPanelCode",
    getV2: (p) => lr(p).panel_code?.concept_code ?? null,
    getV1: (r) => r.LIMSPanelCode,
    comparator: stringCi,
  },
  {
    field: "panel_desc",
    v1Column: "LIMSPanelDesc",
    getV2: (p) => lr(p).panel_code?.display_name ?? null,
    getV1: (r) => r.LIMSPanelDesc,
    // Loose: both sides carry the codebook description, but v1's column is a
    // varchar and truncates. Substring containment, not equality.
    comparator: stringCiLoose,
  },
  {
    field: "specimen_code",
    v1Column: "LIMSSpecimenSourceCode",
    getV2: (p) => lr(p).specimen_code?.concept_code ?? null,
    getV1: (r) => r.LIMSSpecimenSourceCode,
    comparator: stringCi,
  },
  {
    field: "specimen_desc",
    v1Column: "LIMSSpecimenSourceDesc",
    getV2: (p) => lr(p).specimen_code?.display_name ?? null,
    getV1: (r) => r.LIMSSpecimenSourceDesc,
    comparator: stringCiLoose,
  },
  {
    // ⚠ D4 — THE LOAD-BEARING ONE. v1 collapses DISA's TakenDateTime and
    // CollectedDateTime into a single SpecimenDateTime. The old gate offered
    // both as candidates, so "a match on either wins" — which is exactly why it
    // could never tell us which one v1 actually means.
    //
    // Asserted STRICTLY against `collected`: on 3 of 3 real requests
    // v1.SpecimenDateTime equalled collected exactly (13:30 / 10:00 / 09:00)
    // while taken differed by up to 5 hours. That is 3 requests, not a proof —
    // so let the report prove or refute it at scale. If this comes back
    // systematically red, the fix slice follows the DATA, not this comment.
    field: "collected_datetime",
    v1Column: "SpecimenDateTime",
    getV2: (p) => lr(p).collected_datetime,
    getV1: (r) => r.SpecimenDateTime,
    comparator: datetime,
  },
  {
    field: "received_at",
    v1Column: "ReceivedDateTime",
    getV2: (p) => lr(p).received_at,
    getV1: (r) => r.ReceivedDateTime,
    comparator: datetime,
  },
  {
    field: "registered_at",
    v1Column: "RegisteredDateTime",
    getV2: (p) => lr(p).registered_at,
    getV1: (r) => r.RegisteredDateTime,
    comparator: datetime,
  },
  {
    // v2-transform.ts:337 hardcodes null ("disalab doesn't expose analysis_at").
    // v1 has it on 99.0% of DISA/TDS requests. Expected RED — that is the point.
    field: "analysis_at",
    v1Column: "AnalysisDateTime",
    getV2: (p) => lr(p).analysis_at,
    getV1: (r) => r.AnalysisDateTime,
    comparator: datetime,
  },
  {
    // v2-transform.ts:338 hardcodes null. v1 has it on 91.2% of DISA/TDS.
    // Expected RED — but only for FINAL results; see the conditional rule.
    field: "authorised_at",
    v1Column: "AuthorisedDateTime",
    getV2: (p) => lr(p).authorised_at,
    getV1: (r) => r.AuthorisedDateTime,
    comparator: datetime,
    // CONDITIONAL RULE (measured, spec §3.3b, DISA/TDS): AuthorisedDateTime is
    // empty on 100% of interim (I, 1,795), 99.9% of rejected (X, 4,627) and 88%
    // of not-reviewed (R, 10,020) rows. A result never reviewed, rejected, or
    // still interim HAS no authorisation time — so demanding one would flag
    // CORRECT data as a defect and drown the report in false red. Among FINAL
    // (F) rows it is 99.95% populated, and the residual 73 F rows with no
    // AuthorisedDateTime stay RED on purpose: a finalised result should have
    // one. Counting them is the point; absorbing them is how allowDisaEmpty
    // was born.
    emptyIsCorrectWhen: (v1) =>
      typeof v1.HL7ResultStatusCode !== "string" ||
      v1.HL7ResultStatusCode.trim().toUpperCase() !== "F",
  },
  {
    field: "clinical_info",
    v1Column: "ClinicalInfo",
    getV2: (p) => lr(p).clinical_info,
    getV1: (r) => r.ClinicalInfo,
    comparator: stringCiLoose,
  },
  {
    field: "icd10_codes",
    v1Column: "ICD10ClinicalInfoCodes",
    getV2: (p) => lr(p).icd10_codes,
    getV1: (r) => r.ICD10ClinicalInfoCodes,
    comparator: stringCi,
  },
  {
    field: "therapy",
    v1Column: "Therapy",
    getV2: (p) => lr(p).therapy,
    getV1: (r) => r.Therapy,
    comparator: stringCiLoose,
  },
  {
    field: "priority",
    v1Column: "HL7PriorityCode",
    getV2: (p) => lr(p).priority,
    getV1: (r) => r.HL7PriorityCode,
    comparator: stringCi,
  },
  {
    field: "sex",
    v1Column: "HL7SexCode",
    getV2: (p) => lr(p).sex,
    getV1: (r) => r.HL7SexCode,
    comparator: stringCi,
  },
  {
    // v2-transform.ts:341 hardcodes null ("not surfaced on SpecimenRecpt").
    //
    // ⚠ NOT A DEFECT, and this def exists to PROVE that rather than assume it.
    // v1's HL7PatientClassCode is EMPTY on all 174,261 DISA/TDS rows — the
    // spec's "100.0%" was count() counting non-NULL empty strings. CDR's null
    // and v1's '' agree, so this must score MATCH via the ''-is-empty rule.
    // If it goes red, the bug is in that rule, NOT in the export: do not open a
    // fix slice to invent data v1 never had.
    field: "patient_class",
    v1Column: "HL7PatientClassCode",
    getV2: (p) => lr(p).patient_class,
    getV1: (r) => r.HL7PatientClassCode,
    comparator: stringCi,
  },
  {
    field: "section_code",
    v1Column: "HL7SectionCode",
    getV2: (p) => lr(p).section_code,
    getV1: (r) => r.HL7SectionCode,
    comparator: stringCi,
  },
  {
    field: "result_status",
    v1Column: "HL7ResultStatusCode",
    getV2: (p) => lr(p).result_status,
    getV1: (r) => r.HL7ResultStatusCode,
    comparator: stringCi,
  },
  {
    field: "age_years",
    v1Column: "AgeInYears",
    getV2: (p) => lr(p).age_years,
    getV1: (r) => r.AgeInYears,
    comparator: stringCi,
  },
  {
    field: "age_days",
    v1Column: "AgeInDays",
    getV2: (p) => lr(p).age_days,
    getV1: (r) => r.AgeInDays,
    comparator: stringCi,
  },
  {
    field: "requesting_doctor",
    v1Column: "AttendingDoctor",
    getV2: (p) => lr(p).requesting_doctor,
    getV1: (r) => r.AttendingDoctor,
    comparator: stringCiLoose,
  },
  {
    field: "tested_by",
    v1Column: "TestedBy",
    getV2: (p) => lr(p).tested_by,
    getV1: (r) => r.TestedBy,
    comparator: stringCi,
  },
  {
    field: "authorised_by",
    v1Column: "AuthorisedBy",
    getV2: (p) => lr(p).authorised_by,
    getV1: (r) => r.AuthorisedBy,
    comparator: stringCi,
  },
];

export const V2_REQUEST_EXCEPTIONS: readonly V2FieldException[] = [
  {
    field: "point_of_care",
    v1Column: "LIMSPointOfCareDesc",
    reason:
      "v1 packs facility name and ward into ONE varchar(50) separated by '~'. V2 " +
      "carries them as separate structured values (facility_code.display_name and " +
      "source_payload.ward), so there is no single V2 field to compare against it. " +
      "Splitting v1's column here would re-implement the convention the DISA<->v1 " +
      "table already grades precisely, and a loose 'substring wins' comparator is " +
      "exactly the widened assertion this table exists to avoid.",
    evidence:
      "openldr.ts exposes splitPointOfCare + PocFormat (facility_ward for Tanzania, " +
      "district_facility_ward for Mozambique); mapping.ts grades the split as the " +
      "separate `facility_name` and `ward` fields. comparators.ts:88-103 records the " +
      "truncation empirically: 87 TDS labs where v1 stores 'KCMC' for DISA's 'KCMC " +
      "CLINICAL LABORATORY', and 594 where v1's parsed facility name is null entirely.",
  },
];

// ===========================================================================
// RESULT LEVEL — the observation stream.
// ===========================================================================

export interface V2ResultFieldDef {
  field: string;
  v1Column: keyof OpenLdrV1LabResult;
  getV2: (r: V2LabResult) => unknown;
  getV1: (r: OpenLdrV1LabResult) => unknown;
  comparator: (v2: unknown, v1: unknown) => CompareResult;
}

export interface V2ResultFieldException {
  field: string;
  v1Column: keyof OpenLdrV1LabResult;
  reason: string;
  evidence: string;
}

/**
 * The PAIRING KEY, plus v1's own request pointer.
 *
 * ⚠ These are deliberately NOT graded. Paired rows are selected BY these
 * columns, so a def over them would compare each value to itself and report
 * 100% match forever — a vacuous green that would look like coverage. The
 * honest signal for these lives in the pairing outcome instead: an observation
 * whose panel+param finds no partner is reported as `only_v1` / `only_v2`.
 *
 * ⚠ The plan named the key `(RequestID, OBRSetID, OBXSetID)`. That is not
 * buildable: `V2LabResult` carries neither a request id nor an OBRSetID (see
 * types.ts:59-83). The real key is `(source_test_code, observation_code)` —
 * which is exactly the `(panelCode, paramCode)` key `result-diff.ts:349` already
 * pairs the DISA<->v1 gate on. Reused rather than reinvented.
 */
export const V1_RESULT_BOOKKEEPING: readonly string[] = [
  "RequestID",
  "LIMSPanelCode",
  "LIMSObservationCode",
];

export const V2_RESULT_FIELDS: readonly V2ResultFieldDef[] = [
  {
    // v1's OBX-1 vs the counter buildLabResults maintains (v2-transform.ts:433-441,
    // resetting per panelCode#panelIndex). Genuinely comparable — and if the two
    // orderings disagree, that is a finding, not a nuisance.
    field: "obx_set_id",
    v1Column: "OBXSetID",
    getV2: (r) => r.obx_set_id,
    getV1: (r) => r.OBXSetID,
    comparator: stringCi,
  },
  {
    field: "obx_sub_id",
    v1Column: "OBXSubID",
    getV2: (r) => r.obx_sub_id,
    getV1: (r) => r.OBXSubID,
    comparator: stringCi,
  },
  {
    field: "observation_desc",
    v1Column: "LIMSObservationDesc",
    getV2: (r) => r.observation_code?.display_name ?? null,
    getV1: (r) => r.LIMSObservationDesc,
    comparator: stringCiLoose,
  },
  {
    field: "result_value",
    v1Column: "LIMSRptResult",
    getV2: (r) => r.result_value,
    getV1: (r) => r.LIMSRptResult,
    comparator: stringCiLoose,
  },
  {
    field: "coded_value",
    v1Column: "LIMSCodedValue",
    getV2: (r) => r.coded_value,
    getV1: (r) => r.LIMSCodedValue,
    comparator: stringCi,
  },
  {
    field: "result_type",
    v1Column: "HL7ResultTypeCode",
    getV2: (r) => r.result_type,
    getV1: (r) => r.HL7ResultTypeCode,
    comparator: stringCi,
  },
  {
    // ★ THE ACCEPTANCE FIELD — the reason this slice exists.
    //
    // v2-transform.ts:496 hardcodes `abnormal_flag: null`. v1 carries a real
    // flag on 107,602 of 643,855 DISA/TDS rows (16.7%): N 99,232 / L 6,003 /
    // H 2,339 / LL 16 / HH 12. Nothing has ever compared them, because the gate
    // never looked at the export. Expected RED on ~107,602 rows.
    //
    // ⚠ NOT 100%. The spec claimed 643,855/643,855 because count() counts
    // NON-NULL and v1 writes '' for "no flag" on the other 536,253 rows. Those
    // must score MATCH against CDR's null — see the pair-guard test. If this
    // reports ~643,855 red, the ''-empty rule is broken and the number is a
    // 6x fabrication, not a finding.
    field: "abnormal_flag",
    v1Column: "HL7AbnormalFlagCodes",
    getV2: (r) => r.abnormal_flag,
    getV1: (r) => r.HL7AbnormalFlagCodes,
    comparator: stringCi,
  },
  {
    field: "rpt_range",
    v1Column: "LIMSRptRange",
    getV2: (r) => r.rpt_range,
    getV1: (r) => r.LIMSRptRange,
    comparator: stringCiLoose,
  },
  {
    field: "numeric_value",
    v1Column: "SIValue",
    getV2: (r) => r.numeric_value,
    getV1: (r) => r.SIValue,
    comparator: stringCi,
  },
  {
    field: "numeric_units",
    v1Column: "SIUnits",
    getV2: (r) => r.numeric_units,
    getV1: (r) => r.SIUnits,
    comparator: stringCiLoose,
  },
];

export const V2_RESULT_EXCEPTIONS: readonly V2ResultFieldException[] = [
  {
    field: "obr_set_id",
    v1Column: "OBRSetID",
    reason:
      "v1 groups observations into HL7 OBR sets — one per ordered panel, assigned " +
      "by v1's own migration. V2 has no OBR concept at all: V2LabResult carries " +
      "source_test_code (the panel) and obx_set_id (position within it), and the " +
      "OBR grouping is reconstructed by the consumer. There is no V2 value to " +
      "compare, so grading it would only measure v1's numbering against nothing.",
    evidence:
      "types.ts:59-83 — V2LabResult has no obr_set_id and no request id. " +
      "openldr.ts:224-236 shows OBRSetID is v1's join key between LabResults and " +
      "Requests, i.e. v1-internal structure rather than observed clinical data.",
  },
  {
    field: "panel_desc",
    v1Column: "LIMSPanelDesc",
    reason:
      "Not a LabResults column: openldr.ts:217 selects it as req.[LIMSPanelDesc] " +
      "through the join to Requests, so every result row under one panel repeats " +
      "the same request-level value. It is already graded strictly at the request " +
      "level as `panel_desc`. Grading it again per observation would multiply one " +
      "request-level finding by the observation count and misreport its size.",
    evidence:
      "openldr.ts:215-222 (LAB_RESULT_COLUMNS) — LIMSPanelCode and LIMSPanelDesc " +
      "are both prefixed `req.`, unlike every other selected column, which is `lr.`.",
  },
];

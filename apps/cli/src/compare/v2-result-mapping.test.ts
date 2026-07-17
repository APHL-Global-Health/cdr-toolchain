import { test } from "node:test";
import assert from "node:assert/strict";
import type { V2LabResult, V2Payload } from "../export/types.js";
import type { OpenLdrV1LabResult } from "../openldr.js";
import {
  V2_RESULT_FIELDS,
  V2_RESULT_EXCEPTIONS,
  V1_RESULT_PAIRING_KEY,
} from "./v2-mapping.js";
import { diffV2Results } from "./v2-diff.js";

function v2Result(r: Partial<V2LabResult>): V2LabResult {
  return {
    source_test_code: "CBC",
    obx_set_id: 1,
    obx_sub_id: 0,
    observation_code: { concept_code: "HB", display_name: "Haemoglobin" },
    abnormal_flag: null,
    ...r,
  } as unknown as V2LabResult;
}

function payload(results: V2LabResult[]): V2Payload {
  return { lab_results: results } as unknown as V2Payload;
}

function v1Row(r: Partial<OpenLdrV1LabResult>): OpenLdrV1LabResult {
  return {
    RequestID: "TZDISATDS0013541",
    OBRSetID: 1,
    OBXSetID: 1,
    OBXSubID: 0,
    LIMSPanelCode: "CBC",
    LIMSObservationCode: "HB",
    ...r,
  } as OpenLdrV1LabResult;
}

const NO_DOC_PANELS = { documentationPanels: new Set<string>() };

function fieldStatus(
  v2: Partial<V2LabResult>,
  v1: Partial<OpenLdrV1LabResult>,
  field: string,
): string {
  const d = diffV2Results(payload([v2Result(v2)]), [v1Row(v1)], NO_DOC_PANELS);
  const row = d.pairs[0]?.fields.find((f) => f.field === field);
  assert.ok(row !== undefined, `no result field def named ${field}`);
  return row.status;
}

// ---------------------------------------------------------------------------
// THE ACCEPTANCE TEST FOR THE WHOLE SLICE.
//
// The gate has only ever graded the disalab DECODER, so the export was
// structurally invisible: v2-transform.ts:496 hardcodes `abnormal_flag: null`
// while v1 carries a real flag on 107,602 of 643,855 DISA/TDS rows (16.7%).
// Nothing has ever compared them. If this does NOT go red, the gate is still
// not reading the V2 payload — which IS the bug.
// ---------------------------------------------------------------------------

test("ACCEPTANCE: the abnormal_flag stub vs a populated v1 flag reports only_v1", () => {
  // 'N' is the modal real value (99,232 rows). The measured value set is
  // N/L/H/LL/HH — the plan's original 'R' never occurs, and a fixture with an
  // impossible value makes a test look like it pins reality when it does not.
  assert.equal(fieldStatus({ abnormal_flag: null }, { HL7AbnormalFlagCodes: "N" }, "abnormal_flag"), "only_v1");
});

// THE PAIR-GUARD. v1 stores '' for "no flag" on 536,253 of 643,855 rows, and
// CDR's null AGREES with that. Without this test, the acceptance test above is
// satisfied by a comparator that reds EVERY row, and the report would claim
// 643,855 losses instead of the true 107,602 — a 6x fabrication.
test("PAIR-GUARD: the abnormal_flag stub vs an EMPTY v1 flag is a match", () => {
  assert.equal(fieldStatus({ abnormal_flag: null }, { HL7AbnormalFlagCodes: "" }, "abnormal_flag"), "match");
});

test("a real V2 value vs a differing v1 value is a mismatch", () => {
  assert.equal(
    fieldStatus({ result_value: "12.1" }, { LIMSRptResult: "9.4" }, "result_value"),
    "mismatch",
  );
});

// ---------------------------------------------------------------------------
// THE DOCUMENTATION-PANEL SCOPE RULE. Built BEFORE the acceptance number is
// trusted, because it is 36.6% of the population.
//
// Measured (DISA/TDS): VLID 218,181 + EIDID 17,664 = 235,845 of 643,855 v1 rows
// are questionnaire observations ("Is the client pregnant?", "Drug Adherance").
// CDR routes them to the FORMS feed, so their absence from the lab payload is
// correct. Pairing them anyway would score 36.6% only_v1 and drown every real
// finding.
// ---------------------------------------------------------------------------

test("v1 rows under a documentation panel are excluded from pairing — and COUNTED", () => {
  const d = diffV2Results(
    payload([v2Result({})]),
    [v1Row({}), v1Row({ LIMSPanelCode: "VLID", LIMSObservationCode: "ARVPP" })],
    { documentationPanels: new Set(["VLID", "EIDID"]) },
  );
  assert.equal(d.summary.v1_results_documentation_excluded, 1);
  // Excluded, NOT silently dropped into only_v1 — that is the whole point.
  assert.equal(d.summary.only_v1, 0);
  assert.equal(d.summary.paired, 1);
});

// The scope rule must track the payload. With no --country the doc-panel set is
// EMPTY and toV2 excludes nothing, so the gate must exclude nothing either.
// If these ever drift apart the gate grades a payload that was never built.
test("with an EMPTY documentation-panel set, nothing is excluded", () => {
  const d = diffV2Results(
    payload([v2Result({})]),
    [v1Row({}), v1Row({ LIMSPanelCode: "VLID", LIMSObservationCode: "ARVPP" })],
    NO_DOC_PANELS,
  );
  assert.equal(d.summary.v1_results_documentation_excluded, 0);
  assert.equal(d.summary.only_v1, 1); // the VLID row is now unpaired, honestly
});

// ---------------------------------------------------------------------------
// Pairing. ⚠ The plan specified (RequestID, OBRSetID, OBXSetID) — but V2LabResult
// has NO OBRSetID and no request id; v1's OBR grouping has no V2 counterpart at
// all. The real key is (source_test_code, observation_code), which is exactly
// the (panelCode, paramCode) key result-diff.ts already pairs on.
// ---------------------------------------------------------------------------

test("a v1 observation with no V2 counterpart reports only_v1", () => {
  const d = diffV2Results(
    payload([v2Result({})]),
    [v1Row({}), v1Row({ LIMSObservationCode: "WBC" })],
    NO_DOC_PANELS,
  );
  assert.equal(d.summary.only_v1, 1);
  assert.equal(d.summary.paired, 1);
});

test("a V2 observation with no v1 counterpart reports only_v2", () => {
  const d = diffV2Results(
    payload([v2Result({}), v2Result({ observation_code: { concept_code: "PLT" } as never })]),
    [v1Row({})],
    NO_DOC_PANELS,
  );
  assert.equal(d.summary.only_v2, 1);
  assert.equal(d.summary.paired, 1);
});

test("observations are paired on panel AND param, not param alone", () => {
  // Same param code under a different panel is a DIFFERENT observation.
  const d = diffV2Results(
    payload([v2Result({ source_test_code: "CBC" })]),
    [v1Row({ LIMSPanelCode: "CHEM" })],
    NO_DOC_PANELS,
  );
  assert.equal(d.summary.paired, 0);
  assert.equal(d.summary.only_v2, 1);
  assert.equal(d.summary.only_v1, 1);
});

// ---------------------------------------------------------------------------
// Coverage guard — enumerated from OpenLdrV1LabResult (openldr.ts:50-66).
// ---------------------------------------------------------------------------

const V1_RESULT_COLUMNS: readonly (keyof OpenLdrV1LabResult)[] = [
  "RequestID",
  "OBRSetID",
  "OBXSetID",
  "OBXSubID",
  "LIMSPanelCode",
  "LIMSPanelDesc",
  "LIMSObservationCode",
  "LIMSObservationDesc",
  "LIMSRptResult",
  "LIMSCodedValue",
  "HL7ResultTypeCode",
  "HL7AbnormalFlagCodes",
  "LIMSRptRange",
  "SIValue",
  "SIUnits",
];

test("every v1 result column has a field def, an exception, or is bookkeeping", () => {
  const covered = new Set<string>([
    ...V2_RESULT_FIELDS.map((f) => f.v1Column),
    ...V2_RESULT_EXCEPTIONS.map((e) => e.v1Column),
    ...V1_RESULT_PAIRING_KEY,
  ]);
  const uncovered = V1_RESULT_COLUMNS.filter((c) => !covered.has(c));
  assert.deepEqual(uncovered, [], `uncovered v1 result columns: ${uncovered.join(", ")}`);
});

test("the result coverage list has no phantom columns", () => {
  const known = new Set<string>(V1_RESULT_COLUMNS);
  const phantom = [
    ...V2_RESULT_FIELDS.map((f) => f.v1Column),
    ...V2_RESULT_EXCEPTIONS.map((e) => e.v1Column),
  ].filter((c) => !known.has(c));
  assert.deepEqual(phantom, []);
});

test("every result exception carries a reason and real evidence", () => {
  for (const e of V2_RESULT_EXCEPTIONS) {
    assert.ok(e.reason.trim().length > 0, `${e.field}: empty reason`);
    assert.ok(e.evidence.trim().length > 0, `${e.field}: empty evidence`);
  }
});

// TZ PIN — see the header of v2-transform-datestamp.test.ts for the full rationale.
// V2 emits local-form ISO ("2018-05-18T09:00:00", no offset). `Date.parse` reads
// that as LOCAL time per spec, while toWallClock reads components back with
// getUTC*. On a UTC host those agree and every assertion below passes even if
// the parse is wrong; on this laptop (UTC+3) 09:00 would read back as 06:00.
// Africa/Dar_es_Salaam has no DST => a constant -180, so the pin is stable.
// Node's test runner is process-per-file, so this cannot leak into other suites.
process.env.TZ = "Africa/Dar_es_Salaam";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { V2Payload } from "../export/types.js";
import type { OpenLdrV1Request } from "../openldr.js";
import {
  V2_REQUEST_FIELDS,
  V2_REQUEST_EXCEPTIONS,
} from "./v2-mapping.js";
import { V1_REQUEST_DERIVED } from "./v1-coverage.js";
import { diffV2Request } from "./v2-diff.js";

// Asserts the OUTCOME (the offset), not the mechanism, so it cannot pass while
// the pin is silently ineffective. If this fails, every datetime assertion
// below is vacuous — fix this first.
test("TZ pin took effect", () => {
  assert.equal(new Date("2018-05-18").getTimezoneOffset(), -180);
});

function payload(req: Partial<V2Payload["lab_request"]>): V2Payload {
  return {
    patient: {},
    lab_request: { request_id: "TZDISATDS0013541", ...req },
    lab_results: [],
    isolates: [],
    susceptibility_tests: [],
  } as unknown as V2Payload;
}

function v1(cols: Partial<OpenLdrV1Request>): OpenLdrV1Request {
  return { RequestID: "TZDISATDS0013541", allPanelCodes: [], ...cols } as OpenLdrV1Request;
}

function statusOf(p: V2Payload, r: OpenLdrV1Request, field: string): string {
  const row = diffV2Request(p, r).fields.find((f) => f.field === field);
  assert.ok(row !== undefined, `no field def named ${field}`);
  return row.status;
}

// ---------------------------------------------------------------------------
// The core assertion: a stub must not be forgiven.
// ---------------------------------------------------------------------------

// v2-transform.ts:338 hardcodes `authorised_at: null` while v1's
// AuthorisedDateTime is populated on 91.2% of DISA/TDS requests. The old gate
// could never see this because it never looked at the export.
test("a V2 field stubbed null while v1 is populated reports only_v1", () => {
  assert.equal(
    statusOf(
      payload({ authorised_at: null }),
      v1({ AuthorisedDateTime: new Date(Date.UTC(2018, 4, 18, 9, 0)), HL7ResultStatusCode: "F" }),
      "authorised_at",
    ),
    "only_v1",
  );
});

// ---------------------------------------------------------------------------
// THE '' PAIR. Neither test is meaningful alone: a comparator that called
// everything empty passes the first; one that called nothing empty passes the
// second. Only together do they pin the boundary.
//
// Measured (DISA/TDS): HL7AbnormalFlagCodes is '' on 536,253 of 643,855 rows and
// a real flag on 107,602. count(col) reported 100% because it counts NON-NULL.
// If '' were treated as a value, the gate would report 643,855 red instead of
// 107,602 -- 6x inflation, and patient_class would be a fabricated defect.
// ---------------------------------------------------------------------------

test("V2 null vs v1 '' is a MATCH — both mean absent", () => {
  assert.equal(
    statusOf(payload({ patient_class: null }), v1({ HL7PatientClassCode: "" }), "patient_class"),
    "match",
  );
});

test("V2 null vs a REAL v1 value is still only_v1 — the empty rule is not a blanket", () => {
  assert.equal(
    statusOf(payload({ patient_class: null }), v1({ HL7PatientClassCode: "I" }), "patient_class"),
    "only_v1",
  );
});

// ---------------------------------------------------------------------------
// The status label must say V2, not DISA. The comparators are shared with the
// DISA<->v1 gate and return "only_disa" for a populated left side; if that label
// leaked through, a V2-only value would be reported as a DISA-only value and the
// report would name the wrong system.
// ---------------------------------------------------------------------------

test("V2 populated vs v1 empty reports only_v2, not only_disa", () => {
  assert.equal(
    statusOf(payload({ therapy: "AZT" }), v1({ Therapy: "" }), "therapy"),
    "only_v2",
  );
});

// ---------------------------------------------------------------------------
// D4 — the load-bearing mapping. STRICT on purpose: the old gate offered taken
// and collected as candidates ("a match on either wins"), which is exactly why
// it could never discover which one v1 means.
// ---------------------------------------------------------------------------

test("collected_datetime maps to v1.SpecimenDateTime — strictly, with no TZ shift", () => {
  assert.equal(
    statusOf(
      payload({ collected_datetime: "2018-05-18T09:00:00" }),
      v1({ SpecimenDateTime: new Date(Date.UTC(2018, 4, 18, 9, 0)) }),
      "collected_datetime",
    ),
    "match",
  );
});

// The mutant this kills: parsing V2's local-form ISO through Date.parse and
// reading it back with getUTC*. On this host that turns 09:00 into 06:00.
test("a V2 wall-clock time that really differs is still a mismatch", () => {
  assert.equal(
    statusOf(
      payload({ collected_datetime: "2018-05-18T06:00:00" }),
      v1({ SpecimenDateTime: new Date(Date.UTC(2018, 4, 18, 9, 0)) }),
      "collected_datetime",
    ),
    "mismatch",
  );
});

// ---------------------------------------------------------------------------
// Conditional rules (spec §3.3b). NOT an exception: an exception tolerates a
// mismatch, a conditional rule says the correct value depends on state.
// Measured: AuthorisedDateTime is empty on 100% of interim (I) rows and 88% of
// not-reviewed (R) rows -- a result never authorised HAS no authorisation time.
// ---------------------------------------------------------------------------

test("authorised_at empty is CORRECT when the v1 result status is not final", () => {
  assert.equal(
    statusOf(
      payload({ authorised_at: null }),
      v1({ AuthorisedDateTime: null, HL7ResultStatusCode: "I" }),
      "authorised_at",
    ),
    "match",
  );
});

// The 73 F-status rows with no AuthorisedDateTime (0.05%) must stay COUNTED.
// A conditional rule that absorbed them would become the next allowDisaEmpty.
test("the conditional rule does NOT fire for a FINAL result — that stays red", () => {
  assert.equal(
    statusOf(
      payload({ authorised_at: null }),
      v1({ AuthorisedDateTime: new Date(Date.UTC(2018, 4, 18, 9, 0)), HL7ResultStatusCode: "F" }),
      "authorised_at",
    ),
    "only_v1",
  );
});

// ---------------------------------------------------------------------------
// THE COVERAGE GUARD. Without it, "cover every v1 column" degrades silently the
// first time someone adds one. Enumerated from OpenLdrV1Request (openldr.ts:6-42),
// not from memory.
// ---------------------------------------------------------------------------

const V1_REQUEST_COLUMNS: readonly (keyof OpenLdrV1Request)[] = [
  "RequestID",
  "RequestingFacilityCode",
  "TestingFacilityCode",
  "LIMSPointOfCareDesc",
  "LIMSPanelCode",
  "LIMSPanelDesc",
  "LIMSSpecimenSourceCode",
  "LIMSSpecimenSourceDesc",
  "SpecimenDateTime",
  "ReceivedDateTime",
  "RegisteredDateTime",
  "AnalysisDateTime",
  "AuthorisedDateTime",
  "ClinicalInfo",
  "ICD10ClinicalInfoCodes",
  "Therapy",
  "HL7PriorityCode",
  "HL7SexCode",
  "HL7PatientClassCode",
  "HL7SectionCode",
  "HL7ResultStatusCode",
  "AgeInYears",
  "AgeInDays",
  "AttendingDoctor",
  "TestedBy",
  "AuthorisedBy",
  "allPanelCodes",
];

test("every v1 request column has a field def, an exception, or is bookkeeping", () => {
  const covered = new Set<string>([
    ...V2_REQUEST_FIELDS.map((f) => f.v1Column),
    ...V2_REQUEST_EXCEPTIONS.map((e) => e.v1Column),
    ...V1_REQUEST_DERIVED,
  ]);
  const uncovered = V1_REQUEST_COLUMNS.filter((c) => !covered.has(c));
  assert.deepEqual(uncovered, [], `uncovered v1 columns: ${uncovered.join(", ")}`);
});

// Guards the guard: if the list above drifts from the real interface, the test
// above would still pass while silently checking fewer columns.
test("the coverage list matches the def/exception tables — no phantom columns", () => {
  const known = new Set<string>(V1_REQUEST_COLUMNS);
  const phantom = [
    ...V2_REQUEST_FIELDS.map((f) => f.v1Column),
    ...V2_REQUEST_EXCEPTIONS.map((e) => e.v1Column),
  ].filter((c) => !known.has(c));
  assert.deepEqual(phantom, [], `defs reference v1 columns that do not exist: ${phantom.join(", ")}`);
});

// ---------------------------------------------------------------------------
// The exception registry must carry EVIDENCE, not an assertion. This is what
// stops it becoming the next allowDisaEmpty -- that hatch survived on the
// strength of a comment citing "an obvious literal default like 2013-02-06",
// which turned out to be 11 rows of 3,602,986.
// ---------------------------------------------------------------------------

test("every exception carries a reason and real evidence", () => {
  for (const e of V2_REQUEST_EXCEPTIONS) {
    assert.ok(e.reason.trim().length > 0, `${e.field}: empty reason`);
    assert.ok(e.evidence.trim().length > 0, `${e.field}: empty evidence`);
  }
});

test("no field is both graded and excepted — an exception cannot silence a def", () => {
  const graded = new Set(V2_REQUEST_FIELDS.map((f) => f.v1Column));
  const both = V2_REQUEST_EXCEPTIONS.filter((e) => graded.has(e.v1Column));
  assert.deepEqual(both.map((e) => e.field), []);
});

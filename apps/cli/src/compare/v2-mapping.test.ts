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
import type { V2LabRequest } from "../export/types.js";
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

// The defs grade ONE lab_request (the OBR paired against a v1 row), not the
// whole payload — a payload no longer has a single "the" request.
function payload(req: Partial<V2LabRequest>): V2LabRequest {
  return { request_id: "TZDISATDS0013541", obr_set_id: 1, ...req } as unknown as V2LabRequest;
}

function v1(cols: Partial<OpenLdrV1Request>): OpenLdrV1Request {
  return { RequestID: "TZDISATDS0013541", allPanelCodes: [], ...cols } as OpenLdrV1Request;
}

function statusOf(p: V2LabRequest, r: OpenLdrV1Request, field: string): string {
  const row = diffV2Request(p, r).fields.find((f) => f.field === field);
  assert.ok(row !== undefined, `no field def named ${field}`);
  return row.status;
}

// ---------------------------------------------------------------------------
// The core assertion: a stub must not be forgiven.
// ---------------------------------------------------------------------------

// Was: "a V2 field stubbed null while v1 is populated reports only_v1".
// The stub is gone (2026-08-02); a populated authorised_at must now MATCH v1.
// NOTE the emitted form: local-form ISO, no offset, no milliseconds — the file
// header explains that Date.parse reads it as LOCAL while the comparator reads
// v1's Date back with getUTC*, so these two represent the same wall clock.
test("authorised_at matches v1 when the panel was reviewed", () => {
  assert.equal(
    statusOf(
      payload({ authorised_at: "2018-05-18T09:00:00" }),
      v1({ AuthorisedDateTime: new Date(Date.UTC(2018, 4, 18, 9, 0)), HL7ResultStatusCode: "F" }),
      "authorised_at",
    ),
    "match",
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
// The coverage guard MOVED to v1-coverage.test.ts, which asserts against the
// GENERATED v1 schema snapshot (60/28 real columns) instead of a hand-maintained
// list of OpenLdrV1Request's fields (26/13). The old guard covered 43% of v1
// while claiming to cover all of it -- the exact blind spot this slice removed --
// and a hand-maintained list would have to be edited every time a def is added,
// which is how it silently drifted in the first place.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// The 10 new request-level defs. Every getV2 below was MEASURED, not guessed.
// ---------------------------------------------------------------------------

// lims_facility_code DOES have a V2 counterpart and must MATCH. Measured on TDS,
// the four v1 facility columns disambiguate exactly:
//   RequestingFacilityCode 'DISA0JJAA'   TestingFacilityCode   'TDS'
//   LIMSFacilityCode       '0JJAA'       ReceivingFacilityCode 'TDS'
// i.e. LIMSFacilityCode is RequestingFacilityCode WITHOUT v1's DISA prefix, and
// equals DISA's own Facility.Code -- which is what V2 emits. So this def is
// expected GREEN and exists to PROVE the mapping, not to accuse. If it reds, the
// bug is here, not in the export. (Asserting a defect on a field V2 does carry is
// how patient_class nearly sent a fix slice to invent data v1 never had.)
test("lims_facility_code matches V2's requesting facility concept — no prefix", () => {
  const p = payload({ requesting_facility_code: { concept_code: "0JJAA" } as never });
  assert.equal(statusOf(p, v1({ LIMSFacilityCode: "0JJAA" }), "lims_facility_code"), "match");
});

// THE MULTI-PANEL DEFECT — now FIXED. This test used to assert the defect
// ("obr_set_id is only_v1 — V2LabRequest has no such field", expected RED).
// V2LabRequest now carries obr_set_id, toV2 emits one lab_request per ordered
// panel, and compare-batch pairs each against the v1 row with the SAME OBRSetID.
// Rewritten to pin the FIX rather than deleted: the pairing is what the whole
// slice buys, so it must stay asserted.
test("obr_set_id matches the v1 OBR row it is paired against", () => {
  assert.equal(statusOf(payload({ obr_set_id: 2 }), v1({ OBRSetID: 2 }), "obr_set_id"), "match");
});

// The other half of the pair — without this, a def that returned a constant 2,
// or one that ignored the payload entirely, would pass the test above.
test("obr_set_id from the WRONG OBR is a mismatch, not a pass", () => {
  assert.equal(statusOf(payload({ obr_set_id: 1 }), v1({ OBRSetID: 2 }), "obr_set_id"), "mismatch");
});

// CDR knows a request was REJECTED (result_status: rejection.rejected ? "X" : null,
// v2-transform.ts:350) but carries no code or reason. v1 has both on 4,518 rows
// (2.6%). detectDisaRejection is real logic that has never been graded.
test("rejection_code is only_v1 — CDR drops WHY a request was rejected", () => {
  assert.equal(statusOf(payload({}), v1({ LIMSRejectionCode: "HAEM" }), "rejection_code"), "only_v1");
});

// The '' pair-guard for the new defs: v1 writes '' not NULL for an absent string,
// so an UNREJECTED request must MATCH. Without this, 169,743 unrejected rows would
// report as losses.
test("rejection_code vs an EMPTY v1 value is a match", () => {
  assert.equal(statusOf(payload({}), v1({ LIMSRejectionCode: "" }), "rejection_code"), "match");
});

test("registered_by is only_v1 — CDR has no registered_by field", () => {
  assert.equal(statusOf(payload({}), v1({ RegisteredBy: "JDOE" }), "registered_by"), "only_v1");
});

// 0 is v1's empty convention for numerics (types.ts:160). Without this, 137,887
// zero rows would report as losses.
test("collection_volume vs v1's zero is a match — 0 is v1's empty for numerics", () => {
  assert.equal(statusOf(payload({}), v1({ CollectionVolume: 0 }), "collection_volume"), "match");
});

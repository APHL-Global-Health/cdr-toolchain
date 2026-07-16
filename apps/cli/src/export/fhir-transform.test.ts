import { test } from "node:test";
import assert from "node:assert/strict";
import { toFhir } from "./fhir-transform.js";
import type { V2Payload, V2LabResult } from "./types.js";

const TZ = { tzOffset: "+02:00" };

// Exported so Tasks 4-6 reuse it.
export function basePayload(over: Partial<V2Payload> = {}): V2Payload {
  return {
    patient: {
      patient_guid: "DEFAULT_REQ-2024-00456", firstname: "Jane", middlename: null,
      surname: "Doe", sex: "F", folder_no: "FLD-9981", date_of_birth: "1990-05-14",
      phone: null, email: null, national_id: null, patient_data: {},
    },
    lab_request: {
      request_id: "DEFAULT_REQ-2024-00456",
      facility_code: null, panel_code: null, specimen_code: null,
      taken_datetime: null, collected_datetime: null, received_at: null,
      registered_at: null, analysis_at: null, authorised_at: null,
      clinical_info: null, icd10_codes: null, therapy: null, priority: null,
      age_years: null, age_days: null, sex: "F", patient_class: null,
      section_code: null, result_status: "F", requesting_facility_code: null,
      testing_facility_code: null, requesting_doctor: null, tested_by: null,
      authorised_by: null, source_payload: {},
    },
    lab_results: [], isolates: [], susceptibility_tests: [],
    ...over,
  };
}

export function findOne(resources: unknown[], type: string): Record<string, any> {
  const hits = resources.filter((r: any) => r.resourceType === type);
  assert.equal(hits.length, 1, `expected exactly one ${type}, got ${hits.length}`);
  return hits[0] as Record<string, any>;
}

test("patient maps to a Patient with a sanitised id", () => {
  const p = findOne(toFhir(basePayload(), TZ), "Patient");
  // Underscore is illegal in a FHIR id (CE's ID_RE) — must be sanitised.
  assert.equal(p.id, "DEFAULT-REQ-2024-00456");
  assert.equal(p.name[0].family, "Doe");
  assert.deepEqual(p.name[0].given, ["Jane"]);
  assert.equal(p.gender, "female");
  assert.equal(p.birthDate, "1990-05-14");
});

test("patient sex codes map to FHIR gender", () => {
  const g = (sex: string | null) => {
    const pl = basePayload();
    pl.patient.sex = sex;
    return (findOne(toFhir(pl, TZ), "Patient") as any).gender;
  };
  assert.equal(g("M"), "male");
  assert.equal(g("F"), "female");
  assert.equal(g("U"), "unknown");
  assert.equal(g("I"), "other");   // HL7 Indeterminate has no FHIR equivalent
  assert.equal(g(null), undefined);
  assert.equal(g("banana"), undefined);
});

test("null name parts are omitted, never emitted as empty strings", () => {
  const pl = basePayload();
  pl.patient.middlename = null;
  pl.patient.surname = null;
  const p = findOne(toFhir(pl, TZ), "Patient");
  assert.deepEqual(p.name[0].given, ["Jane"]);
  assert.equal("family" in p.name[0], false);
});

test("middlename becomes a second given name", () => {
  const pl = basePayload();
  pl.patient.middlename = "Q";
  const p = findOne(toFhir(pl, TZ), "Patient");
  assert.deepEqual(p.name[0].given, ["Jane", "Q"]);
});

test("folder_no and national_id become identifiers", () => {
  const pl = basePayload();
  pl.patient.national_id = "NID-123";
  const p = findOne(toFhir(pl, TZ), "Patient");
  assert.equal(p.identifier.some((i: any) => i.value === "FLD-9981"), true);
  assert.equal(p.identifier.some((i: any) => i.value === "NID-123"), true);
});

test("phone and email become telecom entries", () => {
  const pl = basePayload();
  pl.patient.phone = "+258840000000";
  pl.patient.email = "a@b.com";
  const p = findOne(toFhir(pl, TZ), "Patient");
  assert.equal(p.telecom.some((t: any) => t.system === "phone" && t.value === "+258840000000"), true);
  assert.equal(p.telecom.some((t: any) => t.system === "email" && t.value === "a@b.com"), true);
});

test("a patient with nothing but a guid still yields a valid minimal Patient", () => {
  const pl = basePayload();
  pl.patient = {
    patient_guid: "X1", firstname: null, middlename: null, surname: null,
    sex: null, folder_no: null, date_of_birth: null, phone: null, email: null,
    national_id: null, patient_data: {},
  };
  const p = findOne(toFhir(pl, TZ), "Patient");
  assert.equal(p.resourceType, "Patient");
  assert.equal(p.id, "X1");
  // No empty arrays or empty-string fields — CE's fhirString is min(1).
  assert.equal("identifier" in p, false);
  assert.equal("telecom" in p, false);
  assert.equal("name" in p, false);
});

test("toFhir throws when request_id cannot form a FHIR id", () => {
  const pl = basePayload();
  pl.lab_request.request_id = "___";
  pl.patient.patient_guid = null;
  assert.throws(() => toFhir(pl, TZ), /request_id/);
});

test("lab_request produces ServiceRequest, Specimen and DiagnosticReport", () => {
  const pl = basePayload();
  pl.lab_request.panel_code = {
    concept_code: "CULT", display_name: "Blood Culture",
    concept_class: "panel", datatype: "coded", system_id: "DEFAULT_TEST",
  };
  pl.lab_request.specimen_code = {
    concept_code: "BLD", display_name: "Blood",
    concept_class: "specimen", datatype: "coded", system_id: "DEFAULT_SPEC",
  };
  pl.lab_request.collected_datetime = "2024-07-20T08:30:00";
  pl.lab_request.received_at = "2024-07-20T09:00:00";

  const out = toFhir(pl, TZ);
  const sr = findOne(out, "ServiceRequest");
  const sp = findOne(out, "Specimen");
  const dr = findOne(out, "DiagnosticReport");

  // CE requires status + intent + subject on ServiceRequest.
  assert.equal(sr.status, "completed");
  assert.equal(sr.intent, "order");
  assert.equal(sr.subject.reference, "Patient/DEFAULT-REQ-2024-00456");
  assert.equal(sr.code.coding[0].code, "CULT");

  // DISA's unzoned local time must gain the configured offset, NOT Z.
  assert.equal(sp.collection.collectedDateTime, "2024-07-20T08:30:00+02:00");
  assert.equal(sp.receivedTime, "2024-07-20T09:00:00+02:00");
  assert.equal(sp.type.coding[0].code, "BLD");

  assert.equal(dr.status, "final");
  assert.equal(dr.code.coding[0].code, "CULT");
  assert.equal(dr.subject.reference, "Patient/DEFAULT-REQ-2024-00456");
  assert.equal(dr.specimen[0].reference, `Specimen/${sp.id}`);
  assert.equal(dr.basedOn[0].reference, `ServiceRequest/${sr.id}`);
});

test("result_status maps to DiagnosticReport.status", () => {
  const s = (rs: string | null) => {
    const pl = basePayload();
    pl.lab_request.result_status = rs;
    return (findOne(toFhir(pl, TZ), "DiagnosticReport") as any).status;
  };
  assert.equal(s("F"), "final");
  assert.equal(s("P"), "preliminary");
  assert.equal(s("C"), "corrected");
  assert.equal(s("X"), "cancelled");
  assert.equal(s("R"), "registered");
  assert.equal(s(null), "unknown");     // never omit — CE requires status
  assert.equal(s("banana"), "unknown"); // unknown code must not crash or omit
});

test("a null panel_code still yields a DiagnosticReport with a code", () => {
  // CE REQUIRES DiagnosticReport.code — we must never emit a report without one.
  const pl = basePayload();
  pl.lab_request.panel_code = null;
  const dr = findOne(toFhir(pl, TZ), "DiagnosticReport");
  assert.ok(dr.code, "DiagnosticReport.code is required by CE");
  assert.ok(dr.code.coding[0].code, "code must carry an actual coding");
});

test("a null specimen_code omits Specimen.type rather than emitting an empty one", () => {
  const pl = basePayload();
  pl.lab_request.specimen_code = null;
  const sp = findOne(toFhir(pl, TZ), "Specimen");
  assert.equal("type" in sp, false);
});

test("absent dates are omitted, not emitted as null", () => {
  const pl = basePayload(); // all dates null
  const sp = findOne(toFhir(pl, TZ), "Specimen");
  const dr = findOne(toFhir(pl, TZ), "DiagnosticReport");
  assert.equal("receivedTime" in sp, false);
  assert.equal("collection" in sp, false);
  assert.equal("effectiveDateTime" in dr, false);
  assert.equal("issued" in dr, false);
});

test("clinical_info and requesting_doctor ride the ServiceRequest", () => {
  const pl = basePayload();
  pl.lab_request.clinical_info = "suspected sepsis";
  pl.lab_request.requesting_doctor = "Dr Mwakasege";
  const sr = findOne(toFhir(pl, TZ), "ServiceRequest");
  assert.equal(sr.note[0].text, "suspected sepsis");
  assert.equal(sr.requester.display, "Dr Mwakasege");
});

test("every emitted id satisfies CE's ID_RE", () => {
  // The whole resource set must be id-safe, not just the Patient.
  const CE_ID_RE = /^[A-Za-z0-9.\-]{1,64}$/;
  const pl = basePayload();
  pl.lab_request.specimen_code = {
    concept_code: "BLD", display_name: "Blood",
    concept_class: "specimen", datatype: "coded", system_id: "DEFAULT_SPEC",
  };
  for (const r of toFhir(pl, TZ)) {
    const id = (r as any).id;
    if (id !== undefined) assert.match(id, CE_ID_RE, `${(r as any).resourceType} id "${id}"`);
  }
});

function labResult(over: Partial<V2LabResult> = {}): V2LabResult {
  return {
    source_test_code: "CULT", obx_set_id: 1, obx_sub_id: 0,
    observation_code: {
      concept_code: "WBC", display_name: "White Blood Cell Count",
      concept_class: "test", datatype: "numeric", system_id: "DEFAULT_TEST",
    },
    result_value: "15.2", result_type: "NM", numeric_value: 15.2,
    coded_value: null, text_value: null, numeric_units: "x10^9/L",
    abnormal_flag: null, rpt_units: null, rpt_flag: null, rpt_range: null,
    result_timestamp: null, isolate_index: null, is_resulted: true,
    raw_result: {}, ...over,
  };
}

test("numeric lab_result becomes an Observation with valueQuantity", () => {
  const pl = basePayload({ lab_results: [labResult()] });
  const o = findOne(toFhir(pl, TZ), "Observation");
  assert.equal(o.status, "final");           // CE-required
  assert.equal(o.code.coding[0].code, "WBC");
  assert.equal(o.valueQuantity.value, 15.2);
  assert.equal(o.valueQuantity.unit, "x10^9/L");
  assert.equal(o.subject.reference, "Patient/DEFAULT-REQ-2024-00456");
});

test("abnormal_flag maps to interpretation and rpt_range to referenceRange", () => {
  // The v2 reference nulls both on its FHIR path; going FHIR-ward we map them.
  const pl = basePayload({ lab_results: [labResult({ abnormal_flag: "H", rpt_range: "4.0-11.0" })] });
  const o = findOne(toFhir(pl, TZ), "Observation");
  assert.equal(o.interpretation[0].coding[0].code, "H");
  assert.equal(o.referenceRange[0].low.value, 4.0);
  assert.equal(o.referenceRange[0].high.value, 11.0);
  assert.equal(o.referenceRange[0].low.unit, "x10^9/L");
});

test("a non-numeric range falls back to referenceRange.text", () => {
  const pl = basePayload({ lab_results: [labResult({ rpt_range: "negative" })] });
  const o = findOne(toFhir(pl, TZ), "Observation");
  assert.equal(o.referenceRange[0].text, "negative");
});

test("a negative-bounded range still parses", () => {
  const pl = basePayload({ lab_results: [labResult({ rpt_range: "-5 - 5" })] });
  const o = findOne(toFhir(pl, TZ), "Observation");
  assert.equal(o.referenceRange[0].low.value, -5);
  assert.equal(o.referenceRange[0].high.value, 5);
});

test("coded and string results pick the right value[x]", () => {
  const coded = basePayload({
    lab_results: [labResult({ result_type: "CE", numeric_value: null, coded_value: "ECO", result_value: "Escherichia coli" })],
  });
  assert.equal((findOne(toFhir(coded, TZ), "Observation") as any).valueCodeableConcept.coding[0].code, "ECO");

  const str = basePayload({
    lab_results: [labResult({ result_type: "ST", numeric_value: null, coded_value: null, result_value: "turbid" })],
  });
  assert.equal((findOne(toFhir(str, TZ), "Observation") as any).valueString, "turbid");
});

test("an Observation with no value at all is still emitted and valid", () => {
  // is_resulted:false — an ordered-but-unresulted test. CE requires status+code
  // but no value; the record must survive rather than vanish.
  const pl = basePayload({
    lab_results: [labResult({ result_value: null, numeric_value: null, coded_value: null, text_value: null, is_resulted: false })],
  });
  const o = findOne(toFhir(pl, TZ), "Observation");
  assert.equal(o.status, "final");
  assert.ok(o.code);
  assert.equal("valueQuantity" in o, false);
  assert.equal("valueString" in o, false);
  assert.equal("valueCodeableConcept" in o, false);
});

test("result_timestamp gains the configured offset", () => {
  const pl = basePayload({ lab_results: [labResult({ result_timestamp: "2024-07-20T10:00:00" })] });
  const o = findOne(toFhir(pl, TZ), "Observation");
  assert.equal(o.effectiveDateTime, "2024-07-20T10:00:00+02:00");
});

test("DiagnosticReport.result references every Observation", () => {
  const pl = basePayload({ lab_results: [labResult(), labResult({ obx_set_id: 2 })] });
  const out = toFhir(pl, TZ);
  const dr = findOne(out, "DiagnosticReport");
  const obs = out.filter((r: any) => r.resourceType === "Observation");
  assert.equal(obs.length, 2);
  assert.equal(dr.result.length, 2);
  const ids = new Set(obs.map((o: any) => `Observation/${o.id}`));
  for (const ref of dr.result) assert.equal(ids.has(ref.reference), true);
});

test("Observation ids are unique across many results", () => {
  const pl = basePayload({ lab_results: [labResult(), labResult(), labResult()] });
  const obs = toFhir(pl, TZ).filter((r: any) => r.resourceType === "Observation");
  const ids = new Set(obs.map((o: any) => o.id));
  assert.equal(ids.size, 3, "duplicate Observation ids would collide on persist");
});

test("no DiagnosticReport.result key when there are no results", () => {
  const dr = findOne(toFhir(basePayload(), TZ), "DiagnosticReport");
  assert.equal("result" in dr, false);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { toFhir } from "./fhir-transform.js";
import type { V2Payload } from "./types.js";

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

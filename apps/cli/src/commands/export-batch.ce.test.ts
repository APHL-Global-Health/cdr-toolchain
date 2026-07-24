import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpecimenRecpt } from "disalab";
import { postFhirResources } from "../api/ce-client.js";
import { toFhir } from "../export/fhir-transform.js";
import { buildCeResources, ceRouting } from "./export-batch.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";
import { basePayload } from "../export/fhir-transform.test.js";

// -------------------------------------------------------------------------
// Step 1: this pins the CONTRACT the CE branch relies on — postFhirResources
// sends exactly the array it is given, so an integration test that stubs
// fetch can inspect the posted body. (Already covered by ce-client.test.ts;
// restated here so this file documents the full CE-branch contract in one
// place.) The concatenation itself (test leg + documentation leg) is
// exercised directly below via buildCeResources, since export-batch's
// processOneLab has no other seam to hook into.
// -------------------------------------------------------------------------
test("posts the exact array it is handed (bare FHIR array contract)", async () => {
  const seen: unknown[] = [];
  const fetchImpl = (async (_url: string, init: { body?: string }) => {
    seen.push(JSON.parse(init.body ?? "[]"));
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const resources = [
    { resourceType: "Patient", id: "p1" },
    { resourceType: "QuestionnaireResponse", id: "qr1", status: "completed" },
  ];
  await postFhirResources(resources, {
    baseUrl: "https://ce", path: "/hooks/x", token: "t", fetchImpl,
  });
  assert.deepEqual(seen[0], resources);
});

/**
 * Build a minimal SpecimenRecpt fixture (same shape flattenDisa expects —
 * see v2-transform-exclude.test.ts's specimenFixture for the annotated
 * reference version) whose TestResults are empty, so it carries NO
 * documentation observations.
 */
function docFreeSpecimen(): SpecimenRecpt {
  return ({
    LabNumber: "TEST001",
    TestOrders: [],
    TestResults: [],
    Facility: null, WardClinic: null, WardClinicResolved: null, FolderNo: null,
    LastName: null, MiddleName: null, FirstName: null, Sex: null, Phone: null,
    Work: null, Mobile: null, Email: null, Address: null, ICD10: null,
    Therapy: null, TherapyText: null, ClinicalDiagnosis: null, ClinicalDiagnosisText: null,
    Specimen: null, Condition: null, TakenDateTime: null, CollectedDateTime: null,
    ReceivedInLabDateTime: null, RegisteredDateTime: null, CollectedBy: null,
    TakenBy: null, ReceivedInLabBy: null, Priority: null, DoctorCode: null,
    Doctor: null, DobAge: null, NID: null,
  } as unknown) as SpecimenRecpt;
}

/**
 * Fixture WITH one documentation observation: panel VIRAL (config-flagged
 * documentation panel), param ARTRS. Mirrors v2-transform-exclude.test.ts's
 * specimenFixture pattern.
 */
function docBearingSpecimen(): SpecimenRecpt {
  const numericType = String.fromCharCode(1);
  const makeItem = (code: string, value: string) => ({
    Code: code, Type: numericType, Value: value, RawValue: "", IsResulted: true, Description: null,
  });
  return ({
    LabNumber: "TEST001",
    TestOrders: ["VIRAL"],
    TestResults: [
      { TESTCODE: "VIRAL", TESTINDEX: 1, DATESTAMP: null, ORDER: [makeItem("ARTRS", "123")] },
    ],
    Facility: null, WardClinic: null, WardClinicResolved: null, FolderNo: null,
    LastName: null, MiddleName: null, FirstName: null, Sex: null, Phone: null,
    Work: null, Mobile: null, Email: null, Address: null, ICD10: null,
    Therapy: null, TherapyText: null, ClinicalDiagnosis: null, ClinicalDiagnosisText: null,
    Specimen: null, Condition: null, TakenDateTime: null, CollectedDateTime: null,
    ReceivedInLabDateTime: null, RegisteredDateTime: null, CollectedBy: null,
    TakenBy: null, ReceivedInLabBy: null, Priority: null, DoctorCode: null,
    Doctor: null, DobAge: null, NID: null,
  } as unknown) as SpecimenRecpt;
}

const TZ_OPTS = { prefix: "", codebook: stubCodebook({ params: { ARTRS: { description: "reason" } } }), docConfig: { panels: new Set<string>(), params: new Set<string>(), forms: new Map<string, string>() }, tzOffset: "+02:00" };

test("buildCeResources: documentation-free specimen returns exactly toFhir(payload) — test-only path unchanged", () => {
  const payload = basePayload();
  const out = buildCeResources(docFreeSpecimen(), payload, TZ_OPTS);
  const expected = toFhir(payload, { tzOffset: TZ_OPTS.tzOffset });
  assert.equal(out.length, expected.length);
  assert.deepEqual(out, expected);
  assert.equal(out.some((r) => (r as { resourceType?: string }).resourceType === "QuestionnaireResponse"), false);
});

// -------------------------------------------------------------------------
// Step 2: the CE branch's routing tally (result.routing, which feeds the
// batch summary's split/forms_posted counters) is derived by ceRouting from
// two counts — how many documentation resources came out of
// buildCeResources, and how many lab_results are on the v2 payload. Pin all
// three outcomes directly against the pure helper so a future edit to the
// CE branch can't silently swap "split" and "form" without a red test.
// -------------------------------------------------------------------------
test("ceRouting: documentation + lab results routes to split", () => {
  assert.equal(ceRouting(1, 1), "split");
});

test("ceRouting: documentation with no lab results routes to form", () => {
  assert.equal(ceRouting(1, 0), "form");
});

test("ceRouting: no documentation routes to lab, regardless of lab results", () => {
  assert.equal(ceRouting(0, 0), "lab");
  assert.equal(ceRouting(0, 1), "lab");
});

// This fixture pairs a documentation-bearing specimen with basePayload()'s
// default lab_results: [] — i.e. it is a "form" routing case, NOT "split".
// The test below only pins buildCeResources' concatenation shape (test leg
// + documentation leg, in order); it intentionally does not assert routing.
test("buildCeResources: concatenates the test leg with the documentation leg", () => {
  const payload = basePayload();
  const docConfig = {
    panels: new Set(["VIRAL"]),
    params: new Set<string>(),
    forms: new Map([["VIRAL", "viral_documentation"]]),
  };
  const codebook = stubCodebook({ params: { ARTRS: { description: "reason" } } });
  const opts = { prefix: "", codebook, docConfig, tzOffset: "+02:00" };

  const out = buildCeResources(docBearingSpecimen(), payload, opts);
  const expected = toFhir(payload, { tzOffset: opts.tzOffset });

  // test leg present, unchanged, and first in the array
  assert.deepEqual(out.slice(0, expected.length), expected);
  // documentation leg appended after it
  assert.equal(out.some((r) => (r as { resourceType?: string }).resourceType === "Questionnaire"), true);
  assert.equal(out.some((r) => (r as { resourceType?: string }).resourceType === "QuestionnaireResponse"), true);
  assert.equal(out.length, expected.length + 2);
});

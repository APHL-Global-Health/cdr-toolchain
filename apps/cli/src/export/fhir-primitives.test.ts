import { test } from "node:test";
import assert from "node:assert/strict";
import { fhirId, fhirDateTime, fhirText } from "./fhir-primitives.js";

test("fhirId strips characters FHIR forbids", () => {
  // CE's ID_RE is /^[A-Za-z0-9.\-]{1,64}$/ — underscore is NOT allowed.
  assert.equal(fhirId("DEFAULT_REQ-2024-00456"), "DEFAULT-REQ-2024-00456");
  assert.equal(fhirId("ZUL0800028"), "ZUL0800028");
  assert.equal(fhirId("a b/c"), "a-b-c");
});

test("fhirId truncates to 64 chars", () => {
  assert.equal(fhirId("x".repeat(70))?.length, 64);
});

test("fhirId returns undefined for empty/null input", () => {
  assert.equal(fhirId(null), undefined);
  assert.equal(fhirId(""), undefined);
  assert.equal(fhirId("___"), undefined);
});

test("fhirDateTime demands a timezone when a time is present", () => {
  assert.equal(fhirDateTime("2024-07-20T08:30:00Z"), "2024-07-20T08:30:00Z");
  assert.equal(fhirDateTime("2024-07-20T08:30:00"), "2024-07-20T08:30:00Z");
  assert.equal(fhirDateTime("2024-07-20"), "2024-07-20");
  assert.equal(fhirDateTime(null), undefined);
  assert.equal(fhirDateTime("not a date"), undefined);
});

test("fhirText omits empty strings rather than emitting them", () => {
  // CE's fhirString is z.string().min(1) — "" fails validation.
  assert.equal(fhirText(""), undefined);
  assert.equal(fhirText("   "), undefined);
  assert.equal(fhirText(null), undefined);
  assert.equal(fhirText("Jane"), "Jane");
});

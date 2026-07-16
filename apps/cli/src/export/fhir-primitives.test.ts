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

test("fhirId truncation cannot leave a trailing hyphen", () => {
  // slice(0,64) must run BEFORE the trailing-strip, or it reintroduces one.
  const out = fhirId("a".repeat(63) + "-" + "a".repeat(10));
  assert.equal(out?.endsWith("-"), false);
  assert.ok((out?.length ?? 0) <= 64);
});

test("fhirDateTime applies the configured offset to unzoned local time", () => {
  // DISA stores local wall-clock; assuming UTC would shift Moz/Zambia by 2h.
  assert.equal(fhirDateTime("2024-07-20T08:30:00", "+02:00"), "2024-07-20T08:30:00+02:00");
  assert.equal(fhirDateTime("2024-07-20 08:30:00", "+02:00"), "2024-07-20T08:30:00+02:00");
});

test("fhirDateTime leaves already-zoned values alone", () => {
  assert.equal(fhirDateTime("2024-07-20T08:30:00Z", "+02:00"), "2024-07-20T08:30:00Z");
  assert.equal(fhirDateTime("2024-07-20T08:30:00.000Z", "+02:00"), "2024-07-20T08:30:00.000Z");
  assert.equal(fhirDateTime("2024-07-20T08:30:00+05:30", "+02:00"), "2024-07-20T08:30:00+05:30");
});

test("fhirDateTime passes date-only through unchanged", () => {
  assert.equal(fhirDateTime("2024-07-20", "+02:00"), "2024-07-20");
});

test("fhirDateTime omits rather than guesses at unrecognised formats", () => {
  // disaToIso passes unrecognised input through raw; new Date() would apply US
  // month/day ordering and silently emit a wrong timestamp.
  assert.equal(fhirDateTime("07/20/2024", "+02:00"), undefined);
  assert.equal(fhirDateTime("not a date", "+02:00"), undefined);
  assert.equal(fhirDateTime(null, "+02:00"), undefined);
  assert.equal(fhirDateTime("", "+02:00"), undefined);
});

test("fhirDateTime rejects a malformed offset loudly", () => {
  assert.throws(() => fhirDateTime("2024-07-20T08:30:00", "+2"), /offset/i);
  assert.throws(() => fhirDateTime("2024-07-20T08:30:00", "EAT"), /offset/i);
});

test("fhirText omits empty strings rather than emitting them", () => {
  // CE's fhirString is z.string().min(1) — "" fails validation.
  assert.equal(fhirText(""), undefined);
  assert.equal(fhirText("   "), undefined);
  assert.equal(fhirText(null), undefined);
  assert.equal(fhirText("Jane"), "Jane");
});

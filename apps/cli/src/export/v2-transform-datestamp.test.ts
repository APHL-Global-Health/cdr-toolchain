import { test } from "node:test";
import assert from "node:assert/strict";
import { disaDatestampToIso } from "./v2-transform.js";

// Measured against DisalabData.TESTDATA: SQL `2019-01-23 15:56:42.257` is read by
// mssql/tedious (useUTC = its default) into a Date whose UTC components ARE the
// wall-clock digits DISA stored. We must return those digits, UNZONED.
test("disaDatestampToIso returns the stored wall-clock, unzoned", () => {
  const d = new Date(Date.UTC(2019, 0, 23, 15, 56, 42, 257));
  assert.equal(disaDatestampToIso(d), "2019-01-23T15:56:42");
});

// MUTATION GUARD: a full toISOString() returns "...42.257Z". fhirDateTime treats an
// already-zoned value as passthrough, so the `Z` would survive and silently declare
// Tanzania local time to be UTC — shifting every timestamp by the deployment offset.
test("disaDatestampToIso never emits a zone suffix", () => {
  const d = new Date(Date.UTC(2019, 0, 23, 15, 56, 42, 257));
  const out = disaDatestampToIso(d);
  assert.equal(out?.endsWith("Z"), false);
  assert.equal(/[+-]\d{2}:\d{2}$/.test(out ?? ""), false);
});

test("disaDatestampToIso returns null for null and for an invalid Date", () => {
  assert.equal(disaDatestampToIso(null), null);
  assert.equal(disaDatestampToIso(new Date(Number.NaN)), null);
});

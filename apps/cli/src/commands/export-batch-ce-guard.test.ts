import { test } from "node:test";
import assert from "node:assert/strict";
import { assertCeGatesEnabled, requireCeTimezone } from "./export-batch.js";

const CE = "https://ce.example.com";

test("refuses --no-check when a CE target is configured", () => {
  assert.throws(() => assertCeGatesEnabled({ ceUrl: CE, doCheck: false, doQuarantine: true }), /--no-check/);
});

test("refuses --no-quarantine when a CE target is configured", () => {
  assert.throws(() => assertCeGatesEnabled({ ceUrl: CE, doCheck: true, doQuarantine: false }), /--no-quarantine/);
});

test("allows gates to be disabled when the target is not CE", () => {
  assert.doesNotThrow(() => assertCeGatesEnabled({ ceUrl: undefined, doCheck: false, doQuarantine: false }));
});

test("allows a CE target with both gates on", () => {
  assert.doesNotThrow(() => assertCeGatesEnabled({ ceUrl: CE, doCheck: true, doQuarantine: true }));
});

test("requires a well-formed timezone offset for a CE target", () => {
  assert.equal(requireCeTimezone(CE, "+02:00"), "+02:00");
  assert.equal(requireCeTimezone(CE, "Z"), "Z");
  assert.throws(() => requireCeTimezone(CE, undefined), /timezone offset is required/);
  assert.throws(() => requireCeTimezone(CE, ""), /timezone offset is required/);
  assert.throws(() => requireCeTimezone(CE, "+2"), /timezone offset is required/);
  assert.throws(() => requireCeTimezone(CE, "EAT"), /timezone offset is required/);
});

test("no timezone needed when the target is not CE", () => {
  assert.equal(requireCeTimezone(undefined, undefined), undefined);
});

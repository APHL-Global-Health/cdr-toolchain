import { test } from "node:test";
import assert from "node:assert/strict";
import { requireLabCode, labNumberMatchesLab } from "./export-batch.js";

test("a lab code is required when the target is CE", () => {
  assert.throws(() => requireLabCode("http://localhost:3000", undefined), /OPENLDR_LAB_CODE/);
  assert.throws(() => requireLabCode("http://localhost:3000", "   "), /OPENLDR_LAB_CODE/);
});

test("a lab code is trimmed and returned for CE", () => {
  assert.equal(requireLabCode("http://localhost:3000", " TDS "), "TDS");
});

test("no CE target: the lab code is optional and passed through", () => {
  assert.equal(requireLabCode(undefined, undefined), undefined);
  assert.equal(requireLabCode(undefined, "TDS"), "TDS");
});

test("a lab number matches its lab by prefix, ignoring case and spaces", () => {
  assert.equal(labNumberMatchesLab("TDS0012345", "TDS"), true);
  assert.equal(labNumberMatchesLab(" tds0012345", "TDS"), true);
  assert.equal(labNumberMatchesLab("TMS0012345", "TDS"), false);
  assert.equal(labNumberMatchesLab("138-001001", "PCA"), false);
});

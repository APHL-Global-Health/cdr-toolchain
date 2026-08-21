import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSelectionOrder } from "./export-batch.js";

test("defaults to ascending when the flag is absent", () => {
  assert.equal(parseSelectionOrder(undefined), "asc");
});

test("accepts asc and desc", () => {
  assert.equal(parseSelectionOrder("asc"), "asc");
  assert.equal(parseSelectionOrder("desc"), "desc");
});

test("accepts either case", () => {
  assert.equal(parseSelectionOrder("DESC"), "desc");
  assert.equal(parseSelectionOrder("Asc"), "asc");
});

test("rejects anything else", () => {
  assert.throws(() => parseSelectionOrder("newest"), /--order must be asc or desc/);
  assert.throws(() => parseSelectionOrder(""), /--order must be asc or desc/);
  assert.throws(() => parseSelectionOrder("descending"), /--order must be asc or desc/);
});

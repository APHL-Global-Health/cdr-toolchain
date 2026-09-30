import { test } from "node:test";
import assert from "node:assert/strict";
import { censorNumeric } from "./numeric-censoring.js";

const lim = (lowLimit: number | null, highLimit: number | null) => ({ lowLimit, highLimit });

test("below the low limit is sent as < with the limit", () => {
  assert.deepEqual(censorNumeric(0, lim(20, null)), { value: 20, comparator: "<" });
});

test("above the high limit is sent as > with the limit", () => {
  assert.deepEqual(censorNumeric(12000000, lim(null, 1e7)), { value: 10000000, comparator: ">" });
});

test("equal to a limit is not censored", () => {
  assert.deepEqual(censorNumeric(20, lim(20, null)), { value: 20, comparator: null });
  assert.deepEqual(censorNumeric(1e7, lim(null, 1e7)), { value: 1e7, comparator: null });
});

test("a value inside the range is unchanged", () => {
  assert.deepEqual(censorNumeric(540, lim(20, 1e7)), { value: 540, comparator: null });
});

test("no limits leaves the value unchanged", () => {
  assert.deepEqual(censorNumeric(0, lim(null, null)), { value: 0, comparator: null });
});

test("a float32 low limit goes out rounded to 7 significant digits", () => {
  assert.deepEqual(censorNumeric(0, lim(0.14000000059604645, null)), { value: 0.14, comparator: "<" });
});

test("a value equal to the unrounded float32 limit is not censored and is not rounded", () => {
  assert.deepEqual(
    censorNumeric(0.14000000059604645, lim(0.14000000059604645, null)),
    { value: 0.14000000059604645, comparator: null },
  );
});

test("a float32 high limit goes out rounded to 7 significant digits", () => {
  assert.deepEqual(censorNumeric(7, lim(null, 6.699999809265137)), { value: 6.7, comparator: ">" });
});

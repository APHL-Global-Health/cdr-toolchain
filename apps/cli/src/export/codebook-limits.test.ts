import { test } from "node:test";
import assert from "node:assert/strict";
import { readParmLimits } from "./codebook.js";

const OFFSETS = { highLimit: 103, lowLimit: 107 };

/** A latin1 string with one byte per char, as PARMDICT.Raw holds it. */
function raw(mut: (b: Buffer) => void, length = 200): string {
  const b = Buffer.alloc(length, 0);
  mut(b);
  return b.toString("latin1");
}

test("reads low and high limits as float32 little-endian", () => {
  const r = raw((b) => { b.writeFloatLE(1e7, 103); b.writeFloatLE(20, 107); });
  assert.deepEqual(readParmLimits(r, OFFSETS), { lowLimit: 20, highLimit: 10000000 });
});

test("high bytes survive (chars above 0x7f)", () => {
  const r = raw((b) => { b.writeFloatLE(-1.5, 103); b.writeFloatLE(3000000, 107); });
  assert.deepEqual(readParmLimits(r, OFFSETS), { lowLimit: 3000000, highLimit: -1.5 });
});

test("zero bytes give null (zero means no limit)", () => {
  assert.deepEqual(readParmLimits(raw(() => {}), OFFSETS), { lowLimit: null, highLimit: null });
});

test("one limit set and one zero", () => {
  const r = raw((b) => { b.writeFloatLE(6.7, 103); });
  const out = readParmLimits(r, OFFSETS);
  assert.equal(out.lowLimit, null);
  assert.ok(Math.abs(out.highLimit! - 6.7) < 1e-6);
});

test("null offsets give both null", () => {
  const r = raw((b) => { b.writeFloatLE(1e7, 103); b.writeFloatLE(20, 107); });
  assert.deepEqual(readParmLimits(r, null), { lowLimit: null, highLimit: null });
});

test("an offset past the end gives null", () => {
  assert.deepEqual(readParmLimits(raw(() => {}, 105), OFFSETS), { lowLimit: null, highLimit: null });
});

test("NaN and Infinity give null", () => {
  const r = raw((b) => { b.writeFloatLE(NaN, 103); b.writeFloatLE(Infinity, 107); });
  assert.deepEqual(readParmLimits(r, OFFSETS), { lowLimit: null, highLimit: null });
});

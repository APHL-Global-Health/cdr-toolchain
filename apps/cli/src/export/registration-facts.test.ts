import { test } from "node:test";
import assert from "node:assert/strict";
import { readRegistrationFacts } from "./registration-facts.js";
import type { RegistrationOffsets } from "../config/request-fact-config.js";

const TZ: RegistrationOffsets = {
  requestType: { offset: 333, values: new Map([[0, "D"], [8, "E"]]) },
  ageYears: { offset: 414 },
  ageDays: { offset: 417 },
  newborn: { offset: 409, mask: 2 },
};

function blob(set: Record<number, number>): string {
  const buf = Buffer.alloc(700, 0);
  for (const [i, v] of Object.entries(set)) buf[Number(i)] = v;
  return buf.toString("latin1");
}

test("decodes request type, age and newborn", () => {
  const f = readRegistrationFacts(blob({ 333: 8, 409: 2, 414: 1, 417: 0x80, 418: 0x02 }), TZ);
  assert.deepEqual(f, { requestType: "E", ageYears: 1, ageDays: 640, newborn: true });
});

test("byte 0 is the D request type, not a blank", () => {
  assert.equal(readRegistrationFacts(blob({}), TZ).requestType, "D");
});

test("a byte value the config does not name is null", () => {
  assert.equal(readRegistrationFacts(blob({ 333: 5 }), TZ).requestType, null);
});

test("zero age is empty, as v1 writes 0 as a filler", () => {
  const f = readRegistrationFacts(blob({}), TZ);
  assert.equal(f.ageYears, null);
  assert.equal(f.ageDays, null);
});

test("other bits in the newborn byte do not count", () => {
  assert.equal(readRegistrationFacts(blob({ 409: 4 }), TZ).newborn, false);
});

test("no blob or no offsets decodes nothing", () => {
  const none = { requestType: null, ageYears: null, ageDays: null, newborn: false };
  assert.deepEqual(readRegistrationFacts(null, TZ), none);
  assert.deepEqual(readRegistrationFacts(blob({ 333: 8, 414: 3 }), { requestType: null, ageYears: null, ageDays: null, newborn: null }), none);
});

test("an offset past the end of a short blob is null", () => {
  assert.equal(readRegistrationFacts("\u0000".repeat(100), TZ).ageYears, null);
});

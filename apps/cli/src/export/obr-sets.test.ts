import test from "node:test";
import assert from "node:assert/strict";
import { deriveObrSets, baseIndex } from "./obr-sets.js";

test("baseIndex strips the +100 second slot", () => {
  assert.equal(baseIndex(1), 1);
  assert.equal(baseIndex(100), 100);
  assert.equal(baseIndex(101), 1);
  assert.equal(baseIndex(113), 13);
});

test("one OBR per TestOrders position, in sequence", () => {
  // TZDISATDS0047711 — measured: v1 has OBR 1..5 = MRCSW,MRCSW,MRCSW,MICBM,MSENS
  const sets = deriveObrSets(["MRCSW", "MRCSW", "MRCSW", "MICBM", "MSENS"]);
  assert.deepEqual(sets.map((s) => s.obr_set_id), [1, 2, 3, 4, 5]);
  assert.deepEqual(sets.map((s) => s.panelCode), ["MRCSW", "MRCSW", "MRCSW", "MICBM", "MSENS"]);
});

test("repeated codes stay INTERLEAVED, never regrouped", () => {
  // TDS0068941 — v1 preserves [HIVVL,VLID,HIVVL,HIVVL]; regrouping by code is WRONG
  const sets = deriveObrSets(["HIVVL", "VLID", "HIVVL", "HIVVL"]);
  assert.deepEqual(sets.map((s) => s.panelCode), ["HIVVL", "VLID", "HIVVL", "HIVVL"]);
});

test("blank order codes are dropped, and numbering stays dense", () => {
  const sets = deriveObrSets(["COL", "", "  ", "RNAHF"]);
  assert.deepEqual(sets.map((s) => s.obr_set_id), [1, 2]);
  assert.deepEqual(sets.map((s) => s.panelCode), ["COL", "RNAHF"]);
});

test("an ordered panel with NO results still yields an OBR", () => {
  // TDS0109482 — TestOrders ["ROTEL"], TestResults EMPTY, v1 has OBR 1 status I
  const sets = deriveObrSets(["ROTEL"]);
  assert.deepEqual(sets, [{ obr_set_id: 1, panelCode: "ROTEL" }]);
});

import test from "node:test";
import assert from "node:assert/strict";
import { deriveObrSets, baseIndex, linkObsToObr } from "./obr-sets.js";

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

test("links each panel iteration to its ordered position", () => {
  const sets = deriveObrSets(["MRCSW", "MRCSW", "MRCSW", "MICBM", "MSENS"]);
  const link = linkObsToObr(sets, [
    { panelCode: "MRCSW", panelIndex: 1 },
    { panelCode: "MRCSW", panelIndex: 2 },
    { panelCode: "MRCSW", panelIndex: 3 },
    { panelCode: "MICBM", panelIndex: 4 },
    { panelCode: "MSENS", panelIndex: 5 },
  ]);
  assert.equal(link("MRCSW", 1), 1);
  assert.equal(link("MRCSW", 3), 3);
  assert.equal(link("MICBM", 4), 4);
  assert.equal(link("MSENS", 5), 5);
});

test("TESTINDEX is not the position — a gapped index links by RANK", () => {
  // TDS0083491: DISA HIVVL#2 -> v1 OBR 1. TDS0024458: HIVVL#2,#4 -> OBR 1,2.
  const one = deriveObrSets(["HIVVL"]);
  assert.equal(linkObsToObr(one, [{ panelCode: "HIVVL", panelIndex: 2 }])("HIVVL", 2), 1);

  const two = deriveObrSets(["HIVVL", "HIVVL"]);
  const link = linkObsToObr(two, [
    { panelCode: "HIVVL", panelIndex: 2 },
    { panelCode: "HIVVL", panelIndex: 4 },
  ]);
  assert.equal(link("HIVVL", 2), 1);
  assert.equal(link("HIVVL", 4), 2);
});

test("a +100 second slot links to its BASE OBR, not a new one", () => {
  // TDS0012427: orders [COL,RNAHF]; results COL#1, COL#101, RNAHF#2 -> v1 has 2 rows
  const sets = deriveObrSets(["COL", "RNAHF"]);
  const link = linkObsToObr(sets, [
    { panelCode: "COL", panelIndex: 1 },
    { panelCode: "COL", panelIndex: 101 },
    { panelCode: "RNAHF", panelIndex: 2 },
  ]);
  assert.equal(link("COL", 1), 1);
  assert.equal(link("COL", 101), 1); // same OBR as its base
  assert.equal(link("RNAHF", 2), 2);
});

test("rule P: results that don't cover every order never misfile onto another code", () => {
  // NO LIVE LAB EXERCISES THIS (spec §4.1) — it is why we match on code first.
  // Global rank would rank B's only iteration to position 1 and file it under A.
  const sets = deriveObrSets(["A", "B"]);
  const link = linkObsToObr(sets, [{ panelCode: "B", panelIndex: 2 }]);
  assert.equal(link("B", 2), 2); // B's own slot, NOT A's
  assert.equal(link("A", 1), null); // A was ordered but never resulted
});

test("an unknown panel code links to no OBR rather than guessing", () => {
  const sets = deriveObrSets(["COL"]);
  assert.equal(linkObsToObr(sets, [{ panelCode: "ZZZ", panelIndex: 1 }])("ZZZ", 1), null);
});

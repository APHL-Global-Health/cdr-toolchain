import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreFR, scoreTimestamp } from "./review-score.js";

test("scoreFR reproduces the 2026-07-16 confusion matrix shape", () => {
  const rows = [
    ...Array.from({ length: 7 }, () => ({ initialsPresent: true,  v1Status: "F" })),
    ...Array.from({ length: 2 }, () => ({ initialsPresent: false, v1Status: "R" })),
    { initialsPresent: false, v1Status: "F" },
    { initialsPresent: true,  v1Status: "R" },
  ];
  const m = scoreFR(rows);
  assert.equal(m.fCorrect, 7);
  assert.equal(m.rCorrect, 2);
  assert.equal(m.fMiss, 1);
  assert.equal(m.rMiss, 1);
  assert.equal(m.total, 11);
  assert.equal(Math.round(m.accuracy * 10000) / 10000, 0.8182);
});

test("scoreFR ignores I and X — the rule only claims F vs R", () => {
  const m = scoreFR([
    { initialsPresent: true,  v1Status: "F" },
    { initialsPresent: false, v1Status: "I" },
    { initialsPresent: true,  v1Status: "X" },
  ]);
  assert.equal(m.total, 1);
  assert.equal(m.fCorrect, 1);
});

test("scoreFR is case- and whitespace-insensitive on the v1 label", () => {
  const m = scoreFR([{ initialsPresent: true, v1Status: " f " }]);
  assert.equal(m.fCorrect, 1);
});

test("scoreFR on zero scorable rows reports 0 accuracy, not NaN", () => {
  const m = scoreFR([{ initialsPresent: true, v1Status: "I" }]);
  assert.equal(m.total, 0);
  assert.equal(m.accuracy, 0);
});

test("scoreTimestamp counts a hit inside tolerance and a miss outside", () => {
  const target = new Date("2017-05-18T09:00:00Z");
  const s = scoreTimestamp([
    { decoded: new Date("2017-05-18T09:00:30Z"), target },
    { decoded: new Date("2017-05-18T09:05:00Z"), target },
    { decoded: null, target },
  ], 60);
  assert.equal(s.hits, 1);
  assert.equal(s.total, 3);
});

test("scoreTimestamp counts an undecodable row as a miss, never skips it", () => {
  const s = scoreTimestamp([{ decoded: null, target: new Date() }], 60);
  assert.equal(s.hits, 0);
  assert.equal(s.total, 1);
  assert.equal(s.rate, 0);
});

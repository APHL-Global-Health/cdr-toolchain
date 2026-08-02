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

// `decoded` is built the way decodeLongDatetime actually builds it — the
// LOCAL Date constructor — and `target` the way mssql actually returns
// Requests.AuthorisedDateTime — wall-clock components tagged as UTC. Using
// that construction (rather than two same-instant ISO "Z" strings) is
// deliberate: it is host-timezone-independent and it exercises the real
// bug (see "scoreTimestamp compares wall clock, not instant" below), where
// same-instant fixtures would not.
test("scoreTimestamp counts a hit inside tolerance and a miss outside", () => {
  const target = new Date(Date.UTC(2017, 4, 18, 9, 0, 0));
  const s = scoreTimestamp([
    { decoded: new Date(2017, 4, 18, 9, 0, 30), target },
    { decoded: new Date(2017, 4, 18, 9, 5, 0), target },
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

// Regression test for the timezone trap: decodeLongDatetime builds its Date
// with the LOCAL constructor while mssql's AuthorisedDateTime is wall-clock
// components tagged as UTC. The OLD instant-comparing implementation
// (Math.abs(a.getTime() - b.getTime())) sees these as ~3h apart on any host
// west of UTC-and-of-Africa/Dar_es_Salaam's offset and scores a correct
// decode as a miss. This must FAIL under that implementation and PASS once
// scoreTimestamp compares wall clock instead of instant.
test("scoreTimestamp matches a local-constructed decode against a UTC-tagged target for the same wall clock (timezone trap)", () => {
  const decoded = new Date(2017, 4, 18, 9, 0, 0); // decodeLongDatetime's local ctor
  const target = new Date(Date.UTC(2017, 4, 18, 9, 0, 0)); // mssql's UTC-tagged wall clock
  const s = scoreTimestamp([{ decoded, target }], 60);
  assert.equal(s.hits, 1, "same wall clock (09:00) in different frames must be a hit, not a ~3h miss");
});

// Boundary: a difference exactly equal to the tolerance must count as a
// HIT — the comparison is inclusive (<=). This catches a regression that
// changes <= to <.
test("scoreTimestamp treats a difference exactly equal to the tolerance as a hit", () => {
  const decoded = new Date(2017, 4, 18, 9, 1, 0); // wall clock 09:01:00
  const target = new Date(Date.UTC(2017, 4, 18, 9, 0, 0)); // wall clock 09:00:00 — 60s earlier
  const s = scoreTimestamp([{ decoded, target }], 60);
  assert.equal(s.hits, 1);
});

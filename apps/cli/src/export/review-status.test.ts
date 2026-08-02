import { test } from "node:test";
import assert from "node:assert/strict";
import { TestDataHeader, HEADER_LENGTH } from "disalab";
import { buildStatusByObr, type PanelIteration } from "./review-status.js";

const OFFSETS = { reviewerInitials: { start: 77, end: 80 }, reviewedAt: null };

function header(reviewed: boolean): TestDataHeader {
  const b = Buffer.alloc(HEADER_LENGTH, 0);
  if (reviewed) { b[77] = 65; b[78] = 80; b[79] = 66; }
  return TestDataHeader.fromBytes(b);
}

function iter(panelCode: string, panelIndex: number, reviewed: boolean, datestamp: Date | null = null): PanelIteration {
  return { panelCode, panelIndex, datestamp, header: header(reviewed) };
}

/** Maps (code, index) pairs to explicit obr ids. */
function obrOfMap(m: Record<string, number>) {
  return (panelCode: string, panelIndex: number): number | null => m[`${panelCode}:${panelIndex}`] ?? null;
}

test("reviewed panel with results is F", () => {
  const s = buildStatusByObr({
    iterations: [iter("HIVVL", 1, true)],
    obrOf: obrOfMap({ "HIVVL:1": 1 }),
    obsCountByObr: new Map([[1, 3]]),
    rejected: false,
    offsets: OFFSETS,
  });
  assert.equal(s.get(1)?.status, "F");
});

test("unreviewed panel with results is R", () => {
  const s = buildStatusByObr({
    iterations: [iter("HIVVL", 1, false)],
    obrOf: obrOfMap({ "HIVVL:1": 1 }),
    obsCountByObr: new Map([[1, 3]]),
    rejected: false,
    offsets: OFFSETS,
  });
  assert.equal(s.get(1)?.status, "R");
});

test("zero observations is I, and I beats the review signal", () => {
  const s = buildStatusByObr({
    iterations: [iter("HIVVL", 1, true)],
    obrOf: obrOfMap({ "HIVVL:1": 1 }),
    obsCountByObr: new Map([[1, 0]]),
    rejected: false,
    offsets: OFFSETS,
  });
  assert.equal(s.get(1)?.status, "I");
});

test("rejection wins over everything — X beats I and F", () => {
  const s = buildStatusByObr({
    iterations: [iter("HIVVL", 1, true)],
    obrOf: obrOfMap({ "HIVVL:1": 1 }),
    obsCountByObr: new Map([[1, 0]]),
    rejected: true,
    offsets: OFFSETS,
  });
  assert.equal(s.get(1)?.status, "X");
});

// ---- THE GRAIN TRAP ------------------------------------------------------
// supersedePanelIterations picks ONE winner keyed on panelCode alone, but OBR
// grain is (panelCode, base(TESTINDEX)). When one code spans two OBRs, a
// panelCode-level winner would leak one panel's review state onto its sibling.
test("one panel code across two OBRs resolves each OBR independently", () => {
  const s = buildStatusByObr({
    iterations: [iter("HIVVL", 1, true), iter("HIVVL", 2, false)],
    obrOf: obrOfMap({ "HIVVL:1": 1, "HIVVL:2": 2 }),
    obsCountByObr: new Map([[1, 2], [2, 2]]),
    rejected: false,
    offsets: OFFSETS,
  });
  assert.equal(s.get(1)?.status, "F", "OBR 1 was reviewed");
  assert.equal(s.get(2)?.status, "R", "OBR 2 was NOT reviewed and must not inherit OBR 1's F");
});

test("within one OBR the latest iteration wins by datestamp", () => {
  const older = iter("COL", 1, false, new Date("2017-01-01T00:00:00Z"));
  const newer = iter("COL", 101, true, new Date("2018-01-01T00:00:00Z")); // base(101) === 1
  const s = buildStatusByObr({
    iterations: [older, newer],
    obrOf: obrOfMap({ "COL:1": 1 }),
    obsCountByObr: new Map([[1, 2]]),
    rejected: false,
    offsets: OFFSETS,
  });
  assert.equal(s.get(1)?.status, "F", "the later iteration was reviewed");
});

test("with equal datestamps the higher panelIndex wins", () => {
  const d = new Date("2018-01-01T00:00:00Z");
  const s = buildStatusByObr({
    iterations: [iter("COL", 1, false, d), iter("COL", 101, true, d)],
    obrOf: obrOfMap({ "COL:1": 1 }),
    obsCountByObr: new Map([[1, 2]]),
    rejected: false,
    offsets: OFFSETS,
  });
  assert.equal(s.get(1)?.status, "F");
});

test("a missing header is flagged undecodable and falls back to R, never crashes", () => {
  const s = buildStatusByObr({
    iterations: [{ panelCode: "HIVVL", panelIndex: 1, datestamp: null, header: null }],
    obrOf: obrOfMap({ "HIVVL:1": 1 }),
    obsCountByObr: new Map([[1, 2]]),
    rejected: false,
    offsets: OFFSETS,
  });
  assert.equal(s.get(1)?.status, "R");
  assert.equal(s.get(1)?.headerUndecodable, true);
});

test("an unmeasured deployment yields null status, NOT a defaulted R", () => {
  const s = buildStatusByObr({
    iterations: [iter("HIVVL", 1, true)],
    obrOf: obrOfMap({ "HIVVL:1": 1 }),
    obsCountByObr: new Map([[1, 3]]),
    rejected: false,
    offsets: { reviewerInitials: null, reviewedAt: null },
  });
  assert.equal(s.get(1)?.status, null);
  assert.equal(s.get(1)?.authorisedAt, null);
});

test("an unmeasured deployment STILL reports X and I, which need no offsets", () => {
  const unmeasured = { reviewerInitials: null, reviewedAt: null };
  const rejected = buildStatusByObr({
    iterations: [iter("HIVVL", 1, true)],
    obrOf: obrOfMap({ "HIVVL:1": 1 }),
    obsCountByObr: new Map([[1, 3]]),
    rejected: true,
    offsets: unmeasured,
  });
  assert.equal(rejected.get(1)?.status, "X");

  const interim = buildStatusByObr({
    iterations: [iter("HIVVL", 1, true)],
    obrOf: obrOfMap({ "HIVVL:1": 1 }),
    obsCountByObr: new Map([[1, 0]]),
    rejected: false,
    offsets: unmeasured,
  });
  assert.equal(interim.get(1)?.status, "I");
});

test("an ordered-but-unresulted OBR with no iteration at all is I", () => {
  const s = buildStatusByObr({
    iterations: [],
    obrOf: obrOfMap({}),
    obsCountByObr: new Map([[1, 0]]),
    rejected: false,
    offsets: OFFSETS,
  });
  assert.equal(s.get(1)?.status, "I");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  V1_REQUEST_BOOKKEEPING,
  V1_RESULT_BOOKKEEPING,
  V1_REQUEST_NOT_CARRIED,
  V1_RESULT_NOT_CARRIED,
  V1_REQUEST_MEASURED_EMPTY,
  V1_RESULT_MEASURED_EMPTY,
} from "./v1-coverage.js";
import {
  V2_REQUEST_FIELDS,
  V2_REQUEST_EXCEPTIONS,
  V2_RESULT_FIELDS,
  V2_RESULT_EXCEPTIONS,
  V1_RESULT_PAIRING_KEY,
} from "./v2-mapping.js";

const schema = JSON.parse(
  readFileSync(new URL("./v1-schema.json", import.meta.url), "utf8"),
) as { tables: { Requests: string[]; LabResults: string[] } };

// THE STALENESS GUARD. The snapshot's only failure mode is going stale, or being
// regenerated against a partial/wrong database. Pinning the COUNT makes that fail
// loudly here instead of silently shrinking what the coverage guard checks — a
// quiet shrink is the exact bug this slice exists to kill.
// Measured against INFORMATION_SCHEMA on 2026-07-17.
test("the v1 schema snapshot has v1's real column counts", () => {
  assert.equal(schema.tables.Requests.length, 60);
  assert.equal(schema.tables.LabResults.length, 28);
});

// Guards the guard: a snapshot of 60 empty strings would satisfy the counts above.
test("the snapshot holds real column names", () => {
  for (const t of ["Requests", "LabResults"] as const) {
    for (const c of schema.tables[t]) {
      assert.ok(typeof c === "string" && c.trim().length > 0, `${t}: blank column name`);
    }
  }
  assert.ok(schema.tables.Requests.includes("OBRSetID"));
  assert.ok(schema.tables.LabResults.includes("LIMSRptFlag"));
});

// ---------------------------------------------------------------------------
// THE GUARD THIS SLICE EXISTS FOR. The old one asserted over OpenLdrV1Request --
// our SELECT -- and called it "every v1 column". It covered 26 of 60.
// ---------------------------------------------------------------------------

test("every v1 Requests column is classified", () => {
  const covered = new Set<string>([
    ...V2_REQUEST_FIELDS.map((f) => f.v1Column),
    ...V2_REQUEST_EXCEPTIONS.map((e) => e.v1Column),
    ...V1_REQUEST_BOOKKEEPING,
    ...V1_REQUEST_NOT_CARRIED.map((n) => n.column),
    ...V1_REQUEST_MEASURED_EMPTY.map((n) => n.column),
  ]);
  const uncovered = schema.tables.Requests.filter((c) => !covered.has(c));
  assert.deepEqual(uncovered, [], `unclassified v1 Requests columns: ${uncovered.join(", ")}`);
});

test("every v1 LabResults column is classified", () => {
  const covered = new Set<string>([
    ...V2_RESULT_FIELDS.map((f) => f.v1Column),
    ...V2_RESULT_EXCEPTIONS.map((e) => e.v1Column),
    ...V1_RESULT_PAIRING_KEY, // RequestID / LIMSPanelCode / LIMSObservationCode
    ...V1_RESULT_BOOKKEEPING,
    ...V1_RESULT_NOT_CARRIED.map((n) => n.column),
    ...V1_RESULT_MEASURED_EMPTY.map((n) => n.column),
  ]);
  // LIMSPanelCode / LIMSPanelDesc are joined in from Requests (openldr.ts:217),
  // so they are not LabResults columns and never appear in this snapshot.
  const uncovered = schema.tables.LabResults.filter((c) => !covered.has(c));
  assert.deepEqual(uncovered, [], `unclassified v1 LabResults columns: ${uncovered.join(", ")}`);
});

// Exactly one bucket each. A column that is both graded and not_carried would
// silently never be fetched while claiming to be graded.
test("no v1 column is in two buckets", () => {
  const req = [
    ...V2_REQUEST_FIELDS.map((f) => f.v1Column),
    ...V2_REQUEST_EXCEPTIONS.map((e) => e.v1Column),
    ...V1_REQUEST_BOOKKEEPING,
    ...V1_REQUEST_NOT_CARRIED.map((n) => n.column),
  ];
  const dupes = req.filter((c, i) => req.indexOf(c) !== i);
  assert.deepEqual(dupes, [], `v1 Requests columns in two buckets: ${dupes.join(", ")}`);
});

// not_carried is NOT GRADED, so a mistake in it is invisible in the report.
// These are the only automated checks it gets.
test("every not_carried entry carries a measurement, a reason and a decider", () => {
  for (const n of [...V1_REQUEST_NOT_CARRIED, ...V1_RESULT_NOT_CARRIED]) {
    assert.ok(n.measured.trim().length > 0, `${n.column}: no measurement`);
    assert.ok(!/^n\/?a$/i.test(n.measured.trim()), `${n.column}: "n/a" is not a measurement`);
    assert.ok(n.reason.trim().length > 0, `${n.column}: no reason`);
    assert.ok(n.decidedBy.trim().length > 0, `${n.column}: no decider`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(n.decidedOn), `${n.column}: decidedOn must be YYYY-MM-DD`);
  }
});

// The stated plan is "we will slowly add them back bit by bit". A bucket that
// cannot say "parked" vs "gone" turns that into archaeology through a git log.
test("the columns promised a revisit actually carry one", () => {
  const parked = new Set([
    "HL7SpecimenSourceCode",
    "HL7SpecimenSiteCode",
    "LIMSSpecimenSiteCode",
    "LIMSSpecimenSiteDesc",
    "ReceivingFacilityCode",
    "EncryptedPatientID",
  ]);
  for (const n of V1_REQUEST_NOT_CARRIED) {
    if (parked.has(n.column)) {
      assert.ok(
        n.revisit !== undefined && n.revisit.trim().length > 0,
        `${n.column}: parked but no revisit note`,
      );
    }
  }
});

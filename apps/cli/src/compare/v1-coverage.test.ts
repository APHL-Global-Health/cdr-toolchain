import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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

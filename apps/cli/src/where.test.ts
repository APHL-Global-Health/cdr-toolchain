import { test } from "node:test";
import assert from "node:assert/strict";
import { composeBatchSelection } from "./where.js";

test("composes an ascending clause with no user WHERE", () => {
  assert.equal(
    composeBatchSelection("", "[LabNo]", 100, 0, "asc"),
    " ORDER BY [LabNo] OFFSET 0 ROWS FETCH NEXT 100 ROWS ONLY",
  );
});

test("ascending never emits the word DESC", () => {
  const clause = composeBatchSelection("", "[LabNo]", 10, 0, "asc");
  assert.ok(!/\bDESC\b/.test(clause), `unexpected DESC in ${clause}`);
});

test("descending emits DESC after the column", () => {
  assert.equal(
    composeBatchSelection("", "[LabNo]", 10, 0, "desc"),
    " ORDER BY [LabNo] DESC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY",
  );
});

test("keeps a bare user clause and prefixes WHERE", () => {
  assert.equal(
    composeBatchSelection("LabNo > 'TDS0125000'", "[LabNo]", 5, 0, "asc"),
    "WHERE LabNo > 'TDS0125000' ORDER BY [LabNo] OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY",
  );
});

test("does not double the WHERE keyword when the user supplied it", () => {
  assert.equal(
    composeBatchSelection("WHERE LabNo > 'TDS0125000'", "[LabNo]", 5, 0, "desc"),
    "WHERE LabNo > 'TDS0125000' ORDER BY [LabNo] DESC OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY",
  );
});

test("carries a non-zero offset", () => {
  assert.equal(
    composeBatchSelection("", "[LabNo]", 50, 200, "desc"),
    " ORDER BY [LabNo] DESC OFFSET 200 ROWS FETCH NEXT 50 ROWS ONLY",
  );
});

test("undefined user clause behaves like an empty one", () => {
  assert.equal(
    composeBatchSelection(undefined, "[LabNo]", 1, 0, "asc"),
    " ORDER BY [LabNo] OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY",
  );
});

test("orders by the column argument, not a hardcoded one", () => {
  assert.equal(
    composeBatchSelection("", "[RequestID]", 10, 0, "asc"),
    " ORDER BY [RequestID] OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY",
  );
});

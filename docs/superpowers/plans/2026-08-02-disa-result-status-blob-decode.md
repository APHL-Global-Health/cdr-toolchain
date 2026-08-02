# DISA result status + authorisation time from the TESTDATA blob header — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode DISA's per-panel review signal out of the `TESTDATA_STATUS` blob header so `result_status` and `authorised_at` stop being hardcoded nulls, and CE's Specimen Turnaround Time report returns rows.

**Architecture:** The first 80 bytes of `TESTDATA_STATUS` are a header the decoder currently discards (`TESTDATA.ts:39` reads from offset 80 onward). A new `TestDataHeader` value object exposes that header. A measurement command scores candidate decodes against OpenLDR v1 as ground truth **before** any production rule ships. Only after the measurement gate passes do the offsets move into `config/<country>.yaml` and the values get wired onto the per-OBR `V2LabRequest`.

**Tech Stack:** TypeScript 5, Node 20+, `node:test` + `node:assert/strict`, `commander`, `mssql`, `yaml`, `zod`, pnpm monorepo (`apps/cli`, `packages/disalab`).

**Spec:** `docs/superpowers/specs/2026-08-02-disa-result-status-blob-decode-design.md`
**Branch:** `feat/disa-result-status-blob-decode`

## Global Constraints

- **All DISA and v1 database access is READ-ONLY.** No writes, ever, to `DisalabData`, `DisaGlobal`, `DisalabDict`, or `OpenLDRData`.
- **Never hardcode country-specific values.** Byte offsets go in `config/<country>.yaml` (CLAUDE.md). Existing files: `config/tanzania.yaml`, `config/zambia.yaml`.
- **Per-row decode failures are warnings, never quarantine.** A header that will not decode yields `null` — today's behaviour exactly.
- **Negative turnarounds are emitted and flagged, not nulled** (PRD "garbage in, flagged out", §1 and §14).
- **Success = matching the measured ceiling (~99%), not 100.0000%.** `A` status is underivable (624 rows in 3.4M).
- **Do NOT add a `Co-Authored-By: Claude` trailer** to any commit (repo convention).
- **Phase 1 is a hard gate.** ≥95% minute-exact on the labelled timestamp rows, or stop and ship status alone.
- Bytes are handled as a **latin1 string** (`Core.ConvertToBytes` → `charCodeAt(i) & 0xff` is byte `i`). Never `Buffer.toString('utf8')`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/disalab/src/lib/DisalabData/testdata-header.ts` | **Create.** `TestDataHeader` value object: raw 80 bytes, `reviewerInitials`, `byteAt()`. Owns the header layout. |
| `packages/disalab/src/lib/DisalabData/testdata-header.test.ts` | **Create.** Unit tests for the above. |
| `packages/disalab/src/lib/DisalabData/TESTDATA.ts` | **Modify** (`:32-42`). Populate `HEADER` in `initialize()`. |
| `packages/disalab/src/index.ts` | **Modify.** Export `TestDataHeader`. |
| `apps/cli/src/compare/disa-datetime-candidates.ts` | **Create.** Datetime candidate decoders extracted verbatim from `probe-bytes.ts` so the search and the probe share one implementation. |
| `apps/cli/src/commands/probe-bytes.ts` | **Modify** (`:71-135`). Import the extracted decoders instead of defining them. |
| `apps/cli/src/compare/review-score.ts` | **Create.** Pure scoring: F/R confusion matrix, timestamp candidate hit-rate. |
| `apps/cli/src/compare/review-score.test.ts` | **Create.** Unit tests for scoring. |
| `apps/cli/src/commands/probe-review.ts` | **Create.** The measurement command (Phase 1). Joins DISA→v1, prints the matrix. |
| `apps/cli/src/index.ts` | **Modify.** Register `probe-review`. |
| `apps/cli/src/config/blob-offsets.ts` | **Create.** Zod schema + loader + semantic self-check for `disa_blob_offsets`. |
| `apps/cli/src/config/blob-offsets.test.ts` | **Create.** Unit tests for validation and the guard. |
| `config/tanzania.yaml`, `config/zambia.yaml` | **Modify.** Add `disa_blob_offsets`. |
| `apps/cli/src/export/review-status.ts` | **Create.** `buildStatusByObr()` — per-OBR header resolution + X/I/F/R rule. |
| `apps/cli/src/export/review-status.test.ts` | **Create.** Unit tests incl. the grain trap. |
| `apps/cli/src/export/v2-transform.ts` | **Modify** (`:235-343`, `:682-712`). Thread `statusByObr` into `buildLabRequest`. |
| `apps/cli/src/compare/v2-mapping.test.ts` | **Modify** (`:48-56`). Retire the assertion that the stub is RED. |

---

## Phase 0 — Expose the header

### Task 1: `TestDataHeader` value object

**Files:**
- Create: `packages/disalab/src/lib/DisalabData/testdata-header.ts`
- Test: `packages/disalab/src/lib/DisalabData/testdata-header.test.ts`

**Interfaces:**
- Consumes: `Core.ConvertToBytes`, `Core.FixString` from `packages/disalab/src/lib/core.ts`.
- Produces: `HEADER_LENGTH: 80`, `interface HeaderOffsets { reviewerInitials: { start: number; end: number } }`, `DEFAULT_HEADER_OFFSETS`, `class TestDataHeader` with `readonly raw: string`, `readonly reviewerInitials: string | null`, `byteAt(index: number): number`, `static fromDecoded(data: string, offsets?: HeaderOffsets): TestDataHeader`, `static fromBytes(bytes: DisaInput, offsets?: HeaderOffsets): TestDataHeader`.

- [ ] **Step 1: Write the failing test**

Create `packages/disalab/src/lib/DisalabData/testdata-header.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TestDataHeader, HEADER_LENGTH } from "./testdata-header.js";

/** Build a TESTDATA_STATUS blob: 80-byte header + result payload. */
function blob(mutate: (b: Buffer) => void, payload = "PAYLOAD"): Buffer {
  const b = Buffer.alloc(HEADER_LENGTH + payload.length, 0);
  mutate(b);
  b.write(payload, HEADER_LENGTH, "latin1");
  return b;
}

test("reviewer initials decode from bytes 77-79 (the observed APB case)", () => {
  const h = TestDataHeader.fromBytes(blob((b) => { b[77] = 65; b[78] = 80; b[79] = 66; }));
  assert.equal(h.reviewerInitials, "APB");
});

test("an all-zero initials slot means NOT reviewed, decoding to null", () => {
  const h = TestDataHeader.fromBytes(blob(() => {}));
  assert.equal(h.reviewerInitials, null);
});

test("raw stops at the header boundary and never reads result payload", () => {
  const h = TestDataHeader.fromBytes(blob(() => {}, "ZZZZZZZZ"));
  assert.equal(h.raw.length, HEADER_LENGTH);
});

test("byteAt exposes raw bytes so the Phase 1 search can read uint16LE at 23", () => {
  const h = TestDataHeader.fromBytes(blob((b) => { b.writeUInt16LE(2017, 23); }));
  assert.equal(h.byteAt(23) | (h.byteAt(24) << 8), 2017);
});

test("byteAt returns 0 past the end instead of NaN", () => {
  const h = TestDataHeader.fromBytes(Buffer.alloc(10, 0));
  assert.equal(h.byteAt(79), 0);
});

test("initials slot padded with spaces still reads as not-reviewed", () => {
  const h = TestDataHeader.fromBytes(blob((b) => { b[77] = 32; b[78] = 32; b[79] = 32; }));
  assert.equal(h.reviewerInitials, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter disalab exec node --import tsx --test "src/lib/DisalabData/testdata-header.test.ts"
```

Expected: FAIL — `Cannot find module './testdata-header.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/disalab/src/lib/DisalabData/testdata-header.ts`:

```ts
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";

/**
 * TESTDATA_STATUS is a fixed 80-byte header followed by the result payload.
 * TESTDATA.ts has always parsed from offset 80 onward; bytes 0-79 were never
 * decoded, which is why the review signal sat unread in every row.
 */
export const HEADER_LENGTH = 80;

export interface HeaderOffsets {
  /** `end` is EXCLUSIVE. Reviewer initials, ASCII. */
  reviewerInitials: { start: number; end: number };
}

/**
 * Tanzania (TDS) measured default. Other deployments MUST re-measure — DISA
 * versions vary even within one database. See config/<country>.yaml.
 */
export const DEFAULT_HEADER_OFFSETS: HeaderOffsets = {
  reviewerInitials: { start: 77, end: 80 },
};

function readInitials(raw: string, slot: { start: number; end: number }): string | null {
  const slice = Core.FixString(raw, slot.start, slot.end);
  let out = "";
  for (let i = 0; i < slice.length; i++) {
    const b = slice.charCodeAt(i) & 0xff;
    if (b === 0) continue;
    out += String.fromCharCode(b);
  }
  const trimmed = out.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export class TestDataHeader {
  /** latin1 string — charCodeAt(i) & 0xff is byte i. Length <= HEADER_LENGTH. */
  readonly raw: string;
  /** Non-null ⇒ the panel was reviewed. Null ⇒ not reviewed. */
  readonly reviewerInitials: string | null;

  private constructor(raw: string, reviewerInitials: string | null) {
    this.raw = raw;
    this.reviewerInitials = reviewerInitials;
  }

  /** Preferred entry point when the caller has already decoded the blob. */
  static fromDecoded(data: string, offsets: HeaderOffsets = DEFAULT_HEADER_OFFSETS): TestDataHeader {
    const raw = Core.FixString(data, 0, HEADER_LENGTH);
    return new TestDataHeader(raw, readInitials(raw, offsets.reviewerInitials));
  }

  static fromBytes(bytes: DisaInput, offsets: HeaderOffsets = DEFAULT_HEADER_OFFSETS): TestDataHeader {
    return TestDataHeader.fromDecoded(Core.ConvertToBytes(bytes), offsets);
  }

  /** Raw byte at `index`, or 0 past the end. Used by the Phase 1 search. */
  byteAt(index: number): number {
    return index < this.raw.length ? this.raw.charCodeAt(index) & 0xff : 0;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter disalab exec node --import tsx --test "src/lib/DisalabData/testdata-header.test.ts"
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add packages/disalab/src/lib/DisalabData/testdata-header.ts packages/disalab/src/lib/DisalabData/testdata-header.test.ts
git commit -m "feat(disalab): add TestDataHeader for the TESTDATA_STATUS 80-byte header"
```

---

### Task 2: Populate `TESTDATA.HEADER`

**Files:**
- Modify: `packages/disalab/src/lib/DisalabData/TESTDATA.ts:32-42`
- Modify: `packages/disalab/src/index.ts`
- Test: `packages/disalab/src/lib/DisalabData/testdata-header.test.ts` (append)

**Interfaces:**
- Consumes: `TestDataHeader.fromDecoded` from Task 1.
- Produces: `TESTDATA.HEADER: TestDataHeader | null`; `TestDataHeader` exported from the `disalab` package root.

- [ ] **Step 1: Write the failing test**

Append to `packages/disalab/src/lib/DisalabData/testdata-header.test.ts`:

```ts
import { TESTDATA } from "./TESTDATA.js";

test("TESTDATA.HEADER is populated even without a server, and payload parsing is unchanged", async () => {
  const b = Buffer.alloc(HEADER_LENGTH + 4, 0);
  b[77] = 65; b[78] = 80; b[79] = 66;
  b.write("DATA", HEADER_LENGTH, "latin1");

  // No server ⇒ initialize() returns before OrderItem.Parse, but HEADER must
  // still be set: the header is a property of the bytes, not of the server.
  const t = new TESTDATA(null, "TDS0010012", "HIVVL", 1, b);
  await t.initialize(b);

  assert.equal(t.HEADER?.reviewerInitials, "APB");
  assert.deepEqual(t.ORDER, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter disalab exec node --import tsx --test "src/lib/DisalabData/testdata-header.test.ts"
```

Expected: FAIL — `t.HEADER` is `undefined`.

- [ ] **Step 3: Write minimal implementation**

In `packages/disalab/src/lib/DisalabData/TESTDATA.ts`, add the import at the top:

```ts
import { TestDataHeader } from "./testdata-header.js";
```

Add the field beside the existing ones (after `TESTINDEX: unknown;`):

```ts
  /**
   * Bytes 0-79 of TESTDATA_STATUS. Carries the review signal (reviewer
   * initials ⇒ F/R). Null only if initialize() was never called.
   */
  HEADER: TestDataHeader | null = null;
```

Replace `initialize` (`:32-42`) with:

```ts
  async initialize(bytes: DisaInput): Promise<void> {
    // Decode ONCE and share: ConvertToBytes runs iconv over the whole blob,
    // and this runs per TESTDATA row (191k+ on a full site).
    const _data = Core.ConvertToBytes(bytes);
    // Set before the server guard — the header is a property of the bytes.
    this.HEADER = TestDataHeader.fromDecoded(_data);
    if (this.#server === undefined) return;
    this.ORDER = await OrderItem.Parse(
      this.LABNO,
      this.TESTCODE,
      this.TESTINDEX,
      Core.FixString(_data, 80, _data.length).trim(),
      this.#server,
    );
  }
```

In `packages/disalab/src/index.ts`, add beside the other `DisalabData` exports:

```ts
export { TestDataHeader, HEADER_LENGTH, DEFAULT_HEADER_OFFSETS } from "./lib/DisalabData/testdata-header.js";
export type { HeaderOffsets } from "./lib/DisalabData/testdata-header.js";
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter disalab exec node --import tsx --test "src/lib/DisalabData/testdata-header.test.ts"
pnpm --filter disalab build
```

Expected: PASS, 7 tests. Build succeeds.

> ⚠ `pnpm --filter disalab build` is REQUIRED after any change to `disalab/src` — `apps/cli` consumes the built output, and skipping it produces confusing stale-code failures downstream.

- [ ] **Step 5: Commit**

```bash
git add packages/disalab/src/lib/DisalabData/TESTDATA.ts packages/disalab/src/index.ts packages/disalab/src/lib/DisalabData/testdata-header.test.ts
git commit -m "feat(disalab): populate TESTDATA.HEADER from the blob header bytes"
```

---

## Phase 1 — Measure before any production rule

### Task 3: Extract the datetime candidate decoders

`probe-bytes.ts` already implements the candidate decoders the timestamp search needs. Extract rather than duplicate.

**Files:**
- Create: `apps/cli/src/compare/disa-datetime-candidates.ts`
- Modify: `apps/cli/src/commands/probe-bytes.ts:71-135`

**Interfaces:**
- Produces, moved **verbatim** (bodies unchanged) from `probe-bytes.ts`:
  - `decodeLongDate(data: string, offset: number, minY: number, maxY: number): Date | null`
  - `decodeLongTime(data: string, offset: number): Date | null`
  - `decodeLongDatetime(data: string, offset: number, minY: number, maxY: number): Date | null`
  - `decodeShortDate(data: string, offset: number, minY: number, maxY: number): Date | null`
  - `decodeShortDatetime(data: string, offset: number, minY: number, maxY: number): Date | null`
  - `decodeShortTimeOnly(data: string, offset: number): { hours: number; mins: number } | null`
  - `decodeLongTimeOnly(data: string, offset: number): { hours: number; mins: number } | null`

- [ ] **Step 1: Move the functions**

Create `apps/cli/src/compare/disa-datetime-candidates.ts`. Cut lines `71-135` of `apps/cli/src/commands/probe-bytes.ts` into it **unchanged**, adding `export` to each of the seven functions and carrying over any imports they use (`BitConverter` / `Core` from `disalab`). Add a file header comment:

```ts
/**
 * DISA packed date/time candidate decoders, shared by `probe-bytes` (manual
 * reverse-engineering) and `probe-review` (scored search against v1).
 * Extracted from probe-bytes.ts unchanged — do not "improve" them here without
 * re-running both commands; probe-bytes' output is calibrated against these.
 */
```

- [ ] **Step 2: Re-point `probe-bytes.ts`**

Delete the moved bodies from `probe-bytes.ts` and import them instead:

```ts
import {
  decodeLongDate,
  decodeLongTime,
  decodeLongDatetime,
  decodeShortDate,
  decodeShortDatetime,
  decodeShortTimeOnly,
  decodeLongTimeOnly,
} from "../compare/disa-datetime-candidates.js";
```

- [ ] **Step 3: Verify nothing broke**

```bash
pnpm --filter cdr-cli exec tsc --noEmit
pnpm --filter cdr-cli test
```

Expected: typecheck clean; existing tests PASS (this is a pure move — no behaviour change).

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/compare/disa-datetime-candidates.ts apps/cli/src/commands/probe-bytes.ts
git commit -m "refactor(cli): extract DISA datetime candidate decoders for reuse"
```

---

### Task 4: Pure scoring functions

**Files:**
- Create: `apps/cli/src/compare/review-score.ts`
- Test: `apps/cli/src/compare/review-score.test.ts`

**Interfaces:**
- Produces:
  - `interface LabelledPanel { initialsPresent: boolean; v1Status: string }`
  - `interface FRMatrix { fCorrect: number; rCorrect: number; fMiss: number; rMiss: number; total: number; accuracy: number }`
  - `function scoreFR(rows: readonly LabelledPanel[]): FRMatrix`
  - `interface TimestampRow { decoded: Date | null; target: Date }`
  - `interface TimestampScore { hits: number; total: number; rate: number }`
  - `function scoreTimestamp(rows: readonly TimestampRow[], toleranceSec: number): TimestampScore`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/compare/review-score.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter cdr-cli exec node --import tsx --test "src/compare/review-score.test.ts"
```

Expected: FAIL — `Cannot find module './review-score.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cli/src/compare/review-score.ts`:

```ts
/**
 * Pure scoring for the review-signal search. Kept separate from the command so
 * the arithmetic is unit-testable without a database.
 */

export interface LabelledPanel {
  /** TESTDATA_STATUS reviewer-initials slot is non-zero. */
  initialsPresent: boolean;
  /** v1 Requests.HL7ResultStatusCode — the ground truth label. */
  v1Status: string;
}

export interface FRMatrix {
  fCorrect: number;
  rCorrect: number;
  fMiss: number;
  rMiss: number;
  total: number;
  accuracy: number;
}

/**
 * Rule under test: initialsPresent ⇒ F, else R.
 * Only F and R rows are scorable — I comes from "no results" and X from the
 * rejection signal, so counting them here would measure the wrong thing.
 */
export function scoreFR(rows: readonly LabelledPanel[]): FRMatrix {
  let fCorrect = 0, rCorrect = 0, fMiss = 0, rMiss = 0;
  for (const r of rows) {
    const s = r.v1Status.trim().toUpperCase();
    if (s !== "F" && s !== "R") continue;
    if (s === "F") {
      if (r.initialsPresent) fCorrect++; else fMiss++;
    } else {
      if (r.initialsPresent) rMiss++; else rCorrect++;
    }
  }
  const total = fCorrect + rCorrect + fMiss + rMiss;
  return { fCorrect, rCorrect, fMiss, rMiss, total, accuracy: total === 0 ? 0 : (fCorrect + rCorrect) / total };
}

export interface TimestampRow {
  /** Candidate decode of the header bytes. Null when the candidate did not parse. */
  decoded: Date | null;
  /** v1 Requests.AuthorisedDateTime — the ground truth. */
  target: Date;
}

export interface TimestampScore {
  hits: number;
  total: number;
  rate: number;
}

/**
 * A null decode is a MISS, never a skipped row. Skipping would let a candidate
 * that parses 1% of rows perfectly report a 100% rate.
 */
export function scoreTimestamp(rows: readonly TimestampRow[], toleranceSec: number): TimestampScore {
  let hits = 0;
  for (const r of rows) {
    if (r.decoded === null) continue;
    if (Math.abs(r.decoded.getTime() - r.target.getTime()) <= toleranceSec * 1000) hits++;
  }
  const total = rows.length;
  return { hits, total, rate: total === 0 ? 0 : hits / total };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter cdr-cli exec node --import tsx --test "src/compare/review-score.test.ts"
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/compare/review-score.ts apps/cli/src/compare/review-score.test.ts
git commit -m "feat(cli): add pure scoring for the DISA review-signal search"
```

---

### Task 5: The `probe-review` measurement command

**Files:**
- Create: `apps/cli/src/commands/probe-review.ts`
- Modify: `apps/cli/src/index.ts`

**Interfaces:**
- Consumes: `scoreFR`, `scoreTimestamp` (Task 4); the seven decoders (Task 3); `TestDataHeader` (Task 2); `getPool` from `disalab`; `loadRuntime` from `./context.js`.
- Produces: a registered CLI command `cdr probe-review [--limit N] [--tolerance-sec N] [--min-year N] [--max-year N]`.

- [ ] **Step 1: Write the command**

Create `apps/cli/src/commands/probe-review.ts`. Follow `probe-bytes.ts`'s structure for option parsing and pool handling.

```ts
import type { Command } from "commander";
import { getPool, TestDataHeader } from "disalab";
import { CliError } from "../errors.js";
import { closePool } from "../db.js";
import { loadRuntime } from "./context.js";
import { scoreFR, scoreTimestamp, type LabelledPanel, type TimestampRow } from "../compare/review-score.js";
import {
  decodeLongDatetime,
  decodeShortDatetime,
} from "../compare/disa-datetime-candidates.js";

interface Row {
  header: TestDataHeader;
  v1Status: string;
  authorisedAt: Date | null;
}

/**
 * Labelled join. DISA is the blob source; v1 Requests is ground truth.
 * READ-ONLY. The join is the one measured sound at 13,253/13,254:
 *   RequestID = <prefix> + LABNO  AND  LIMSPanelCode = TESTCODE
 */
async function fetchLabelled(
  connectionString: string,
  v1Database: string,
  prefix: string,
  limit: number,
): Promise<Row[]> {
  const pool = await getPool(connectionString);
  const sql = `
    SELECT TOP (${limit})
           t.[TESTDATA_STATUS] AS blob,
           r.[HL7ResultStatusCode] AS status,
           r.[AuthorisedDateTime]  AS authorised
    FROM [DisalabData].[dbo].[TESTDATA] t
    JOIN [${v1Database}].[dbo].[Requests] r
      ON r.[RequestID] = '${prefix}' + t.[LABNO]
     AND r.[LIMSPanelCode] = t.[TESTCODE]`;
  const rs = (await pool.request().query(sql)).recordset as Record<string, unknown>[];
  return rs.map((row) => ({
    header: TestDataHeader.fromBytes(row.blob as Buffer),
    v1Status: String(row.status ?? ""),
    authorisedAt: row.authorised instanceof Date ? row.authorised : null,
  }));
}

export function registerProbeReview(program: Command): void {
  program
    .command("probe-review")
    .description("Score the TESTDATA header review signal against OpenLDR v1 (read-only)")
    .option("--limit <n>", "max labelled panels to score", "200000")
    .option("--tolerance-sec <n>", "timestamp match tolerance in seconds", "60")
    .option("--min-year <n>", "candidate year floor", "2000")
    .option("--max-year <n>", "candidate year ceiling", "2030")
    .action(async (opts: Record<string, string>) => {
      const rt = await loadRuntime();
      const limit = Number(opts.limit);
      const tolerance = Number(opts.toleranceSec);
      const minY = Number(opts.minYear);
      const maxY = Number(opts.maxYear);
      if (!Number.isFinite(limit) || limit <= 0) throw new CliError("--limit must be a positive number");

      try {
        const rows = await fetchLabelled(
          rt.config.disaConnectionString,
          rt.config.v1DatabaseData,
          rt.config.labnoPrefix,
          limit,
        );
        console.log(`labelled panels fetched: ${rows.length}`);

        // ---- (a) F/R rule -------------------------------------------------
        const frRows: LabelledPanel[] = rows.map((r) => ({
          initialsPresent: r.header.reviewerInitials !== null,
          v1Status: r.v1Status,
        }));
        const m = scoreFR(frRows);
        console.log("\n=== F/R rule: initials non-zero => F, else R ===");
        console.log(`  F & reviewed  (correct) = ${m.fCorrect}`);
        console.log(`  R & !reviewed (correct) = ${m.rCorrect}`);
        console.log(`  F & !reviewed (miss)    = ${m.fMiss}`);
        console.log(`  R & reviewed  (miss)    = ${m.rMiss}`);
        console.log(`  ACCURACY = ${(m.accuracy * 100).toFixed(2)}%  (n = ${m.total})`);

        // ---- (b) timestamp search ----------------------------------------
        // Only rows that are reviewed AND carry a v1 timestamp are scorable.
        const tsRows = rows.filter((r) => r.header.reviewerInitials !== null && r.authorisedAt !== null);
        console.log(`\n=== timestamp search (n = ${tsRows.length}, tolerance ${tolerance}s) ===`);

        const kinds = [
          { name: "long-datetime",  fn: decodeLongDatetime  },
          { name: "short-datetime", fn: decodeShortDatetime },
        ];
        let best = { name: "", offset: -1, rate: 0, hits: 0, total: 0 };
        for (const kind of kinds) {
          for (let offset = 0; offset <= 74; offset++) {
            const scored: TimestampRow[] = tsRows.map((r) => ({
              decoded: kind.fn(r.header.raw, offset, minY, maxY),
              target: r.authorisedAt as Date,
            }));
            const s = scoreTimestamp(scored, tolerance);
            if (s.rate > best.rate) best = { name: kind.name, offset, rate: s.rate, hits: s.hits, total: s.total };
          }
        }
        console.log(`  BEST: kind=${best.name} offset=${best.offset} hits=${best.hits}/${best.total} rate=${(best.rate * 100).toFixed(2)}%`);

        // ---- GATE ---------------------------------------------------------
        console.log("\n=== GATE (spec: >=95% minute-exact) ===");
        if (best.rate >= 0.95) {
          console.log(`  PASS (${(best.rate * 100).toFixed(2)}%) — proceed to Phase 2.`);
        } else if (best.rate >= 0.90) {
          console.log(`  BORDERLINE (${(best.rate * 100).toFixed(2)}%) — surface to the user; do NOT proceed unilaterally.`);
        } else {
          console.log(`  FAIL (${(best.rate * 100).toFixed(2)}%) — STOP. Ship result_status alone and report the ceiling.`);
        }
      } finally {
        await closePool();
      }
    });
}
```

> **Runtime field names:** `rt.config.disaConnectionString`, `rt.config.v1DatabaseData`, `rt.config.labnoPrefix` follow `loadRuntime()`'s shape. Open `apps/cli/src/commands/context.ts` and `apps/cli/src/config.ts` and use the **actual** property names — do not invent them. `compare-batch.ts` is a working reference for reading all three.

- [ ] **Step 2: Register the command**

In `apps/cli/src/index.ts`, mirror how the other commands are registered:

```ts
import { registerProbeReview } from "./commands/probe-review.js";
// ...alongside the other register* calls:
registerProbeReview(program);
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter cdr-cli exec tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Run against the live database**

```bash
pnpm --filter cdr-cli exec tsx src/index.ts probe-review --limit 200000
```

Expected: F/R accuracy near **98.99%** over roughly **176,287** scorable panels, and a BEST timestamp line over roughly **160,931** rows.

- [ ] **Step 5: Record the numbers in the spec**

Paste the real output into the "Phase 1 measurement" bullet of `docs/superpowers/specs/2026-08-02-disa-result-status-blob-decode-design.md`.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/probe-review.ts apps/cli/src/index.ts docs/superpowers/specs/2026-08-02-disa-result-status-blob-decode-design.md
git commit -m "feat(cli): add probe-review to score the DISA review signal against v1"
```

---

> # ⛔ GATE — STOP HERE
>
> Read the `=== GATE ===` line from Task 5 Step 4.
>
> - **PASS (≥95%)** — continue to Phase 2.
> - **BORDERLINE (90-95%)** — **stop and report to the user.** Do not choose.
> - **FAIL (<90%)** — **stop.** `authorised_at` is not derivable from this header. Report the measured ceiling, then implement Phase 2/3 for `result_status` **only**, leaving `authorised_at: null`, and state plainly that CE's turnaround report will still return 0 rows.
>
> Everything below assumes PASS. The timestamp `kind` and `offset` from the BEST line are inputs to Task 6.

---

## Phase 2 — Production decode + config

### Task 6: `disa_blob_offsets` config with a semantic self-check

**Files:**
- Create: `apps/cli/src/config/blob-offsets.ts`
- Test: `apps/cli/src/config/blob-offsets.test.ts`
- Modify: `config/tanzania.yaml`, `config/zambia.yaml`

**Interfaces:**
- Consumes: `configDir()` from `./country-config.js`; `parse` from `yaml`; `z` from `zod`; `TestDataHeader` from `disalab`.
- Produces:
  - `interface BlobOffsets { reviewerInitials: { start: number; end: number }; reviewedAt: { start: number; kind: "long-datetime" | "short-datetime" } | null }`
  - `function loadBlobOffsets(country: string | undefined, dir?: string): BlobOffsets`
  - `function assertOffsetsPlausible(headers: readonly TestDataHeader[], offsets: BlobOffsets): void` — throws `CliError` on failure.
  - `const DEFAULT_SELF_CHECK_SAMPLE = 500`

> **Note:** this refines the spec's provisional `reviewed_at: { start, end }` to `{ start, kind }`. `kind` selects one of the already-tested decoders from Task 3, so the encoding is a choice from a known finite set rather than a free-form byte range.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/config/blob-offsets.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestDataHeader, HEADER_LENGTH } from "disalab";
import { loadBlobOffsets, assertOffsetsPlausible } from "./blob-offsets.js";

function dirWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cdr-offsets-"));
  writeFileSync(join(dir, "tanzania.yaml"), yaml);
  return dir;
}

const GOOD = `disa_blob_offsets:
  reviewer_initials: { start: 77, end: 80 }
  reviewed_at: { start: 21, kind: long-datetime }
`;

test("loads offsets from yaml", () => {
  const dir = dirWith(GOOD);
  try {
    const o = loadBlobOffsets("tanzania", dir);
    assert.equal(o.reviewerInitials.start, 77);
    assert.equal(o.reviewerInitials.end, 80);
    assert.equal(o.reviewedAt?.kind, "long-datetime");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("end is EXCLUSIVE, so end=80 is legal and addresses byte 79", () => {
  const dir = dirWith(GOOD);
  try {
    assert.equal(loadBlobOffsets("tanzania", dir).reviewerInitials.end, 80);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects an end beyond the header, which would read result payload", () => {
  const dir = dirWith(`disa_blob_offsets:
  reviewer_initials: { start: 77, end: 81 }
`);
  try {
    assert.throws(() => loadBlobOffsets("tanzania", dir), /end/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects start >= end", () => {
  const dir = dirWith(`disa_blob_offsets:
  reviewer_initials: { start: 80, end: 80 }
`);
  try {
    assert.throws(() => loadBlobOffsets("tanzania", dir), /start/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a country with no disa_blob_offsets block yields no reviewedAt and safe defaults", () => {
  const dir = dirWith("documentation:\n  panels:\n    - VIRAL\n");
  try {
    const o = loadBlobOffsets("tanzania", dir);
    assert.equal(o.reviewedAt, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- semantic self-check -------------------------------------------------

function header(mut: (b: Buffer) => void): TestDataHeader {
  const b = Buffer.alloc(HEADER_LENGTH, 0);
  mut(b);
  return TestDataHeader.fromBytes(b);
}

const OFFSETS = { reviewerInitials: { start: 77, end: 80 }, reviewedAt: null };

test("self-check passes on plausible printable initials", () => {
  const hs = Array.from({ length: 10 }, () => header((b) => { b[77] = 65; b[78] = 80; b[79] = 66; }));
  assert.doesNotThrow(() => assertOffsetsPlausible(hs, OFFSETS));
});

test("self-check REJECTS non-printable initials — the wrong-offset signature", () => {
  const hs = Array.from({ length: 10 }, () => header((b) => { b[77] = 0x01; b[78] = 0xff; b[79] = 0x7f; }));
  assert.throws(() => assertOffsetsPlausible(hs, OFFSETS), /printable/i);
});

test("self-check tolerates an all-zero sample — not-reviewed is legitimate", () => {
  const hs = Array.from({ length: 10 }, () => header(() => {}));
  assert.doesNotThrow(() => assertOffsetsPlausible(hs, OFFSETS));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter cdr-cli exec node --import tsx --test "src/config/blob-offsets.test.ts"
```

Expected: FAIL — `Cannot find module './blob-offsets.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cli/src/config/blob-offsets.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HEADER_LENGTH, type TestDataHeader } from "disalab";
import { CliError } from "../errors.js";
import { configDir } from "./country-config.js";

export const DEFAULT_SELF_CHECK_SAMPLE = 500;

const slotSchema = z
  .object({ start: z.number().int().min(0).max(HEADER_LENGTH - 1), end: z.number().int().min(1).max(HEADER_LENGTH) })
  .refine((s) => s.start < s.end, { message: "start must be less than end (end is EXCLUSIVE)" });

const reviewedAtSchema = z.object({
  start: z.number().int().min(0).max(HEADER_LENGTH - 1),
  kind: z.enum(["long-datetime", "short-datetime"]),
});

const schema = z.object({
  disa_blob_offsets: z
    .object({ reviewer_initials: slotSchema.optional(), reviewed_at: reviewedAtSchema.optional() })
    .optional(),
});

export interface BlobOffsets {
  reviewerInitials: { start: number; end: number };
  reviewedAt: { start: number; kind: "long-datetime" | "short-datetime" } | null;
}

/** Tanzania measured default; every deployment should set its own explicitly. */
const FALLBACK: BlobOffsets = { reviewerInitials: { start: 77, end: 80 }, reviewedAt: null };

export function loadBlobOffsets(country: string | undefined, dir: string = configDir()): BlobOffsets {
  if (country === undefined || country.trim().length === 0) return FALLBACK;
  const path = resolve(dir, `${country.trim().toLowerCase()}.yaml`);
  if (!existsSync(path)) return FALLBACK;

  const parsed = schema.safeParse(parse(readFileSync(path, "utf8")) ?? {});
  if (!parsed.success) {
    throw new CliError(`Invalid disa_blob_offsets in ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const block = parsed.data.disa_blob_offsets;
  if (block === undefined) return FALLBACK;
  return {
    reviewerInitials: block.reviewer_initials ?? FALLBACK.reviewerInitials,
    reviewedAt: block.reviewed_at ?? null,
  };
}

/**
 * Wrong offsets do not throw — they return plausible garbage. This is the
 * guard that makes a hand-edited YAML fail loudly instead of silently
 * emitting wrong statuses for an entire migration.
 */
export function assertOffsetsPlausible(headers: readonly TestDataHeader[], offsets: BlobOffsets): void {
  const sample = headers.slice(0, DEFAULT_SELF_CHECK_SAMPLE);
  let nonZero = 0;
  let printable = 0;
  for (const h of sample) {
    let any = false;
    let ok = true;
    for (let i = offsets.reviewerInitials.start; i < offsets.reviewerInitials.end; i++) {
      const b = h.byteAt(i);
      if (b === 0 || b === 32) continue;
      any = true;
      // Printable ASCII letters/digits are what real initials look like ("APB").
      if (!((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122))) ok = false;
    }
    if (any) {
      nonZero++;
      if (ok) printable++;
    }
  }
  // An all-not-reviewed sample is legitimate and proves nothing either way.
  if (nonZero === 0) return;
  const rate = printable / nonZero;
  if (rate < 0.9) {
    throw new CliError(
      `disa_blob_offsets.reviewer_initials looks wrong: only ${printable}/${nonZero} sampled non-empty slots ` +
        `(${(rate * 100).toFixed(1)}%) decode to printable ASCII. Expected letters/digits such as "APB". ` +
        `Re-run \`cdr probe-review\` and set the measured offset for this deployment.`,
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter cdr-cli exec node --import tsx --test "src/config/blob-offsets.test.ts"
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Add the config blocks**

Append to `config/tanzania.yaml`, substituting the **measured** `start`/`kind` from Task 5's BEST line:

```yaml
# TESTDATA_STATUS blob header layout. Bytes 0-79 are a header; 80+ is the
# result payload. `end` is EXCLUSIVE. These are MEASURED, not guessed — run
# `cdr probe-review` against this deployment's DISA + v1 before changing them.
disa_blob_offsets:
  reviewer_initials: { start: 77, end: 80 }
  reviewed_at: { start: <MEASURED>, kind: <MEASURED> }
```

Append to `config/zambia.yaml`:

```yaml
# Zambia is UNMEASURED. DISA versions vary between deployments, so Tanzania's
# offsets must NOT be assumed here. Run `cdr probe-review` against Zambia's
# DISA + v1 and fill this in; until then result_status/authorised_at stay null.
disa_blob_offsets: {}
```

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/config/blob-offsets.ts apps/cli/src/config/blob-offsets.test.ts config/tanzania.yaml config/zambia.yaml
git commit -m "feat(config): add measured disa_blob_offsets with a plausibility guard"
```

---

## Phase 3 — Transform wiring

### Task 7: `buildStatusByObr` — per-OBR resolution and the status rule

**Files:**
- Create: `apps/cli/src/export/review-status.ts`
- Test: `apps/cli/src/export/review-status.test.ts`

**Interfaces:**
- Consumes: `baseIndex` from `./obr-sets.js`; `TestDataHeader` from `disalab`; the decoders from Task 3; `BlobOffsets` from Task 6.
- Produces:
  - `interface ObrStatus { status: "X" | "I" | "F" | "R"; authorisedAt: Date | null; headerUndecodable: boolean }`
  - `interface PanelIteration { panelCode: string; panelIndex: number; datestamp: Date | null; header: TestDataHeader | null }`
  - `function buildStatusByObr(args: { iterations: readonly PanelIteration[]; obrOf: (panelCode: string, panelIndex: number) => number | null; obsCountByObr: ReadonlyMap<number, number>; rejected: boolean; offsets: BlobOffsets }): Map<number, ObrStatus>`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/export/review-status.test.ts`:

```ts
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
```

> **Note on the `base(101) === 1` cases:** `buildStatusByObr` calls `baseIndex(panelIndex)` before consulting `obrOf`, so the map only needs the `"COL:1"` key — index 101 collapses onto base 1. That collapse is exactly what the test is pinning.

- [ ] **Step 2: Run test to verify it fails**

```bash
pnpm --filter cdr-cli exec node --import tsx --test "src/export/review-status.test.ts"
```

Expected: FAIL — `Cannot find module './review-status.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `apps/cli/src/export/review-status.ts`:

```ts
import type { TestDataHeader } from "disalab";
import { baseIndex } from "./obr-sets.js";
import type { BlobOffsets } from "../config/blob-offsets.js";
import { decodeLongDatetime, decodeShortDatetime } from "../compare/disa-datetime-candidates.js";

export interface ObrStatus {
  status: "X" | "I" | "F" | "R";
  authorisedAt: Date | null;
  headerUndecodable: boolean;
}

export interface PanelIteration {
  panelCode: string;
  panelIndex: number;
  datestamp: Date | null;
  header: TestDataHeader | null;
}

export interface BuildStatusArgs {
  iterations: readonly PanelIteration[];
  obrOf: (panelCode: string, panelIndex: number) => number | null;
  /** Kept observation count per obr_set_id. Zero ⇒ interim. */
  obsCountByObr: ReadonlyMap<number, number>;
  /** Request-level rejection from detectDisaRejection. */
  rejected: boolean;
  offsets: BlobOffsets;
}

/** Same precedence supersedePanelIterations uses: datestamp, then panelIndex. */
function isLater(a: PanelIteration, b: PanelIteration): boolean {
  const am = a.datestamp?.getTime() ?? -Infinity;
  const bm = b.datestamp?.getTime() ?? -Infinity;
  if (am !== bm) return am > bm;
  return a.panelIndex > b.panelIndex;
}

function decodeReviewedAt(header: TestDataHeader, offsets: BlobOffsets): Date | null {
  if (offsets.reviewedAt === null) return null;
  const { start, kind } = offsets.reviewedAt;
  const fn = kind === "long-datetime" ? decodeLongDatetime : decodeShortDatetime;
  return fn(header.raw, start, 2000, 2100);
}

/**
 * ⛔ Resolves the header PER OBR, not per panel code.
 *
 * supersedePanelIterations (compare/result-mapping.ts) keys its winner on
 * `panelCode` ALONE, while OBR grain is (panelCode, base(TESTINDEX)). Those
 * disagree whenever one panel code occupies two OBRs — reusing that winner
 * here would attach one panel's review state to a sibling OBR. This function
 * deliberately re-resolves per OBR using the same ordering rule.
 */
export function buildStatusByObr(args: BuildStatusArgs): Map<number, ObrStatus> {
  const { iterations, obrOf, obsCountByObr, rejected, offsets } = args;

  const winnerByObr = new Map<number, PanelIteration>();
  for (const it of iterations) {
    // baseIndex is applied here AND inside the real linkObsToObr lookup
    // (obr-sets.ts:122). That double application is deliberate and harmless —
    // baseIndex is idempotent (<=100 passes through) — and it keeps this
    // function correct against any obrOf, including test doubles that do not
    // collapse the +100 second-slot convention themselves.
    const obr = obrOf(it.panelCode, baseIndex(it.panelIndex));
    if (obr === null) continue;
    const cur = winnerByObr.get(obr);
    if (cur === undefined || isLater(it, cur)) winnerByObr.set(obr, it);
  }

  const out = new Map<number, ObrStatus>();
  const obrIds = new Set<number>([...winnerByObr.keys(), ...obsCountByObr.keys()]);
  for (const obr of obrIds) {
    const winner = winnerByObr.get(obr) ?? null;
    const headerUndecodable = winner !== null && winner.header === null;

    if (rejected) {
      out.set(obr, { status: "X", authorisedAt: null, headerUndecodable });
      continue;
    }
    if ((obsCountByObr.get(obr) ?? 0) === 0) {
      out.set(obr, { status: "I", authorisedAt: null, headerUndecodable });
      continue;
    }
    const header = winner?.header ?? null;
    const reviewed = header !== null && header.reviewerInitials !== null;
    out.set(obr, {
      status: reviewed ? "F" : "R",
      authorisedAt: reviewed && header !== null ? decodeReviewedAt(header, offsets) : null,
      headerUndecodable,
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
pnpm --filter cdr-cli exec node --import tsx --test "src/export/review-status.test.ts"
```

Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/export/review-status.ts apps/cli/src/export/review-status.test.ts
git commit -m "feat(export): derive per-OBR result status from the TESTDATA review header"
```

---

### Task 8: Wire into `v2-transform` and retire the stub assertions

**Files:**
- Modify: `apps/cli/src/export/v2-transform.ts` (`:235-247` signature, `:329`, `:343`, `:682-712`)
- Modify: `apps/cli/src/compare/v2-mapping.test.ts:48-56`

**Interfaces:**
- Consumes: `buildStatusByObr`, `ObrStatus`, `PanelIteration` (Task 7); `loadBlobOffsets`, `BlobOffsets` (Task 6).
- Produces: `V2LabRequest.result_status` and `.authorised_at` populated per OBR; `ToV2Opts.blobOffsets: BlobOffsets`.

- [ ] **Step 1: Build the map in `toV2`**

In `apps/cli/src/export/v2-transform.ts`, after `const obrOf = linkObsToObr(obrSets, iterations);` (`:709`), add:

```ts
  // Observation count per OBR drives the `I` (interim) branch: an ordered
  // panel with zero kept observations is exactly v1's "request but no
  // results" case (compare-batch.ts:60-65).
  const obsCountByObr = new Map<number, number>();
  for (const o of obs) {
    const id = obrOf(o.panelCode, o.panelIndex);
    if (id === null) continue;
    obsCountByObr.set(id, (obsCountByObr.get(id) ?? 0) + 1);
  }
  const statusByObr = buildStatusByObr({
    iterations: specimen.TestResults.map((t) => ({
      panelCode: String(t.TESTCODE ?? "").trim(),
      panelIndex: Number(t.TESTINDEX ?? 0),
      datestamp: t.DATESTAMP instanceof Date ? t.DATESTAMP : null,
      header: t.HEADER,
    })),
    obrOf,
    obsCountByObr,
    rejected: rejection.rejected,
    offsets: opts.blobOffsets,
  });
```

Change the `buildLabRequest` call (`:710-712`) to pass the per-OBR status:

```ts
  const labRequests = obrSets.map((obr) =>
    buildLabRequest(
      specimen, obr, opts.prefix, opts.site, opts.codebook, rejection, specimenAnomalous,
      statusByObr.get(obr.obr_set_id) ?? null,
    ),
  );
```

Add the imports at the top of the file:

```ts
import { buildStatusByObr, type ObrStatus } from "./review-status.js";
import type { BlobOffsets } from "../config/blob-offsets.js";
```

Add `blobOffsets: BlobOffsets;` to the `ToV2Opts` interface. Every caller of `toV2` must now supply it — find them with:

```bash
rg -n 'toV2\(' apps/cli/src --glob '*.ts'
```

For each caller, load offsets **once at startup** via `loadBlobOffsets(country)` and pass them through. Do **not** call `loadBlobOffsets` inside `toV2` — it does file I/O and `toV2` runs per specimen.

- [ ] **Step 2: Consume it in `buildLabRequest`**

Extend the signature (`:235-247`) with a trailing parameter:

```ts
  reviewStatus: ObrStatus | null,
```

Add this helper beside `disaToIso` (near `:43`):

```ts
/**
 * ⛔ Do NOT use Date#toISOString() here. Every other datetime on the payload is
 * emitted by disaToIso as LOCAL-form ISO with no offset and no milliseconds
 * (`2018-05-18T09:00:00`, v2-transform.ts:50). toISOString() would emit
 * `...T06:00:00.000Z` on a UTC+3 host — a silent whole-timezone shift that the
 * gate's comparator reads as a mismatch, or worse, as a plausible wrong time.
 */
function dateToLocalIso(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
```

> ⚠ **Verify the getter family matches the decoder.** `dateToLocalIso` reads local components (`getFullYear`, `getHours`). That is correct only if the Task 3 decoders build their `Date` with the local constructor `new Date(y, m, d, h, mi)`. Open `disa-datetime-candidates.ts` and check: if they use `Date.UTC(...)`, switch this helper to the `getUTC*` family. Getting this backwards shifts every timestamp by the host offset while still looking well-formed.

Replace `:329`:

```ts
    authorised_at: reviewStatus?.authorisedAt ? dateToLocalIso(reviewStatus.authorisedAt) : null,
```

Replace `:339-343` (the comment block and the stub) with:

```ts
    // Per-OBR result status decoded from the TESTDATA_STATUS header, with the
    // existing rejection signal taking precedence. See export/review-status.ts
    // and docs/superpowers/specs/2026-08-02-disa-result-status-blob-decode-design.md.
    // `A` is NOT derivable (624 rows in 3.4M) and is an accepted gap.
    result_status: reviewStatus?.status ?? (rejection.rejected ? "X" : null),
```

- [ ] **Step 3: Retire the stub assertions**

The test at `apps/cli/src/compare/v2-mapping.test.ts:52-60` — *"a V2 field stubbed null while v1 is populated reports only_v1"* — asserts the **stub is RED**. It has reached end of life. The file's own helpers are `payload(req)`, `v1(cols)`, and `statusOf(payload, v1Row, field): string`.

Replace that test with one asserting a **populated** `authorised_at` matches v1:

```ts
// Was: "a V2 field stubbed null while v1 is populated reports only_v1".
// The stub is gone (2026-08-02); a populated authorised_at must now MATCH v1.
// NOTE the emitted form: local-form ISO, no offset, no milliseconds — the file
// header explains that Date.parse reads it as LOCAL while the comparator reads
// v1's Date back with getUTC*, so these two represent the same wall clock.
test("authorised_at matches v1 when the panel was reviewed", () => {
  assert.equal(
    statusOf(
      payload({ authorised_at: "2018-05-18T09:00:00" }),
      v1({ AuthorisedDateTime: new Date(Date.UTC(2018, 4, 18, 9, 0)), HL7ResultStatusCode: "F" }),
      "authorised_at",
    ),
    "match",
  );
});
```

> If `"match"` is not the comparator's token for agreement, take the exact string from a neighbouring passing test rather than guessing — `statusOf` returns `diffV2Request`'s vocabulary, of which `only_v1` is one member.

**Do NOT touch the TZ pin** at the top of the file (`process.env.TZ = "Africa/Dar_es_Salaam"`) or the test that asserts it took effect. Every datetime assertion in the file is vacuous without it.

Leave untouched: the `emptyIsCorrectWhen` conditional (`v2-mapping.ts:247`) and the test at `:134-149` that keeps the 73 `F`-without-authorisation rows RED. Those are correct and must not be relaxed.

- [ ] **Step 4: Run the full test suite**

```bash
pnpm --filter disalab build
pnpm --filter cdr-cli exec tsc --noEmit
pnpm --filter cdr-cli test
```

Expected: typecheck clean, all tests PASS.

- [ ] **Step 5: Run the live gate**

```bash
pnpm --filter cdr-cli exec tsx src/index.ts compare-batch --limit 2000
```

Expected: `result_status` and `authorised_at` now report real agreement instead of RED stubs. **`result_status` will NOT be 100%** — the rule is ~99% by construction. Record the achieved number.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/export/v2-transform.ts apps/cli/src/compare/v2-mapping.test.ts
git commit -m "feat(export): populate result_status and authorised_at from the review header

Retires the v2-mapping test that asserted the authorised_at stub was RED — it
encoded 'this is broken' and the stub is now gone. The emptyIsCorrectWhen
conditional and the 73 F-without-authorisation RED rows are deliberately
unchanged."
```

---

## Phase 4 — CE re-ingest and live verification

### Task 9: Re-ingest and confirm the turnaround report

Existing CE rows keep `issued = NULL`; only re-ingested rows carry it.

**Files:** none modified — this task is operational verification.

- [ ] **Step 1: Capture the "before" state**

```bash
docker exec openldr_ce-postgres-1 psql -U postgres -d openldr -c "select count(*) total, count(issued) with_issued from diagnostic_reports;"
```

Expected: `with_issued` is 0 (the memory recorded 1231 / 0). If the database or user name differs, read the CE compose file rather than guessing.

- [ ] **Step 2: Re-ingest**

```bash
pnpm --filter cdr-cli exec tsx src/index.ts export-batch --target ce --limit 500
```

Expected: successful posts, no `API_REJECTED` storm. If you see mass 400s, check that the `OPENLDR_*_NAME` env vars are non-empty — a blank one yields an empty `X-DataFeed-Id` and the CLI hides the real body.

- [ ] **Step 3: Confirm `issued` is populated**

```bash
docker exec openldr_ce-postgres-1 psql -U postgres -d openldr -c "select count(*) total, count(issued) with_issued from diagnostic_reports;"
```

Expected: `with_issued` > 0, roughly the `F`-status share of what was ingested (~79%).

- [ ] **Step 4: Run the turnaround query**

```bash
docker exec openldr_ce-postgres-1 psql -U postgres -d openldr -c "
select count(*) rows,
       round(avg(extract(epoch from (dr.issued - s.received_time))/3600)::numeric, 1) avg_hours,
       count(*) filter (where dr.issued < s.received_time) negative
from diagnostic_reports dr
join specimens s on s.id = dr.specimen_id
where dr.issued is not null and s.received_time is not null;"
```

Expected: `rows` > 0 — **this is the original goal met.** `avg_hours` plausible. `negative` is the `authorised_before_received` population; per the PRD these are emitted and flagged, so a non-zero count is expected, not a failure.

> If the join column names differ in CE's schema, inspect it with `\d diagnostic_reports` rather than guessing.

- [ ] **Step 5: Record results and commit**

Add a "Phase 4 results" section to the spec with the before/after counts, `avg_hours`, and the negative count.

```bash
git add docs/superpowers/specs/2026-08-02-disa-result-status-blob-decode-design.md
git commit -m "docs(export): record Phase 4 CE re-ingest and turnaround verification results"
```

---

## Deferred to a follow-up

The spec names two flags this plan surfaces but does not emit:

- `review_header_undecodable` — `ObrStatus.headerUndecodable` is computed in Task 7 and carried on the returned map, but never emitted.
- `authorised_before_received` — detectable in Task 8 by comparing `reviewStatus.authorisedAt` against `received_at`, but never emitted.

**Why deferred, verified 2026-08-02:** there is **no flag pipeline to wire into**. `apps/cli/src/flags/` does not exist; PRD §7's `flags/types.ts` + `flags/collector.ts` are part of the pre-pivot design that the PRD's own §0 marks as "pending revision". Building that collector is a separate piece of work with its own design, and inventing one here would mean shipping an API no caller agreed to.

Both are **warnings, never quarantine**, so neither blocks the turnaround fix, and both signals are preserved rather than lost: `headerUndecodable` rides on the returned `ObrStatus`, and Task 9 Step 4 counts negative turnarounds directly from CE. Raise the flag pipeline as its own spec once Phase 4 confirms the values are real.

---

## Done criteria

- [ ] `cdr probe-review` reports F/R accuracy consistent with the recorded 98.99%.
- [ ] The Phase 1 gate was evaluated and its outcome acted on (PASS → continued; BORDERLINE/FAIL → stopped and reported).
- [ ] `disa_blob_offsets` is set for Tanzania from measurement, and explicitly empty for unmeasured Zambia.
- [ ] `assertOffsetsPlausible` aborts on wrong offsets.
- [ ] `result_status` and `authorised_at` are populated per OBR; the achieved match rates are recorded, **not** claimed as 100%.
- [ ] CE's turnaround query returns rows.
- [ ] No `Co-Authored-By` trailer on any commit.

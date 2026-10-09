# reports-zm slice 1: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `reports-zm` content pack 0.1.0: the Zambia facility register from the MFL CSV and
one query, "VL clients by province", that replaces Zambia's 12 province procedures. cdr-toolchain sends
two more patient IDs so the query can build the ART number, and CE lists their codes.

**Architecture:** The query is one read-only SELECT over CE's warehouse, built by JS helpers in
`packs/reports-zm/zm-queries.mjs`. It reuses SQL helpers from `packs/vl-reports-mz/vl-queries.mjs`.
A shared check runner (`packs/shared/pg-check.mjs`) runs the SQL against temp copies of the warehouse
tables in the CE dev Postgres. cdr-toolchain adds two request attributes; CE adds their two codes.

**Tech Stack:** Node ESM scripts for packs; TypeScript with `node --test` (cdr-toolchain CLI);
vitest (CE terminology); Postgres 16 in the CE dev container.

**Spec:** `docs/superpowers/specs/2026-10-09-reports-zm-slice-1-design.md` (cdr-toolchain, approved).

## Global Constraints

- The goal is output parity with v1, not script parity. Rewrite freely; match the output.
- A custom query is one read-only SELECT. CE's `validateSelectSql`
  (`openldr_ce/packages/dashboards/src/sql-runner.ts:17`) rejects these words anywhere outside a
  string literal or comment: `insert update delete drop alter create truncate grant revoke merge
  call copy into`. Never use one as a SQL identifier, alias or CTE name.
- No `--` comments in pack SQL. Explanations go in JS comments.
- v1 text comparisons follow SQL Server's default collation: case-insensitive, trailing spaces
  ignored (`inListSql` already does `lower(rtrim(x))`). SQL Server's `REPLACE` and `LIKE` are
  case-insensitive too.
- Register URL `urn:openldr:zm:facilities`, code `ZMFAC`, name "Zambia health facilities".
- Request-attribute codes `reference-numbers` ("Reference numbers") and `unique-id` ("Unique ID") in
  `urn:openldr:cs:request-attribute`.
- Pack id `reports-zm`, version `0.1.0`.
- No em dashes in any new text. Short sentences. Run the `unslop` skill
  (`openldr_ce/.claude/skills/unslop/SKILL.md`) over new prose.
- Commit only when the operator asks; each task ends with a commit step. No `Co-Authored-By` trailer.
- Never pipe a test or typecheck command into `tail` and then read `$?`. Redirect to a file first.

## Plan-level rulings (read before Task 1)

1. **ARTNumber per part.** The spec's column table gives one source for ARTNumber. v1 differs per
   part: part 1 (`TND`) builds it with the clean-up rule; parts 2 and 3 show `p.UNIQUEID` raw
   (`sp_SPHO_hivvl_clients_month`, the `rejects` and `incs` CTEs). The port follows v1: rule in part
   1, raw unique ID in parts 2 and 3. This is the spec's own principle (output parity).
2. **Blank IDs.** v1's `Patients` holds `''` for an empty ID. cdr-toolchain sends nothing for an empty
   ID. Part 1 treats a missing attribute as `''`, so the rule behaves as v1's does. Parts 2 and 3 show
   NULL where nothing was sent.
3. **v1 errors the port cannot copy.** Rule 2 of the ART number does `RIGHT(x, LEN(x)-3)`, which
   raises an error in SQL Server when the text before `,elabs` is shorter than 3 characters. The port
   returns `''` there.
4. **Shared code.** The Zambia check reuses the Mozambique check's runner and the Mozambique build's
   CSV and step helpers. Task 4 moves them into `packs/shared/`, and proves the Mozambique output did
   not change. The SQL helpers stay in `vl-reports-mz/vl-queries.mjs` (the spec names that file); four
   of them gain `export`.
5. **CE docs.** The CE docs explain how to import the request-attribute code system; they do not list
   its codes. No doc change is needed.

## Facts this plan rests on (checked 2026-10-09)

- MFL CSV: 3,788 rows, 21 columns, UTF-8 with BOM, quoted cells. `MFL Code` unique, numeric, never
  blank. No blank `Name`. Coordinates: 3,678 valid pairs, 98 rows with none, 12 rows with a broken
  value (for example longitude `29580210`). Status: Functional 3,771, Permanent closure 11, Closed 5,
  Temporarily closure 1.
- Warehouse NOT NULL columns without defaults: `lab_requests.id`, `lab_results.id`,
  `diagnostic_reports.id`, `patients.id`, `facility_map.id/source_system/source_code`,
  `lab_request_attributes.id/lab_request_id/system/code`, `facility_registry.id/facility_code/name`.
- `facility_map` keeps a row for an unmapped code with `registry_id` NULL
  (`openldr_ce/packages/db/src/migrations/external/012_facility_map.ts:33`). Mapped = `registry_id
  is not null`.
- `patients.sex` holds the HL7 letter (`F`). `diagnostic_reports.status` holds the FHIR status;
  cdr-toolchain maps v1 `F` to `final` and `X` to `cancelled`.
- CE custom-query params accept `type: 'select'` with `optionsSql`
  (`openldr_ce/packages/dashboards/src/custom-query.ts:5-11`). The options endpoint runs
  `validateSelectSql` and returns each row's first column (`apps/server/src/query-routes.ts:218-227`).
  The content-pack import keeps `optionsSql` (`custom-query-transfer.ts:88`). A blank optional select
  binds `''`.
- cdr-toolchain: `SpecimenRecpt.ReferenceNumber` is already loaded from `REGDAT4.ReferenceNumber`
  (the `RefNos` bytes 66-121; `packages/disalab/src/lib/Forms/specimenrecpt.ts:96`). `UniqueID` is
  decoded by `REGDAT4` (`REGDAT4.ts:98`) but not copied to `SpecimenRecpt`. `apps/cli` imports
  `disalab` from its built `dist/`, so `disalab` must be rebuilt after a change.
- `config/request-attributes.yaml` is shared by every deployment. `request-fact-config.test.ts` and
  `v2-transform-request-facts.test.ts` read the real config directory.
- CE: `packages/terminology/codesystems/openldr-request-attribute.json` has 25 concepts and is loaded
  by hand with `openldr terminology import resource <file>`. Its test pins 25 in three places
  (`packages/terminology/src/request-attribute-codesystem.test.ts`).
- Package names: cdr `@cdr-toolchain/cli` (`apps/cli`), `disalab`; CE `@openldr/terminology`.

## Files

| Repo | File | Change |
|---|---|---|
| openldr_ce | `packages/terminology/codesystems/openldr-request-attribute.json` | two concepts |
| openldr_ce | `packages/terminology/src/request-attribute-codesystem.test.ts` | 27 concepts, new codes |
| cdr-toolchain | `config/request-attributes.yaml` | two keys |
| cdr-toolchain | `apps/cli/src/config/request-fact-config.ts` (+ test) | read the two keys |
| cdr-toolchain | `packages/disalab/src/lib/Forms/specimenrecpt.ts` | `UniqueID` field |
| cdr-toolchain | `apps/cli/src/export/v2-transform.ts` (+ `v2-transform-request-facts.test.ts`) | send the two attributes |
| cdr-toolchain | `packs/shared/pg-check.mjs` | create: check runner |
| cdr-toolchain | `packs/shared/pack-build.mjs` | create: `toCsv`, `csvCell`, `summarizeStep` |
| cdr-toolchain | `packs/vl-reports-mz/check-vl-functions.mjs`, `build.mjs`, `vl-queries.mjs` | use shared code; export 4 helpers |
| cdr-toolchain | `packs/reports-zm/zm-queries.mjs` | create: the query |
| cdr-toolchain | `packs/reports-zm/check-reports-zm.mjs` | create: the case table |
| cdr-toolchain | `packs/reports-zm/build.mjs` | create: register + steps + manifest |
| cdr-toolchain | `packs/reports-zm/PACK.md`, `README.md`, `QUESTIONS-FOR-ZM.md`, `.gitignore` | create |

cdr-toolchain paths are relative to `D:/Projects/Repositories/cdr-toolchain/.claude/worktrees/reports-zm`.
CE paths are relative to `D:/Projects/Repositories/openldr_ce/.claude/worktrees/request-attribute-ids`.

---

### Task 0: Worktrees

Prerequisite: the spec and this plan are committed on cdr-toolchain `docs/reports-zm-spec`.

- [ ] **Step 1: cdr-toolchain worktree**

```bash
cd D:/Projects/Repositories/cdr-toolchain
git worktree add .claude/worktrees/reports-zm -b feat/reports-zm main
cd .claude/worktrees/reports-zm
git merge --no-edit docs/reports-zm-spec
pnpm install --frozen-lockfile > "$TEMP/zm-install.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=0`; `docs/superpowers/plans/2026-10-09-reports-zm-slice-1.md` present.

- [ ] **Step 2: CE worktree**

```bash
cd D:/Projects/Repositories/openldr_ce
git worktree add .claude/worktrees/request-attribute-ids -b feat/request-attribute-ids main
cd .claude/worktrees/request-attribute-ids
pnpm install --frozen-lockfile > "$TEMP/ce-install.txt" 2>&1; echo "exit=$?"
```

Expected: `exit=0`.

Before every commit in either worktree, run `git branch --show-current` and check the branch name.
Stage files by exact path.

---

### Task 1: CE lists the two new attribute codes

**Files (CE worktree):**
- Modify: `packages/terminology/codesystems/openldr-request-attribute.json`
- Test: `packages/terminology/src/request-attribute-codesystem.test.ts`

**Interfaces:** Produces the codes `reference-numbers` and `unique-id`. Task 2's config uses them.

- [ ] **Step 1: Update the test first**

In `request-attribute-codesystem.test.ts`:
- change `it('has 25 concepts, ...'` to `it('has 27 concepts, ...'` and `toHaveLength(25)` to
  `toHaveLength(27)`;
- change `it('imports 25 concepts ...'` to `it('imports 27 concepts ...'`, `conceptsLoaded).toBe(25)`
  to `toBe(27)`, and `expect(rows).toHaveLength(25)` to `toHaveLength(27)`;
- after `expect(rows.find((r) => r.code === 'target-time-mins')).toBeTruthy();` add:

```ts
    expect(rows.find((r) => r.code === 'reference-numbers')).toBeTruthy();
    expect(rows.find((r) => r.code === 'unique-id')).toBeTruthy();
```

- [ ] **Step 2: Run it and see it fail**

```bash
cd D:/Projects/Repositories/openldr_ce/.claude/worktrees/request-attribute-ids/packages/terminology
npx vitest run src/request-attribute-codesystem.test.ts > "$TEMP/ce-t1.txt" 2>&1; echo "exit=$?"; grep -E "Tests|FAIL|expected" "$TEMP/ce-t1.txt" | head
```

Expected: `exit=1`; failures on length 25 vs 27.

- [ ] **Step 3: Add the two concepts**

Append to the `concept` array of `openldr-request-attribute.json`, after the `target-time-mins`
entry, keeping the file's 2-space JSON style:

```json
    {
      "code": "reference-numbers",
      "display": "Reference numbers"
    },
    {
      "code": "unique-id",
      "display": "Unique ID"
    }
```

- [ ] **Step 4: Run it and see it pass**

Same command as Step 2. Expected: `exit=0`, all tests in the file pass.

- [ ] **Step 5: Full CE gate**

```bash
cd D:/Projects/Repositories/openldr_ce/.claude/worktrees/request-attribute-ids
pnpm turbo run test --force --concurrency=2 --continue > "$TEMP/ce-gate-test.txt" 2>&1; echo "test exit=$?"
pnpm turbo run typecheck --force --concurrency=2 > "$TEMP/ce-gate-tc.txt" 2>&1; echo "typecheck exit=$?"
grep -E "Tasks:|Failed:" "$TEMP/ce-gate-test.txt" "$TEMP/ce-gate-tc.txt"
```

Expected: both `exit=0`. If a package fails, grep the file for `out of memory`, `VirtualAlloc` and
`Test timed out` and re-run that package alone before treating it as a regression (CLAUDE.md).

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add packages/terminology/codesystems/openldr-request-attribute.json packages/terminology/src/request-attribute-codesystem.test.ts
git commit -m "feat(terminology): reference-numbers and unique-id request attributes"
```

---

### Task 2: cdr-toolchain reads the two attribute keys

**Files (cdr worktree):**
- Modify: `config/request-attributes.yaml`
- Modify: `apps/cli/src/config/request-fact-config.ts`
- Test: `apps/cli/src/config/request-fact-config.test.ts`

**Interfaces:** `AttributeCodes` gains `referenceNumbers: string | null` and `uniqueId: string | null`.
Task 3 uses them.

- [ ] **Step 1: Update the tests first**

In `request-fact-config.test.ts`:
- `ATTRS` gains two lines after `folder_number: ordering-notes`:
  `  reference_numbers: reference-numbers` and `  unique_id: unique-id`;
- every expected `attributeCodes` object gains the two keys. The two `deepEqual`s that expect codes
  become
  `{ therapy: "therapy", folderNumber: "ordering-notes", referenceNumbers: "reference-numbers", uniqueId: "unique-id", newborn: "newborn" }`;
  the "no attribute file" one becomes
  `{ therapy: null, folderNumber: null, referenceNumbers: null, uniqueId: null, newborn: null }`.

- [ ] **Step 2: Run and see it fail**

```bash
cd D:/Projects/Repositories/cdr-toolchain/.claude/worktrees/reports-zm/apps/cli
node --import tsx --test src/config/request-fact-config.test.ts > "$TEMP/cdr-t2.txt" 2>&1; echo "exit=$?"; grep -E "^# (pass|fail)" "$TEMP/cdr-t2.txt"
```

Expected: `exit=1`, failing `deepEqual`s.

- [ ] **Step 3: Implement**

`request-fact-config.ts`:

```ts
/** Attribute codes in urn:openldr:cs:request-attribute, keyed by the DISA source the code knows. */
export interface AttributeCodes {
  therapy: string | null;
  folderNumber: string | null;
  /** REGDAT4 RefNos, v1 Patients.REFNO. */
  referenceNumbers: string | null;
  /** REGDAT4 UniqueID, v1 Patients.UNIQUEID. */
  uniqueId: string | null;
  newborn: string | null;
}
```

`NO_ATTRIBUTES` becomes
`{ therapy: null, folderNumber: null, referenceNumbers: null, uniqueId: null, newborn: null }`.
`attributesSchema.request_attributes` gains `reference_numbers: attributeCode.optional(),` and
`unique_id: attributeCode.optional(),` after `folder_number`. In `loadRequestFactConfig`:

```ts
  const attributeCodes: AttributeCodes = {
    therapy: a.therapy ?? null, folderNumber: a.folder_number ?? null,
    referenceNumbers: a.reference_numbers ?? null, uniqueId: a.unique_id ?? null,
    newborn: a.newborn ?? null,
  };
```

`config/request-attributes.yaml`, after the `folder_number` line:

```yaml
  reference_numbers: reference-numbers # REGDAT4 RefNos; taken as v1 Patients.REFNO (unconfirmed)
  unique_id: unique-id          # REGDAT4 UniqueID; taken as v1 Patients.UNIQUEID (unconfirmed)
```

- [ ] **Step 4: Run and see it pass**

Same command as Step 2. Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add config/request-attributes.yaml apps/cli/src/config/request-fact-config.ts apps/cli/src/config/request-fact-config.test.ts
git commit -m "feat(export): config keys for the reference-numbers and unique-id attributes"
```

---

### Task 3: cdr-toolchain sends the two attributes

**Files (cdr worktree):**
- Modify: `packages/disalab/src/lib/Forms/specimenrecpt.ts`
- Modify: `apps/cli/src/export/v2-transform.ts`
- Test: `apps/cli/src/export/v2-transform-request-facts.test.ts`

**Interfaces:** Consumes `AttributeCodes.referenceNumbers` and `.uniqueId` (Task 2). Produces
attributes `{ code: "reference-numbers", valueString }` and `{ code: "unique-id", valueString }` in
`request_facts.attributes`, after `ordering-notes` and before `newborn`.

- [ ] **Step 1: Add the test first**

In `v2-transform-request-facts.test.ts`, after the "newborn is absent ..." test:

```ts
test("reference numbers and unique id are sent when the specimen has them", () => {
  const req = run(specimen({ ReferenceNumber: ",ELABS 12AT.3456", UniqueID: "ZM-001" }), TZ_OFFSETS, TZ_FACTS).lab_requests[0]!;
  const attrs = (req.source_payload.request_facts as { attributes?: { code: string; valueString?: string }[] }).attributes!;
  assert.deepEqual(attrs.map((a) => a.code), ["therapy", "ordering-notes", "reference-numbers", "unique-id", "newborn"]);
  assert.equal(attrs.find((a) => a.code === "reference-numbers")?.valueString, ",ELABS 12AT.3456");
  assert.equal(attrs.find((a) => a.code === "unique-id")?.valueString, "ZM-001");
});

test("blank reference numbers and unique id are not sent", () => {
  const req = run(specimen({ ReferenceNumber: "  ", UniqueID: null }), TZ_OFFSETS, TZ_FACTS).lab_requests[0]!;
  const attrs = (req.source_payload.request_facts as { attributes?: { code: string }[] }).attributes!;
  assert.deepEqual(attrs.map((a) => a.code), ["therapy", "ordering-notes", "newborn"]);
});
```

The existing tests keep passing unchanged: their fixture has neither field, so nothing new is sent.

- [ ] **Step 2: Run and see it fail**

```bash
cd D:/Projects/Repositories/cdr-toolchain/.claude/worktrees/reports-zm/apps/cli
node --import tsx --test src/export/v2-transform-request-facts.test.ts > "$TEMP/cdr-t3.txt" 2>&1; echo "exit=$?"; grep -E "^# (pass|fail)|not ok" "$TEMP/cdr-t3.txt"
```

Expected: `exit=1`; the first new test fails (codes list lacks the two).

- [ ] **Step 3: `UniqueID` on the specimen**

`specimenrecpt.ts`: add the field after `ReferenceNumber`:

```ts
  UniqueID: string | null = null;
```

After `r.ReferenceNumber = regdat4.ReferenceNumber;` add `r.UniqueID = regdat4.UniqueID;`. After
`if (Core.IsNullOrEmpty(r.ReferenceNumber)) r.ReferenceNumber = null;` add
`if (Core.IsNullOrEmpty(r.UniqueID)) r.UniqueID = null;`.

- [ ] **Step 4: Send the attributes**

`v2-transform.ts`, right after the `folderNo` lines:

```ts
  // v1 Patients.REFNO and UNIQUEID, which Zambia's reports build the ART number from.
  const referenceNumbers = nz(s.ReferenceNumber);
  if (codes.referenceNumbers !== null && referenceNumbers !== null) attributes.push({ code: codes.referenceNumbers, valueString: referenceNumbers });
  const uniqueId = nz(s.UniqueID);
  if (codes.uniqueId !== null && uniqueId !== null) attributes.push({ code: codes.uniqueId, valueString: uniqueId });
```

- [ ] **Step 5: Rebuild `disalab`, run the tests, typecheck**

```bash
cd D:/Projects/Repositories/cdr-toolchain/.claude/worktrees/reports-zm
pnpm --filter disalab build > "$TEMP/cdr-t3b.txt" 2>&1; echo "build exit=$?"
pnpm --filter @cdr-toolchain/cli test > "$TEMP/cdr-t3t.txt" 2>&1; echo "test exit=$?"; grep -E "^# (pass|fail)" "$TEMP/cdr-t3t.txt"
pnpm turbo run typecheck --force > "$TEMP/cdr-t3c.txt" 2>&1; echo "typecheck exit=$?"
pnpm --filter disalab test > "$TEMP/cdr-t3d.txt" 2>&1; echo "disalab test exit=$?"
```

Expected: all four `exit=0`; `# fail 0`.

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add packages/disalab/src/lib/Forms/specimenrecpt.ts apps/cli/src/export/v2-transform.ts apps/cli/src/export/v2-transform-request-facts.test.ts
git commit -m "feat(export): send REGDAT4 reference numbers and unique id as request attributes"
```

`packages/disalab/dist` is git-ignored (`.gitignore:84`); it is never committed.

---

### Task 4: Shared pack helpers, Mozambique output unchanged

**Files (cdr worktree):**
- Create: `packs/shared/pg-check.mjs`, `packs/shared/pack-build.mjs`
- Modify: `packs/vl-reports-mz/check-vl-functions.mjs`, `packs/vl-reports-mz/build.mjs`,
  `packs/vl-reports-mz/vl-queries.mjs`

**Interfaces:**
- `pg-check.mjs` exports `WAREHOUSE_TABLES`, `lit(v)` (SQL literal, NULL as `null::text`, else
  `'…'::text`), `caseSuite(name, columns, cases, expr, opts?)`, `inOrder(keys, names)`,
  `runSuites(suites)` (runs, prints `N checks, M failed`, exits 1 on failure).
- `pack-build.mjs` exports `csvCell(v)`, `toCsv(rows, cols)`, `summarizeStep(step)`.
- `vl-queries.mjs` additionally exports `lit`, `rpt`, `foldSql`, `inListSql` (unchanged bodies).

- [ ] **Step 1: Baseline the Mozambique output**

```bash
cd D:/Projects/Repositories/cdr-toolchain/.claude/worktrees/reports-zm
node packs/vl-reports-mz/build.mjs > "$TEMP/mz-build-before.txt" 2>&1; echo "exit=$?"
rm -rf "$TEMP/mz-before" && cp -r packs/vl-reports-mz/dist "$TEMP/mz-before"
node -e "import('./packs/vl-reports-mz/vl-queries.mjs').then(m=>console.log(require('crypto').createHash('sha256').update(m.vlResultSql(m.MOZ_CODES)+m.vlInfoSql(m.MOZ_CODES)).digest('hex')))"
node packs/vl-reports-mz/check-vl-functions.mjs
```

Expected: build `exit=0`; a hash (record it); `76 checks, 0 failed`.

- [ ] **Step 2: Create `packs/shared/pg-check.mjs`**

Move these from `check-vl-functions.mjs` without changing their bodies: `CONTAINER`, `DATABASE`,
`WAREHOUSE_TABLES` (add `'facility_registry'` as the ninth table), `lit`, `caseSuite`, `inOrder`,
`runPsql`, and the runner block (everything after `// ---- Runner ----`), the runner wrapped as:

```js
// Shared runner for the packs' hand-run SQL checks (check-*.mjs). A check builds a list of suites
// and calls runSuites. Every query runs in the CE dev Postgres container (PG_CONTAINER, default
// openldr_ce-postgres-1; PG_DATABASE, default openldr_target) on temp copies of the warehouse
// tables (CREATE TEMP TABLE ... LIKE), which Postgres searches before the real ones, inside a
// transaction that is rolled back. It reads no warehouse rows.
//
// A suite is { name, count, check(rows) -> string[] failures, sql?, setup? }. `setup` runs before
// every suite's `sql`. Each `sql` prints lines "<name>\t<json>".

export function runSuites(suites) {
  const sqlSuites = suites.filter((s) => s.sql);
  const script = [
    'begin;',
    ...WAREHOUSE_TABLES.map((t) => `create temp table ${t} (like public.${t} including defaults);`),
    ...suites.map((s) => s.setup ?? ''),
    ...sqlSuites.map((s) => s.sql),
    'rollback;',
  ].join('\n');
  const stdout = sqlSuites.length > 0 ? runPsql(script) : '';

  const rowsBySuite = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const name = line.slice(0, tab);
    if (!rowsBySuite.has(name)) rowsBySuite.set(name, []);
    rowsBySuite.get(name).push(JSON.parse(line.slice(tab + 1)));
  }

  let total = 0;
  const failures = [];
  for (const s of suites) {
    total += s.count;
    for (const f of s.check(rowsBySuite.get(s.name) ?? [])) failures.push(`${s.name}: ${f}`);
  }
  for (const f of failures) console.error(`FAIL ${f}`);
  console.log(`${total} checks, ${failures.length} failed`);
  process.exit(failures.length > 0 ? 1 : 0);
}
```

`lit`, `caseSuite`, `inOrder` and `WAREHOUSE_TABLES` get `export`; `runPsql` stays private.

- [ ] **Step 3: Point the Mozambique check at it**

In `check-vl-functions.mjs`: delete the `spawnSync` import, the moved definitions and the runner
block; add `import { lit, caseSuite, inOrder, runSuites } from '../shared/pg-check.mjs';`; end the
file with `runSuites(suites);`. `bindParams`, `WIRING_ROWS`, `wiringSuite` and every suite stay.

- [ ] **Step 4: Create `packs/shared/pack-build.mjs` and point the Mozambique build at it**

```js
// Helpers shared by the packs' build.mjs scripts.

const clean = (v) => (v == null ? '' : String(v).trim());

export function csvCell(v) {
  const s = clean(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A header line, then one line per row in `cols` order. CRLF, with a final CRLF.
export const toCsv = (rows, cols) =>
  [cols.join(','), ...rows.map((r) => cols.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n';
```

Then move `summarizeStep` from `vl-reports-mz/build.mjs` into this file unchanged, with `export`
(keep its comment about CE's `summarizeContentPack`). In `vl-reports-mz/build.mjs`: delete
`csvCell`, `summarizeStep` and the `toCsv` arrow; import
`{ toCsv, summarizeStep } from '../shared/pack-build.mjs'`; change `toCsv(regRows)` to
`toCsv(regRows, header)`. `clean` and `cleanNull` stay (the build uses them).

- [ ] **Step 5: Export the four SQL helpers**

In `vl-queries.mjs` add `export` to `const lit`, `const rpt`, `const foldSql`, `const inListSql`.
No body changes.

- [ ] **Step 6: Prove nothing changed**

```bash
node packs/vl-reports-mz/build.mjs > "$TEMP/mz-build-after.txt" 2>&1; echo "exit=$?"
BEFORE="$TEMP/mz-before" node -e "
const fs=require('fs');const drop=(k,v)=>['timestamp','exportedAt','builtAt'].includes(k)?undefined:v;
for (const f of ['pack.json','manifest.json','build-summary.json']) {
  const a=JSON.stringify(JSON.parse(fs.readFileSync(process.env.BEFORE+'/'+f,'utf8')),drop);
  const b=JSON.stringify(JSON.parse(fs.readFileSync('packs/vl-reports-mz/dist/'+f,'utf8')),drop);
  console.log(f, a===b?'same':'DIFFERENT');
}"
node -e "import('./packs/vl-reports-mz/vl-queries.mjs').then(m=>console.log(require('crypto').createHash('sha256').update(m.vlResultSql(m.MOZ_CODES)+m.vlInfoSql(m.MOZ_CODES)).digest('hex')))"
node packs/vl-reports-mz/check-vl-functions.mjs
```

Expected: `exit=0`; `same` three times; the same hash as Step 1; `76 checks, 0 failed`.

- [ ] **Step 7: Commit**

```bash
git branch --show-current
git add packs/shared/pg-check.mjs packs/shared/pack-build.mjs packs/vl-reports-mz/check-vl-functions.mjs packs/vl-reports-mz/build.mjs packs/vl-reports-mz/vl-queries.mjs
git commit -m "refactor(packs): share the check runner and build helpers between packs"
```

---

### Task 5: The ART number rule

**Files (cdr worktree):**
- Create: `packs/reports-zm/zm-queries.mjs` (first part)
- Create: `packs/reports-zm/check-reports-zm.mjs`

**Interfaces:**
- Consumes `lit`, `caseSuite`, `runSuites` (`../shared/pg-check.mjs`); `lit` from
  `../vl-reports-mz/vl-queries.mjs` (imported as `sqlLit`, a plain `'…'` literal).
- Produces `artNumberSql(ref: string, uniqueId: string): string` (both arguments are SQL text
  expressions that are never NULL). Task 6 uses it.

- [ ] **Step 1: Write the check script with the ART suite**

`packs/reports-zm/check-reports-zm.mjs`:

```js
// Checks the reports-zm query SQL against real Postgres, over a table of cases.
//
//   node packs/reports-zm/check-reports-zm.mjs
//
// Uses the shared runner (../shared/pg-check.mjs): temp copies of the warehouse tables in the CE
// dev Postgres container, rolled back. Exits 1 on any mismatch. Run it by hand before a release.

import { caseSuite, runSuites } from '../shared/pg-check.mjs';
import { artNumberSql } from './zm-queries.mjs';

const suites = [];

// v1 sp_GetPreviousVLResultforCohort2x: the ART number from REFNO, else UNIQUEID. HOSPID is not
// sent yet, so its rule never fires (spec section 3).
suites.push(caseSuite('art-number', ['ref', 'uq'], [
  { ref: ',ELABS 12AT.3456', uq: 'U-1', expected: '3456' },
  { ref: ',elabs xt.99', uq: 'U', expected: '99' },
  { ref: 'ART12345,ELABS 99', uq: 'U', expected: '12345' },
  // v1 raises an error here (RIGHT with a negative length). The port gives ''.
  { ref: 'AB,ELABS', uq: 'U', expected: '' },
  { ref: '', uq: 'AB-12 34', expected: 'AB1234' },
  { ref: ' , AT. ', uq: 'Q-1', expected: 'Q1' },
  { ref: 'ART.555', uq: 'AB-1', expected: 'AB1' },
  { ref: 'elabs.123', uq: 'X-9', expected: 'X9' },
  { ref: ',ART.5', uq: 'Z-1', expected: 'Z1' },
  { ref: '12-345 678,AT.', uq: 'U', expected: '12345678' },
  { ref: '1234at.5', uq: 'U', expected: '12345' },
  { ref: 'A,T.9', uq: 'U', expected: '9' },
  { ref: '', uq: '', expected: '' },
], artNumberSql('ref', 'uq')));

// ---- Suites above this line ----

runSuites(suites);
```

- [ ] **Step 2: Run and see it fail**

Run: `node packs/reports-zm/check-reports-zm.mjs`
Expected: exits 1 with `Cannot find module` for `zm-queries.mjs`.

- [ ] **Step 3: Write the first part of `zm-queries.mjs`**

```js
// SQL for Zambia's reports, ported from v1's OpenLDRReporting database
// (corlix/fixtures/Zambia_views/script.sql, UTF-16). build.mjs puts them in the custom-queries step
// of dist/pack.json. The SQL may differ from v1's; the output must match.

import { lit as sqlLit } from '../vl-reports-mz/vl-queries.mjs';

// SQL Server's REPLACE ignores case under the default collation, so v1's replace(x, 'AT.', '')
// also removes 'at.'. Postgres replace() is case-sensitive, so that step is a regexp. The order of
// the steps is v1's: commas, then 'AT.', then spaces, then dashes.
const dropCommaAt = (x) => `regexp_replace(replace(${x}, ',', ''), 'AT\\.', '', 'gi')`;
const stripRef = (x) => `replace(replace(${dropCommaAt(x)}, ' ', ''), '-', '')`;
const stripId = (x) => `replace(replace(${x}, ' ', ''), '-', '')`;

// The ART number, v1 sp_GetPreviousVLResultforCohort2x. `ref` is REFNO and `uniqueId` UNIQUEID,
// both SQL text that is never NULL ('' when not sent). v1 LIKE ignores case, so ilike.
//   1. REFNO starts ",ELABS": the text after the first "T.".
//   2. REFNO contains ",ELABS": the part before ",elabs", less its first 3 characters. (v1 errors
//      when that part is under 3 characters; substr gives ''.)
//   3. v1: REFNO blank and HOSPID set gives HOSPID. HOSPID is not sent yet (spec section 3), so
//      this rule never fires and a blank REFNO falls to rule 4.
//   4. REFNO blank after stripping: UNIQUEID without spaces and dashes.
//   5. REFNO, less commas and "AT.", starts "ART." or "ELABS.": UNIQUEID without spaces and dashes.
//   6. Otherwise REFNO without commas, "AT.", spaces and dashes.
export function artNumberSql(ref, uniqueId) {
  return `case
    when ${ref} ilike ',ELABS%' then substr(${ref}, strpos(upper(${ref}), 'T.') + 2)
    when ${ref} ilike '%,ELABS%' then substr(left(${ref}, strpos(lower(${ref}), ',elabs') - 1), 4)
    when ${stripRef(ref)} = '' then ${stripId(uniqueId)}
    when ${dropCommaAt(ref)} ilike 'ART.%' or ${dropCommaAt(ref)} ilike 'ELABS.%' then ${stripId(uniqueId)}
    else ${stripRef(ref)}
  end`;
}
```

`sqlLit` is imported now because Task 6 uses it; if your linter objects to an unused import, add it
in Task 6 instead.

- [ ] **Step 4: Run and see it pass**

Run: `node packs/reports-zm/check-reports-zm.mjs`
Expected: `13 checks, 0 failed`.

If a case fails, re-read v1 in `script.sql` (convert with `iconv -f UTF-16 -t UTF-8`; search
`sp_GetPreviousVLResultforCohort2x`) before changing either side, and report what you found.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add packs/reports-zm/zm-queries.mjs packs/reports-zm/check-reports-zm.mjs
git commit -m "feat(packs): Zambia's ART number rule as SQL in reports-zm"
```

---

### Task 6: The "VL clients by province" query

**Files (cdr worktree):**
- Modify: `packs/reports-zm/zm-queries.mjs`
- Modify: `packs/reports-zm/check-reports-zm.mjs`

**Interfaces:**
- Consumes `artNumberSql` (Task 5); `rpt`, `inListSql`, `isNumericSql`, `lit` from
  `../vl-reports-mz/vl-queries.mjs` (Task 4 exports them); `lit`, `inOrder` from the shared runner.
- Produces: `ZM_REGISTER_URL`, `ZM_CODES`, `INVALID_RESULTS`, `SUPPRESSED_RESULTS`,
  `BELOW_LIMIT_RESULTS`, `provinceOptionsSql(registerUrl)`, `provinceClientsSql(codes)`,
  `zmParams(registerUrl)`, `zmQueryFile()`. Task 7's build uses `ZM_REGISTER_URL` and `zmQueryFile`.

- [ ] **Step 1: Add the suites to the check script**

Change the imports to:

```js
import { lit, caseSuite, inOrder, runSuites } from '../shared/pg-check.mjs';
import { artNumberSql, provinceClientsSql, provinceOptionsSql, ZM_CODES, ZM_REGISTER_URL } from './zm-queries.mjs';
```

Insert above `// ---- Suites above this line ----`:

```js
// The province picker: distinct provinces of in-register ZMFAC rows, sorted.
const REGISTRY_ROWS = `insert into facility_registry (id, facility_code, name, facility_system, region, register_state) values
  ('fr1', '1', 'A', ${lit(ZM_REGISTER_URL)}, 'Southern', 'in_register'),
  ('fr2', '2', 'B', ${lit(ZM_REGISTER_URL)}, 'Lusaka', 'in_register'),
  ('fr3', '3', 'C', ${lit(ZM_REGISTER_URL)}, 'Lusaka', 'in_register'),
  ('fr4', '4', 'D', ${lit(ZM_REGISTER_URL)}, 'Western', 'dropped'),
  ('fr5', '5', 'E', 'urn:example:other', 'Maputo', 'in_register'),
  ('fr6', '6', 'F', ${lit(ZM_REGISTER_URL)}, null, 'in_register');`;

suites.push({
  name: 'province-options',
  setup: REGISTRY_ROWS,
  sql: `select 'province-options' || chr(9) || json_build_object('v', q.region)::text from (${provinceOptionsSql(ZM_REGISTER_URL)}) q;`,
  count: 1,
  check(rows) {
    const got = rows.map((r) => r.v);
    return JSON.stringify(got) === JSON.stringify(['Lusaka', 'Southern']) ? [] : [`expected ["Lusaka","Southern"], got ${JSON.stringify(got)}`];
  },
});

// Requests for the full query. W1-W5, W7, W9 are in range; W6's facility is unmapped; W8 and W10
// fall outside 2026-05-01..2026-05-31. W9's result date is the last evening of the range.
const ATTR = "'urn:openldr:cs:request-attribute'";
const WIRING_ROWS = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('fm-s', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('fm-l', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('fm-u', '', '', 'ZUNMP', null, null, null, null);
insert into patients (id, firstname, surname, sex) values
  ('p1', 'Mary', 'Banda', 'F'), ('p2', 'John', 'Phiri', 'M'), ('p3', 'Ruth', 'Mwale', 'F'),
  ('p4', null, 'Zulu', null), ('p5', 'Grace', 'Tembo', 'F'), ('p6', 'Ann', 'Moyo', 'F'),
  ('p7', 'Peter', 'Lungu', 'M'), ('p8', 'Joy', 'Bwalya', 'F'), ('p9', 'Esther', 'Daka', 'F'),
  ('p10', 'Paul', 'Sakala', 'M');
insert into lab_requests (id, request_id, panel_code, authored_at, requester_code, patient_id, age_years) values
  ('w1', 'V1', 'HIVVL', '2026-05-02T08:00:00Z', 'ZSOUT', 'p1', 30),
  ('w2', 'V2', 'HIVVL', '2026-05-02T09:00:00Z', 'ZSOUT', 'p2', 41),
  ('w3', 'V3', 'HIVVL', '2026-05-02T10:00:00Z', 'ZSOUT', 'p3', 25),
  ('w4', 'V4', 'HIVVL', '2026-05-03T08:00:00Z', 'ZSOUT', 'p4', 19),
  ('w5', 'V5', 'HIVVL', '2026-05-04T08:00:00Z', 'ZSOUT', 'p5', 33),
  ('w6', 'V6', 'HIVVL', '2026-05-04T09:00:00Z', 'ZUNMP', 'p6', 50),
  ('w7', 'V7', 'HIVVL', '2026-05-05T08:00:00Z', 'ZLUSA', 'p7', 28),
  ('w8', 'V8', 'HIVVL', '2026-06-20T08:00:00Z', 'ZSOUT', 'p8', 36),
  ('w9', 'V9', 'RTRI', '2026-05-06T08:00:00Z', 'ZSOUT', 'p9', 22),
  ('w10', 'V10', 'HIVVL', '2026-04-25T08:00:00Z', 'ZSOUT', 'p10', 44);
insert into diagnostic_reports (id, based_on_id, status, effective, issued) values
  ('d1', 'w1', 'final', '2026-05-01T07:00:00Z', '2026-05-10T10:00:00Z'),
  ('d2', 'w2', 'final', '2026-05-01T08:00:00Z', '2026-05-11T10:00:00Z'),
  ('d3', 'w3', 'final', '2026-05-01T09:00:00Z', '2026-05-12T10:00:00Z'),
  ('d4', 'w4', 'cancelled', '2026-05-02T08:00:00Z', null),
  ('d5', 'w5', 'final', '2026-05-03T08:00:00Z', '2026-05-13T10:00:00Z'),
  ('d6', 'w6', 'final', '2026-05-03T09:00:00Z', '2026-05-13T11:00:00Z'),
  ('d7', 'w7', 'final', '2026-05-04T08:00:00Z', '2026-05-14T10:00:00Z'),
  ('d8', 'w8', 'final', '2026-06-19T08:00:00Z', '2026-07-01T10:00:00Z'),
  ('d9', 'w9', 'final', '2026-05-05T08:00:00Z', '2026-05-31T23:00:00Z'),
  ('d10', 'w10', 'cancelled', '2026-04-24T08:00:00Z', null);
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values
  ('r1', 'w1', 'HIVVL', null, 540, null, null),
  ('r2a', 'w2', 'HIVVL', 'Target Not Detected', null, null, null),
  ('r2b', 'w2', 'HIVVC', null, 1500, null, null),
  ('r3', 'w3', 'HIVVL', 'INVAL', null, null, null),
  ('r5a', 'w5', 'HIVVL', 'Please repeat', null, null, null),
  ('r5b', 'w5', 'HIVVD', null, 200, null, null),
  ('r6', 'w6', 'HIVVL', null, 540, null, null),
  ('r7', 'w7', 'HIVVL', null, 300, null, null),
  ('r8', 'w8', 'HIVVL', null, 100, null, null),
  ('r9', 'w9', 'HIVVL', '<20 copies/mL', null, null, null);
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values
  ('a1', 'w1', ${ATTR}, 'reference-numbers', ',ELABS 12AT.3456'),
  ('a2', 'w1', ${ATTR}, 'unique-id', 'ZM-001'),
  ('a5', 'w2', ${ATTR}, 'reference-numbers', 'AT.12-34 56'),
  ('a3', 'w3', ${ATTR}, 'unique-id', 'ZM-77'),
  ('a4', 'w4', ${ATTR}, 'unique-id', 'ZM 44'),
  ('a9', 'w9', ${ATTR}, 'unique-id', 'U-9');`;

const COLUMNS = ['Province', 'District', 'Facility', 'LabID', 'Name', 'AgeInYears', 'Gender', 'ARTNumber',
  'CollectedDate', 'RegisteredDate', 'ResultDate', 'Result', 'Suppressed'];

const row = (Province, District, Facility, LabID, Name, AgeInYears, Gender, ARTNumber, CollectedDate,
  RegisteredDate, ResultDate, Result, Suppressed) => ({ Province, District, Facility, LabID, Name, AgeInYears,
  Gender, ARTNumber, CollectedDate, RegisteredDate, ResultDate, Result, Suppressed });
const S = ['Southern', 'Choma', 'Choma General Hospital'];
const EXPECTED_SOUTHERN = [
  // Part 1, valid results.
  row(...S, 'V1', 'Mary Banda', 30, 'Female', '3456', '2026-05-01T07:00:00Z', '2026-05-02T08:00:00Z', '2026-05-10T10:00:00Z', '540', 'Yes'),
  row(...S, 'V2', 'John Phiri', 41, 'Male', '123456', '2026-05-01T08:00:00Z', '2026-05-02T09:00:00Z', '2026-05-11T10:00:00Z', 'Target Not Detected', 'Yes'),
  row(...S, 'V2', 'John Phiri', 41, 'Male', '123456', '2026-05-01T08:00:00Z', '2026-05-02T09:00:00Z', '2026-05-11T10:00:00Z', '1500', 'No'),
  row(...S, 'V5', 'Grace Tembo', 33, 'Female', '', '2026-05-03T08:00:00Z', '2026-05-04T08:00:00Z', '2026-05-13T10:00:00Z', '200', 'Yes'),
  row(...S, 'V9', 'Esther Daka', 22, 'Female', 'U9', '2026-05-05T08:00:00Z', '2026-05-06T08:00:00Z', '2026-05-31T23:00:00Z', '<20 copies/mL', 'Yes'),
  // Part 2, rejected: raw unique id, no surname-only trim, Gender Missing.
  row(...S, 'V4', ' Zulu', 19, 'Missing', 'ZM 44', '2026-05-02T08:00:00Z', '2026-05-03T08:00:00Z', null, 'REJECTED', null),
  // Part 3, unclear: raw unique id. V5's "Please repeat" is not here: V5 is in part 1.
  row(...S, 'V3', 'Ruth Mwale', 25, 'Female', 'ZM-77', '2026-05-01T09:00:00Z', '2026-05-02T10:00:00Z', '2026-05-12T10:00:00Z', 'INVAL', null),
];
const EXPECTED_ALL = [
  ...EXPECTED_SOUTHERN,
  row('Lusaka', 'Lusaka', 'Chilenje Clinic', 'V7', 'Peter Lungu', 28, 'Male', '', '2026-05-04T08:00:00Z', '2026-05-05T08:00:00Z', '2026-05-14T10:00:00Z', '300', 'Yes'),
];

const bind = (sqlText, params) => Object.entries(params)
  .reduce((s, [k, v]) => s.replaceAll(`{{param.${k}}}`, `'${v.replace(/'/g, "''")}'`), sqlText);

function querySuite(name, params, expected, setup = '') {
  return {
    name,
    setup,
    sql: `select ${lit(name)} || chr(9) || row_to_json(q)::text from (${bind(provinceClientsSql(ZM_CODES), params)}) q;`,
    count: expected.length + 1,
    check(rows) {
      const failures = [];
      if (rows[0]) failures.push(...inOrder(Object.keys(rows[0]), COLUMNS));
      if (rows[0] && Object.keys(rows[0]).length !== COLUMNS.length) failures.push(`expected ${COLUMNS.length} columns, got ${Object.keys(rows[0]).length}`);
      const key = (r) => JSON.stringify(COLUMNS.map((c) => r[c] ?? null));
      const got = rows.map(key).sort();
      const want = expected.map(key).sort();
      for (const w of want) if (!got.includes(w)) failures.push(`missing row ${w}`);
      for (const g of got) if (!want.includes(g)) failures.push(`unexpected row ${g}`);
      return failures;
    },
  };
}

suites.push(querySuite('clients-all', { province: '', from: '2026-05-01', to: '2026-05-31' }, EXPECTED_ALL, WIRING_ROWS));
suites.push(querySuite('clients-southern', { province: 'Southern', from: '2026-05-01', to: '2026-05-31' }, EXPECTED_SOUTHERN));
```

- [ ] **Step 2: Run and see it fail**

Run: `node packs/reports-zm/check-reports-zm.mjs`
Expected: exits 1 with `does not provide an export named 'provinceClientsSql'`.

- [ ] **Step 3: Write the rest of `zm-queries.mjs`**

Change the import to
`import { lit as sqlLit, rpt, inListSql, isNumericSql } from '../vl-reports-mz/vl-queries.mjs';`
and append:

```js
export const ZM_REGISTER_URL = 'urn:openldr:zm:facilities';

// Zambia's v1 panel and observation codes (content, so they live in the pack).
export const ZM_CODES = {
  // TND: the valid results of part 1.
  validPanels: ['HIVVL', 'RTRI'],
  validObservations: ['HIVVL', 'HIVVC', 'HIVTM', 'HIVVD', 'POCVR', 'POCVC'],
  // Parts 2 and 3.
  vlPanel: 'HIVVL',
  unclearObservations: ['HIVVL', 'HIVVC', 'HIVVD'],
};

const ATTR_SYSTEM = 'urn:openldr:cs:request-attribute';

// v1 TND (sp_GetPreviousVLResultforCohort2x): results left out as not a viral load.
export const INVALID_RESULTS = [
  'antibodies. @mat3', 'FAIL', 'Haemolysed', 'Haemolysed ++', 'Insufficient for further tests',
  'Insufficient serum received', 'INV', 'INVAL', 'Negative', 'No', 'Please repeat', 'Positive',
  'to confirm patient identity.', 'Weak Positive', 'Invalid', 'Absent', 'antibodies.', 'AT', 'Failed',
  'Icteric ++++', 'Indeterminate', 'per request', 'Positive (Repeat sample)',
  'This result has been checked', 'VAL', '@con1 @con2',
];
// v1 TND: results counted as suppressed, beside any number under 1000.
export const SUPPRESSED_RESULTS = [
  '<20 copies/mL', 'TAR', 'Target Not Detected', 'TARG', '< 20', 'RNA not detected', '<30 copies/ml',
  '<30 copies/mL', 'NDET', 'ND', '<20CP', '< 40', '<40 copies/mL', '<400 copies/mL', '<400',
  '<883 copies/mL',
];
// v1 sp_*_hivvl_clients_month, part "incs": texts that are not unclear although not a number.
export const BELOW_LIMIT_RESULTS = [
  '< 20', '<30 copies/mL', '> 10000000', 'NDET', 'Target Not Detected', 'RNA Not Detected',
  '<400 copies/mL', '<400', '<40 copies/mL',
];

const sqlList = (values) => values.map(sqlLit).join(', ');
const inRange = (x) => `${x} >= {{param.from}} and ${x} <= ({{param.to}} || 'T23:59:59.999Z')`;

// The province picker: the register's provinces. CE runs it through validateSelectSql and uses the
// first column of each row.
export const provinceOptionsSql = (registerUrl) =>
  `select distinct region from facility_registry where facility_system = ${sqlLit(registerUrl)} and register_state = 'in_register' and region is not null and region <> '' order by region`;

// "VL clients by province": v1's 12 sp_<province>_hivvl_clients_month/_quarter procedures as one
// query. Three parts joined with UNION, as v1's are:
//   zm_valid    v1 TND: every final VL result in the range that is not an invalid text.
//   zm_rejected cancelled HIVVL requests registered in the range, not in zm_valid.
//   zm_unclear  final HIVVL results that are neither a number nor a below-limit text, not in zm_valid.
// v1 reads its copy tables TND and hivvl; this rebuilds them from the warehouse. Province, district
// and facility come from the requesting facility's mapped ZMFAC row; unmapped facilities drop out,
// as v1's inner joins drop facilities missing from its dictionary. Gender and the two dates always
// come from the request (v1 part 1 leaves them blank when its hivvl table lacks the request).
// Part 1 builds the ART number with artNumberSql; parts 2 and 3 show the unique id raw, as v1 does.
export function provinceClientsSql(codes) {
  const result = rpt('r');
  return `with zm_ids as (
  select a.lab_request_id,
    max(case when a.code = 'reference-numbers' then a.value_text end) as reference_numbers,
    max(case when a.code = 'unique-id' then a.value_text end) as unique_id
  from lab_request_attributes a
  where a.system = ${sqlLit(ATTR_SYSTEM)} and a.code in ('reference-numbers', 'unique-id')
  group by a.lab_request_id
),
zm_req as (
  select lr.id, lr.request_id, lr.panel_code, lr.age_years, lr.authored_at,
    fmr.region as province, fmr.district, fmr.name as facility,
    concat(p.firstname, ' ', p.surname) as client_name,
    case p.sex when 'F' then 'Female' when 'M' then 'Male' when 'U' then 'Unknown' when 'I' then 'Indeterminate' else 'Missing' end as gender,
    zi.reference_numbers, zi.unique_id,
    dr.status as report_status, dr.effective as collected_date, dr.issued as result_date
  from lab_requests lr
  join facility_map fmr on fmr.source_system = coalesce(lr.source_system, '') and fmr.performer_system = coalesce(lr.requester_system, '') and fmr.source_code = lr.requester_code and fmr.registry_id is not null
  left join diagnostic_reports dr on dr.based_on_id = lr.id
  left join patients p on p.id = lr.patient_id
  left join zm_ids zi on zi.lab_request_id = lr.id
  where ({{param.province}} = '' or fmr.region = {{param.province}})
),
zm_valid as (
  select q.province, q.district, q.facility, q.request_id as lab_id, q.client_name, q.age_years, q.gender,
    ${artNumberSql("coalesce(q.reference_numbers, '')", "coalesce(q.unique_id, '')")} as art_number,
    q.collected_date, q.authored_at as registered_date, q.result_date,
    ${result} as result,
    case when ${inListSql(result, SUPPRESSED_RESULTS)} or r.numeric_value < 1000 then 'Yes' else 'No' end as suppressed
  from zm_req q
  join lab_results r on r.request_id = q.id
  where q.panel_code in (${sqlList(codes.validPanels)})
    and r.observation_code in (${sqlList(codes.validObservations)})
    and q.report_status = 'final'
    and ${inRange('q.result_date')}
    and ${result} is not null
    and not ${inListSql(result, INVALID_RESULTS)}
),
zm_rejected as (
  select q.province, q.district, q.facility, q.request_id as lab_id, q.client_name, q.age_years, q.gender,
    q.unique_id as art_number, q.collected_date, q.authored_at as registered_date, q.result_date,
    'REJECTED' as result, null::text as suppressed
  from zm_req q
  where q.panel_code = ${sqlLit(codes.vlPanel)}
    and q.report_status = 'cancelled'
    and ${inRange('q.authored_at')}
    and not exists (select 1 from zm_valid v where v.lab_id = q.request_id)
),
zm_unclear as (
  select q.province, q.district, q.facility, q.request_id as lab_id, q.client_name, q.age_years, q.gender,
    q.unique_id as art_number, q.collected_date, q.authored_at as registered_date, q.result_date,
    ${result} as result, null::text as suppressed
  from zm_req q
  join lab_results r on r.request_id = q.id
  where q.panel_code = ${sqlLit(codes.vlPanel)}
    and r.observation_code in (${sqlList(codes.unclearObservations)})
    and q.report_status = 'final'
    and ${inRange('q.result_date')}
    and ${result} is not null
    and not ${isNumericSql(result)}
    and not ${inListSql(result, BELOW_LIMIT_RESULTS)}
    and not exists (select 1 from zm_valid v where v.lab_id = q.request_id)
)
select province as "Province", district as "District", facility as "Facility", lab_id as "LabID",
  client_name as "Name", age_years as "AgeInYears", gender as "Gender", art_number as "ARTNumber",
  collected_date as "CollectedDate", registered_date as "RegisteredDate", result_date as "ResultDate",
  result as "Result", suppressed as "Suppressed"
from (
  select * from zm_valid
  union
  select * from zm_rejected
  union
  select * from zm_unclear
) zm
order by 1, 2, 3, 4, 11, 12, 5, 6, 7, 8, 9, 10, 13`;
}

export const zmParams = (registerUrl) => [
  { id: 'province', label: 'Province (blank for all)', type: 'select', required: false, optionsSql: provinceOptionsSql(registerUrl) },
  { id: 'from', label: 'Date from (YYYY-MM-DD)', type: 'text', required: true },
  { id: 'to', label: 'Date to (YYYY-MM-DD)', type: 'text', required: true },
];

export function zmQueryFile() {
  return {
    format: 'openldr.custom-queries',
    version: 1,
    exportedAt: new Date().toISOString(),
    queries: [
      { name: 'VL clients by province', sql: provinceClientsSql(ZM_CODES), params: zmParams(ZM_REGISTER_URL) },
    ],
  };
}
```

The `order by` lists every column, so the order is total (AGENTS.md section 7: ORDER BY with
OFFSET needs a unique tiebreaker; UNION removes duplicate rows).

- [ ] **Step 4: Run and see it pass**

Run: `node packs/reports-zm/check-reports-zm.mjs`
Expected: `31 checks, 0 failed` (13 + 1 + 9 + 8).

If a row is missing or unexpected, find out why from the data before changing code or expected
values, and report what you found.

- [ ] **Step 5: Banned words and comments**

```bash
node -e "import('./packs/reports-zm/zm-queries.mjs').then(({zmQueryFile})=>{for(const q of zmQueryFile().queries){for(const s of [q.sql, ...q.params.map(p=>p.optionsSql).filter(Boolean)]){const t=s.replace(/'(?:[^']|'')*'/g,\"''\");const m=t.match(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i);console.log(m?'BANNED '+m[0]:'ok', s.includes('--')?'HAS --':'no --')}}})"
```

Expected: `ok no --` twice (the query and its `optionsSql`).

- [ ] **Step 6: Commit**

```bash
git branch --show-current
git add packs/reports-zm/zm-queries.mjs packs/reports-zm/check-reports-zm.mjs
git commit -m "feat(packs): VL clients by province, one query for Zambia's 12 province procedures"
```

---

### Task 7: The build

**Files (cdr worktree):**
- Create: `packs/reports-zm/build.mjs`, `packs/reports-zm/.gitignore`, a first `packs/reports-zm/PACK.md`

**Interfaces:** Consumes `ZM_REGISTER_URL`, `zmQueryFile` (Task 6); `toCsv`, `summarizeStep`
(Task 4). Produces `dist/pack.json` (2 steps), `dist/manifest.json`, `dist/build-summary.json`.

- [ ] **Step 1: `.gitignore` and a first `PACK.md`**

`packs/reports-zm/.gitignore`: `dist/` (one line, as `vl-reports-mz/.gitignore`).

`packs/reports-zm/PACK.md` (Task 8 fills it out):

```markdown
# Zambia reports

Zambia's v1 reports in OpenLDR CE, for data exported from DISA*Lab.
```

- [ ] **Step 2: Write `build.mjs`**

```js
// Builds the reports-zm content pack.
//
//   node packs/reports-zm/build.mjs
//
// Reads Zambia's master facility list (ZM_MFL_CSV, else the corlix fixture path below) and writes
// dist/ (git-ignored), next to this script:
//   pack.json            the pack payload, in install order
//   manifest.json        the unsigned artifact manifest; `openldr artifact pack` signs it
//   build-summary.json   row counts and every row or value left out, with the reason

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv, summarizeStep } from '../shared/pack-build.mjs';
import { zmQueryFile, ZM_REGISTER_URL } from './zm-queries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, 'dist');
const MFL_CSV = process.env.ZM_MFL_CSV
  ?? 'D:/Projects/Repositories/corlix/fixtures/Zambia_master_facility_list/mfl_facilities_export20260810155748.csv';

// MFL "Operational status" as CE location-status codes (active, suspended, inactive).
const STATUS = { 'Functional': 'active', 'Closed': 'inactive', 'Permanent closure': 'inactive', 'Temporarily closure': 'suspended' };
// MFL columns kept raw in extras, as [MFL header, extras key]. CE stores extras keys in lowercase.
const EXTRAS = [
  ['Hims code', 'hims_code'], ['DHIS2 UID', 'dhis2_uid'], ['Type', 'type'], ['Ownership', 'ownership'],
  ['Ownership type', 'ownership_type'], ['Constituency', 'constituency'], ['Ward', 'ward'], ['Location', 'location'],
];
const EXTRA_COLUMNS = EXTRAS.map(([, key]) => key);
const COLUMNS = ['national_code', 'name', 'region', 'district', 'status', 'latitude', 'longitude', ...EXTRA_COLUMNS];

const clean = (v) => (v == null ? '' : String(v).trim());

// RFC 4180: quoted cells, doubled quotes, commas and line breaks inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// CE drops a row's coordinates unless both are valid, so the build keeps both or neither.
function coordinates(latRaw, lonRaw) {
  const lat = clean(latRaw), lon = clean(lonRaw);
  if (!lat && !lon) return { latitude: '', longitude: '', problem: null };
  const la = Number(lat), lo = Number(lon);
  const ok = lat !== '' && lon !== '' && Number.isFinite(la) && Number.isFinite(lo) && la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
  return ok ? { latitude: lat, longitude: lon, problem: null }
    : { latitude: '', longitude: '', problem: `coordinates "${lat}", "${lon}" are not a valid pair; both left out` };
}

function writeJson(name, value) {
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function main() {
  const [header, ...rows] = parseCsv(readFileSync(MFL_CSV, 'utf8').replace(/^\uFEFF/, ''));
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`the MFL CSV has no "${name}" column`);
    return i;
  };
  const at = (row, name) => clean(row[col(name)]);

  const summary = {
    source: MFL_CSV,
    builtAt: new Date().toISOString(),
    read: rows.length,
    register: { rows: 0, byStatus: {}, left_out: [], coordinates_left_out: [] },
  };

  const byCode = new Map();
  for (const row of rows) {
    const code = at(row, 'MFL Code');
    const name = at(row, 'Name');
    if (!code) { summary.register.left_out.push({ key: name, reason: 'blank MFL Code' }); continue; }
    if (!name) { summary.register.left_out.push({ key: code, reason: 'blank Name' }); continue; }
    if (byCode.has(code)) { summary.register.left_out.push({ key: code, reason: 'duplicate MFL Code' }); continue; }
    const operational = at(row, 'Operational status');
    const status = STATUS[operational];
    if (status === undefined) throw new Error(`MFL Code ${code}: unknown Operational status "${operational}"`);
    const coords = coordinates(row[col('Latitude')], row[col('Longitude')]);
    if (coords.problem) summary.register.coordinates_left_out.push({ key: code, reason: coords.problem });
    const rec = {
      national_code: code, name, region: at(row, 'Province'), district: at(row, 'District'), status,
      latitude: coords.latitude, longitude: coords.longitude,
    };
    for (const [source, key] of EXTRAS) rec[key] = at(row, source);
    byCode.set(code, rec);
  }
  const regRows = [...byCode.values()].sort((a, b) => a.national_code.localeCompare(b.national_code, 'en', { numeric: true }));
  summary.register.rows = regRows.length;
  for (const r of regRows) summary.register.byStatus[r.status] = (summary.register.byStatus[r.status] ?? 0) + 1;

  const steps = [
    // No link-matching step: DISA facility codes are letters, MFL codes are numbers, so equal codes
    // never meet. An admin maps DISA codes to these rows in CE's Facilities screen (spec section 1).
    { kind: 'facility-register', url: ZM_REGISTER_URL, name: 'Zambia health facilities', code: 'ZMFAC', csv: toCsv(regRows, COLUMNS), extraColumns: EXTRA_COLUMNS },
    { kind: 'custom-queries', file: zmQueryFile() },
  ];
  writeJson('pack.json', { formatVersion: 1, steps });

  const leftOut = [
    ...summary.register.left_out.map((r) => `facility register, MFL ${r.key}: ${r.reason}`),
    ...summary.register.coordinates_left_out.map((r) => `facility register, MFL ${r.key}: ${r.reason}`),
  ];
  const readme = readFileSync(join(here, 'PACK.md'), 'utf8').trimEnd()
    + `\n\n## Rows and values left out of this build\n\nBuilt from the Zambia master facility list. ${leftOut.length} left out.\n\n`
    + leftOut.map((l) => `- ${l}`).join('\n') + '\n';
  writeJson('manifest.json', {
    schemaVersion: 1,
    type: 'content-pack',
    id: 'reports-zm',
    version: '0.1.0',
    description: "Zambia's v1 reports in OpenLDR CE, for data exported from DISA*Lab.",
    readme,
    license: 'UNLICENSED',
    publisher: { id: 'openldr-content', name: 'OpenLDR Content Publisher', keyFingerprint: '0'.repeat(64) },
    compatibility: { ceVersion: '*' },
    capabilities: [],
    payload: { kind: 'content-pack', steps: steps.map(summarizeStep) },
  });
  writeJson('build-summary.json', summary);

  console.log(JSON.stringify({
    read: summary.read,
    steps: steps.map(summarizeStep),
    register: { rows: summary.register.rows, byStatus: summary.register.byStatus, leftOut: summary.register.left_out.length, coordinatesLeftOut: summary.register.coordinates_left_out.length },
  }, null, 2));
}

try { main(); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
```

- [ ] **Step 3: Build and check the counts**

Run: `node packs/reports-zm/build.mjs`

Expected:
- `read: 3788`
- `steps`: `facility-register` "Zambia health facilities" count 3788, then `custom-queries`
  "VL clients by province" count 1
- `register.rows: 3788`, `byStatus: { active: 3771, inactive: 16, suspended: 1 }`, `leftOut: 0`,
  `coordinatesLeftOut: 12`

If a number differs, stop and report it with the output; do not change code to make it match.

- [ ] **Step 4: Spot-check the register CSV and the query**

```bash
node -e "const p=require('./packs/reports-zm/dist/pack.json');const csv=p.steps[0].csv.split('\r\n');console.log(csv[0]);console.log(csv.find(l=>l.startsWith('1835,')));console.log(csv.find(l=>l.startsWith('4157,')));const q=p.steps[1].file.queries[0];console.log(q.name, q.params.map(x=>x.id+':'+x.type).join(' '), !!q.params[0].optionsSql)"
node packs/reports-zm/check-reports-zm.mjs
```

Expected: the header
`national_code,name,region,district,status,latitude,longitude,hims_code,dhis2_uid,type,ownership,ownership_type,constituency,ward,location`;
row 1835 `1835,Namatindi Rural Health Centre,Western,Kalabo,active,-14.44888262,22.76034052,90010019,fykM10MbEBA,Health Centre,MOH,Public,Kalabo Central,Ndoka,Rural`;
row 4157 with latitude `-8.65494` and longitude `29.16818` (the trailing tab trimmed);
`VL clients by province province:select from:text to:text true`; then `31 checks, 0 failed`.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add packs/reports-zm/build.mjs packs/reports-zm/.gitignore packs/reports-zm/PACK.md
git commit -m "feat(packs): reports-zm 0.1.0 build: Zambia facility register and the province query"
```

---

### Task 8: PACK.md, README.md, QUESTIONS-FOR-ZM.md

**Files (cdr worktree):** `packs/reports-zm/PACK.md` (rewrite), `README.md` (create),
`QUESTIONS-FOR-ZM.md` (create). No test cycle; rebuild after PACK.md (it goes into the manifest).

- [ ] **Step 1: PACK.md (admin-facing, shown in the marketplace)**

```markdown
# Zambia reports

Zambia's v1 reports in OpenLDR CE, for data exported from DISA*Lab. This version has the Zambia
health facility register and one report. Later versions add more of Zambia's reports.

## What it installs

1. The facility register `urn:openldr:zm:facilities`, code `ZMFAC`: 3,788 facilities from Zambia's
   master facility list (August 2026), keyed on the MFL code.
2. The query "VL clients by province".

Installing again is safe. It updates the register rows and replaces the query. A query you edited
under the same name is overwritten.

## The facility register

Each facility has its MFL code, name, province, district, status and, where the list has a valid
pair, latitude and longitude. Status comes from the list's operational status: Functional is
active, Closed and Permanent closure are inactive, Temporarily closure is suspended. In CE a
facility's status is information only; an inactive facility is still listed and reported.

The register also keeps eight list values in each facility's `extras`, exactly as the list has
them: `hims_code`, `dhis2_uid`, `type`, `ownership`, `ownership_type`, `constituency`, `ward` and
`location`.

**Map your lab's facility codes.** DISA*Lab names facilities with its own codes, not MFL codes, so
the pack cannot link them for you. In CE, open Facilities and map each requesting facility code to
its register row; CE suggests matches by name. A request from an unmapped facility does not appear
in the report.

## VL clients by province

One query in place of v1's 12 province procedures (`sp_<province>_hivvl_clients_month` and the two
quarterly ones). Pick a province, or leave it blank for all, and a date range: a month or a quarter.

Columns, in v1's order: Province, District, Facility, LabID, Name, AgeInYears, Gender, ARTNumber,
CollectedDate, RegisteredDate, ResultDate, Result, Suppressed.

It lists, for the range:

- every valid viral load result (Suppressed is Yes under 1000 copies or for a below-limit text);
- every rejected viral load request, with Result `REJECTED`;
- every result that is neither a number nor a below-limit text, as written.

A report run stops at 1000 rows. Narrow the dates or pick a province for a big range.

## How it differs from v1

- Province, District and Facility names come from the master facility list, not from v1's
  dictionary. Some spellings can differ.
- Gender, CollectedDate and RegisteredDate are always filled. v1 left them blank for some results.
- Rejected means a cancelled result. v1 also counted statuses Y and Z, which reach CE only as
  "unknown", so they cannot be picked out.
- The ART number is built as v1 builds it, from the reference number, else the unique ID. v1 also
  used a hospital number, which CE does not receive yet.
- The data must come from a DISA*Lab that cdr-toolchain has measured. Until then results have no
  status or result date, and the report is empty.
```

- [ ] **Step 2: README.md (for pack authors)**

Cover, in this order, in the style of `packs/vl-reports-mz/README.md`:

- **Files** table: `build.mjs`, `zm-queries.mjs`, `check-reports-zm.mjs`, `QUESTIONS-FOR-ZM.md`,
  `PACK.md`, `.gitignore`, and the shared `../shared/pg-check.mjs` and `../shared/pack-build.mjs`;
  then the three `dist/` outputs.
- **Build**: `node packs/reports-zm/build.mjs`; input `ZM_MFL_CSV` or the corlix fixture path.
- **Check**: `node packs/reports-zm/check-reports-zm.mjs` (31 checks), what it covers and that it
  reads no warehouse rows.
- **Sign and publish**: as in `vl-reports-mz/README.md`.
- **Steps, in install order**: the register, then the query; why there is no link-matching step.
- **How the register is built**: the column table from spec section 1, status mapping, the 12 rows
  whose coordinates were left out (and why), what is dropped.
- **The query**: the three parts with their exact rules and the three text lists (name the
  constants in `zm-queries.mjs`), the ART number rule (six steps, rule 3 skipped), the province
  picker's `optionsSql`, the date range.
- **Where it differs from v1**: the five bullets of spec "Differences from v1", plus plan rulings
  1 to 3 (ART number per part, blank IDs, v1's RIGHT error).
- **Source**: `corlix/fixtures/Zambia_views/script.sql` (UTF-16; `iconv -f UTF-16 -t UTF-8`), the
  procedures `sp_SPHO_hivvl_clients_month` and `sp_GetPreviousVLResultforCohort2x`.
- **HONEST NON-PROOF**: the four items of the spec's section.

- [ ] **Step 3: QUESTIONS-FOR-ZM.md**

Header as `vl-reports-mz/QUESTIONS-FOR-MZ.md` ("Open questions ... Opened 2026-10-09."), then one
numbered section per question in spec "Delivery" (dictionary backup; result sample as DISA*Lab and
v1; HOSPID source and REFNO/UNIQUEID confirmation; status Y and Z; which views are still used). Each
section says why we ask and what we do with the answer, in two to four short sentences.

- [ ] **Step 4: Rebuild, unslop, em dashes**

```bash
node packs/reports-zm/build.mjs > "$TEMP/zm-build.txt" 2>&1; echo "exit=$?"
grep -c $'\xe2\x80\x94' packs/reports-zm/PACK.md packs/reports-zm/README.md packs/reports-zm/QUESTIONS-FOR-ZM.md
```

Expected: `exit=0` with Task 7's counts; `0` for each file. Run the `unslop` skill over the three
files and fix what it flags.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add packs/reports-zm/PACK.md packs/reports-zm/README.md packs/reports-zm/QUESTIONS-FOR-ZM.md
git commit -m "docs(packs): reports-zm 0.1.0 docs and questions for the Zambia team"
```

---

### Task 9: Live check on the dev CE (controller)

No code. Done by the controller: it needs the publisher key, the shared dev CE and the Browser pane.

- [ ] **Step 1: Re-import the request-attribute code system**

```bash
cd D:/Projects/Repositories/openldr_ce
node_modules/.bin/tsx packages/cli/src/index.ts terminology import resource D:/Projects/Repositories/openldr_ce/.claude/worktrees/request-attribute-ids/packages/terminology/codesystems/openldr-request-attribute.json
```

Expected: 27 concepts loaded. Then check the dev CE now lists both codes (Terminology page, or the
internal database's concepts for `urn:openldr:cs:request-attribute`).

- [ ] **Step 2: Sign**

```bash
node_modules/.bin/tsx packages/cli/src/index.ts artifact pack D:/Projects/Repositories/cdr-toolchain/.claude/worktrees/reports-zm/packs/reports-zm/dist --key C:/Users/Fredrick/.openldr/keys/content-publisher/publisher.priv --out <scratchpad>/reports-zm-0.1.0
```

Expected: `packed reports-zm@0.1.0`, fingerprint `69b5920dc40a601cd61736e71998f3dcc138407717b5b632ee99a519674314be`.

- [ ] **Step 3: Install**

`market install <scratchpad>/reports-zm-0.1.0 --dry-run`, then without `--dry-run`. Expected: 2
steps, installed. The pack is new on the dev CE, so `install` (not `update`).

- [ ] **Step 4: Check the register and the query**

- Warehouse: `select count(*), count(*) filter (where status = 'active') from facility_registry where facility_system = 'urn:openldr:zm:facilities' and register_state = 'in_register';`
  Expected `3788|3771`.
- Studio, Query page: open "VL clients by province". The Province picker lists the 10 provinces.
  Run with Province blank, from 2026-01-01, to 2026-12-31. Expected: HTTP 200, 0 rows (the dev
  warehouse is empty), no error.

- [ ] **Step 5: Report and stop**

Report the commits, the check outputs, build counts, install output, the counts above, the picker
values and the run. Then the HONEST NON-PROOF list below. Do not merge, publish or push.

---

### Task 10 (only when the operator says so): merge, changelog, publish, push

- [ ] **Step 1: CE**: merge `feat/request-attribute-ids` into local CE `main` (`--no-ff`), run
  `pnpm make:changelog`, commit `apps/web/src/landing/changelog.json` as
  `chore(web): update changelog after the request attribute codes`, push, confirm the origin SHA.
- [ ] **Step 2: cdr-toolchain**: merge `feat/reports-zm` into `main` (`--no-ff`), run both pack checks
  (`check-vl-functions.mjs` 76, `check-reports-zm.mjs` 31), confirm the merged tree equals the
  signed source (`git diff <last task commit> main --stat` is empty), push, confirm the origin SHA.
- [ ] **Step 3: Marketplace**: copy `<scratchpad>/reports-zm-0.1.0` to
  `openldr-ce-marketplace/bundles/reports-zm-0.1.0`; compare sha256 of the three files with the
  scratchpad copy; add to `index.json` `packages`:
  `{ "id": "reports-zm", "kind": "content-pack", "latestVersion": "0.1.0", "publisher": "OpenLDR Content Publisher", "summary": "Zambia's v1 reports in OpenLDR CE, for data exported from DISA*Lab.", "path": "bundles/reports-zm-0.1.0", "signatureFingerprint": "69b5920dc40a601cd61736e71998f3dcc138407717b5b632ee99a519674314be" }`
  and set `updatedAt`; commit `feat: publish the reports-zm content pack 0.1.0 (Zambia register, VL clients by province)`; push; confirm the origin SHA.
- [ ] **Step 4: Verify the published bundle**: download the three files from GitHub at the pushed
  SHA, compare hashes, and run `market install <download> --dry-run --force`.
- [ ] **Step 5: Clean up** the two worktrees and branches (cdr `feat/reports-zm`,
  `docs/reports-zm-spec`; CE `feat/request-attribute-ids`).

---

## HONEST NON-PROOF

What this plan does not prove, even when every step passes:

- **Parity with v1 on real Zambia data.** The check runs made-up rows. The Zambia sample is the proof.
- **The patient ID sources.** `REFNO` = `RefNos` and `UNIQUEID` = `UniqueID` are inferred.
- **HOSPID.** Not sent; rule 3 never fires.
- **Facility names.** MFL names are not compared with Zambia's dictionary.
- **Zambia's DISA layout.** Unmeasured, so real Zambia data has no status or result date yet.
- **CE's own parameter binding of this query.** The check binds literals; the studio run in Task 9
  binds real parameters but returns zero rows.
- **The cdr-toolchain export end to end.** Unit tests cover the transform; no real DISA specimen with
  a `UniqueID` was exported to a CE.

## Self-review notes

- Spec coverage: register (Tasks 7, 8), query and its parameters and three parts (Task 6), ART number
  rule (Task 5) and fields (Tasks 2, 3), CE codes (Task 1), testing (check script, unit tests, gate,
  live), delivery including QUESTIONS-FOR-ZM.md (Task 8) and publish (Task 10).
- Check counts: art-number 13; province-options 1; clients-all 8 rows + 1 = 9; clients-southern 7
  rows + 1 = 8. Total 31.
- Types: `artNumberSql(ref, uniqueId)` takes non-NULL SQL text in Task 5 and Task 6. `AttributeCodes`
  keys `referenceNumbers`, `uniqueId` match between Tasks 2 and 3. `ZM_REGISTER_URL`, `zmQueryFile`
  match between Tasks 6 and 7.

# VL functions port: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** "VL info" and "VL results" return v1's six function columns (`ReasonForTest`,
`HIVVL_ViralLoadResult`, `HIVVL_ViralLoadCAPCTM`, `HIVVL_Low_value`, `HIVVL_Viral`,
`FinalViralLoadResult`) instead of the raw stand-in columns. Ship it as vl-reports-mz 0.5.3.

**Architecture:** Each v1 SQL function becomes an inline SQL expression, built by a helper in
`vl-queries.mjs`. The coded-result descriptions ship in the pack as a code system and value set.
"VL results" reads them once per run through a CTE. A check script runs the expressions and both
full queries against the dev Postgres, on temp copies of the warehouse tables.

**Tech Stack:** Node ESM scripts (no test runner in cdr-toolchain packs), Postgres 16 in the CE dev
container, `mssql` for the dictionary read, the CE CLI for signing and installing.

**Spec:** `docs/superpowers/specs/2026-10-09-vl-functions-port-design.md` (cdr-toolchain).

## Global Constraints

- Repo: cdr-toolchain. CE is not changed. So no CE changelog, docs or CLI work.
- A custom query is one read-only SELECT. CE's `validateSelectSql`
  (`openldr_ce/packages/dashboards/src/sql-runner.ts:17`) rejects these words anywhere outside a
  string literal or comment: `insert update delete drop alter create truncate grant revoke merge
  call copy into`. Never use one as a SQL identifier, alias or CTE name. JS names are fine.
- Keep the SQL free of `--` comments. Put explanations in JS comments.
- Port v1, not intent. Where v1 looks like a bug, match it and say so in a comment.
- v1 compares with SQL Server's default collation: case-insensitive, trailing spaces ignored. The
  port compares `lower(rtrim(x))`.
- Value set URL `urn:openldr:mz:vl-coded-results`. Code system URL
  `urn:openldr:mz:cs:vl-coded-results`. Both names `MozVlCodedResults`.
- Pack version `0.5.3` (0.5.2 is published; see the pack-version-numbering rule).
- No em dashes in any new text. Short sentences. Run `unslop` over PACK.md, README.md and
  QUESTIONS-FOR-MZ.md edits.
- Commit only when the operator asks. Each task ends with a commit step; skip the commit if not
  yet authorized, and say so.

## Two places this plan follows v1 where the spec text is silent or different

Both found by reading `openldr-functions-script.sql` while writing this plan.

1. **Unknown coded value.** `ViralLoadResultMerge` does `SELECT @OutString = ISNULL(Value, @code)
   FROM @results WHERE Code = @code`. When no row matches, the assignment never runs and the
   function returns NULL. The spec says "or `coded` itself when it has no description". That is the
   `ISNULL` branch, for a NULL description, and none of the 39 dictionary rows has one. The plan
   returns NULL for a code missing from the value set, as v1 does.
2. **`Indeterminado` is in v1's error list twice.** Rule 2 and rule 3's "equal" branch test
   `(SELECT 1 FROM @errors WHERE Error = x) = 1`. For `Indeterminado` that subquery returns two
   rows, and SQL Server raises error 512 ("Subquery returned more than 1 value"). So in v1 a
   request whose HIVVD merges to `Indeterminado` (code `I`) with no HIVVR, HIVVC or HIVVF value
   fails the whole `viewVL_Result` query. The port cannot return an error per row. It returns
   NULL, which is what the error list means. Rule 1 uses `COUNT` and works in v1.

Both go in PACK.md, README.md and QUESTIONS-FOR-MZ.md (Task 6).

## Facts this plan rests on (checked 2026-10-09)

- `OpenLDRDict_MZ.dbo.LIMSCodedValues` columns: `DateTimeStamp, VersionStamp, LIMSCodedValue,
  Description, LIMSPanelCode, LIMSObservationCode`. Panels HIVVL and VIRAL: 39 rows, all HIVVL,
  26 distinct codes, no blank description.
- Codes with more than one description: `LDL` (Target not detected ×3, Nível de detecção baixo ×1),
  `NEG` (Negative ×3, NOT DETECTED ×1), `POS` (Positive ×1, POS ×2), `INVAL` (Invalid ×1, INVAL ×1),
  `NDET` (NOT DETECTED ×2, Not Detected ×1). The spec did not list `NDET`; the same rule covers it.
  `TND` has "Target not Detected" three times (one distinct description).
- v1 column positions (`openldr-views-script.sql`): `ReasonForTest` sits after `LocalDeColheita`
  and before `DateTimeStamp`. In `viewVL_Result` the order is `HIVVL_LIMSRejectionDesc`,
  the four merge columns, `HIVVL_VRLogValue`, `FinalViralLoadResult`, `AgeInYears`.
- v1 picks `FinalViralLoadResult`'s second input with `LEN(x.LIMSRptResult) > 0` on HIVVR, then
  HIVVC, then HIVVF, else merge(HIVVR). `LEN` ignores trailing spaces.
- Warehouse `lab_results.numeric_value` is `double precision`. `terminology_codes` has
  `value_set_url, code, display` and an index on `value_set_id` only.
- `docker exec -i openldr_ce-postgres-1 sh -c 'psql -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d openldr_target'`
  works with no password. `-q` prints only SELECT rows. All eight warehouse tables the queries
  read exist in `public`.
- The dev warehouse is empty (reset 2026-10-08). A live run returns zero rows.

## Files

| File | Change |
|---|---|
| `packs/vl-reports-mz/vl-queries.mjs` | Modify. The function helpers, the coded-results CTE, the new columns. |
| `packs/vl-reports-mz/vl-coded-results.mjs` | Create. Picks one description per code. Pure, so the check script can test it. |
| `packs/vl-reports-mz/check-vl-functions.mjs` | Create. The case table, run against real Postgres. |
| `packs/vl-reports-mz/build.mjs` | Modify. Reads `LIMSCodedValues`, adds two steps, version 0.5.3. |
| `packs/vl-reports-mz/PACK.md` | Modify. Admin-facing text. |
| `packs/vl-reports-mz/README.md` | Modify. Author-facing text. |
| `packs/vl-reports-mz/QUESTIONS-FOR-MZ.md` | Modify. Question 2 gains the new open points. |

All paths below are relative to the implementation worktree root,
`D:/Projects/Repositories/cdr-toolchain/.claude/worktrees/vl-functions-port`.

---

### Task 0: Worktree

Prerequisite: the spec and this plan are committed on `docs/vl-functions-spec`.

- [ ] **Step 1: Create the worktree from main and bring in the spec branch**

```bash
cd D:/Projects/Repositories/cdr-toolchain
git worktree add .claude/worktrees/vl-functions-port -b feat/vl-functions-port main
cd .claude/worktrees/vl-functions-port
git merge --no-edit docs/vl-functions-spec
git log --oneline -4
```

Expected: a merge commit on top of `f051eed`. `packs/vl-reports-mz/build.mjs` still says
`version: '0.5.2'` (main's 0.5.2 change is kept). Check with
`grep -n "version: '0.5" packs/vl-reports-mz/build.mjs`.

Guard every later command with the worktree path. Run `git branch --show-current` before each
commit and expect `feat/vl-functions-port`.

---

### Task 1: Check-script runner, ISNUMERIC and GetReasonForTest

**Files:**
- Create: `packs/vl-reports-mz/check-vl-functions.mjs`
- Modify: `packs/vl-reports-mz/vl-queries.mjs` (add helpers after the `rpt` definition, line 35)

**Interfaces:**
- Produces in `vl-queries.mjs`: `isNumericSql(x: string): string` (SQL boolean, never NULL),
  `reasonForTestSql(x: string): string` (SQL text). Private: `blankSql(x)`, `foldSql(x)`,
  `inListSql(x, words)`.
- Produces in the check script: `caseSuite(name, columns, cases, expr, opts?)`, the `suites`
  array, the `// ---- Runner ----` marker. Later tasks insert suites above that marker.

- [ ] **Step 1: Write the check script with two suites**

Create `packs/vl-reports-mz/check-vl-functions.mjs`:

```js
// Checks the SQL that ports v1's VL functions (GetReasonForTest, ViralLoadResultMerge,
// ViralLoadFinalResult) against real Postgres, over a table of cases.
//
//   node packs/vl-reports-mz/check-vl-functions.mjs
//
// It runs psql inside the CE dev Postgres container: PG_CONTAINER (default
// openldr_ce-postgres-1), database PG_DATABASE (default openldr_target). It reads no warehouse
// rows. Every query runs against temp copies of the warehouse tables (CREATE TEMP TABLE ... LIKE),
// which Postgres searches before the real ones, inside a transaction that is rolled back.
// Exits 1 on any mismatch. Run it by hand before a pack release, like build.mjs.

import { spawnSync } from 'node:child_process';
import { isNumericSql, reasonForTestSql } from './vl-queries.mjs';

const CONTAINER = process.env.PG_CONTAINER ?? 'openldr_ce-postgres-1';
const DATABASE = process.env.PG_DATABASE ?? 'openldr_target';

const WAREHOUSE_TABLES = [
  'lab_requests', 'lab_results', 'diagnostic_reports', 'specimens', 'patients',
  'lab_request_attributes', 'facility_map', 'terminology_codes',
];

const lit = (v) => (v === null || v === undefined ? 'null::text' : `'${String(v).replace(/'/g, "''")}'::text`);

// One SELECT over a VALUES table of cases. Each row prints "<suite>\t{"id":…,"got":…}".
// `columns` name the case fields the expression reads. `opts.with` is a CTE list to put first.
function caseSuite(name, columns, cases, expr, opts = {}) {
  const rows = cases.map((c, i) => `(${i}, ${columns.map((col) => lit(c[col])).join(', ')})`).join(',\n  ');
  const withClause = opts.with ? `with ${opts.with}\n` : '';
  return {
    name,
    setup: opts.setup ?? '',
    sql: `${withClause}select ${lit(name)} || chr(9) || json_build_object('id', id, 'got', ${expr})::text
from (values
  ${rows}
) as cases(id, ${columns.join(', ')})
order by id;`,
    count: cases.length,
    check(out) {
      const failures = [];
      cases.forEach((c, i) => {
        const row = out.find((r) => r.id === i);
        const got = row ? row.got : '(no row)';
        if (JSON.stringify(got) !== JSON.stringify(c.expected)) {
          failures.push(`${JSON.stringify(columns.map((col) => c[col] ?? null))}: expected ${JSON.stringify(c.expected)}, got ${JSON.stringify(got)}`);
        }
      });
      return failures;
    },
  };
}

const suites = [];

// SQL Server's ISNUMERIC, as far as a viral load result needs it.
suites.push(caseSuite('isnumeric', ['input'], [
  { input: '540', expected: true },
  { input: '61.736', expected: true },
  { input: '1,000', expected: true },
  { input: '1e5', expected: true },
  { input: '$5', expected: true },
  { input: ' 12 ', expected: true },
  { input: '-5', expected: true },
  { input: '1.', expected: true },
  { input: '.5', expected: true },
  { input: '201000', expected: true },
  { input: '<20', expected: false },
  { input: '< 20', expected: false },
  { input: '> 10000000', expected: false },
  { input: '', expected: false },
  { input: null, expected: false },
  { input: 'abc', expected: false },
  { input: 'INDETECTAVEL', expected: false },
], isNumericSql('input')));

// GetReasonForTest.
suites.push(caseSuite('reason', ['input'], [
  { input: null, expected: 'Reason Not Specified' },
  { input: '', expected: 'Reason Not Specified' },
  { input: '  ', expected: 'Reason Not Specified' },
  { input: 'Nao Prenchido', expected: 'Not Specified' },
  { input: 'nao prenchido', expected: 'Not Specified' },
  { input: 'Suspect treatment failure', expected: 'Suspected treatment failure' },
  { input: 'Repiticas apos AMA', expected: 'Repeat after breastfeeding' },
  { input: 'Rotina', expected: 'Routine' },
  { input: 'Rotina ', expected: 'Routine' },
  { input: 'Other reason', expected: 'Other reason' },
], reasonForTestSql('input')));

// ---- Runner ----

function runPsql(sqlText) {
  const r = spawnSync('docker', [
    'exec', '-i', '-e', 'PGCLIENTENCODING=UTF8', CONTAINER, 'sh', '-c',
    `psql -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d ${DATABASE}`,
  ], { input: sqlText, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}):\n${r.stderr}`);
  return r.stdout;
}

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
```

- [ ] **Step 2: Run it and see it fail**

Run: `node packs/vl-reports-mz/check-vl-functions.mjs`
Expected: exits 1 with `SyntaxError: The requested module './vl-queries.mjs' does not provide an export named 'isNumericSql'`.

- [ ] **Step 3: Add the helpers to `vl-queries.mjs`**

Insert after the `rpt` definition (after line 35):

```js
// ---- v1's VL functions as inline SQL. A custom query is one SELECT and cannot create SQL
// functions, so each function is an expression. Source: the Mozambique team's
// openldr-functions-script.sql (2026-10-09). v1 compares with SQL Server's default collation:
// case-insensitive, and trailing spaces do not count. So the port compares lower(rtrim(x)).

// SQL Server's ISNUMERIC: a sign, digits with thousands commas, a decimal point, an exponent, a
// currency sign, surrounding spaces. It also accepts a lone "+", "$" or "." and tabs. This does
// not; none is a plausible viral load result.
const ISNUMERIC_RE = String.raw`^\s*[-+]?[$£€¥]?(\d[\d,]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$`;

export const isNumericSql = (x) => `coalesce(${x} ~ ${lit(ISNUMERIC_RE)}, false)`;

// SQL Server's "x = ''" is also true for spaces only. NULL counts as blank here too.
const blankSql = (x) => `coalesce(rtrim(${x}), '') = ''`;
const foldSql = (x) => `lower(rtrim(${x}))`;
const inListSql = (x, words) => `${foldSql(x)} in (${words.map((w) => lit(w.toLowerCase())).join(', ')})`;

// GetReasonForTest: v1's English text for Mozambique's reason-for-test answers. Mozambique
// content, so it lives in the pack, not in CE.
const REASON_FOR_TEST = [
  ['Nao Prenchido', 'Not Specified'],
  ['Suspect treatment failure', 'Suspected treatment failure'],
  ['Repiticas apos AMA', 'Repeat after breastfeeding'],
  ['Rotina', 'Routine'],
];

export function reasonForTestSql(x) {
  const whens = REASON_FOR_TEST.map(([from, to]) => `when ${foldSql(x)} = ${lit(from.toLowerCase())} then ${lit(to)}`).join(' ');
  return `case when ${blankSql(x)} then 'Reason Not Specified' ${whens} else ${x} end`;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node packs/vl-reports-mz/check-vl-functions.mjs`
Expected: `27 checks, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add packs/vl-reports-mz/check-vl-functions.mjs packs/vl-reports-mz/vl-queries.mjs
git commit -m "feat(packs): ISNUMERIC and GetReasonForTest as SQL in vl-reports-mz, with a check script"
```

---

### Task 2: ViralLoadResultMerge and ViralLoadFinalResult

**Files:**
- Modify: `packs/vl-reports-mz/vl-queries.mjs`
- Modify: `packs/vl-reports-mz/check-vl-functions.mjs`

**Interfaces:**
- Consumes: `blankSql`, `foldSql`, `inListSql`, `isNumericSql`, `lit` from Task 1.
- Produces in `vl-queries.mjs`:
  - `VL_CODED_SYSTEM = 'urn:openldr:mz:cs:vl-coded-results'`
  - `VL_CODED_VALUE_SET = 'urn:openldr:mz:vl-coded-results'`
  - `vlCodedCte: string`, the CTE `vl_coded(code, display)` with `code` upper-cased
  - `reportedSql(alias: string): string`, the reported value with no coded fallback
  - `resultMergeSql(reported: string, coded: string): string`. Needs `vl_coded` in scope.
  - `finalResultSql(result: string, capctm: string): string`
  - `blankSql` becomes exported (Task 4 uses it in the query).
- Produces in the check script: temp `terminology_codes` fixture rows. Task 4 relies on the
  `LDL` row.

- [ ] **Step 1: Add the two suites to the check script**

Change the import line to:

```js
import {
  isNumericSql, reasonForTestSql, resultMergeSql, finalResultSql, vlCodedCte, VL_CODED_VALUE_SET,
} from './vl-queries.mjs';
```

Insert above `// ---- Runner ----`:

```js
// The coded-results value set, as the pack installs it, plus a row from another value set that
// must be ignored. Task 4's wiring suite uses the LDL row too.
const TERMINOLOGY_FIXTURE = `insert into terminology_codes (id, value_set_url, code, display) values
  ('tc-1', ${lit(VL_CODED_VALUE_SET)}, 'LDL', 'Target not detected'),
  ('tc-2', ${lit(VL_CODED_VALUE_SET)}, 'TND', 'Target not Detected'),
  ('tc-3', ${lit(VL_CODED_VALUE_SET)}, 'I', 'Indeterminado'),
  ('tc-4', ${lit(VL_CODED_VALUE_SET)}, '<20', '< 20 copies / ml'),
  ('tc-5', 'urn:example:other', 'XYZ', 'Other value set');`;

// ViralLoadResultMerge(reported, coded).
suites.push(caseSuite('merge', ['rep', 'coded'], [
  { rep: '540', coded: null, expected: '540' },
  { rep: '540', coded: 'LDL', expected: '540' },
  { rep: '< 20', coded: null, expected: '< 20' },
  { rep: null, coded: 'LDL', expected: 'Target not detected' },
  { rep: '', coded: 'LDL', expected: 'Target not detected' },
  { rep: '  ', coded: 'LDL', expected: 'Target not detected' },
  { rep: null, coded: 'ldl', expected: 'Target not detected' },
  { rep: null, coded: 'LDL ', expected: 'Target not detected' },
  { rep: null, coded: '<20', expected: '< 20 copies / ml' },
  // In another value set only: not found.
  { rep: null, coded: 'XYZ', expected: null },
  // Not in the value set: v1 returns NULL (the SELECT assignment matches no row).
  { rep: null, coded: 'ZZZ', expected: null },
  { rep: null, coded: null, expected: null },
], resultMergeSql('rep', 'coded'), { with: vlCodedCte, setup: TERMINOLOGY_FIXTURE }));

// ViralLoadFinalResult(result, capctm). Rule numbers follow the spec.
suites.push(caseSuite('final', ['res', 'cap'], [
  // Rule 1: capctm set, result NULL.
  { res: null, cap: 'POS', expected: null },
  { res: null, cap: 'pos', expected: null },
  { res: null, cap: 'Indeterminado', expected: null },
  { res: null, cap: 'Negative', expected: null },
  { res: null, cap: '< 20 copies / ml', expected: '< 20 copies / ml' },
  { res: null, cap: '> 10000000', expected: '> 10000000' },
  { res: null, cap: '540', expected: '540' },
  { res: null, cap: '1,000', expected: '1,000' },
  { res: null, cap: 'Target not detected', expected: 'INDETECTAVEL' },
  // Rule 2: capctm NULL, result set.
  { res: 'Negative', cap: null, expected: null },
  // v1 raises error 512 here (Indeterminado is in its list twice). The port returns NULL.
  { res: 'Indeterminado', cap: null, expected: null },
  { res: '< 20', cap: null, expected: '< 20' },
  // v1 quirk: rule 2 has no numeric branch.
  { res: '540', cap: null, expected: 'INDETECTAVEL' },
  { res: 'Target not detected', cap: null, expected: 'INDETECTAVEL' },
  // Rule 3: both set, or both NULL.
  { res: null, cap: null, expected: null },
  // v1 quirk: the numeric test runs on the two values joined ('201000').
  { res: '20', cap: '1000', expected: '1000' },
  { res: '1e5', cap: '5', expected: '5' },
  { res: 'Target not detected', cap: '540', expected: 'INDETECTAVEL' },
  { res: '540', cap: 'not detected', expected: 'INDETECTAVEL' },
  { res: '< 20', cap: '< 20', expected: '< 20' },
  { res: 'POS', cap: 'pos', expected: null },
  { res: 'Valid', cap: 'VALID', expected: null },
  { res: 'abc', cap: 'ABC', expected: 'INDETECTAVEL' },
  { res: '< 20', cap: '< 40', expected: null },
  { res: '540', cap: '< 20', expected: null },
  { res: 'abc', cap: '1000', expected: null },
], finalResultSql('res', 'cap')));
```

- [ ] **Step 2: Run it and see it fail**

Run: `node packs/vl-reports-mz/check-vl-functions.mjs`
Expected: exits 1 with `does not provide an export named 'finalResultSql'` (or `resultMergeSql`).

- [ ] **Step 3: Add the helpers to `vl-queries.mjs`**

Next to `POC_VALUE_SET` and `LINK_VALUE_SET` (line 25-26), add:

```js
export const VL_CODED_SYSTEM = 'urn:openldr:mz:cs:vl-coded-results';
export const VL_CODED_VALUE_SET = 'urn:openldr:mz:vl-coded-results';
```

Change `const blankSql` (Task 1) to `export const blankSql`.

After `reasonForTestSql`, add:

```js
// The reported value without rpt()'s coded fallback: text value, else comparator and numeric
// value. ViralLoadResultMerge needs it blank when only a code was reported. With rpt() it would
// never be blank, and the merge would return the code where v1 returns its description.
export const reportedSql = (a) =>
  `coalesce(${a}.text_value, coalesce(${a}.numeric_comparator || ' ', '') || ${a}.numeric_value::text)`;

// The coded-result descriptions, read once per run. terminology_codes holds every value set and
// is indexed on value_set_id only, so a lookup per row would scan it each time.
export const vlCodedCte = `vl_coded as materialized (
  select upper(code) as code, display from terminology_codes where value_set_url = ${lit(VL_CODED_VALUE_SET)}
)`;

// ViralLoadResultMerge(reported, coded): the reported value. When it is blank, the description of
// the coded value. v1 reads the descriptions from OpenLDRDict.dbo.LIMSCodedValues; the pack ships
// them as the coded-results value set. A code not in the set gives NULL, as in v1: its
// "SELECT @OutString = ... WHERE Code = @code" matches no row and leaves @OutString NULL.
export const resultMergeSql = (reported, coded) =>
  `case when ${blankSql(reported)} then (select vc.display from vl_coded vc where vc.code = upper(rtrim(${coded})) limit 1) else ${reported} end`;

// ViralLoadFinalResult's error list. v1 lists Indeterminado twice. Its rule 1 counts matches and
// works; rules 2 and 3 use "(SELECT 1 ...) = 1", which raises SQL Server error 512 on two rows.
// The port cannot raise an error per row, so it treats Indeterminado as the list means: NULL.
const VL_ERROR_WORDS = ['POS', 'Positive', 'Invalid', 'INVAL', 'Valid', 'Indeterminado', 'NEGAT', 'Reactive', 'Negative'];
const NOT_DETECTED = ['Target not detected', 'NOT DETECTED'];
const hasRangeSql = (x) => `(${x} like '%<%' or ${x} like '%>%')`;
// v1 rule 2: an error word gives NULL, a range keeps the value, anything else is INDETECTAVEL.
// There is no numeric branch, so a plain number alone in HIVVD becomes INDETECTAVEL. v1 does this.
const resultOnlySql = (x) =>
  `case when ${inListSql(x, VL_ERROR_WORDS)} then null when ${hasRangeSql(x)} then ${x} else 'INDETECTAVEL' end`;

// ViralLoadFinalResult(result, capctm). The rules, in v1's order:
//   1. capctm set, result NULL: error word NULL; range or number keeps capctm; else INDETECTAVEL.
//   2. capctm NULL, result set: resultOnlySql(result).
//   3. otherwise: the two joined are numeric, capctm (v1 tests the joined text, '20'||'1000');
//      either is "not detected", INDETECTAVEL; equal ignoring case, rule 2 on result; else NULL.
// A numeric value comes back as CE stores it (61.736, where v1 shows 62).
export function finalResultSql(result, capctm) {
  return `case
    when ${capctm} is not null and ${result} is null then
      case when ${inListSql(capctm, VL_ERROR_WORDS)} then null when ${hasRangeSql(capctm)} then ${capctm} when ${isNumericSql(capctm)} then ${capctm} else 'INDETECTAVEL' end
    when ${capctm} is null and ${result} is not null then ${resultOnlySql(result)}
    when ${isNumericSql(`coalesce(${result}, '') || coalesce(${capctm}, '')`)} then ${capctm}
    when ${inListSql(capctm, NOT_DETECTED)} or ${inListSql(result, NOT_DETECTED)} then 'INDETECTAVEL'
    when ${foldSql(result)} = ${foldSql(capctm)} then ${resultOnlySql(result)}
  end`;
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node packs/vl-reports-mz/check-vl-functions.mjs`
Expected: `65 checks, 0 failed`, exit 0.

If a `final` case fails, re-read the v1 function at `openldr-functions-script.sql` line 275
before changing either side. The case table encodes v1, not intent.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add packs/vl-reports-mz/check-vl-functions.mjs packs/vl-reports-mz/vl-queries.mjs
git commit -m "feat(packs): ViralLoadResultMerge and ViralLoadFinalResult as SQL in vl-reports-mz"
```

---

### Task 3: One description per coded value

**Files:**
- Create: `packs/vl-reports-mz/vl-coded-results.mjs`
- Modify: `packs/vl-reports-mz/check-vl-functions.mjs`

**Interfaces:**
- Produces: `pickCodedResultDisplays(rows: {panel, code, description}[])` returning
  `{ concepts: {code, display}[], choices: {code, chosen, descriptions: {description, count}[]}[], leftOut: {key, reason}[] }`.
  `concepts` is sorted by code in code-unit order. `choices` lists only codes with more than one
  distinct description.

- [ ] **Step 1: Add a JS-only suite to the check script**

Add to the imports:

```js
import { pickCodedResultDisplays } from './vl-coded-results.mjs';
```

Insert above `// ---- Runner ----`:

```js
// The duplicate rule, on the OpenLDRDict_MZ.dbo.LIMSCodedValues rows for these codes (2026-10-09).
suites.push((() => {
  const rows = [
    ...Array(3).fill(['HIVVL', 'LDL', 'Target not detected']), ['HIVVL', 'LDL', 'Nível de detecção baixo'],
    ...Array(3).fill(['HIVVL', 'NEG', 'Negative']), ['HIVVL', 'NEG', 'NOT DETECTED'],
    ['HIVVL', 'POS', 'Positive'], ['HIVVL', 'POS', 'POS'], ['HIVVL', 'POS', 'POS'],
    ['HIVVL', 'INVAL', 'Invalid'], ['HIVVL', 'INVAL', 'INVAL'],
    ['HIVVL', 'NDET', 'NOT DETECTED'], ['HIVVL', 'NDET', 'NOT DETECTED'], ['HIVVL', 'NDET', 'Not Detected'],
    ...Array(3).fill(['HIVVL', 'TND', 'Target not Detected']),
    ['HIVVL', 'ACO', null],
    ['HIVVL', '  ', 'blank code'],
  ].map(([panel, code, description]) => ({ panel, code, description }));
  const expected = {
    concepts: [
      { code: 'ACO', display: 'ACO' },
      { code: 'INVAL', display: 'INVAL' },
      { code: 'LDL', display: 'Target not detected' },
      { code: 'NDET', display: 'NOT DETECTED' },
      { code: 'NEG', display: 'Negative' },
      { code: 'POS', display: 'POS' },
      { code: 'TND', display: 'Target not Detected' },
    ],
    choiceCodes: ['INVAL', 'LDL', 'NDET', 'NEG', 'POS'],
    leftOut: 1,
  };
  return {
    name: 'pick',
    count: 3,
    check() {
      const got = pickCodedResultDisplays(rows);
      const failures = [];
      if (JSON.stringify(got.concepts) !== JSON.stringify(expected.concepts)) failures.push(`concepts: got ${JSON.stringify(got.concepts)}`);
      const codes = got.choices.map((c) => c.code);
      if (JSON.stringify(codes) !== JSON.stringify(expected.choiceCodes)) failures.push(`choices: got ${JSON.stringify(codes)}`);
      if (got.leftOut.length !== expected.leftOut) failures.push(`leftOut: got ${JSON.stringify(got.leftOut)}`);
      return failures;
    },
  };
})());
```

- [ ] **Step 2: Run it and see it fail**

Run: `node packs/vl-reports-mz/check-vl-functions.mjs`
Expected: exits 1 with `Cannot find module` for `vl-coded-results.mjs`.

- [ ] **Step 3: Write `vl-coded-results.mjs`**

```js
// One description per coded value, for the vl-reports-mz coded-results code system.
//
// v1's ViralLoadResultMerge reads OpenLDRDict.dbo.LIMSCodedValues with no ordering. A code listed
// with two descriptions shows whichever row SQL Server returns. A code system needs one display
// per code. Until the Mozambique team says which v1 shows (QUESTIONS-FOR-MZ.md, question 2): the
// most frequent description wins, and on a tie the first in (LIMSPanelCode, Description) order.
// build.mjs writes every choice to build-summary.json so it can be checked against sample data.

const trim = (v) => (v == null ? '' : String(v).trim());
// Code-unit order, so the result does not depend on the machine's locale.
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function pickCodedResultDisplays(rows) {
  const byCode = new Map();
  const leftOut = [];
  for (const row of rows) {
    const code = trim(row.code);
    if (!code) {
      leftOut.push({ key: trim(row.description), reason: 'blank LIMSCodedValue' });
      continue;
    }
    // v1 shows the code when the description is NULL: ISNULL(Value, @LIMSCodedValue).
    const description = trim(row.description) || code;
    const panel = trim(row.panel);
    if (!byCode.has(code)) byCode.set(code, new Map());
    const seen = byCode.get(code);
    const prev = seen.get(description);
    if (prev) {
      prev.count += 1;
      if (byCodeUnit(panel, prev.panel) < 0) prev.panel = panel;
    } else {
      seen.set(description, { description, count: 1, panel });
    }
  }
  const concepts = [];
  const choices = [];
  for (const code of [...byCode.keys()].sort(byCodeUnit)) {
    const ranked = [...byCode.get(code).values()].sort((a, b) =>
      b.count - a.count || byCodeUnit(a.panel, b.panel) || byCodeUnit(a.description, b.description));
    concepts.push({ code, display: ranked[0].description });
    if (ranked.length > 1) {
      choices.push({ code, chosen: ranked[0].description, descriptions: ranked.map(({ description, count }) => ({ description, count })) });
    }
  }
  return { concepts, choices, leftOut };
}
```

- [ ] **Step 4: Run it and see it pass**

Run: `node packs/vl-reports-mz/check-vl-functions.mjs`
Expected: `68 checks, 0 failed`, exit 0.

- [ ] **Step 5: Commit**

```bash
git branch --show-current
git add packs/vl-reports-mz/check-vl-functions.mjs packs/vl-reports-mz/vl-coded-results.mjs
git commit -m "feat(packs): pick one description per coded VL result in vl-reports-mz"
```

---

### Task 4: The six columns in the two queries

**Files:**
- Modify: `packs/vl-reports-mz/vl-queries.mjs` (header comment lines 7-10, `vlResultSql`, `vlInfoSql`)
- Modify: `packs/vl-reports-mz/check-vl-functions.mjs`

**Interfaces:**
- Consumes: `reportedSql`, `resultMergeSql`, `finalResultSql`, `reasonForTestSql`, `blankSql`,
  `vlCodedCte` (Tasks 1-2). The `LDL` fixture row from Task 2.
- Produces: `vlResultSql(codes)` and `vlInfoSql(codes)` with v1's column names and positions.

- [ ] **Step 1: Add the wiring suites to the check script**

Change the import to also take `MOZ_CODES, vlResultSql, vlInfoSql`. Insert above
`// ---- Runner ----`:

```js
// Both full queries on a few requests in the temp tables. The "{{param.x}}" placeholders are
// bound as literals here; CE binds them as parameters.
const bindParams = (sqlText) => sqlText
  .replaceAll('{{param.from}}', "'2026-01-01'")
  .replaceAll('{{param.to}}', "'2026-12-31'")
  .replaceAll('{{param.facility}}', "''");

const WIRING_ROWS = `insert into lab_requests (id, request_id, panel_code, authored_at) values
  ('w-a', 'A', 'HIVVL', '2026-05-01T08:00:00Z'),
  ('w-b', 'B', 'HIVVL', '2026-05-01T09:00:00Z'),
  ('w-c', 'C', 'HIVVL', '2026-05-01T10:00:00Z'),
  ('w-d', 'D', 'HIVVL', '2026-05-01T11:00:00Z'),
  ('w-e', 'E', 'VIRAL', '2026-05-01T08:00:00Z'),
  ('w-f', 'F', 'VIRAL', '2026-05-01T09:00:00Z');
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values
  ('r-a1', 'w-a', 'HIVVD', null, null, null, 'LDL'),
  ('r-b1', 'w-b', 'HIVVR', null, 540, null, null),
  ('r-c1', 'w-c', 'HIVVR', '', null, null, null),
  ('r-c2', 'w-c', 'HIVVC', null, 20, '<', null),
  ('r-d1', 'w-d', 'HIVVD', '540', null, null, null),
  ('r-d2', 'w-d', 'HIVVF', '1000', null, null, null),
  ('r-e1', 'w-e', 'ESCOL', 'Rotina', null, null, null);`;

// Fails unless `names` appear in `keys` next to each other, in this order.
function inOrder(keys, names) {
  const start = keys.indexOf(names[0]);
  const ok = start >= 0 && names.every((n, i) => keys[start + i] === n);
  return ok ? [] : [`columns not in v1 order: want ${names.join(', ')}; got ${keys.join(', ')}`];
}

function wiringSuite(name, sqlText, expected, order) {
  return {
    name,
    setup: '',
    sql: `select ${lit(name)} || chr(9) || row_to_json(q)::text from (${bindParams(sqlText)}) q;`,
    count: Object.keys(expected).length + 1,
    check(rows) {
      const failures = [];
      if (rows.length !== Object.keys(expected).length) failures.push(`expected ${Object.keys(expected).length} rows, got ${rows.length}`);
      if (rows[0]) {
        const keys = Object.keys(rows[0]);
        failures.push(...inOrder(keys, order));
        const stale = keys.filter((k) => /_LIMSRptResult$|_LIMSCodedValue$/.test(k));
        if (stale.length > 0) failures.push(`raw stand-in columns still present: ${stale.join(', ')}`);
      }
      for (const [requestId, want] of Object.entries(expected)) {
        const row = rows.find((r) => r.RequestID === requestId);
        if (!row) { failures.push(`request ${requestId}: no row`); continue; }
        for (const [col, value] of Object.entries(want)) {
          if (row[col] !== value) failures.push(`request ${requestId} ${col}: expected ${JSON.stringify(value)}, got ${JSON.stringify(row[col])}`);
        }
      }
      return failures;
    },
  };
}

suites.push({ ...wiringSuite('wiring-results', vlResultSql(MOZ_CODES), {
  // HIVVD coded LDL only. Rule 2 on "Target not detected".
  A: { HIVVL_ViralLoadResult: 'Target not detected', HIVVL_ViralLoadCAPCTM: null, HIVVL_Low_value: null, HIVVL_Viral: null, FinalViralLoadResult: 'INDETECTAVEL' },
  // HIVVR numeric only. Rule 1, numeric.
  B: { HIVVL_ViralLoadResult: null, HIVVL_ViralLoadCAPCTM: '540', FinalViralLoadResult: '540' },
  // HIVVR blank, so the second input is HIVVC "< 20". Rule 1, range.
  C: { HIVVL_ViralLoadCAPCTM: null, HIVVL_Low_value: '< 20', FinalViralLoadResult: '< 20' },
  // HIVVD 540 and HIVVF 1000. Rule 3: '5401000' is numeric, so capctm.
  D: { HIVVL_ViralLoadResult: '540', HIVVL_Viral: '1000', FinalViralLoadResult: '1000' },
}, ['HIVVL_LIMSRejectionDesc', 'HIVVL_ViralLoadResult', 'HIVVL_ViralLoadCAPCTM', 'HIVVL_Low_value', 'HIVVL_Viral', 'HIVVL_VRLogValue', 'FinalViralLoadResult', 'AgeInYears']),
  setup: WIRING_ROWS });

suites.push(wiringSuite('wiring-info', vlInfoSql(MOZ_CODES), {
  E: { ReasonForTest: 'Routine' },
  F: { ReasonForTest: 'Reason Not Specified' },
}, ['LocalDeColheita', 'ReasonForTest', 'DateTimeStamp']));
```

- [ ] **Step 2: Run it and see it fail**

Run: `node packs/vl-reports-mz/check-vl-functions.mjs`
Expected: exits 1. `wiring-results` reports the order failure and
`raw stand-in columns still present: HIVVD_LIMSRptResult, ...`. `wiring-info` reports
`request E ReasonForTest: expected "Routine", got undefined`.

- [ ] **Step 3: Change `vlResultSql`**

Replace the whole function with:

```js
export function vlResultSql(codes) {
  const r = codes.result;
  const merged = (alias) => resultMergeSql(reportedSql(alias), `${alias}.coded_value`);
  // Two lateral subqueries work out the merge once per slot, then FinalViralLoadResult's second
  // input: the first of HIVVR, HIVVC, HIVVF with a reported value, else HIVVR. v1 tests
  // LEN(LIMSRptResult) > 0, and LEN ignores trailing spaces, as blankSql does.
  return `with ${attrCte},
${vlCodedCte}
select
  lr.request_id as "RequestID",
  lr.obr_set_id as "OBRSetID",
  lr.panel_code as "LIMSPanelCode",
  lr.panel_desc as "LIMSPanelDesc",
  dr.issued as "HIVVL_AuthorisedDateTime",
  lr.rejection_code as "HIVVL_LIMSRejectionCode",
  lr.rejection_reason as "HIVVL_LIMSRejectionDesc",
  vlm.vd as "HIVVL_ViralLoadResult",
  vlm.vr as "HIVVL_ViralLoadCAPCTM",
  vlm.vc as "HIVVL_Low_value",
  vlm.vf as "HIVVL_Viral",
  ${rpt('hivrl')} as "HIVVL_VRLogValue",
  ${finalResultSql('vlm.vd', 'vlc.capctm')} as "FinalViralLoadResult",
  lr.age_years as "AgeInYears",
  lr.age_days as "AgeInDays",
  p.sex as "HL7SexCode",
  dr.effective as "SpecimenDatetime",
  lr.authored_at as "RegisteredDateTime",
  s.received_time as "ReceivedDateTime",
  dr.issued as "AuthorisedDateTime",
  lr.analysis_at as "AnalysisDateTime",
  lr.rejection_code as "LIMSRejectionCode",
  lr.rejection_reason as "LIMSRejectionDesc",
${facilityBlock('testingProvinceName')}
${sharedTail()}
from lab_requests lr
${commonJoins}
${obsJoin('hivvd', r.HIVVD)}
${obsJoin('hivvr', r.HIVVR)}
${obsJoin('hivvc', r.HIVVC)}
${obsJoin('hivvf', r.HIVVF)}
${obsJoin('hivrl', r.HIVRL)}
cross join lateral (select
  ${merged('hivvd')} as vd,
  ${merged('hivvr')} as vr,
  ${merged('hivvc')} as vc,
  ${merged('hivvf')} as vf
) vlm
cross join lateral (select case
  when not ${blankSql(reportedSql('hivvr'))} then vlm.vr
  when not ${blankSql(reportedSql('hivvc'))} then vlm.vc
  when not ${blankSql(reportedSql('hivvf'))} then vlm.vf
  else vlm.vr end as capctm
) vlc
${where(codes.resultPanel)}`;
}
```

- [ ] **Step 4: Change `vlInfoSql`**

Replace the line

```js
  ${rpt('motivo')} as "ESCOL_LIMSRptResult",
```

with

```js
  ${reasonForTestSql(rpt('motivo'))} as "ReasonForTest",
```

v1 passes `motivo.LIMSRptResult`. This pack maps v1's `LIMSRptResult` to `rpt()` for every info
column, so the reason uses `rpt()` too.

- [ ] **Step 5: Update the file header comment**

Replace lines 7-10 of `vl-queries.mjs`:

```js
// Column names and order follow v1. A v1 column with no CE source is NULL under its v1 name.
// The columns v1 computed with GetReasonForTest, ViralLoadResultMerge and ViralLoadFinalResult
// are ported as SQL expressions below. The merge reads the coded-result descriptions from the
// pack's value set urn:openldr:mz:vl-coded-results.
```

- [ ] **Step 6: Run it and see it pass**

Run: `node packs/vl-reports-mz/check-vl-functions.mjs`
Expected: `76 checks, 0 failed`, exit 0.

- [ ] **Step 7: Check the SQL against CE's banned words**

Run:

```bash
node -e "import('./packs/vl-reports-mz/vl-queries.mjs').then(({vlResultSql,vlInfoSql,MOZ_CODES})=>{for(const s of [vlResultSql(MOZ_CODES),vlInfoSql(MOZ_CODES)]){const t=s.replace(/--[^\n]*/g,' ').replace(/'(?:[^']|'')*'/g,\"''\");const m=t.match(/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i);console.log(m?'BANNED '+m[0]:'ok')}})"
```

Expected: `ok` twice. This copies the regex at `sql-runner.ts:28`. The CE install in Task 7 is the
real test.

- [ ] **Step 8: Commit**

```bash
git branch --show-current
git add packs/vl-reports-mz/check-vl-functions.mjs packs/vl-reports-mz/vl-queries.mjs
git commit -m "feat(packs): VL info and VL results return v1's six function columns"
```

---

### Task 5: Build the coded-results terminology and version 0.5.3

**Files:**
- Modify: `packs/vl-reports-mz/build.mjs`

**Interfaces:**
- Consumes: `VL_CODED_SYSTEM`, `VL_CODED_VALUE_SET` (Task 2), `pickCodedResultDisplays` (Task 3).
- Produces: `dist/pack.json` with 11 steps; `build-summary.json` gains `read.limsCodedValues` and
  `vlCodedResults`.

- [ ] **Step 1: Imports**

Replace line 19:

```js
import { vlQueryFile, MOZ_CODES, VL_CODED_SYSTEM, VL_CODED_VALUE_SET } from './vl-queries.mjs';
import { pickCodedResultDisplays } from './vl-coded-results.mjs';
```

- [ ] **Step 2: Read the coded values**

Change `let labs, pocs, links, facilities;` to
`let labs, pocs, links, facilities, codedValues;`. Inside the `try`, after the `facilities` query,
add:

```js
    // The panels v1's ViralLoadResultMerge reads.
    codedValues = (await pool.request().query(
      "SELECT LIMSPanelCode, LIMSCodedValue, Description FROM dbo.LIMSCodedValues WHERE LIMSPanelCode IN ('HIVVL', 'VIRAL')",
    )).recordset;
```

- [ ] **Step 3: Summary fields**

In `summary`, add `limsCodedValues: codedValues.length` to `read`, and add a key after
`linkValueSet`:

```js
    vlCodedResults: { concepts: 0, choices: [], left_out: [] },
```

- [ ] **Step 4: Pick the displays**

After the `summary.linkValueSet.concepts = linkRows.length;` line, add:

```js
  // ---- Coded VL results: one description per code. See vl-coded-results.mjs for the rule. ----
  const coded = pickCodedResultDisplays(codedValues.map((r) => ({
    panel: r.LIMSPanelCode, code: r.LIMSCodedValue, description: r.Description,
  })));
  summary.vlCodedResults.concepts = coded.concepts.length;
  summary.vlCodedResults.choices = coded.choices;
  summary.vlCodedResults.left_out = coded.leftOut;
```

- [ ] **Step 5: The two steps**

After the `LINK_DESCRIPTION` constant, add:

```js
  const VL_CODED_TITLE = 'Mozambique viral load coded results';
  const VL_CODED_DESCRIPTION = 'Viral load result codes and their descriptions, from the v1 dictionary list LIMSCodedValues (panels HIVVL and VIRAL). "VL results" uses it to show a coded result as text, as v1 did.';
```

In `steps`, after the link-sites `value-set` step, add:

```js
    { kind: 'code-system', resource: codeSystem(VL_CODED_SYSTEM, 'MozVlCodedResults', VL_CODED_TITLE, VL_CODED_DESCRIPTION, coded.concepts) },
    { kind: 'value-set', resource: valueSet(VL_CODED_VALUE_SET, 'MozVlCodedResults', VL_CODED_TITLE, VL_CODED_DESCRIPTION, VL_CODED_SYSTEM, coded.concepts) },
```

- [ ] **Step 6: Left-out lines, console output, version, header**

In `leftOut`, add after the link value set line:

```js
    ...summary.vlCodedResults.left_out.map((r) => `VL coded results, ${r.key}: ${r.reason}`),
```

In the final `console.log` object, add:

```js
    vlCodedResults: { concepts: summary.vlCodedResults.concepts, choices: summary.vlCodedResults.choices.map((c) => `${c.code}: ${c.chosen}`), leftOut: summary.vlCodedResults.left_out.length },
```

Change `version: '0.5.2'` to `version: '0.5.3'`. In the header comment, change
`nine steps, in install order` to `eleven steps, in install order`.

- [ ] **Step 7: Build**

Run: `node packs/vl-reports-mz/build.mjs`

Expected in the printed JSON:
- `read.limsCodedValues: 39`
- `steps`: 11 entries; the 5th and 6th are `code-system` and `value-set` labelled `MozVlCodedResults`
- `vlCodedResults.concepts: 26`
- `vlCodedResults.choices`: `["INVAL: INVAL", "LDL: Target not detected", "NDET: NOT DETECTED", "NEG: Negative", "POS: POS"]`
- `vlCodedResults.leftOut: 0`

If `choices` differs, the dictionary changed. Stop and report it.

- [ ] **Step 8: Check the built pack**

Run:

```bash
node -e "const p=require('./packs/vl-reports-mz/dist/pack.json');const m=require('./packs/vl-reports-mz/dist/manifest.json');const q=p.steps.at(-1).file.queries;console.log(m.version,p.steps.length,q.map(x=>x.name).join(' | '));for(const x of q.slice(0,2))console.log(x.name,/FinalViralLoadResult|ReasonForTest/.test(x.sql),/_LIMSCodedValue|ESCOL_LIMSRptResult/.test(x.sql))"
node packs/vl-reports-mz/check-vl-functions.mjs
```

Expected: `0.5.3 11 VL info | VL results | Mozambique facilities (v1 layout)`, then
`VL info true false` and `VL results true false`, then `76 checks, 0 failed`.

- [ ] **Step 9: Commit**

```bash
git branch --show-current
git add packs/vl-reports-mz/build.mjs
git commit -m "feat(packs): vl-reports-mz 0.5.3 ships the coded VL result descriptions"
```

---

### Task 6: PACK.md, README.md, QUESTIONS-FOR-MZ.md

**Files:**
- Modify: `packs/vl-reports-mz/PACK.md`
- Modify: `packs/vl-reports-mz/README.md`
- Modify: `packs/vl-reports-mz/QUESTIONS-FOR-MZ.md`

No test cycle. Rebuild after editing PACK.md, because `build.mjs` copies it into the manifest
readme.

- [ ] **Step 1: PACK.md, "What it installs"**

Replace the numbered list with:

```markdown
1. Code system and value set for the POC sites: `urn:openldr:mz:poc-sites`.
2. Code system and value set for the link sites: `urn:openldr:mz:link-sites`.
3. Code system and value set for the viral load result codes: `urn:openldr:mz:vl-coded-results`.
   26 codes from the v1 dictionary list `LIMSCodedValues`, each with one description.
4. The lab register `urn:openldr:mz:laboratories` (laboratories and POC sites), code `MZLABS`.
5. The health facility register `urn:openldr:mz:facilities`, code `MZFAC`. It has 2,830
   facilities from the v1 dictionary view `viewFacilities`, keyed on the DISA facility code.
6. Link-matching against the facility register.
7. Link-matching against the lab register.
8. The queries "VL info", "VL results" and "Mozambique facilities (v1 layout)".
```

- [ ] **Step 2: PACK.md, replace "## Columns not provided yet" (the whole section) with**

```markdown
## Columns v1 computed with functions

v1 worked out six columns with SQL functions. The pack does the same work in each query.

- `ReasonForTest` (VL info): the reason for the test, in English. `Rotina` reads `Routine`,
  `Nao Prenchido` reads `Not Specified`, and an empty reason reads `Reason Not Specified`.
- `HIVVL_ViralLoadResult`, `HIVVL_ViralLoadCAPCTM`, `HIVVL_Low_value`, `HIVVL_Viral` (VL results):
  the reported value. When only a code was reported, the code's description, such as
  `Target not detected` for `LDL`. A code that is not in the pack's list gives an empty value, as
  in v1.
- `FinalViralLoadResult` (VL results): one result per request, by v1's rules. It is a number, a
  range such as `< 20`, `INDETECTAVEL`, or empty.

Where v1's rules look odd, the pack still follows them:

- A plain number in `HIVVL_ViralLoadResult`, with the other three empty, gives `INDETECTAVEL`.
- When both inputs are set, v1 tests whether the two joined together are a number.

Some codes have more than one description in the v1 dictionary. The pack keeps the most frequent
one: `LDL` reads `Target not detected`, `NEG` reads `Negative`, `NDET` reads `NOT DETECTED`,
`POS` reads `POS`, and `INVAL` reads `INVAL`. v1 picks one with no fixed order.
```

- [ ] **Step 3: PACK.md, "How the values differ from v1"**

Add after the bullet about the reported value:

```markdown
- `FinalViralLoadResult` keeps CE's full numeric value too.
- v1 stops with an error when a request's only result is the code `I` (`Indeterminado`). The pack
  gives an empty `FinalViralLoadResult` for that request.
```

- [ ] **Step 4: PACK.md, "Known limits"**

Add:

```markdown
- v1 counts some odd text as a number, such as a lone `+`, `$` or `.`. The pack does not. No real
  viral load result looks like that.
```

- [ ] **Step 5: README.md, "Files" table**

Add two rows after `facility-queries.mjs`:

```markdown
| `vl-coded-results.mjs` | Picks one description per coded VL result for the coded-results code system. |
| `check-vl-functions.mjs` | Runs the ported v1 functions and both VL queries against the dev Postgres over a table of cases. Run it by hand before a release. |
```

- [ ] **Step 6: README.md, "Steps, in install order"**

Replace the list with:

```markdown
1. `code-system` for the POC sites, `urn:openldr:mz:cs:poc-sites`.
2. `value-set` `urn:openldr:mz:poc-sites`.
3. `code-system` for the link sites, `urn:openldr:mz:cs:link-sites`.
4. `value-set` `urn:openldr:mz:link-sites`.
5. `code-system` for the coded VL results, `urn:openldr:mz:cs:vl-coded-results`.
6. `value-set` `urn:openldr:mz:vl-coded-results`. "VL results" reads it.
7. `facility-register` `urn:openldr:mz:laboratories`, code `MZLABS`, with the register CSV.
8. `facility-register` `urn:openldr:mz:facilities`, code `MZFAC`, from `viewFacilities`.
9. `link-matching` against the facility register.
10. `link-matching` against the lab register. Without these two the facility names, provinces
    and districts stay empty in both queries.
11. `custom-queries`: "VL info", "VL results" and "Mozambique facilities (v1 layout)". The
    facilities query reads the warehouse copy of the register, so it needs a CE with the warehouse
    table `facility_registry`. It leaves out retired rows. `DateTimeStamp` is CE's update time.
```

In the paragraph below it, change "The order of steps 7 and 8 matters" to "The order of steps 9
and 10 matters".

- [ ] **Step 7: README.md, replace "## Columns left out: the three missing functions" (the whole
  section, through the "Request to Mozambique" paragraph and the `HIVVL_VRLogValue` line) with**

```markdown
## The three v1 functions

The Mozambique team sent v1's functions on 2026-10-09
(`corlix/fixtures/Mozambique_views/openldr-functions-script.sql`, UTF-16). A custom query is one
SELECT and cannot create SQL functions, so each one is an SQL expression built in `vl-queries.mjs`.
`check-vl-functions.mjs` runs them over a table of cases.

| v1 column | Function | Port |
|---|---|---|
| `ReasonForTest` | `GetReasonForTest(ESCOL)` | `reasonForTestSql` |
| `HIVVL_ViralLoadResult` | `ViralLoadResultMerge(HIVVD)` | `resultMergeSql` |
| `HIVVL_ViralLoadCAPCTM` | `ViralLoadResultMerge(HIVVR)` | `resultMergeSql` |
| `HIVVL_Low_value` | `ViralLoadResultMerge(HIVVC)` | `resultMergeSql` |
| `HIVVL_Viral` | `ViralLoadResultMerge(HIVVF)` | `resultMergeSql` |
| `FinalViralLoadResult` | `ViralLoadFinalResult(...)` | `finalResultSql` |

The port matches v1, including where v1 looks wrong:

- The merge takes the reported value without the coded fallback that `rpt()` adds. Otherwise it
  would never be blank and would return a code where v1 returns its description.
- A code missing from `LIMSCodedValues` gives NULL. v1's `SELECT @x = ... WHERE Code = @code`
  matches no row and leaves `@x` NULL.
- Rule 2 of `ViralLoadFinalResult` has no numeric branch. A plain number in HIVVD with nothing in
  HIVVR, HIVVC or HIVVF gives `INDETECTAVEL`.
- Rule 3 tests whether the two inputs joined together are a number (`'20' || '1000'`).
- Comparisons ignore case and trailing spaces, as SQL Server's default collation does.
- `ISNUMERIC` is a Postgres regular expression: sign, digits with commas, a decimal point, an
  exponent, `$ £ € ¥`, surrounding spaces. SQL Server also accepts a lone `+`, `$` or `.`, and tabs.

One place the port cannot match: v1's error list has `Indeterminado` twice. Rules 2 and 3 test
`(SELECT 1 FROM @errors WHERE Error = x) = 1`, which raises SQL Server error 512 when two rows
match. So v1 fails the whole `viewVL_Result` query on such a request. The port returns NULL.

`LIMSCodedValues` lists five codes with more than one description (`LDL`, `NEG`, `POS`, `INVAL`,
`NDET`). v1 reads them in no fixed order. The build keeps the most frequent description, and on a
tie the first in `(LIMSPanelCode, Description)` order. `build-summary.json` lists each choice
under `vlCodedResults.choices`.

`HIVVL_VRLogValue` needs no function and is returned as v1 did.
```

- [ ] **Step 8: README.md, "HONEST NON-PROOF"**

Replace the bullet `- **Anything the three missing functions do.**` with:

```markdown
- **The ported functions on real results.** `check-vl-functions.mjs` runs every branch on made-up
  cases in real Postgres. It does not show that v1 and the port agree on Mozambique data. That
  needs the sample data (QUESTIONS-FOR-MZ.md, question 4): run "VL results" and v1's
  `viewVL_Result` side by side and compare the six columns request by request.
- **Which description v1 shows for a duplicated code.** The build's pick is a rule, not an
  observation.
```

- [ ] **Step 9: QUESTIONS-FOR-MZ.md, question 2**

In the "Still open" list of question 2, add the `NDET` line after `INVAL`:

```markdown
- `NDET`: "NOT DETECTED" twice, "Not Detected" once
```

Then append to question 2:

```markdown
Until the team answers, the pack keeps the most frequent description, and on a tie the first in
`(LIMSPanelCode, Description)` order.

**Still open (found porting the functions, 2026-10-09):**

- `ViralLoadFinalResult` turns a plain number in HIVVD into `INDETECTAVEL` when HIVVR, HIVVC and
  HIVVF are empty. Its rule for that case has no numeric branch. Is that intended? The pack does
  the same as v1.
- The function's error list has `Indeterminado` twice. For a request whose only result is the code
  `I` (`Indeterminado`), SQL Server raises error 512 and the whole `viewVL_Result` query fails. Has
  the team seen that error? The pack returns an empty `FinalViralLoadResult` there.
- A coded result whose code is not in `LIMSCodedValues` comes out empty in all four merge columns.
  Is that what the team sees in v1?
```

- [ ] **Step 10: Rebuild, run unslop, check for em dashes**

Run:

```bash
node packs/vl-reports-mz/build.mjs
grep -nP "\x{2014}" packs/vl-reports-mz/PACK.md packs/vl-reports-mz/README.md packs/vl-reports-mz/QUESTIONS-FOR-MZ.md
```

Expected: the build prints the same counts as Task 5 Step 7. The grep prints nothing.
Run the `unslop` skill over the three edited sections and fix what it flags.

- [ ] **Step 11: Commit**

```bash
git branch --show-current
git add packs/vl-reports-mz/PACK.md packs/vl-reports-mz/README.md packs/vl-reports-mz/QUESTIONS-FOR-MZ.md
git commit -m "docs(packs): vl-reports-mz 0.5.3 docs for the ported VL functions"
```

---

### Task 7: Sign and install on the dev CE

**Files:** none changed. `dist/` is git-ignored. The signed bundle goes to the session scratchpad.

- [ ] **Step 1: Sign with a CLI run from current CE source**

The main checkout's `packages/cli/dist` is from 2026-08-19 and has no content-pack support. Run
the CLI from source with tsx instead. CE `main` is `97d53fab` or later.

```bash
cd D:/Projects/Repositories/openldr_ce
node_modules/.bin/tsx packages/cli/src/index.ts artifact pack D:/Projects/Repositories/cdr-toolchain/.claude/worktrees/vl-functions-port/packs/vl-reports-mz/dist --key C:/Users/Fredrick/.openldr/keys/content-publisher/publisher.priv --out <scratchpad>/vl-reports-mz-0.5.3
```

Expected: a bundle directory with `manifest.json`, `pack.json` and `publisher.pub`. The manifest's
`publisher.keyFingerprint` is `69b5920dc40a601cd61736e71998f3dcc138407717b5b632ee99a519674314be`.

- [ ] **Step 2: Install over 0.5.2**

```bash
node_modules/.bin/tsx packages/cli/src/index.ts market update <scratchpad>/vl-reports-mz-0.5.3 --dry-run
node_modules/.bin/tsx packages/cli/src/index.ts market update <scratchpad>/vl-reports-mz-0.5.3
```

Expected: the dry run lists 11 steps. The real run installs 0.5.3. If it says the pack is not
installed, stop and report: `market update` refuses that without `--force`, and installing fresh
is the operator's call.

- [ ] **Step 3: The value set reached the warehouse**

```bash
echo "select count(*), count(*) filter (where code = 'LDL' and display = 'Target not detected') from terminology_codes where value_set_url = 'urn:openldr:mz:vl-coded-results';" | docker exec -i openldr_ce-postgres-1 sh -c 'psql -q -At -U "$POSTGRES_USER" -d openldr_target'
```

Expected: `26|1`.

- [ ] **Step 4: Run both queries through CE**

Use the Browser pane on the running studio (dev servers `api` and `studio` in
`.claude/launch.json`). Reports page, run "VL info" and "VL results" with `from` 2026-01-01,
`to` 2026-12-31, `facility` blank.

Expected: both run with no error and return zero rows (the dev warehouse is empty since the
2026-10-08 reset). That proves CE accepted the SQL (install validation) and Postgres planned and
ran it on the real tables. It proves nothing about values.

- [ ] **Step 5: Report to the operator and stop**

Report: commits, the check output (`76 checks, 0 failed`), the build counts, the install output,
the `26|1` count, the zero-row runs. Then the HONEST NON-PROOF list below. Do not merge, publish
or push until the operator says so.

---

### Task 8 (only when the operator says so): merge, publish, push

- [ ] **Step 1: Merge to cdr main**

```bash
cd D:/Projects/Repositories/cdr-toolchain
git checkout main
git merge --no-ff feat/vl-functions-port -m "Merge branch 'feat/vl-functions-port': vl-reports-mz 0.5.3 ports v1's VL functions"
```

- [ ] **Step 2: Publish to the marketplace repo**

Copy `<scratchpad>/vl-reports-mz-0.5.3` to
`D:/Projects/Repositories/openldr-ce-marketplace/bundles/vl-reports-mz-0.5.3`. In `index.json`,
set the `vl-reports-mz` entry's `latestVersion` to `0.5.3` and `path` to
`bundles/vl-reports-mz-0.5.3`, and set `updatedAt` to the current ISO time. Commit:
`feat: publish the vl-reports-mz content pack 0.5.3 (v1's VL functions)`.

- [ ] **Step 3: Push both and confirm**

Push cdr-toolchain `main` and the marketplace repo. Confirm each origin SHA with
`git rev-parse origin/main`. Re-download the bundle from GitHub and check it byte-for-byte against
the scratchpad copy, as for 0.5.2.

- [ ] **Step 4: Remove the worktrees and branches**

Remove `.claude/worktrees/vl-functions-port` and `.claude/worktrees/vl-functions-spec`, and delete
`feat/vl-functions-port` and `docs/vl-functions-spec`.

---

## HONEST NON-PROOF

What this plan does not prove, even when every step passes:

- **v1 and the port agree on real Mozambique results.** There is no Mozambique result data on this
  machine. The check runs made-up cases. The sample data the team promised is the proof.
- **Which description v1 shows for `LDL`, `NEG`, `POS`, `INVAL`, `NDET`.** The pick is a rule.
- **v1's `ISNUMERIC` edge cases.** The regex covers the forms a viral load result takes. It was not
  run side by side with SQL Server.
- **CE's own parameter binding of the new SQL.** The check binds literals. The studio run in
  Task 7 binds real parameters but returns zero rows.
- **Speed on a large warehouse.** The coded lookups read a 26-row CTE, but the query was never run
  on a full lab's data.

## Self-review notes

- Spec coverage: GetReasonForTest (Task 1, 4), ViralLoadResultMerge with no coded fallback and the
  shipped value set (Tasks 2, 3, 5), ViralLoadFinalResult with the three quirks and ISNUMERIC
  (Task 2), column layout with the stand-ins removed (Task 4), check script (Tasks 1-4), PACK.md
  and README.md (Task 6), version 0.5.3 (Task 5). Out of scope items are untouched.
- Check counts: Task 1 = 17 + 10 = 27. Task 2 adds 12 + 26 = 38, so 65. Task 3 adds 3, so 68.
  Task 4 adds (4 + 1) + (2 + 1) = 8, so 76. A different total means a case was added or lost.

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
import {
  isNumericSql, reasonForTestSql, resultMergeSql, finalResultSql, vlCodedCte, VL_CODED_VALUE_SET,
} from './vl-queries.mjs';

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

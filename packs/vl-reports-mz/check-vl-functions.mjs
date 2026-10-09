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

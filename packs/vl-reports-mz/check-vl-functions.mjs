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

import {
  isNumericSql, reasonForTestSql, resultMergeSql, finalResultSql, vlCodedCte, VL_CODED_VALUE_SET,
  MOZ_CODES, vlResultSql, vlInfoSql,
} from './vl-queries.mjs';
import { pickCodedResultDisplays } from './vl-coded-results.mjs';
import { lit, caseSuite, inOrder, runSuites } from '../shared/pg-check.mjs';

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

runSuites(suites);

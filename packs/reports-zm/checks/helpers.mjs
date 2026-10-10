// Group t1: the shared helpers in zm-sql.mjs. Fixture ids start with "t1-".

import { lit, caseSuite } from '../../shared/pg-check.mjs';
import {
  sqlList, inRange, ZM_REGISTER_URL, ATTR_SYSTEM, provinceParam, districtParam, facilityParam, labParam,
  dateParams, requesterJoin, areaFilter, zmIdsCte, genderSql, ageGroupSql, formAnswerSql, labNameSql,
  districtOptionsSql, ssTextKey, dateParamSql, dateTextParamSql, optionalWindowSql,
} from '../zm-sql.mjs';
import { dateErrorSuites } from './epi-fixture.mjs';
import { zmQueryFile } from '../zm-queries.mjs';

const bind = (sqlText, params) => Object.entries(params)
  .reduce((s, [k, v]) => s.replaceAll(`{{param.${k}}}`, `'${v.replace(/'/g, "''")}'`), sqlText);

// A suite that runs `selectSql` over fixture rows and compares the exact row set (no extra rows).
function rowSuite(name, setup, selectSql, expected) {
  const key = (r) => JSON.stringify(r);
  return {
    name,
    setup,
    sql: `select ${lit(name)} || chr(9) || row_to_json(q)::text from (${selectSql}) q;`,
    count: expected.length + 1,
    check(rows) {
      const failures = [];
      if (rows.length !== expected.length) failures.push(`expected ${expected.length} rows, got ${rows.length}`);
      const got = rows.map(key).sort();
      const want = expected.map(key).sort();
      for (const w of want) if (!got.includes(w)) failures.push(`missing row ${w}`);
      for (const g of got) if (!want.includes(g)) failures.push(`unexpected row ${g}`);
      return failures;
    },
  };
}

// A suite with no SQL: a list of [label, failure-or-null] from plain JS.
function jsSuite(name, tests) {
  return {
    name,
    count: tests.length,
    check: () => tests.filter(([, bad]) => bad).map(([label, bad]) => `${label}: ${bad}`),
  };
}
const same = (got, want) => (JSON.stringify(got) === JSON.stringify(want) ? null : `expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);

// A suite over fixture rows: one line per (id, wanted value) pair.
function pairSuite(name, setup, selectSql, wanted) {
  return {
    name,
    setup,
    sql: selectSql,
    count: wanted.length,
    check(rows) {
      return wanted.flatMap(([id, want, label]) => {
        const row = rows.find((r) => r.id === id && (label === undefined || r.code === label));
        const got = row ? row.got : '(no row)';
        return JSON.stringify(got) === JSON.stringify(want) ? [] : [`${id}${label === undefined ? '' : ` ${label}`}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
      });
    },
  };
}

const suites = [];

// ---- genderSql: v1 getGenderFromSexCode (UserDefinedFunction__dbo_getGenderFromSexCode.sql) ----
suites.push(caseSuite('gender', ['sex'], [
  { sex: 'F', expected: 'Female' },
  { sex: 'M', expected: 'Male' },
  { sex: 'N', expected: 'Not Applicable' },
  { sex: 'O', expected: 'Other' },
  { sex: 'U', expected: 'Unknown' },
  { sex: 'I', expected: 'Indeterminate' },
  { sex: 'X', expected: 'Not Specified' },
  { sex: '', expected: 'Not Specified' },
  { sex: null, expected: 'Not Specified' },
  // SQL Server's default collation ignores case and trailing spaces in a comparison.
  { sex: 'f', expected: 'Female' },
  { sex: 'm ', expected: 'Male' },
], genderSql('sex')));

// ---- ageGroupSql: v1 dbo.Agegroup (UserDefinedFunction__dbo_Agegroup.sql). Its 45 to 54 branch
// is labelled "45-49", so ages 50 to 54 never reach "50+". Kept as is (spec ruling 1). ----
const AGE_CASES = [
  [-1, '<1'], [0, '<1'], [1, '1-4'], [4, '1-4'], [5, '5-9'], [9, '5-9'], [10, '10-14'], [14, '10-14'],
  [15, '15-19'], [19, '15-19'], [20, '20-24'], [24, '20-24'], [25, '25-29'], [29, '25-29'], [30, '30-34'],
  [34, '30-34'], [35, '35-39'], [39, '35-39'], [40, '40-44'], [44, '40-44'], [45, '45-49'], [49, '45-49'],
  [50, '45-49'], [54, '45-49'], [55, '50+'], [56, '50+'], [99, '50+'], [null, 'Not Captured'],
];
suites.push(caseSuite('age-group', ['age'],
  AGE_CASES.map(([age, expected]) => ({ age: age === null ? null : String(age), expected })), ageGroupSql('age::int')));

// ---- inRange: a window on the local date, the first ten characters of the stamp ----
suites.push(caseSuite('in-range', ['d'], [
  { d: '2026-04-30T23:59:59.999Z', expected: false },
  { d: '2026-05-01', expected: true },
  { d: '2026-05-01T00:00:00Z', expected: true },
  { d: '2026-05-31T23:59:59.999Z', expected: true },
  { d: '2026-06-01T00:00:00Z', expected: false },
  { d: null, expected: null },
  // Fix round 1: a stamp with no fraction on the last day is in (text compare against 'T23:59:59.999Z' put it out).
  { d: '2026-05-31T23:59:59Z', expected: true },
  { d: '2026-04-30T23:59:59Z', expected: false },
  // The date is the stamp's own local date, not its UTC date.
  { d: '2026-05-01T00:30:00+02:00', expected: true },
  { d: '2026-05-31T23:30:00+02:00', expected: true },
  { d: '2026-06-01T00:30:00+02:00', expected: false },
  { d: '2026-04-30T23:30:00+02:00', expected: false },
  { d: '2026-05-15', expected: true },
], bind(inRange('d'), { from: '2026-05-01', to: '2026-05-31' })));
suites.push(caseSuite('in-range-names', ['d'], [
  { d: '2026-01-15T10:00', expected: true },
  { d: '2026-01-31T23:59:59.999Z', expected: true },
  { d: '2026-02-01', expected: false },
], bind(inRange('d', 'start', 'end'), { start: '2026-01-15', end: '2026-01-31' })));

// A partial or odd stamp is outside every window. As text '2026-07' sorts between '2026-06-01' and '2026-07-31', so a bare text compare
// would put it inside a June to July window; the stamp must start with a full date.
suites.push(caseSuite('in-range-partial-stamps', ['d'], [
  { d: '2026-07', expected: false },
  { d: '2026-06', expected: false },
  { d: '2026', expected: false },
  { d: '2026-07-1', expected: false },
  { d: 'garbage', expected: false },
  { d: '', expected: false },
  { d: '2026-06-01', expected: true },
  { d: '2026-07-31T23:59:59Z', expected: true },
  { d: '2026-07-15', expected: true },
  { d: null, expected: null },
], bind(inRange('d'), { from: '2026-06-01', to: '2026-07-31' })));
suites.push(caseSuite('in-range-partial-stamps-extra-day', ['d'], [
  { d: '2026-08', expected: false },
  { d: '2026-08-01T10:00:00Z', expected: true },
  { d: '2026-08-02', expected: false },
], bind(inRange('d', 'from', 'to', 1), { from: '2026-06-01', to: '2026-07-31' })));

// extraDays moves the end of the window later (the dashboard procedures add a day to their end date).
suites.push(caseSuite('in-range-extra-day', ['d'], [
  { d: '2026-05-31T10:00:00Z', expected: true },
  { d: '2026-06-01T23:30:00+02:00', expected: true },
  { d: '2026-06-02T00:30:00+02:00', expected: false },
  { d: '2026-04-30T23:59:59Z', expected: false },
  { d: null, expected: null },
], bind(inRange('d', 'from', 'to', 1), { from: '2026-05-01', to: '2026-05-31' })));
// A year-end roll: the day after 2026-12-31 is 2027-01-01, and 2027-01-02 is out.
suites.push(caseSuite('in-range-extra-day-year-end', ['d'], [
  { d: '2026-12-31T23:59:59Z', expected: true },
  { d: '2027-01-01T00:30:00+02:00', expected: true },
  { d: '2027-01-01', expected: true },
  { d: '2027-01-02', expected: false },
  { d: '2026-12-01', expected: true },
], bind(inRange('d', 'from', 'to', 1), { from: '2026-12-01', to: '2026-12-31' })));
// Two extra days, and the other parameter names.
suites.push(caseSuite('in-range-extra-days-names', ['d'], [
  { d: '2026-03-01', expected: true },
  { d: '2026-03-02', expected: false },
  { d: '2026-02-28', expected: true },
], bind(inRange('d', 'start', 'end', 2), { start: '2026-02-27', end: '2026-02-27' })));
suites.push(jsSuite('in-range-extra-days-guard', [
  ['0 adds nothing', same(inRange('d', 'from', 'to', 0), inRange('d'))],
  ['negative throws', (() => { try { inRange('d', 'from', 'to', -1); return 'did not throw'; } catch { return null; } })()],
  ['fractional throws', (() => { try { inRange('d', 'from', 'to', 1.5); return 'did not throw'; } catch { return null; } })()],
  ['text throws', (() => { try { inRange('d', 'from', 'to', '1'); return 'did not throw'; } catch { return null; } })()],
]));

// ---- sqlList ----
suites.push(caseSuite('sql-list', ['x'], [
  { x: 'a', expected: true },
  { x: "it's", expected: true },
  { x: 'b', expected: false },
  { x: null, expected: null },
], `x in (${sqlList(['a', "it's"])})`));

// ---- formAnswerSql: the VIRAL form answer by observation code ----
const json = (v) => lit(JSON.stringify(v));
const FORM_ROWS = `insert into lab_requests (id, request_id) values ('t1-r1', 'A'), ('t1-r2', 'B'), ('t1-r3', 'C'), ('t1-r4', 'D');
insert into questionnaire_responses (id, questionnaire, form_code, based_on_id, authored, items) values
  ('t1-q1', 'q', 'hiv_vl_documentation', 't1-r1', '2026-05-01T10:00:00Z', ${json([
    { linkId: 'ARTPR', text: 'ART', answer: [{ valueString: 'Option B+' }] },
    { linkId: 'AGE', answer: [{ valueDecimal: 1.5 }] },
    { linkId: 'WHOLE', answer: [{ valueDecimal: 20 }] },
    { linkId: 'EMPTY', answer: [] },
    { linkId: 'NOANS', text: 'no answer key' },
    { linkId: 'TWO', answer: [{ valueString: 'first' }, { valueString: 'second' }] },
    { linkId: 'BOTH', answer: [{ valueString: 'text', valueDecimal: 2 }] },
    { linkId: 'BLANK', answer: [{ valueString: '' }] },
  ])}),
  ('t1-q2', 'q', 'other_form', 't1-r1', '2026-05-01T10:00:00Z', ${json([{ linkId: 'ARTPR', answer: [{ valueString: 'WRONG FORM' }] }])}),
  ('t1-q3', 'q', 'hiv_vl_documentation', 't1-r2', '2026-05-01T10:00:00Z', ${json([{ linkId: 'ARTPR', answer: [{ valueString: 'Other' }] }])}),
  ('t1-q4a', 'q', 'hiv_vl_documentation', 't1-r4', '2026-05-01T10:00:00Z', ${json([{ linkId: 'ARTPR', answer: [{ valueString: 'old' }] }])}),
  ('t1-q4b', 'q', 'hiv_vl_documentation', 't1-r4', '2026-05-02T10:00:00Z', ${json([{ linkId: 'ARTPR', answer: [{ valueString: 'new' }] }])});`;
const FORM_WANT = [
  ['t1-r1', 'Option B+', 'ARTPR'],  // text answer; the other form's row for this request is ignored
  ['t1-r1', '1.5', 'AGE'],          // decimal answer as text
  ['t1-r1', '20', 'WHOLE'],
  ['t1-r1', null, 'EMPTY'],         // empty answer list
  ['t1-r1', null, 'NOANS'],         // no answer key
  ['t1-r1', 'first', 'TWO'],        // the first answer only
  ['t1-r1', 'text', 'BOTH'],        // text before decimal
  ['t1-r1', '', 'BLANK'],           // an empty text is kept
  ['t1-r1', null, 'MISSING'],       // code not in the form
  ['t1-r2', 'Other', 'ARTPR'],
  ['t1-r3', null, 'ARTPR'],         // request without a response
  ['t1-r4', 'new', 'ARTPR'],        // two responses: the later authored one
];
suites.push(pairSuite('form-answer', FORM_ROWS,
  FORM_WANT.map(([id, , code]) => `select 'form-answer' || chr(9) || json_build_object('id', r.id, 'code', ${lit(code)}, 'got', ${formAnswerSql('r.id', code)})::text from lab_requests r where r.id = ${lit(id)};`).join('\n'),
  FORM_WANT));

// ---- labNameSql (ruling 8): performer_display, else the mapped register name, else the code ----
const LAB_ROWS = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t1-fm1', '', '', 'L2', 'reg-2', 'Mapped Lab', 'Southern', 'Choma'),
  ('t1-fm2', '', '', 'L3', null, null, null, null),
  ('t1-fm3', 'src', 'ps', 'L7', 'reg-7', 'Source Lab', 'Lusaka', 'Lusaka');
insert into diagnostic_reports (id, based_on_id, performer, performer_display, performer_system, source_system) values
  ('t1-d1', 'x', 'L1', 'Lab Display', null, null),
  ('t1-d2', 'x', 'L2', null, null, null),
  ('t1-d3', 'x', 'L3', '', null, null),
  ('t1-d4', 'x', 'L2', '   ', null, null),
  ('t1-d5', 'x', null, null, null, null),
  ('t1-d6', 'x', 'L2', null, 'urn:other', null),
  ('t1-d7', 'x', 'L7', null, 'ps', 'src'),
  ('t1-d8', 'x', 'L7', null, 'ps', null);`;
suites.push(pairSuite('lab-name', LAB_ROWS,
  `select 'lab-name' || chr(9) || json_build_object('id', dr.id, 'got', ${labNameSql('dr')})::text from diagnostic_reports dr;`,
  [
    ['t1-d1', 'Lab Display'],  // display wins
    ['t1-d2', 'Mapped Lab'],   // no display: the mapped register name
    ['t1-d3', 'L3'],           // blank display, and the map row has no register row: the code
    ['t1-d4', 'Mapped Lab'],   // spaces only count as blank
    ['t1-d5', null],           // nothing at all
    ['t1-d6', 'L2'],           // performer system differs from the map row
    ['t1-d7', 'Source Lab'],   // source system and performer system both match
    ['t1-d8', 'L7'],           // source system differs
  ]));

// ---- requesterJoin + areaFilter: mapped rows only, then the optional area parameters ----
const AREA_ROWS = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t1-a-s', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t1-a-l', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('t1-a-k', '', '', 'ZKAFU', 'reg-k', 'Kafue District Hospital', 'Lusaka', 'Kafue'),
  ('t1-a-u', '', '', 'ZUNMP', null, null, null, null);
insert into lab_requests (id, request_id, requester_code) values
  ('t1-ar1', 'R-S', 'ZSOUT'), ('t1-ar2', 'R-L', 'ZLUSA'), ('t1-ar3', 'R-K', 'ZKAFU'), ('t1-ar4', 'R-U', 'ZUNMP'), ('t1-ar5', 'R-N', 'ZNONE');`;
const areaSql = (params) => bind(`select lr.request_id from lab_requests lr ${requesterJoin('lr', 'fmr')} where ${areaFilter({ province: 'province', district: 'district', facility: 'facility' }, 'fmr')}`, params);
const none = { province: '', district: '', facility: '' };
const AREA_CASES = [
  ['all', none, ['R-S', 'R-L', 'R-K']],   // R-U (map row without register row) and R-N (no map row) never appear
  ['province', { ...none, province: 'Lusaka' }, ['R-L', 'R-K']],
  ['district', { ...none, district: 'Kafue' }, ['R-K']],
  ['province and district', { ...none, province: 'Southern', district: 'Kafue' }, []],
  ['facility, other case', { ...none, facility: 'chilenje CLINIC' }, ['R-L']],
  ['facility, trailing spaces', { ...none, facility: 'Chilenje Clinic  ' }, ['R-L']],
  ['facility not in register', { ...none, facility: 'Nowhere' }, []],
  ['all three', { province: 'Lusaka', district: 'Lusaka', facility: 'Chilenje Clinic' }, ['R-L']],
];
// The runner puts every suite's setup in one transaction, so the shared rows go in the first suite only.
AREA_CASES.forEach(([label, params, want], i) => {
  suites.push(rowSuite(`area-${label}`, i === 0 ? AREA_ROWS : '', areaSql(params), want.map((request_id) => ({ request_id }))));
});

suites.push(jsSuite('area-shape', [
  ['no filters is true', same(areaFilter({}), 'true')],
  ['province only', same(areaFilter({ province: 'province' }, 'fmr'), "({{param.province}} = '' or fmr.region = {{param.province}})")],
  ['district only leaves province out', areaFilter({ district: 'district' }).includes('province') ? 'mentions province' : null],
  ['custom ids', areaFilter({ province: 'prov', facility: 'fac' }).includes('{{param.prov}}') && areaFilter({ province: 'prov', facility: 'fac' }).includes('{{param.fac}}') ? null : 'param ids not used'],
]));

// ---- zmIdsCte ----
const ID_ROWS = `insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values
  ('t1-i1', 't1-x1', ${lit(ATTR_SYSTEM)}, 'reference-numbers', 'REF-1'),
  ('t1-i2', 't1-x1', ${lit(ATTR_SYSTEM)}, 'unique-id', 'UID-1'),
  ('t1-i3', 't1-x2', ${lit(ATTR_SYSTEM)}, 'reference-numbers', 'REF-2'),
  ('t1-i4', 't1-x3', ${lit(ATTR_SYSTEM)}, 'unique-id', 'UID-3'),
  ('t1-i5', 't1-x4', 'urn:other', 'unique-id', 'WRONG SYSTEM'),
  ('t1-i6', 't1-x4', ${lit(ATTR_SYSTEM)}, 'other-code', 'WRONG CODE');`;
suites.push(rowSuite('zm-ids', ID_ROWS, `with ${zmIdsCte('ids')} select * from ids`, [
  { lab_request_id: 't1-x1', reference_numbers: 'REF-1', unique_id: 'UID-1' },
  { lab_request_id: 't1-x2', reference_numbers: 'REF-2', unique_id: null },
  { lab_request_id: 't1-x3', reference_numbers: null, unique_id: 'UID-3' },
]));

// ---- parameters ----
const REGISTRY_ROWS = `insert into facility_registry (id, facility_code, name, facility_system, region, district, register_state) values
  ('t1-fr1', '1', 'A', ${lit(ZM_REGISTER_URL)}, 'Southern', 'Choma', 'in_register'),
  ('t1-fr2', '2', 'B', ${lit(ZM_REGISTER_URL)}, 'Lusaka', 'Lusaka', 'in_register'),
  ('t1-fr3', '3', 'C', ${lit(ZM_REGISTER_URL)}, 'Lusaka', 'Kafue', 'in_register'),
  ('t1-fr4', '4', 'D', ${lit(ZM_REGISTER_URL)}, 'Western', 'Mongu', 'dropped'),
  ('t1-fr5', '5', 'E', 'urn:example:other', 'Maputo', 'Matola', 'in_register'),
  ('t1-fr6', '6', 'F', ${lit(ZM_REGISTER_URL)}, 'Lusaka', null, 'in_register'),
  ('t1-fr7', '7', 'G', ${lit(ZM_REGISTER_URL)}, 'Lusaka', '', 'in_register');`;
// The picker reads the first column of each row, in order: distinct in-register ZMFAC districts, sorted.
suites.push({
  name: 'district-options',
  setup: REGISTRY_ROWS,
  sql: `select 'district-options' || chr(9) || json_build_object('v', q.district)::text from (${districtOptionsSql(ZM_REGISTER_URL)}) q;`,
  count: 1,
  check(rows) {
    const bad = same(rows.map((r) => r.v), ['Choma', 'Kafue', 'Lusaka']);
    return bad ? [bad] : [];
  },
});

suites.push(jsSuite('params-shape', [
  ['province defaults', same(Object.keys(provinceParam()), ['id', 'label', 'type', 'required', 'optionsSql'])],
  ['province values', same([provinceParam().id, provinceParam().label, provinceParam().type, provinceParam().required], ['province', 'Province (blank for all)', 'select', false])],
  ['province id and required', same([provinceParam('prov', true).id, provinceParam('prov', true).required], ['prov', true])],
  ['district is a select', same([districtParam().id, districtParam().type, districtParam().required], ['district', 'select', false])],
  ['district id and required', same([districtParam('d2', true).id, districtParam('d2', true).required], ['d2', true])],
  ['district options', same(districtParam().optionsSql, districtOptionsSql(ZM_REGISTER_URL))],
  ['facility is optional text', same([facilityParam().id, facilityParam().type, facilityParam().required], ['facility', 'text', false])],
  ['laboratory is optional text', same([labParam().id, labParam().type, labParam().required], ['laboratory', 'text', false])],
  ['dates default required', same(dateParams().map((p) => [p.id, p.type, p.required]), [['from', 'text', true], ['to', 'text', true]])],
  ['dates optional', same(dateParams(false).map((p) => p.required), [false, false])],
]));

// ---- ssTextKey: SQL Server's text order. The default is the Windows word sort of Latin1_General_CI_AS, the collation of v1's OpenLDRData
// text columns (and of nvarchar); { sqlCollation: true } is the SQL_Latin1_General_CP1_CI_AS order of a server-default column. The expected
// orders were read from SQL Server itself (ORDER BY on the probe list for each collation, and the same with the SQL collation), so a change
// of the character tables shows here. ----
const SS_WORDS = ['Zed', 'oneil', "o'neil", 'é', 'e', 'coop', 'co-op', 'abc', 'ab', 'a_b', 'a-b', 'a b', 'a', '2500', '150', '1,000', '_x', '>10000000', '<20 copies/mL'];
// SQL collation (sqlCollation: true): '<' (0x3C) sorts before the digits and before '_'; the comma sorts before a digit; punctuation before letters.
const SS_VARCHAR_ORDER = ['<20 copies/mL', '>10000000', '_x', '1,000', '150', '2500', 'a', 'a b', 'a-b', 'a_b', 'ab', 'abc', 'co-op', 'coop', 'e', 'é', "o'neil", 'oneil', 'Zed'];
// Word sort (the default): the hyphen and the apostrophe do not count, so 'a-b', 'co-op' and "o'neil" tie with 'ab', 'coop' and 'oneil' (left
// out of the list, tested as ties below; SQL Server puts the plain text first, the key cannot); '_' sorts before '<'.
const SS_NVARCHAR_WORDS = SS_WORDS.filter((w) => !['a-b', 'co-op', "o'neil"].includes(w));
const SS_NVARCHAR_ORDER = ['_x', '<20 copies/mL', '>10000000', '1,000', '150', '2500', 'a', 'a b', 'a_b', 'ab', 'abc', 'coop', 'e', 'é', 'oneil', 'Zed'];

function ssOrderSuite(name, words, opts, expectedOrder) {
  return {
    name,
    sql: `select ${lit(name)} || chr(9) || json_build_object('got', (select json_agg(w order by ${ssTextKey('w', opts)} collate "C", w collate "C") from (values ${words.map((w) => `(${lit(w)})`).join(', ')}) as t(w)))::text;`,
    count: 1,
    check(rows) {
      const got = rows[0]?.got;
      return JSON.stringify(got) === JSON.stringify(expectedOrder) ? [] : [`expected ${JSON.stringify(expectedOrder)}, got ${JSON.stringify(got)}`];
    },
  };
}
suites.push(ssOrderSuite('ss-order-sql-collation', SS_WORDS, { sqlCollation: true }, SS_VARCHAR_ORDER));
suites.push(ssOrderSuite('ss-order-word-sort', SS_NVARCHAR_WORDS, {}, SS_NVARCHAR_ORDER));

// Ties: trailing spaces and case for both; the hyphen and the apostrophe only in the word sort.
const TIE_CASES = [
  { a: 'abc', b: 'ABC  ', sqlCollation: true, expected: true },
  { a: 'abc', b: 'abd', sqlCollation: true, expected: false },
  { a: 'a-b', b: 'ab', sqlCollation: true, expected: false },
  { a: 'a-b', b: 'ab', sqlCollation: false, expected: true },
  { a: "o'neil", b: 'oneil', sqlCollation: false, expected: true },
  { a: 'co-op', b: 'coop', sqlCollation: false, expected: true },
  { a: 'a b', b: 'ab', sqlCollation: false, expected: false },
  { a: 'a_b', b: 'ab', sqlCollation: false, expected: false },
];
suites.push({
  name: 'ss-ties',
  sql: `select 'ss-ties' || chr(9) || json_build_object('got', json_build_array(${TIE_CASES.map((c) => `${ssTextKey(lit(c.a), { sqlCollation: c.sqlCollation })} = ${ssTextKey(lit(c.b), { sqlCollation: c.sqlCollation })}`).join(', ')}))::text;`,
  count: 1,
  check(rows) {
    const got = rows[0]?.got ?? [];
    return TIE_CASES.flatMap((c, i) => (got[i] === c.expected ? [] : [`${JSON.stringify([c.a, c.b, c.sqlCollation])}: expected ${c.expected}, got ${got[i]}`]));
  },
});

// The larger of two texts, as SQL Server's MAX picks (measured on Latin1_General_CI_AS, both word sort and, for the pairs below, the SQL collation; the
// pairs have no hyphen), with the key then the plain text as the tie-break.
const MAX_PAIRS = [
  ['<20 copies/mL', '2500', '2500'], ['< 20', '150', '150'], ['>10000000', '2500', '2500'],
  ['120', '110', '120'], ['99', '100', '99'], ['abc', 'ABD', 'ABD'], ['abc', '2500', 'abc'],
];
const maxOf = (opts) => `(select (array_agg(w order by ${ssTextKey('w', opts)} collate "C" desc, w collate "C" desc))[1] from (values (x), (y)) as t(w))`;
suites.push(caseSuite('ss-max-pair', ['x', 'y'], MAX_PAIRS.map(([x, y, expected]) => ({ x, y, expected })), maxOf({})));
suites.push(caseSuite('ss-max-pair-sql-collation', ['x', 'y'], MAX_PAIRS.map(([x, y, expected]) => ({ x, y, expected })), maxOf({ sqlCollation: true })));
// Where the two collations part: the hyphen does not count in the word sort ('a-c' is 'ac', above 'ab'); in the SQL collation it sorts as a mark.
suites.push(caseSuite('ss-max-pair-word-sort', ['x', 'y'], [
  { x: 'a-c', y: 'ab', expected: 'a-c' }, { x: 'a_', y: 'ab', expected: 'ab' }, { x: '<20', y: '_1', expected: '<20' },
], maxOf({})));
suites.push(caseSuite('ss-max-pair-sql-collation-marks', ['x', 'y'], [
  { x: 'a-c', y: 'ab', expected: 'ab' }, { x: 'a_', y: 'ab', expected: 'ab' }, { x: '<20', y: '_1', expected: '_1' },
], maxOf({ sqlCollation: true })));

// ---- Group t30c (Task 30c): the shared fixes that reviewers deferred. Fixture ids start with "t30c-". ----
const suites30c = [];

// Item A: dateParamSql / dateTextParamSql. A value is four digits, two and two and a real date: every month's length, February in leap and
// other years (1900 and 2100 are not leap years, 2000 and 2400 are), year 0000 (a Postgres date error of its own), and the forms that look
// like dates but are not. The expected answer for the sweep comes from JavaScript's own calendar, not from the SQL under test.
// The suite runs `select <expr>` in a plpgsql block and keeps either 'ok <value>' or the error text.
function evalSuite(name, cases) {
  const call = (expr) => `pg_temp.zm_eval($q$select ${expr}$q$)`;
  return {
    name,
    sql: `create or replace function pg_temp.zm_eval(q text) returns text language plpgsql as $f$ declare r text; begin execute q into r; return 'ok ' || coalesce(r, '(null)'); exception when others then return sqlerrm; end $f$;
select ${lit(name)} || chr(9) || json_build_object('got', (select json_agg(v.x order by v.i) from (values ${cases.map((c, i) => `(${i}, ${call(bind(c.expr, c.params))})`).join(',\n  ')}) as v(i, x)))::text;`,
    count: cases.length,
    check(rows) {
      const got = rows[0]?.got ?? [];
      return cases.flatMap((c, i) => {
        const ok = typeof c.want === 'string' && c.want.startsWith('ok ') ? got[i] === c.want : typeof got[i] === 'string' && got[i].includes(c.want);
        return ok ? [] : [`${c.label}: expected ${JSON.stringify(c.want)}, got ${JSON.stringify(got[i])}`];
      });
    },
  };
}
const dateAt = (d, id = 'd') => ({ expr: dateTextParamSql(id), params: { [id]: d }, label: JSON.stringify(d) });
const bad = (id, v) => `${id} must be YYYY-MM-DD, got ${v}`;
const dateCases = [
  // Real dates: both ends of every kind of month, leap days.
  ...['2026-01-01', '2026-01-31', '2026-03-31', '2026-04-30', '2026-12-31', '2024-02-29', '2000-02-29', '2400-02-29', '0001-01-01', '9999-12-31']
    .map((d) => ({ ...dateAt(d), want: `ok ${d}` })),
  // Not dates, or not in this format.
  ...['09/10/2026', 'yesterday', '', ' ', 'now', '2026-5-1', '2026-05-1', '26-05-01', '20260501', '2026/05/01', '2026-05-01T00:00', '2026-05-01 00:00',
    ' 2026-05-01', '2026-05-01 ', '2026-05-01\n', '\n2026-05-01', '2026-05-011', '12026-05-01', '2026-13-01', '2026-00-10', '2026-05-00', '2026-05-32',
    '2026-02-29', '2026-02-30', '2026-02-31', '2026-04-31', '2026-06-31', '2026-09-31', '2026-11-31', '1900-02-29', '2100-02-29', '0000-01-01', '0000-12-31',
    '2026-05-01+02', 'null', 'NULL', '٢٠٢٦-٠٥-٠١']
    .map((d) => ({ ...dateAt(d), want: bad('d', d) })),
];
// The sweep: 8 years x 12 months x 7 days against the JavaScript calendar.
const sweep = [];
for (const y of [1900, 1999, 2000, 2023, 2024, 2026, 2100, 2400]) {
  for (let m = 1; m <= 12; m += 1) {
    for (const day of [0, 1, 28, 29, 30, 31, 32]) {
      const text = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const t = new Date(Date.UTC(y, m - 1, day));
      const real = day >= 1 && t.getUTCMonth() === m - 1 && t.getUTCDate() === day;
      sweep.push({ ...dateAt(text), want: real ? `ok ${text}` : bad('d', text) });
    }
  }
}
suites30c.push(evalSuite('date-param-values', dateCases));
suites30c.push(evalSuite('date-param-sweep', sweep));

// The optional form: a blank value is NULL and raises nothing; a bad one still raises. The required form raises for a blank.
const optionalDate = (d) => ({ expr: dateTextParamSql('d', { optional: true }), params: { d }, label: `optional ${JSON.stringify(d)}` });
suites30c.push(evalSuite('date-param-optional', [
  { ...optionalDate(''), want: 'ok (null)' },
  { ...optionalDate('2026-05-01'), want: 'ok 2026-05-01' },
  { ...optionalDate('yesterday'), want: bad('d', 'yesterday') },
  { ...optionalDate(' '), want: bad('d', ' ') },
  { ...optionalDate('09/10/2026'), want: bad('d', '09/10/2026') },
  { ...optionalDate('2026-02-30'), want: bad('d', '2026-02-30') },
  { ...dateAt(''), want: bad('d', '') },
  // The parameter id is in the message, and the date form works in arithmetic.
  { ...dateAt('x', 'start'), want: bad('start', 'x') },
  { expr: `to_char(${dateParamSql('d')} + 1, 'YYYY-MM-DD')`, params: { d: '2026-12-31' }, want: 'ok 2027-01-01', label: 'date + 1' },
  { expr: `to_char(${dateParamSql('d')} + 1, 'YYYY-MM-DD')`, params: { d: '2026-12-32' }, want: bad('d', '2026-12-32'), label: 'date + 1, bad' },
  // A value with a quote (CE doubles it) is shown as it is.
  { ...dateAt("it's"), want: bad('d', "it's") },
]));

// inRange and optionalWindowSql: the window still works for a valid date, a bad date raises, and a blank optional side stays open.
const winCase = (expr, params, want, label) => ({ expr, params, want, label });
suites30c.push(evalSuite('date-window-helpers', [
  winCase(`(${inRange("'2026-05-15'")})::text`, { from: '2026-05-01', to: '2026-05-31' }, 'ok true', 'inRange inside'),
  winCase(`(${inRange("'2026-06-01'")})::text`, { from: '2026-05-01', to: '2026-05-31' }, 'ok false', 'inRange outside'),
  winCase(`(${inRange("'2026-05-15'")})::text`, { from: '09/10/2026', to: '2026-05-31' }, bad('from', '09/10/2026'), 'inRange bad from'),
  winCase(`(${inRange("'2026-05-15'")})::text`, { from: '2026-05-01', to: 'yesterday' }, bad('to', 'yesterday'), 'inRange bad to'),
  winCase(`(${inRange("'2026-06-01'", 'from', 'to', 1)})::text`, { from: '2026-05-01', to: '2026-05-31' }, 'ok true', 'inRange extra day inside'),
  winCase(`(${inRange("'2026-06-01'", 'from', 'to', 1)})::text`, { from: '2026-05-01', to: '2026-05-32' }, bad('to', '2026-05-32'), 'inRange extra day bad to'),
  winCase(`(${optionalWindowSql("'2026-05-15'")})::text`, { from: '', to: '' }, 'ok true', 'optional both blank'),
  winCase(`(${optionalWindowSql("'2026-05-15'")})::text`, { from: '2026-05-10', to: '' }, 'ok true', 'optional from only, inside'),
  winCase(`(${optionalWindowSql("'2026-05-15'")})::text`, { from: '', to: '2026-05-10' }, 'ok false', 'optional to only, outside'),
  winCase(`(${optionalWindowSql("'2026-05-15'")})::text`, { from: '', to: 'yesterday' }, bad('to', 'yesterday'), 'optional bad to'),
  winCase(`(${optionalWindowSql("'2026-05-15'")})::text`, { from: '09/10/2026', to: '' }, bad('from', '09/10/2026'), 'optional bad from'),
]));
// Slice 1's query (VL clients by province) is not in an area file.
suites30c.push(...dateErrorSuites('t30c-slice1', zmQueryFile().queries));

export const groups = [{ name: 't1', suites }, { name: 't30c', suites: suites30c }];

// Checks the reports-zm query SQL against real Postgres, over a table of cases.
//
//   node packs/reports-zm/check-reports-zm.mjs
//
// Uses the shared runner (../shared/pg-check.mjs): temp copies of the warehouse tables in the CE
// dev Postgres container, rolled back. Exits 1 on any mismatch. Run it by hand before a release.

import { lit, caseSuite, inOrder, runSuites } from '../shared/pg-check.mjs';
import { artNumberSql, provinceClientsSql, provinceOptionsSql, ZM_CODES, ZM_REGISTER_URL } from './zm-queries.mjs';

const suites = [];

// v1 sp_GetPreviousVLResultforCohort2x: the ART number from REFNO, else UNIQUEID. HOSPID is not
// sent yet, so its rule never fires (spec section 3).
suites.push(caseSuite('art-number', ['ref', 'uq'], [
  { ref: ',ELABS 12AT.3456', uq: 'U-1', expected: '3456' },
  { ref: ',elabs xt.99', uq: 'U', expected: '99' },
  { ref: 'ART12345,ELABS 99', uq: 'U', expected: '12345' },
  // v1 raises an error here (RIGHT with a negative length). The port gives ''.
  { ref: 'AB,ELABS', uq: 'U', expected: '' },
  // v1's LEN ignores trailing spaces but RIGHT counts them.
  { ref: ',ELABS 12AT.3456 ', uq: 'U', expected: '456 ' },
  { ref: 'ART12345 ,ELABS 99', uq: 'U', expected: '2345 ' },
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

// Requests for the full query. W1-W5, W7, W9 and W11 are in range; W6's facility is unmapped; W8 and W10
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
  ('p10', 'Paul', 'Sakala', 'M'), ('p11', 'Lisa', 'Mumba', 'F');
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
  ('w10', 'V10', 'HIVVL', '2026-04-25T08:00:00Z', 'ZSOUT', 'p10', 44),
  ('w11a', 'V11', 'RTRI', '2026-05-07T08:00:00Z', 'ZSOUT', 'p11', 27),
  ('w11b', 'V11', 'HIVVL', '2026-05-07T09:00:00Z', 'ZSOUT', 'p11', 27);
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
  ('d10', 'w10', 'cancelled', '2026-04-24T08:00:00Z', null),
  ('d11a', 'w11a', 'final', '2026-05-06T08:00:00Z', '2026-05-16T10:00:00Z'),
  ('d11b', 'w11b', 'cancelled', '2026-05-06T09:00:00Z', null);
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
  ('r9', 'w9', 'HIVVL', '<20 copies/mL', null, null, null),
  ('r11', 'w11a', 'HIVVL', null, 50, null, null);
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
  // V11 has two requests with one lab number: a final RTRI with a result, and a cancelled HIVVL.
  // The lab number is in part 1, so part 2 adds no REJECTED row.
  row(...S, 'V11', 'Lisa Mumba', 27, 'Female', '', '2026-05-06T08:00:00Z', '2026-05-07T08:00:00Z', '2026-05-16T10:00:00Z', '50', 'Yes'),
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
      if (rows.length !== expected.length) failures.push(`expected ${expected.length} rows, got ${rows.length}`);
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

// ---- Suites above this line ----

runSuites(suites);

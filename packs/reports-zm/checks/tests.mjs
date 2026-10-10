// Check groups for the tests reports. Each task adds { name, suites } entries to this list.
//
// Groups t5-recency and t5-surveillance: the recency builders (v1 sp_getTestLevelRecency_CIDRZ with
// Table__dbo_Recency.sql, and sp_recency_surveillance with Table__dbo_Recency_Surveillance.sql).
// Fixture ids start with "t5r-" and "t5s-". Lab ids (lr.request_id) start with "T5R-" and "T5S-" unless a case needs
// a lab prefix (ZAP and the like) or a numeric one.
// "v1 line N" below means a line of StoredProcedure__dbo_sp_getTestLevelRecency_CIDRZ.sql (group t5-recency) or
// StoredProcedure__dbo_sp_recency_surveillance.sql (group t5-surveillance).

import { lit, inOrder } from '../../shared/pg-check.mjs';
import { recencyCte, recencySurveillanceCte } from '../zm-sql.mjs';
import { queries } from '../queries/tests.mjs';
import { orderedSuite } from './epi-fixture.mjs';

// ---- Shared fixture builder ----

const num = (v) => (v === null || v === undefined ? 'null' : String(v));
const pad = (n) => String(n).padStart(3, '0');

// What one request row holds unless a case says otherwise.
const REQ = {
  panel: 'RTRI', sex: 'F', years: 30, req: 'ZSOUT',
  authored: '2026-05-02T08:00:00Z', analysis: '2026-05-02T09:00:00Z',
  effective: '2026-05-01T07:00:00Z', issued: '2026-05-10T10:00:00Z',
  status: 'final', performer: 'LUS', display: 'Test Lab', report: true,
  results: [{ obs: 'RTRI', text: 'Recent' }],
};
// A viral load request registered in the window (v1 panel HIVVL).
const vl = (results, extra = {}) => ({ panel: 'HIVVL', authored: '2026-05-03T08:00:00Z', results, ...extra });
const vlNum = (n, obs = 'HIVVL') => vl([{ obs, num: n }]);
const vlText = (t, obs = 'HIVVL') => vl([{ obs, text: t }]);

// The register rows every case reads. ZSOUT and ZLUSA are mapped; ZUNMP is in the map but not in the register;
// ZNORG is in the register with no province; ZPERF is a mapped lab (a performer, for the lab name).
const facilityMapSql = (p) => `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district, national_code) values
  ('${p}-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma', '1001'),
  ('${p}-fm2', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka', '2002'),
  ('${p}-fm3', '', '', 'ZUNMP', null, null, null, null, null),
  ('${p}-fm4', '', '', 'ZNORG', 'reg-n', 'No Province Clinic', null, null, '3003'),
  ('${p}-fm5', '', '', 'ZPERF', 'reg-p', 'Perf Lab Register', 'Southern', 'Choma', '4004'),
  ('${p}-fm6', '', '', 'ZLUS2', 'reg-l2', 'CHILENJE CLINIC ', 'LUSAKA', 'lusaka ', '2003');`;

function makeFixture(p) {
  const patients = [];
  const requests = [];
  const reports = [];
  const results = [];
  let seq = 0;
  return {
    // One lab number with one or more request rows (v1 Requests rows sharing a RequestID, one per OBR set).
    add(labId, reqs) {
      reqs.forEach((o, i) => {
        const r = { ...REQ, ...o };
        const n = ++seq;
        const qid = `${p}-q${pad(n)}`;
        let patientId = null;
        if (r.sex !== undefined && r.sex !== null) {
          patientId = `${p}-p${pad(n)}`;
          patients.push(`(${lit(patientId)}, ${lit('P' + n)}, ${lit(r.sex)})`);
        }
        requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.authored)}, ${lit(r.analysis)}, ${lit(r.req)}, ${lit(patientId)}, ${num(r.years)}, ${r.obr ?? i + 1})`);
        if (r.report) {
          reports.push(`(${lit(`${p}-d${pad(n)}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.effective)}, ${lit(r.issued)}, ${lit(r.performer)}, ${lit(r.display)})`);
        }
        r.results.forEach((x, j) => {
          results.push(`(${lit(`${p}-r${pad(n)}-${j + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${num(x.num)}, ${lit(x.cmp ?? null)})`);
        });
      });
    },
    setup() {
      return `${facilityMapSql(p)}
insert into patients (id, surname, sex) values ${patients.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years, obr_set_id) values ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, performer_display) values ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator) values ${results.join(',\n  ')};`;
    },
  };
}

const bind = (sqlText, params) => Object.entries(params)
  .reduce((s, [k, v]) => s.replaceAll(`{{param.${k}}}`, `'${v.replace(/'/g, "''")}'`), sqlText);

// A suite over `select * from <cte>`: column order, then the exact row set (duplicates counted) with its count.
// `after` is SQL put after the CTE's name, for example a filter.
// `fold` names text columns compared ignoring case and trailing spaces: the builder shows one spelling of a group that
// SQL Server merges, and which one is arbitrary (v1 shows any).
function builderSuite({ name, setup, cteSql, columns, alias, rows, where = '', fold = [] }) {
  const norm = (c, v) => (fold.includes(c) && typeof v === 'string' ? v.trimEnd().toLowerCase() : v);
  const key = (r) => JSON.stringify(columns.map((c) => norm(c, r[c] ?? null)));
  return {
    name,
    setup,
    sql: `with ${cteSql} select ${lit(name)} || chr(9) || row_to_json(q)::text from (select * from ${alias} ${where}) q;`,
    count: rows.length + 1,
    check(got) {
      const failures = [];
      if (got.length !== rows.length) failures.push(`expected ${rows.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), columns));
        if (Object.keys(got[0]).length !== columns.length) failures.push(`expected ${columns.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const tally = (list) => list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
      const have = tally(got.map(key));
      const want = tally(rows.map(key));
      for (const [k, n] of want) if ((have.get(k) ?? 0) !== n) failures.push(`row wanted ${n} time(s), got ${have.get(k) ?? 0}: ${k}`);
      for (const [k, n] of have) if (!want.has(k)) failures.push(`unexpected row (${n}): ${k}`);
      return failures;
    },
  };
}

// A suite on the text of a builder, no database: its name, its window parameters, no banned word.
function shapeSuite(name, build) {
  return {
    name,
    count: 5,
    check() {
      const text = build('anyname');
      const bad = [];
      if (!text.startsWith('anyname as (')) bad.push(`must start with "anyname as (": ${text.slice(0, 30)}`);
      if (build('x').includes('{{param.')) bad.push('no window: must not mention a parameter');
      for (const half of [{ from: 'a' }, { to: 'b' }]) {
        try { build('x', half); bad.push(`half a window ${JSON.stringify(half)} must throw`); } catch { /* expected */ }
      }
      const windowed = build('x', { from: 'a', to: 'b' });
      if (!windowed.includes('{{param.a}}') || !windowed.includes('{{param.b}}')) bad.push('window: must use the given parameter names');
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(text.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      return bad;
    },
  };
}

const WINDOW = { from: '2026-05-01', to: '2026-05-31' };

// ======================================================================
// Group t5-recency: the Recency table
// ======================================================================

const RECENCY_COLUMNS = ['province', 'district', 'facility', 'moh_facility_code', 'ip', 'lab_id', 'gender', 'age_in_years',
  'recency_result', 'baseline_vl_result', 'suppression_status', 'testing_laboratory', 'sample_collection_date',
  'date_registered', 'tested_date', 'reviewed_date', 'reporting_status', 'modality', 'pregnant', 'breastfeeding',
  'recency_test_date'];

// What a default request produces. Written out by hand from the v1 text.
const D = {
  province: 'Southern', district: 'Choma', facility: 'Choma General Hospital',
  moh_facility_code: '1001',                    // the MFL code of the mapped register row
  ip: null,                                     // IPatner has no CE source (ruling 7)
  lab_id: null, gender: 'Female', age_in_years: 30,
  recency_result: 'Recent',                     // v1 line 30-32: the RTRI observation's result
  baseline_vl_result: null, suppression_status: null,
  testing_laboratory: 'Test Lab',               // ruling 8: the report's display
  sample_collection_date: '2026-05-01T07:00:00Z', // v1 line 40: SpecimenDateTime
  date_registered: '2026-05-02T08:00:00Z',      // v1 line 41: RegisteredDateTime
  tested_date: '2026-05-02T09:00:00Z',          // v1 line 42: AnalysisDateTime
  reviewed_date: '2026-05-10T10:00:00Z',        // v1 line 43: AuthorisedDateTime
  reporting_status: 'Recent RTRI',              // v1 line 119: Recent with no suppression status
  modality: null, pregnant: null, breastfeeding: null, recency_test_date: null,
};

// Shortcuts for the wanted columns of a baseline result. Recent with Suppressed is 'Confirmed Long-Term' (line 120),
// with UnSuppressed 'Confirmed Recent' (line 121), with neither 'Recent RTRI' (line 119).
const sup = (t) => ({ baseline_vl_result: t, suppression_status: 'Suppressed', reporting_status: 'Confirmed Long-Term' });
const uns = (t) => ({ baseline_vl_result: t, suppression_status: 'UnSuppressed', reporting_status: 'Confirmed Recent' });
const nos = (t) => ({ baseline_vl_result: t, suppression_status: null, reporting_status: 'Recent RTRI' });
const rtri = (text, extra = []) => ({ results: [{ obs: 'RTRI', text }, ...extra] });

const rc = makeFixture('t5r');
const wantedWindow = [];
const wantedAll = [];
// One lab number. `win` is the list of rows (as changes to D) the window run returns, `all` the rows with no window
// (the same list unless the window changes the answer).
function lab(labId, reqs, win, all = win) {
  rc.add(labId, reqs);
  for (const w of win) wantedWindow.push({ ...D, ...w, lab_id: labId });
  for (const w of all) wantedAll.push({ ...D, ...w, lab_id: labId });
}

// ---- Which rows (v1 lines 58-66) ----
lab('T5R-BASIC', [{}], [{}]);
// Panel and observation compare ignoring case and trailing spaces (SQL Server collation).
lab('T5R-CASE', [{ panel: 'rtri ', results: [{ obs: 'rtri ', text: 'recent ' }] }], [{ recency_result: 'recent ' }]);
// The observation must be one of the five (line 66). XYZ gives no row at all.
lab('T5R-OBS-OTHER', [{ results: [{ obs: 'XYZ', text: 'Recent' }] }], []);
// A lab number with only an HIVVL request has no RTRI request (lines 59-60).
lab('T5R-NORTRI', [vlNum(500)], []);
// An RTRI-panel result with another observation is a row with an empty recency result and no status (lines 30, 119).
lab('T5R-RTRI-HIVVL', [{ results: [{ obs: 'HIVVL', num: 700 }] }], [{ recency_result: null, reporting_status: null }]);
lab('T5R-RTRI-BOTH', [{ results: [{ obs: 'RTRI', text: 'Recent' }, { obs: 'HIVVL', num: 700 }] }],
  [{}, { recency_result: null, reporting_status: null }]);
// No test on the report status: a cancelled report with no issued date still gives a row (reviewed date empty).
lab('T5R-CANCELLED', [{ status: 'cancelled', issued: null }], [{ reviewed_date: null }]);
// No report at all: the dates of the report and the lab name are empty; the analysis date is on the request.
lab('T5R-NOREPORT', [{ report: false }], [{ sample_collection_date: null, reviewed_date: null, testing_laboratory: null }]);

// ---- The recency result and the reporting status (lines 30, 117-122) ----
lab('T5R-LONG', [rtri('Long Term')], [{ recency_result: 'Long Term', reporting_status: 'Long-Term RTRI' }]);
// Long Term ignores the suppression status (line 118 has the check commented out).
lab('T5R-LONG-VL', [rtri('Long Term'), vlNum(1500)], [{ recency_result: 'Long Term', baseline_vl_result: '1500', suppression_status: 'UnSuppressed', reporting_status: 'Long-Term RTRI' }]);
lab('T5R-LONG-UPPER', [rtri('LONG TERM ')], [{ recency_result: 'LONG TERM ', reporting_status: 'Long-Term RTRI' }]);
// Any other recency result has no reporting status (the case has no else).
lab('T5R-INVALID', [rtri('Invalid'), vlNum(500)], [{ recency_result: 'Invalid', baseline_vl_result: '500', suppression_status: 'Suppressed', reporting_status: null }]);
lab('T5R-RECENT-UPPER', [rtri('RECENT')], [{ recency_result: 'RECENT' }]);

// ---- The suppression status (lines 70-74) ----
lab('T5R-VL-500', [{}, vlNum(500)], [sup('500')]);
lab('T5R-VL-1500', [{}, vlNum(1500)], [uns('1500')]);
// The edge: under 1000 is suppressed, 1000 and over is not. A decimal reads as a number (v1 converts to float here).
lab('T5R-VL-1000', [{}, vlNum(1000)], [uns('1000')]);
lab('T5R-VL-999', [{}, vlNum(999)], [sup('999')]);
lab('T5R-VL-999-5', [{}, vlNum(999.5)], [sup('999.5')]);
// The eight suppressed texts (line 71), plus the same text in other case and with a trailing space.
['< 20', '<20 copies/mL', 'Target Not Detected', '<30 copies/mL', '<40 copies/mL', '<400 copies/mL', '<400', '<883 copies/mL']
  .forEach((t, i) => lab(`T5R-SUP-${i}`, [{}, vlText(t)], [sup(t)]));
lab('T5R-SUP-CASE', [{}, vlText('target not DETECTED ')], [sup('target not DETECTED ')]);
// A number with a comparator reads as its text: '< 20' is on the list, '> 10000000' is the unsuppressed text (line 72),
// '> 5' is on neither list.
lab('T5R-CMP-LT', [{}, vl([{ obs: 'HIVVL', num: 20, cmp: '<' }])], [sup('< 20')]);
lab('T5R-CMP-GT', [{}, vl([{ obs: 'HIVVL', num: 10000000, cmp: '>' }])], [uns('> 10000000')]);
lab('T5R-CMP-GT-OTHER', [{}, vl([{ obs: 'HIVVL', num: 5, cmp: '>' }])], [nos('> 5')]);
lab('T5R-TEXT-UNSUP', [{}, vlText('> 10000000')], [uns('> 10000000')]);
// ISNUMERIC accepts commas, an exponent and spaces. Texts on no list stay with no status.
lab('T5R-TEXT-COMMA', [{}, vlText('1,500')], [uns('1,500')]);
lab('T5R-TEXT-EXP', [{}, vlText('1E5')], [uns('1E5')]);
lab('T5R-TEXT-SPACES', [{}, vlText(' 800 ')], [sup(' 800 ')]);
lab('T5R-TEXT-12', [{}, vlText('12')], [sup('12')]);
lab('T5R-TEXT-FAILED', [{}, vlText('Failed')], [nos('Failed')]);
lab('T5R-TEXT-EMPTY', [{}, vlText('')], [nos('')]);
// The observations of a baseline (lines 33-35): HIVVL, HIVVC, HIVVD and HIVTM (the other procedure has no HIVTM).
lab('T5R-OBS-HIVVC', [{}, vlNum(2000, 'HIVVC')], [uns('2000')]);
lab('T5R-OBS-HIVVD', [{}, vlText('<20 copies/mL', 'HIVVD')], [sup('<20 copies/mL')]);
lab('T5R-OBS-HIVTM', [{}, vlText('Target Not Detected', 'HIVTM')], [sup('Target Not Detected')]);
// A HIVVL-panel result with an observation outside the five gives no VL row; one with RTRI gives a row with no baseline.
lab('T5R-VL-OBS-OTHER', [{}, vlNum(500, 'XYZ')], [{}]);
lab('T5R-VL-OBS-RTRI', [{}, vl([{ obs: 'RTRI', text: 'x' }])], [{}]);
lab('T5R-VL-CASE', [{}, vl([{ obs: 'hivvl ', num: 500 }], { panel: 'hivvl ' })], [sup('500')]);
// Rows multiply (the join is on the lab number): two results on one VL request, or two VL requests.
lab('T5R-VL-TWO', [{}, vl([{ obs: 'HIVVL', num: 500 }, { obs: 'HIVVC', num: 1500 }])], [sup('500'), uns('1500')]);
lab('T5R-VL-TWOREQ', [{}, vlNum(500), vl([{ obs: 'RTRI', text: 'x' }])], [sup('500'), {}]);
// The VL request needs no mapped facility (only the RTRI row does).
lab('T5R-VL-UNMAPPED', [{}, vlNum(500, 'HIVVL')].map((r, i) => (i === 1 ? { ...r, req: 'ZUNMP' } : r)), [sup('500')]);
// A VL request in a different panel is no baseline.
lab('T5R-VL-PANEL', [{}, vl([{ obs: 'HIVVL', num: 500 }], { panel: 'HIVPC' })], [{}]);

// ---- Facility (line 112): the RTRI row's facility must have a province ----
lab('T5R-LUSAKA', [{ req: 'ZLUSA' }], [{ province: 'Lusaka', district: 'Lusaka', facility: 'Chilenje Clinic', moh_facility_code: '2002' }]);
lab('T5R-UNMAPPED', [{ req: 'ZUNMP' }], []);
lab('T5R-NOPROVINCE', [{ req: 'ZNORG' }], []);
lab('T5R-NOFAC', [{ req: 'ZNONE' }], []);

// ---- Gender (lines 21-27) and age ----
[['M', 'Male'], ['U', 'Unknown'], ['I', 'Indeterminate'], ['X', 'Missing'], ['m ', 'Male'], ['f', 'Female'], ['', 'Missing']]
  .forEach(([sex, gender], i) => lab(`T5R-SEX-${i}`, [{ sex }], [{ gender }]));
lab('T5R-SEX-NOPATIENT', [{ sex: null }], [{ gender: 'Missing' }]);
lab('T5R-AGE-NULL', [{ years: null }], [{ age_in_years: null }]);

// ---- The testing laboratory (lines 85-100) ----
// The first three characters of the lab number win, whatever the report says. Case is ignored.
[['ZAP', 'Arthur Davison Childrens Hospital Lab'], ['ZKT', 'Kitwe Teaching Hospital Lab'], ['ZUE', 'UTH HAP PCOE Lab'],
  ['ZUA', 'UTH HAP ACOE Lab'], ['ZUL', 'UTH Virology Lab'], ['ZUF', 'UTH Virology Lab'], ['ZCH', 'CHAZ Complex Lab'],
  ['ZFP', 'Levy Mwanawasa UTH Lab'], ['ZBP', 'Kabwe General Hospital Lab'], ['ZCM', 'Choma General Hospital Lab'],
  ['ZMB', 'Mazabuka General Hospital Lab'], ['ZLR', 'Livingstone Teaching Hospital Lab'],
  ['ZLP', 'Livingstone Teaching Hospital Lab']]
  .forEach(([prefix, name]) => lab(`${prefix}-T5R`, [{}], [{ testing_laboratory: name }]));
lab('zkt-T5R-LOWER', [{}], [{ testing_laboratory: 'Kitwe Teaching Hospital Lab' }]);
// Any other prefix: ruling 8. The display, else the register name of the performer, else the performer's code.
lab('ZXX-T5R', [{}], [{ testing_laboratory: 'Test Lab' }]);
lab('T5R-LAB-REGISTER', [{ display: null, performer: 'ZPERF' }], [{ testing_laboratory: 'Perf Lab Register' }]);
lab('T5R-LAB-BLANK', [{ display: '  ', performer: 'ZPERF' }], [{ testing_laboratory: 'Perf Lab Register' }]);
lab('T5R-LAB-CODE', [{ display: null, performer: 'NOPE' }], [{ testing_laboratory: 'NOPE' }]);
lab('T5R-LAB-NONE', [{ display: null, performer: null }], [{ testing_laboratory: null }]);

// ---- The answers (lines 123-148): from RTRI-panel rows of the lab number, with no window ----
lab('T5R-ANS-ALL', [rtri('Recent', [{ obs: 'RTMOD', text: 'Index' }, { obs: 'VPREG', text: 'Yes' }, { obs: 'VBREA', text: 'No' }, { obs: 'RTRTD', text: '01/03/2026' }])],
  [{ modality: 'Index', pregnant: 'Yes', breastfeeding: 'No', recency_test_date: '2026-03-01' }]);
// The test date is a datetime in v1. cdr measured dd/mm/yyyy in the text, so that form (and ISO) becomes 'YYYY-MM-DD';
// anything else, and a date that does not exist, is NULL.
[['01/03/2026', '2026-03-01'], ['31/12/2026', '2026-12-31'], ['29/02/2024', '2024-02-29'], [' 05/06/2026 ', '2026-06-05'],
  ['2026-04-20', '2026-04-20'], [' 2026-04-20', '2026-04-20'], ['29/02/2026', null], ['31/02/2026', null], ['13/13/2026', null],
  ['00/01/2026', null], ['32/01/2026', null], ['2026-02-30', null], ['2026-13-01', null], ['0000-01-01', null], ['1/3/2026', null],
  ['03/01/26', null], ['2026-04-20T10:00:00Z', null], ['garbage', null], ['', null]]
  .forEach(([text, iso], i) => lab(`T5R-ANS-DATE-${i}`, [rtri('Recent', [{ obs: 'RTRTD', text }])], [{ recency_test_date: iso }]));
// Modality is the raw text (line 123), not the six of the surveillance list.
lab('T5R-ANS-MODRAW', [rtri('Recent', [{ obs: 'rtmod ', text: 'Anything' }])], [{ modality: 'Anything' }]);
// VPREG and ARTPR both answer "pregnant" (line 135): two answers give two rows.
lab('T5R-ANS-PREG2', [rtri('Recent', [{ obs: 'VPREG', text: 'Yes' }, { obs: 'ARTPR', text: 'Y' }])],
  [{ pregnant: 'Yes' }, { pregnant: 'Y' }]);
lab('T5R-ANS-ARTPR', [rtri('Recent', [{ obs: 'ARTPR', text: 'N' }])], [{ pregnant: 'N' }]);
// The same question twice (two answers on one request) gives two rows.
lab('T5R-ANS-MOD2', [rtri('Recent', [{ obs: 'RTMOD', text: 'VCT' }, { obs: 'RTMOD', text: 'PITC' }])],
  [{ modality: 'VCT' }, { modality: 'PITC' }]);
// Only RTRI-panel rows answer (lines 128, 134, 140, 146): an RTMOD result on the HIVVL request is no modality.
lab('T5R-ANS-VLPANEL', [{}, vl([{ obs: 'RTMOD', text: 'VCT' }])], [{}]);

// ---- The window (lines 61, 63): registered date, local date ----
// 00:30+02:00 on 05-01 is local May 1: in (UTC would say April 30).
lab('T5R-WIN-IN-TZ1', [{ authored: '2026-05-01T00:30:00+02:00' }], [{ date_registered: '2026-05-01T00:30:00+02:00' }]);
lab('T5R-WIN-IN-LAST', [{ authored: '2026-05-31T23:59:59Z' }], [{ date_registered: '2026-05-31T23:59:59Z' }]);
lab('T5R-WIN-IN-TZ2', [{ authored: '2026-05-31T23:30:00+02:00' }], [{ date_registered: '2026-05-31T23:30:00+02:00' }]);
// 00:30+02:00 on 06-01 is local June 1: out (UTC would say May 31).
lab('T5R-WIN-OUT-TZ', [{ authored: '2026-06-01T00:30:00+02:00' }], [], [{ date_registered: '2026-06-01T00:30:00+02:00' }]);
lab('T5R-WIN-OUT-EARLY', [{ authored: '2026-04-30T23:59:59Z' }], [], [{ date_registered: '2026-04-30T23:59:59Z' }]);
// An RTRI request out of the window drops the lab number, whatever its VL.
lab('T5R-WIN-RTRI-OUT', [{ authored: '2026-04-30T12:00:00Z' }, vlNum(500)], [], [{ date_registered: '2026-04-30T12:00:00Z', ...sup('500') }]);
// A VL request out of the window gives no baseline (line 63 tests every row).
lab('T5R-WIN-VL-OUT', [{}, vlNum(500, 'HIVVL')].map((r, i) => (i === 1 ? { ...r, authored: '2026-06-05T08:00:00Z' } : r)), [{}], [sup('500')]);
// A second RTRI request out of the window is not a row either; the lab number stays through the first.
lab('T5R-WIN-RTRI2-OUT', [{}, { authored: '2026-06-05T08:00:00Z', results: [{ obs: 'RTRI', text: 'Long Term' }] }], [{}],
  [{}, { recency_result: 'Long Term', reporting_status: 'Long-Term RTRI', date_registered: '2026-06-05T08:00:00Z' }]);
// The answers have no window: the modality of a second RTRI request out of the window still shows.
lab('T5R-WIN-ANS-OUT', [{}, { authored: '2026-06-05T08:00:00Z', results: [{ obs: 'RTMOD', text: 'VCT' }] }], [{ modality: 'VCT' }]);

const recencySetup = `${rc.setup()}`;
const recencySuites = [
  builderSuite({ name: 'recency-window', setup: recencySetup, cteSql: bind(recencyCte('rc', { from: 'from', to: 'to' }), WINDOW), columns: RECENCY_COLUMNS, alias: 'rc', rows: wantedWindow }),
  builderSuite({ name: 'recency-all', setup: '', cteSql: recencyCte('rc'), columns: RECENCY_COLUMNS, alias: 'rc', rows: wantedAll }),
  shapeSuite('recency-shape', recencyCte),
];

// ======================================================================
// Group t5-surveillance: the Recency_Surveillance table
// ======================================================================

const SURV_FOLD = ['province', 'district', 'facility', 'recency_result', 'modality'];
const SURV_COLUMNS = ['province', 'district', 'facility', 'implementing_partner', 'age_group', 'gender', 'recency_result',
  'suppression_status', 'reporting_status', 'modality', 'reg_year', 'reg_quarter', 'month', 'week', 'count'];

const rs = makeFixture('t5s');
const SOUTH = { province: 'Southern', district: 'Choma', facility: 'Choma General Hospital' };
const LUSAKA = { province: 'Lusaka', district: 'Lusaka', facility: 'Chilenje Clinic' };
// 2026-05-02 is a Saturday, the 122nd day of 2026. 2026-01-01 is a Thursday, so week 1 is 12-28..01-03 and
// datepart(wk) of May 2 is 18 (the week of Sunday April 26). May 3 starts week 19; May 31 starts week 23.
const D18 = '2026-05-02T08:00:00Z';
const D19 = '2026-05-03T08:00:00Z';
const wantedSurv = [];
// One group of the output: `where` is the place, `g` the group's own columns.
function group(where, g, count) {
  wantedSurv.push({ ...where, implementing_partner: null, reg_year: 2026, reg_quarter: 2, month: 5, modality: null, ...g, count });
}
const G = (age_group, gender, recency_result, suppression_status, reporting_status, week, extra = {}) =>
  ({ age_group, gender, recency_result, suppression_status, reporting_status, week, ...extra });
const withModality = (text) => rtri('Recent', [{ obs: 'RTMOD', text }]);

// ---- Block A (Choma): one lab number per row, and the grouping (lines 186-202) ----
// A1 and A2 share a group. A2 has two baseline results in the same class: counted once (line 186 is a distinct count).
rs.add('T5S-A1', [{ ...withModality('PMTCT'), years: 17, authored: D18 }, vlNum(500)]);
rs.add('T5S-A2', [{ ...withModality('PMTCT'), years: 19, authored: D18 }, vl([{ obs: 'HIVVL', text: 'Target Not Detected' }, { obs: 'HIVVC', num: 300 }])]);
group(SOUTH, G('15 - 19', 'Female', 'Recent', 'Suppressed', 'Confirmed Long-Term', 18, { modality: 'PMTCT' }), 2);
// Age 50 is '<15' (line 25 tests > 50). Long Term has no suppression status (line 176).
rs.add('T5S-A3', [{ ...rtri('Long Term'), years: 50, sex: 'M', authored: D19 }]);
group(SOUTH, G('<15', 'Male', 'Long Term', null, 'Long-Term RTRI', 19), 1);
// Recent and UnSuppressed: Confirmed Recent (line 179). Modality 'Other' is on the list (line 124).
rs.add('T5S-A4', [{ ...withModality('Other'), years: 51, sex: 'U', authored: D19 }, vlNum(1500)]);
group(SOUTH, G('50+', 'Unknown', 'Recent', 'UnSuppressed', 'Confirmed Recent', 19, { modality: 'Other' }), 1);
// No age is 'Missing' (line 26), no patient is gender 'Missing' (line 34), a modality off the list is NULL (line 126).
// Registered 05-04, a Monday: week 19.
rs.add('T5S-A5', [{ ...withModality('Unknown'), years: null, sex: null, authored: '2026-05-04T08:00:00Z' }]);
group(SOUTH, G('Missing', 'Missing', 'Recent', null, 'Recent RTRI', 19), 1);
// Long Term with a high VL: the suppression status shows, the reporting status stays Long-Term RTRI.
rs.add('T5S-A6', [{ ...rtri('Long Term'), years: 28, authored: D19 }, vlNum(1500)]);
group(SOUTH, G('25 - 29', 'Female', 'Long Term', 'UnSuppressed', 'Long-Term RTRI', 19), 1);
// An RTRI-panel result with another observation: empty recency result, no VL row, no status.
rs.add('T5S-A7', [{ results: [{ obs: 'HIVVD', num: 400 }], years: 22, authored: D18 }]);
group(SOUTH, G('20 - 24', 'Female', null, null, null, 18), 1);

// ---- Block B (Lusaka): the age groups (lines 17-28) ----
// Ages 0, 14 and 50 are '<15'; every other group holds the two ends of its range; 51 is '50+'.
const AGE_LABS = [[0, '<15'], [14, '<15'], [50, '<15'], [15, '15 - 19'], [19, '15 - 19'], [20, '20 - 24'], [24, '20 - 24'],
  [25, '25 - 29'], [29, '25 - 29'], [30, '30 - 34'], [34, '30 - 34'], [35, '35 - 39'], [39, '35 - 39'], [40, '40 - 44'],
  [44, '40 - 44'], [45, '45 - 49'], [49, '45 - 49'], [51, '50+']];
AGE_LABS.forEach(([years, band], i) => rs.add(`T5S-B-${i}`, [{ ...rtri('Long Term'), req: 'ZLUSA', years, authored: D19 }]));
for (const band of ['<15', '15 - 19', '20 - 24', '25 - 29', '30 - 34', '35 - 39', '40 - 44', '45 - 49', '50+']) {
  group(LUSAKA, G(band, 'Female', 'Long Term', null, 'Long-Term RTRI', 19), AGE_LABS.filter((a) => a[1] === band).length);
}

// ---- Block C (Lusaka, female 33): the suppressed texts (lines 159-162) ----
const SUP_TEXTS = ['< 20', '<20 copies/mL', 'Target Not Detected', '<30 copies/mL', '<400 copies/mL', '<400', '<40 copies/mL'];
const C = { ...rtri('Recent'), req: 'ZLUSA', years: 33, authored: D18 };
SUP_TEXTS.forEach((t, i) => rs.add(`T5S-C-${i}`, [C, vlText(t)]));
rs.add('T5S-C-CASE', [C, vlText('TARGET NOT DETECTED ')]);
rs.add('T5S-C-CMP', [C, vl([{ obs: 'HIVVL', num: 20, cmp: '<' }])]);      // reads '< 20'
group(LUSAKA, G('30 - 34', 'Female', 'Recent', 'Suppressed', 'Confirmed Long-Term', 18), SUP_TEXTS.length + 2);
// '<883 copies/mL' is not on this list (it is on the other procedure's); 'Failed' and an empty text are on none;
// HIVTM is not an observation of this procedure (line 73), so it gives no baseline row at all.
rs.add('T5S-C-883', [C, vlText('<883 copies/mL')]);
rs.add('T5S-C-FAILED', [C, vlText('Failed')]);
rs.add('T5S-C-EMPTY', [C, vlText('')]);
rs.add('T5S-C-HIVTM', [C, vlText('Target Not Detected', 'HIVTM')]);
group(LUSAKA, G('30 - 34', 'Female', 'Recent', null, 'Recent RTRI', 18), 4);

// ---- Block D (Lusaka, male 33): numbers (lines 162-163) ----
const Dm = { ...rtri('Recent'), req: 'ZLUSA', years: 33, sex: 'M', authored: D18 };
rs.add('T5S-D-999', [Dm, vlNum(999)]);
rs.add('T5S-D-540', [Dm, vlNum(540.5)]);     // v1 CONVERT(int) stops on a decimal; the port reads the number
rs.add('T5S-D-TEXT12', [Dm, vlText('12')]);
group(LUSAKA, G('30 - 34', 'Male', 'Recent', 'Suppressed', 'Confirmed Long-Term', 18), 3);
rs.add('T5S-D-1000', [Dm, vlNum(1000)]);
rs.add('T5S-D-COMMA', [Dm, vlText('1,500')]);
rs.add('T5S-D-GT5', [Dm, vl([{ obs: 'HIVVL', num: 5, cmp: '>' }])]);       // '> 5': any text starting with '>' (line 163)
rs.add('T5S-D-GTTEXT', [Dm, vlText('> 10000000')]);
group(LUSAKA, G('30 - 34', 'Male', 'Recent', 'UnSuppressed', 'Confirmed Recent', 18), 4);

// ---- Block E (Lusaka, female 38): modality (lines 124-127, 152-154) ----
const E = { req: 'ZLUSA', years: 38, authored: D19 };
['PMTCT', 'VCT', 'PITC', 'VMMC', 'Other', 'Index'].forEach((m, i) => rs.add(`T5S-E-${i}`, [{ ...withModality(m), ...E }]));
// RTMOD on both panels: two modality rows for one lab number, counted once.
rs.add('T5S-E-BOTH', [{ ...withModality('VCT'), ...E }, vl([{ obs: 'RTMOD', text: 'VCT' }])]);
// Two RTMOD results on one request: one on the list and one off it give two groups.
rs.add('T5S-E-TWO', [{ ...rtri('Recent', [{ obs: 'RTMOD', text: 'PITC' }, { obs: 'RTMOD', text: 'Foo' }]), ...E }]);
const EG = (modality, count) => group(LUSAKA, G('35 - 39', 'Female', 'Recent', null, 'Recent RTRI', 19, { modality }), count);
EG('PMTCT', 1); EG('VCT', 2); EG('PITC', 2); EG('VMMC', 1); EG('Other', 1); EG('Index', 1); EG(null, 1);

// ---- Block F (Lusaka, age 60): gender (lines 29-35) ----
const F = { ...rtri('Long Term'), req: 'ZLUSA', years: 60, authored: D19 };
[['M ', 'Male'], ['m', 'Male'], ['U', 'Unknown'], ['I', 'Indeterminate'], ['X', 'Missing'], [null, 'Missing']]
  .forEach(([sex, gender], i) => rs.add(`T5S-F-${i}`, [{ ...F, sex }]));
group(LUSAKA, G('50+', 'Male', 'Long Term', null, 'Long-Term RTRI', 19), 2);
group(LUSAKA, G('50+', 'Unknown', 'Long Term', null, 'Long-Term RTRI', 19), 1);
group(LUSAKA, G('50+', 'Indeterminate', 'Long Term', null, 'Long-Term RTRI', 19), 1);
group(LUSAKA, G('50+', 'Missing', 'Long Term', null, 'Long-Term RTRI', 19), 2);

// ---- Block G (Lusaka, male 44): the window (lines 67, 70), local dates ----
const Gm = { req: 'ZLUSA', years: 44, sex: 'M' };
// 00:30+02:00 on 05-01 is local May 1, a Friday: week 18, in the window.
rs.add('T5S-G-1', [{ ...rtri('Long Term'), ...Gm, authored: '2026-05-01T00:30:00+02:00' }]);
group(LUSAKA, G('40 - 44', 'Male', 'Long Term', null, 'Long-Term RTRI', 18), 1);
// 23:30+02:00 and 23:59:59Z on 05-31, a Sunday: week 23, in the window.
rs.add('T5S-G-2', [{ ...rtri('Long Term'), ...Gm, authored: '2026-05-31T23:30:00+02:00' }]);
rs.add('T5S-G-3', [{ ...rtri('Long Term'), ...Gm, authored: '2026-05-31T23:59:59Z' }]);
group(LUSAKA, G('40 - 44', 'Male', 'Long Term', null, 'Long-Term RTRI', 23), 2);
// Out: local June 1 (UTC would say May 31), and April 30.
rs.add('T5S-G-OUT1', [{ ...rtri('Long Term'), ...Gm, authored: '2026-06-01T00:30:00+02:00' }]);
rs.add('T5S-G-OUT2', [{ ...rtri('Long Term'), ...Gm, authored: '2026-04-30T23:59:59Z' }]);
// An RTRI request out of the window drops the lab number, whatever its VL.
rs.add('T5S-G-OUT3', [{ ...rtri('Recent'), ...Gm, authored: '2026-04-30T12:00:00Z' }, vlNum(500)]);
// A VL request out of the window gives no baseline; a second RTRI request out of the window is not a row.
rs.add('T5S-G-VLOUT', [{ ...rtri('Recent'), ...Gm, authored: D18 }, vlNum(500, 'HIVVL')].map((r, i) => (i === 1 ? { ...r, authored: '2026-06-05T08:00:00Z' } : r)));
rs.add('T5S-G-RTRI2', [{ ...rtri('Recent'), ...Gm, authored: D18 }, { ...rtri('Long Term'), ...Gm, authored: '2026-06-05T08:00:00Z' }]);
group(LUSAKA, G('40 - 44', 'Male', 'Recent', null, 'Recent RTRI', 18), 2);

// ---- Block H (Lusaka): the rest ----
// Case-insensitive panel, observation and recency result; the result keeps its text. VL needs no mapped facility.
rs.add('T5S-H-CASE', [{ panel: 'rtri ', results: [{ obs: 'rtri ', text: 'recent ' }], req: 'ZLUSA', years: 22, authored: D19 },
  vl([{ obs: 'hivvc ', num: 2000 }], { panel: 'hivvl ' })]);
group(LUSAKA, G('20 - 24', 'Female', 'recent ', 'UnSuppressed', 'Confirmed Recent', 19), 1);
rs.add('T5S-H-VLUNMAPPED', [{ ...rtri('Recent'), req: 'ZLUSA', years: 55, authored: D19 }, vlNum(1500, 'HIVVL')].map((r, i) => (i === 1 ? { ...r, req: 'ZUNMP' } : r)));
group(LUSAKA, G('50+', 'Female', 'Recent', 'UnSuppressed', 'Confirmed Recent', 19), 1);
// Another recency result has no reporting status (line 175 has no else), the suppression status stays.
rs.add('T5S-H-INVALID', [{ ...rtri('Invalid'), req: 'ZLUSA', years: 26, authored: D19 }, vlNum(500)]);
group(LUSAKA, G('25 - 29', 'Female', 'Invalid', 'Suppressed', null, 19), 1);
// No row: only a VL request, an unmapped facility, a facility with no province, an observation off the list.
rs.add('T5S-H-NORTRI', [vlNum(500)]);
rs.add('T5S-H-UNMAPPED', [{ ...rtri('Recent'), req: 'ZUNMP', authored: D19 }]);
rs.add('T5S-H-NOPROV', [{ ...rtri('Recent'), req: 'ZNORG', authored: D19 }]);
rs.add('T5S-H-OBSOTHER', [{ results: [{ obs: 'XYZ', text: 'Recent' }], req: 'ZLUSA', authored: D19 }]);

// ---- Block I (Lusaka, female 18): v1 groups under SQL Server's collation (lines 190-201) ----
// Spellings that differ in case or trailing spaces fall in one group: the recency result, the modality, the facility
// name (two register rows 'Chilenje Clinic' and 'CHILENJE CLINIC ', region 'Lusaka' / 'LUSAKA', district 'Lusaka' /
// 'lusaka ') and the lab number (count distinct is under the same collation). One group of 5 labs: I-1 to I-3 are three
// labs, I-4 and I-5 are one lab number in two spellings.
const I = { years: 18, authored: D18 };
rs.add('T5S-I-1', [{ ...withModality('VCT'), ...I, req: 'ZLUSA' }]);
rs.add('T5S-I-2', [{ ...rtri('RECENT ', [{ obs: 'RTMOD', text: 'vct ' }]), ...I, req: 'ZLUSA' }]);
rs.add('T5S-I-3', [{ ...withModality('Vct'), ...I, req: 'ZLUS2' }]);
rs.add('T5S-I-4', [{ ...withModality('VCT'), ...I, req: 'ZLUSA' }]);
rs.add('t5s-i-4 ', [{ ...withModality('VCT'), ...I, req: 'ZLUS2' }]);
group(LUSAKA, G('15 - 19', 'Female', 'Recent', null, 'Recent RTRI', 18, { modality: 'VCT' }), 4);

// ---- The year boundary: local dates, quarter and week (lines 47-50) ----
// 2026-12-31 is a Thursday, day 365: week 53 of 2026, quarter 4. 2027-01-01 is a Friday: week 1, quarter 1.
// 23:50+02:00 on 12-31 is 21:50 UTC the same day; 00:10+02:00 on 01-01 is 22:10 UTC on 12-31, so a UTC date would
// put both in 2026.
const Y = { ...rtri('Long Term'), req: 'ZLUSA', years: 33 };
rs.add('T5S-Y-1', [{ ...Y, authored: '2026-12-31T23:50:00+02:00' }]);
rs.add('T5S-Y-2', [{ ...Y, authored: '2027-01-01T00:10:00+02:00' }]);
const yearRows = [
  { ...LUSAKA, implementing_partner: null, age_group: '30 - 34', gender: 'Female', recency_result: 'Long Term', suppression_status: null, reporting_status: 'Long-Term RTRI', modality: null, reg_year: 2026, reg_quarter: 4, month: 12, week: 53, count: 1 },
  { ...LUSAKA, implementing_partner: null, age_group: '30 - 34', gender: 'Female', recency_result: 'Long Term', suppression_status: null, reporting_status: 'Long-Term RTRI', modality: null, reg_year: 2027, reg_quarter: 1, month: 1, week: 1, count: 1 },
];

const survSetup = rs.setup();
const survSuites = [
  builderSuite({ name: 'surveillance-window', setup: survSetup, cteSql: bind(recencySurveillanceCte('rs', { from: 'from', to: 'to' }), WINDOW), columns: SURV_COLUMNS, alias: 'rs', rows: wantedSurv, fold: SURV_FOLD }),
  // No window: Choma's labs are all in May, so the filtered rows are block A either way.
  builderSuite({ name: 'surveillance-all-choma', setup: '', cteSql: recencySurveillanceCte('rs'), columns: SURV_COLUMNS, alias: 'rs',
    rows: wantedSurv.filter((r) => r.facility === 'Choma General Hospital'), where: "where facility = 'Choma General Hospital'" }),
  builderSuite({ name: 'surveillance-year-boundary', setup: '', cteSql: bind(recencySurveillanceCte('rs', { from: 'start', to: 'end' }), { start: '2026-12-01', end: '2027-01-31' }), columns: SURV_COLUMNS, alias: 'rs', rows: yearRows }),
  shapeSuite('surveillance-shape', recencySurveillanceCte),
];

// ======================================================================
// Group t17: Recency tests, Recency surveillance counts, Recency tests with client names
// ======================================================================
//
// Fixture ids start with "t17-". Lab numbers start with "T17-" (or are named in the case). Three v1 files:
//   R = StoredProcedure__dbo_get_Test_level_Recency.sql, S = ..._Recency_Surveillance.sql, Z = ..._Recency_ZNPHI.sql.
// "R line N" and so on mean a line of those files. The builders (the Recency and Recency_Surveillance tables) are pinned
// by groups t5-recency and t5-surveillance; this group pins what the three queries add: v1's column names and order,
// the blank baseline, the Patients join (client name, REFNO), the window, and the row order.
// Windows keep the fixtures apart: May 2026 (main and one day), September 2026 (row order), March to April 2027
// (surveillance).

const RECENCY_TESTS_17 = 'Recency tests';
const SURVEILLANCE_17 = 'Recency surveillance counts';
const CLIENT_NAMES_17 = 'Recency tests with client names';
const allQueries17 = queries();
const query17 = (name) => allQueries17.find((q) => q.name === name);

// ---- Fixture builder (the t5 one has no first name, no shared patients and no request attributes) ----

const ATTR_SYSTEM_17 = 'urn:openldr:cs:request-attribute';
// A request row: `pk` names its patient within the lab number (default: one patient per lab number; null for none; '#dangling' for a
// patient_id with no patients row). The patient takes first, last and sex from the first row that names it.
// `refs`: [code, value, system?] request attributes of the row.
function makeFixture17(p) {
  const patients = new Map();
  const requests = [];
  const reports = [];
  const results = [];
  const attrs = [];
  let seq = 0;
  return {
    add(labId, reqs) {
      reqs.forEach((o, i) => {
        const r = { ...REQ, pk: labId, first: 'Mary', last: 'Banda', ...o };
        const n = ++seq;
        const qid = `${p}-q${pad(n)}`;
        let patientId = null;
        if (r.pk === '#dangling') patientId = `${p}-ghost`;
        else if (r.pk !== null) {
          patientId = `${p}-p-${labId}-${r.pk}`;
          if (!patients.has(patientId)) patients.set(patientId, `(${lit(patientId)}, ${lit(r.first)}, ${lit(r.last)}, ${lit(r.sex)})`);
        }
        requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.authored)}, ${lit(r.analysis)}, ${lit(r.req)}, ${lit(patientId)}, ${num(r.years)}, ${r.obr ?? i + 1})`);
        if (r.report) {
          reports.push(`(${lit(`${p}-d${pad(n)}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.effective)}, ${lit(r.issued)}, ${lit(r.performer)}, ${lit(r.display)})`);
        }
        r.results.forEach((x, j) => {
          results.push(`(${lit(`${p}-r${pad(n)}-${j + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${num(x.num)}, ${lit(x.cmp ?? null)})`);
        });
        (r.refs ?? []).forEach(([code, value, system = ATTR_SYSTEM_17], j) => {
          attrs.push(`(${lit(`${p}-a${pad(n)}-${j + 1}`)}, ${lit(qid)}, ${lit(system)}, ${lit(code)}, ${lit(value)})`);
        });
      });
    },
    setup() {
      return `${facilityMapSql(p)}
insert into patients (id, firstname, surname, sex) values ${[...patients.values()].join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years, obr_set_id) values ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, performer_display) values ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator) values ${results.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${attrs.join(',\n  ')};`;
    },
  };
}

// ---- Columns: v1's names. SQL Server names an unaliased column as the final select writes it: R line 55 and Z line 56
// write BreastFeeding (the table says Breastfeeding), and Z line 46 writes REFNO. ----

const FIELDS_17 = [
  ['province', 'Province'], ['district', 'District'], ['facility', 'Facility'], ['moh_facility_code', 'MOHFacilityCode'],
  ['ip', 'IP'], ['lab_id', 'Lab ID'], ['gender', 'Gender'], ['age_in_years', 'AgeInYears'],
  ['recency_result', 'Recency Result'], ['baseline_vl_result', 'Baseline VL Result'],
  ['suppression_status', 'Suppression Status'], ['testing_laboratory', 'Testing Laboratory'],
  ['sample_collection_date', 'Sample Collection Date'], ['date_registered', 'Date Registered'],
  ['tested_date', 'Tested Date'], ['reviewed_date', 'Reviewed Date'], ['reporting_status', 'Reporting Status'],
  ['modality', 'Modality'], ['pregnant', 'Pregnant'], ['breastfeeding', 'BreastFeeding'], ['recency_test_date', 'Recency Test Date'],
];
// Z lines 45-56: ClientName and REFNO come after Lab ID.
const NAME_FIELDS_17 = [...FIELDS_17.slice(0, 6), ['client_name', 'ClientName'], ['refno', 'REFNO'], ...FIELDS_17.slice(6)];
const SURV_FIELDS_17 = ['Province', 'District', 'Facility', 'Implementing Partner', 'AgeGroup', 'Gender', 'Recency Result',
  'Suppression Status', 'Reporting Status', 'Modality', 'Reg_Year', 'Reg_Quarter', 'Month', 'week', 'Count'];

// What a default request gives, by hand from R (and the builder, group t5-recency).
const D17 = {
  province: 'Southern', district: 'Choma', facility: 'Choma General Hospital', moh_facility_code: '1001',
  ip: null,                                        // IPatner has no CE source (ruling 7)
  lab_id: null, gender: 'Female', age_in_years: 30,
  recency_result: 'Recent', baseline_vl_result: null, suppression_status: null,
  testing_laboratory: 'Test Lab',
  sample_collection_date: '2026-05-01T07:00:00Z', date_registered: '2026-05-02T08:00:00Z',
  tested_date: '2026-05-02T09:00:00Z', reviewed_date: '2026-05-10T10:00:00Z',
  reporting_status: 'Recent RTRI',                 // R line 51: Recent with no suppression status
  modality: null, pregnant: null, breastfeeding: null, recency_test_date: null,
};

const f17 = makeFixture17('t17');
const MARY_17 = { name: 'Mary Banda', refno: null };
const want1_17 = [];     // Recency tests, main window
const want3_17 = [];     // Recency tests with client names, main window
const wantDay1_17 = [];  // the same for the one-day window
const wantDay3_17 = [];
// One lab number. `rows` are the rows R returns in the main window (changes to D17). `people` are the Patients rows
// Z joins (name and REFNO): one row of R becomes one row of Z per person; none drops the lab (Z lines 58-59).
// `day` marks a lab that is also in the one-day window 2026-05-01.
function lab17(labId, reqs, rows, { people = [MARY_17], day = false } = {}) {
  f17.add(labId, reqs);
  for (const w of rows) {
    const row = { ...D17, ...w, lab_id: labId };
    want1_17.push(row);
    if (day) wantDay1_17.push(row);
    for (const pe of people) {
      const named = { ...row, client_name: pe.name, refno: pe.refno ?? null };
      want3_17.push(named);
      if (day) wantDay3_17.push(named);
    }
  }
}

// ---- Every column has its own value (R lines 45-55) ----
// Lusaka, male, 41, a baseline of 1500, every answer. Z line 46: the name is first name + ' ' + surname, REFNO is
// the raw text of the reference-numbers attribute (not the ART number).
lab17('T17-FULL', [
  { req: 'ZLUSA', years: 41, sex: 'M', first: 'Alice', last: 'Zulu', refs: [['reference-numbers', ',ELABS 12AT.3456']],
    results: [{ obs: 'RTRI', text: 'Recent' }, { obs: 'RTMOD', text: 'Index' }, { obs: 'VPREG', text: 'Yes' }, { obs: 'VBREA', text: 'No' }, { obs: 'RTRTD', text: '01/03/2026' }] },
  vlNum(1500),
], [{
  province: 'Lusaka', district: 'Lusaka', facility: 'Chilenje Clinic', moh_facility_code: '2002', gender: 'Male', age_in_years: 41,
  ...uns('1500'), modality: 'Index', pregnant: 'Yes', breastfeeding: 'No', recency_test_date: '2026-03-01',
}], { people: [{ name: 'Alice Zulu', refno: ',ELABS 12AT.3456' }] });

// ---- The reporting status passes through (R lines 49-54) ----
lab17('T17-ST-LONG', [rtri('Long Term')], [{ recency_result: 'Long Term', reporting_status: 'Long-Term RTRI' }]);
lab17('T17-ST-RECENT', [{}], [{}]);
lab17('T17-ST-SUP', [{}, vlNum(500)], [sup('500')]);
lab17('T17-ST-UNS', [{}, vlNum(1000)], [uns('1000')]);
lab17('T17-ST-NOSTATUS', [{}, vlText('Failed')], [nos('Failed')]);
lab17('T17-ST-OTHER', [rtri('Invalid'), vlNum(500)], [{ recency_result: 'Invalid', baseline_vl_result: '500', suppression_status: 'Suppressed', reporting_status: null }]);

// ---- The suppression lists, seen through the queries (the builder pins them too: group t5-recency) ----
// The eight suppressed texts (builder line 71), one lab each; a number under 1000 (999) is suppressed and 1000 is not (above). A text
// is on the list ignoring case and trailing spaces. '> 10000000' is the only text that is unsuppressed; any other '>' text has no status.
['< 20', '<20 copies/mL', 'Target Not Detected', '<30 copies/mL', '<40 copies/mL', '<400 copies/mL', '<400', '<883 copies/mL']
  .forEach((t, i) => lab17(`T17-LIST-${i}`, [{}, vlText(t)], [sup(t)]));
lab17('T17-LIST-CASE', [{}, vlText('target not DETECTED ')], [sup('target not DETECTED ')]);
lab17('T17-LIST-999', [{}, vlNum(999)], [sup('999')]);
lab17('T17-LIST-GT', [{}, vlText('> 10000000')], [uns('> 10000000')]);
lab17('T17-LIST-GT5', [{}, vl([{ obs: 'HIVVL', num: 5, cmp: '>' }])], [nos('> 5')]);

// ---- A blank baseline is NULL (R lines 22-25) ----
// v1 swaps an empty baseline for tb_edits.result. CE has no tb_edits, so the swap finds nothing and the baseline is NULL.
// '' = '' and '   ' = '' are true in SQL Server (trailing spaces do not count). A tab and 'x  ' are not blank.
lab17('T17-BL-EMPTY', [{}, vlText('')], [{}]);
lab17('T17-BL-SPACES', [{}, vlText('   ')], [{}]);
lab17('T17-BL-MIXED', [{}, vlText(''), vlNum(500)], [{}, sup('500')]);
lab17('T17-BL-KEEP', [{}, vlText('x  ')], [nos('x  ')]);
lab17('T17-BL-TAB', [{}, vlText('\t')], [nos('\t')]);
// Rows multiply, one per baseline result (the builder joins by lab number).
lab17('T17-VL-TWO', [{}, vl([{ obs: 'HIVVL', num: 500 }, { obs: 'HIVVC', num: 1500 }])], [sup('500'), uns('1500')]);
lab17('T17-VL-TWOREQ', [{}, vlNum(500), vl([{ obs: 'RTRI', text: 'x' }])], [sup('500'), {}]);

// ---- The rest of the row ----
// Only the registered date is windowed (R has no filter of its own): the other dates may lie anywhere.
lab17('T17-D-OUTSIDE', [{ effective: '2024-12-30T10:00:00Z', analysis: '2025-01-01T00:00:00Z', issued: '2027-02-02T00:00:00Z' }],
  [{ sample_collection_date: '2024-12-30T10:00:00Z', tested_date: '2025-01-01T00:00:00Z', reviewed_date: '2027-02-02T00:00:00Z' }]);
lab17('T17-D-NOREPORT', [{ report: false }], [{ sample_collection_date: null, reviewed_date: null, testing_laboratory: null }]);
// A patient with no sex and no age: gender 'Missing' (builder line 26), age NULL.
lab17('T17-G-MISSING', [{ sex: null, years: null }], [{ gender: 'Missing', age_in_years: null }]);
lab17('ZKT-T17-LAB', [{}], [{ testing_laboratory: 'Kitwe Teaching Hospital Lab' }]);
// The requesting facility must be mapped to a register row with a province (builder line 112).
lab17('T17-F-UNMAPPED', [{ req: 'ZUNMP' }], []);
lab17('T17-F-NOPROV', [{ req: 'ZNORG' }], []);

// ---- The window: the registered date, local date (builder lines 61 and 63). Main 2026-05-01..2026-05-31, day 2026-05-01. ----
// 00:30+02:00 on 05-01 is local May 1 (UTC says April 30).
lab17('T17-W-TZ1', [{ authored: '2026-05-01T00:30:00+02:00' }], [{ date_registered: '2026-05-01T00:30:00+02:00' }], { day: true });
lab17('T17-W-DAYLATE', [{ authored: '2026-05-01T23:59:59Z' }], [{ date_registered: '2026-05-01T23:59:59Z' }], { day: true });
lab17('T17-W-DAYTZ', [{ authored: '2026-05-01T23:30:00+02:00' }], [{ date_registered: '2026-05-01T23:30:00+02:00' }], { day: true });
// 00:30+02:00 on 05-02 is local May 2 (UTC says May 1): in the main window, out of the one-day window.
lab17('T17-W-DAYOUT-TZ', [{ authored: '2026-05-02T00:30:00+02:00' }], [{ date_registered: '2026-05-02T00:30:00+02:00' }]);
lab17('T17-W-LAST', [{ authored: '2026-05-31T23:59:59Z' }], [{ date_registered: '2026-05-31T23:59:59Z' }]);
lab17('T17-W-TZ2', [{ authored: '2026-05-31T23:30:00+02:00' }], [{ date_registered: '2026-05-31T23:30:00+02:00' }]);
lab17('T17-W-OUT-TZ', [{ authored: '2026-06-01T00:30:00+02:00' }], []);
lab17('T17-W-OUT-EARLY', [{ authored: '2026-04-30T23:59:59Z' }], []);
// An RTRI request out of the window drops the lab number, whatever its baseline. A baseline out of the window is none.
lab17('T17-W-RTRI-OUT', [{ authored: '2026-04-30T12:00:00Z' }, vlNum(500)], []);
lab17('T17-W-VL-OUT', [{}, { ...vlNum(500), authored: '2026-06-05T08:00:00Z' }], [{}]);

// ---- The client (Z lines 46 and 58-59): v1 Patients by lab number ----
// concat treats NULL as empty: a missing first name leaves the space in front.
lab17('T17-N-FIRSTNULL', [{ first: null }], [{}], { people: [{ name: ' Banda' }] });
lab17('T17-N-LASTNULL', [{ last: null }], [{}], { people: [{ name: 'Mary ' }] });
lab17('T17-N-BOTHNULL', [{ first: null, last: null }], [{}], { people: [{ name: ' ' }] });
lab17('T17-N-FIRSTEMPTY', [{ first: '' }], [{}], { people: [{ name: ' Banda' }] });
lab17('T17-N-PADDED', [{ first: ' Joy ', last: ' Phiri ' }], [{}], { people: [{ name: ' Joy   Phiri ' }] });
// No patient row, or a patient_id that points nowhere: the inner join drops the lab from Z (not from R).
lab17('T17-N-NOPATIENT', [{ pk: null }], [{ gender: 'Missing' }], { people: [] });
lab17('T17-N-DANGLING', [{ pk: '#dangling' }], [{ gender: 'Missing' }], { people: [] });
// Patients is by lab number, not by request row: a patient on the baseline request counts. The gender still comes
// from the RTRI row's patient (none: Missing).
lab17('T17-N-VLONLY', [{ pk: null }, { ...vlNum(500), pk: 'vlp', first: 'Vera', last: 'Lungu' }], [{ gender: 'Missing', ...sup('500') }], { people: [{ name: 'Vera Lungu' }] });
// ... and the lab number matches ignoring case and trailing spaces (SQL Server collation): a request row 't17-n-fold ' of
// another panel carries the patient.
f17.add('t17-n-fold ', [{ panel: 'HIVPC', report: false, results: [], pk: 'fold', first: 'Fiona', last: 'Mwale' }]);
lab17('T17-N-FOLD', [{ pk: null }], [{ gender: 'Missing' }], { people: [{ name: 'Fiona Mwale' }] });
// The same person on two request rows (two patients rows, same name) is one Patients row: one output row.
lab17('T17-N-SAME2', [{ pk: 'a', first: 'Sam', last: 'Tembo' }, { ...vlNum(500), pk: 'b', first: 'Sam', last: 'Tembo' }], [sup('500')], { people: [{ name: 'Sam Tembo' }] });
// Two different people under one lab number: a join gives a row each.
lab17('T17-N-TWO', [
  { pk: 'a', first: 'Ann', last: 'Moyo', refs: [['reference-numbers', 'R-ANN']] },
  { ...vlNum(500), pk: 'b', first: 'Bob', last: 'Daka', refs: [['reference-numbers', 'R-BOB']] },
], [sup('500')], { people: [{ name: 'Ann Moyo', refno: 'R-ANN' }, { name: 'Bob Daka', refno: 'R-BOB' }] });
// The patient is not windowed: the only patient is on a baseline request registered after the window.
lab17('T17-P-OUTWIN', [{ pk: null }, { ...vlNum(500), authored: '2026-06-05T08:00:00Z', pk: 'ow', first: 'Olga', last: 'Phiri' }],
  [{ gender: 'Missing' }], { people: [{ name: 'Olga Phiri' }] });

// ---- REFNO: the reference-numbers request attribute (Z line 46) ----
lab17('T17-R-RTRI', [{ refs: [['reference-numbers', 'R-100']] }], [{}], { people: [{ name: 'Mary Banda', refno: 'R-100' }] });
// On the baseline request row only: the lab number has it.
lab17('T17-R-VLROW', [{}, { ...vlNum(500), refs: [['reference-numbers', 'R-200']] }], [sup('500')], { people: [{ name: 'Mary Banda', refno: 'R-200' }] });
// Another code, or another code system, is no REFNO.
lab17('T17-R-OTHERCODE', [{ refs: [['unique-id', 'U-1']] }], [{}]);
lab17('T17-R-OTHERSYS', [{ refs: [['reference-numbers', 'R-300', 'urn:other']] }], [{}]);
// Two values under one lab number and one person: the greater text in byte order (v1 has one value; this is the fixed pick).
lab17('T17-R-TWO', [{ refs: [['reference-numbers', 'REF-A']] }, { ...vlNum(500), refs: [['reference-numbers', 'REF-B']] }], [sup('500')], { people: [{ name: 'Mary Banda', refno: 'REF-B' }] });

// ---- Row order (September 2026): the rows are added scrambled; the expected rows are in order ----
// Province first, then the lab number ignoring case ('b' between 'A' and 'C', where a byte order puts it last; 'T17-O-E' and
// 't17-o-e' tie for SQL Server, and the plain text breaks the tie), then a missing age before a number, a missing baseline
// before a number, and '1500' before '500' (text, not number). In Z the client name follows the lab number.
const SEPT_17 = '2026-09-10T08:00:00Z';
const vlSept = (results) => ({ ...vl(results), authored: '2026-09-11T08:00:00Z' });
f17.add('T17-O-C', [{ authored: SEPT_17 }]);
f17.add('T17-O-A', [{ authored: SEPT_17 }, vlSept([{ obs: 'HIVVL', num: 500 }]), vlSept([{ obs: 'HIVVL', num: 1500 }]), vlSept([{ obs: 'RTRI', text: 'x' }])]);
f17.add('T17-O-D', [{ authored: SEPT_17, pk: 'a', first: 'Zed', last: 'Zulu' }, { panel: 'HIVPC', report: false, results: [], pk: 'b', first: 'Abe', last: 'Aaron' }]);
f17.add('t17-o-e', [{ authored: SEPT_17 }]);
f17.add('T17-O-b', [{ authored: SEPT_17 }]);
f17.add('T17-O-F', [{ authored: SEPT_17, years: 30 }, { authored: SEPT_17, years: null }]);
f17.add('T17-O-E', [{ authored: SEPT_17 }]);
f17.add('T17-O-Z', [{ authored: SEPT_17, req: 'ZLUSA' }]);
const sept = (labId, extra = {}) => ({ ...D17, date_registered: SEPT_17, lab_id: labId, ...extra });
const LUSAKA_17 = { province: 'Lusaka', district: 'Lusaka', facility: 'Chilenje Clinic', moh_facility_code: '2002' };
const ordered1_17 = [
  sept('T17-O-Z', LUSAKA_17),
  sept('T17-O-A'), sept('T17-O-A', uns('1500')), sept('T17-O-A', sup('500')),
  sept('T17-O-b'), sept('T17-O-C'), sept('T17-O-D'),
  sept('T17-O-E'), sept('t17-o-e'),
  sept('T17-O-F', { age_in_years: null }), sept('T17-O-F'),
];
const person17 = (row, name, refno = null) => ({ ...row, client_name: name, refno });
const ordered3_17 = ordered1_17.flatMap((row) => (row.lab_id === 'T17-O-D'
  ? [person17(row, 'Abe Aaron'), person17(row, 'Zed Zulu')]
  : [person17(row, 'Mary Banda')]));

// ---- Surveillance counts (January to April 2027), one ordered list ----
// Weeks are datepart(wk): Sunday first, week 1 holds January 1 (a Friday in 2027), so week 2 starts on January 3.
const W2_17 = { from: '2027-01-01', to: '2027-04-30' };
const vlAt = (results, authored) => ({ ...vl(results), authored });
const pmtct = rtri('Recent', [{ obs: 'RTMOD', text: 'PMTCT' }]);
// Choma, age 15 - 19, PMTCT, baseline 500: one group per week or month. A: two labs on March 10 (week 11), counted twice.
f17.add('T17-S-1', [{ ...pmtct, years: 17, authored: '2027-03-10T08:00:00Z' }, vlAt([{ obs: 'HIVVL', num: 500 }], '2027-03-11T08:00:00Z')]);
f17.add('T17-S-2', [{ ...pmtct, years: 19, authored: '2027-03-10T08:00:00Z' }, vlAt([{ obs: 'HIVVL', text: 'Target Not Detected' }], '2027-03-11T08:00:00Z')]);
// B: the next week (March 17, week 12). C: April 7 (week 15, month 4, quarter 2).
f17.add('T17-S-8', [{ ...pmtct, years: 17, authored: '2027-03-17T08:00:00Z' }, vlAt([{ obs: 'HIVVL', num: 500 }], '2027-03-18T08:00:00Z')]);
f17.add('T17-S-9', [{ ...pmtct, years: 17, authored: '2027-04-07T08:00:00Z' }, vlAt([{ obs: 'HIVVL', num: 500 }], '2027-04-08T08:00:00Z')]);
// Two months in one week: January 31 (a Sunday) and February 1 both start week 6, so only the month tells them apart.
f17.add('T17-S-14', [{ ...pmtct, years: 17, authored: '2027-02-01T08:00:00Z' }, vlAt([{ obs: 'HIVVL', num: 500 }], '2027-02-02T08:00:00Z')]);
f17.add('T17-S-13', [{ ...pmtct, years: 17, authored: '2027-01-31T08:00:00Z' }, vlAt([{ obs: 'HIVVL', num: 500 }], '2027-02-02T08:00:00Z')]);
// Age 51 is '50+'; Index; no baseline, so no suppression status: it sorts first among the Choma female groups if the
// age group were left out of the order.
f17.add('T17-S-7', [{ ...rtri('Recent', [{ obs: 'RTMOD', text: 'Index' }]), years: 51, authored: '2027-03-20T08:00:00Z' }]);
// Age 28, male, 1500: unsuppressed, Confirmed Recent. March 22 is a Monday: week 13.
f17.add('T17-S-15', [{ ...rtri('Recent'), years: 28, sex: 'M', authored: '2027-03-22T08:00:00Z' }, vlAt([{ obs: 'HIVVL', num: 1500 }], '2027-03-23T08:00:00Z')]);
// Lusaka. Age 50 is '<15' (S line 25); local April 30, week 18. Out: local May 1 (UTC says April 30).
f17.add('T17-S-3', [{ ...rtri('Long Term'), req: 'ZLUSA', years: 50, sex: 'M', authored: '2027-04-30T23:30:00+02:00' }]);
f17.add('T17-S-4', [{ ...rtri('Long Term'), req: 'ZLUSA', years: 50, sex: 'M', authored: '2027-05-01T00:30:00+02:00' }]);
// No age, no sex; a modality off the list is NULL; local January 1 (UTC says December 31), week 1. Out: local December 31.
f17.add('T17-S-5', [{ ...rtri('Recent', [{ obs: 'RTMOD', text: 'Foo' }]), req: 'ZLUSA', years: null, sex: null, authored: '2027-01-01T00:30:00+02:00' }]);
f17.add('T17-S-10', [{ ...rtri('Long Term'), req: 'ZLUSA', years: 33, authored: '2026-12-31T23:30:00+02:00' }]);
// Lusaka, age 33, female, registered April 14 (week 16): the seven suppressed texts of the surveillance list (line 159-162), a case
// variant and 999 are Suppressed (nine labs); '<883 copies/mL' (not on this list) and 'Failed' have no status; '> 5' (any text starting
// with '>') and 1000 are UnSuppressed.
const survLab17 = (labId, vlResult) => f17.add(labId, [{ ...rtri('Recent'), req: 'ZLUSA', years: 33, authored: '2027-04-14T08:00:00Z' }, vlAt(vlResult, '2027-04-15T08:00:00Z')]);
['< 20', '<20 copies/mL', 'Target Not Detected', '<30 copies/mL', '<400 copies/mL', '<400', '<40 copies/mL', 'TARGET NOT DETECTED  ']
  .forEach((t, i) => survLab17(`T17-S-L${i}`, [{ obs: 'HIVVL', text: t }]));
survLab17('T17-S-L8', [{ obs: 'HIVVL', num: 999 }]);
survLab17('T17-S-N1', [{ obs: 'HIVVL', text: '<883 copies/mL' }]);
survLab17('T17-S-N2', [{ obs: 'HIVVL', text: 'Failed' }]);
survLab17('T17-S-U1', [{ obs: 'HIVVL', text: '> 5' }]);
survLab17('T17-S-U2', [{ obs: 'HIVVL', num: 1000 }]);
const surv17 = (place, age, gender, recency, suppression, reporting, modality, year, quarter, month, week, count) => ({
  ...place, 'Implementing Partner': null, AgeGroup: age, Gender: gender, 'Recency Result': recency, 'Suppression Status': suppression,
  'Reporting Status': reporting, Modality: modality, Reg_Year: year, Reg_Quarter: quarter, Month: month, week, Count: count,
});
const SOUTH_17 = { Province: 'Southern', District: 'Choma', Facility: 'Choma General Hospital' };
const LUS_17 = { Province: 'Lusaka', District: 'Lusaka', Facility: 'Chilenje Clinic' };
const pmtctGroup17 = (year, quarter, month, week, count) =>
  surv17(SOUTH_17, '15 - 19', 'Female', 'Recent', 'Suppressed', 'Confirmed Long-Term', 'PMTCT', year, quarter, month, week, count);
const orderedSurv17 = [
  surv17(LUS_17, '<15', 'Male', 'Long Term', null, 'Long-Term RTRI', null, 2027, 2, 4, 18, 1),
  surv17(LUS_17, '30 - 34', 'Female', 'Recent', null, 'Recent RTRI', null, 2027, 2, 4, 16, 2),
  surv17(LUS_17, '30 - 34', 'Female', 'Recent', 'Suppressed', 'Confirmed Long-Term', null, 2027, 2, 4, 16, 9),
  surv17(LUS_17, '30 - 34', 'Female', 'Recent', 'UnSuppressed', 'Confirmed Recent', null, 2027, 2, 4, 16, 2),
  surv17(LUS_17, 'Missing', 'Missing', 'Recent', null, 'Recent RTRI', null, 2027, 1, 1, 1, 1),
  pmtctGroup17(2027, 1, 1, 6, 1),
  pmtctGroup17(2027, 1, 2, 6, 1),
  pmtctGroup17(2027, 1, 3, 11, 2),
  pmtctGroup17(2027, 1, 3, 12, 1),
  pmtctGroup17(2027, 2, 4, 15, 1),
  surv17(SOUTH_17, '25 - 29', 'Male', 'Recent', 'UnSuppressed', 'Confirmed Recent', null, 2027, 1, 3, 13, 1),
  surv17(SOUTH_17, '50+', 'Female', 'Recent', null, 'Recent RTRI', 'Index', 2027, 1, 3, 12, 1),
];

// ---- Suites ----

const asRow17 = (fields, w) => Object.fromEntries(fields.map(([k, n]) => [n, w[k] ?? null]));
const BANNED_17 = /--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i;

// The exact row set of a query (duplicates counted) with its column order. Rows are keyed by v1 name.
function setSuite17(name, queryName, params, columns, wanted, setup = '') {
  const query = query17(queryName);
  const key = (r) => JSON.stringify(columns.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `select ${lit(name)} || chr(9) || row_to_json(q)::text from (${query ? bind(query.sql, params) : 'select 1'}) q;`,
    count: wanted.length + 1,
    check(got) {
      if (!query) return [`query "${queryName}" is missing`];
      const failures = [];
      if (got.length !== wanted.length) failures.push(`expected ${wanted.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), columns));
        if (Object.keys(got[0]).length !== columns.length) failures.push(`expected ${columns.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const left = wanted.map(key);
      for (const h of got.map(key)) {
        const i = left.indexOf(h);
        if (i < 0) failures.push(`unexpected row ${h}`); else left.splice(i, 1);
      }
      for (const w of left) failures.push(`missing row ${w}`);
      return failures;
    },
  };
}
const listSuite17 = (name, queryName, params, fields, wanted, setup = '') => setSuite17(name, queryName, params, fields.map((f) => f[1]), wanted.map((w) => asRow17(fields, w)), setup);
const orderedSuite17 = (name, queryName, params, columns, wanted) => orderedSuite(name, query17(queryName)?.sql ?? 'select 1', params, columns, wanted);

// The declared shape: parameter ids, types, required; a plain SELECT; and a total ORDER BY. CE pages a result with LIMIT and OFFSET,
// so the order must use every output column. The needles are the column expressions in output order; each must appear in the ORDER BY,
// in that order. (This reads the SQL text. The row-order suites show the order that comes out; they cannot show a column whose
// absence changes nothing on the fixture.)
function shapeSuite17(name, queryName, needles) {
  return {
    name,
    count: 8,
    check() {
      const query = query17(queryName);
      if (!query) return [`query "${queryName}" is missing`];
      const bad = [];
      const ids = query.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['from', 'to'])) bad.push(`params: expected from, to; got ${ids}`);
      for (const p of query.params) {
        if (p.type !== 'text') bad.push(`${p.id}: expected type text, got ${p.type}`);
        if (p.required !== true) bad.push(`${p.id}: must be required (the builders' window is v1's fixed start)`);
      }
      const text = query.sql;
      if (BANNED_17.test(text.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (!/^\s*with\b/i.test(text)) bad.push('does not start with "with"');
      if (!text.includes('{{param.from}}') || !text.includes('{{param.to}}')) bad.push('must use both window parameters');
      const at = text.lastIndexOf('order by');
      if (at < 0) bad.push('must end with an ORDER BY');
      else {
        let pos = at;
        for (const n of needles) {
          const i = text.indexOf(n, pos);
          if (i < 0) { bad.push(`ORDER BY must list ${n}, after the column before it`); break; }
          pos = i + n.length;
        }
      }
      return bad;
    },
  };
}

const RC_17 = ['province', 'district', 'facility', 'moh_facility_code', 'ip', 'lab_id'];
const RC_REST_17 = ['gender', 'age_in_years', 'recency_result', 'baseline_vl_result', 'suppression_status', 'testing_laboratory',
  'sample_collection_date', 'date_registered', 'tested_date', 'reviewed_date', 'reporting_status', 'modality', 'pregnant',
  'breastfeeding', 'recency_test_date'];
const NEEDLES_PLAIN_17 = [...RC_17, ...RC_REST_17].map((c) => `rc.${c}`);
const NEEDLES_NAMED_17 = [...RC_17.map((c) => `rc.${c}`), 'pt.firstname', 'pt.surname', 'pt.refno', ...RC_REST_17.map((c) => `rc.${c}`)];
const NEEDLES_SURV_17 = ['province', 'district', 'facility', 'implementing_partner', 'age_group', 'gender', 'recency_result',
  'suppression_status', 'reporting_status', 'modality', 'reg_year', 'reg_quarter', 'month', 'week', 'count'].map((c) => `rs.${c}`);

const NAMED_COLUMNS_17 = NAME_FIELDS_17.map((f) => f[1]);
const PLAIN_COLUMNS_17 = FIELDS_17.map((f) => f[1]);
const MAIN_17 = { from: '2026-05-01', to: '2026-05-31' };
const DAY_17 = { from: '2026-05-01', to: '2026-05-01' };
const SEPT_WINDOW_17 = { from: '2026-09-01', to: '2026-09-30' };

const suites17 = [
  // The fixture rows go in the first suite only.
  listSuite17('rt-main', RECENCY_TESTS_17, MAIN_17, FIELDS_17, want1_17, f17.setup()),
  listSuite17('rt-day', RECENCY_TESTS_17, DAY_17, FIELDS_17, wantDay1_17),
  listSuite17('rt-empty', RECENCY_TESTS_17, { from: '2030-01-01', to: '2030-12-31' }, FIELDS_17, []),
  orderedSuite17('rt-order', RECENCY_TESTS_17, SEPT_WINDOW_17, PLAIN_COLUMNS_17, ordered1_17.map((w) => asRow17(FIELDS_17, w))),
  shapeSuite17('rt-shape', RECENCY_TESTS_17, NEEDLES_PLAIN_17),
  listSuite17('cn-main', CLIENT_NAMES_17, MAIN_17, NAME_FIELDS_17, want3_17),
  listSuite17('cn-day', CLIENT_NAMES_17, DAY_17, NAME_FIELDS_17, wantDay3_17),
  listSuite17('cn-empty', CLIENT_NAMES_17, { from: '2030-01-01', to: '2030-12-31' }, NAME_FIELDS_17, []),
  orderedSuite17('cn-order', CLIENT_NAMES_17, SEPT_WINDOW_17, NAMED_COLUMNS_17, ordered3_17.map((w) => asRow17(NAME_FIELDS_17, w))),
  shapeSuite17('cn-shape', CLIENT_NAMES_17, NEEDLES_NAMED_17),
  orderedSuite17('rs-order', SURVEILLANCE_17, W2_17, SURV_FIELDS_17, orderedSurv17),
  setSuite17('rs-empty', SURVEILLANCE_17, { from: '2030-01-01', to: '2030-12-31' }, SURV_FIELDS_17, []),
  shapeSuite17('rs-shape', SURVEILLANCE_17, NEEDLES_SURV_17),
];

export const groups = [
  { name: 't5-recency', suites: recencySuites },
  { name: 't5-surveillance', suites: survSuites },
  { name: 't17', suites: suites17 },
];

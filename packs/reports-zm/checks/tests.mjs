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

// ======================================================================
// Group t18: DBS monitoring (VL and EID)
// ======================================================================
//
// "v1 line N" is a line of StoredProcedure__dbo_sp_CIDRZ_DBS_Monitoring.sql. Fixture ids start with "t18-"; lab numbers with "T18-".
// The main window is May 2026 (blank province, then Southern, Northern, Lusaka and Copperbelt); September 2026 holds the row order.
//
// The expected rows are worked out by hand from the v1 text. A row says which runs it belongs to: by default a row is in the blank
// run when its province is one of v1's five (ignoring case and trailing spaces) and in a province run when the province is that one;
// the cross-province labs name their runs by hand.
//
// A lab that tests the unclear texts (v1 lines 71-123) is a PAIR: request A (an old numeric result, issued before the window, so it
// is not a row itself but it is the row the hivvl table keeps) and request B (the result under test, issued in the window). The
// "valid" row of B takes its dates and its specimen from the hivvl table (A's dates); the "unclear" row takes B's own. The two rows
// differ, so a wrong list shows as an extra row. (With one request the two rows are identical and UNION would hide the mistake.)

const DBS_18 = 'DBS monitoring (VL and EID)';
const COLUMNS_18 = ['Province', 'District', 'Facility', 'LabID', 'CollectedDate', 'ReceivedDate', 'RegisteredDate', 'ResultDate',
  'Result', 'SpecimenType', 'Test', 'RejectionReason'];
const fold18 = (s) => s.replace(/ +$/, '').toLowerCase();
const FIVE_18 = ['Lusaka', 'Southern', 'Eastern', 'Western', 'North-Western'].map(fold18);

// code, register name, province, district. ZUNMP is in the map but not in the register; ZNORG is in the register with no province.
const FAC_18 = {
  SOUTH: ['ZSOUT', 'Choma General Hospital', 'Southern', 'Choma'],
  LUSAKA: ['ZLUSA', 'Chilenje Clinic', 'Lusaka', 'Lusaka'],
  EAST: ['ZEAST', 'Chipata Central', 'Eastern', 'Chipata'],
  WEST: ['ZWEST', 'Mongu General', 'Western', 'Mongu'],
  NW: ['ZNWES', 'Solwezi General', 'North-Western', 'Solwezi'],
  NORTH: ['ZNORT', 'Kasama General', 'Northern', 'Kasama'],
  COPPER: ['ZCOPP', 'Ndola Central', 'Copperbelt', 'Ndola'],
  EAST2: ['ZEAS2', 'Chadiza Clinic', 'eastern ', 'Chadiza'],
  EAST3: ['ZEAS3', 'Chipata Central ', 'eastern ', 'Chipata'],
  LUSAKA2: ['ZLUS2', 'CHILENJE CLINIC ', 'LUSAKA', 'lusaka '],
  UNMAPPED: ['ZUNMP', null, null, null],
  NOREGION: ['ZNORG', 'No Region Clinic', null, null],
};
const facilityMap18 = () => `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ${Object.entries(FAC_18).map(([k, [code, name, region, district]]) => `(${lit(`t18-fm-${k}`)}, '', '', ${lit(code)}, ${k === 'UNMAPPED' ? 'null::text' : lit(`reg-t18-${k}`)}, ${lit(name)}, ${lit(region)}, ${lit(district)})`).join(',\n  ')};`;

// What one request row holds unless a case says otherwise: a final viral load request with a numeric result and a dried blood spot.
const REQ_18 = {
  panel: 'HIVVL', fac: 'SOUTH', authored: '2026-05-02T08:00:00Z', analysis: '2026-05-02T09:00:00Z', status: 'final',
  eff: '2026-05-01T07:00:00Z', iss: '2026-05-10T10:00:00Z', recv: '2026-05-02T10:00:00Z', type: 'DBS', specimen: true, report: true,
  reason: null, results: [{ obs: 'HIVVL', num: 540 }],
};
// A request v1 rejected: a cancelled report with no result, registered in the window.
const CANC_18 = { status: 'cancelled', authored: '2026-05-05T08:00:00Z', eff: '2026-05-04T08:00:00Z', iss: null, recv: '2026-05-05T09:00:00Z', results: [] };
// An EID request: a final HIVPC result.
const EID_18 = { panel: 'HIVPC', authored: '2026-05-04T08:00:00Z', eff: '2026-05-03T07:00:00Z', iss: '2026-05-14T10:00:00Z', recv: '2026-05-04T10:00:00Z', results: [{ obs: 'HIVPC', text: 'Positive' }] };

function makeFixture18() {
  const requests = [];
  const reports = [];
  const specimens = [];
  const results = [];
  let seq = 0;
  const pad = (n) => String(n).padStart(3, '0');
  const num = (v) => (v === null || v === undefined ? 'null' : String(v));
  return {
    req(lab, o = {}) {
      const r = { ...REQ_18, ...o };
      seq += 1;
      const qid = `t18-q${pad(seq)}`;
      requests.push(`(${lit(qid)}, ${lit(lab)}, ${lit(r.panel)}, ${lit(r.authored)}, ${lit(r.analysis)}, ${lit(FAC_18[r.fac][0])}, ${lit(r.reason)}, ${seq})`);
      if (r.report !== false) {
        let sid = null;
        if (r.specimen !== false) {
          sid = `t18-s${pad(seq)}`;
          specimens.push(`(${lit(sid)}, ${lit(r.recv)}, ${lit(r.type)})`);
        }
        reports.push(`(${lit(`t18-d${pad(seq)}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.eff)}, ${lit(r.iss)}, ${lit(sid)})`);
      }
      r.results.forEach((x, j) => {
        results.push(`(${lit(`t18-r${pad(seq)}-${j + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${num(x.num)}, ${lit(x.cmp ?? null)})`);
      });
    },
    setup() {
      return `${facilityMap18()}
insert into specimens (id, received_time, type_code) values ${specimens.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, rejection_reason, obr_set_id) values ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, specimen_id) values ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator) values ${results.join(',\n  ')};`;
    },
  };
}

const RUNS_18 = [
  { name: 'all', province: '' }, { name: 'southern', province: 'Southern' }, { name: 'northern', province: 'northern ' },
  { name: 'lusaka', province: 'Lusaka' }, { name: 'copper', province: 'Copperbelt' },
];
const defaultRuns18 = (province) => RUNS_18
  .filter((r) => (r.province === '' ? FIVE_18.includes(fold18(province)) : fold18(r.province) === fold18(province))).map((r) => r.name);

const f18 = makeFixture18();
const want18 = [];
const T18 = { dbs: 'Dry Blood Spot', blood: 'Blood', whole: 'Whole Blood', plasma: 'Plasma', none: 'Unrecorded', other: 'Other' };

// One expected row. `reason` and `runs` are optional.
function out18(fac, lab, collected, received, registered, resultDate, result, type, test, reason = null, runs = null) {
  const [, name, region, district] = FAC_18[fac];
  want18.push({
    runs: runs ?? defaultRuns18(region),
    row: { Province: region, District: district, Facility: name, LabID: lab, CollectedDate: collected, ReceivedDate: received, RegisteredDate: registered,
      ResultDate: resultDate, Result: result, SpecimenType: type, Test: test, RejectionReason: reason },
  });
}
const hasSpecimen18 = (r) => r.report !== false && r.specimen !== false;

// A viral load lab with one request and one numeric result 540 (v1 valid part, lines 8-33). The hivvl row is the request itself.
function valid18(lab, o = {}, e = {}) {
  const r = { ...REQ_18, ...o };
  f18.req(lab, o);
  out18(r.fac, lab, r.eff, hasSpecimen18(r) ? r.recv : null, r.authored, r.iss, e.result ?? '540', e.type, 'VL', e.reason ?? null, e.runs ?? null);
}
// A rejected request (v1 rejects part, lines 34-70; EID lines 164-201): a cancelled report registered in the window.
function reject18(lab, o = {}, e = {}) {
  const r = { ...REQ_18, ...CANC_18, ...o };
  f18.req(lab, { ...CANC_18, ...o });
  out18(r.fac, lab, r.eff, hasSpecimen18(r) ? r.recv : null, r.authored, r.iss, 'REJECTED', e.type ?? T18.dbs, e.test ?? 'VL', e.reason ?? null, e.runs ?? null);
}
// An EID lab with one request (v1 Evalid, lines 135-163).
function eid18(lab, o = {}, e = {}) {
  const r = { ...REQ_18, ...EID_18, ...o };
  f18.req(lab, { ...EID_18, ...o });
  out18(r.fac, lab, r.eff, hasSpecimen18(r) ? r.recv : null, r.authored, r.iss, e.result === undefined ? 'Positive' : e.result, e.type ?? T18.dbs, 'EID', e.reason ?? null, e.runs ?? null);
}
// A pair (see the header). `text` is the result text of B; `e.valid` and `e.incs` say which rows B gives.
const A18 = { authored: '2026-04-18T08:00:00Z', eff: '2026-04-17T07:00:00Z', iss: '2026-04-20T10:00:00Z', recv: '2026-04-19T10:00:00Z', results: [{ obs: 'HIVVL', num: 100 }] };
const B18 = { authored: '2026-05-12T08:00:00Z', eff: '2026-05-11T07:00:00Z', iss: '2026-05-20T10:00:00Z', recv: '2026-05-13T10:00:00Z' };
function pair18(lab, text, b = {}, e = {}) {
  const fac = e.fac ?? 'SOUTH';
  const rb = { ...REQ_18, ...B18, ...b };
  f18.req(lab, { ...A18, fac });
  f18.req(lab, { ...B18, fac, results: [{ obs: 'HIVVL', text }], ...b });
  const valid = e.valid ?? true;
  const incs = e.incs ?? true;
  // valid row: A's dates (the hivvl row), B's result date, one row per specimen type of the lab's VL requests.
  if (valid) for (const type of e.validTypes ?? [T18.dbs]) out18(fac, lab, A18.eff, A18.recv, A18.authored, rb.iss, text, type, 'VL', e.reason ?? null, e.runs ?? null);
  // unclear row: B's own dates and its own specimen.
  if (incs) out18(fac, lab, rb.eff, hasSpecimen18(rb) ? rb.recv : null, rb.authored, rb.iss, text, e.incsType ?? T18.dbs, 'VL', e.reason ?? null, e.runs ?? null);
}

// ---- Valid part: the specimen type (v1 lines 13-19), one lab per source code ----
// A reason on a valid row is not shown (the re-join only works on REJECTED rows, lines 208-216).
valid18('T18-TY-DBS', { reason: 'Ignored' }, { type: T18.dbs });
valid18('T18-TY-DBSL', { type: 'dbs ' }, { type: T18.dbs });
valid18('T18-TY-B', { type: 'B' }, { type: T18.blood });
valid18('T18-TY-BLD', { type: 'BLD' }, { type: T18.blood });
valid18('T18-TY-WB', { type: 'WB' }, { type: T18.whole });
valid18('T18-TY-P', { type: 'P' }, { type: T18.plasma });
valid18('T18-TY-PL', { type: 'p ' }, { type: T18.plasma });
valid18('T18-TY-EMPTY', { type: '' }, { type: T18.none });
valid18('T18-TY-SPACES', { type: '   ' }, { type: T18.none });
valid18('T18-TY-X', { type: 'X' }, { type: T18.other });
valid18('T18-TY-PLASMA', { type: 'PLASMA' }, { type: T18.other });
// A specimen row whose code is NULL (cdr drops a blank code) or blank is 'Unrecorded'; no specimen row at all (below) is 'Other'.
valid18('T18-TY-NULL', { type: null }, { type: T18.none });
valid18('T18-TY-NOSPEC', { specimen: false }, { type: T18.other });

// ---- Valid part: rows with no hivvl row (lines 22-25) ----
// An RTRI result is in tnd but not in hivvl: dates empty, and the Requests join is limited to the VL panels: 'Other', though the
// specimen is a DBS.
f18.req('T18-RTRI', { panel: 'RTRI', results: [{ obs: 'HIVVL', num: 120 }] });
out18('SOUTH', 'T18-RTRI', null, null, null, REQ_18.iss, '120', T18.other, 'VL');
// A text the hivvl table does not accept ('<883 copies/mL' is neither a valid text nor a number) but tnd keeps.
f18.req('T18-NOHV', { results: [{ obs: 'HIVVL', text: '<883 copies/mL' }] });
out18('SOUTH', 'T18-NOHV', null, null, null, REQ_18.iss, '<883 copies/mL', T18.other, 'VL');

// ---- Valid part: several request rows of one lab number ----
// Two specimen types: the join to Requests gives a row per request (lines 22-25), so two rows.
f18.req('T18-TWO', { type: 'DBS' });
f18.req('T18-TWO', { type: 'P' });
out18('SOUTH', 'T18-TWO', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.dbs, 'VL');
out18('SOUTH', 'T18-TWO', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.plasma, 'VL');
// Two requests with one type, spelled 'DBS' and 'dbs ': the same output row twice, which UNION removes.
f18.req('T18-SAMETYPE', { type: 'DBS' });
f18.req('T18-SAMETYPE', { type: 'dbs ' });
out18('SOUTH', 'T18-SAMETYPE', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.dbs, 'VL');
// UNION compares text ignoring case and trailing spaces (v1 lines 127-129, 204, 212): two results of one lab that differ only in case and a trailing
// space are one row. The shown spelling is the smaller one in byte order ('T' before 't'; v1 shows either).
f18.req('T18-FOLD', { results: [{ obs: 'HIVVL', text: 'Target Not Detected' }] });
f18.req('T18-FOLD', { results: [{ obs: 'HIVVL', text: 'target not detected ' }] });
out18('SOUTH', 'T18-FOLD', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, 'Target Not Detected', T18.dbs, 'VL');
// The same for the facility names: two register rows of one place spelled differently ('LUSAKA' sorts before 'Lusaka').
f18.req('T18-FOLDFAC', { fac: 'LUSAKA' });
f18.req('T18-FOLDFAC', { fac: 'LUSAKA2' });
out18('LUSAKA2', 'T18-FOLDFAC', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.dbs, 'VL', null, ['all', 'lusaka']);
// And for the lab number: 'T18-LID' and 't18-lid ' are one lab number (one hivvl row, one output row).
f18.req('T18-LID', {});
f18.req('t18-lid ', {});
out18('SOUTH', 'T18-LID', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.dbs, 'VL');

// ---- Valid part: the window is the result date, as a local date (lines 28-29) ----
valid18('T18-W-START', { iss: '2026-05-01T00:30:00+02:00' }, { type: T18.dbs });
valid18('T18-W-END', { iss: '2026-05-31T23:30:00+02:00' }, { type: T18.dbs });
f18.req('T18-W-AFTER', { iss: '2026-06-01T00:30:00+02:00' });
f18.req('T18-W-BEFORE', { iss: '2026-04-30T23:30:00+02:00' });
f18.req('T18-W-PARTIAL', { iss: '2026-05' });

// ---- The province (line 27): v1's five, or the one given ----
valid18('T18-P-LUSAKA', { fac: 'LUSAKA' }, { type: T18.dbs });
valid18('T18-P-EAST', { fac: 'EAST' }, { type: T18.dbs });
valid18('T18-P-WEST', { fac: 'WEST' }, { type: T18.dbs });
valid18('T18-P-NW', { fac: 'NW' }, { type: T18.dbs });
valid18('T18-P-EAST2', { fac: 'EAST2' }, { type: T18.dbs });
valid18('T18-P-NORTH', { fac: 'NORTH' }, { type: T18.dbs });
valid18('T18-P-COPPER', { fac: 'COPPER' }, { type: T18.dbs });
f18.req('T18-P-UNMAPPED', { fac: 'UNMAPPED' });
f18.req('T18-P-NOREGION', { fac: 'NOREGION' });

// ---- Rejected part (lines 34-70) ----
reject18('T18-RJ-1', { type: 'B', reason: 'Insufficient volume' }, { type: T18.blood, reason: 'Insufficient volume' });
reject18('T18-RJ-NOREASON', { type: 'P' }, { type: T18.plasma });
reject18('T18-RJ-BLANK', { type: 'WB', reason: '   ' }, { type: T18.whole });        // len() ignores trailing spaces: length 0, no reason
reject18('T18-RJ-EMPTY', { type: '', reason: '' }, { type: T18.none });
reject18('T18-RJ-POCVR', { panel: 'POCVR', type: 'BLD', reason: 'Clotted' }, { type: T18.blood, reason: 'Clotted' });
reject18('T18-RJ-POHVL', { panel: 'POHVL', reason: 'Haemolysed' }, { reason: 'Haemolysed' });
// The result date is shown when the report has one; a report with no specimen has no received date and the type 'Other'.
reject18('T18-RJ-NULLTYPE', { type: null }, { type: T18.none });
reject18('T18-RJ-ISSUED', { iss: '2026-05-12T10:00:00Z', specimen: false }, { type: T18.other });
// A lab with several request rows: one reason per distinct reason of its VL-panel rows (any status, any facility, even unmapped),
// not those of an EID panel, not a blank one; 'Leaked' and 'leaked ' are one reason.
reject18('T18-RJ-MULTI', { reason: 'Leaked' }, { reason: 'Leaked' });
f18.req('T18-RJ-MULTI', { report: false, reason: 'leaked ' });
f18.req('T18-RJ-MULTI', { panel: 'POHVL', report: false, reason: 'Spoiled', fac: 'UNMAPPED' });
f18.req('T18-RJ-MULTI', { panel: 'HIVPC', report: false, reason: 'EID only' });
f18.req('T18-RJ-MULTI', { panel: 'POCVR', report: false, reason: '   ' });
out18('SOUTH', 'T18-RJ-MULTI', CANC_18.eff, CANC_18.recv, CANC_18.authored, null, 'REJECTED', T18.dbs, 'VL', 'Spoiled');
// A result text of 'REJECTED' (any case) gets the reason too (line 211: the join tests Result = 'REJECTED'), 'Rejection' does not.
pair18('T18-I-REJ', 'rejected ', { reason: 'Clotted2' }, { reason: 'Clotted2' });
pair18('T18-I-REJ2', 'Rejection', { reason: 'NotUsed' });
// A status other than cancelled (v1 also takes Y and Z, which CE cannot tell from the other statuses) is not rejected.
f18.req('T18-RJ-UNKNOWN', { ...CANC_18, status: 'unknown' });
// Not rejected when the lab number has a valid result in the window and province (line 69)...
f18.req('T18-RJ-VALID', { ...CANC_18, reason: 'Excluded' });
valid18('T18-RJ-VALID', {}, { type: T18.dbs });
// ...but only a valid result in the window: a result issued in June does not count.
reject18('T18-RJ-VALIDOUT', { type: 'P' }, { type: T18.plasma });
f18.req('T18-RJ-VALIDOUT', { iss: '2026-06-10T10:00:00Z' });
// ...and only one in the province asked for: rejected in Lusaka with a valid result in Northern, and the reverse. The valid
// rows show one row per specimen type of the lab's VL requests (the cancelled request's too).
f18.req('T18-RJ-XPROV', { ...CANC_18, fac: 'LUSAKA', type: 'B' });
f18.req('T18-RJ-XPROV', { fac: 'NORTH' });
out18('LUSAKA', 'T18-RJ-XPROV', CANC_18.eff, CANC_18.recv, CANC_18.authored, null, 'REJECTED', T18.blood, 'VL');
out18('NORTH', 'T18-RJ-XPROV', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.blood, 'VL');
out18('NORTH', 'T18-RJ-XPROV', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.dbs, 'VL');
f18.req('T18-RJ-XPROV2', { ...CANC_18, fac: 'NORTH', type: 'B' });
f18.req('T18-RJ-XPROV2', { fac: 'LUSAKA' });
out18('NORTH', 'T18-RJ-XPROV2', CANC_18.eff, CANC_18.recv, CANC_18.authored, null, 'REJECTED', T18.blood, 'VL');
out18('LUSAKA', 'T18-RJ-XPROV2', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.blood, 'VL');
out18('LUSAKA', 'T18-RJ-XPROV2', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.dbs, 'VL');
// The lab numbers compare ignoring case and trailing spaces: a valid result under 't18-rj-case ' excludes the rejected 'T18-RJ-CASE', and
// a reason on a request row of 't18-rj-rcase ' is the reason of 'T18-RJ-RCASE'.
f18.req('T18-RJ-CASE', { ...CANC_18 });
valid18('t18-rj-case ', {}, { type: T18.dbs });
reject18('T18-RJ-RCASE', {}, { reason: 'Case reason' });
f18.req('t18-rj-rcase ', { report: false, reason: 'Case reason' });
// The window is the registered date (line 66), a local date.
reject18('T18-RJ-W-START', { authored: '2026-05-01T00:30:00+02:00', type: 'WB' }, { type: T18.whole });
reject18('T18-RJ-W-END', { authored: '2026-05-31T23:30:00+02:00', type: 'WB' }, { type: T18.whole });
f18.req('T18-RJ-W-AFTER', { ...CANC_18, authored: '2026-06-01T00:30:00+02:00' });
f18.req('T18-RJ-W-BEFORE', { ...CANC_18, authored: '2026-04-30T23:30:00+02:00' });
f18.req('T18-RJ-W-PARTIAL', { ...CANC_18, authored: '2026-05' });
// The province (line 68).
reject18('T18-RJ-P-LUSAKA', { fac: 'LUSAKA', type: 'P' }, { type: T18.plasma });
reject18('T18-RJ-P-NORTH', { fac: 'NORTH', type: 'P' }, { type: T18.plasma });
f18.req('T18-RJ-P-UNMAPPED', { ...CANC_18, fac: 'UNMAPPED' });
f18.req('T18-RJ-P-NOREGION', { ...CANC_18, fac: 'NOREGION' });

// ---- Unclear part (lines 71-123): final, not a number, not on the 14 texts ----
const LIST14_18 = ['< 20', '<30 copies/mL', '<40 copies/mL', '> 10000000', 'DET', '>9999999', '> 9999999', '>9999999 copies/mL',
  '> 9999999 copies/mL', 'NDET', 'PLTV', 'Target Not Detected', 'RNA Not Detected', '<883 copies/mL'];
LIST14_18.forEach((t, i) => pair18(`T18-I-L${String(i + 1).padStart(2, '0')}`, t, {}, { incs: false }));
['ndet ', '<30 COPIES/ML', 'rna not detected', 'det  '].forEach((t, i) => pair18(`T18-I-V${i + 1}`, t, {}, { incs: false }));
// Near misses and unlisted texts are rows.
pair18('T18-I-PTLTT', 'PTLTT');
pair18('T18-I-NINES', '>99999999');
pair18('T18-I-SPACES', '>  9999999');
pair18('T18-I-PENDING', 'Pending');
pair18('T18-I-REPEAT', 'Please repeat', {}, { valid: false });     // on tnd's invalid list: only the unclear part has it
// The six observation codes (line 107).
['HIVVL', 'HIVVC', 'HIVVD', 'HIVTM', 'POCVR', 'POCVC'].forEach((obs) => {
  const lab = `T18-I-O-${obs}`;
  f18.req(lab, { ...A18 });
  f18.req(lab, { ...B18, results: [{ obs, text: 'PTLTT' }] });
  out18('SOUTH', lab, A18.eff, A18.recv, A18.authored, B18.iss, 'PTLTT', T18.dbs, 'VL');
  out18('SOUTH', lab, B18.eff, B18.recv, B18.authored, B18.iss, 'PTLTT', T18.dbs, 'VL');
});
f18.req('T18-I-O-X', { ...A18 });
f18.req('T18-I-O-X', { ...B18, results: [{ obs: 'HIVVX', text: 'PTLTT' }] });
f18.req('T18-I-O-CASE', { ...A18 });
f18.req('T18-I-O-CASE', { ...B18, results: [{ obs: 'hivvc ', text: 'PTLTT' }] });
out18('SOUTH', 'T18-I-O-CASE', B18.eff, B18.recv, B18.authored, B18.iss, 'PTLTT', T18.dbs, 'VL');
// The three panels (line 102), and RTRI / EID panels are not unclear rows.
pair18('T18-I-P-POHVL', 'PTLTT', { panel: 'POHVL' }, { valid: false });
pair18('T18-I-P-POCVR', 'PTLTT', { panel: 'POCVR' }, { valid: false });
pair18('T18-I-P-CASE', 'PTLTT', { panel: 'hivvl ' }, { valid: false });
pair18('T18-I-P-RTRI', 'PTLTT', { panel: 'RTRI' }, { incs: false });
pair18('T18-I-P-HIVPC', 'PTLTT', { panel: 'HIVPC' }, { valid: false, incs: false });
// The window is the authorised date (lines 104-105), a local date.
pair18('T18-I-W-START', 'PTLTT', { iss: '2026-05-01T00:30:00+02:00' });
pair18('T18-I-W-END', 'PTLTT', { iss: '2026-05-31T23:30:00+02:00' });
pair18('T18-I-W-AFTER', 'PTLTT', { iss: '2026-06-01T00:30:00+02:00' }, { valid: false, incs: false });
pair18('T18-I-W-BEFORE', 'PTLTT', { iss: '2026-04-30T23:30:00+02:00' }, { valid: false, incs: false });
pair18('T18-I-W-PARTIAL', 'PTLTT', { iss: '2026-05' }, { valid: false, incs: false });
// A report that is not final is nothing (line 101).
pair18('T18-I-STATUS', 'PTLTT', { status: 'unknown' }, { valid: false, incs: false });
// A number (line 108: ISNUMERIC) is not an unclear result, in any form it takes.
pair18('T18-I-NUM1', '5,000', {}, { incs: false });
pair18('T18-I-NUM2', '1E3', {}, { incs: false });
f18.req('T18-I-NUM3', { ...A18 });
f18.req('T18-I-NUM3', { ...B18, results: [{ obs: 'HIVVL', num: 5000 }] });
out18('SOUTH', 'T18-I-NUM3', A18.eff, A18.recv, A18.authored, B18.iss, '5000', T18.dbs, 'VL');
// A result with nothing in it is no row.
f18.req('T18-I-NULL', { ...A18 });
f18.req('T18-I-NULL', { ...B18, results: [{ obs: 'HIVVL' }] });
// The specimen of the unclear row is its own request's; the valid row has a row per type of the lab's VL requests.
pair18('T18-I-TYPE', 'PTLTT', { type: 'P' }, { validTypes: [T18.dbs, T18.plasma], incsType: T18.plasma });
pair18('T18-I-NULLTYPE', 'PTLTT', { type: null }, { validTypes: [T18.dbs, T18.none], incsType: T18.none });
pair18('T18-I-NOSPEC', 'PTLTT', { specimen: false }, { validTypes: [T18.dbs, T18.other], incsType: T18.other });
// The province (line 121).
pair18('T18-I-P-NORTH', 'PTLTT', {}, { fac: 'NORTH' });
pair18('T18-I-P-LUSAKA', 'PTLTT', {}, { fac: 'LUSAKA' });
pair18('T18-I-P-UNMAPPED', 'PTLTT', {}, { fac: 'UNMAPPED', valid: false, incs: false });

// ---- The specimen types of a valid row come from the lab number's requests in the three VL panels (line 25) ----
// A request of another status still counts (it is a Requests row); RTRI and EID-panel requests do not.
f18.req('T18-SP-POHVL', {});
f18.req('T18-SP-POHVL', { panel: 'POHVL', status: 'unknown', type: 'P', results: [] });
out18('SOUTH', 'T18-SP-POHVL', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.dbs, 'VL');
out18('SOUTH', 'T18-SP-POHVL', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.plasma, 'VL');
f18.req('T18-SP-POCVR', {});
f18.req('T18-SP-POCVR', { panel: 'POCVR', status: 'unknown', type: 'WB', results: [] });
out18('SOUTH', 'T18-SP-POCVR', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.dbs, 'VL');
out18('SOUTH', 'T18-SP-POCVR', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.whole, 'VL');
f18.req('T18-SP-OTHER', {});
f18.req('T18-SP-OTHER', { panel: 'RTRI', status: 'unknown', type: 'B', results: [] });
f18.req('T18-SP-OTHER', { panel: 'HIVPC', status: 'unknown', type: 'WB', results: [] });
f18.req('T18-SP-OTHER', { panel: 'pohvl ', status: 'unknown', type: 'BLD', results: [] });
out18('SOUTH', 'T18-SP-OTHER', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.dbs, 'VL');
out18('SOUTH', 'T18-SP-OTHER', REQ_18.eff, REQ_18.recv, REQ_18.authored, REQ_18.iss, '540', T18.blood, 'VL');

// ---- EID (lines 135-206) ----
// The result (lines 139-144): Positive, Negative, Indeterminate, Error; anything else, Invalid too, is empty.
eid18('T18-E-POS', {}, { result: 'Positive' });
eid18('T18-E-NEG', { results: [{ obs: 'HIVPC', text: 'Negative' }] }, { result: 'Negative' });
eid18('T18-E-IND', { results: [{ obs: 'HIVPC', text: 'Indeterminate' }] }, { result: 'Indeterminate' });
eid18('T18-E-ERR', { results: [{ obs: 'HIVPC', text: 'Error' }] }, { result: 'Error' });
eid18('T18-E-INV', { results: [{ obs: 'HIVPC', text: 'Invalid' }] }, { result: null });
eid18('T18-E-WEIRD', { results: [{ obs: 'HIVPC', text: 'Weird' }] }, { result: null });
// The panels and observations of the eid table, and the Requests join on the three EID panels (lines 154-155).
eid18('T18-E-POEID', { panel: 'POEID', type: 'WB', results: [{ obs: 'HIVPR', text: 'Negative' }] }, { result: 'Negative', type: T18.whole });
eid18('T18-E-POCGH', { panel: 'POCGH', type: 'P', results: [{ obs: 'PGHIV', text: 'Positive' }] }, { type: T18.plasma });
eid18('T18-E-NULLTYPE', { type: null }, { type: T18.none });
eid18('T18-E-NOSPEC', { specimen: false }, { type: T18.other });
eid18('T18-E-CASE', { panel: 'hivpc ', results: [{ obs: 'hivpr ', text: 'Positive' }] });
f18.req('T18-E-OBS', { ...EID_18, results: [{ obs: 'XYZ', text: 'Positive' }] });
// Two request rows of one lab number: a row per specimen type among its EID-panel requests; the eid table keeps the earlier one.
f18.req('T18-E-TWO', { ...EID_18 });
f18.req('T18-E-TWO', { ...EID_18, panel: 'POEID', iss: '2026-05-20T10:00:00Z', type: 'P', results: [{ obs: 'HIVPC', text: 'Negative' }] });
f18.req('T18-E-TWO', { ...EID_18, panel: 'HIVVL', status: 'unknown', type: 'B', results: [] });   // a VL-panel request: not in the join
out18('SOUTH', 'T18-E-TWO', EID_18.eff, EID_18.recv, EID_18.authored, EID_18.iss, 'Positive', T18.dbs, 'EID');
out18('SOUTH', 'T18-E-TWO', EID_18.eff, EID_18.recv, EID_18.authored, EID_18.iss, 'Positive', T18.plasma, 'EID');
f18.req('T18-E-TWO2', { ...EID_18 });
f18.req('T18-E-TWO2', { ...EID_18, panel: 'POCGH', iss: '2026-05-20T10:00:00Z', type: 'WB', results: [{ obs: 'PGHIV', text: 'Negative' }] });
out18('SOUTH', 'T18-E-TWO2', EID_18.eff, EID_18.recv, EID_18.authored, EID_18.iss, 'Positive', T18.dbs, 'EID');
out18('SOUTH', 'T18-E-TWO2', EID_18.eff, EID_18.recv, EID_18.authored, EID_18.iss, 'Positive', T18.whole, 'EID');
// The eid table keeps the earliest tested row of the lab number: it is before the window, so nothing shows.
f18.req('T18-E-DEDUP', { ...EID_18, iss: '2026-04-20T10:00:00Z' });
f18.req('T18-E-DEDUP', { ...EID_18, iss: '2026-05-10T10:00:00Z' });
// The window is the tested date (lines 160-161), a local date.
eid18('T18-E-W-START', { iss: '2026-05-01T00:30:00+02:00' });
eid18('T18-E-W-END', { iss: '2026-05-31T23:30:00+02:00' });
f18.req('T18-E-W-AFTER', { ...EID_18, iss: '2026-06-01T00:30:00+02:00' });
f18.req('T18-E-W-BEFORE', { ...EID_18, iss: '2026-04-30T23:30:00+02:00' });
f18.req('T18-E-STATUS', { ...EID_18, status: 'unknown' });
// The province (line 158).
eid18('T18-E-P-LUSAKA', { fac: 'LUSAKA' });
eid18('T18-E-P-NORTH', { fac: 'NORTH' });
f18.req('T18-E-P-UNMAPPED', { ...EID_18, fac: 'UNMAPPED' });
// EID rejected (lines 164-201): the EID panels HIVPC, POCGH and POEID, with the reason of the lab's EID-panel requests only.
reject18('T18-E-RJ-HIVPC', { panel: 'HIVPC', reason: 'Dry spot damaged' }, { test: 'EID', reason: 'Dry spot damaged' });
reject18('T18-E-RJ-POCGH', { panel: 'POCGH', reason: 'Wrong card', type: 'B' }, { test: 'EID', reason: 'Wrong card', type: T18.blood });
reject18('T18-E-RJ-POEID', { panel: 'POEID', type: 'BLD' }, { test: 'EID', type: T18.blood });
reject18('T18-E-RJ-NULLTYPE', { panel: 'HIVPC', type: null }, { test: 'EID', type: T18.none });
reject18('T18-E-RJ-NOSPEC', { panel: 'HIVPC', specimen: false }, { test: 'EID', type: T18.other });
reject18('T18-E-RJ-X1', { panel: 'HIVPC' }, { test: 'EID' });
f18.req('T18-E-RJ-X1', { panel: 'HIVVL', report: false, reason: 'VL reason' });       // a VL panel reason is not used
reject18('T18-E-RJ-WIN', { panel: 'HIVPC', authored: '2026-05-31T23:30:00+02:00' }, { test: 'EID' });
reject18('T18-E-RJ-WIN2', { panel: 'HIVPC', authored: '2026-05-01T00:30:00+02:00' }, { test: 'EID' });
f18.req('T18-E-RJ-W-AFTER', { ...CANC_18, panel: 'HIVPC', authored: '2026-06-01T00:30:00+02:00' });
f18.req('T18-E-RJ-W-BEFORE', { ...CANC_18, panel: 'HIVPC', authored: '2026-04-30T23:30:00+02:00' });
f18.req('T18-E-RJ-UNKNOWN', { ...CANC_18, panel: 'HIVPC', status: 'unknown' });
// Not rejected when the lab has a valid EID row in the window and province (line 200); lab numbers compare ignoring case and spaces.
f18.req('T18-E-RJ-CASE', { ...CANC_18, panel: 'HIVPC' });
eid18('t18-e-rj-case ', {}, {});
f18.req('T18-E-RJ-VALID', { ...CANC_18, panel: 'HIVPC' });
eid18('T18-E-RJ-VALID', {}, {});
f18.req('T18-E-RJ-VALIDOUT', { ...EID_18, iss: '2026-06-10T10:00:00Z' });
reject18('T18-E-RJ-VALIDOUT', { panel: 'HIVPC', type: 'P' }, { test: 'EID', type: T18.plasma });
f18.req('T18-E-RJ-XPROV', { ...CANC_18, panel: 'HIVPC', fac: 'LUSAKA', type: 'B' });
f18.req('T18-E-RJ-XPROV', { ...EID_18, fac: 'NORTH' });
out18('LUSAKA', 'T18-E-RJ-XPROV', CANC_18.eff, CANC_18.recv, CANC_18.authored, null, 'REJECTED', T18.blood, 'EID');
out18('NORTH', 'T18-E-RJ-XPROV', EID_18.eff, EID_18.recv, EID_18.authored, EID_18.iss, 'Positive', T18.blood, 'EID');
out18('NORTH', 'T18-E-RJ-XPROV', EID_18.eff, EID_18.recv, EID_18.authored, EID_18.iss, 'Positive', T18.dbs, 'EID');
reject18('T18-E-RJ-NORTH', { panel: 'HIVPC', fac: 'NORTH' }, { test: 'EID' });
f18.req('T18-E-RJ-UNMAPPED', { ...CANC_18, panel: 'HIVPC', fac: 'UNMAPPED' });

// ---- Row order: the September window ----
// v1 orders by Province, District, Facility (line 218), comparing as SQL Server does (case and trailing spaces ignored, so 'eastern '
// is Eastern and the district decides). The port adds every other column so that paging is stable (NULL first).
const SEPT_18 = { iss: '2026-09-10T10:00:00Z' };
const ord18 = [];
const ordRow18 = (fac, lab, result, test = 'VL') => {
  const [, name, region, district] = FAC_18[fac];
  ord18.push({ Province: region, District: district, Facility: name, LabID: lab, CollectedDate: REQ_18.eff, ReceivedDate: REQ_18.recv,
    RegisteredDate: REQ_18.authored, ResultDate: SEPT_18.iss, Result: result, SpecimenType: T18.dbs, Test: test, RejectionReason: null });
};
f18.req('T18-O-1', { ...SEPT_18, fac: 'WEST' }); f18.req('T18-O-2', { ...SEPT_18, fac: 'EAST2' }); f18.req('T18-O-3', { ...SEPT_18, fac: 'EAST' });
f18.req('T18-O-4', { ...SEPT_18, fac: 'EAST', results: [{ obs: 'HIVVL', num: 540 }, { obs: 'HIVVC', num: 100 }] });
f18.req('T18-O-5', { ...SEPT_18, fac: 'NW' }); f18.req('T18-O-6', { ...SEPT_18, fac: 'LUSAKA' }); f18.req('T18-O-7', SEPT_18);
f18.req('T18-O-0', { ...SEPT_18, fac: 'EAST' });
f18.req('T18-O-8', { ...SEPT_18, fac: 'EAST3' });
f18.req('T18-O-9', { ...SEPT_18, fac: 'EAST' });
f18.req('T18-O-9', { ...EID_18, ...SEPT_18, eff: REQ_18.eff, recv: REQ_18.recv, authored: REQ_18.authored, fac: 'EAST', results: [{ obs: 'HIVPC', text: 'Invalid' }] });
ordRow18('EAST2', 'T18-O-2', '540');
ordRow18('EAST', 'T18-O-0', '540');
ordRow18('EAST', 'T18-O-3', '540');
ordRow18('EAST', 'T18-O-4', '100');
ordRow18('EAST', 'T18-O-4', '540');
ordRow18('EAST', 'T18-O-9', null, 'EID');
ordRow18('EAST', 'T18-O-9', '540');
// Same province, district and facility as far as SQL Server compares them, spelled differently: after them, whatever the lab number.
ordRow18('EAST3', 'T18-O-8', '540');
ordRow18('LUSAKA', 'T18-O-6', '540');
ordRow18('NW', 'T18-O-5', '540');
ordRow18('SOUTH', 'T18-O-7', '540');
ordRow18('WEST', 'T18-O-1', '540');

// ---- Suites ----
const rowsFor18 = (run) => want18.filter((w) => w.runs.includes(run)).map((w) => w.row);
const MAIN_18 = { from: '2026-05-01', to: '2026-05-31' };

// The declared shape: parameters, a plain SELECT, and a total ORDER BY (CE pages a result with LIMIT and OFFSET).
const shape18 = {
  name: 'dbs-shape',
  count: 14,
  check() {
    const query = query17(DBS_18);
    if (!query) return [`query "${DBS_18}" is missing`];
    const bad = [];
    const ids = query.params.map((p) => p.id);
    if (JSON.stringify(ids) !== JSON.stringify(['from', 'to', 'province'])) bad.push(`params: expected from, to, province; got ${ids}`);
    const want = { from: ['text', true], to: ['text', true], province: ['select', false] };
    for (const p of query.params) {
      const w = want[p.id];
      if (w && (p.type !== w[0] || p.required !== w[1])) bad.push(`${p.id}: expected ${w[0]} required=${w[1]}, got ${p.type} required=${p.required}`);
    }
    const province = query.params.find((p) => p.id === 'province');
    if (province && !String(province.label).includes('blank for Lusaka, Southern, Eastern, Western and North-Western')) bad.push(`province label must name v1's five provinces: ${province.label}`);
    if (province && !province.optionsSql) bad.push('province must have optionsSql');
    const text = query.sql;
    if (BANNED_17.test(text.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
    if (!/^\s*with\b/i.test(text)) bad.push('does not start with "with"');
    for (const p of ['from', 'to', 'province']) if (!text.includes(`{{param.${p}}}`)) bad.push(`must use {{param.${p}}}`);
    const at = text.lastIndexOf('order by');
    if (at < 0) bad.push('must end with an ORDER BY');
    else {
      let pos = at;
      for (const c of ['province', 'district', 'facility', 'lab_id', 'collected_date', 'received_date', 'registered_date', 'result_date', 'result', 'specimen_type', 'test', 'reason']) {
        const i = text.indexOf(`dd.${c}`, pos);
        if (i < 0) { bad.push(`ORDER BY must list dd.${c}, after the column before it`); break; }
        pos = i + c.length;
      }
    }
    return bad;
  },
};

const suites18 = [
  // The fixture rows go in the first suite only.
  ...RUNS_18.map((run, i) => setSuite17(`dbs-${run.name}`, DBS_18, { ...MAIN_18, province: run.province }, COLUMNS_18, rowsFor18(run.name), i === 0 ? f18.setup() : '')),
  setSuite17('dbs-empty', DBS_18, { from: '2030-01-01', to: '2030-12-31', province: '' }, COLUMNS_18, []),
  orderedSuite('dbs-order', query17(DBS_18)?.sql ?? 'select 1', { from: '2026-09-01', to: '2026-09-30', province: '' }, COLUMNS_18, ord18),
  shape18,
];


// ======================================================================
// Group t19: CD4 by area, age and sex (sp_get_CDC_CD4_data_month) and HPV results by month (sp_get_HPV_data)
// ======================================================================
//
// Fixture ids start with "t19-"; lab numbers with "T19-". "CD4 line N" is a line of StoredProcedure__dbo_sp_get_CDC_CD4_data_month.sql, "HPV line N" a
// line of StoredProcedure__dbo_sp_get_HPV_data.sql. Both queries read lab requests and results; the HPV one also reads reports (the authorised date).
// Every group of cases lives in its own cell (facility, lab, month, age, sex) so that the expected rows can be worked out one cell at a time.

const CD4_19 = 'CD4 by area, age and sex';
const HPV_19 = 'HPV results by month';

const facilityMap19 = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t19-fm01', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t19-fm02', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('t19-fm03', '', '', 'ZLUS2', 'reg-l2', 'CHILENJE CLINIC ', 'LUSAKA', 'lusaka '),
  ('t19-fm04', '', '', 'ZKAFU', 'reg-k', 'Kafue District Hospital', 'Lusaka', 'Kafue'),
  ('t19-fm05', '', '', 'ZUNMP', null, null, null, null),
  ('t19-fm06', '', '', 'ZNORG', 'reg-n', 'No Province Clinic', null, null),
  ('t19-fm07', '', '', 'ZNODS', 'reg-d', 'No District Clinic', 'Western', null),
  ('t19-fm08', '', '', 'ZNONM', 'reg-m', null, 'Eastern', 'Chipata'),
  ('t19-fm09', '', '', 'ZMONG', 'reg-g', 'Mongu Clinic', 'Western', 'Mongu'),
  ('t19-fm10', '', '', 'ZCHIP', 'reg-c', 'Chipata Clinic', 'Eastern', 'Chipata'),
  ('t19-fm11', '', '', 'ZPERF', 'reg-p', 'Perf Lab Register', 'Southern', 'Choma'),
  ('t19-fm12', '', '', 'ZTWE', 'reg-te', 'Twin Clinic', 'Eastern', 'Twin'),
  ('t19-fm13', '', '', 'ZTWW', 'reg-tw', 'Twin Clinic', 'Western', 'Twin');`;

// One lab_requests row per add(), with its client, its report and its results. `sex`: a letter, null (a client with no sex), or noPatient.
function makeFixture19(p) {
  const patients = [];
  const requests = [];
  const reports = [];
  const results = [];
  let seq = 0;
  return {
    add(labId, o = {}) {
      const r = {
        panel: 'CD4', req: 'ZSOUT', authored: '2026-05-10T08:00:00Z', years: 30, sex: 'F', noPatient: false, analyzer: null,
        report: false, status: 'final', issued: '2026-05-10T10:00:00Z', performer: 'LUS', display: 'Lusaka Lab', results: [], ...o,
      };
      const n = ++seq;
      const qid = `${p}-q${pad(n)}`;
      let patientId = null;
      if (!r.noPatient) {
        patientId = `${p}-p${pad(n)}`;
        patients.push(`(${lit(patientId)}, ${lit('P' + n)}, ${lit(r.sex)})`);
      }
      requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.authored)}, ${lit(r.req)}, ${lit(patientId)}, ${num(r.years)}, ${lit(r.analyzer)})`);
      if (r.report) reports.push(`(${lit(`${p}-d${pad(n)}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.issued)}, ${lit(r.performer)}, ${lit(r.display)})`);
      r.results.forEach((x, j) => {
        results.push(`(${lit(`${p}-r${pad(n)}-${j + 1}`)}, ${lit(qid)}, ${lit(x.obs ?? null)}, ${lit(x.text ?? null)}, ${num(x.num)}, ${lit(x.cmp ?? null)}, ${lit(x.coded ?? null)})`);
      });
    },
    setup() {
      return `${facilityMap19}
insert into patients (id, surname, sex) values ${patients.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, requester_code, patient_id, age_years, analyzer_code) values ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, issued, performer, performer_display) values ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values ${results.join(',\n  ')};`;
    },
  };
}
const f19 = makeFixture19('t19');

// ---------------------------------------------------------------- CD4 ----
// A CD4 request: panel CD4 (v1 line 39), no report needed (v1 reads Requests and LabResults only).
const cd4 = (labId, results, o = {}) => f19.add(`T19-${labId}`, { panel: 'CD4', results, ...o });
const abs = (text, extra = {}) => ({ obs: 'CD4', text, ...extra });
const pct = (text, extra = {}) => ({ obs: 'CD4L', text, ...extra });

// Cell A: Southern / Choma / Choma General Hospital, age 30, F, May 2026. The absolute-count ranges (v1 lines 28-32) and what counts as a number.
// v1 casts to numeric with no scale, which ROUNDS to a whole number (measured on SQL Server: '199.5' becomes 200, '409.5' 410, '1590.5' 1591).
[
  ['A01', '199'], ['A02', '199.4'], ['A03', '199.5'], ['A04', '200'], ['A05', '409'],
  ['A06', '409.4'], ['A07', '409.5'], ['A08', '410'], ['A09', '1590'], ['A10', '1590.4'],
  ['A11', '1590.5'], ['A12', '1591'], ['A13', '0'], ['A14', '-5'], ['A15', ' 250 '],
  // v1 stops with a conversion error on these (ISNUMERIC says yes, CAST to numeric fails): the port reads the number.
  ['A16', '1,000'], ['A17', '1E3'],
  ['A18', '< 20'], ['A19', ''], ['A21', 'Pending'],
  ['A22', '$5'], ['A31', '.5'], ['A32', '5.'], ['A33', '+300'], ['A34', '-'], ['A35', '1 2'],
].forEach(([id, text]) => cd4(id, [abs(text)]));
cd4('A20', [{ obs: 'CD4' }]);                                  // no value at all: missing
cd4('A23', [{ obs: 'CD4', num: 199.6 }]);                      // a number result: 199.6 rounds to 200, below normal
cd4('A24', [{ obs: 'CD4', num: 150 }]);
cd4('A25', [{ obs: 'CD4', coded: '350' }]);                    // only a coded value: LIMSRptResult shows it
cd4('A26', [{ obs: 'CD4', num: 20, cmp: '<' }]);               // '< 20' is no number
cd4('A27', [abs('150'), abs('160')]);                          // two results in one range: the request counts once
cd4('A28', [abs('150'), abs('300')]);                          // two ranges: the request counts in each
cd4('A36', [abs('100')]);
cd4('a36 ', [abs('100')]);                                     // the same request number (case, trailing space) on a second request row: counts once

// Cell B: Lusaka / Kafue / Kafue District Hospital, age 20, M, May 2026. The percentage ranges (v1 lines 94-97) join to the absolute rows.
const bb = { years: 20, req: 'ZKAFU', sex: 'M' };
cd4('B00', [abs('300')], bb);
cd4('B16', [abs('120'), pct('25')], bb);                       // one request with both results: it counts in both CTEs
[
  ['B01', '30', 'M'], ['B02', '30.4', 'M'], ['B03', '30.5', 'M'], ['B04', '31', 'm '], ['B05', '60', 'M'], ['B06', '60.4', 'M'],
  ['B07', '60.5', 'M'], ['B08', '61', 'M'], ['B09', 'n/a', 'm '], ['B10', '', 'M'], ['B11', '0', 'M'], ['B12', '-1', 'M'],
].forEach(([id, text, sex]) => cd4(id, [pct(text)], { ...bb, sex }));
cd4('B13', [{ obs: 'CD4L', num: 72 }], bb);
cd4('B14', [{ obs: 'CD4L', coded: '45' }], bb);

// Cell T: the join needs the province and the sex too. Eastern and Western each have a 'Twin Clinic' in a district 'Twin'; age 33.
cd4('T01', [abs('100')], { years: 33, sex: 'F', req: 'ZTWE' });
cd4('T02', [pct('40')], { years: 33, sex: 'M', req: 'ZTWE' });   // another sex: no join
cd4('T03', [pct('40')], { years: 33, sex: 'F', req: 'ZTWW' });   // another province: no join, and no absolute row of its own

// Cell C: Lusaka / Lusaka / Chilenje Clinic, age 40, M, May 2026. Which panels and observations count (lines 39-40 and 104-105). Text compares ignore case and spaces.
const cc = { years: 40, req: 'ZLUSA', sex: 'M' };
cd4('C01', [{ obs: 'cd4 ', text: '100' }], { ...cc, panel: 'cd4 ' });
cd4('C02', [abs('100')], cc);
cd4('C03', [abs('100')], { ...cc, panel: 'CD4X' });
cd4('C04', [abs('100')], { ...cc, panel: 'HIVVL' });
cd4('C05', [{ obs: 'CD4X', text: '100' }], cc);
cd4('C06', [{ obs: 'CD3', text: '100' }], cc);
cd4('C07', [{ obs: 'cd4l', text: '40' }], cc);
cd4('C08', [abs('100')], { ...cc, panel: null });
cd4('C09', [{ obs: null, text: '100' }], cc);
cd4('C10', [{ obs: 'CD4L ', text: '45' }], cc);

// Cell D: the requesting facility (lines 36-38, 140). Age 25, F unless said. An unmapped facility, a register row with no province, a code
// the map does not hold and a request with no facility drop out (v1: Province is null).
const dd = { years: 25, sex: 'F' };
cd4('D01', [abs('100')], { ...dd, req: 'ZLUSA' });
cd4('D02', [abs('100')], { ...dd, req: 'ZLUS2' });             // the same facility under other spellings: one group
cd4('D11', [pct('40')], { ...dd, req: 'ZLUS2' });
cd4('D12', [pct('40')], { ...dd, req: 'ZLUSA' });
cd4('D03', [abs('100')], { ...dd, req: 'ZUNMP' });
cd4('D04', [abs('100')], { ...dd, req: 'ZNORG' });
cd4('D09', [abs('100')], { ...dd, req: 'ZNONE' });
cd4('D10', [abs('100')], { ...dd, req: null });
cd4('D05', [abs('100')], { ...dd, req: 'ZNODS' });            // no district: the join to the percentage row fails (null never equals null)
cd4('D06', [pct('40')], { ...dd, req: 'ZNODS' });
cd4('D07', [abs('100')], { ...dd, req: 'ZNONM' });            // no facility name: the same
cd4('D08', [pct('40')], { ...dd, req: 'ZNONM' });
cd4('D13', [abs('100')], { years: 17, sex: 'F', req: 'ZLUS2' });  // spelled one way here and the other way in the percentage row: the join still matches
cd4('D14', [pct('40')], { years: 17, sex: 'F', req: 'ZLUSA' });

// Cell E: the age bands (lines 10-23), ZSOUT, M, May 2026. Age 0 is '<01'; a missing or negative age is 'Missing'; 50 and over is '50+'.
[0, 1, 4, 5, 9, 10, 14, 15, 19, 20, 24, 25, 29, 30, 34, 35, 39, 40, 44, 45, 49, 50, 99, null, -1]
  .forEach((age, i) => cd4(`E${pad(i)}`, [abs('100')], { years: age, sex: 'M' }));

// Cell F: the sex column (lines 24-27), ZKAFU, age 60, May 2026. '' is 'Missing'; other letters come through; groups ignore case and trailing spaces.
[
  ['F', 'F'], ['F2', 'f '], ['M', 'M'], ['U', 'U'], ['X', 'X'], ['Blank', ''], ['Spaces', '   '], ['Null', null], ['Word', 'Missing'], ['Word2', 'missing'],
].forEach(([id, sex]) => cd4(`F-${id}`, [abs('100')], { years: 60, req: 'ZKAFU', sex }));
cd4('F-NoPatient', [abs('100')], { years: 60, req: 'ZKAFU', noPatient: true });

// Cell G: the month window, ZSOUT, age 65, F. v1 takes last month by the registered date's year and month; here `from` and `to` on the LOCAL date.
[
  ['G01', '2026-05-01T00:00:00Z'], ['G02', '2026-05-31T23:59:59Z'], ['G03', '2026-04-30T23:59:59Z'], ['G04', '2026-06-01T00:00:00Z'],
  ['G05', '2026-05-01T00:30:00+02:00'], ['G06', '2026-05-31T23:30:00+02:00'], ['G07', '2026-06-01T00:30:00+02:00'], ['G08', '2026-04-30T23:30:00+02:00'],
  ['G09', '2026-05-15'], ['G10', '2026-05'], ['G11', null], ['G12', '2026-05-31T23:30:00-02:00'],
].forEach(([id, authored]) => cd4(id, [abs('100')], { years: 65, authored }));

// Window two: Dec 2025 and Jan 2026, and Jan 2025 (the year must be part of the join). Same cell as G.
cd4('Y1', [abs('100')], { years: 65, authored: '2025-12-31T23:30:00+02:00' });
cd4('Y2', [abs('100')], { years: 65, authored: '2026-01-01T00:30:00+02:00' });
cd4('Y3', [abs('100')], { years: 65, authored: '2026-01-31T12:00:00Z' });
cd4('Y4', [pct('40')], { years: 65, authored: '2026-01-15T00:00:00Z' });
cd4('Y5', [pct('40')], { years: 65, authored: '2025-01-15' });

// Window three: one request in each month of 2027, so every month name shows. ZSOUT, age 2, sex I.
for (let m = 1; m <= 12; m += 1) cd4(`M${pad(m)}`, [abs('100')], { years: 2, sex: 'I', authored: `2027-${String(m).padStart(2, '0')}-15T10:00:00Z` });

// Order fixture, 10 March 2028.
const ord28 = { authored: '2028-03-10T10:00:00Z' };
cd4('O01', [abs('100')], { ...ord28, years: 7 });
cd4('O02', [abs('300')], { ...ord28, years: 7 });
cd4('O03', [pct('20')], { ...ord28, years: 7 });
cd4('O04', [pct('40')], { ...ord28, years: 7 });
cd4('O05', [abs('1700')], { ...ord28, years: 33, sex: 'M', req: 'ZKAFU' });
cd4('O06', [abs('100')], { ...ord28, years: 33, sex: 'M', req: 'ZLUSA' });
cd4('O07', [abs('100')], { ...ord28, years: 33, sex: 'M', req: 'ZNODS' });
cd4('O08', [abs('100')], { ...ord28, years: 33, sex: 'M', req: 'ZMONG' });
cd4('O09', [abs('100')], { ...ord28, years: 33, sex: 'M', req: 'ZNONM' });
cd4('O10', [abs('100')], { ...ord28, years: 33, sex: 'M', req: 'ZCHIP' });

// ---- Expected CD4 rows ----
const CD4_COLUMNS = ['Year', 'Month', 'MonthName', 'Province', 'District', 'Facility', 'AgeGroup', 'Sex',
  'CD4 Absolute Count Range', 'CD4 Absolute Count Tests', 'CD4 Percent Range', 'CD4 Percent Tests'];
const ADV = 'Advanced HIV';
const BELOW = 'CD4 count below normal range';
const WITHIN = 'CD4 count Within normal range';
const ABOVE = 'CD4 count Above normal range';
const ABS_MISSING = 'Missing Absolute CD4 Count Result';
const P_BELOW = 'CD4 percentage below normal range';
const P_WITHIN = 'CD4 percentage Within normal range';
const P_ABOVE = 'CD4 percentage above normal range';
const P_MISSING = 'Missing CD4% Result';
const cdRow = (year, month, monthName, place, age, sex, absRange, absTests, pctRange = null, pctTests = null) => ({
  Year: year, Month: month, MonthName: monthName, Province: place[0], District: place[1], Facility: place[2], AgeGroup: age, Sex: sex,
  'CD4 Absolute Count Range': absRange, 'CD4 Absolute Count Tests': absTests, 'CD4 Percent Range': pctRange, 'CD4 Percent Tests': pctTests,
});
const MAY = (place, age, sex, absRange, absTests, pctRange, pctTests) => cdRow(2026, 5, 'May', place, age, sex, absRange, absTests, pctRange, pctTests);
const CHOMA = ['Southern', 'Choma', 'Choma General Hospital'];
const KAFUE = ['Lusaka', 'Kafue', 'Kafue District Hospital'];
const CHILENJE = ['Lusaka', 'Lusaka', 'Chilenje Clinic'];
// The merged Chilenje group shows the smallest spelling of each name in byte order (v1 shows whichever it meets first).
const CHILENJE_MERGED = ['LUSAKA', 'Lusaka', 'CHILENJE CLINIC '];
const CHILENJE_ZLUS2 = ['LUSAKA', 'lusaka ', 'CHILENJE CLINIC '];

const want19 = [
  // Cell A: no percentage rows, so the percentage columns are null (the left join, line 138).
  MAY(CHOMA, '30-34', 'F', ADV, 10, null, null),
  MAY(CHOMA, '30-34', 'F', BELOW, 9, null, null),
  MAY(CHOMA, '30-34', 'F', WITHIN, 6, null, null),
  MAY(CHOMA, '30-34', 'F', ABOVE, 2, null, null),
  MAY(CHOMA, '30-34', 'F', ABS_MISSING, 8, null, null),
  // Cell B: each absolute row meets each percentage row (the join is many to many), and each count is of distinct requests.
  ...[[ADV, 1], [BELOW, 1]].flatMap(([range, n]) => [[P_BELOW, 5], [P_WITHIN, 5], [P_ABOVE, 3], [P_MISSING, 2]]
    .map(([prange, pn]) => MAY(KAFUE, '20-24', 'M', range, n, prange, pn))),
  // Cell T
  MAY(['Eastern', 'Twin', 'Twin Clinic'], '30-34', 'F', ADV, 1, null, null),
  // Cell C
  MAY(CHILENJE, '40-44', 'M', ADV, 2, P_WITHIN, 2),
  // Cell D
  MAY(CHILENJE_MERGED, '25-29', 'F', ADV, 2, P_WITHIN, 2),
  MAY(['Western', null, 'No District Clinic'], '25-29', 'F', ADV, 1, null, null),
  MAY(['Eastern', 'Chipata', null], '25-29', 'F', ADV, 1, null, null),
  MAY(CHILENJE_ZLUS2, '15-19', 'F', ADV, 1, P_WITHIN, 1),
  // Cell E
  ...[['<01', 1], ['01-04', 2], ['05-09', 2], ['10-14', 2], ['15-19', 2], ['20-24', 2], ['25-29', 2], ['30-34', 2], ['35-39', 2],
    ['40-44', 2], ['45-49', 2], ['50+', 2], ['Missing', 2]].map(([age, n]) => MAY(CHOMA, age, 'M', ADV, n, null, null)),
  // Cell F
  ...[['F', 2], ['M', 1], ['U', 1], ['X', 1], ['Missing', 6]].map(([sex, n]) => MAY(KAFUE, '50+', sex, ADV, n, null, null)),
  // Cell G: in are G01, G02, G05, G06, G09 and G12.
  MAY(CHOMA, '50+', 'F', ADV, 6, null, null),
];
const want19Win2 = [
  cdRow(2025, 12, 'December', CHOMA, '50+', 'F', ADV, 1, null, null),
  cdRow(2026, 1, 'January', CHOMA, '50+', 'F', ADV, 2, P_WITHIN, 1),
];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const want19Win3 = MONTH_NAMES.map((name, i) => cdRow(2027, i + 1, name, CHOMA, '01-04', 'I', ADV, 1, null, null));
const MAR = (place, age, sex, absRange, absTests, pctRange = null, pctTests = null) => cdRow(2028, 3, 'March', place, age, sex, absRange, absTests, pctRange, pctTests);
const want19Order = [
  MAR(['Eastern', 'Chipata', null], '30-34', 'M', ADV, 1),
  MAR(['Eastern', 'Chipata', 'Chipata Clinic'], '30-34', 'M', ADV, 1),
  MAR(KAFUE, '30-34', 'M', ABOVE, 1),
  MAR(CHILENJE, '30-34', 'M', ADV, 1),
  MAR(CHOMA, '05-09', 'F', ADV, 1, P_BELOW, 1),
  MAR(CHOMA, '05-09', 'F', ADV, 1, P_WITHIN, 1),
  MAR(CHOMA, '05-09', 'F', BELOW, 1, P_BELOW, 1),
  MAR(CHOMA, '05-09', 'F', BELOW, 1, P_WITHIN, 1),
  MAR(['Western', null, 'No District Clinic'], '30-34', 'M', ADV, 1),
  MAR(['Western', 'Mongu', 'Mongu Clinic'], '30-34', 'M', ADV, 1),
];

// ---------------------------------------------------------------- HPV ----
// An HPV request: panel HPV (line 35), with a report whose issued date is the authorised date (line 37). Tested at LUS by default.
const hpv = (labId, results, o = {}) => f19.add(`T19-${labId}`, {
  panel: 'HPV', report: true, req: 'ZSOUT', authored: '2026-05-01T08:00:00Z', issued: '2026-05-10T10:00:00Z', performer: 'LUS', display: 'Lusaka Lab',
  results: results.map(([obs, text, extra]) => ({ obs, text, ...extra })), ...o,
});

// Cell HA: ZSOUT, lab LUS, May 2026, no analyser (Conventional). Every measure, list member and filter.
hpv('HA01', [['HPVHR', 'Positive']]);
hpv('HA02', [['HPV16', 'POSITIVE']]);
hpv('HA03', [['HPV18', 'Positive*']]);
hpv('HA04', [['HPVOT', 'REACTIVE']]);
hpv('HA05', [['HPVHR', 'Negative']]);
hpv('HA06', [['HPV16', 'Negative*']]);
hpv('HA07', [['HPVHR', 'positive ']]);
hpv('HA08', [['HPV16', 'Positive**']]);
hpv('HA09', [['HPVOT', 'Pos']]);
hpv('HA10', [['HPV18', null]]);
hpv('HA11', [['HPVHR', 'Reactive']]);
hpv('HA12', [['STXT', 'Positive']]);                           // comment results do not count (line 36)
hpv('HA13', [['SCOM', 'Positive']]);
hpv('HA14', [['HPVX', 'Positive']]);                           // another observation: a test and a positive, but no type
hpv('HA15', [['HPV16', 'Positive'], ['HPV18', 'Positive']]);   // two types: one positive request, counted in both types
hpv('HA16', [['HPV16', 'Positive'], ['STXT', 'Positive']]);
hpv('HA17', [['STXT', 'Negative'], ['HPVHR', 'Negative']]);
hpv('HA18', [['HPV16', 'Positive'], ['HPV16', 'Positive']]);   // the same result twice: one request
hpv('HA19a', [['HPVHR', 'Positive']], { panel: 'POHPV' });
hpv('HA19b', [['HPV16', 'Positive']], { panel: 'HPVGT' });
hpv('HA19c', [['HPVHR', 'Negative']], { panel: 'hpv ' });
hpv('HA19x', [['HPVHR', 'Positive']], { panel: 'HPVX' });      // other panels are out
hpv('HA19y', [['HPVHR', 'Positive']], { panel: 'HPV2' });
hpv('HA19z', [['HPVHR', 'Positive']], { panel: 'CD4' });
hpv('HA19n', [['HPVHR', 'Positive']], { panel: null });
hpv('HA20a', [['hpv16', 'Positive']]);
hpv('HA20b', [['HPV16 ', 'Positive']]);
hpv('HA20c', [['stxt ', 'Positive']]);                         // 'stxt ' is STXT: out
hpv('HA20d', [[null, 'Positive']]);                            // NOT IN with a missing observation is unknown: out
hpv('HA21', [['HPVHR', 'Negative']]);
hpv('ha21 ', [['HPVHR', 'Negative']]);                         // the same request number as HA21 (case and a trailing space): counts once
hpv('HA22', [['HPV16', null, { coded: 'Positive' }]]);         // only a coded value: LIMSRptResult shows it

// Cell HB: the join does not carry the lab type (lines 215-219), so rows multiply. ZLUSA, lab KIT, May 2026.
const kit = { req: 'ZLUSA', performer: 'KIT', display: 'Kitwe Lab' };
hpv('HB-g1', [['HPV16', 'Positive']], { ...kit, analyzer: 'GEN123' });
hpv('HB-g2', [['HPV16', 'Negative']], { ...kit, analyzer: 'GEN9' });
hpv('HB-c1', [['HPV18', 'Positive']], { ...kit, analyzer: 'ABC' });
hpv('HB-c2', [['HPV18', 'Positive']], { ...kit, analyzer: 'ABC' });
hpv('HB-c3', [['HPVHR', 'Negative']], { ...kit, analyzer: 'ABC' });
hpv('HB-u1', [['HPVHR', 'Positive']], { ...kit, analyzer: '' });

// Cell HC: the lab type (lines 12-14). ZKAFU, lab NDO, May 2026; every result negative so no row multiplies.
[['gx1', 'GEN123'], ['gx2', 'gen'], ['cv1', ' GEN1'], ['cv2', 'XGEN'], ['cv3', null], ['cv4', 'ABC'], ['un1', ''], ['un2', '   ']]
  .forEach(([id, analyzer]) => hpv(`HC-${id}`, [['HPVHR', 'Negative']], { req: 'ZKAFU', performer: 'NDO', display: 'Ndola Lab', analyzer }));

// Cell HD: the window (line 37), ZSOUT, lab WIN, results negative. From 2026-04-01 to 2026-06-30: 00:00:01 on the first day to 23:59:59 on the last.
[
  ['d01', '2026-04-01T00:00:00Z'], ['d02', '2026-04-01T00:00:01Z'], ['d03', '2026-04-01T00:00:30+02:00'], ['d04', '2026-04-01T00:00:00+02:00'],
  ['d05', '2026-03-31T23:59:59Z'], ['d06', '2026-03-31T23:30:00-02:00'], ['d07', '2026-06-30T23:59:59Z'], ['d08', '2026-06-30T23:59:59+02:00'],
  ['d09', '2026-07-01T00:00:00Z'], ['d10', '2026-07-01T00:30:00+02:00'], ['d11', '2026-06-30'], ['d12', '2026-04-01'],
  ['d13', '2026-04'], ['d13b', null], ['d13c', 'garbage'], ['d14', '2026-06-30T23:59:58Z'], ['d15', '2026-05-31T23:30:00+02:00'],
  ['d16', '2026-06-01T00:30:00+02:00'], ['d17', '2026-05-01T00:30:00+02:00'],
].forEach(([id, issued]) => hpv(`HD-${id}`, [['HPVHR', 'Negative']], { performer: 'WIN', display: 'Window Lab', issued }));
hpv('HD-d18', [['HPVHR', 'Negative']], { performer: 'WIN', display: 'Window Lab', status: 'cancelled', issued: '2026-05-12T10:00:00Z' }); // no status filter
hpv('HD-d19', [['HPVHR', 'Negative']], { performer: 'WIN', display: 'Window Lab', report: false });                                           // no report: no authorised date

// Cell HE: the requesting facility and the testing lab (lines 27-34, 220). Lab LUS unless said; May 2026.
hpv('HE-1', [['HPV16', 'Positive']], { req: 'ZNODS' });         // no district: the join to the positives fails (null never equals null)
hpv('HE-2', [['HPVHR', 'Negative']], { req: 'ZNODS' });
hpv('HE-3', [['HPVHR', 'Positive']], { req: 'ZNONM' });         // no facility name: the same
hpv('HE-4', [['HPVHR', 'Negative']], { req: 'ZNONM' });
hpv('HE-5', [['HPVHR', 'Positive']], { req: 'ZKAFU', performer: null, display: 'Ignored Name' });   // no testing lab: no lab name, and no join
hpv('HE-6', [['HPVHR', 'Negative']], { req: 'ZKAFU', performer: '', display: 'Ignored 2' });
hpv('HE-7', [['HPVHR', 'Negative']], { req: 'ZKAFU', performer: '  ', display: 'Ignored 3' });
hpv('HE-8', [['HPVHR', 'Positive']], { req: 'ZUNMP' });         // not in the register, no province, unknown code, no code: out
hpv('HE-9', [['HPVHR', 'Positive']], { req: 'ZNORG' });
hpv('HE-10', [['HPVHR', 'Positive']], { req: 'ZNONE' });
hpv('HE-11', [['HPVHR', 'Positive']], { req: null });

// Cell HF: lab names and folds. One name per testing code, the same on every row of the code.
hpv('HF-1', [['HPVHR', 'Positive']], { req: 'ZLUSA', performer: 'LAB1', display: 'Zeta Lab' });
hpv('HF-2', [['HPVHR', 'Positive']], { req: 'ZLUS2', performer: 'lab1 ', display: 'Alpha Lab' });
hpv('HF-3', [['HPVHR', 'Negative']], { req: 'ZLUSA', performer: 'Lab1', display: null });
hpv('HF-4', [['HPVHR', 'Negative']], { performer: 'LAB1', display: 'Mid Lab', issued: '2026-04-15T10:00:00Z' });
hpv('HF-5', [['HPVHR', 'Negative']], { performer: 'BARE', display: null });
hpv('HF-6', [['HPVHR', 'Negative']], { performer: 'bare', display: 'Bare Lab', issued: '2026-06-10T10:00:00Z' });
hpv('HF-7', [['HPVHR', 'Negative']], { performer: 'ZPERF', display: null });
hpv('HF-8', [['HPVHR', 'Negative']], { performer: 'XYZ', display: '   ' });
hpv('HF-9', [['HPVHR', 'Negative']], { performer: 'SHARE', display: 'Zed Share' });
hpv('HF-10', [['HPVHR', 'Negative']], { req: 'ZUNMP', performer: 'share', display: 'Aaa Share' });  // a name from a report of an unmapped facility still names the code

// Cell HT: the join needs the province. Two 'Twin Clinic' in a district 'Twin', one Eastern and one Western; the positive is in the Western one.
hpv('HT-1', [['HPVHR', 'Negative']], { req: 'ZTWE', performer: 'TWL', display: 'Twin Lab' });
hpv('HT-2', [['HPVHR', 'Positive']], { req: 'ZTWW', performer: 'TWL', display: 'Twin Lab' });

// Window two: Jan 2025 to Jan 2026, ZSOUT, lab YR. The year and the month are part of the join.
const yr = { performer: 'YR', display: 'Year Lab' };
hpv('HY-e1', [['HPVHR', 'Negative']], { ...yr, issued: '2025-12-31T23:30:00+02:00' });
hpv('HY-e2', [['HPV16', 'Positive']], { ...yr, issued: '2026-01-01T00:30:00+02:00' });
hpv('HY-e7', [['HPV16', 'Positive']], { ...yr, issued: '2025-01-15T10:00:00Z' });
hpv('HY-e8', [['HPVHR', 'Negative']], { ...yr, issued: '2025-01-20' });
hpv('HY-e9', [['HPVHR', 'Negative']], { ...yr, issued: '2025-01-01T00:00:00Z' });
hpv('HY-e10', [['HPVHR', 'Negative']], { ...yr, issued: '2025-01-01T00:00:01Z' });
hpv('HY-e11', [['HPVHR', 'Negative']], { ...yr, issued: '2026-01-31T23:59:59Z' });
hpv('HY-e12', [['HPVHR', 'Negative']], { ...yr, issued: '2026-02-01T00:00:00Z' });

// Order fixture, 10 January 2029.
const ord29 = { issued: '2029-01-10T10:00:00Z' };
hpv('HO-1', [['HPVHR', 'Negative']], ord29);
hpv('HO-2', [['HPVHR', 'Negative']], { ...ord29, analyzer: 'GEN1' });
hpv('HO-3', [['HPVHR', 'Negative']], { ...ord29, req: 'ZLUSA' });
hpv('HO-4', [['HPVHR', 'Negative']], { ...ord29, req: 'ZNODS' });
hpv('HO-5', [['HPVHR', 'Negative']], { ...ord29, performer: 'KIT', display: 'Kitwe Lab' });
hpv('HO-6', [['HPVHR', 'Negative']], { ...ord29, performer: null });

// ---- Expected HPV rows ----
const HPV_COLUMNS = ['Province', 'District', 'Description', 'LabName', 'LabType', 'Year', 'Month', 'Tests', 'Positives', 'HPV16', 'HPV18', 'HPVOT', 'HPVHR'];
const hpvRow = (place, lab, type, year, month, tests, positives = 0, h16 = 0, h18 = 0, hot = 0, hr = 0) => ({
  Province: place[0], District: place[1], Description: place[2], LabName: lab, LabType: type, Year: year, Month: month,
  Tests: tests, Positives: positives, HPV16: h16, HPV18: h18, HPVOT: hot, HPVHR: hr,
});
const CV = 'Conventional';
const GX = 'GeneXpert';
const UN = 'Unrecorded';
const want19Hpv = [
  // HA: 23 tests (01-11, 14-18, 19a-c, 20a-b, 21, 22), 15 positive, 8 HPV16, 2 HPV18, 1 HPVOT, 4 HPVHR. The HPVOT count of 1 is the repaired join
  // (v1 matches the month to the year, so v1 shows 0).
  hpvRow(CHOMA, 'Lusaka Lab', CV, 2026, 5, 23, 15, 8, 2, 1, 4),
  // HB: 3 test rows (lab types) meet 3 positive rows (1, 2, 1), each with the one HPV16 row (1), the one HPV18 row (2) and the one HPVHR row (1).
  ...[[GX, 2], [CV, 3], [UN, 1]].flatMap(([type, tests]) => [1, 2, 1].map((p) => hpvRow(CHILENJE, 'Kitwe Lab', type, 2026, 5, tests, p, 1, 2, 0, 1))),
  // HC
  hpvRow(KAFUE, 'Ndola Lab', GX, 2026, 5, 2),
  hpvRow(KAFUE, 'Ndola Lab', CV, 2026, 5, 4),
  hpvRow(KAFUE, 'Ndola Lab', UN, 2026, 5, 2),
  // HD
  hpvRow(CHOMA, 'Window Lab', CV, 2026, 4, 2),
  hpvRow(CHOMA, 'Window Lab', CV, 2026, 5, 3),
  hpvRow(CHOMA, 'Window Lab', CV, 2026, 6, 5),
  // HE
  hpvRow(['Western', null, 'No District Clinic'], 'Lusaka Lab', CV, 2026, 5, 2),
  hpvRow(['Eastern', 'Chipata', null], 'Lusaka Lab', CV, 2026, 5, 2),
  hpvRow(KAFUE, null, CV, 2026, 5, 3),
  // HT
  hpvRow(['Eastern', 'Twin', 'Twin Clinic'], 'Twin Lab', CV, 2026, 5, 1),
  hpvRow(['Western', 'Twin', 'Twin Clinic'], 'Twin Lab', CV, 2026, 5, 1, 1, 0, 0, 0, 1),
  // HF
  hpvRow(['LUSAKA', 'Lusaka', 'CHILENJE CLINIC '], 'Alpha Lab', CV, 2026, 5, 3, 2, 0, 0, 0, 2),
  hpvRow(CHOMA, 'Alpha Lab', CV, 2026, 4, 1),
  hpvRow(CHOMA, 'Bare Lab', CV, 2026, 5, 1),
  hpvRow(CHOMA, 'Bare Lab', CV, 2026, 6, 1),
  hpvRow(CHOMA, 'Perf Lab Register', CV, 2026, 5, 1),
  hpvRow(CHOMA, 'XYZ', CV, 2026, 5, 1),
  hpvRow(CHOMA, 'Aaa Share', CV, 2026, 5, 1),
];
const want19HpvWin2 = [
  hpvRow(CHOMA, 'Year Lab', CV, 2025, 12, 1),
  hpvRow(CHOMA, 'Year Lab', CV, 2026, 1, 2, 1, 1),
  hpvRow(CHOMA, 'Year Lab', CV, 2025, 1, 3, 1, 1),
];
const want19HpvOrder = [
  hpvRow(CHILENJE, 'Lusaka Lab', CV, 2029, 1, 1),
  hpvRow(CHOMA, null, CV, 2029, 1, 1),
  hpvRow(CHOMA, 'Kitwe Lab', CV, 2029, 1, 1),
  hpvRow(CHOMA, 'Lusaka Lab', CV, 2029, 1, 1),
  hpvRow(CHOMA, 'Lusaka Lab', GX, 2029, 1, 1),
  hpvRow(['Western', null, 'No District Clinic'], 'Lusaka Lab', CV, 2029, 1, 1),
];

// ---- Suites ----
const W19 = { from: '2026-05-01', to: '2026-05-31' };
const W19_WIN2 = { from: '2025-01-01', to: '2026-01-31' };
const W19_WIN3 = { from: '2027-01-01', to: '2027-12-31' };
const W19_ORD28 = { from: '2028-03-01', to: '2028-03-31' };
const H19 = { from: '2026-04-01', to: '2026-06-30' };
const H19_ORD = { from: '2029-01-01', to: '2029-01-31' };
const EMPTY_19 = { from: '2031-01-01', to: '2031-12-31' };
const orderNeedles19 = (names) => names.map((n) => `res.${n}`);

const suites19 = [
  // The fixture rows go in the first suite only.
  setSuite17('cd4-main', CD4_19, W19, CD4_COLUMNS, want19, f19.setup()),
  setSuite17('cd4-window-two', CD4_19, W19_WIN2, CD4_COLUMNS, want19Win2),
  setSuite17('cd4-month-names', CD4_19, W19_WIN3, CD4_COLUMNS, want19Win3),
  setSuite17('cd4-empty', CD4_19, EMPTY_19, CD4_COLUMNS, []),
  orderedSuite17('cd4-order', CD4_19, W19_ORD28, CD4_COLUMNS, want19Order),
  shapeSuite17('cd4-shape', CD4_19, orderNeedles19(['year', 'month', 'month_name', 'province', 'district', 'facility', 'age_group', 'sex', 'abs_range', 'abs_tests', 'pct_range', 'pct_tests'])),
  setSuite17('hpv-main', HPV_19, H19, HPV_COLUMNS, want19Hpv),
  setSuite17('hpv-window-two', HPV_19, W19_WIN2, HPV_COLUMNS, want19HpvWin2),
  setSuite17('hpv-empty', HPV_19, EMPTY_19, HPV_COLUMNS, []),
  orderedSuite17('hpv-order', HPV_19, H19_ORD, HPV_COLUMNS, want19HpvOrder),
  shapeSuite17('hpv-shape', HPV_19, orderNeedles19(['province', 'district', 'description', 'lab_name', 'lab_type', 'year', 'month', 'tests', 'positives', 'hpv16', 'hpv18', 'hpvot', 'hpvhr'])),
];

export const groups = [
  { name: 't5-recency', suites: recencySuites },
  { name: 't5-surveillance', suites: survSuites },
  { name: 't17', suites: suites17 },
  { name: 't18', suites: suites18 },
  { name: 't19', suites: suites19 },
];

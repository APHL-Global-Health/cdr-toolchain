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

export const groups = [
  { name: 't5-recency', suites: recencySuites },
  { name: 't5-surveillance', suites: survSuites },
];

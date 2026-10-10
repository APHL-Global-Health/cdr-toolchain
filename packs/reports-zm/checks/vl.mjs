// Check groups for the vl reports. Each task adds { name, suites } entries to this list.
//
// Group t2: the hivvl builder (v1 sp_update_HIVVLTable, Table__dbo_HIVVL.sql and
// sp_remove_dupsHIVVLEID). Fixture ids start with "t2-". Lab ids (lr.request_id) start with "T2-",
// "123-", "1E5-" or "12A-".
// "v1 line N" below means a line of StoredProcedure__dbo_sp_update_HIVVLTable.sql.

import { lit, inOrder, caseSuite } from '../../shared/pg-check.mjs';
import { ATTR_SYSTEM, hivvlCte, tndCte } from '../zm-sql.mjs';
import { queries, rateCutSql } from '../queries/vl.mjs';
import { epiFixture, facilityRows, orderedSuite as orderedSuite10, shapeSuite } from './epi-fixture.mjs';

// ---- Fixture builder ----

const COLUMNS = ['province', 'district', 'facility', 'lab_id', 'gender', 'age_group', 'tested_date',
  'suppressed', 'uu', 'tat', 'tat_within14', 'pregnant', 'breastfeeding', 'baseline_vl', 'run_date',
  'received_date', 'registered_date', 'collected_date', 'tested_at', 'referral', 'disalink',
  'three_m_post_unsuppressed', 'poc', 'poc_w48h'];

const REQ_DEFAULTS = {
  panel: 'HIVVL', status: 'final', req: 'ZSOUT', sex: 'F', age: 30,
  authored: '2026-05-02T08:00:00Z', analysis: '2026-05-02T09:00:00Z',
  effective: '2026-05-01T07:00:00Z', issued: '2026-05-10T10:00:00Z', received: '2026-05-01T12:00:00Z',
  performer: 'LUS', results: [{ obs: 'HIVVL', num: 540 }], attrs: [], form: null, noReport: false,
};
// What a default request produces. Written out by hand from the v1 text.
const D = {
  province: 'Southern', district: 'Choma', facility: 'Choma General Hospital', lab_id: null,
  gender: 'Female', age_group: '30-34',
  tested_date: '2026-05-10T10:00:00Z', // v1 line 71: AuthorisedDateTime
  suppressed: 1,                       // v1 line 89: 540 < 1000
  uu: 0,                               // v1 line 95: 540 is not under 200
  tat: 9,                              // v1 line 96: datediff(dd, 05-01, 05-10)
  tat_within14: 1,
  pregnant: null, breastfeeding: null, baseline_vl: null,
  run_date: '2026-05-02T09:00:00Z', received_date: '2026-05-01T12:00:00Z',
  registered_date: '2026-05-02T08:00:00Z', collected_date: '2026-05-01T07:00:00Z',
  tested_at: 'LUS',
  referral: null,                      // ReceivingFacilityCode is not carried (ruling 7)
  disalink: 0,
  three_m_post_unsuppressed: null,
  poc: 0, poc_w48h: 0,
};

const num = (v) => (v === null || v === undefined ? 'null' : String(v));
const pad = (n) => String(n).padStart(3, '0');
const patients = [];
const requests = [];
const reports = [];
const specimens = [];
const results = [];
const attrs = [];
const forms = [];
const expected = [];
let seq = 0;

// One lab id with one or more request rows (v1 Requests rows sharing a RequestID). `want` is the
// hivvl row v1 would keep for the lab id (after sp_remove_dupsHIVVLEID), or null for no row.
function lab(labId, reqs, want) {
  for (const o of reqs) {
    const r = { ...REQ_DEFAULTS, ...o };
    const n = ++seq;
    const qid = `t2-q${pad(n)}`;
    let patientId = null;
    if (r.sex !== undefined && r.sex !== null) {
      patientId = `t2-p${pad(n)}`;
      patients.push(`(${lit(patientId)}, ${lit('P' + n)}, ${lit(r.sex)})`);
    }
    requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.authored)}, ${lit(r.analysis)}, ${lit(r.req)}, ${lit(patientId)}, ${num(r.age)})`);
    if (!r.noReport) {
      const sid = r.received ? `t2-s${pad(n)}` : null;
      if (sid) specimens.push(`(${lit(sid)}, ${lit(r.received)})`);
      reports.push(`(${lit(`t2-d${pad(n)}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.effective)}, ${lit(r.issued)}, ${lit(r.performer)}, ${lit(sid)})`);
    }
    r.results.forEach((x, i) => {
      results.push(`(${lit(`t2-r${pad(n)}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${num(x.num)}, ${lit(x.cmp ?? null)})`);
    });
    r.attrs.forEach(([system, code, value], i) => {
      attrs.push(`(${lit(`t2-a${pad(n)}-${i + 1}`)}, ${lit(qid)}, ${lit(system)}, ${lit(code)}, ${lit(value)})`);
    });
    if (r.form) {
      const code = r.form.code ?? 'hiv_vl_documentation';
      const items = r.form.answers.map(([linkId, text]) => ({ linkId, answer: [{ valueString: text }] }));
      forms.push(`(${lit(`t2-f${pad(n)}`)}, 'q', ${lit(code)}, ${lit(qid)}, '2026-05-02T08:00:00Z', ${lit(JSON.stringify(items))})`);
    }
  }
  if (want) expected.push({ ...D, ...want, lab_id: labId });
}

const ATTR = (code, value) => [ATTR_SYSTEM, code, value];
const VIRAL = (answers, code) => ({ answers, code });

// ---- The cases ----

// A default request: every column from the defaults.
lab('T2-BASIC', [{}], {});

// Two results on one request: the row with the lower result id is kept (the port's tie-break; v1 keeps
// either). 'Target Not Detected' counts as suppressed and UU. ZUE stays ZUE.
// v1 lines 87 and 95 (lists), 77-79 (ZUE not renamed), 96 (10 days).
lab('T2-TND', [{ sex: 'M', age: 41, effective: '2026-05-01T08:00:00Z', issued: '2026-05-11T10:00:00Z', performer: 'ZUE',
  results: [{ obs: 'HIVVL', text: 'Target Not Detected' }, { obs: 'HIVVC', num: 1500 }] }],
{ gender: 'Male', age_group: '40-44', tested_date: '2026-05-11T10:00:00Z', suppressed: 1, uu: 1, tat: 10,
  collected_date: '2026-05-01T08:00:00Z', tested_at: 'ZUE' });

// The dedupe (sp_remove_dupsHIVVLEID lines 19-30): two request rows, one lab id. The earlier tested date is kept.
// The POHVL panel and POCVR observation are accepted (v1 lines 120-121).
lab('T2-DUP', [
  { issued: '2026-05-12T10:00:00Z', results: [{ obs: 'HIVVL', num: 100 }] },
  { panel: 'POHVL', issued: '2026-05-08T10:00:00Z', authored: '2026-05-03T08:00:00Z', analysis: '2026-05-04T09:00:00Z',
    received: '2026-05-02T12:00:00Z', results: [{ obs: 'POCVR', num: 3000 }] },
], { tested_date: '2026-05-08T10:00:00Z', suppressed: 0, uu: 0, tat: 7, run_date: '2026-05-04T09:00:00Z',
  received_date: '2026-05-02T12:00:00Z', registered_date: '2026-05-03T08:00:00Z' });
// SQL Server sorts NULL first, so a row without a tested date wins the dedupe. TAT is NULL, TATWithin14 is 0 (line 97 else).
lab('T2-DUPNULL', [{ issued: null }, { issued: '2026-05-14T10:00:00Z' }],
  { tested_date: null, tat: null, tat_within14: 0 });
// The earlier row is in April, outside the May window. It stays the only row, so the window shows nothing.
lab('T2-DUPOLD', [
  { effective: '2026-04-15T07:00:00Z', issued: '2026-04-20T10:00:00Z', authored: '2026-04-16T08:00:00Z',
    analysis: '2026-04-17T09:00:00Z', received: '2026-04-15T12:00:00Z' },
  { issued: '2026-05-15T10:00:00Z' },
], { tested_date: '2026-04-20T10:00:00Z', tat: 5, collected_date: '2026-04-15T07:00:00Z',
  registered_date: '2026-04-16T08:00:00Z', run_date: '2026-04-17T09:00:00Z', received_date: '2026-04-15T12:00:00Z' });

// A date-only tested date sorts as midnight of its date (v1 datetime), not as NULL: the 05-08 row wins over a
// 05-09 date-only row. The date-only row's result (3000) would show suppressed 0 if it won.
lab('T2-DUPDATEONLY', [
  { issued: '2026-05-09', results: [{ obs: 'HIVVL', num: 3000 }] },
  { issued: '2026-05-08T10:00:00Z', results: [{ obs: 'HIVVL', num: 540 }] },
], { tested_date: '2026-05-08T10:00:00Z', tat: 7 });
// Panel and observation compare like SQL Server: ignoring case and trailing spaces (v1 lines 120-121).
lab('T2-CODECASE', [{ panel: 'hivvl ', results: [{ obs: 'hivvc ', num: 540 }] }], {});

// The valid-result filter (v1 lines 123-133): a row passes only when the result is in the first list or is a
// number. DET, PLTT and '<883 copies/mL' sit in the suppressed list (line 87) but not in this list.
lab('T2-NOTVALID', [{ results: [
  { obs: 'HIVVL', text: 'INVAL' }, { obs: 'HIVVL', text: 'DET' }, { obs: 'HIVVL', text: 'PLTT' },
  { obs: 'HIVVL', text: '<883 copies/mL' }, { obs: 'HIVVL', text: 'Positive' }, { obs: 'HIVVL', text: 'Detected' },
  { obs: 'HIVVL', cmp: '>', num: 5000000 },
] }], null);
// ISNUMERIC('5,000') is 1, so it passes. SIValue is NULL and the text is in no list: not suppressed, not UU.
lab('T2-COMMA', [{ results: [{ obs: 'HIVVL', text: '5,000' }] }], { suppressed: 0, uu: 0 });
lab('T2-TEXTNUM', [{ results: [{ obs: 'HIVVL', text: '120' }] }], { suppressed: 0, uu: 0 });
// '< 20' is in both lists (lines 87, 124); SIValue 20 is under 200.
lab('T2-LT20', [{ results: [{ obs: 'HIVVL', cmp: '<', num: 20 }] }], { suppressed: 1, uu: 1 });
lab('T2-N150', [{ results: [{ obs: 'HIVVL', num: 150 }] }], { suppressed: 1, uu: 1 });
lab('T2-N200', [{ results: [{ obs: 'HIVVL', num: 200 }] }], { suppressed: 1, uu: 0 });
lab('T2-N1000', [{ results: [{ obs: 'HIVVL', num: 1000 }] }], { suppressed: 0, uu: 0 });
// Lists compare ignoring case and trailing spaces.
lab('T2-NDET', [{ results: [{ obs: 'HIVVL', text: 'ndet ' }] }], { suppressed: 1, uu: 1 });
// PTLTV is in the valid list and the suppressed list, not the UU list.
lab('T2-PTLTV', [{ results: [{ obs: 'HIVVL', text: 'PTLTV' }] }], { suppressed: 1, uu: 0 });
lab('T2-HIVTM', [{ results: [{ obs: 'HIVTM', num: 50 }] }], { suppressed: 1, uu: 1 });
lab('T2-OBS', [{ results: [{ obs: 'OTHER', num: 100 }] }], null);          // v1 line 121
lab('T2-PANEL', [{ panel: 'VIRAL' }], null);                               // v1 line 120
lab('T2-CANC', [{ status: 'cancelled', issued: null }], null);             // v1 line 122
lab('T2-UNMAPPED', [{ req: 'ZUNMP' }], null);                              // v1 inner join, line 109
lab('T2-NOFAC', [{ req: 'ZNONE' }], null);
lab('T2-LUSAKA', [{ req: 'ZLUSA' }], { province: 'Lusaka', district: 'Lusaka', facility: 'Chilenje Clinic' });

// The window edges (tested date 2026-05-01 to 2026-05-31). TAT counts date boundaries from 2026-04-28.
lab('T2-EDGE-IN1', [{ effective: '2026-04-28T10:00:00Z', issued: '2026-05-01T00:00:00Z' }],
  { tested_date: '2026-05-01T00:00:00Z', collected_date: '2026-04-28T10:00:00Z', tat: 3, tat_within14: 1 });
lab('T2-EDGE-IN2', [{ effective: '2026-04-28T10:00:00Z', issued: '2026-05-31T23:59:59Z' }],
  { tested_date: '2026-05-31T23:59:59Z', collected_date: '2026-04-28T10:00:00Z', tat: 33, tat_within14: 0 });
lab('T2-EDGE-OUT1', [{ effective: '2026-04-28T10:00:00Z', issued: '2026-04-30T23:59:59Z' }],
  { tested_date: '2026-04-30T23:59:59Z', collected_date: '2026-04-28T10:00:00Z', tat: 2, tat_within14: 1 });
lab('T2-EDGE-OUT2', [{ effective: '2026-04-28T10:00:00Z', issued: '2026-06-01T00:00:00Z' }],
  { tested_date: '2026-06-01T00:00:00Z', collected_date: '2026-04-28T10:00:00Z', tat: 34, tat_within14: 0 });

// Age groups (v1 lines 56-70): zero-padded labels; 45 to 49 is its own group, 50 and over is '50+'.
// A negative or missing age is NULL.
const AGES = [[0, '<01'], [1, '01-04'], [4, '01-04'], [5, '05-09'], [9, '05-09'], [10, '10-14'], [14, '10-14'],
  [15, '15-19'], [19, '15-19'], [20, '20-24'], [24, '20-24'], [25, '25-29'], [29, '25-29'], [30, '30-34'],
  [34, '30-34'], [35, '35-39'], [39, '35-39'], [40, '40-44'], [44, '40-44'], [45, '45-49'], [49, '45-49'],
  [50, '50+'], [80, '50+'], [-1, null], [null, null]];
AGES.forEach(([age, group]) => lab(`T2-AGE-${age}`, [{ age }], { age_group: group }));

// Sex (v1 lines 49-55): F, M, I, U only; anything else, a missing value and a missing patient give NULL.
// The compare ignores case and trailing spaces.
const SEXES = [['F', 'Female'], ['M', 'Male'], ['I', 'Indeterminate'], ['U', 'Unknown'], ['X', null], ['O', null],
  ['N', null], ['m ', 'Male'], ['i', 'Indeterminate'], ['', null]];
SEXES.forEach(([sex, gender], i) => lab(`T2-SEX-${i}`, [{ sex }], { gender }));
lab('T2-SEX-NOPATIENT', [{ sex: null }], { gender: null });

// TestedAt (v1 lines 76-79). The testing code is the performer. ReceivingFacilityCode is not carried, so a blank
// testing code gives NULL. A 3-letter ZU code other than ZUE and ZUA becomes ZUL. SQL Server LIKE ignores trailing
// blanks in the matched text (non-Unicode data), so 'ZUB ' also becomes ZUL.
const TESTED_AT = [[null, null], ['', null], ['  ', null], ['ZUB', 'ZUL'], ['zub', 'ZUL'], ['ZU1', 'ZUL'],
  ['ZUA', 'ZUA'], ['zue', 'zue'], ['ZUEE', 'ZUEE'], ['ZU', 'ZU'], ['ZUB ', 'ZUL']];
TESTED_AT.forEach(([performer, testedAt], i) => lab(`T2-TA-${i}`, [{ performer }], { tested_at: testedAt }));

// TAT counts date boundaries, not 24-hour periods (v1 line 96). 14 days is within, 15 is not (line 97).
lab('T2-TAT-MID', [{ effective: '2026-05-01T23:30:00Z', issued: '2026-05-02T00:10:00Z' }],
  { tested_date: '2026-05-02T00:10:00Z', collected_date: '2026-05-01T23:30:00Z', tat: 1, tat_within14: 1 });
lab('T2-TAT-14', [{ effective: '2026-05-01T10:00:00Z', issued: '2026-05-15T01:00:00Z' }],
  { tested_date: '2026-05-15T01:00:00Z', collected_date: '2026-05-01T10:00:00Z', tat: 14, tat_within14: 1 });
lab('T2-TAT-15', [{ effective: '2026-05-01T10:00:00Z', issued: '2026-05-16T01:00:00Z' }],
  { tested_date: '2026-05-16T01:00:00Z', collected_date: '2026-05-01T10:00:00Z', tat: 15, tat_within14: 0 });
// Dates are local (DISA writes local wall time with its offset): TAT takes each date from the stamp's own text.
// In UTC the first row would be 04-30 to 05-15, so 15 days and not within 14 (v1 gives 14 and 1).
lab('T2-TZ-14', [{ effective: '2026-05-01T01:00:00+02:00', issued: '2026-05-15T10:00:00+02:00' }],
  { tested_date: '2026-05-15T10:00:00+02:00', collected_date: '2026-05-01T01:00:00+02:00', tat: 14, tat_within14: 1 });
// Local 05-03 to 05-04 is 1 day; in UTC it is 05-02 to 05-04 (2 days).
lab('T2-TZ-ORD', [{ effective: '2026-05-03T00:30:00+02:00', issued: '2026-05-04T23:45:00+02:00' }],
  { tested_date: '2026-05-04T23:45:00+02:00', collected_date: '2026-05-03T00:30:00+02:00', tat: 1, tat_within14: 1 });
// A date-only stamp still gives its date. A partial stamp ('2026-07') is not a date: TAT is NULL and the query does not fail.
lab('T2-TAT-DATEONLY', [{ effective: '2026-05-05' }], { collected_date: '2026-05-05', tat: 5, tat_within14: 1 });
lab('T2-TAT-PARTIAL', [{ effective: '2026-07' }], { collected_date: '2026-07', tat: null, tat_within14: 0 });
lab('T2-TAT-NOCOL', [{ effective: null }], { collected_date: null, tat: null, tat_within14: 0 });

// POC (v1 line 102): a numeric testing code, or a lab id whose first 3 characters are numeric.
// POCW48H (line 103) counts hour boundaries, so 24 boundaries pass even when 24h40m passed.
lab('T2-POC-PERF', [{ performer: '4567', effective: '2026-05-10T08:10:00Z', issued: '2026-05-11T08:50:00Z' }],
  { tested_date: '2026-05-11T08:50:00Z', collected_date: '2026-05-10T08:10:00Z', tested_at: '4567', tat: 1, poc: 1, poc_w48h: 1 });
lab('T2-POC-25H', [{ performer: '4567', effective: '2026-05-10T08:50:00Z', issued: '2026-05-11T09:10:00Z' }],
  { tested_date: '2026-05-11T09:10:00Z', collected_date: '2026-05-10T08:50:00Z', tested_at: '4567', tat: 1, poc: 1, poc_w48h: 0 });
lab('T2-POC-23H', [{ performer: '12', effective: '2026-05-10T08:30:00Z', issued: '2026-05-11T07:55:00Z' }],
  { tested_date: '2026-05-11T07:55:00Z', collected_date: '2026-05-10T08:30:00Z', tested_at: '12', tat: 1, poc: 1, poc_w48h: 1 });
lab('T2-POC-NOCOL', [{ performer: '4567', effective: null }],
  { collected_date: null, tested_at: '4567', tat: null, tat_within14: 0, poc: 1, poc_w48h: 0 });
const SAME_DAY = { effective: '2026-05-10T10:00:00Z', issued: '2026-05-10T20:00:00Z' };
const SAME_DAY_WANT = { tested_date: '2026-05-10T20:00:00Z', collected_date: '2026-05-10T10:00:00Z', tat: 0 };
lab('123-LAB', [SAME_DAY], { ...SAME_DAY_WANT, poc: 1, poc_w48h: 1 });
lab('1E5-LAB', [SAME_DAY], { ...SAME_DAY_WANT, poc: 1, poc_w48h: 1 });   // ISNUMERIC('1E5') is 1
lab('12A-LAB', [SAME_DAY], { ...SAME_DAY_WANT, poc: 0, poc_w48h: 0 });
lab('T2-NOPOC-FAST', [SAME_DAY], { ...SAME_DAY_WANT, poc: 0, poc_w48h: 0 });

// Disalink (v1 lines 82-83): a pre-registration facility code, or a referring request id that starts with a
// known facility code (5 characters, not a number), or that starts with a number (3 characters).
const PREREG = 'prereg-registration-facility';
const REFERRING = 'referring-request-id';
lab('T2-DL-PREREG', [{ attrs: [ATTR(PREREG, 'ZSOUT')] }], { disalink: 1 });
lab('T2-DL-PREREG-BLANK', [{ attrs: [ATTR(PREREG, '  ')] }], { disalink: 0 });
lab('T2-DL-REF-FAC', [{ attrs: [ATTR(REFERRING, 'ZSOUT-0001')] }], { disalink: 1 });
lab('T2-DL-REF-LOWER', [{ attrs: [ATTR(REFERRING, 'zsout1')] }], { disalink: 1 });
lab('T2-DL-REF-UNKNOWN', [{ attrs: [ATTR(REFERRING, 'ZNONE-1')] }], { disalink: 0 });
lab('T2-DL-REF-UNMAPPED', [{ attrs: [ATTR(REFERRING, 'ZUNMP-1')] }], { disalink: 0 });
lab('T2-DL-REF-NUM3', [{ attrs: [ATTR(REFERRING, '123456')] }], { disalink: 1 });
lab('T2-DL-REF-NUM2', [{ attrs: [ATTR(REFERRING, '12')] }], { disalink: 1 });
lab('T2-DL-WRONGSYS', [{ attrs: [['urn:other', REFERRING, 'ZSOUT-1']] }], { disalink: 0 });
lab('T2-DL-BOTH', [{ attrs: [ATTR(PREREG, 'ZSOUT'), ATTR(REFERRING, 'ZNONE-1')] }], { disalink: 1 });

// The VIRAL flags (v1 lines 20-23, 30-44) read from the form (ruling 6). A flag is 1 or NULL, never 0.
lab('T2-FL-PREG-ARTPR', [{ form: VIRAL([['ARTPR', 'Yes']]) }], { pregnant: 1 });
lab('T2-FL-PREG-VPREG', [{ form: VIRAL([['VPREG', 'y ']]) }], { pregnant: 1 });
lab('T2-FL-PREG-YEST', [{ form: VIRAL([['ARTPR', 'YEST']]) }], { pregnant: 1 });
lab('T2-FL-PREG-NO', [{ form: VIRAL([['ARTPR', 'No'], ['VPREG', 'Unknown']]) }], {});
lab('T2-FL-PREG-ARTRS', [{ form: VIRAL([['ARTRS', 'Pregnant Mother']]) }], { pregnant: 1 });
lab('T2-FL-BF-ARTBR', [{ form: VIRAL([['ARTBR', 'Yes']]) }], { breastfeeding: 1 });
lab('T2-FL-BF-VBREA', [{ form: VIRAL([['VBREA', 'Yest']]) }], { breastfeeding: 1 });
lab('T2-FL-BF-ARTRS', [{ form: VIRAL([['ARTRS', 'Lactating Mother']]) }], { breastfeeding: 1 });
lab('T2-FL-BOTH', [{ form: VIRAL([['ARTPR', 'Yes'], ['VBREA', 'Y']]) }], { pregnant: 1, breastfeeding: 1 });
lab('T2-FL-BASE-TEXT', [{ form: VIRAL([['ARTRS', 'Baseline VL']]) }], { baseline_vl: 1 });
lab('T2-FL-BASE-UPPER', [{ form: VIRAL([['ARTRS', 'BASE']]) }], { baseline_vl: 1 });
lab('T2-FL-3M-VISIT', [{ form: VIRAL([['VISIT', '3 months post unsuppressed VL result']]) }], { three_m_post_unsuppressed: 1 });
lab('T2-FL-3M-EAC', [{ form: VIRAL([['ARTRS', 'Post EAC']]) }], { three_m_post_unsuppressed: 1 });
lab('T2-FL-3M-CONF', [{ form: VIRAL([['ARTRS', 'Confirmation of Treatment Failure (repeat VL at 3M)']]) }], { three_m_post_unsuppressed: 1 });
lab('T2-FL-OTHER-TEXT', [{ form: VIRAL([['VISIT', 'Routine'], ['ARTRS', 'Something']]) }], {});
// The text counts only under its own question code.
lab('T2-FL-WRONGCODE', [{ form: VIRAL([['VISIT', 'Yes'], ['ARTRS', 'Yes'], ['XXX', 'Yes'], ['ARTBR', 'Pregnant Mother']]) }], {});
lab('T2-FL-OTHERFORM', [{ form: VIRAL([['ARTPR', 'Yes']], 'other_form') }], {});
// An answer on one lab id never reaches another.
lab('T2-FL-SOURCE', [{ form: VIRAL([['ARTPR', 'Yes']]) }], { pregnant: 1 });
lab('T2-FL-NEIGHBOUR', [{}], {});
// The form can sit on another request row of the same lab id (v1's VIRAL panel is its own Requests row).
lab('T2-FL-VIRALREQ', [{}, { panel: 'VIRAL', noReport: true, results: [], form: VIRAL([['ARTPR', 'Yes']]) }], { pregnant: 1 });
// RTRI (v1 line 22): any result row on an RTRI request of the lab id makes it a baseline test.
lab('T2-RTRI', [{}, { panel: 'RTRI', noReport: true, results: [{ obs: 'RTRI', text: 'Recent' }] }], { baseline_vl: 1 });
lab('T2-RTRI-EMPTY', [{}, { panel: 'RTRI', noReport: true, results: [] }], {});

const SETUP = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t2-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t2-fm2', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('t2-fm3', '', '', 'ZUNMP', null, null, null, null);
insert into patients (id, surname, sex) values ${patients.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years) values ${requests.join(',\n  ')};
insert into specimens (id, received_time) values ${specimens.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, specimen_id) values ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator) values ${results.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${attrs.join(',\n  ')};
insert into questionnaire_responses (id, questionnaire, form_code, based_on_id, authored, items) values ${forms.join(',\n  ')};`;

// ---- Suites ----

const bind = (sqlText, params) => Object.entries(params)
  .reduce((s, [k, v]) => s.replaceAll(`{{param.${k}}}`, `'${v.replace(/'/g, "''")}'`), sqlText);

// A suite over `select * from <cte>`: column order, then the exact row set with its count.
function builderSuite(name, setup, cteSql, rows) {
  const key = (r) => JSON.stringify(COLUMNS.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `with ${cteSql} select ${lit(name)} || chr(9) || row_to_json(q)::text from (select * from hv) q;`,
    count: rows.length + 1,
    check(got) {
      const failures = [];
      if (got.length !== rows.length) failures.push(`expected ${rows.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), COLUMNS));
        if (Object.keys(got[0]).length !== COLUMNS.length) failures.push(`expected ${COLUMNS.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const have = got.map(key).sort();
      const want = rows.map(key).sort();
      for (const w of want) if (!have.includes(w)) failures.push(`missing row ${w}`);
      for (const g of have) if (!want.includes(g)) failures.push(`unexpected row ${g}`);
      return failures;
    },
  };
}

const wantRows = expected.filter(Boolean);
// inRange compares the first ten characters of the stamp (its local date).
const inDay = (r, from, to) => r.tested_date !== null && r.tested_date.slice(0, 10) >= from && r.tested_date.slice(0, 10) <= to;

const suites = [
  builderSuite('hivvl-all', SETUP, hivvlCte('hv'), wantRows),
  builderSuite('hivvl-window', '', bind(hivvlCte('hv', { from: 'from', to: 'to' }), { from: '2026-05-01', to: '2026-05-31' }),
    wantRows.filter((r) => inDay(r, '2026-05-01', '2026-05-31'))),
  // Other parameter names, and a one-day window.
  builderSuite('hivvl-window-names', '', bind(hivvlCte('hv', { from: 'start', to: 'end' }), { start: '2026-05-08', end: '2026-05-08' }),
    wantRows.filter((r) => inDay(r, '2026-05-08', '2026-05-08'))),
  {
    name: 'hivvl-shape',
    count: 5,
    check() {
      const text = hivvlCte('anyname');
      const bad = [];
      if (!text.startsWith('anyname as (')) bad.push(`must start with "anyname as (": ${text.slice(0, 30)}`);
      if (hivvlCte('x').includes('{{param.')) bad.push('no window: must not mention a parameter');
      for (const half of [{ from: 'a' }, { to: 'b' }]) {
        try { hivvlCte('x', half); bad.push(`half a window ${JSON.stringify(half)} must throw`); } catch { /* expected */ }
      }
      const windowed = hivvlCte('x', { from: 'a', to: 'b' });
      if (!windowed.includes('{{param.a}}') || !windowed.includes('{{param.b}}')) bad.push('window: must use the given parameter names');
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(text.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      return bad;
    },
  },
];


// ============================================================================================
// Group t6: "VL dashboard summary" (v1 sp_dash_getHIVVL_v2, merging sp_dash_getHIVVL,
// vSuppressionByFacility and vVLQuarterlyFacilitySuppressionRate). Fixture ids start with "t6-";
// lab ids start with "T6-". "v1 line N" is a line of StoredProcedure__dbo_sp_dash_getHIVVL_v2.sql.
//
// The window is [from, to + 1 day] on the local date of the authorised date (v1 lines 21, 130: the
// end date is moved one day forward and the filter is cast(TestedDate as date) between the two).
// ============================================================================================

// The 108 columns of the national branch (v1 lines 24-128), copied from the inventory
// (zm-inv-all.json). The other branches list [AgeMissing] twice (lines 165-166 and so on); the port
// keeps one.
const DASH_COLUMNS = [
  'Province', 'District', 'Facility', 'Tests', 'Tests_POC', 'Suppressed', 'Suppressed_POC', 'Unsuppressed',
  'Undetectable', 'Undetectable_POC', 'SuppressionRate', 'SuppressionRate_POC', 'AverageTAT',
  'AverageTAT_POC', 'TatWithin14', 'TatWithin48h_POC', 'Male', 'Female', 'IndeterminateGender',
  'UnknownGender', 'MissingGender', 'lt01', '1to4', '5to9', '10to14', '15to19', '20to24', '25to29', '30to34',
  '35to39', '40to44', '45to49', '50plus', 'AgeMissing', 'lt01m', '1to4m', '5to9m', '10to14m', '15to19m',
  '20to24m', '25to29m', '30to34m', '35to39m', '40to44m', '45to49m', '50plusm', 'AgeMissingm', 'lt01f',
  '1to4f', '5to9f', '10to14f', '15to19f', '20to24f', '25to29f', '30to34f', '35to39f', '40to44f', '45to49f',
  '50plusf', 'AgeMissingf', 'lt01i', '1to4i', '5to9i', '10to14i', '15to19i', '20to24i', '25to29i', '30to34i',
  '35to39i', '40to44i', '45to49i', '50plusi', 'AgeMissingi', 'lt01u', '1to4u', '5to9u', '10to14u', '15to19u',
  '20to24u', '25to29u', '30to34u', '35to39u', '40to44u', '45to49u', '50plusu', 'AgeMissingu', 'lt01x',
  '1to4x', '5to9x', '10to14x', '15to19x', '20to24x', '25to29x', '30to34x', '35to39x', '40to44x', '45to49x',
  '50plusx', 'AgeMissingx', 'Pregnant', 'PregnantSup', 'BreastFeeding', 'BreastFeedingSup', 'BaselineVL',
  'BaselineVLSup', 'NonBaselineTests', 'NonBaselineVLSuppressed', 'ThreeMPostUnSuppressed',
];

// ---- Fixture rows ----

const P6 = [];
const R6 = [];
const D6 = [];
const L6 = [];
const F6 = [];
let n6 = 0;
const sql6 = (v) => (v === null || v === undefined ? 'null' : String(v));
// One lab id: a request with one result and one report. `o`: req (facility code), sex (null: no patient),
// age, num or text (the result), coll (collected), iss (authorised), perf (the testing code), form
// (VIRAL answers), rtri (a second request on the RTRI panel), status.
function lab6(labId, o) {
  const k = String(++n6).padStart(2, '0');
  const qid = `t6-q${k}`;
  let pid = null;
  if (o.sex !== null && o.sex !== undefined) {
    pid = `t6-p${k}`;
    P6.push(`(${lit(pid)}, ${lit('P' + k)}, ${lit(o.sex)})`);
  }
  R6.push(`(${lit(qid)}, ${lit(labId)}, ${lit(o.panel ?? 'HIVVL')}, '2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', ${lit(o.req)}, ${lit(pid)}, ${sql6(o.age)})`);
  D6.push(`(${lit(`t6-d${k}`)}, ${lit(qid)}, ${lit(o.status ?? 'final')}, ${lit(o.coll)}, ${lit(o.iss)}, ${lit(o.perf ?? 'LUS')})`);
  L6.push(`(${lit(`t6-r${k}`)}, ${lit(qid)}, 'HIVVL', ${lit(o.text ?? null)}, ${sql6(o.num)}, null)`);
  if (o.form) {
    const items = o.form.map(([linkId, text]) => ({ linkId, answer: [{ valueString: text }] }));
    F6.push(`(${lit(`t6-f${k}`)}, 'q', 'hiv_vl_documentation', ${lit(qid)}, '2026-05-02T08:00:00Z', ${lit(JSON.stringify(items))})`);
  }
  if (o.rtri) {
    const rq = `t6-q${k}b`;
    R6.push(`(${lit(rq)}, ${lit(labId)}, 'RTRI', '2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', ${lit(o.req)}, null, null)`);
    L6.push(`(${lit(`t6-r${k}b`)}, ${lit(rq)}, 'RTRI', 'Recent', null, null)`);
  }
}

const CHO = 'ZSOUT';   // Southern / Choma / Choma General Hospital
const CL2 = 'ZCHO2';   // Southern / Choma / Choma Clinic
const MAZ = 'ZMAZA';   // Southern / Mazabuka / Mazabuka Hospital
const LUS = 'ZLUSA';   // Lusaka / Lusaka / Chilenje Clinic
const MAY1 = '2026-05-01T07:00:00Z';

// Choma General Hospital. The comment gives the hivvl row the builder makes (gender, age group, suppressed, ...).
lab6('T6-L01', { req: CHO, sex: 'F', age: 30, num: 540, coll: MAY1, iss: '2026-05-10T10:00:00Z' });                    // Female 30-34, supp 1, uu 0, tat 9
lab6('T6-L02', { req: CHO, sex: 'F', age: 28, text: 'Target Not Detected', coll: '2026-05-01T08:00:00Z', iss: '2026-05-11T10:00:00Z',
  form: [['ARTPR', 'Yes']] });                                                                                         // Female 25-29, supp 1, uu 1, tat 10, pregnant
lab6('T6-L03', { req: CHO, sex: 'M', age: 41, num: 1500, coll: '2026-05-09T08:10:00Z', iss: '2026-05-10T08:50:00Z', perf: '4567' }); // Male 40-44, supp 0, tat 1, POC, 24 hour boundaries
lab6('T6-L04', { req: CHO, sex: 'F', age: 0, num: 100, coll: '2026-05-10T10:00:00Z', iss: '2026-05-12T10:00:00Z', perf: '4567',
  form: [['ARTRS', 'Baseline VL']] });                                                                                 // Female <01, supp 1, uu 1, tat 2, POC, 48 hours, baseline
lab6('T6-L05', { req: CHO, sex: 'U', age: 50, num: 3000, coll: MAY1, iss: '2026-05-16T10:00:00Z',
  form: [['VISIT', '3 months post unsuppressed VL result'], ['VBREA', 'Y']] });                                         // Unknown 50+, supp 0, tat 15 (not within 14), 3 months, breastfeeding
// Choma Clinic.
lab6('T6-L06', { req: CL2, sex: 'I', age: 47, text: '<20 copies/mL', coll: MAY1, iss: '2026-05-06T10:00:00Z',
  form: [['VBREA', 'Y']] });                                                                                           // Indeterminate 45-49, supp 1, uu 0, tat 5, breastfeeding
lab6('T6-L07', { req: CL2, sex: 'X', age: 12, num: 250, coll: '2026-05-20T10:00:00Z', iss: '2026-05-22T10:00:00Z', perf: '12' });   // gender NULL 10-14, supp 1, uu 0, tat 2, POC, 48 hours
lab6('T6-L08', { req: CL2, sex: 'F', age: null, num: 950, coll: MAY1, iss: '2026-05-04T10:00:00Z' });                  // Female, age group NULL, supp 1, tat 3
lab6('T6-L09', { req: CL2, sex: null, age: null, num: 1000, coll: MAY1, iss: '2026-05-08T10:00:00Z',
  form: [['ARTPR', 'Yes']] });                                                                                         // gender NULL, age group NULL, supp 0, tat 7, pregnant
// Mazabuka Hospital: every test is a baseline test.
lab6('T6-L10', { req: MAZ, sex: 'F', age: 22, num: 10, coll: MAY1, iss: '2026-05-05T10:00:00Z', rtri: true });        // Female 20-24, supp 1, uu 1, tat 4, baseline (RTRI request)
lab6('T6-L11', { req: MAZ, sex: 'M', age: 33, num: 5000, coll: MAY1, iss: '2026-05-07T10:00:00Z',
  form: [['ARTRS', 'BASE']] });                                                                                        // Male 30-34, supp 0, tat 6, baseline
// Chilenje Clinic, with stamps that carry +02:00 near midnight.
lab6('T6-L12', { req: LUS, sex: 'F', age: 25, num: 100, coll: '2026-05-31T23:30:00+02:00', iss: '2026-06-01T23:30:00+02:00', perf: '5551' }); // Female 25-29, supp 1, uu 1, tat 1, POC; local 06-01, the day after 05-31: in
lab6('T6-L13', { req: LUS, sex: 'M', age: 60, num: 800, coll: '2026-06-01T10:00:00+02:00', iss: '2026-06-02T00:30:00+02:00' });  // Male 50+, local date 06-02 (UTC 06-01): out of a window ending 05-31
lab6('T6-L14', { req: LUS, sex: 'F', age: 35, num: 500, coll: '2026-05-30T10:00:00Z', iss: '2026-06-02T10:00:00Z' });    // Female 35-39, date 06-02: out
lab6('T6-L15', { req: LUS, sex: 'M', age: 18, num: 600, coll: '2026-04-29T10:00:00+02:00', iss: '2026-05-01T00:30:00+02:00' }); // Male 15-19, supp 1, tat 2; local 05-01 (UTC 04-30): in
lab6('T6-L16', { req: LUS, sex: 'F', age: 40, num: 700, coll: '2026-04-28T10:00:00Z', iss: '2026-04-30T23:30:00Z' });    // date 04-30: out
lab6('T6-L17', { req: LUS, sex: 'F', age: 29, num: 300, coll: '2026-05-12T10:00:00Z', iss: '2026-05-09T10:00:00Z' });   // Female 25-29, supp 1, tat -3
lab6('T6-L18', { req: LUS, sex: 'M', age: 31, num: 300, coll: '2026-05-15T10:00:00Z', iss: '2026-05-10T10:00:00Z' });   // Male 30-34, supp 1, tat -5
// Left out whatever the window: a facility that is not in the register, and a cancelled report.
lab6('T6-UNMAPPED', { req: 'ZUNMP', sex: 'F', age: 30, num: 100, coll: MAY1, iss: '2026-05-10T10:00:00Z' });
lab6('T6-CANC', { req: CHO, sex: 'F', age: 30, num: 100, coll: MAY1, iss: null, status: 'cancelled' });

const SETUP6 = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t6-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t6-fm2', '', '', 'ZCHO2', 'reg-c', 'Choma Clinic', 'Southern', 'Choma'),
  ('t6-fm3', '', '', 'ZMAZA', 'reg-m', 'Mazabuka Hospital', 'Southern', 'Mazabuka'),
  ('t6-fm4', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('t6-fm5', '', '', 'ZUNMP', null, null, null, null);
insert into patients (id, surname, sex) values ${P6.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years) values ${R6.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer) values ${D6.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator) values ${L6.join(',\n  ')};
insert into questionnaire_responses (id, questionnaire, form_code, based_on_id, authored, items) values ${F6.join(',\n  ')};`;

// ---- Expected rows, worked out by hand from v1 lines 24-128 ----

// A row spec names only the columns that are not 0. Rates, averages and the 3-month sum default to NULL.
const NULLABLE = new Set(['SuppressionRate', 'SuppressionRate_POC', 'AverageTAT', 'AverageTAT_POC', 'TatWithin14',
  'TatWithin48h_POC', 'ThreeMPostUnSuppressed']);
const dash = (spec) => Object.fromEntries(DASH_COLUMNS.map((c) => [c, c in spec ? spec[c] : (NULLABLE.has(c) ? null : 0)]));
const allNull = (spec) => Object.fromEntries(DASH_COLUMNS.map((c) => [c, c in spec ? spec[c] : null]));

// All of Zambia, 2026-05-01 to 2026-05-31 (so tested dates 05-01 to 06-01, line 21). 15 labs: L01 to L12,
// L15, L17, L18 (L13 and L14 are on 06-02, L16 on 04-30).
//   Tests 15; POC L03 L04 L07 L12 = 4; suppressed L01 L02 L04 L06 L07 L08 L10 L12 L15 L17 L18 = 11, of POC L04 L07 L12 = 3;
//   undetectable L02 L04 L10 L12 = 4, of POC L04 L12 = 2; baseline L04 L10 L11 = 3, suppressed L04 L10 = 2.
//   line 31: (11 - 2) / (15 - 3) = 0.75. line 32: POC suppressed (L03 0, L04 1, L07 1, L12 1 = 3) - 1 (L04) = 2, over (4 - 1) = 3.
//   tat L01..: 9 10 1 2 15 5 2 3 7 4 6 1 2 -3 -5 = 59; 59 / 15 = 3.93, and AVG of an int column is an int: 3.
//   POC tat 1 2 2 1 = 6 / 4 = 1.5 -> 1. Within 14 days: all but L05 = 14 / 15. POC within 24 hours: L03 and L12 = 2 / 4.
const NATIONAL = {
  Province: 'All', District: 'All', Facility: 'All', Tests: 15, Tests_POC: 4, Suppressed: 11, Suppressed_POC: 3,
  Unsuppressed: 4, Undetectable: 4, Undetectable_POC: 2, SuppressionRate: 9 / 12, SuppressionRate_POC: 2 / 3,
  AverageTAT: 3, AverageTAT_POC: 1, TatWithin14: 14 / 15, TatWithin48h_POC: 2 / 4,
  Male: 4, Female: 7, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 2,
  lt01: 1, '10to14': 1, '15to19': 1, '20to24': 1, '25to29': 3, '30to34': 3, '40to44': 1, '45to49': 1, '50plus': 1, AgeMissing: 2,
  '15to19m': 1, '30to34m': 2, '40to44m': 1,
  lt01f: 1, '20to24f': 1, '25to29f': 3, '30to34f': 1, AgeMissingf: 1,
  '45to49i': 1, '50plusu': 1, '10to14x': 1, AgeMissingx: 1,
  Pregnant: 2, PregnantSup: 1, BreastFeeding: 2, BreastFeedingSup: 1, BaselineVL: 3, BaselineVLSup: 2,
  NonBaselineTests: 12, NonBaselineVLSuppressed: 9, ThreeMPostUnSuppressed: 1,
};

// Southern: L01 to L11 (11 labs). Suppressed 7 (L01 L02 L04 L06 L07 L08 L10), of POC (L03 L04 L07) 2; undetectable 3, of POC 1;
// baseline 3, suppressed 2. line 31: (7 - 2) / (11 - 3) = 5/8. line 32: (2 - 1) / (3 - 1) = 1/2.
// tat 9 10 1 2 15 5 2 3 7 4 6 = 64 / 11 = 5.8 -> 5; POC 1 2 2 = 5 / 3 -> 1. Within 14: 10 / 11. POC within 24 hours: L03 = 1 / 3.
const SOUTHERN = {
  Province: 'Southern', District: 'All', Facility: 'All', Tests: 11, Tests_POC: 3, Suppressed: 7, Suppressed_POC: 2,
  Unsuppressed: 4, Undetectable: 3, Undetectable_POC: 1, SuppressionRate: 5 / 8, SuppressionRate_POC: 1 / 2,
  AverageTAT: 5, AverageTAT_POC: 1, TatWithin14: 10 / 11, TatWithin48h_POC: 1 / 3,
  Male: 2, Female: 5, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 2,
  lt01: 1, '10to14': 1, '20to24': 1, '25to29': 1, '30to34': 2, '40to44': 1, '45to49': 1, '50plus': 1, AgeMissing: 2,
  '30to34m': 1, '40to44m': 1,
  lt01f: 1, '20to24f': 1, '25to29f': 1, '30to34f': 1, AgeMissingf: 1,
  '45to49i': 1, '50plusu': 1, '10to14x': 1, AgeMissingx: 1,
  Pregnant: 2, PregnantSup: 1, BreastFeeding: 2, BreastFeedingSup: 1, BaselineVL: 3, BaselineVLSup: 2,
  NonBaselineTests: 8, NonBaselineVLSuppressed: 5, ThreeMPostUnSuppressed: 1,
};

// Southern / Choma: L01 to L09 (9 labs). Suppressed 6 (L01 L02 L04 L06 L07 L08), POC 2; undetectable 2, POC 1; baseline L04.
// (6 - 1) / (9 - 1) = 5/8; (2 - 1) / (3 - 1) = 1/2. tat 54 / 9 = 6; POC 5 / 3 -> 1. Within 14: 8 / 9. POC within 24 hours: 1 / 3.
const CHOMA = {
  Province: 'Southern', District: 'Choma', Facility: 'All', Tests: 9, Tests_POC: 3, Suppressed: 6, Suppressed_POC: 2,
  Unsuppressed: 3, Undetectable: 2, Undetectable_POC: 1, SuppressionRate: 5 / 8, SuppressionRate_POC: 1 / 2,
  AverageTAT: 6, AverageTAT_POC: 1, TatWithin14: 8 / 9, TatWithin48h_POC: 1 / 3,
  Male: 1, Female: 4, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 2,
  lt01: 1, '10to14': 1, '25to29': 1, '30to34': 1, '40to44': 1, '45to49': 1, '50plus': 1, AgeMissing: 2,
  '40to44m': 1,
  lt01f: 1, '25to29f': 1, '30to34f': 1, AgeMissingf: 1,
  '45to49i': 1, '50plusu': 1, '10to14x': 1, AgeMissingx: 1,
  Pregnant: 2, PregnantSup: 1, BreastFeeding: 2, BreastFeedingSup: 1, BaselineVL: 1, BaselineVLSup: 1,
  NonBaselineTests: 8, NonBaselineVLSuppressed: 5, ThreeMPostUnSuppressed: 1,
};

// Southern / Choma / Choma General Hospital: L01 to L05. Suppressed 3 (L01 L02 L04), POC 1; undetectable 2 (L02 L04), POC 1; baseline L04.
// (3 - 1) / (5 - 1) = 1/2. POC: (1 - 1) / (2 - 1) = 0. tat 37 / 5 = 7.4 -> 7; POC 3 / 2 -> 1. Within 14: 4 / 5. POC within 24 hours: 1 / 2.
const FACILITY = {
  Province: 'Southern', District: 'Choma', Facility: 'Choma General Hospital', Tests: 5, Tests_POC: 2, Suppressed: 3,
  Suppressed_POC: 1, Unsuppressed: 2, Undetectable: 2, Undetectable_POC: 1, SuppressionRate: 2 / 4, SuppressionRate_POC: 0,
  AverageTAT: 7, AverageTAT_POC: 1, TatWithin14: 4 / 5, TatWithin48h_POC: 1 / 2,
  Male: 1, Female: 3, UnknownGender: 1,
  lt01: 1, '25to29': 1, '30to34': 1, '40to44': 1, '50plus': 1,
  '40to44m': 1, lt01f: 1, '25to29f': 1, '30to34f': 1, '50plusu': 1,
  Pregnant: 1, PregnantSup: 1, BreastFeeding: 1, BreastFeedingSup: 0, BaselineVL: 1, BaselineVLSup: 1,
  NonBaselineTests: 4, NonBaselineVLSuppressed: 2, ThreeMPostUnSuppressed: 1,
};

// Southern / Mazabuka: L10 and L11, both baseline. Line 31 divides by (2 - 2) = 0: v1 stops with an error. The port gives NULL
// (spec ruling 2). No POC test: line 32 and line 36 divide by nullif(0, 0) = NULL, and the POC average has no rows.
const MAZABUKA = {
  Province: 'Southern', District: 'Mazabuka', Facility: 'All', Tests: 2, Tests_POC: 0, Suppressed: 1, Suppressed_POC: 0,
  Unsuppressed: 1, Undetectable: 1, Undetectable_POC: 0, SuppressionRate: null, SuppressionRate_POC: null,
  AverageTAT: 5, AverageTAT_POC: null, TatWithin14: 1, TatWithin48h_POC: null,
  Male: 1, Female: 1, '20to24': 1, '30to34': 1, '30to34m': 1, '20to24f': 1,
  BaselineVL: 2, BaselineVLSup: 1, NonBaselineTests: 0, NonBaselineVLSuppressed: 0, ThreeMPostUnSuppressed: null,
};

// Lusaka: L12, L15, L17, L18. All suppressed; L12 is POC and undetectable; no baseline. Rates are 4/4 and 1/1.
// tat 1 2 -3 -5 = -5 / 4 = -1.25, and the int average truncates toward zero: -1. POC tat 1.
const LUSAKA = {
  Province: 'Lusaka', District: 'All', Facility: 'All', Tests: 4, Tests_POC: 1, Suppressed: 4, Suppressed_POC: 1,
  Unsuppressed: 0, Undetectable: 1, Undetectable_POC: 1, SuppressionRate: 1, SuppressionRate_POC: 1,
  AverageTAT: -1, AverageTAT_POC: 1, TatWithin14: 1, TatWithin48h_POC: 1,
  Male: 2, Female: 2, '15to19': 1, '25to29': 2, '30to34': 1, '15to19m': 1, '30to34m': 1, '25to29f': 2,
  NonBaselineTests: 4, NonBaselineVLSuppressed: 4,
};

// Windows that end on the 31st or the 1st of June (L12 is on local 06-01; L13 and L14 on 06-02).
const DAY_0531 = {
  Province: 'All', District: 'All', Facility: 'All', Tests: 1, Tests_POC: 1, Suppressed: 1, Suppressed_POC: 1,
  Unsuppressed: 0, Undetectable: 1, Undetectable_POC: 1, SuppressionRate: 1, SuppressionRate_POC: 1,
  AverageTAT: 1, AverageTAT_POC: 1, TatWithin14: 1, TatWithin48h_POC: 1,
  Female: 1, '25to29': 1, '25to29f': 1, NonBaselineTests: 1, NonBaselineVLSuppressed: 1,
};
// L12, L13, L14: all suppressed, tat 1 1 3 = 5 / 3 -> 1; POC is L12 only.
const DAY_0601 = {
  Province: 'All', District: 'All', Facility: 'All', Tests: 3, Tests_POC: 1, Suppressed: 3, Suppressed_POC: 1,
  Unsuppressed: 0, Undetectable: 1, Undetectable_POC: 1, SuppressionRate: 1, SuppressionRate_POC: 1,
  AverageTAT: 1, AverageTAT_POC: 1, TatWithin14: 1, TatWithin48h_POC: 1,
  Male: 1, Female: 2, '25to29': 1, '35to39': 1, '50plus': 1, '25to29f': 1, '35to39f': 1, '50plusm': 1,
  NonBaselineTests: 3, NonBaselineVLSuppressed: 3,
};

// Nothing in the window: the national branch still returns its one row (lines 24-130). count() is 0 and every sum is NULL.
const EMPTY_NATIONAL = { Province: 'All', District: 'All', Facility: 'All', Tests: 0 };
// The facility branch with no rows returns the all-zero row with blank names (lines 587-693).
const NOT_FOUND = Object.fromEntries(DASH_COLUMNS.map((c) => [c, ['Province', 'District', 'Facility'].includes(c) ? '' : 0]));

// ---- Suites ----

const dashQuery = queries().find((q) => q.name === 'VL dashboard summary');
const win = { from: '2026-05-01', to: '2026-05-31' };
const area = (province, district, facility) => ({ province, district, facility });
const noArea = area('', '', '');

function dashSuite(name, params, expectedRows, setup = '') {
  const key = (r) => JSON.stringify(DASH_COLUMNS.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `select ${lit(name)} || chr(9) || row_to_json(q)::text from (${bind(dashQuery.sql, params)}) q;`,
    count: expectedRows.length + 1,
    check(got) {
      const failures = [];
      if (got.length !== expectedRows.length) failures.push(`expected ${expectedRows.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), DASH_COLUMNS));
        if (Object.keys(got[0]).length !== DASH_COLUMNS.length) failures.push(`expected ${DASH_COLUMNS.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const have = got.map(key).sort();
      const want = expectedRows.map(key).sort();
      for (const w of want) if (!have.includes(w)) failures.push(`missing row ${w}`);
      for (const g of have) if (!want.includes(g)) failures.push(`unexpected row ${g}`);
      return failures;
    },
  };
}

const suites6 = [
  // The four branches (v1 lines 22, 132, 246, 360).
  dashSuite('dash-national', { ...noArea, ...win }, [dash(NATIONAL)], SETUP6),
  dashSuite('dash-province', { ...area('Southern', '', ''), ...win }, [dash(SOUTHERN)]),
  dashSuite('dash-district', { ...area('Southern', 'Choma', ''), ...win }, [dash(CHOMA)]),
  dashSuite('dash-facility', { ...area('Southern', 'Choma', 'Choma General Hospital'), ...win }, [dash(FACILITY)]),
  // Names compare as SQL Server does (case and trailing spaces ignored); the row shows the stored names.
  dashSuite('dash-names-fold', { ...area('SOUTHERN', 'choma', 'choma general hospital  '), ...win }, [dash(FACILITY)]),
  dashSuite('dash-lusaka', { ...area('Lusaka', '', ''), ...win }, [dash(LUSAKA)]),
  dashSuite('dash-lusaka-district', { ...area('Lusaka', 'Lusaka', ''), ...win }, [dash({ ...LUSAKA, District: 'Lusaka' })]),
  dashSuite('dash-lusaka-facility', { ...area('Lusaka', 'Lusaka', 'Chilenje Clinic'), ...win }, [dash({ ...LUSAKA, District: 'Lusaka', Facility: 'Chilenje Clinic' })]),
  // Every test is baseline: v1 divides by zero; the port gives NULL.
  dashSuite('dash-all-baseline', { ...area('Southern', 'Mazabuka', ''), ...win }, [dash(MAZABUKA)]),
  // Nothing found. National still returns its row; province and district return none; facility returns the zero row.
  dashSuite('dash-empty-national', { ...noArea, from: '2026-01-01', to: '2026-01-31' }, [allNull(EMPTY_NATIONAL)]),
  dashSuite('dash-empty-province', { ...area('Western', '', ''), ...win }, []),
  dashSuite('dash-empty-district', { ...area('Southern', 'Kafue', ''), ...win }, []),
  dashSuite('dash-empty-facility', { ...area('Southern', 'Choma', 'Nowhere'), ...win }, [NOT_FOUND]),
  dashSuite('dash-empty-facility-window', { ...area('Southern', 'Choma', 'Choma General Hospital'), from: '2026-01-01', to: '2026-01-31' }, [NOT_FOUND]),
  // A facility in another district does not match (v1 line 471 tests all three).
  dashSuite('dash-facility-wrong-district', { ...area('Southern', 'Mazabuka', 'Choma General Hospital'), ...win }, [NOT_FOUND]),
  // v1 has no branch for these (lines 22, 132, 246, 360): no result set at all.
  dashSuite('dash-district-only', { ...area('', 'Choma', ''), ...win }, []),
  dashSuite('dash-facility-only', { ...area('', '', 'Choma General Hospital'), ...win }, []),
  dashSuite('dash-province-facility', { ...area('Southern', '', 'Choma General Hospital'), ...win }, []),
  dashSuite('dash-district-facility', { ...area('', 'Choma', 'Choma General Hospital'), ...win }, []),
  // The window: the day after the end date is included (line 21), and the date is the local date of the stamp.
  dashSuite('dash-window-end-0531', { ...noArea, from: '2026-05-31', to: '2026-05-31' }, [dash(DAY_0531)]),
  dashSuite('dash-window-end-0601', { ...noArea, from: '2026-06-01', to: '2026-06-01' }, [dash(DAY_0601)]),
  {
    name: 'dash-shape',
    count: 6,
    check() {
      const bad = [];
      const ids = dashQuery.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['province', 'district', 'facility', 'from', 'to'])) bad.push(`params: ${ids}`);
      const byId = Object.fromEntries(dashQuery.params.map((p) => [p.id, p]));
      if (byId.province.type !== 'select' || byId.district.type !== 'select' || byId.facility.type !== 'text') bad.push('area parameter types');
      if (byId.province.required || byId.district.required || byId.facility.required) bad.push('area parameters are optional');
      if (!byId.from.required || !byId.to.required) bad.push('from and to are required (ruling 3)');
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(dashQuery.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      return bad;
    },
  },
];

// ============================================================================================
// Group t7: "VL dashboard by sex and age" (v1 sp_dash_getHIVVL_v2_List, merging vSuppressionByFacility
// and vVLQuarterlyFacilitySuppressionRate) and "VL monthly trend" (v1 sp_dash_getMonthlyVLTrend).
// Fixture ids start with "t7-"; lab ids start with "T7-". "List line N" is a line of
// StoredProcedure__dbo_sp_dash_getHIVVL_v2_List.sql; "Trend line N" is a line of
// StoredProcedure__dbo_sp_dash_getMonthlyVLTrend.sql.
//
// List window (lines 17-21, 29, 40): TestedDate is a datetime and the end date is moved one day forward, so a
// test counts when its LOCAL wall time is from [from 00:00:00, to + 1 day 00:00:00]. Only a test at exactly
// midnight of the day after `to` is in; v2 (cast to date) takes the whole day. Trend window: the local date.
// ============================================================================================

const P7 = [];
const R7 = [];
const D7 = [];
const L7 = [];
const F7 = [];
let n7 = 0;
// One lab id: a request with one result and one report. `o`: req (facility code), sex (null: no patient),
// age, num or text (the result), coll, iss, form (VIRAL answers), status.
function lab7(labId, o) {
  const k = String(++n7).padStart(2, '0');
  const qid = `t7-q${k}`;
  let pid = null;
  if (o.sex !== null && o.sex !== undefined) {
    pid = `t7-p${k}`;
    P7.push(`(${lit(pid)}, ${lit('P' + k)}, ${lit(o.sex)})`);
  }
  R7.push(`(${lit(qid)}, ${lit(labId)}, 'HIVVL', '2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', ${lit(o.req)}, ${lit(pid)}, ${sql6(o.age)})`);
  D7.push(`(${lit(`t7-d${k}`)}, ${lit(qid)}, ${lit(o.status ?? 'final')}, ${lit(o.coll)}, ${lit(o.iss)}, 'LUS')`);
  L7.push(`(${lit(`t7-r${k}`)}, ${lit(qid)}, 'HIVVL', ${lit(o.text ?? null)}, ${sql6(o.num)}, null)`);
  if (o.form) {
    const items = o.form.map(([linkId, text]) => ({ linkId, answer: [{ valueString: text }] }));
    F7.push(`(${lit(`t7-f${k}`)}, 'q', 'hiv_vl_documentation', ${lit(qid)}, '2026-05-02T08:00:00Z', ${lit(JSON.stringify(items))})`);
  }
}

// Choma General Hospital (Southern / Choma). Comments: gender, age group, suppressed, undetectable, tat.
lab7('T7-A1', { req: CHO, sex: 'F', age: 30, num: 540, coll: MAY1, iss: '2026-05-10T10:00:00Z' });                            // Female 30-34, supp 1, uu 0, tat 9
lab7('T7-A2', { req: CHO, sex: 'F', age: 33, num: 1500, coll: MAY1, iss: '2026-05-12T10:00:00Z', form: [['ARTPR', 'Yes']] }); // Female 30-34, supp 0, tat 11, pregnant
lab7('T7-A3', { req: CHO, sex: 'F', age: 28, text: 'Target Not Detected', coll: MAY1, iss: '2026-05-20T10:00:00Z',
  form: [['VBREA', 'Y']] });                                                                                                 // Female 25-29, supp 1, uu 1, tat 19 (not within 14), breastfeeding
lab7('T7-A4', { req: CHO, sex: 'M', age: 41, num: 100, coll: '2026-05-08T08:00:00Z', iss: '2026-05-10T10:00:00Z',
  form: [['ARTRS', 'Baseline VL']] });                                                                                       // Male 40-44, supp 1, uu 1, tat 2, baseline
lab7('T7-A5', { req: CHO, sex: 'M', age: 42, num: 3000, coll: '2026-05-07T08:00:00Z', iss: '2026-05-10T10:00:00Z',
  form: [['VISIT', '3 months post unsuppressed VL result']] });                                                              // Male 40-44, supp 0, tat 3, 3 months
lab7('T7-A6', { req: CHO, sex: 'F', age: 30, num: 700, coll: '2026-05-06T08:00:00Z', iss: '2026-05-10T10:00:00Z' });          // Female 30-34, supp 1, tat 4
// Choma Clinic (Southern / Choma).
lab7('T7-B1', { req: CL2, sex: 'X', age: 12, num: 250, coll: '2026-05-20T10:00:00Z', iss: '2026-05-22T10:00:00Z' });          // gender NULL (Missing), 10-14, supp 1, uu 0, tat 2
lab7('T7-B2', { req: CL2, sex: 'F', age: null, num: 950, coll: MAY1, iss: '2026-05-04T10:00:00Z' });                         // Female, age group NULL (Missing), supp 1, tat 3
lab7('T7-B3', { req: CL2, sex: null, age: null, num: 1000, coll: MAY1, iss: '2026-05-08T10:00:00Z' });                       // Missing, Missing, supp 0 (1000 is not under 1000), tat 7
lab7('T7-B4', { req: CL2, sex: 'O', age: 11, num: 150, coll: '2026-05-10T10:00:00Z', iss: '2026-05-11T10:00:00Z' });          // gender NULL (O), 10-14, supp 1, uu 1, tat 1
// Mazabuka Hospital (Southern / Mazabuka).
lab7('T7-C1', { req: MAZ, sex: 'M', age: 22, num: 5000, coll: MAY1, iss: '2026-05-07T10:00:00Z' });                          // Male 20-24, supp 0, tat 6
lab7('T7-C2', { req: MAZ, sex: 'F', age: 22, num: 10, coll: MAY1, iss: '2026-05-05T10:00:00Z' });                            // Female 20-24, supp 1, uu 1, tat 4
// Chilenje Clinic (Lusaka / Lusaka), with stamps at +02:00 near midnight and at the edges of the List window.
lab7('T7-D1', { req: LUS, sex: 'F', age: 25, num: 100, coll: '2026-05-31T23:30:00+02:00', iss: '2026-05-31T23:50:00+02:00' });   // Female 25-29, supp 1, uu 1, tat 0; local 05-31
lab7('T7-D2', { req: LUS, sex: 'M', age: 60, num: 800, coll: '2026-05-30T10:00:00Z', iss: '2026-06-01T00:00:00+02:00' });        // Male 50+, supp 1, tat 2; local 06-01 00:00:00 exactly
lab7('T7-D3', { req: LUS, sex: 'F', age: 35, num: 500, coll: '2026-05-30T10:00:00Z', iss: '2026-06-01T00:00:01+02:00' });        // Female 35-39, supp 1, tat 2; local 06-01 00:00:01
lab7('T7-D4', { req: LUS, sex: 'M', age: 18, num: 600, coll: '2026-04-29T10:00:00+02:00', iss: '2026-05-01T00:30:00+02:00' });   // Male 15-19, supp 1, tat 2; local 05-01 00:30 (UTC 04-30)
lab7('T7-D5', { req: LUS, sex: 'F', age: 40, num: 700, coll: '2026-04-28T10:00:00Z', iss: '2026-04-30T23:30:00Z' });              // Female 40-44, supp 1, tat 2; local 04-30 23:30
lab7('T7-D6', { req: LUS, sex: 'F', age: 29, num: 300, coll: '2026-05-30T10:00:00Z', iss: '2026-06-01T23:30:00+02:00' });        // Female 25-29, supp 1, tat 2; local 06-01 23:30
// Other months, for the trend.
lab7('T7-E1', { req: CHO, sex: 'M', age: 50, num: 100, coll: '2026-03-30T10:00:00Z', iss: '2026-04-01T00:30:00+02:00' });        // Male 50+, supp 1, uu 1, tat 2; local 04-01 (UTC 03-31)
lab7('T7-E2', { req: CHO, sex: 'M', age: 50, num: 3000, coll: '2026-03-29T10:00:00Z', iss: '2026-03-31T23:30:00+02:00' });       // supp 0, tat 2; local 03-31
lab7('T7-Y1', { req: LUS, sex: 'F', age: 20, num: 400, coll: '2025-12-30T10:00:00Z', iss: '2026-01-01T00:30:00+02:00' });        // supp 1, uu 0, tat 2; local 2026-01-01 (UTC 2025-12-31)
lab7('T7-Y2', { req: LUS, sex: 'M', age: 20, num: 2000, coll: '2025-12-10T10:00:00Z', iss: '2025-12-15T10:00:00Z' });             // supp 0, tat 5
// Left out whatever the window: a facility that is not in the register, and a cancelled report.
lab7('T7-UNMAPPED', { req: 'ZUNMP', sex: 'F', age: 30, num: 100, coll: MAY1, iss: '2026-05-10T10:00:00Z' });
lab7('T7-CANC', { req: CHO, sex: 'F', age: 30, num: 100, coll: MAY1, iss: null, status: 'cancelled' });

const SETUP7 = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t7-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t7-fm2', '', '', 'ZCHO2', 'reg-c', 'Choma Clinic', 'Southern', 'Choma'),
  ('t7-fm3', '', '', 'ZMAZA', 'reg-m', 'Mazabuka Hospital', 'Southern', 'Mazabuka'),
  ('t7-fm4', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('t7-fm5', '', '', 'ZUNMP', null, null, null, null);
insert into patients (id, surname, sex) values ${P7.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years) values ${R7.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer) values ${D7.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator) values ${L7.join(',\n  ')};
insert into questionnaire_responses (id, questionnaire, form_code, based_on_id, authored, items) values ${F7.join(',\n  ')};`;

// ---- Expected rows, worked out by hand from the List text (lines 34-47 for the output and the order) ----

const SEX_AGE_COLUMNS = ['Province', 'District', 'Facility', 'Gender', 'AgeGroup', 'Tests', 'Suppressed', 'UnSuppressed',
  'Undetectable', 'TATWithin14', 'Pregnant', 'BreastFeeding', 'BaselineVL', 'ThreeMPostUnSuppressed'];
// counts: [tests, suppressed, unsuppressed, undetectable, within 14 days, pregnant, breastfeeding, baseline, 3 months]
const sx = (province, district, facility, gender, age, counts) =>
  Object.fromEntries(SEX_AGE_COLUMNS.map((c, i) => [c, [province, district, facility, gender, age, ...counts][i]]));
// The fallback row (lines 49, 80, 112): blank names, zeros. v1's row has no UnSuppressed column; the port gives 0.
const NOTHING = sx('', '', '', '', '', [0, 0, 0, 0, 0, 0, 0, 0, 0]);

// Southern, by gender and age group.
//   C2 Female 20-24: 1 test, suppressed, undetectable, within 14.
//   A3 Female 25-29: tat 19, so not within 14; breastfeeding.
//   A1 A2 A6 Female 30-34: suppressed 2 (A1 A6), pregnant 1 (A2), within 14 all three.
//   B2 Female, no age group. C1 Male 20-24 (unsuppressed). A4 A5 Male 40-44: suppressed 1, undetectable 1, baseline 1, 3 months 1.
//   B1 B4 gender NULL 10-14: both suppressed, undetectable 1 (B4). B3 gender NULL and age NULL: unsuppressed.
const S_FEM2024 = [1, 1, 0, 1, 1, 0, 0, 0, 0];
const S_FEM2529 = [1, 1, 0, 1, 0, 0, 1, 0, 0];
const S_FEM3034 = [3, 2, 1, 0, 3, 1, 0, 0, 0];
const S_FEMMISS = [1, 1, 0, 0, 1, 0, 0, 0, 0];
const S_MAL2024 = [1, 0, 1, 0, 1, 0, 0, 0, 0];
const S_MAL4044 = [2, 1, 1, 1, 2, 0, 0, 1, 1];
const S_MIS1014 = [2, 2, 0, 1, 2, 0, 0, 0, 0];
const S_MISMISS = [1, 0, 1, 0, 1, 0, 0, 0, 0];
const ONE_SUPP = [1, 1, 0, 0, 1, 0, 0, 0, 0];
const ONE_SUPP_UU = [1, 1, 0, 1, 1, 0, 0, 0, 0];

// National branch (List line 34): one row per province, gender, age group; District and Facility are 'All'.
const NATIONAL7 = [
  sx('Lusaka', 'All', 'All', 'Female', '25-29', ONE_SUPP_UU),                    // D1
  sx('Lusaka', 'All', 'All', 'Male', '15-19', ONE_SUPP),                         // D4
  sx('Lusaka', 'All', 'All', 'Male', '50+', ONE_SUPP),                           // D2, local 06-01 00:00:00
  sx('Southern', 'All', 'All', 'Female', '20-24', S_FEM2024),
  sx('Southern', 'All', 'All', 'Female', '25-29', S_FEM2529),
  sx('Southern', 'All', 'All', 'Female', '30-34', S_FEM3034),
  sx('Southern', 'All', 'All', 'Female', 'Missing', S_FEMMISS),
  sx('Southern', 'All', 'All', 'Male', '20-24', S_MAL2024),
  sx('Southern', 'All', 'All', 'Male', '40-44', S_MAL4044),
  sx('Southern', 'All', 'All', 'Missing', '10-14', S_MIS1014),
  sx('Southern', 'All', 'All', 'Missing', 'Missing', S_MISMISS),
];
// Province branch (line 65): one row per facility, gender, age group. Order: district, facility, gender, age group.
const CHOMA_CLINIC = [
  sx('Southern', 'Choma', 'Choma Clinic', 'Female', 'Missing', S_FEMMISS),
  sx('Southern', 'Choma', 'Choma Clinic', 'Missing', '10-14', S_MIS1014),
  sx('Southern', 'Choma', 'Choma Clinic', 'Missing', 'Missing', S_MISMISS),
];
const CHOMA_GENERAL = [
  sx('Southern', 'Choma', 'Choma General Hospital', 'Female', '25-29', S_FEM2529),
  sx('Southern', 'Choma', 'Choma General Hospital', 'Female', '30-34', S_FEM3034),
  sx('Southern', 'Choma', 'Choma General Hospital', 'Male', '40-44', S_MAL4044),
];
const MAZABUKA7 = [
  sx('Southern', 'Mazabuka', 'Mazabuka Hospital', 'Female', '20-24', S_FEM2024),
  sx('Southern', 'Mazabuka', 'Mazabuka Hospital', 'Male', '20-24', S_MAL2024),
];
const CHILENJE = [
  sx('Lusaka', 'Lusaka', 'Chilenje Clinic', 'Female', '25-29', ONE_SUPP_UU),
  sx('Lusaka', 'Lusaka', 'Chilenje Clinic', 'Male', '15-19', ONE_SUPP),
  sx('Lusaka', 'Lusaka', 'Chilenje Clinic', 'Male', '50+', ONE_SUPP),
];

// ---- The List suites ----

const sexAgeQuery = queries().find((q) => q.name === 'VL dashboard by sex and age');
const trendQuery = queries().find((q) => q.name === 'VL monthly trend');

// A suite over a query's rows: column order, then the rows IN ORDER (v1 orders its rows).
function orderedSuite(name, sqlText, params, columns, expectedRows, setup = '') {
  const key = (r) => JSON.stringify(columns.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `select ${lit(name)} || chr(9) || row_to_json(q)::text from (${bind(sqlText, params)}) q;`,
    count: expectedRows.length + 1,
    check(got) {
      const failures = [];
      if (got.length !== expectedRows.length) failures.push(`expected ${expectedRows.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), columns));
        if (Object.keys(got[0]).length !== columns.length) failures.push(`expected ${columns.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const have = got.map(key);
      const want = expectedRows.map(key);
      if (have.length === want.length) {
        have.forEach((h, i) => { if (h !== want[i]) failures.push(`row ${i + 1}: expected ${want[i]}, got ${h}`); });
      } else {
        for (const x of want) if (!have.includes(x)) failures.push(`missing row ${x}`);
        for (const g of have) if (!want.includes(g)) failures.push(`unexpected row ${g}`);
      }
      return failures;
    },
  };
}
const listSuite = (name, params, rows, setup = '') => orderedSuite(name, sexAgeQuery?.sql ?? 'select 1', params, SEX_AGE_COLUMNS, rows, setup);
const area2 = (province, district) => ({ province, district });

const suites7list = [
  listSuite('sexage-national', { ...area2('', ''), ...win }, NATIONAL7, SETUP7),
  listSuite('sexage-province', { ...area2('Southern', ''), ...win }, [...CHOMA_CLINIC, ...CHOMA_GENERAL, ...MAZABUKA7]),
  listSuite('sexage-district', { ...area2('Southern', 'Choma'), ...win }, [...CHOMA_CLINIC, ...CHOMA_GENERAL]),
  listSuite('sexage-lusaka', { ...area2('Lusaka', ''), ...win }, CHILENJE),
  listSuite('sexage-lusaka-district', { ...area2('Lusaka', 'Lusaka'), ...win }, CHILENJE),
  // Names compare as SQL Server does (case and trailing spaces ignored); the rows show the stored names.
  listSuite('sexage-names-fold', { ...area2('SOUTHERN ', 'choma  '), ...win }, [...CHOMA_CLINIC, ...CHOMA_GENERAL]),
  // Nothing found: v1 returns only the all-zero row with blank names (lines 49, 80, 112), in every branch.
  listSuite('sexage-empty-national', { ...area2('', ''), from: '2026-07-01', to: '2026-07-31' }, [NOTHING]),
  listSuite('sexage-empty-province', { ...area2('Western', ''), ...win }, [NOTHING]),
  listSuite('sexage-empty-district', { ...area2('Southern', 'Kafue'), ...win }, [NOTHING]),
  listSuite('sexage-wrong-district', { ...area2('Lusaka', 'Choma'), ...win }, [NOTHING]),
  // A district without a province matches no branch (lines 22, 51, 83): no result set at all, not even the zero row.
  listSuite('sexage-district-only', { ...area2('', 'Choma'), ...win }, []),
  listSuite('sexage-district-only-empty', { ...area2('', 'Kafue'), ...win }, []),
  // The window is [from 00:00:00, to + 1 day 00:00:00] on the LOCAL wall time (lines 17-21, 29, 40).
  // 05-31: D1 (05-31 23:50) and D2 (exactly 06-01 00:00:00) are in; D3 (00:00:01) is out.
  listSuite('sexage-window-0531', { ...area2('', ''), from: '2026-05-31', to: '2026-05-31' }, [
    sx('Lusaka', 'All', 'All', 'Female', '25-29', ONE_SUPP_UU),
    sx('Lusaka', 'All', 'All', 'Male', '50+', ONE_SUPP),
  ]),
  // 06-01: D2 again (a test at midnight counts in two consecutive windows), D3, and D6 (06-01 23:30).
  listSuite('sexage-window-0601', { ...area2('', ''), from: '2026-06-01', to: '2026-06-01' }, [
    sx('Lusaka', 'All', 'All', 'Female', '25-29', ONE_SUPP),
    sx('Lusaka', 'All', 'All', 'Female', '35-39', ONE_SUPP),
    sx('Lusaka', 'All', 'All', 'Male', '50+', ONE_SUPP),
  ]),
  // 04-30: D5 (04-30 23:30) is in; D4 (local 05-01 00:30, after the midnight that ends the window) is out. v2 would take it.
  listSuite('sexage-window-0430', { ...area2('', ''), from: '2026-04-30', to: '2026-04-30' }, [
    sx('Lusaka', 'All', 'All', 'Female', '40-44', ONE_SUPP),
  ]),
  // 05-01: D4 is in (local 05-01 00:30; its UTC date is 04-30).
  listSuite('sexage-window-0501', { ...area2('Lusaka', ''), from: '2026-05-01', to: '2026-05-01' }, [
    sx('Lusaka', 'Lusaka', 'Chilenje Clinic', 'Male', '15-19', ONE_SUPP),
  ]),
  {
    name: 'sexage-shape',
    count: 5,
    check() {
      const bad = [];
      if (!sexAgeQuery) return ['query "VL dashboard by sex and age" is missing'];
      const ids = sexAgeQuery.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['province', 'district', 'from', 'to'])) bad.push(`params: ${ids}`);
      const byId = Object.fromEntries(sexAgeQuery.params.map((p) => [p.id, p]));
      if (byId.province.type !== 'select' || byId.district.type !== 'select') bad.push('area parameter types');
      if (byId.province.required || byId.district.required) bad.push('area parameters are optional');
      if (!byId.from.required || !byId.to.required) bad.push('from and to are required (ruling 3)');
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(sexAgeQuery.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      return bad;
    },
  },
];

// ---- The trend suites. Expected rows from Trend lines 13, 28, 43 (province, district, facility) and 60 (all). ----

const TREND_COLUMNS = ['MonthID', 'Tests', 'Suppressed', 'Undetectable', 'Within14', 'Pregnant', 'BreastFeeding', 'Baseline'];
const tr = (month, tests, suppressed, undetectable, within14, pregnant = null, breastfeeding = null, baseline = null) =>
  Object.fromEntries(TREND_COLUMNS.map((c, i) => [c, [month, tests, suppressed, undetectable, within14, pregnant, breastfeeding, baseline][i]]));
const trendSuite = (name, params, rows, setup = '') => orderedSuite(name, trendQuery?.sql ?? 'select 1', params, TREND_COLUMNS, rows, setup);
const area3 = (province, district, facility) => ({ province, district, facility });
const span = (from, to) => ({ from, to });

// April: D5 (supp 1, uu 0) and E1 (supp 1, uu 1), both within 14 days; E2 is local 03-31. No flag is set, so the sums are NULL (line 17).
const APRIL = tr('2026 - 04', 2, 2, 1, 2);
// May, all: A1..A6 B1..B4 C1 C2 D1 D4 = 14 tests; suppressed 10; undetectable A3 A4 B4 C2 D1 = 5; within 14: all but A3 = 13;
// pregnant A2, breastfeeding A3, baseline A4. D2 (06-01 00:00:00 local) is June here: the trend takes the local date.
const MAY = tr('2026 - 05', 14, 10, 5, 13, 1, 1, 1);
// June: D2 D3 D6 (800, 500, 300): all suppressed, none under 200.
const JUNE = tr('2026 - 06', 3, 3, 0, 3);

const suites7trend = [
  trendSuite('trend-national', { ...area3('', '', ''), ...span('2026-04-01', '2026-05-31') }, [APRIL, MAY]),
  trendSuite('trend-may-june', { ...area3('', '', ''), ...span('2026-05-01', '2026-06-30') }, [MAY, JUNE]),
  // Southern: April E1; May 12 labs (A, B, C): suppressed 8, undetectable A3 A4 B4 C2 = 4, within 14: 11.
  trendSuite('trend-province', { ...area3('Southern', '', ''), ...span('2026-04-01', '2026-05-31') }, [tr('2026 - 04', 1, 1, 1, 1), tr('2026 - 05', 12, 8, 4, 11, 1, 1, 1)]),
  // Southern / Choma: April E1; May A1..A6 B1..B4 = 10: suppressed 7, undetectable 3, within 14: 9.
  trendSuite('trend-district', { ...area3('Southern', 'Choma', ''), ...span('2026-04-01', '2026-05-31') }, [tr('2026 - 04', 1, 1, 1, 1), tr('2026 - 05', 10, 7, 3, 9, 1, 1, 1)]),
  // Choma Clinic: B1..B4 in May; suppressed 3, undetectable 1, within 14: 4. No flags.
  trendSuite('trend-facility', { ...area3('Southern', 'Choma', 'Choma Clinic'), ...span('2026-04-01', '2026-05-31') }, [tr('2026 - 05', 4, 3, 1, 4)]),
  trendSuite('trend-names-fold', { ...area3('southern', 'CHOMA ', 'choma clinic  '), ...span('2026-04-01', '2026-05-31') }, [tr('2026 - 05', 4, 3, 1, 4)]),
  // Lusaka: April D5; May D1 D4.
  trendSuite('trend-lusaka', { ...area3('Lusaka', '', ''), ...span('2026-04-01', '2026-05-31') }, [tr('2026 - 04', 1, 1, 0, 1), tr('2026 - 05', 2, 2, 1, 2)]),
  trendSuite('trend-lusaka-district', { ...area3('Lusaka', 'Lusaka', ''), ...span('2026-04-01', '2026-05-31') }, [tr('2026 - 04', 1, 1, 0, 1), tr('2026 - 05', 2, 2, 1, 2)]),
  // Any other combination falls to v1's last branch (line 60): nothing is filtered, so it is all of Zambia.
  trendSuite('trend-district-only', { ...area3('', 'Choma', ''), ...span('2026-04-01', '2026-05-31') }, [APRIL, MAY]),
  trendSuite('trend-facility-only', { ...area3('', '', 'Choma Clinic'), ...span('2026-04-01', '2026-05-31') }, [APRIL, MAY]),
  trendSuite('trend-province-facility', { ...area3('Southern', '', 'Choma Clinic'), ...span('2026-04-01', '2026-05-31') }, [APRIL, MAY]),
  trendSuite('trend-district-facility', { ...area3('', 'Choma', 'Choma Clinic'), ...span('2026-04-01', '2026-05-31') }, [APRIL, MAY]),
  // The month is the local month of the stamp. D4 (local 05-01 00:30, UTC 04-30) is May; E1 (local 04-01, UTC 03-31) is April.
  trendSuite('trend-edge-0501', { ...area3('', '', ''), ...span('2026-05-01', '2026-05-01') }, [tr('2026 - 05', 1, 1, 0, 1)]),
  trendSuite('trend-edge-0531', { ...area3('', '', ''), ...span('2026-05-31', '2026-05-31') }, [tr('2026 - 05', 1, 1, 1, 1)]),
  trendSuite('trend-edge-0601', { ...area3('', '', ''), ...span('2026-06-01', '2026-06-01') }, [JUNE]),
  trendSuite('trend-edge-0430', { ...area3('', '', ''), ...span('2026-04-30', '2026-04-30') }, [tr('2026 - 04', 1, 1, 0, 1)]),
  trendSuite('trend-edge-0401', { ...area3('', '', ''), ...span('2026-04-01', '2026-04-01') }, [tr('2026 - 04', 1, 1, 1, 1)]),
  // The year turns: MonthID sorts 2025 - 12 before 2026 - 01. Y1 is local 2026-01-01 (UTC 2025-12-31).
  trendSuite('trend-year-turn', { ...area3('', '', ''), ...span('2025-12-01', '2026-01-31') }, [tr('2025 - 12', 1, 0, 0, 1), tr('2026 - 01', 1, 1, 0, 1)]),
  // No test in the window: no row (a group by over no rows).
  trendSuite('trend-empty', { ...area3('', '', ''), ...span('2026-07-01', '2026-07-31') }, []),
  trendSuite('trend-empty-province', { ...area3('Western', '', ''), ...span('2026-04-01', '2026-05-31') }, []),
  {
    name: 'trend-shape',
    count: 5,
    check() {
      const bad = [];
      if (!trendQuery) return ['query "VL monthly trend" is missing'];
      const ids = trendQuery.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['province', 'district', 'facility', 'from', 'to'])) bad.push(`params: ${ids}`);
      const byId = Object.fromEntries(trendQuery.params.map((p) => [p.id, p]));
      if (byId.province.type !== 'select' || byId.district.type !== 'select' || byId.facility.type !== 'text') bad.push('area parameter types');
      if (byId.province.required || byId.district.required || byId.facility.required) bad.push('area parameters are optional');
      if (!byId.from.required || !byId.to.required) bad.push('from and to are required (ruling 3)');
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(trendQuery.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      return bad;
    },
  },
];

// ============================================================================================
// Group t8: "Client by ART number" (v1 sp_GetDetailsFromARTNumber, "lookup" below) and "VL results for a
// facility's clients" (v1 sp_getFacilityVLClientDetails, "facility" below). Fixture ids start with "t8-"; lab
// ids with "T8-" ("T8-A.." for the lookup, "T8-.." for the facility report). "lookup line N" and "facility line N"
// are lines of those two v1 files. Expected rows are worked out by hand from the v1 text.
// ============================================================================================

const P8 = [];
const R8 = [];
const D8 = [];
const L8 = [];
const A8 = [];
let n8 = 0;
const k8 = () => String(++n8).padStart(3, '0');
const REF = 'reference-numbers';
const UNQ = 'unique-id';

// ---- Lookup fixtures: one request (a Patients row in v1) per case. ----
// names: [firstname, surname] or null for a request with no patient.
function look(labId, ref, uq, names) {
  const k = k8();
  const qid = `t8-q${k}`;
  let pid = null;
  if (names) {
    pid = `t8-p${k}`;
    P8.push(`(${lit(pid)}, ${lit(names[1])}, ${lit(names[0])}, 'F')`);
  }
  R8.push(`(${lit(qid)}, ${lit(labId)}, 'HIVVL', null, null, null, ${lit(pid)})`);
  if (ref !== null) A8.push(`(${lit(`t8-a${k}r`)}, ${lit(qid)}, ${lit(ATTR_SYSTEM)}, ${lit(REF)}, ${lit(ref)})`);
  if (uq !== null) A8.push(`(${lit(`t8-a${k}u`)}, ${lit(qid)}, ${lit(ATTR_SYSTEM)}, ${lit(UNQ)}, ${lit(uq)})`);
  return qid;
}

look('T8-A01', '12345', 'U-1', ['Ann', 'Bwalya']);                  // else branch (line 27): REFNO as is
look('T8-A02', 'AT.12 345', 'U-2', ['Ben', 'Chola']);               // "AT." removed, space removed: 12345
look('T8-A03', '', 'AB-12 34', ['Carol', 'Daka']);                  // REFNO blank (line 24): UNIQUEID without spaces and dashes
look('T8-A04', 'ART.555', 'AB-1234', ['Dan', 'Ejoh']);              // starts ART. (line 25): UNIQUEID, dash removed
look('T8-A05', 'ELABS.77', 'X-9', ['Eve', 'Phiri']);                // starts ELABS. (line 26): UNIQUEID
// This procedure has no ",ELABS" text-extraction steps (lookup lines 22-28), so the text is only cleaned:
// the comma and "AT." go, then spaces. "ELABS 12AT.3456" -> "ELABS 123456" -> "ELABS123456".
look('T8-A06', ',ELABS 12AT.3456', 'U-6', ['Fay', 'Zulu']);
look('T8-A07', 'art12345,ELABS 99', 'U-7', ['Gus', 'Mwale']);       // comma and spaces go: art12345ELABS99
look('T8-A08', ' , AT. ', 'Q-1', ['Hana', 'Sata']);                 // nothing left (line 24): UNIQUEID Q1
look('T8-A09', '1234at.5', 'U-9', ['Ian', 'Tembo']);                // REPLACE ignores case: "at." goes: 12345
look('T8-A10', ',ART.5', 'Z-1', ['Jo', 'Nkole']);                   // comma removed, starts ART.: UNIQUEID Z1
look('T8-A11', null, null, ['Kim', 'Lungu']);                       // no attributes: nothing, ART number ''
look('T8-A12', '12345', 'U-12', null);                              // no patient: v1 Patients row without names
// One lab id, two request rows (OBR sets), one patient: v1 Patients has one row per RequestID, so one row.
{
  const pid = 't8-p-a13';
  P8.push(`(${lit(pid)}, 'Mumba', 'Lee', 'F')`);
  for (let i = 0; i < 2; i++) {
    const k = k8();
    R8.push(`(${lit(`t8-q${k}`)}, 'T8-A13', 'HIVVL', null, null, null, ${lit(pid)})`);
    A8.push(`(${lit(`t8-a${k}r`)}, ${lit(`t8-q${k}`)}, ${lit(ATTR_SYSTEM)}, ${lit(REF)}, '99001')`);
  }
}
look('T8-A14', '777 ', 'U', ['Mia', 'Simba']);                      // trailing space kept in REFNO, spaces removed: 777
look('T8-A15', '777', 'U', ['Ned', 'Sakala']);

// ---- Facility fixtures. Defaults: Choma General Hospital, one HIVVL result of 540, final report. ----
// o: req, panel, status, ref, uq, ana, auth, eff, iss, results [{ obs, num, text, cmp, coded }], noReport.
const F_DEFAULTS = {
  req: 'ZSOUT', panel: 'HIVVL', status: 'final', uq: null,
  auth: '2026-05-02T08:00:00Z', ana: '2026-05-02T09:00:00Z', eff: '2026-05-01T07:00:00Z', iss: '2026-05-02T13:00:00Z',
  results: [{ obs: 'HIVVL', num: 540 }], noReport: false,
};
function fac(labId, o = {}) {
  const r = { ...F_DEFAULTS, ref: `N${labId}`, ...o };
  const k = k8();
  const qid = `t8-q${k}`;
  R8.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.auth)}, ${lit(r.ana)}, ${lit(r.req)}, null)`);
  if (!r.noReport) D8.push(`(${lit(`t8-d${k}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.eff)}, ${lit(r.iss)}, 'LUS')`);
  r.results.forEach((x, i) => {
    L8.push(`(${lit(`t8-r${k}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs ?? 'HIVVL')}, ${lit(x.text ?? null)}, ${sql6(x.num)}, ${lit(x.cmp ?? null)}, ${lit(x.coded ?? null)})`);
  });
  if (r.ref !== null) A8.push(`(${lit(`t8-a${k}r`)}, ${lit(qid)}, ${lit(ATTR_SYSTEM)}, ${lit(REF)}, ${lit(r.ref)})`);
  if (r.uq !== null) A8.push(`(${lit(`t8-a${k}u`)}, ${lit(qid)}, ${lit(ATTR_SYSTEM)}, ${lit(UNQ)}, ${lit(r.uq)})`);
}

// In the window and through every filter. The comment is the row's serial number (the rank of its lab id among
// all rows in the window, any facility), then what it shows.
fac('T8-01', { ref: '1001', uq: 'U1' });                                                 // 1: 540 < 1000, ART 1001
fac('T8-02', { ref: 'AT.2002', results: [{ num: 1500 }] });                              // 2: "AT." removed (facility line 33): 2002
fac('T8-03', { ref: '', uq: 'U-3 3', results: [{ text: 'target not detected' }] });      // 3: REFNO blank: UNIQUEID as is, spaces and dash kept
fac('T8-04', { req: 'ZCHO2', ref: 'ART.555', uq: 'AB-1 2', results: [{ text: '>10000000 copies/mL' }] }); // 4: Choma Clinic; starts ART.
fac('T8-05', { ref: 'ELABS.5', uq: 'E-7', results: [{ num: 999 }] });                    // 5: starts ELABS.: UNIQUEID
fac('t8-06', { ref: '1006', results: [{ text: 'Rejected sample' }] });                  // 6: a lower-case lab id sorts by its lower-case text; no flag
// Left out by the invalid-text list or the null result (the 13 texts, NOT IN drops NULL): no serial number.
fac('T8-07', { results: [{ text: 'haemolysed ' }] });
fac('T8-08', { results: [{ text: 'INVAL' }] });
fac('T8-09', { results: [{}] });
fac('T8-10', { ref: '1010', results: [{ coded: 'BLOQ' }] });                            // 7: result is the coded value; coded value present: Suppressed 1
fac('T8-11', { ref: ',AT.4004', results: [{ num: 3000, coded: 'HIGH' }] });             // 8: both flags (coded value, and 3000 >= 1000)
fac('T8-12', { ref: ' ', uq: 'BL 1', results: [{ num: 2000, coded: '   ' }] });         // 9: REFNO only a space: UNIQUEID; a blank coded value has length 0
fac('T8-13', { ref: '10 01', results: [{ num: 1000 }] });                               // 10: spaces are kept in the ART number; 1000 is not under 1000
fac('T8-14', { ref: '1014', results: [{ text: '999.5' }] });                            // 11: a decimal text (v1 stops here; the port reads the number)
fac('T8-15', { ref: '1015', results: [{ text: '1200.5' }] });                           // 12: the same, over 1000
fac('T8-16', { ref: '1016', results: [{ text: '<20 COPIES/ML ' }] });                   // 13: the list ignores case and trailing spaces
fac('T8-17', { ref: '1017', results: [{ cmp: '<', num: 20 }] });                        // 14: result text is "< 20", on the list
fac('T8-18', { ref: '1018', results: [{ text: 'ND' }] });                               // 15: not on this procedure's list
fac('T8-19', { ref: '1019', results: [{ obs: 'HIVVC', num: 450 }] });                   // 16: observation HIVVC
fac('T8-20', { ref: '1020', results: [{ obs: 'hivvc', num: 1800 }] });                  // 17: the observation compares ignoring case
// Left out by panel, observation, report status or no report.
fac('T8-21', { results: [{ obs: 'HIVTM', num: 100 }] });
fac('T8-22', { panel: 'POHVL' });
fac('T8-23', { ref: '1023', panel: 'hivvl', results: [{ num: 320 }] });                  // 18: the panel compares ignoring case
fac('T8-24', { status: 'cancelled' });
fac('T8-25', { status: 'unknown' });
fac('T8-26', { noReport: true });
fac('T8-27', { ref: '2727', results: [{ obs: 'HIVVL', num: 540 }, { obs: 'HIVVC', num: 540 }] }); // 19 and 20: one row per result
fac('T8-28', { req: 'ZUNMP' });                                                          // 21: a facility not in the register: numbered, never shown
fac('T8-29', { req: 'ZNONE' });                                                          // 22: a code not in the map at all
fac('T8-30', { req: null });                                                             // 23: no requesting facility
// Turnaround times. Local dates, not UTC (stamps at +02:00 near midnight).
fac('T8-31', { ref: '3131', results: [{ num: 700 }], eff: '2026-05-01T23:50:00+02:00', auth: '2026-05-02T00:05:00+02:00',
  ana: '2026-05-02T00:10:00+02:00', iss: '2026-05-02T00:40:00+02:00' });                 // 24: TAT1 1 (local 05-01 to 05-02; UTC would say 0), TAT3 1800 s
fac('T8-32', { ref: '3232', results: [{ num: 700 }], eff: '2026-05-01T22:00:00+02:00', auth: '2026-05-01T23:30:00+02:00',
  ana: '2026-05-02T00:10:00+02:00', iss: '2026-05-02T00:11:40+02:00' });                 // 25: TAT2 1 (UTC would say 0), TAT3 100 s
fac('T8-33', { ref: '3333', results: [{ num: 600 }], eff: null, iss: null });            // 26: no collection date, no authorised date
fac('T8-34', { ref: '3434', results: [{ num: 600 }], iss: '2026-05-02T08:00:00Z' });     // 27: authorised before analysis: negative hours
fac('T8-35', { ref: '3535', results: [{ num: 600 }], auth: null });                      // 28: no registered date
fac('T8-36', { ref: '3636', results: [{ num: 600 }], iss: '2026-05' });                  // 29: a partial stamp gives NULL, never an error
// The window is on AnalysisDateTime with dates at 00:00:00: from 00:00:00 up to and including to 00:00:00, local time.
fac('T8-37', { ref: '3737', results: [{ num: 100 }], auth: '2026-05-01T00:00:00+02:00', ana: '2026-05-01T00:00:00+02:00',
  iss: '2026-05-01T01:00:00+02:00' });                                                   // 30: exactly 05-01 00:00:00 local (UTC 04-30): in
fac('T8-38', { ana: '2026-04-30T23:59:59+02:00' });                                       // out: one second before
fac('T8-39', { ref: '3939', results: [{ num: 200 }], eff: '2026-05-30T07:00:00Z', auth: '2026-05-31T00:00:00+02:00',
  ana: '2026-05-31T00:00:00+02:00', iss: '2026-05-31T02:00:00+02:00' });                 // 31: exactly 05-31 00:00:00 local: in (BETWEEN is inclusive)
fac('T8-40', { ana: '2026-05-31T00:00:01+02:00' });                                       // out: one second into the end day
fac('T8-41', { ana: '2026-06-01T00:30:00+02:00' });                                       // out
fac('T8-42', { ana: null });                                                              // out: no analysis date
fac('T8-43', { ref: '4343', results: [{ num: 300 }], auth: '2026-05-30T20:00:00Z', ana: '2026-05-30T23:59:59Z',
  iss: '2026-05-31T00:59:59Z' });                                                        // 32: 05-30 23:59:59: in the 05-31 window, out of a 05-30 window
fac('T8-44', { req: 'ZCHO3', ref: 'C44', results: [{ num: 100 }] });                    // 33: a second register entry named "Choma Clinic"
// Lab numbers that SQL Server (Latin1_General_CI_AS, the collation of v1's text columns) and byte order sort differently. The word sort ignores
// the hyphen, so 'U8-1' sorts as 'U81'. SQL Server: ':' < '@' < '_' < 'U8-1' (as 'U81') < 'U891' < 'U8A1'; byte order: '-' < digits < ':' < '@' <
// letters < '_'. They all sort after the T8- numbers in both. Serials 34 to 39 in SQL Server's order.
fac('U8:1', { ref: '8002' });   // 34
fac('U8@1', { ref: '8003' });   // 35
fac('U8_1', { ref: '8004' });   // 36
fac('U8-1', { ref: '8001' });   // 37
fac('U891', { ref: '8005' });   // 38
fac('U8A1', { ref: '8006' });   // 39

const SETUP8 = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t8-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t8-fm2', '', '', 'ZCHO2', 'reg-c', 'Choma Clinic', 'Southern', 'Choma'),
  ('t8-fm3', '', '', 'ZCHO3', 'reg-d', 'Choma Clinic', 'Southern', 'Choma'),
  ('t8-fm4', '', '', 'ZUNMP', null, null, null, null);
insert into patients (id, surname, firstname, sex) values ${P8.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id) values ${R8.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer) values ${D8.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values ${L8.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${A8.join(',\n  ')};`;

// ---- Expected rows: lookup ----

const LOOKUP_COLUMNS = ['Lab Number', 'FIRSTNAME', 'SURNAME'];
const lk = (lab, first, last) => ({ 'Lab Number': lab, FIRSTNAME: first, SURNAME: last });
const lookupQuery = queries().find((q) => q.name === 'Client by ART number');
const lookupSuite = (name, art, rows, setup = '') =>
  orderedSuite(name, lookupQuery?.sql ?? 'select 1', { art_number: art }, LOOKUP_COLUMNS, rows, setup);

// ---- Expected rows: facility ----

const FACILITY_COLUMNS = ['Facility Name', 'SerialNumber', 'ARTNo', 'VL Result', 'Suppressed', 'Unsupressed', 'TAT1', 'TAT2', 'TAT3'];
const CGH = 'Choma General Hospital';
const fv = (serial, art, result, sup, unsup, tat1, tat2, tat3, name = CGH) =>
  Object.fromEntries(FACILITY_COLUMNS.map((c, i) => [c, [name, serial, art, result, sup, unsup, tat1, tat2, tat3][i]]));
// Default times: collected 05-01, registered 05-02 (TAT1 1), analysed 05-02 (TAT2 0), authorised 4 hours later (TAT3 4).
const FAC_GENERAL = [
  fv(1, '1001', '540', 1, 0, 1, 0, 4),
  fv(2, '2002', '1500', 0, 1, 1, 0, 4),
  fv(3, 'U-3 3', 'target not detected', 1, 0, 1, 0, 4),          // 'Target Not Detected' is on the list; the compare ignores case
  fv(5, 'E-7', '999', 1, 0, 1, 0, 4),
  fv(6, '1006', 'Rejected sample', 0, 0, 1, 0, 4),
  fv(7, '1010', 'BLOQ', 1, 0, 1, 0, 4),
  fv(8, '4004', '3000', 1, 1, 1, 0, 4),
  fv(9, 'BL 1', '2000', 0, 1, 1, 0, 4),
  fv(10, '10 01', '1000', 0, 1, 1, 0, 4),
  fv(11, '1014', '999.5', 1, 0, 1, 0, 4),                         // intent: v1 stops on a decimal text
  fv(12, '1015', '1200.5', 0, 1, 1, 0, 4),                        // intent: v1 stops on a decimal text
  fv(13, '1016', '<20 COPIES/ML ', 1, 0, 1, 0, 4),
  fv(14, '1017', '< 20', 1, 0, 1, 0, 4),
  fv(15, '1018', 'ND', 0, 0, 1, 0, 4),
  fv(16, '1019', '450', 1, 0, 1, 0, 4),
  fv(17, '1020', '1800', 0, 1, 1, 0, 4),
  fv(18, '1023', '320', 1, 0, 1, 0, 4),
  fv(19, '2727', '540', 1, 0, 1, 0, 4),                           // two results of one request: same row twice, serials 19 and 20
  fv(20, '2727', '540', 1, 0, 1, 0, 4),
  fv(24, '3131', '700', 1, 0, 1, 0, 0.5),
  fv(25, '3232', '700', 1, 0, 0, 1, 0.0277777),
  fv(26, '3333', '600', 1, 0, null, 0, null),
  fv(27, '3434', '600', 1, 0, 1, 0, -1),
  fv(28, '3535', '600', 1, 0, null, null, 4),
  fv(29, '3636', '600', 1, 0, 1, 0, null),
  fv(30, '3737', '100', 1, 0, 0, 0, 1),
  fv(31, '3939', '200', 1, 0, 1, 0, 2),
  fv(32, '4343', '300', 1, 0, 29, 0, 1),
  fv(34, '8002', '540', 1, 0, 1, 0, 4),
  fv(35, '8003', '540', 1, 0, 1, 0, 4),
  fv(36, '8004', '540', 1, 0, 1, 0, 4),
  fv(37, '8001', '540', 1, 0, 1, 0, 4),
  fv(38, '8005', '540', 1, 0, 1, 0, 4),
  fv(39, '8006', '540', 1, 0, 1, 0, 4),
];
const FAC_CLINIC = [
  fv(4, 'AB-1 2', '>10000000 copies/mL', 0, 1, 1, 0, 4, 'Choma Clinic'),
  fv(33, 'C44', '100', 1, 0, 1, 0, 4, 'Choma Clinic'),
];
const factSuite = (name, facility, from, to, rows, setup = '') =>
  orderedSuite(name, factQuery?.sql ?? 'select 1', { facility, from, to }, FACILITY_COLUMNS, rows, setup);
const factQuery = queries().find((q) => q.name === "VL results for a facility's clients");

// A suite that reads one column as text, for the scale of TAT3 (decimal(15,7) in SQL Server: 7 places, cut not rounded).
function tat3TextSuite(name, rows) {
  return {
    name,
    sql: `select ${lit(name)} || chr(9) || json_build_object('serial', q."SerialNumber", 't3', q."TAT3"::text)::text
      from (${bind(factQuery?.sql ?? 'select 1', { facility: CGH, ...win })}) q;`,
    count: rows.length + 1,
    check(got) {
      const bad = [];
      if (got.length !== FAC_GENERAL.length) bad.push(`expected ${FAC_GENERAL.length} rows, got ${got.length}`);
      for (const [serial, want] of rows) {
        const row = got.find((g) => g.serial === serial);
        if (!row) bad.push(`serial ${serial}: no row`);
        else if (row.t3 !== want) bad.push(`serial ${serial}: expected TAT3 ${JSON.stringify(want)}, got ${JSON.stringify(row.t3)}`);
      }
      return bad;
    },
  };
}

const suites8 = [
  // v1 lookup lines 22-29, on the 15 cases above. The first suite carries every t8 fixture row.
  lookupSuite('art-12345', '12345', [lk('T8-A01', 'Ann', 'Bwalya'), lk('T8-A02', 'Ben', 'Chola'), lk('T8-A09', 'Ian', 'Tembo'), lk('T8-A12', null, null)], SETUP8),
  lookupSuite('art-ab1234', 'AB1234', [lk('T8-A03', 'Carol', 'Daka'), lk('T8-A04', 'Dan', 'Ejoh')]),
  lookupSuite('art-case', 'ab1234', [lk('T8-A03', 'Carol', 'Daka'), lk('T8-A04', 'Dan', 'Ejoh')]),
  lookupSuite('art-elabs-prefix', 'X9', [lk('T8-A05', 'Eve', 'Phiri')]),
  // No ",ELABS" text extraction here: the text after "T." (3456) is not the ART number; the cleaned text is.
  lookupSuite('art-elabs-text-extraction-absent', '3456', []),
  lookupSuite('art-elabs-comma', 'ELABS123456', [lk('T8-A06', 'Fay', 'Zulu')]),
  lookupSuite('art-elabs-comma-case', 'ART12345ELABS99', [lk('T8-A07', 'Gus', 'Mwale')]),
  lookupSuite('art-blank-ref', 'Q1', [lk('T8-A08', 'Hana', 'Sata')]),
  lookupSuite('art-art-prefix', 'Z1', [lk('T8-A10', 'Jo', 'Nkole')]),
  lookupSuite('art-one-row-per-lab-id', '99001', [lk('T8-A13', 'Lee', 'Mumba')]),
  // SQL Server compares ignoring trailing spaces: a parameter with one still matches.
  lookupSuite('art-trailing-space', '777 ', [lk('T8-A14', 'Mia', 'Simba'), lk('T8-A15', 'Ned', 'Sakala')]),
  // The dash is removed from the derived value, not from the parameter: 'AB-1234' matches nothing.
  lookupSuite('art-dash-in-parameter', 'AB-1234', []),
  lookupSuite('art-nothing', 'NOPE', []),
  {
    name: 'lookup-shape',
    count: 4,
    check() {
      const bad = [];
      if (!lookupQuery) return ['query "Client by ART number" is missing'];
      const ids = lookupQuery.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['art_number'])) bad.push(`params: ${ids}`);
      if (lookupQuery.params[0].type !== 'text' || !lookupQuery.params[0].required) bad.push('art_number is a required text parameter');
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(lookupQuery.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      return bad;
    },
  },
  // Facility report. The whole window, one facility: serial numbers have gaps (rows of other facilities, of a
  // facility not in the register, and of a code in no map are numbered too: facility lines 27 and 83).
  factSuite('facility-choma-general', CGH, '2026-05-01', '2026-05-31', FAC_GENERAL),
  factSuite('facility-name-fold', 'choma general hospital  ', '2026-05-01', '2026-05-31', FAC_GENERAL),
  // Two register entries share the name: v1 joins on the code and compares the name, so both show.
  factSuite('facility-choma-clinic', 'Choma Clinic', '2026-05-01', '2026-05-31', FAC_CLINIC),
  factSuite('facility-unknown', 'Nowhere Clinic', '2026-05-01', '2026-05-31', []),
  // v1 has no all-facilities mode: a blank name matches no facility (none has an empty description).
  factSuite('facility-blank', '', '2026-05-01', '2026-05-31', []),
  // The window ends at to 00:00:00 (BETWEEN with dates). 05-30: T8-39 (05-31 00:00:00) and T8-43 are out, and the
  // rows are renumbered (T8-44 is now 31): the numbering runs over the window, before the facility filter.
  factSuite('facility-window-0530', 'Choma Clinic', '2026-05-01', '2026-05-30', [
    fv(4, 'AB-1 2', '>10000000 copies/mL', 0, 1, 1, 0, 4, 'Choma Clinic'),
    fv(31, 'C44', '100', 1, 0, 1, 0, 4, 'Choma Clinic'),
  ]),
  // A one-day window holds only analyses at exactly 00:00:00 of that day (v1 end-date quirk): nothing here.
  factSuite('facility-window-one-day', CGH, '2026-05-02', '2026-05-02', []),
  // 05-01 00:00:00 local is in a window that starts that day (UTC is 04-30 22:00).
  factSuite('facility-window-start-edge', CGH, '2026-05-01', '2026-05-01', [fv(1, '3737', '100', 1, 0, 0, 0, 1)]),
  tat3TextSuite('facility-tat3-scale', [[1, '4.0000000'], [24, '0.5000000'], [25, '0.0277777'], [26, null], [27, '-1.0000000'], [29, null]]),
  {
    name: 'facility-shape',
    count: 5,
    check() {
      const bad = [];
      if (!factQuery) return ['query "VL results for a facility\'s clients" is missing'];
      const ids = factQuery.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['facility', 'from', 'to'])) bad.push(`params: ${ids}`);
      const byId = Object.fromEntries(factQuery.params.map((p) => [p.id, p]));
      if (byId.facility.type !== 'text') bad.push('facility is a text parameter');
      if (!byId.facility.required || !byId.from.required || !byId.to.required) bad.push('facility, from and to are required (v1 has no all-facilities mode)');
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(factQuery.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      return bad;
    },
  },
];


// ============================================================================================
// Group t9: "Earlier VL results of high-VL clients" (v1 sp_GetPreviousVLResultforCohort, "T1" below) and "VL results
// history by client" (v1 sp_GetPreviousVLResultforCohort2 with its _Prega copy merged in, "T2" below). Fixture ids start
// with "t9-"; lab ids with "T9-". "T1 line N" is a line of StoredProcedure__dbo_sp_GetPreviousVLResultforCohort.sql,
// "T2 line N" of ...Cohort2.sql, "T2P line N" of ...Cohort2_Prega.sql. Expected rows are worked out by hand from the
// v1 text. Window used by most cases: from 2026-05-01, to 2026-05-31.
// ============================================================================================

const P9 = [];
const R9 = [];
const D9 = [];
const L9 = [];
const A9 = [];
const F9 = [];
let n9 = 0;
const k9 = () => String(++n9).padStart(3, '0');
const sqlNum9 = (v) => (v === null || v === undefined ? 'null' : String(v));

// One lab number with one request row, one final report and one result. o: art (REFNO), uq (UNIQUEID), req, sex (null
// = no patient), panel, status, obs, num, text, form [[linkId, answer]] (on this request row), viral [[linkId, answer]]
// (a second request row of the lab number, panel VIRAL, holding the form: no report, no result).
const L9_DEFAULTS = { req: 'ZSOUT', sex: 'F', panel: 'HIVVL', status: 'final', obs: 'HIVVL', uq: null, num: null, text: null };
function res9(labId, art, issued, o = {}) {
  const r = { ...L9_DEFAULTS, art, issued, ...o };
  const k = k9();
  const qid = `t9-q${k}`;
  let pid = null;
  if (r.sex !== null) {
    pid = `t9-p${k}`;
    P9.push(`(${lit(pid)}, 'P${k}', ${lit(r.sex)})`);
  }
  R9.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, null, null, ${lit(r.req)}, ${lit(pid)})`);
  D9.push(`(${lit(`t9-d${k}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.issued)}, 'LUS')`);
  L9.push(`(${lit(`t9-r${k}`)}, ${lit(qid)}, ${lit(r.obs)}, ${lit(r.text)}, ${sqlNum9(r.num)}, null)`);
  A9.push(`(${lit(`t9-a${k}r`)}, ${lit(qid)}, ${lit(ATTR_SYSTEM)}, ${lit(REF)}, ${lit(r.art)})`);
  if (r.uq !== null) A9.push(`(${lit(`t9-a${k}u`)}, ${lit(qid)}, ${lit(ATTR_SYSTEM)}, ${lit(UNQ)}, ${lit(r.uq)})`);
  const form = (hostId, answers, suffix) => {
    const items = answers.map(([linkId, text]) => ({ linkId, answer: [{ valueString: text }] }));
    F9.push(`(${lit(`t9-f${k}${suffix}`)}, 'q', 'hiv_vl_documentation', ${lit(hostId)}, '2026-05-02T08:00:00Z', ${lit(JSON.stringify(items))})`);
  };
  if (r.form) form(qid, r.form, '');
  if (r.viral) {
    const vid = `t9-q${k}v`;
    R9.push(`(${lit(vid)}, ${lit(labId)}, 'VIRAL', null, null, ${lit(r.req)}, ${lit(pid)})`);
    A9.push(`(${lit(`t9-a${k}vr`)}, ${lit(vid)}, ${lit(ATTR_SYSTEM)}, ${lit(REF)}, ${lit(r.art)})`);
    form(vid, r.viral, 'v');
  }
}

// ---- Clients at Choma General Hospital (ZSOUT) unless said otherwise ----
// 1001: two older results and one in the window. T1: [200, 450, 1500]. T2: ranks 3, 2, 1.
res9('T9-01', '1001', '2025-06-10T08:00:00Z', { num: 200 });
res9('T9-02', '1001', '2025-12-15T08:00:00Z', { num: 450 });
res9('T9-03', '1001', '2026-05-10T08:00:00Z', { num: 1500 });
// 2002: a high result before the window only: no cohort, no row.
res9('T9-04', '2002', '2026-04-01T08:00:00Z', { num: 5000 });
// 3003: a result of 300 in the window: under four characters, so not in T1's cohort; in T2's cohort (any valid result).
res9('T9-05', '3003', '2026-05-12T08:00:00Z', { num: 300 });
// 4004: INVAL is on the exclusion list (not shown, and not a cohort result); 1000 has four characters.
res9('T9-06', '4004', '2026-03-01T08:00:00Z', { num: 100 });
res9('T9-07', '4004', '2026-05-05T08:00:00Z', { text: 'INVAL' });
res9('T9-08', '4004', '2026-05-20T08:00:00Z', { num: 1000 });
// 5005: REFNO "ART.99" sends the ART number to UNIQUEID "AB-5 5": AB55. A text result below the cutoff.
res9('T9-09', 'ART.99', '2026-02-01T08:00:00Z', { uq: 'AB-5 5', text: '<20 copies/mL' });
res9('T9-10', 'ART.99', '2026-05-08T08:00:00Z', { uq: 'AB-5 5', num: 2500 });
// 6006: the cohort test of T1 has no panel or observation filter: a high result of another test puts the client in.
res9('T9-11', '6006', '2026-03-10T08:00:00Z', { num: 90 });
res9('T9-12', '6006', '2026-05-11T08:00:00Z', { num: 3000, panel: 'POHVL', obs: 'HIVTM' });
// 7007: two sexes under one ART number. Visits count per sex, the pivot merges them with Max.
res9('T9-13', '7007', '2026-03-01T08:00:00Z', { num: 110, sex: 'F' });
res9('T9-14', '7007', '2026-03-02T08:00:00Z', { num: 120, sex: 'M' });
res9('T9-15', '7007', '2026-05-09T08:00:00Z', { num: 2000, sex: 'F' });
// 8008: panel and observation compare ignoring case.
res9('T9-16', '8008', '2026-04-10T08:00:00Z', { num: 800, panel: 'hivvl', obs: 'hivvc' });
res9('T9-17', '8008', '2026-05-15T08:00:00Z', { num: 4000 });
// Edges. T1 history is datediff(dd, authorised, from) < 366 (line 55) on LOCAL dates; the cohort window is authorised
// between from and to as datetimes (line 92), so the end day is out apart from 00:00:00; x needs authorised < to (line 56).
res9('T9-18', 'E101', '2025-05-01T00:30:00+02:00', { num: 150 });   // local 2025-05-01: 365 days before: in (UTC would say 366: out)
res9('T9-19', 'E101', '2026-05-03T08:00:00Z', { num: 1200 });
res9('T9-20', 'E102', '2025-04-30T23:30:00+02:00', { num: 160 });   // 366 days: out of T1's history, in T2's
res9('T9-21', 'E102', '2026-05-03T08:00:00Z', { num: 1300 });
res9('T9-22', 'E103', '2026-05-01T00:00:00+02:00', { num: 3500 });  // exactly the start, local (UTC is 04-30): in
res9('T9-23', 'E104', '2026-05-31T00:00:00+02:00', { num: 3600 });  // exactly the end: in the cohort, out of x
res9('T9-24', 'E104', '2026-04-01T08:00:00Z', { num: 170 });
res9('T9-25', 'E105', '2026-05-31T00:00:01+02:00', { num: 3700 });  // one second after the end: out of both
res9('T9-26', 'E105', '2026-04-02T08:00:00Z', { num: 180 });
res9('T9-27', 'E106', '2026-04-30T23:59:59+02:00', { num: 3800 });  // one second before the start: not in the cohort
// Status and observation.
res9('T9-28', 'S101', '2026-03-01T08:00:00Z', { num: 130, status: 'cancelled' });
res9('T9-29', 'S101', '2026-05-05T08:00:00Z', { num: 2200 });
res9('T9-30', 'S102', '2026-05-06T08:00:00Z', { text: '5,000' });
res9('T9-31', 'S103', '2026-04-20T08:00:00Z', { num: 700 });
res9('T9-32', 'S103', '2026-05-14T08:00:00Z', { num: 1800, obs: 'HIVVD' });   // T1 reads HIVVL and HIVVC only; T2 adds HIVVD
// Other facilities.
res9('T9-33', 'F101', '2026-03-05T08:00:00Z', { num: 140, req: 'ZCHO2' });  // Choma Clinic
res9('T9-34', 'F101', '2026-05-04T08:00:00Z', { num: 2100, req: 'ZCHO2' });
res9('T9-35', 'F102', '2026-03-06T08:00:00Z', { num: 145, req: 'ZLUSA' });  // Chilenje Clinic, Lusaka
res9('T9-36', 'F102', '2026-05-05T08:00:00Z', { num: 2300, req: 'ZLUSA' });
res9('T9-37', 'F103', '2026-05-06T08:00:00Z', { num: 2400, req: 'ZKAFU' }); // Kafue District Hospital
res9('T9-38', 'F104', '2026-05-07T08:00:00Z', { num: 2500, req: 'ZUNMP' }); // in the map, not in the register: no row
res9('T9-39', 'F105', '2026-05-07T08:00:00Z', { num: 2500, req: 'ZNONE' }); // no map row: no row
res9('T9-40', 'F106', '2026-05-07T08:00:00Z', { num: 2500, req: null });    // no facility: no row
// One ART number at two facilities: the facility is part of the join. Lusaka has no result in the window.
res9('T9-41', 'G101', '2026-03-07T08:00:00Z', { num: 155 });
res9('T9-42', 'G101', '2026-05-08T08:00:00Z', { num: 2600 });
res9('T9-43', 'G101', '2026-03-08T08:00:00Z', { num: 156, req: 'ZLUSA' });
// A client with no ART number at all ('' for blank REFNO and UNIQUEID).
res9('T9-44', '', '2026-05-09T08:00:00Z', { uq: '', num: 2700 });
// ART numbers that differ only in case are one client.
res9('T9-45', 'k101', '2026-03-09T08:00:00Z', { num: 165 });
res9('T9-46', 'K101', '2026-05-10T08:00:00Z', { num: 2800 });
// Twelve results: T1 shows visits 1 to 10 only.
const M9 = ['2025-06-05', '2025-07-05', '2025-08-05', '2025-09-05', '2025-10-05', '2025-11-05', '2025-12-05', '2026-01-05', '2026-02-05', '2026-03-05', '2026-04-05'];
M9.forEach((d, i) => res9(`T9-${47 + i}`, 'M101', `${d}T08:00:00Z`, { num: 201 + i }));
res9('T9-58', 'M101', '2026-05-05T08:00:00Z', { num: 1111 });
// No patient row: sex is empty, one partition.
res9('T9-73', 'N101', '2026-03-01T08:00:00Z', { num: 175, sex: null });
res9('T9-74', 'N101', '2026-05-19T08:00:00Z', { num: 3300, sex: null });
// A two-sex client: visit 1 of the pivot holds '<20 copies/mL' (F) and '150' (M). SQL Server's MAX picks '150' ('<' sorts before digits).
res9('T9-83', 'Q101', '2026-03-01T08:00:00Z', { text: '<20 copies/mL', sex: 'F' });
res9('T9-84', 'Q101', '2026-03-02T08:00:00Z', { num: 150, sex: 'M' });
res9('T9-85', 'Q101', '2026-05-11T08:00:00Z', { num: 1400, sex: 'F' });
// Two results in the window: T2 joins every x row to every cohort row of the client, so each row shows twice.
res9('T9-75', 'D101', '2026-05-20T08:00:00Z', { num: 1100 });
res9('T9-76', 'D101', '2026-05-21T08:00:00Z', { num: 1200 });
// T2 history is under 730 days: 2024-05-02 local (729 days) in, 2024-05-01 local (730) out; UTC would flip the first.
res9('T9-77', 'H101', '2024-05-02T00:30:00+02:00', { num: 190 });
res9('T9-78', 'H101', '2024-05-01T23:30:00+02:00', { num: 191 });
res9('T9-79', 'H101', '2026-05-22T08:00:00Z', { num: 2900 });
// A text on the exclusion list is not a visit.
res9('T9-80', 'V101', '2026-04-01T08:00:00Z', { text: 'Absent' });
res9('T9-81', 'V101', '2026-05-23T08:00:00Z', { num: 1300 });
// Pregnancy (T2 with pregnant_only = yes): the VIRAL form answers, T2P lines 111-129. Results under 1000, so T1 ignores them.
res9('T9-60', 'P101', '2026-05-12T08:00:00Z', { num: 600, viral: [['ARTPR', 'Yes']] });   // form on a VIRAL row of the lab number
res9('T9-61', 'P101', '2026-02-01T08:00:00Z', { num: 500 });
res9('T9-62', 'P102', '2026-05-13T08:00:00Z', { num: 700, form: [['VPREG', 'Y']] });      // form on the result's own row
res9('T9-63', 'P102', '2026-01-01T08:00:00Z', { num: 650 });
res9('T9-64', 'P103', '2026-05-14T08:00:00Z', { num: 800, form: [['ARTRS', 'pregnant mother ']] });
res9('T9-65', 'P104', '2026-05-15T08:00:00Z', { num: 900, form: [['ARTPR', 'No']] });      // not pregnant
res9('T9-66', 'P105', '2026-05-16T08:00:00Z', { num: 950 });
res9('T9-67', 'P105', '2026-02-10T08:00:00Z', { num: 500, form: [['ARTPR', 'Yes']] });     // pregnant, but a lab authorised before the window
res9('T9-68', 'P106', '2026-05-17T08:00:00Z', { num: 960 });                               // pregnant at another facility only
res9('T9-69', 'P106', '2026-05-17T08:00:00Z', { num: 990, req: 'ZLUSA', form: [['ARTPR', 'Yes']] });
res9('T9-70', 'P107', '2026-05-31T00:00:00+02:00', { num: 970, form: [['ARTPR', 'Y']] }); // the form's lab is authorised at the end instant: in
res9('T9-71', 'P107', '2026-05-02T08:00:00Z', { num: 980 });
res9('T9-72', 'P108', '2026-05-18T08:00:00Z', { num: 995, form: [['VPREG', 'YES ']] });
res9('T9-82', 'P109', '2026-05-19T08:00:00Z', { num: 996, form: [['ARTRS', 'Pregnant']] }); // not the exact text: not pregnant

const SETUP9 = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t9-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t9-fm2', '', '', 'ZCHO2', 'reg-c', 'Choma Clinic', 'Southern', 'Choma'),
  ('t9-fm3', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('t9-fm4', '', '', 'ZUNMP', null, null, null, null),
  ('t9-fm5', '', '', 'ZKAFU', 'reg-k', 'Kafue District Hospital', 'Lusaka', 'Kafue'),
  ('t9-fm6', '', '', 'ZMISS', null, null, null, null);
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id) values ${R9.join(',\n  ')};
insert into patients (id, surname, sex) values ${P9.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, issued, performer) values ${D9.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator) values ${L9.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${A9.join(',\n  ')};
insert into questionnaire_responses (id, questionnaire, form_code, based_on_id, authored, items) values ${F9.join(',\n  ')};`;

// ---- Expected rows ----

const CGH9 = ['Southern', 'Choma', 'Choma General Hospital'];
const CCL9 = ['Southern', 'Choma', 'Choma Clinic'];
const CHL9 = ['Lusaka', 'Lusaka', 'Chilenje Clinic'];
const KDH9 = ['Lusaka', 'Kafue', 'Kafue District Hospital'];

const cohortQuery = queries().find((q) => q.name === 'Earlier VL results of high-VL clients');
const historyQuery = queries().find((q) => q.name === 'VL results history by client');

// ---- T1: one row per client, results across visits 1 to 10 (oldest first) ----

const T1_COLUMNS = ['Province', 'District', 'Facility', 'ARTNumber', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const pv = ([prov, dist, fac], art, visits) =>
  Object.fromEntries(T1_COLUMNS.map((c, i) => [c, i < 4 ? [prov, dist, fac, art][i] : (visits[i - 4] ?? null)]));
const wnd = (from, to) => ({ from, to });
const win9 = wnd('2026-05-01', '2026-05-31');

// Every client of the full window, in v1's order (province, district, facility, ART number; the port adds nothing else).
// Expected-by-hand notes sit on the fixtures above. T1 selects LIMSRptResult 'Result' of each x row (line 107).
const T1_ROWS = {
  F103: pv(KDH9, 'F103', ['2400']),
  F102: pv(CHL9, 'F102', ['145', '2300']),
  F101: pv(CCL9, 'F101', ['140', '2100']),
  BLANK: pv(CGH9, '', ['2700']),
  1001: pv(CGH9, '1001', ['200', '450', '1500']),
  4004: pv(CGH9, '4004', ['100', '1000']),
  6006: pv(CGH9, '6006', ['90']),
  7007: pv(CGH9, '7007', ['120', '2000']),
  8008: pv(CGH9, '8008', ['800', '4000']),
  AB55: pv(CGH9, 'AB55', ['<20 copies/mL', '2500']),
  D101: pv(CGH9, 'D101', ['1100', '1200']),
  E101: pv(CGH9, 'E101', ['150', '1200']),
  E102: pv(CGH9, 'E102', ['1300']),
  E103: pv(CGH9, 'E103', ['3500']),
  E104: pv(CGH9, 'E104', ['170']),
  G101: pv(CGH9, 'G101', ['155', '2600']),
  H101: pv(CGH9, 'H101', ['2900']),
  K101: pv(CGH9, 'K101', ['165', '2800']),
  M101: pv(CGH9, 'M101', ['201', '202', '203', '204', '205', '206', '207', '208', '209', '210']),
  N101: pv(CGH9, 'N101', ['175', '3300']),
  Q101: pv(CGH9, 'Q101', ['150', '1400']),
  S101: pv(CGH9, 'S101', ['2200']),
  S102: pv(CGH9, 'S102', ['5,000', null, null, null, null, null, null, null, null, null]),
  S103: pv(CGH9, 'S103', ['700']),
  V101: pv(CGH9, 'V101', ['1300']),
};
// The clients of the full window, in v1's order. 2002 (no result in the window), 3003 (300 has three characters), E105 and E106 (their
// high results are one second outside the window) have no row; 6006 is in through its HIVTM result.
const T1_FULL = ['F103', 'F102', 'F101', 'BLANK', '1001', '4004', '6006', '7007', '8008', 'AB55', 'D101', 'E101', 'E102', 'E103', 'E104',
  'G101', 'H101', 'K101', 'M101', 'N101', 'Q101', 'S101', 'S102', 'S103', 'V101'];
// The pivot columns come from the full list in v1's sort order. Sorted by hand: Lusaka (Kafue, Lusaka), then Southern (Choma Clinic,
// Choma General Hospital with ARTs '', 1001, 4004, 6006, 7007, 8008, AB55, D101, E101..E104, G101, H101, K101, M101, N101, S101..S103, V101).
const t1Rows = (keys) => keys.map((k) => T1_ROWS[k]);

// ---- T2: one row per client result (long format) ----

const T2_COLUMNS = ['Province', 'District', 'Facility', 'ARTNumber', 'Rank', 'SuppressionStatus', 'ResultDate', 'Result'];
const SUP = 'Suppressed';
const UNS = 'UnSuppressed';
const h9 = ([prov, dist, fac], art, rank, status, date, result) =>
  Object.fromEntries(T2_COLUMNS.map((c, i) => [c, [prov, dist, fac, art, rank, status, date, result][i]]));
// One client's rows: [rank, status, date, result] (x rows) at a facility.
const cl = (fac, art, rows) => rows.map(([rank, status, date, result]) => h9(fac, art, rank, status, date, result));

// Per client, the rows T2 gives for the window 2026-05-01..2026-05-31 and no area or pregnancy filter. The order inside a client
// is the port's own (rank, then authorised time): v1 orders by province, district, facility, ART only.
const T2_BLANK = cl(CGH9, '', [[1, UNS, 'May  9 2026  8:00AM', '2700']]);
const T2_1001 = cl(CGH9, '1001', [[1, UNS, 'May 10 2026  8:00AM', '1500'], [2, SUP, 'Dec 15 2025  8:00AM', '450'], [3, SUP, 'Jun 10 2025  8:00AM', '200']]);
const T2_3003 = cl(CGH9, '3003', [[1, SUP, 'May 12 2026  8:00AM', '300']]);
const T2_4004 = cl(CGH9, '4004', [[1, UNS, 'May 20 2026  8:00AM', '1000'], [2, SUP, 'Mar  1 2026  8:00AM', '100']]);
const T2_7007 = cl(CGH9, '7007', [[1, SUP, 'Mar  2 2026  8:00AM', '120'], [1, UNS, 'May  9 2026  8:00AM', '2000'], [2, SUP, 'Mar  1 2026  8:00AM', '110']]);
const T2_8008 = cl(CGH9, '8008', [[1, UNS, 'May 15 2026  8:00AM', '4000'], [2, SUP, 'Apr 10 2026  8:00AM', '800']]);
const T2_AB55 = cl(CGH9, 'AB55', [[1, UNS, 'May  8 2026  8:00AM', '2500'], [2, SUP, 'Feb  1 2026  8:00AM', '<20 copies/mL']]);
const T2_D101 = [
  ...cl(CGH9, 'D101', [[1, UNS, 'May 21 2026  8:00AM', '1200'], [1, UNS, 'May 21 2026  8:00AM', '1200'],
    [2, UNS, 'May 20 2026  8:00AM', '1100'], [2, UNS, 'May 20 2026  8:00AM', '1100']]),
];
const T2_E101 = cl(CGH9, 'E101', [[1, UNS, 'May  3 2026  8:00AM', '1200'], [2, SUP, 'May  1 2025 12:30AM', '150']]);
const T2_E102 = cl(CGH9, 'E102', [[1, UNS, 'May  3 2026  8:00AM', '1300'], [2, SUP, 'Apr 30 2025 11:30PM', '160']]);
const T2_E103 = cl(CGH9, 'E103', [[1, UNS, 'May  1 2026 12:00AM', '3500']]);
const T2_E104 = cl(CGH9, 'E104', [[1, SUP, 'Apr  1 2026  8:00AM', '170']]);
const T2_G101 = cl(CGH9, 'G101', [[1, UNS, 'May  8 2026  8:00AM', '2600'], [2, SUP, 'Mar  7 2026  8:00AM', '155']]);
const T2_H101 = cl(CGH9, 'H101', [[1, UNS, 'May 22 2026  8:00AM', '2900'], [2, SUP, 'May  2 2024 12:30AM', '190']]);
const T2_K101 = [h9(CGH9, 'K101', 1, UNS, 'May 10 2026  8:00AM', '2800'), h9(CGH9, 'k101', 2, SUP, 'Mar  9 2026  8:00AM', '165')];
const T2_M101 = cl(CGH9, 'M101', [[1, UNS, 'May  5 2026  8:00AM', '1111'], [2, SUP, 'Apr  5 2026  8:00AM', '211'], [3, SUP, 'Mar  5 2026  8:00AM', '210'],
  [4, SUP, 'Feb  5 2026  8:00AM', '209'], [5, SUP, 'Jan  5 2026  8:00AM', '208'], [6, SUP, 'Dec  5 2025  8:00AM', '207'],
  [7, SUP, 'Nov  5 2025  8:00AM', '206'], [8, SUP, 'Oct  5 2025  8:00AM', '205'], [9, SUP, 'Sep  5 2025  8:00AM', '204'],
  [10, SUP, 'Aug  5 2025  8:00AM', '203'], [11, SUP, 'Jul  5 2025  8:00AM', '202'], [12, SUP, 'Jun  5 2025  8:00AM', '201']]);
const T2_N101 = cl(CGH9, 'N101', [[1, UNS, 'May 19 2026  8:00AM', '3300'], [2, SUP, 'Mar  1 2026  8:00AM', '175']]);
// Q101: the F series is ranks 1 (May 11) and 2 (Mar 1); the M series has one result, rank 1.
const T2_Q101 = cl(CGH9, 'Q101', [[1, SUP, 'Mar  2 2026  8:00AM', '150'], [1, UNS, 'May 11 2026  8:00AM', '1400'], [2, SUP, 'Mar  1 2026  8:00AM', '<20 copies/mL']]);
const T2_P101 = cl(CGH9, 'P101', [[1, SUP, 'May 12 2026  8:00AM', '600'], [2, SUP, 'Feb  1 2026  8:00AM', '500']]);
const T2_P102 = cl(CGH9, 'P102', [[1, SUP, 'May 13 2026  8:00AM', '700'], [2, SUP, 'Jan  1 2026  8:00AM', '650']]);
const T2_P103 = cl(CGH9, 'P103', [[1, SUP, 'May 14 2026  8:00AM', '800']]);
const T2_P104 = cl(CGH9, 'P104', [[1, SUP, 'May 15 2026  8:00AM', '900']]);
const T2_P105 = cl(CGH9, 'P105', [[1, SUP, 'May 16 2026  8:00AM', '950'], [2, SUP, 'Feb 10 2026  8:00AM', '500']]);
const T2_P106 = cl(CGH9, 'P106', [[1, SUP, 'May 17 2026  8:00AM', '960']]);
const T2_P107 = cl(CGH9, 'P107', [[1, SUP, 'May  2 2026  8:00AM', '980'], [1, SUP, 'May  2 2026  8:00AM', '980']]);
const T2_P108 = cl(CGH9, 'P108', [[1, SUP, 'May 18 2026  8:00AM', '995']]);
const T2_P109 = cl(CGH9, 'P109', [[1, SUP, 'May 19 2026  8:00AM', '996']]);
const T2_S101 = cl(CGH9, 'S101', [[1, UNS, 'May  5 2026  8:00AM', '2200']]);
const T2_S102 = cl(CGH9, 'S102', [[1, UNS, 'May  6 2026  8:00AM', '5,000']]);
const T2_S103 = cl(CGH9, 'S103', [[1, UNS, 'May 14 2026  8:00AM', '1800'], [2, SUP, 'Apr 20 2026  8:00AM', '700']]);
const T2_V101 = cl(CGH9, 'V101', [[1, UNS, 'May 23 2026  8:00AM', '1300']]);
const T2_F101 = cl(CCL9, 'F101', [[1, UNS, 'May  4 2026  8:00AM', '2100'], [2, SUP, 'Mar  5 2026  8:00AM', '140']]);
const T2_F102 = cl(CHL9, 'F102', [[1, UNS, 'May  5 2026  8:00AM', '2300'], [2, SUP, 'Mar  6 2026  8:00AM', '145']]);
const T2_P106L = cl(CHL9, 'P106', [[1, SUP, 'May 17 2026  8:00AM', '990']]);
const T2_F103 = cl(KDH9, 'F103', [[1, UNS, 'May  6 2026  8:00AM', '2400']]);

const T2_LUSAKA = [...T2_F103, ...T2_F102, ...T2_P106L];
const T2_CHOMA_CLINIC = T2_F101;
const T2_CGH = [...T2_BLANK, ...T2_1001, ...T2_3003, ...T2_4004, ...T2_7007, ...T2_8008, ...T2_AB55, ...T2_D101, ...T2_E101, ...T2_E102,
  ...T2_E103, ...T2_E104, ...T2_G101, ...T2_H101, ...T2_K101, ...T2_M101, ...T2_N101, ...T2_P101, ...T2_P102, ...T2_P103, ...T2_P104,
  ...T2_P105, ...T2_P106, ...T2_P107, ...T2_P108, ...T2_P109, ...T2_Q101, ...T2_S101, ...T2_S102, ...T2_S103, ...T2_V101];
const T2_ALL = [...T2_LUSAKA, ...T2_CHOMA_CLINIC, ...T2_CGH];
const T2_SOUTHERN = [...T2_CHOMA_CLINIC, ...T2_CGH];
// Pregnant clients (the _Prega copy): CGH P101, P102, P103, P107, P108 and Chilenje Clinic P106. P104 answered No, P105's form is in a
// lab authorised before the window, P109's text is not 'Pregnant Mother', and CGH's P106 is pregnant only at Chilenje Clinic.
const T2_PREGNANT_CGH = [...T2_P101, ...T2_P102, ...T2_P103, ...T2_P107, ...T2_P108];
const T2_PREGNANT = [...T2_P106L, ...T2_PREGNANT_CGH];

// The pivot columns are named '1' to '10'. A JS object lists integer-like keys first, whatever their order in the row, so
// orderedSuite cannot see the column order of this query; 't1-column-order' below reads it from the row's own JSON text.
const t1Suite = (name, params, keys, setup = '') => {
  const s = orderedSuite(name, cohortQuery?.sql ?? 'select 1', params, T1_COLUMNS, t1Rows(keys), setup);
  const check = s.check;
  s.check = (got) => check(got).filter((m) => !m.startsWith('columns not in v1 order'));
  s.name = name;
  return s;
};

const t2Params = (province, pregnant, w = win9) => ({ ...w, province, pregnant_only: pregnant });
const t2Suite = (name, params, rows, setup = '') => orderedSuite(name, historyQuery?.sql ?? 'select 1', params, T2_COLUMNS, rows, setup);
const BANNED9 = /--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i;

const suites9 = [
  // T1 cohort + history: the first suite carries every t9 fixture row (the runner puts all setups in one transaction).
  t1Suite('t1-full-window', win9, T1_FULL, SETUP9),
  // The column order of v1 (Province, District, Facility, ARTNumber, then 1 to 10), read from the first row's JSON text.
  {
    name: 't1-column-order',
    setup: '',
    sql: 'select \'t1-column-order\' || chr(9) || json_build_object(\'raw\', row_to_json(q)::text)::text from (' + bind(cohortQuery?.sql ?? 'select 1', { from: '2026-05-01', to: '2026-05-31' }) + ') q limit 1;',
    count: 1,
    check(got) {
      const raw = got[0]?.raw ?? '';
      const keys = [...raw.matchAll(/(?:^\{|,)"([^"]+)":/g)].map((m) => m[1]);
      return JSON.stringify(keys) === JSON.stringify(T1_COLUMNS) ? [] : ['columns: ' + keys.join(', ')];
    },
  },
  // A window of the single day 05-31: the cohort result is E104's 3600 at exactly 05-31T00:00:00 (the end instant is in the window
  // for the cohort, line 92). That result is not in x (line 56 needs authorised < to), so the row shows E104's 04-01 result only.
  t1Suite('t1-last-day', wnd('2026-05-31', '2026-05-31'), ['E104']),
  // A window of the single day 05-01: the cohort result is E103's 3500 at exactly 05-01T00:00:00, but it is not in x (authorised < to), so E103
  // has no visit and no row. Nothing else is in the window.
  t1Suite('t1-first-day', wnd('2026-05-01', '2026-05-01'), []),
  // The window 05-04..05-10: cohort clients with a result in it. x needs authorised < 05-10 00:00:00.
  t1Suite('t1-narrow-window', wnd('2026-05-04', '2026-05-10'), ['F103', 'F102', 'F101', 'BLANK', '7007', 'AB55', 'G101', 'M101', 'S101', 'S102']),
  // The history edge (line 55, local dates): E101's result of 2025-05-01 00:30 +02:00 is in (365 days), E102's of 2025-04-30 23:30 +02:00 is out
  // (366 days): both appear in the full-window rows above, E101 with two visits and E102 with one.
  {
    name: 't1-shape',
    count: 5,
    check() {
      const bad = [];
      if (!cohortQuery) return ['query "Earlier VL results of high-VL clients" is missing'];
      const ids = cohortQuery.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['from', 'to'])) bad.push(`params: ${ids}`);
      if (!cohortQuery.params.every((p) => p.required && p.type === 'text')) bad.push('from and to are required text parameters (ruling 3)');
      if (BANNED9.test(cohortQuery.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      return bad;
    },
  },
  // T2 with no filter: every client with a valid HIVVL, HIVVC or HIVVD result in the window, whole 730-day history, descending ranks.
  t2Suite('t2-all-provinces', t2Params('', ''), T2_ALL),
  t2Suite('t2-pregnant-no', t2Params('', 'no'), T2_ALL),
  // The Lusaka constant (T2 line 124) as a parameter: compared ignoring case and trailing spaces.
  t2Suite('t2-province-lusaka', t2Params('Lusaka', ''), T2_LUSAKA),
  t2Suite('t2-province-fold', t2Params('southern ', ''), T2_SOUTHERN),
  t2Suite('t2-province-other', t2Params('Western', ''), []),
  // The _Prega copy: pregnant clients only, any province.
  t2Suite('t2-pregnant', t2Params('', 'yes'), T2_PREGNANT),
  t2Suite('t2-pregnant-fold', t2Params('', 'YES '), T2_PREGNANT),
  t2Suite('t2-pregnant-lusaka', t2Params('Lusaka', 'yes'), T2_P106L),
  t2Suite('t2-pregnant-southern', t2Params('Southern', 'yes'), T2_PREGNANT_CGH),
  // Window 05-04..05-10 and Lusaka: F102 (05-05) and F103 (05-06) only; P106 is on 05-17.
  t2Suite('t2-narrow-window', t2Params('Lusaka', '', wnd('2026-05-04', '2026-05-10')), [...T2_F103, ...T2_F102]),
  // A one-day window holds only results at exactly 00:00:00: nothing here (v1 end-date quirk).
  t2Suite('t2-one-day-window', t2Params('', '', wnd('2026-05-06', '2026-05-06')), []),
  {
    name: 't2-shape',
    count: 8,
    check() {
      const bad = [];
      if (!historyQuery) return ['query "VL results history by client" is missing'];
      const ids = historyQuery.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['from', 'to', 'province', 'pregnant_only'])) bad.push(`params: ${ids}`);
      const byId = Object.fromEntries(historyQuery.params.map((p) => [p.id, p]));
      if (!byId.from?.required || !byId.to?.required) bad.push('from and to are required (ruling 3)');
      if (byId.province?.type !== 'select' || byId.province?.required) bad.push('province is an optional select');
      if (byId.pregnant_only?.type !== 'select' || byId.pregnant_only?.required) bad.push('pregnant_only is an optional select');
      if (BANNED9.test(historyQuery.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (BANNED9.test((byId.pregnant_only?.optionsSql ?? '').replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word in pregnant_only optionsSql');
      return bad;
    },
  },
];

// ============================================================================================
// Group t10: "VL testing summary by province / by district / by facility" (v1 sp_getSummaryTestEpiData, "P" below,
// sp_getSummaryTestEpiDataDistrict, "D", sp_getSummaryTestEpiDataFacility, "F"). Fixture ids start with "t10-"; lab ids
// with "T10-". "P line N" is a line of StoredProcedure__dbo_sp_getSummaryTestEpiData.sql, "D line N" of ...District.sql,
// "F line N" of ...Facility.sql. Expected rows are worked out by hand from the v1 text. Window: 2026-05-01 to 2026-05-31.
//
// The facilities (fixture codes ZT10x):
//   A  Choma General Hospital, Southern/Choma: every result text and turnaround case
//   B  Choma Clinic, Southern/Choma: window edges (local time, +02:00 stamps)
//   H  Choma Clinic, Southern/Choma: same name as B, so the facility level merges them
//   C  Monze Clinic, Southern/Monze: registered only
//   N  Nowhere Clinic, Southern, no district
//   D  Chilenje Clinic, Lusaka/Lusaka;  F  Kabwata Clinic, Lusaka/Lusaka: tests but no registration in the window
//   G  Other Choma Clinic, Central/Choma: a district with the same name in another province
//   U  not in the register
// ============================================================================================

const F10 = epiFixture('t10', {
  panel: 'HIVVL', obs: 'HIVVL', status: 'final', req: 'ZT10A',
  auth: '2026-05-02T08:00:00Z', ana: '2026-05-03T09:00:00Z', eff: '2026-05-01T07:00:00Z', iss: '2026-05-10T10:00:00Z',
  noReport: false, results: [{ num: 540 }],
});
const q10 = F10.req;
// Facility A. Default turnaround 9 days (05-01 to 05-10). The comment says what each request does at the province
// level (P) and at the district and facility levels (D).
q10('T10-A01', { results: [{ num: 540 }] });                                              // test, suppressed
q10('T10-A02', { iss: '2026-05-12T10:00:00Z', results: [{ text: 'Target Not Detected' }, { obs: 'HIVVC', num: 1500 }] }); // one test, both flags; two turnaround rows of 11
q10('T10-A03', { iss: '2026-05-05T10:00:00Z', results: [{ text: 'INVAL' }] });           // registered; no test (invalid text); turnaround 4 counts (the turnaround part has no text filter)
q10('T10-A04', { status: 'cancelled', eff: null, iss: null, results: [] });              // registered only
q10('T10-A05', { results: [{ text: 'Positive' }] });                                      // P lists Positive as invalid; D and F do not: a test at D and F only
q10('T10-A06', { results: [{ num: 10000000, cmp: '>' }] });                               // text "> 10000000": unsuppressed (like '>%')
q10('T10-A07', { results: [{ text: 'GT10' }] });                                          // a test; unsuppressed only at the district level
q10('T10-A08', { results: [{ text: '<400 copies/mL' }] });                                // a test; suppressed only at D and F (their lists add <400)
q10('T10-A09', { results: [{ num: 1500, coded: 'X' }] });                                 // a coded value: suppressed beside 1500, which is also unsuppressed
q10('T10-A10', { results: [{ text: '999.5' }] });                                         // decimal text: v1 stops; intent is a number under 1000 (deviation)
q10('T10-A11', { panel: 'RTRI', results: [{ num: 100 }] });                               // other panel: nowhere
q10('T10-A12', { results: [{ obs: 'HIVTM', num: 50 }] });                                 // registered; observation not in the three: no test, no turnaround
q10('T10-A13', { status: 'preliminary', results: [{ num: 100 }] });                       // registered; not final
q10('T10-A14', { eff: null, results: [{ num: 200 }] });                                   // a test; no collection date: no turnaround
q10('T10-A15', { eff: '2026-01-01T07:00:00Z', results: [{ num: 300 }] });                 // a test; 129 days: over 90, no turnaround
q10('T10-A16', { eff: '2026-02-09T07:00:00Z', results: [{ num: 400 }] });                 // a test; 90 days exactly: in
q10('T10-A17', { iss: null, results: [{ num: 410 }] });                                   // a test; no authorised date: no turnaround
q10('T10-A18', { eff: '2026-05-01T23:30:00+02:00', iss: '2026-05-03T00:30:00+02:00', results: [{ num: 500 }] }); // local dates 05-01 and 05-03: 2 days (UTC would say 1)
q10('T10-A19', { results: [{ text: 'haemolysed ' }] });                                   // invalid text ignoring case and trailing space; turnaround 9 counts
// Facility B: the window edges. Registered (authored) edges first, no report.
const noRep = { noReport: true, ana: null, results: [] };
q10('T10-B01', { req: 'ZT10B', auth: '2026-05-31T23:30:00+02:00', ...noRep });           // local 05-31 23:30: in at P (ends 06-01 00:00), out at D and F (end 05-31 00:00)
q10('T10-B02', { req: 'ZT10B', auth: '2026-06-01T00:00:00+02:00', ...noRep });           // exactly 06-01 00:00: in at P (BETWEEN is inclusive), out at D and F
q10('T10-B03', { req: 'ZT10B', auth: '2026-06-01T00:00:01Z', ...noRep });                // one second later: out everywhere
q10('T10-B04', { req: 'ZT10B', auth: '2026-05-31T00:00:00+02:00', ...noRep });           // exactly 05-31 00:00 (UTC 05-30 22:00): in everywhere
q10('T10-B05', { req: 'ZT10B', auth: '2026-05-01T00:30:00+02:00', ...noRep });           // local 05-01 (UTC 04-30): in
q10('T10-B06', { req: 'ZT10B', auth: '2026-04-30T23:30:00+02:00', ...noRep });           // out
// Analysed edges (registered 05-02, so each also counts as a registration).
q10('T10-B07', { req: 'ZT10B', ana: '2026-05-31T23:30:00+02:00', iss: '2026-05-02T10:00:00Z', results: [{ num: 100 }] });  // P only; turnaround 1
q10('T10-B08', { req: 'ZT10B', ana: '2026-06-01T00:00:00+02:00', iss: '2026-05-04T10:00:00Z', results: [{ num: 2000 }] }); // P only; turnaround 3
q10('T10-B09', { req: 'ZT10B', ana: '2026-05-31T00:00:00+02:00', iss: '2026-05-06T10:00:00Z', results: [{ num: 150 }] });  // all levels; turnaround 5
q10('T10-B10', { req: 'ZT10B', ana: '2026-04-30T23:30:00+02:00', results: [{ num: 100 }] });                                // out
q10('T10-B11', { req: 'ZT10B', ana: '2026-05-01T00:30:00+02:00', iss: '2026-05-01T20:00:00Z', results: [{ num: 3000 }] }); // all levels; turnaround 0
q10('T10-B12', { req: 'ZT10B', ana: '2026-06-01T00:00:01Z', results: [{ num: 100 }] });                                    // out of May
q10('T10-H01', { req: 'ZT10H', results: [{ num: 600 }] });
q10('T10-C01', { req: 'ZT10C', ...noRep });
q10('T10-N01', { req: 'ZT10N', results: [{ num: 800 }] });
q10('T10-D01', { req: 'ZT10D', results: [{ num: 700 }] });
q10('T10-F01', { req: 'ZT10F', auth: '2026-04-20T08:00:00Z', results: [{ num: 100 }] });  // tests, no registration in May: dropped (P final joins)
q10('T10-G01', { req: 'ZT10G', results: [{ num: 5000 }] });
q10('T10-U01', { req: 'ZT10U', results: [{ num: 100 }] });                                // not in the register: dropped

const SETUP10 = F10.setup(facilityRows('t10', [
  ['ZT10A', 'Choma General Hospital', 'Southern', 'Choma'],
  ['ZT10B', 'Choma Clinic', 'Southern', 'Choma'],
  ['ZT10H', 'Choma Clinic', 'Southern', 'Choma'],
  ['ZT10C', 'Monze Clinic', 'Southern', 'Monze'],
  ['ZT10N', 'Nowhere Clinic', 'Southern', null],
  ['ZT10D', 'Chilenje Clinic', 'Lusaka', 'Lusaka'],
  ['ZT10F', 'Kabwata Clinic', 'Lusaka', 'Lusaka'],
  ['ZT10G', 'Other Choma Clinic', 'Central', 'Choma'],
  ['ZT10U', 'Unmapped Clinic', 'Southern', 'Choma', false],
]));

const COUNTS10 = ['Registrations', 'Tests', 'suppressed', 'Unsuppressed', 'TATTests', 'TATpre'];
const P10_COLUMNS = ['Province', ...COUNTS10];
const D10_COLUMNS = ['District', ...COUNTS10];
const F10_COLUMNS = ['District', 'Facility Name', ...COUNTS10];
const row10 = (columns, ...values) => Object.fromEntries(columns.map((c, i) => [c, values[i]]));
const p10 = (...v) => row10(P10_COLUMNS, ...v);
const d10 = (...v) => row10(D10_COLUMNS, ...v);
const f10 = (...v) => row10(F10_COLUMNS, ...v);
const vlSummary = (name) => queries().find((q) => q.name === name);
const provQ = vlSummary('VL testing summary by province');
const distQ = vlSummary('VL testing summary by district');
const facQ = vlSummary('VL testing summary by facility');
const MAY10 = { from: '2026-05-01', to: '2026-05-31' };

const suites10 = [
  // Province (P). Southern: registrations A 18 + B 10 (B01, B02, B04, B05, B07-B12) + H 1 + C 1 + N 1 = 31; tests A 12 + B 4 + H 1 + N 1 = 18;
  // suppressed A 9 + B 2 + H 1 + N 1 = 13; unsuppressed A 3 + B 2 = 5. Turnaround: A has 13 rows summing 190, average 14.6 cut to 14, 12 requests,
  // so 168; B rows 1, 3, 5, 0 average 2 (9 / 4 cut), 4 requests, 8; H 9; N 9: TATTests 12 + 4 + 1 + 1 = 18, TATpre 168 + 8 + 9 + 9 = 194.
  // Lusaka is D alone: F has tests but no registration, so the whole facility is dropped. U is not in the register.
  orderedSuite10('province-may', provQ?.sql ?? 'select 1', MAY10, P10_COLUMNS, [
    p10('Central', 1, 1, null, 1, 1, 9),
    p10('Lusaka', 1, 1, 1, null, 1, 9),
    p10('Southern', 31, 18, 13, 5, 18, 194),
  ], SETUP10),
  // One day: the end moves a day forward (P line 19), so 05-02 runs to 05-03 00:00. Registrations on 05-02 count; nothing was analysed then.
  orderedSuite10('province-one-day', provQ?.sql ?? 'select 1', { from: '2026-05-02', to: '2026-05-02' }, P10_COLUMNS, [
    p10('Central', 1, null, null, null, null, null),
    p10('Lusaka', 1, null, null, null, null, null),
    p10('Southern', 27, null, null, null, null, null),
  ]),
  orderedSuite10('province-empty-window', provQ?.sql ?? 'select 1', { from: '2025-01-01', to: '2025-01-31' }, P10_COLUMNS, []),
  // District (D), Southern. Choma = A + B + H: registrations 18 + 8 + 1 = 27 (B01 and B02 are out: the end is 05-31 00:00); tests 13 + 2 + 1 = 16;
  // suppressed 10 + 1 + 1 = 12; unsuppressed 4 (GT10 counts) + 1 + 0 = 5; turnaround A 168 over 12 requests, B rows 5 and 0 average 2 (4), H 9:
  // TATTests 12 + 2 + 1 = 15, TATpre 168 + 4 + 9 = 181.
  // Monze is registered only: the other sums are NULL. N has no district: a row with a NULL district, which sorts first. Central/Choma (G) is
  // another province.
  orderedSuite10('district-southern', distQ?.sql ?? 'select 1', { province: 'Southern', ...MAY10 }, D10_COLUMNS, [
    d10(null, 1, 1, 1, null, 1, 9),
    d10('Choma', 27, 16, 12, 5, 15, 181),
    d10('Monze', 1, null, null, null, null, null),
  ]),
  orderedSuite10('district-name-fold', distQ?.sql ?? 'select 1', { province: 'southern  ', ...MAY10 }, D10_COLUMNS, [
    d10(null, 1, 1, 1, null, 1, 9),
    d10('Choma', 27, 16, 12, 5, 15, 181),
    d10('Monze', 1, null, null, null, null, null),
  ]),
  orderedSuite10('district-central', distQ?.sql ?? 'select 1', { province: 'Central', ...MAY10 }, D10_COLUMNS, [d10('Choma', 1, 1, null, 1, 1, 9)]),
  orderedSuite10('district-lusaka', distQ?.sql ?? 'select 1', { province: 'Lusaka', ...MAY10 }, D10_COLUMNS, [d10('Lusaka', 1, 1, 1, null, 1, 9)]),
  orderedSuite10('district-unknown', distQ?.sql ?? 'select 1', { province: 'Nowhere', ...MAY10 }, D10_COLUMNS, []),
  // The end is 05-31 00:00 (D has no extra day): B04 (authored exactly then) and B09 (analysed exactly then) are in; B01 (05-31 23:30) is out.
  orderedSuite10('district-one-day-end', distQ?.sql ?? 'select 1', { province: 'Southern', from: '2026-05-31', to: '2026-05-31' }, D10_COLUMNS, [d10('Choma', 1, 1, 1, null, 1, 5)]),
  // June: B02 and B03 are registered, B08 (exactly 06-01 00:00) and B12 (one second later) are analysed in the window.
  orderedSuite10('district-june', distQ?.sql ?? 'select 1', { province: 'Southern', from: '2026-06-01', to: '2026-06-30' }, D10_COLUMNS, [d10('Choma', 2, 2, 1, 1, 2, 12)]),
  // Facility (F), district Choma: any province (G is Central/Choma). Choma Clinic merges B and H (same description); the district is not a key of the
  // facility alone, so Other Choma Clinic of Central shows too.
  orderedSuite10('facility-choma', facQ?.sql ?? 'select 1', { district: 'Choma', ...MAY10 }, F10_COLUMNS, [
    f10('Choma', 'Choma Clinic', 9, 3, 2, 1, 3, 13),
    f10('Choma', 'Choma General Hospital', 18, 13, 10, 3, 12, 168),
    f10('Choma', 'Other Choma Clinic', 1, 1, null, 1, 1, 9),
  ]),
  orderedSuite10('facility-name-fold', facQ?.sql ?? 'select 1', { district: 'CHOMA ', ...MAY10 }, F10_COLUMNS, [
    f10('Choma', 'Choma Clinic', 9, 3, 2, 1, 3, 13),
    f10('Choma', 'Choma General Hospital', 18, 13, 10, 3, 12, 168),
    f10('Choma', 'Other Choma Clinic', 1, 1, null, 1, 1, 9),
  ]),
  orderedSuite10('facility-monze', facQ?.sql ?? 'select 1', { district: 'Monze', ...MAY10 }, F10_COLUMNS, [f10('Monze', 'Monze Clinic', 1, null, null, null, null, null)]),
  orderedSuite10('facility-lusaka', facQ?.sql ?? 'select 1', { district: 'Lusaka', ...MAY10 }, F10_COLUMNS, [f10('Lusaka', 'Chilenje Clinic', 1, 1, 1, null, 1, 9)]),
  orderedSuite10('facility-unknown', facQ?.sql ?? 'select 1', { district: 'Nowhere', ...MAY10 }, F10_COLUMNS, []),
  shapeSuite('province-shape', provQ, ['from', 'to'], ['text', 'text']),
  shapeSuite('district-shape', distQ, ['province', 'from', 'to'], ['select', 'text', 'text']),
  shapeSuite('facility-shape', facQ, ['district', 'from', 'to'], ['select', 'text', 'text']),
];

// ============================================================================================
// Group t11: "Unique VL clients" (v1 sp_getUniqueVLClientsInfo, "I" below, with sp_getUniqueVLClientsInfoList, "L", merged in;
// sp_getUniqueVLClientsInfo_bkup is an exact copy of I) and "Unique VL clients by facility (12 months)" (v1
// sp_getUniqueVLClientsLast12Months_SPHO_WPHO, "S"). Fixture ids start with "t11-"; lab ids with "T11-". "I line N" is a line of
// StoredProcedure__dbo_sp_getUniqueVLClientsInfo.sql, "L line N" of ...InfoList.sql, "S line N" of ...Last12Months_SPHO_WPHO.sql.
// Expected rows are worked out by hand from the v1 text. Window used by most cases: from 2026-05-01, to 2026-05-31.
//
// Facilities (fixture codes ZT11x): A Choma General Hospital, Southern/Choma; B Choma Clinic, Southern/Choma;
// C Monze Clinic, Southern/Monze; D Chilenje Clinic, Lusaka/Lusaka; W Mongu Clinic, Western/Mongu; N Nowhere Clinic, a register
// row with no province and no district; U not in the register.
//
// The clients, with what each does (a client is a first name, surname and ART number at a facility). Results are numbers unless a
// text is shown. "ok" is v1's test on the result text (a number, or one of 15 texts): Clients counts only ok results, the age and
// sex columns count every client. The sex-by-age cell is the sex of the request (m f i u, x = blank) and the age band.
//   A01 Mary Banda     two labs, the newer (1500, age 30) wins over the older (50, age 29): ok, not suppressed. f 30to34
//   A02 John Phiri     'Target Not Detected': ok, suppressed, undetectable. m 40to44
//   A03 Peter Lungu    one lab, two requests: 50 at 05-05, then '<883 copies/mL' (number 150) at 05-12. The newer wins: ok, suppressed,
//                      undetectable (150 < 200), but the district branch's undetectable list lacks '<883 copies/mL' (I line 202). m 25to29
//   A04 Grace Tembo    'PTLTT' (a valid HIVVL text, not a number, not one of the 15): not ok. f 30to34
//   A05 Esther Daka    500 at 05-04, then 700 at 05-25 on a baseline lab (VIRAL answer 'Baseline VL'). I leaves baseline labs out
//                      before it ranks, so 500 wins; S ranks first and drops the client. f 20to24
//   A06 Lisa Mumba     panel RTRI: in TND, but the lab has no hivvl row, so the join drops it
//   A07 Adam Moyo      ART A700, 400, m 18; Zed Moyo, ART A700, 1200, m 50. Two people on one ART number: all branches count both except the
//                      facility branch (I line 282), which ranks by ART number only and keeps the first name (Adam)
//   A08 Tom Zulu       two labs at the same minute, 100 and 2000: both rank 1 (rank, not row_number), counted twice. m 50plus
//   A09 Sarah Chanda   'sarah chanda' / ART 'a900' at 05-06 and 'Sarah Chanda ' / ART 'A900' at 05-18: one client ignoring case and
//                      trailing spaces; the newer (4000, age 37) wins. f 35to39
//   A10 Blank Sex      sex '' (empty), age 5, 250. x 5to9
//   A11 (no patient)   no patient row, no age, ART from the unique id 'U-11': 3500. x AgeMissing
//   A12 Nina Other     sex N, age 40, 150: counts in Clients but in no sex column
//   A13 Hope Mulenga   one lab, two requests: 100 on 04-20 and 3000 on 05-15. The hivvl row is the 04-20 one (earliest), outside the
//                      window; the join by lab number still finds it. f 35to39
//   B01..B07           Choma Clinic, all women of 25 to 30: window edges (local times, +02:00 stamps) and Mary Banda again (ART A100)
//   C01                Monze Clinic: a baseline lab only
//   D01..D05           Lusaka: m, f, u, i, and D05 with no ART number at all
//   W01, W02           Mongu Clinic
//   N01                a facility whose register row has no province
//   X01                July, panel RTRI (no hivvl row): a window with TND rows but no client
//   P01..P03           September, Mongu Clinic: date-only and partial stamps ('2026-09-10', '2026-09'); a date alone is midnight
// ============================================================================================

const P11 = [];
const R11 = [];
const D11 = [];
const L11 = [];
const T11 = [];
const F11 = [];
let n11 = 0;
const num11 = (v) => (v === null || v === undefined ? 'null' : String(v));
const L11_DEFAULTS = { req: 'ZT11A', sex: 'F', age: 30, first: null, last: null, panel: 'HIVVL', obs: 'HIVVL', num: null, text: null,
  cmp: null, art: null, uq: null, form: null, patient: true };

// One request row of lab number `labId`, with one final report authorised at `issued` and one result. o: art (REFNO), uq (UNIQUEID),
// first, last, sex, age, req, panel, obs, num, text, cmp, form [[linkId, answer]], patient (false: no patient row).
function cl11(labId, issued, o = {}) {
  const r = { ...L11_DEFAULTS, ...o };
  const k = String(++n11).padStart(3, '0');
  const qid = `t11-q${k}`;
  let pid = null;
  if (r.patient) {
    pid = `t11-p${k}`;
    P11.push(`(${lit(pid)}, ${lit(r.first)}, ${lit(r.last)}, ${lit(r.sex)})`);
  }
  R11.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, '2026-05-01T08:00:00Z', '2026-05-02T09:00:00Z', ${lit(r.req)}, ${lit(pid)}, ${num11(r.age)})`);
  D11.push(`(${lit(`t11-d${k}`)}, ${lit(qid)}, 'final', '2026-05-01T07:00:00Z', ${lit(issued)}, 'LUS')`);
  L11.push(`(${lit(`t11-r${k}`)}, ${lit(qid)}, ${lit(r.obs)}, ${lit(r.text)}, ${num11(r.num)}, ${lit(r.cmp)})`);
  if (r.art !== null) T11.push(`(${lit(`t11-a${k}r`)}, ${lit(qid)}, ${lit(ATTR_SYSTEM)}, ${lit(REF)}, ${lit(r.art)})`);
  if (r.uq !== null) T11.push(`(${lit(`t11-a${k}u`)}, ${lit(qid)}, ${lit(ATTR_SYSTEM)}, ${lit(UNQ)}, ${lit(r.uq)})`);
  if (r.form) {
    const items = r.form.map(([linkId, text]) => ({ linkId, answer: [{ valueString: text }] }));
    F11.push(`(${lit(`t11-f${k}`)}, 'q', 'hiv_vl_documentation', ${lit(qid)}, '2026-05-02T08:00:00Z', ${lit(JSON.stringify(items))})`);
  }
}

// Facility A, Choma General Hospital.
cl11('T11-A01a', '2026-05-03T08:00:00Z', { first: 'Mary', last: 'Banda', age: 29, art: 'A100', num: 50 });
cl11('T11-A01b', '2026-05-20T08:00:00Z', { first: 'Mary', last: 'Banda', age: 30, art: 'A100', num: 1500 });
cl11('T11-A02', '2026-05-11T10:00:00Z', { first: 'John', last: 'Phiri', sex: 'M', age: 41, art: 'A200', text: 'Target Not Detected' });
cl11('T11-A03', '2026-05-05T08:00:00Z', { first: 'Peter', last: 'Lungu', sex: 'M', age: 28, art: 'A300', num: 50 });
cl11('T11-A03', '2026-05-12T08:00:00Z', { first: 'Peter', last: 'Lungu', sex: 'M', age: 28, art: 'A300', text: '<883 copies/mL', num: 150 });
cl11('T11-A04', '2026-05-08T08:00:00Z', { first: 'Grace', last: 'Tembo', age: 33, art: 'A400', text: 'PTLTT' });
cl11('T11-A05a', '2026-05-04T08:00:00Z', { first: 'Esther', last: 'Daka', age: 22, art: 'A500', num: 500 });
cl11('T11-A05b', '2026-05-25T08:00:00Z', { first: 'Esther', last: 'Daka', age: 22, art: 'A500', num: 700, form: [['ARTRS', 'Baseline VL']] });
cl11('T11-A06', '2026-05-06T08:00:00Z', { first: 'Lisa', last: 'Mumba', age: 27, art: 'A600', panel: 'RTRI', num: 80 });
cl11('T11-A07a', '2026-05-10T08:00:00Z', { first: 'Adam', last: 'Moyo', sex: 'M', age: 18, art: 'A700', num: 400 });
cl11('T11-A07b', '2026-05-15T08:00:00Z', { first: 'Zed', last: 'Moyo', sex: 'M', age: 50, art: 'A700', num: 1200 });
cl11('T11-A08a', '2026-05-12T09:00:00Z', { first: 'Tom', last: 'Zulu', sex: 'M', age: 60, art: 'A800', num: 100 });
cl11('T11-A08b', '2026-05-12T09:00:00Z', { first: 'Tom', last: 'Zulu', sex: 'M', age: 60, art: 'A800', num: 2000 });
cl11('T11-A09a', '2026-05-06T08:00:00Z', { first: 'sarah', last: 'chanda', age: 36, art: 'a900', num: 300 });
cl11('T11-A09b', '2026-05-18T08:00:00Z', { first: 'Sarah', last: 'Chanda ', age: 37, art: 'A900', num: 4000 });
cl11('T11-A10', '2026-05-07T08:00:00Z', { first: 'Blank', last: 'Sex', sex: '', age: 5, art: 'A1000', num: 250 });
cl11('T11-A11', '2026-05-09T08:00:00Z', { patient: false, age: null, uq: 'U-11', num: 3500 });
cl11('T11-A12', '2026-05-13T08:00:00Z', { first: 'Nina', last: 'Other', sex: 'N', age: 40, art: 'A1200', num: 150 });
cl11('T11-A13', '2026-04-20T08:00:00Z', { first: 'Hope', last: 'Mulenga', age: 36, art: 'A1300', num: 100 });
cl11('T11-A13', '2026-05-15T08:00:00Z', { first: 'Hope', last: 'Mulenga', age: 36, art: 'A1300', num: 3000 });
// Facility B, Choma Clinic: the window edges and Mary Banda's ART number at another facility.
const B11 = { req: 'ZT11B', age: 25 };
cl11('T11-B01', '2026-05-31T00:00:00+02:00', { ...B11, first: 'Edge', last: 'One', art: 'B100', num: 100 });
cl11('T11-B02', '2026-05-31T00:00:01+02:00', { ...B11, first: 'Edge', last: 'Two', art: 'B200', num: 100 });
cl11('T11-B03', '2026-05-01T00:00:00+02:00', { ...B11, first: 'Edge', last: 'Three', age: 26, art: 'B300', num: 2000 });
cl11('T11-B04', '2026-04-30T23:59:59+02:00', { ...B11, first: 'Edge', last: 'Four', art: 'B400', num: 100 });
cl11('T11-B05', '2026-05-30T23:30:00Z', { ...B11, first: 'Edge', last: 'Five', age: 27, art: 'B500', num: 300 });
cl11('T11-B06a', '2026-05-10T08:00:00Z', { ...B11, first: 'Late', last: 'Fee', age: 28, art: 'B600', num: 200 });
cl11('T11-B06b', '2026-06-02T08:00:00Z', { ...B11, first: 'Late', last: 'Fee', age: 28, art: 'B600', num: 5000 });
cl11('T11-B07', '2026-05-22T08:00:00Z', { req: 'ZT11B', first: 'Mary', last: 'Banda', art: 'A100', num: 90 });
// Facility C, Monze Clinic: a baseline lab only.
cl11('T11-C01', '2026-05-10T08:00:00Z', { req: 'ZT11C', first: 'Bea', last: 'Seline', art: 'C100', num: 800, form: [['ARTRS', 'Baseline']] });
// Facility D, Chilenje Clinic.
cl11('T11-D01', '2026-05-14T08:00:00Z', { req: 'ZT11D', first: 'Dan', last: 'Lungu', sex: 'M', age: 45, art: 'D100', num: 100 });
cl11('T11-D02', '2026-05-15T08:00:00Z', { req: 'ZT11D', first: 'Dina', last: 'Zulu', age: 15, art: 'D200', text: 'RNA not detected' });
cl11('T11-D03', '2026-05-16T08:00:00Z', { req: 'ZT11D', first: 'Ida', last: 'Unknown', sex: 'U', age: 3, art: 'D300', text: '<20 copies/mL' });
cl11('T11-D04', '2026-05-17T08:00:00Z', { req: 'ZT11D', first: 'Ian', last: 'Indet', sex: 'I', age: 10, art: 'D400', num: 1000 });
cl11('T11-D05', '2026-05-18T08:00:00Z', { req: 'ZT11D', first: 'Zero', last: 'Art', age: 55, num: 600 });
// Facility W, Mongu Clinic.
cl11('T11-W01', '2026-05-20T08:00:00Z', { req: 'ZT11W', first: 'Wanda', last: 'Mwila', age: 61, art: 'W100', num: 20 });
cl11('T11-W02', '2026-05-21T08:00:00Z', { req: 'ZT11W', first: 'Willy', last: 'Mwila', sex: 'M', age: 0, art: 'W200', num: 5000 });
// Facility N (no province), facility U (not in the register), and July.
cl11('T11-N01', '2026-05-10T08:00:00Z', { req: 'ZT11N', first: 'Nora', last: 'Null', art: 'N100', num: 100 });
cl11('T11-U01', '2026-05-10T08:00:00Z', { req: 'ZT11U', first: 'Una', last: 'Mapped', art: 'U100', num: 100 });
cl11('T11-X01', '2026-07-10T08:00:00Z', { first: 'Xena', last: 'Rtri', art: 'X100', panel: 'RTRI', num: 100 });

// September: a date-only stamp is midnight of that day (in the window if the day is in it, and at the end date it is the last instant); a
// partial stamp ('2026-09') has no day, so it is out and must not raise.
cl11('T11-P01', '2026-09-10', { req: 'ZT11W', first: 'Pia', last: 'One', age: 12, art: 'P100', num: 100 });
cl11('T11-P02', '2026-09', { req: 'ZT11W', first: 'Pia', last: 'Two', age: 30, art: 'P200', num: 100 });
cl11('T11-P03', '2026-09-30', { req: 'ZT11W', first: 'Pia', last: 'Three', age: 70, art: 'P300', num: 3000 });

const SETUP11 = `${facilityRows('t11', [
  ['ZT11A', 'Choma General Hospital', 'Southern', 'Choma'],
  ['ZT11B', 'Choma Clinic', 'Southern', 'Choma'],
  ['ZT11C', 'Monze Clinic', 'Southern', 'Monze'],
  ['ZT11D', 'Chilenje Clinic', 'Lusaka', 'Lusaka'],
  ['ZT11W', 'Mongu Clinic', 'Western', 'Mongu'],
  ['ZT11N', 'Nowhere Clinic', null, null],
  ['ZT11U', 'Unmapped Clinic', 'Southern', 'Choma', false],
])}
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years) values ${R11.join(',\n  ')};
insert into patients (id, firstname, surname, sex) values ${P11.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer) values ${D11.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator) values ${L11.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${T11.join(',\n  ')};
insert into questionnaire_responses (id, questionnaire, form_code, based_on_id, authored, items) values ${F11.join(',\n  ')};`;

// ---- Expected rows ----

const BANDS11 = ['lt01', '1to4', '5to9', '10to14', '15to19', '20to24', '25to29', '30to34', '35to39', '40to44', '45to49', '50plus', 'AgeMissing'];
const AGE_COLUMNS11 = ['m', 'f', 'i', 'u', 'x'].flatMap((s) => BANDS11.map((b) => `${b}${s}`));
const UC_COLUMNS = ['Province', 'District', 'Facility', 'Clients', 'SuppressedC', 'UnsuppressedC', 'UndetectableC', ...AGE_COLUMNS11];
// labels: the three names; counts: Clients, SuppressedC, UnsuppressedC, UndetectableC; ages: the sex-by-age cells that are not 0.
const uc = (labels, counts, ages = {}) => Object.fromEntries(UC_COLUMNS.map((c, i) => [c, i < 3 ? labels[i] : i < 7 ? counts[i - 3] : (ages[c] ?? 0)]));
// A sum over no rows is NULL in v1 (I lines 29-97 with no rows).
const ucNull = (labels) => Object.fromEntries(UC_COLUMNS.map((c, i) => [c, i < 3 ? labels[i] : null]));
const NONE11 = uc(['', '', ''], [0, 0, 0, 0]); // I lines 365-430: the all-zero row with blank names

// Sex-by-age cells. Facility A: all 14 clients (Mary f30, John m41, Peter m28, Grace f33, Esther f22, Adam m18, Zed m50, Tom twice m60,
// Sarah f37, Blank Sex x5, no-patient x missing, Nina none, Hope f36). Facility A without Zed. Facility B: four women of 25 to 28 and Mary.
const AG_A_NOZED = { '15to19m': 1, '25to29m': 1, '40to44m': 1, '50plusm': 2, '20to24f': 1, '30to34f': 2, '35to39f': 2, '5to9x': 1, AgeMissingx: 1 };
const AG_B = { '25to29f': 4, '30to34f': 1 };
const AG_SOUTH = { '15to19m': 1, '25to29m': 1, '40to44m': 1, '50plusm': 3, '20to24f': 1, '25to29f': 4, '30to34f': 3, '35to39f': 2, '5to9x': 1, AgeMissingx: 1 };
const AG_SOUTH_NOZED = { ...AG_SOUTH, '50plusm': 2 };
const AG_LUSAKA = { '45to49m': 1, '15to19f': 1, '50plusf': 1, '10to14i': 1, '1to4u': 1 };
const AG_WESTERN = { '50plusf': 1, lt01m: 1 };
const AG_ALL = { lt01m: 1, '15to19m': 1, '25to29m': 1, '40to44m': 1, '45to49m': 1, '50plusm': 3, '15to19f': 1, '20to24f': 1, '25to29f': 4,
  '30to34f': 3, '35to39f': 2, '50plusf': 2, '10to14i': 1, '1to4u': 1, '5to9x': 1, AgeMissingx: 1 };

const ALL3 = ['All', 'All', 'All'];
const SOUTH1 = ['Southern', 'All', 'All'];
const CHOMA2 = ['Southern', 'Choma', 'All'];
const CGH3 = ['Southern', 'Choma', 'Choma General Hospital'];
const CCL3 = ['Southern', 'Choma', 'Choma Clinic'];
const LUSAKA1 = ['Lusaka', 'All', 'All'];
const WESTERN1 = ['Western', 'All', 'All'];

const uniqueQ = queries().find((q) => q.name === 'Unique VL clients');
const facility12Q = queries().find((q) => q.name === 'Unique VL clients by facility (12 months)');
const MAY11 = { from: '2026-05-01', to: '2026-05-31' };
const SEP11 = { from: '2026-09-01', to: '2026-09-30' };
const SUB = 'One row per sub-area';
const p11 = (province = '', district = '', facility = '', rows = '', w = MAY11) => ({ province, district, facility, ...w, rows });
const uSuite = (name, params, rows, setup = '') => orderedSuite10(name, uniqueQ?.sql ?? 'select 1', params, UC_COLUMNS, rows, setup);

// Counts are [Clients, SuppressedC, UnsuppressedC, UndetectableC].
// I counts ok results only. All of A: 13 ok (Grace's 'PTLTT' is not), 7 suppressed (John, Peter, Esther, Adam, Tom 100, Blank Sex, Nina),
// 4 undetectable (John, Peter, Tom 100, Nina). B: 5 ok, 4 suppressed (Edge One 100, Edge Five 300, Late Fee 200, Mary 90), 2 undetectable
// (100 and 90). Lusaka: 5 ok, 4 suppressed (all but 1000), 2 undetectable (100, 'RNA not detected'). Western: 2, 1, 1 undetectable.
const SOUTH_COUNTS = [18, 11, 7, 6];
const B_COUNTS = [5, 4, 1, 2];
const LUSAKA_COUNTS = [5, 4, 1, 2];
const WESTERN_COUNTS = [2, 1, 1, 1];
const LIST_ALL = [
  uc(LUSAKA1, LUSAKA_COUNTS, AG_LUSAKA),
  uc(SOUTH1, [19, 11, 8, 6], AG_SOUTH),
  uc(WESTERN1, WESTERN_COUNTS, AG_WESTERN),
];
const LIST_CHOMA = [uc(CCL3, B_COUNTS, AG_B), uc(CGH3, [13, 7, 6, 4], AG_A_NOZED)];

const suites11 = [
  // I line 21 (no province, district or facility): one row, 'All' names. Clients 25, suppressed 16, unsuppressed 9, undetectable 9.
  // Nowhere Clinic's client has no province and is left out (I line 102); the unmapped facility is not in TND.
  uSuite('all-totals', p11(), [uc(ALL3, [25, 16, 9, 9], AG_ALL)], SETUP11),
  uSuite('all-totals-named', p11('', '', '', 'Totals'), [uc(ALL3, [25, 16, 9, 9], AG_ALL)]),
  // I line 107: the province row; names compare ignoring case and trailing spaces, the row shows the stored name.
  uSuite('province', p11('Southern'), [uc(SOUTH1, SOUTH_COUNTS, AG_SOUTH)]),
  uSuite('province-fold', p11('southern  '), [uc(SOUTH1, SOUTH_COUNTS, AG_SOUTH)]),
  uSuite('province-lusaka', p11('Lusaka'), [uc(LUSAKA1, LUSAKA_COUNTS, AG_LUSAKA)]),
  // I lines 191 and 202: the district branch's undetectable list lacks '<883 copies/mL', so Peter is not undetectable here (5, not 6).
  uSuite('district', p11('Southern', 'Choma'), [uc(CHOMA2, [18, 11, 7, 5], AG_SOUTH)]),
  uSuite('district-fold', p11('SOUTHERN', 'choma '), [uc(CHOMA2, [18, 11, 7, 5], AG_SOUTH)]),
  // I lines 277-282: the facility branch ranks by ART number only, so Adam and Zed (one ART number) are one client: Adam, the first name.
  uSuite('facility', p11('Southern', 'Choma', 'Choma General Hospital'), [uc(CGH3, [12, 7, 5, 4], AG_A_NOZED)]),
  uSuite('facility-fold', p11('Southern', 'Choma', 'choma general hospital '), [uc(CGH3, [12, 7, 5, 4], AG_A_NOZED)]),
  uSuite('facility-clinic', p11('Southern', 'Choma', 'Choma Clinic'), [uc(CCL3, B_COUNTS, AG_B)]),
  // The branch tests only that TND has a row for the area (I lines 107, 191, 278). Monze has one (a baseline lab) but x is empty, so
  // the grouped select returns no row, and not the all-zero row.
  uSuite('district-monze', p11('Southern', 'Monze'), []),
  uSuite('facility-monze', p11('Southern', 'Monze', 'Monze Clinic'), []),
  // I lines 365-430: no TND row for the area, or an unsupported combination of parameters: the all-zero row with blank names.
  uSuite('unknown-province', p11('Nowhere'), [NONE11]),
  uSuite('unknown-district', p11('Southern', 'Nowhere'), [NONE11]),
  uSuite('unknown-facility', p11('Southern', 'Choma', 'Nowhere'), [NONE11]),
  uSuite('district-without-province', p11('', 'Choma'), [NONE11]),
  uSuite('facility-without-district', p11('Southern', '', 'Choma General Hospital'), [NONE11]),
  uSuite('facility-alone', p11('', '', 'Mongu Clinic'), [NONE11]),
  uSuite('empty-window', p11('', '', '', '', { from: '2025-01-01', to: '2025-01-31' }), [NONE11]),
  uSuite('empty-window-province', p11('Southern', '', '', '', { from: '2025-01-01', to: '2025-01-31' }), [NONE11]),
  // July has TND rows (panel RTRI, no hivvl row) but no client. All Zambia always answers with a row, and a sum over no rows is NULL
  // (I line 29 with no rows); a province answers with no row.
  uSuite('july-all', p11('', '', '', '', { from: '2026-07-01', to: '2026-07-31' }), [ucNull(ALL3)]),
  uSuite('july-province', p11('Southern', '', '', '', { from: '2026-07-01', to: '2026-07-31' }), []),
  // I lines 27, 113, 197, 285: cast(ResultDate as datetime) between two dates, so the window ends at 00:00:00 of the end date. A
  // one-day window holds only results at exactly midnight: Edge One at 05-31 00:00:00 (+02:00), Edge Three at 05-01 00:00:00 (+02:00).
  // Edge Two (05-31 00:00:01) and Edge Four (04-30 23:59:59) are out; so is Late Fee's June result.
  // Date-only stamps: Pia One (09-10) and Pia Three (09-30, the end date at midnight) are in; the partial '2026-09' is out and does not raise.
  uSuite('september', p11('', '', '', '', SEP11), [uc(ALL3, [2, 1, 1, 1], { '10to14f': 1, '50plusf': 1 })]),
  uSuite('last-day', p11('', '', '', '', { from: '2026-05-31', to: '2026-05-31' }), [uc(ALL3, [1, 1, 0, 1], { '25to29f': 1 })]),
  uSuite('first-day', p11('', '', '', '', { from: '2026-05-01', to: '2026-05-01' }), [uc(ALL3, [1, 0, 1, 0], { '25to29f': 1 })]),
  // L: one row per sub-area. L lines 20-29 (no province or district): one row per province, count(*) of the ranked rows, sum(suppressed),
  // sum(UU). Grace's 'PTLTT' counts here (Clients 19, not 18), and Zed counts (the all-Zambia branch ranks by name too, L line 23).
  uSuite('list-all', p11('', '', '', SUB), LIST_ALL),
  uSuite('list-all-fold', p11('', '', '', 'ONE ROW PER SUB-AREA '), LIST_ALL),
  // L has no facility parameter: a facility is ignored.
  uSuite('list-all-facility-ignored', p11('', '', 'Mongu Clinic', SUB), LIST_ALL),
  // L lines 104-114 and 180-184 (a province): one row per district. The province and district branches rank by ART number only (L lines
  // 107, 189), so Zed is dropped: 18 clients, 11 suppressed, 7 unsuppressed, 6 undetectable.
  uSuite('list-province', p11('Southern', '', '', SUB), [uc(CHOMA2, [18, 11, 7, 6], AG_SOUTH_NOZED)]),
  // L lines 186-195 and 262-267 (a district): one row per facility.
  uSuite('list-district', p11('Southern', 'Choma', '', SUB), LIST_CHOMA),
  uSuite('list-district-facility-ignored', p11('Southern', 'Choma', 'Nowhere', SUB), LIST_CHOMA),
  uSuite('list-district-monze', p11('Southern', 'Monze', '', SUB), []),
  uSuite('list-unknown-province', p11('Nowhere', '', '', SUB), [NONE11]),
  uSuite('list-district-without-province', p11('', 'Choma', '', SUB), [NONE11]),
  uSuite('list-empty-window', p11('', '', '', SUB, { from: '2025-01-01', to: '2025-01-31' }), [NONE11]),
  uSuite('list-july', p11('', '', '', SUB, { from: '2026-07-01', to: '2026-07-31' }), []),
  uSuite('list-last-day', p11('', '', '', SUB, { from: '2026-05-31', to: '2026-05-31' }), [uc(SOUTH1, [1, 1, 0, 1], { '25to29f': 1 })]),
  {
    name: 'unique-shape',
    count: 9,
    check() {
      const bad = [];
      if (!uniqueQ) return ['query "Unique VL clients" is missing'];
      const ids = uniqueQ.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['province', 'district', 'facility', 'from', 'to', 'rows'])) bad.push(`params: ${ids}`);
      const byId = Object.fromEntries(uniqueQ.params.map((p) => [p.id, p]));
      for (const id of ['from', 'to']) if (!byId[id]?.required || byId[id].type !== 'text') bad.push(`${id} is a required text parameter (ruling 3)`);
      for (const id of ['province', 'district', 'rows']) if (byId[id]?.required || byId[id]?.type !== 'select') bad.push(`${id} is an optional select`);
      if (byId.facility?.required || byId.facility?.type !== 'text') bad.push('facility is an optional text parameter');
      if (BANNED9.test(uniqueQ.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (BANNED9.test((byId.rows?.optionsSql ?? '').replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word in rows optionsSql');
      if (!/^\s*with\b/i.test(uniqueQ.sql)) bad.push('does not start with "with"');
      return bad;
    },
  },
];

// ---- S: one row per facility, three counts ----

const F12_COLUMNS = ['Province', 'District', 'Facility', 'Clients', 'Suppressed', 'UnSuppressed'];
const f12 = (...v) => Object.fromEntries(F12_COLUMNS.map((c, i) => [c, v[i]]));
const p12 = (province = '', w = MAY11) => ({ province, ...w });
const fSuite = (name, params, rows) => orderedSuite10(name, facility12Q?.sql ?? 'select 1', params, F12_COLUMNS, rows);
const SCCL = f12('Southern', 'Choma', 'Choma Clinic', 5, 4, 1);
// S lines 11-13: x ranks every TND row of a hivvl lab, baseline or not. S line 93 drops baseline labs after the ranking, so Esther
// (newest result on a baseline lab) is gone entirely, and Monze's baseline-only client leaves no row. A: 13 clients (A01-A04, Adam, Zed,
// Tom twice, Sarah, Blank Sex, no-patient, Nina, Hope), 6 suppressed (John, Peter, Adam, Tom 100, Blank Sex, Nina).
const SCGH = f12('Southern', 'Choma', 'Choma General Hospital', 13, 6, 7);
const SMONGU = f12('Western', 'Mongu', 'Mongu Clinic', 2, 1, 1);

const suites12 = [
  // S line 120: provinces Southern and Western (the constants); order by province, district, facility (line 121).
  fSuite('facility12-default', p12(), [SCCL, SCGH, SMONGU]),
  // S line 16: ARTNumber must have a length. Zero Art (Lusaka, no ART number) is out: 4 clients, 3 suppressed (not 1000).
  fSuite('facility12-lusaka', p12('Lusaka'), [f12('Lusaka', 'Lusaka', 'Chilenje Clinic', 4, 3, 1)]),
  fSuite('facility12-fold', p12('southern  '), [SCCL, SCGH]),
  fSuite('facility12-unknown', p12('Nowhere'), []),
  // S line 15: cast(ResultDate as datetime) between two dates: the end date at 00:00:00. Edge One is the only result at 05-31 00:00:00.
  fSuite('facility12-last-day', p12('', { from: '2026-05-31', to: '2026-05-31' }), [f12('Southern', 'Choma', 'Choma Clinic', 1, 1, 0)]),
  fSuite('facility12-september', p12('', SEP11), [SMONGU]),
  fSuite('facility12-empty-window', p12('', { from: '2025-01-01', to: '2025-01-31' }), []),
  {
    name: 'facility12-shape',
    count: 7,
    check() {
      const bad = [];
      if (!facility12Q) return ['query "Unique VL clients by facility (12 months)" is missing'];
      const ids = facility12Q.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['from', 'to', 'province'])) bad.push(`params: ${ids}`);
      const byId = Object.fromEntries(facility12Q.params.map((p) => [p.id, p]));
      for (const id of ['from', 'to']) if (!byId[id]?.required || byId[id].type !== 'text') bad.push(`${id} is a required text parameter (ruling 3)`);
      if (byId.province?.required || byId.province?.type !== 'select') bad.push('province is an optional select');
      if (BANNED9.test(facility12Q.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (!/^\s*with\b/i.test(facility12Q.sql)) bad.push('does not start with "with"');
      return bad;
    },
  },
];

// ---- The builders ----

// tndCte (v1 TND, sp_GetPreviousVLResultforCohort2x): every final result of panels HIVVL and RTRI in the observations
// HIVVL, HIVVC, HIVTM, HIVVD, POCVR, POCVC that is not on the 26 invalid texts, with a report issued in the window
// (a LOCAL-DATE window, wider than the reports' own midnight window). One row per result.
const TND_COLUMNS = ['province', 'district', 'facility', 'lab_id', 'client_name', 'firstname', 'surname', 'age_years', 'sex', 'gender',
  'art_number', 'collected_date', 'registered_date', 'result_date', 'result', 'suppressed_flag', 'uu_flag'];
const tnd = (lab, result_date, o) => ({
  province: 'Southern', district: 'Choma', facility: 'Choma General Hospital', lab_id: lab, client_name: null, firstname: null, surname: null,
  age_years: 30, sex: 'F', gender: 'Female', art_number: '', collected_date: '2026-05-01T07:00:00Z', registered_date: '2026-05-01T08:00:00Z',
  result_date, result: null, suppressed_flag: 0, uu_flag: 0, ...o,
});
const TND_ROWS = [
  // John: 'Target Not Detected' is on the suppressed and the undetectable lists.
  tnd('T11-A02', '2026-05-11T10:00:00Z', { client_name: 'John Phiri', firstname: 'John', surname: 'Phiri', age_years: 41, sex: 'M', gender: 'Male', art_number: 'A200', result: 'Target Not Detected', suppressed_flag: 1, uu_flag: 1 }),
  // Peter: the number 50 is under 200; the text '<883 copies/mL' is a suppressed text and its number 150 is under 200.
  tnd('T11-A03', '2026-05-05T08:00:00Z', { client_name: 'Peter Lungu', firstname: 'Peter', surname: 'Lungu', age_years: 28, sex: 'M', gender: 'Male', art_number: 'A300', result: '50', suppressed_flag: 1, uu_flag: 1 }),
  tnd('T11-A03', '2026-05-12T08:00:00Z', { client_name: 'Peter Lungu', firstname: 'Peter', surname: 'Lungu', age_years: 28, sex: 'M', gender: 'Male', art_number: 'A300', result: '<883 copies/mL', suppressed_flag: 1, uu_flag: 1 }),
  // Grace: PTLTT is on no list and has no number.
  tnd('T11-A04', '2026-05-08T08:00:00Z', { client_name: 'Grace Tembo', firstname: 'Grace', surname: 'Tembo', age_years: 33, art_number: 'A400', result: 'PTLTT' }),
  // Lisa: panel RTRI is valid in TND.
  tnd('T11-A06', '2026-05-06T08:00:00Z', { client_name: 'Lisa Mumba', firstname: 'Lisa', surname: 'Mumba', age_years: 27, art_number: 'A600', result: '80', suppressed_flag: 1, uu_flag: 1 }),
  // No patient row: no names, no sex (gender Missing), no age; the ART number comes from the unique id.
  tnd('T11-A11', '2026-05-09T08:00:00Z', { client_name: ' ', age_years: null, sex: null, gender: 'Missing', art_number: 'U11', result: '3500' }),
  // Nina's sex code N has no gender word of its own in slice 1's mapping.
  tnd('T11-A12', '2026-05-13T08:00:00Z', { client_name: 'Nina Other', firstname: 'Nina', surname: 'Other', age_years: 40, sex: 'N', gender: 'Missing', art_number: 'A1200', result: '150', suppressed_flag: 1, uu_flag: 1 }),
  // Hope's April result is outside the window; the May one is in.
  tnd('T11-A13', '2026-05-15T08:00:00Z', { client_name: 'Hope Mulenga', firstname: 'Hope', surname: 'Mulenga', age_years: 36, art_number: 'A1300', result: '3000' }),
  // Edge Two is in the local-date window (05-31), though a midnight window would drop it.
  tnd('T11-B02', '2026-05-31T00:00:01+02:00', { facility: 'Choma Clinic', client_name: 'Edge Two', firstname: 'Edge', surname: 'Two', age_years: 25, art_number: 'B200', result: '100', suppressed_flag: 1, uu_flag: 1 }),
  // Nowhere Clinic's register row has no province or district.
  tnd('T11-N01', '2026-05-10T08:00:00Z', { province: null, district: null, facility: 'Nowhere Clinic', client_name: 'Nora Null', firstname: 'Nora', surname: 'Null', art_number: 'N100', result: '100', suppressed_flag: 1, uu_flag: 1 }),
];
const TND_ABSENT = [['T11-A13', '2026-04-20T08:00:00Z'], ['T11-B04', '2026-04-30T23:59:59+02:00'], ['T11-B06b', '2026-06-02T08:00:00Z'],
  ['T11-U01', '2026-05-10T08:00:00Z'], ['T11-X01', '2026-07-10T08:00:00Z']];

const tndSuite = {
  name: 'tnd-builder',
  setup: '',
  sql: `select 'tnd-builder' || chr(9) || row_to_json(q)::text from (${bind(`with ${tndCte('tn')}
select ${TND_COLUMNS.join(', ')} from tn order by lab_id, result_date`, MAY11)}) q;`,
  count: 2 + TND_ROWS.length + TND_ABSENT.length,
  check(got) {
    const failures = [];
    // 34 results: A 19, B 6, C 1, D 5, W 2, N 1.
    if (got.length !== 34) failures.push(`expected 34 rows, got ${got.length}`);
    if (got[0]) failures.push(...inOrder(Object.keys(got[0]), TND_COLUMNS));
    for (const want of TND_ROWS) {
      const row = got.find((g) => g.lab_id === want.lab_id && g.result_date === want.result_date);
      if (!row) failures.push(`missing ${want.lab_id} ${want.result_date}`);
      else if (JSON.stringify(TND_COLUMNS.map((c) => row[c] ?? null)) !== JSON.stringify(TND_COLUMNS.map((c) => want[c] ?? null))) {
        failures.push(`${want.lab_id} ${want.result_date}: expected ${JSON.stringify(TND_COLUMNS.map((c) => want[c] ?? null))}, got ${JSON.stringify(TND_COLUMNS.map((c) => row[c] ?? null))}`);
      }
    }
    for (const [lab, date] of TND_ABSENT) if (got.some((g) => g.lab_id === lab && g.result_date === date)) failures.push(`${lab} ${date} must not be in TND`);
    return failures;
  },
};

// hivvlCte with labsInWindow keeps the row of a lab whose earliest report is before the window (Hope, 04-20); without it, the lab is gone.
const hvSuite = (name, options, rows) => orderedSuite10(name,
  `with ${hivvlCte('hv', options)} select lab_id, tested_date from hv where lab_id = 'T11-A13'`, MAY11, ['lab_id', 'tested_date'], rows);

const suitesBuilders11 = [
  tndSuite,
  hvSuite('hivvl-labs-in-window', { from: 'from', to: 'to', labsInWindow: true }, [{ lab_id: 'T11-A13', tested_date: '2026-04-20T08:00:00Z' }]),
  hvSuite('hivvl-windowed', { from: 'from', to: 'to' }, []),
];

// ============================================================================================
// Group t12: "Unique VL clients, 12-month rates" (v1 sp_getUniqueVLClientsInfoLast1Year, "R" below), "VL requests and tests by lab and
// month" (v1 view vVLRequestsTestsByMonth, "M") and "VL result bands by month" (v1 view vVLResRangeBreakDownByMonth, "B", over the helper
// view vVLReportData, "D"). Fixture ids start with "t12-"; lab ids with "T12-". "R line N" is a line of
// StoredProcedure__dbo_sp_getUniqueVLClientsInfoLast1Year.sql, "M line N" of View__dbo_vVLRequestsTestsByMonth.sql, "B line N" of
// View__dbo_vVLResRangeBreakDownByMonth.sql, "D line N" of View__dbo_vVLReportData.sql. Expected rows are worked out by hand from the v1 text.
//
// Every suite of a group shares one fixture (all setups run first), so the three queries' rows are kept apart by what each ignores:
//   - R clients (lab ids T12-A.., T12-B.., T12-C.., T12-D.., T12-U..): a mapped requesting facility, a blank testing lab (M needs a lab
//     code) and a rejection code (D drops rejected requests). R reads neither.
//   - M requests (T12-X.., T12-Y..): no requesting facility (TND and hivvl need one) and a rejection code (D drops them).
//   - B requests (T12-Bb..): no requesting facility and no testing lab, never rejected unless the case says so.
//
// R facilities (fixture codes ZT12x): A Choma General Hospital, Southern/Choma; B Choma Clinic, Southern/Choma; C Mongu Clinic,
// Western/Mongu; D Chilenje Clinic, Lusaka/Lusaka; U not in the register. Window used by most cases: 2026-05-01 to 2026-05-31.
//
// R clients, with what each does. "latest ever" is TND.Rank = 1 (R lines 19, 35...): the client's newest result over ALL time.
//   A01 Mary Banda    04-10 3000, then 05-12 50: latest 50, counted, suppressed, undetectable. (The same name and ART at Choma Clinic is a
//                     separate client: B05.)
//   A02 John Phiri    05-11 'Target Not Detected', then 06-15 4000: the latest ever is June, outside the May window: NOT counted in May
//                     (counted in June). "Unique VL clients" would count his May result; R does not.
//   A03 Peter Lungu   05-05 50, then 05-12 '<883 copies/mL': the latest has no hivvl row (not a valid hivvl result): not counted, and R
//                     does not fall back to the 50.
//   A04 Grace Tembo   'PTLTT': a valid hivvl text, but not a number and not one of the 13 texts: not counted.
//   A05 Esther Daka   05-04 500, then 05-25 700 on a baseline lab: the latest is a baseline test, so she is dropped (R line 27 comes after
//                     the rank). "Unique VL clients" would count the 500.
//   A06 Lisa Mumba    panel RTRI: in TND, no hivvl row: not counted.
//   A07 Adam, Zed Moyo   two people, one ART number (A700): R ranks by the names too in every branch, so both count (400; 1200).
//   A08 Tom Zulu      two labs at one instant, both 100: row_number() gives one visit 1, so he counts once (rank() would count twice).
//   A09 Sarah Chanda  'sarah' 'chanda' 'a900' 05-06 300, then 'Sarah' 'Chanda ' 'A900' 05-18 4000: one client ignoring case and trailing
//                     spaces; the latest 4000 counts: not suppressed.
//   A10 Blank Sex     sex '' 250: suppressed, not undetectable.   A11 (no patient)  ART 'U11' from the unique id: 3500.
//   A12 Nina Other    150: suppressed and undetectable.   A13 Hope Mulenga  04-20 100, then 05-15 3000: latest 3000.
//   A14 Pan Els       a result in panel HIVVL 05-14 (100) and one in panel RTRI 05-24 (90): the rank partitions by panel, so the HIVVL result
//                     is visit 1 of its own and counts; the RTRI one has no hivvl row.
//   A15 Sex Two       one ART number, sex code F (05-10 100) and sex code M (05-23 2000): the rank partitions by sex code, so both are visit
//                     1 and both count.
//   A16 Nd One        the text 'ND': counted in the all-Zambia and province branches, NOT in the district and facility branches (R lines 110, 146).
//   A17 Four Hundred  the text '<400': in R's list but not a valid hivvl result, so no hivvl row: never counted.
//   A18 Four Copies   '<400 copies/mL': counted, suppressed, not undetectable.
//   B01..B06          Choma Clinic: window edges with +02:00 stamps, Mary Banda again (B05), and Late Fee (B06, latest in June).
//   C01..C03          Mongu Clinic: a date-only stamp, a partial stamp ('2026-05', no day: out and must not raise), a plain one.
//   D01..D05          Chilenje Clinic: 100; 'RNA not detected'; '<20 copies/mL'; 1000; 600 with no ART number.
// ============================================================================================

const P12 = [];
const R12 = [];
const D12 = [];
const S12 = [];
const L12 = [];
const T12 = [];
const F12 = [];
let n12 = 0;
const num12 = (v) => (v === null || v === undefined ? 'null' : String(v));
const Q12_DEFAULTS = { panel: 'HIVVL', req: null, authored: '2026-05-01T08:00:00Z', eff: '2026-05-01T07:00:00Z', rec: null, issued: null,
  status: 'final', performer: null, rej: null, obr: 1, results: [{ obs: 'HIVVL', num: 100 }], noReport: false, patient: false,
  first: null, last: null, sex: 'F', age: 30, art: null, uq: null, form: null };

// One lab request row of lab number `labId` with its report (unless noReport), specimen (when `rec`), results, optional patient and
// pre-registration attributes. o: panel, req (requester code), authored, eff (collected), rec (received), issued, status, performer, rej
// (rejection code), obr, results [{ obs, num, text, cmp, coded }], noReport, patient (true: a patient row), first, last, sex, age,
// art (reference-numbers), uq (unique-id), form [[linkId, answer]].
function rq12(labId, o = {}) {
  const r = { ...Q12_DEFAULTS, ...o };
  const k = String(++n12).padStart(3, '0');
  const qid = `t12-q${k}`;
  let pid = null;
  if (r.patient) {
    pid = `t12-p${k}`;
    P12.push(`(${lit(pid)}, ${lit(r.first)}, ${lit(r.last)}, ${lit(r.sex)})`);
  }
  R12.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.authored)}, '2026-05-02T09:00:00Z', ${lit(r.req)}, ${lit(pid)}, ${num12(r.age)}, ${lit(r.rej)}, ${r.obr})`);
  if (!r.noReport) {
    let sid = null;
    if (r.rec !== null) {
      sid = `t12-s${k}`;
      S12.push(`(${lit(sid)}, ${lit(r.rec)})`);
    }
    D12.push(`(${lit(`t12-d${k}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.eff)}, ${lit(r.issued)}, ${lit(r.performer)}, ${lit(sid)})`);
  }
  r.results.forEach((x, i) => {
    L12.push(`(${lit(`t12-r${k}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${num12(x.num)}, ${lit(x.cmp ?? null)}, ${lit(x.coded ?? null)})`);
  });
  if (r.art !== null) T12.push(`(${lit(`t12-a${k}r`)}, ${lit(qid)}, ${lit(ATTR_SYSTEM)}, ${lit(REF)}, ${lit(r.art)})`);
  if (r.uq !== null) T12.push(`(${lit(`t12-a${k}u`)}, ${lit(qid)}, ${lit(ATTR_SYSTEM)}, ${lit(UNQ)}, ${lit(r.uq)})`);
  if (r.form) {
    const items = r.form.map(([linkId, text]) => ({ linkId, answer: [{ valueString: text }] }));
    F12.push(`(${lit(`t12-f${k}`)}, 'q', 'hiv_vl_documentation', ${lit(qid)}, '2026-05-02T08:00:00Z', ${lit(JSON.stringify(items))})`);
  }
}

// An R client's lab: a mapped requesting facility, a blank testing lab, rejected (the other two queries ignore it). o as rq12, plus num/text.
function cl12(labId, issued, o = {}) {
  const { num = null, text = null, obs = 'HIVVL', ...rest } = o;
  rq12(labId, { req: 'ZT12A', performer: '', rej: 'REJ', patient: true, issued, results: [{ obs, num, text }], ...rest });
}

// ---- R: Choma General Hospital ----
cl12('T12-A01a', '2026-04-10T08:00:00Z', { first: 'Mary', last: 'Banda', art: 'A100', num: 3000 });
cl12('T12-A01b', '2026-05-12T08:00:00Z', { first: 'Mary', last: 'Banda', art: 'A100', num: 50 });
cl12('T12-A02a', '2026-05-11T10:00:00Z', { first: 'John', last: 'Phiri', sex: 'M', art: 'A200', text: 'Target Not Detected' });
cl12('T12-A02b', '2026-06-15T08:00:00Z', { first: 'John', last: 'Phiri', sex: 'M', art: 'A200', num: 4000 });
cl12('T12-A03a', '2026-05-05T08:00:00Z', { first: 'Peter', last: 'Lungu', sex: 'M', art: 'A300', num: 50 });
cl12('T12-A03b', '2026-05-12T08:00:00Z', { first: 'Peter', last: 'Lungu', sex: 'M', art: 'A300', text: '<883 copies/mL', num: 150 });
cl12('T12-A04', '2026-05-08T08:00:00Z', { first: 'Grace', last: 'Tembo', art: 'A400', text: 'PTLTT' });
cl12('T12-A05a', '2026-05-04T08:00:00Z', { first: 'Esther', last: 'Daka', art: 'A500', num: 500 });
cl12('T12-A05b', '2026-05-25T08:00:00Z', { first: 'Esther', last: 'Daka', art: 'A500', num: 700, form: [['ARTRS', 'Baseline VL']] });
cl12('T12-A06', '2026-05-06T08:00:00Z', { first: 'Lisa', last: 'Mumba', art: 'A600', panel: 'RTRI', num: 80 });
cl12('T12-A07a', '2026-05-10T08:00:00Z', { first: 'Adam', last: 'Moyo', sex: 'M', art: 'A700', num: 400 });
cl12('T12-A07b', '2026-05-15T08:00:00Z', { first: 'Zed', last: 'Moyo', sex: 'M', art: 'A700', num: 1200 });
cl12('T12-A08a', '2026-05-12T09:00:00Z', { first: 'Tom', last: 'Zulu', sex: 'M', art: 'A800', num: 100 });
cl12('T12-A08b', '2026-05-12T09:00:00Z', { first: 'Tom', last: 'Zulu', sex: 'M', art: 'A800', num: 100 });
cl12('T12-A09a', '2026-05-06T08:00:00Z', { first: 'sarah', last: 'chanda', art: 'a900', num: 300 });
cl12('T12-A09b', '2026-05-18T08:00:00Z', { first: 'Sarah', last: 'Chanda ', art: 'A900', num: 4000 });
cl12('T12-A10', '2026-05-07T08:00:00Z', { first: 'Blank', last: 'Sex', sex: '', art: 'A1000', num: 250 });
cl12('T12-A11', '2026-05-09T08:00:00Z', { patient: false, uq: 'U-11', num: 3500 });
cl12('T12-A12', '2026-05-13T08:00:00Z', { first: 'Nina', last: 'Other', sex: 'N', art: 'A1200', num: 150 });
cl12('T12-A13a', '2026-04-20T08:00:00Z', { first: 'Hope', last: 'Mulenga', art: 'A1300', num: 100 });
cl12('T12-A13b', '2026-05-15T08:00:00Z', { first: 'Hope', last: 'Mulenga', art: 'A1300', num: 3000 });
cl12('T12-A14a', '2026-05-14T08:00:00Z', { first: 'Pan', last: 'Els', art: 'A1400', num: 100 });
cl12('T12-A14b', '2026-05-24T08:00:00Z', { first: 'Pan', last: 'Els', art: 'A1400', panel: 'RTRI', num: 90 });
cl12('T12-A15a', '2026-05-10T09:00:00Z', { first: 'Sex', last: 'Two', sex: 'F', art: 'A1500', num: 100 });
cl12('T12-A15b', '2026-05-23T08:00:00Z', { first: 'Sex', last: 'Two', sex: 'M', art: 'A1500', num: 2000 });
cl12('T12-A16', '2026-05-16T08:00:00Z', { first: 'Nd', last: 'One', art: 'A1600', text: 'ND' });
cl12('T12-A17', '2026-05-17T08:00:00Z', { first: 'Four', last: 'Hundred', art: 'A1700', text: '<400' });
cl12('T12-A18', '2026-05-17T09:00:00Z', { first: 'Four', last: 'Copies', art: 'A1800', text: '<400 copies/mL' });
// ---- R: Choma Clinic ----
const CB = { req: 'ZT12B' };
cl12('T12-B01', '2026-06-01T00:30:00+02:00', { ...CB, first: 'Edge', last: 'One', art: 'B100', num: 100 });   // local June 1 (UTC May 31): out of May
cl12('T12-B02', '2026-05-01T00:30:00+02:00', { ...CB, first: 'Edge', last: 'Two', art: 'B200', num: 100 });   // local May 1 (UTC April 30): in
cl12('T12-B03', '2026-05-31T23:59:59+02:00', { ...CB, first: 'Edge', last: 'Three', art: 'B300', num: 800 }); // the last evening of May: in
cl12('T12-B04', '2026-04-30T23:30:00+02:00', { ...CB, first: 'Edge', last: 'Four', art: 'B400', num: 100 });  // local April 30: out of May
cl12('T12-B05', '2026-05-22T08:00:00Z', { ...CB, first: 'Mary', last: 'Banda', art: 'A100', num: 90 });
cl12('T12-B06a', '2026-05-10T08:00:00Z', { ...CB, first: 'Late', last: 'Fee', art: 'B600', num: 200 });
cl12('T12-B06b', '2026-06-02T08:00:00Z', { ...CB, first: 'Late', last: 'Fee', art: 'B600', num: 5000 });
// ---- R: Mongu Clinic ----
const CC = { req: 'ZT12C' };
cl12('T12-C01', '2026-05-20', { ...CC, first: 'Wanda', last: 'Mwila', age: 61, art: 'W100', num: 20 });
cl12('T12-C02', '2026-05', { ...CC, first: 'Partial', last: 'Stamp', art: 'W200', num: 100 });
cl12('T12-C03', '2026-05-21T08:00:00Z', { ...CC, first: 'Willy', last: 'Mwila', sex: 'M', art: 'W300', num: 5000 });
// ---- R: Chilenje Clinic, and an unmapped facility ----
const CD = { req: 'ZT12D' };
cl12('T12-D01', '2026-05-14T08:00:00Z', { ...CD, first: 'Dan', last: 'Lungu', sex: 'M', art: 'D100', num: 100 });
cl12('T12-D02', '2026-05-15T08:00:00Z', { ...CD, first: 'Dina', last: 'Zulu', art: 'D200', text: 'RNA not detected' });
cl12('T12-D03', '2026-05-16T08:00:00Z', { ...CD, first: 'Ida', last: 'Unknown', sex: 'U', art: 'D300', text: '<20 copies/mL' });
cl12('T12-D04', '2026-05-17T08:00:00Z', { ...CD, first: 'Ian', last: 'Indet', sex: 'I', art: 'D400', num: 1000 });
cl12('T12-D05', '2026-05-18T08:00:00Z', { ...CD, first: 'Zero', last: 'Art', num: 600 });
cl12('T12-U01', '2026-05-10T08:00:00Z', { req: 'ZT12U', first: 'Una', last: 'Mapped', art: 'U100', num: 100 });
// ---- R: TND's floor and ceiling (sp_GetPreviousVLResultforCohort2x line 105: AuthorisedDateTime between 2017-01-01 and getdate()) ----
cl12('T12-F01', '2016-12-31T23:30:00+02:00', { first: 'Old', last: 'Timer', art: 'F100', num: 100 });    // local Dec 31 2016: before the floor
cl12('T12-F02', '2099-01-01T08:00:00Z', { first: 'Future', last: 'Self', art: 'F200', num: 5000 });     // after the ceiling: never her newest result
cl12('T12-F03', '2026-03-10T08:00:00Z', { first: 'Future', last: 'Self', art: 'F200', num: 100 });      // so this is her newest
cl12('T12-F04', '2017-01-01T00:30:00+02:00', { first: 'New', last: 'Year', art: 'F300', num: 100 });    // local Jan 1 2017 (UTC Dec 31 2016): on the floor, in

// ---- M: lab X (testing lab code 'T12X') and lab Y ('T12Y') ----
// No requesting facility, rejected; so only the lab-by-month query sees them. Authored = registration; issued = authorised.
const mx = (labId, o) => rq12(labId, { performer: 'T12X', rej: 'REJ', ...o });
const my = (labId, o) => rq12(labId, { performer: 'T12Y', rej: 'REJ', ...o });
mx('T12-X1', { authored: '2025-05-10T08:00:00Z', issued: '2025-05-20T10:00:00Z' });
mx('T12-X2', { authored: '2025-05-11T08:00:00Z', issued: '2025-06-02T10:00:00Z', results: [{ obs: 'HIVVC', num: 100 }] });
mx('T12-X3', { authored: '2026-05-12T08:00:00Z', issued: '2026-05-15T10:00:00Z' });
mx('T12-X4', { authored: '2026-05-13T08:00:00Z', issued: '2026-05-16T10:00:00Z', status: 'preliminary' });              // not final: not tested
mx('T12-X5', { authored: '2026-05-14T08:00:00Z', issued: '2026-05-17T10:00:00Z', results: [{ obs: 'HIVVD', num: 100 }] }); // observation not HIVVL or HIVVC: not tested
mx('T12-X6', { authored: '2026-06-01T00:30:00+02:00', issued: '2026-05-01T00:30:00+02:00' });  // registered local June 1 (UTC May 31); authorised local May 1 (UTC April 30)
mx('T12-X7', { authored: '2026-05-31T23:30:00+02:00', issued: '2026-05-31T23:45:00+02:00' });  // local May 31 both
mx('T12-X8', { authored: '2026-04-02T08:00:00Z', issued: '2026-04-03T10:00:00Z', obr: 1 });
mx('T12-X8', { authored: '2026-04-02T08:00:00Z', issued: '2026-04-03T10:00:00Z', obr: 2 });    // the same request, a second OBR set: counted once
mx('T12-X9', { performer: 'T12x ', authored: '2026-03-05T08:00:00Z', issued: '2026-03-06T10:00:00Z' }); // the lab code differs in case and a trailing space
mx('T12-X9b', { authored: '2026-03-09T08:00:00Z', issued: '2026-03-10T10:00:00Z' });
mx('T12-X10', { panel: 'HIVPC', authored: '2026-03-06T08:00:00Z', issued: '2026-03-07T10:00:00Z' });  // not a VL panel
mx('T12-X11', { performer: '', authored: '2026-03-07T08:00:00Z', issued: '2026-03-08T10:00:00Z' });  // blank testing lab
mx('T12-X12', { noReport: true, authored: '2026-03-08T08:00:00Z' });                                 // no report, so no testing lab
my('T12-Y1', { authored: '2026-03-10T08:00:00Z', issued: '2026-03-12T10:00:00Z' });
my('T12-y1', { authored: '2026-03-10T09:00:00Z', issued: '2026-03-12T11:00:00Z' });                  // the lab number in another case: the same request
my('T12-Y2', { authored: '2026-03-11T08:00:00Z', issued: null });                                    // final, never authorised
my('T12-Y3', { authored: '2024-03-05T08:00:00Z', issued: '2024-03-06T10:00:00Z' });
my('T12-Y4', { authored: null, issued: '2026-03-20T10:00:00Z' });                                    // no registration date
my('T12-Y5', { panel: 'hivvl ', authored: '2026-03-12T08:00:00Z', issued: '2026-03-13T10:00:00Z' });  // panel code in another case, trailing space

// ---- B: result bands ----
// No requesting facility, no testing lab. effective = collected date (the month key), rec = received date, authored = registered date.
const bb = (labId, o = {}) => rq12(labId, { eff: '2026-03-02T08:00:00Z', authored: '2026-03-01T08:00:00Z', ...o });
bb('T12-Bb01', { results: [{ obs: 'HIVVL', num: 10 }] });
bb('T12-Bb02', { eff: '2026-03-03T08:00:00Z', results: [{ obs: 'HIVVL', coded: 'LDL' }] });
bb('T12-Bb03', { eff: '2026-03-04T08:00:00Z', results: [{ obs: 'HIVVL', num: 20 }] });
bb('T12-Bb04', { eff: '2026-03-05T08:00:00Z', results: [{ obs: 'HIVVL', num: 999 }] });
bb('T12-Bb05', { eff: '2026-03-06T08:00:00Z', results: [{ obs: 'HIVVL', num: 1000 }] });
bb('T12-Bb06', { eff: '2026-03-07T08:00:00Z', results: [{ obs: 'HIVVL', num: 1000.5 }] });
bb('T12-Bb07', { eff: '2026-03-08T08:00:00Z', results: [{ obs: 'HIVVL', num: 19.99 }] });
bb('T12-Bb08', { eff: '2026-03-09T08:00:00Z', results: [{ obs: 'HIVVL', num: 0 }] });
bb('T12-Bb09', { eff: '2026-03-10T08:00:00Z', results: [{ obs: 'HIVVL', num: -1 }] });
bb('T12-Bb10', { eff: '2026-03-11T08:00:00Z', results: [{ obs: 'HIVVL', text: 'Pending' }] });
bb('T12-Bb11', { eff: '2026-03-12T08:00:00Z', results: [{ obs: 'HIVVL', coded: 'ldl', num: 5000 }] });          // the coded value comes first
bb('T12-Bb12', { eff: '2026-03-13T08:00:00Z', results: [{ obs: 'HIVVL', num: 10 }, { obs: 'HIVVC', num: 5000 }] }); // two bands, one request
bb('T12-Bb13', { eff: '2026-03-14T08:00:00Z', results: [{ obs: 'HIVVD', num: 500 }] });
bb('T12-Bb14', { eff: '2026-03-15T08:00:00Z', rej: 'REJ', results: [{ obs: 'HIVVL', num: 10 }] });                // rejected: out
bb('T12-Bb15', { eff: '2026-03-16T08:00:00Z', rej: '  ', results: [{ obs: 'HIVVL', num: 100 }] });                // a blank rejection code is not a rejection
bb('T12-Bb16', { eff: '2026-03-17T08:00:00Z', panel: 'HIVPC', results: [{ obs: 'HIVVL', num: 10 }] });            // not a VL panel
bb('T12-Bb17', { eff: '2026-03-18T08:00:00Z', results: [{ obs: 'XXXX', num: 10 }] });                             // observation not HIVVL, HIVVD or HIVVC
bb('T12-Bb18', { eff: '2026-03-19T08:00:00Z', results: [{ obs: 'HIVVL', num: 10 }] });
bb('T12-bb18', { eff: '2026-03-19T09:00:00Z', results: [{ obs: 'HIVVL', num: 10 }] });                            // the same request in another case
bb('T12-Bb19', { eff: '2026-03-20T08:00:00Z', results: [{ obs: 'HIVVL' }] });                                     // a result with no value at all
bb('T12-Bb20', { eff: '2026-01-01T00:30:00+02:00', results: [{ obs: 'HIVVL', num: 50 }] });                       // local Jan 1 (UTC Dec 31)
bb('T12-Bb21', { eff: null, rec: '2026-05-01T00:30:00+02:00', authored: '2025-02-01T08:00:00Z', results: [{ obs: 'HIVVL', num: 3000 }] }); // received date wins: local May 1
bb('T12-Bb22', { eff: null, rec: null, authored: '2026-06-01T00:30:00+02:00', results: [{ obs: 'HIVVL', num: 5 }] }); // registered date: local June 1 (UTC May 31)
bb('T12-Bb23', { eff: '2025-02-10T07:00:00Z', results: [{ obs: 'HIVVL', coded: 'LDL' }] });
bb('T12-Bb24', { eff: null, rec: null, authored: null, results: [{ obs: 'HIVVL', num: 10 }] });                    // no date at all

const SETUP12 = `${facilityRows('t12', [
  ['ZT12A', 'Choma General Hospital', 'Southern', 'Choma'],
  ['ZT12B', 'Choma Clinic', 'Southern', 'Choma'],
  ['ZT12C', 'Mongu Clinic', 'Western', 'Mongu'],
  ['ZT12D', 'Chilenje Clinic', 'Lusaka', 'Lusaka'],
  ['ZT12U', 'Unmapped Clinic', 'Southern', 'Choma', false],
])}
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years, rejection_code, obr_set_id) values ${R12.join(',\n  ')};
insert into patients (id, firstname, surname, sex) values ${P12.join(',\n  ')};
insert into specimens (id, received_time) values ${S12.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, specimen_id) values ${D12.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values ${L12.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${T12.join(',\n  ')};
insert into questionnaire_responses (id, questionnaire, form_code, based_on_id, authored, items) values ${F12.join(',\n  ')};`;

// ---- R: expected rows ----

const RATE_COLUMNS = ['VLClients', 'Suppressed', 'Undetectable', 'SuppressionRate', 'UndetectableRate'];
const ratesQ = queries().find((q) => q.name === 'Unique VL clients, 12-month rates');
const rate = (...v) => Object.fromEntries(RATE_COLUMNS.map((c, i) => [c, v[i]]));
const MAY12 = { from: '2026-05-01', to: '2026-05-31' };
const r12 = (province = '', district = '', facility = '', w = MAY12) => ({ province, district, facility, ...w });
const rSuite = (name, params, row, setup = '') => orderedSuite10(name, ratesQ?.sql ?? 'select 1', params, RATE_COLUMNS, [row], setup);

// Counts by facility, clients / suppressed / undetectable (the sums of the cases above):
//   A: 14 clients with 'ND', 13 without (Nd One). Suppressed 9 (8 without ND), undetectable 6 (5 without ND).
//      Counted: Mary 50 (S U), Adam 400 (S), Zed 1200, Tom 100 (S U), Sarah 4000, Blank Sex 250 (S), no-patient 3500, Nina 150 (S U),
//      Hope 3000, Pan Els 100 (S U), Sex Two F 100 (S U), Sex Two M 2000, Nd One 'ND' (S U), Four Copies (S).
//   B: Edge Two 100 (S U), Edge Three 800 (S), Mary 90 (S U): 3 clients, 3 suppressed, 2 undetectable.
//   C: Wanda 20 (S U), Willy 5000: 2, 1, 1.
//   D: Dan 100 (S U), Dina 'RNA not detected' (S U), Ida '<20 copies/mL' (S), Ian 1000, Zero Art 600 (S): 5, 4, 2.
// Rates are cut at 12 decimals, not rounded (measured on SQL Server): 1200/17 = 70.588235294117|647, 800/17 = 47.058823529411|765, 500/13 = 38.461538461538|461.
const NULLS = rate(0, null, null, null, null);
const ZEROS = rate(0, 0, 0, 0, 0);

const suitesRates = [
  // R lines 12, 30-43 (nothing given): all Zambia. 24 clients, 17 suppressed, 11 undetectable. 'ND' counts here.
  rSuite('rates-all', r12(), rate(24, 17, 11, 70.833333333333, 45.833333333333), SETUP12),
  // R lines 45, 64-79 (a province): the names are the hivvl row's; compared ignoring case and trailing spaces. Southern = A + B: 17, 12, 8.
  rSuite('rates-province', r12('Southern'), rate(17, 12, 8, 70.588235294117, 47.058823529411)),
  rSuite('rates-province-fold', r12('southern  '), rate(17, 12, 8, 70.588235294117, 47.058823529411)),
  rSuite('rates-lusaka', r12('Lusaka'), rate(5, 4, 2, 80, 40)),
  rSuite('rates-western', r12('Western'), rate(2, 1, 1, 50, 50)),
  // R lines 81, 101-116 (a district): the text list lacks 'ND' (line 110), so Nd One drops out: A 13, 8, 5 + B 3, 3, 2 = 16, 11, 7.
  rSuite('rates-district', r12('Southern', 'Choma'), rate(16, 11, 7, 68.75, 43.75)),
  rSuite('rates-district-fold', r12('SOUTHERN', 'choma '), rate(16, 11, 7, 68.75, 43.75)),
  rSuite('rates-district-lusaka', r12('Lusaka', 'Lusaka'), rate(5, 4, 2, 80, 40)),
  // R lines 118, 137-152 (a facility): also without 'ND' (line 146). A: 13, 8, 5.
  rSuite('rates-facility', r12('Southern', 'Choma', 'Choma General Hospital'), rate(13, 8, 5, 61.538461538461, 38.461538461538)),
  rSuite('rates-facility-fold', r12('Southern', 'Choma', 'choma general hospital '), rate(13, 8, 5, 61.538461538461, 38.461538461538)),
  rSuite('rates-facility-clinic', r12('Southern', 'Choma', 'Choma Clinic'), rate(3, 3, 2, 100, 66.666666666666)),
  rSuite('rates-facility-mongu', r12('Western', 'Mongu', 'Mongu Clinic'), rate(2, 1, 1, 50, 50)),
  // The exists tests are aggregates without GROUP BY, so always true (measured): an area with no client gives 0 clients and NULL for the
  // rest, not the all-zero row.
  rSuite('rates-unknown-province', r12('Nowhere'), NULLS),
  rSuite('rates-unknown-district', r12('Southern', 'Nowhere'), NULLS),
  rSuite('rates-unknown-facility', r12('Southern', 'Choma', 'Nowhere'), NULLS),
  // R line 154: any other combination of parameters gives five integer zeros.
  rSuite('rates-district-alone', r12('', 'Choma'), ZEROS),
  rSuite('rates-facility-alone', r12('', '', 'Mongu Clinic'), ZEROS),
  rSuite('rates-province-facility', r12('Southern', '', 'Choma Clinic'), ZEROS),
  rSuite('rates-district-facility', r12('', 'Choma', 'Choma Clinic'), ZEROS),
  // The rank is over all time, so the window only picks the clients whose LATEST result falls in it (R lines 19-20).
  // June: John Phiri's 4000 (S0 U0), Late Fee's 5000 (S0 U0) and Edge One's 100 at local June 1 00:30 (S1 U1; UTC would put it in May).
  rSuite('rates-june', r12('', '', '', { from: '2026-06-01', to: '2026-06-30' }), rate(3, 1, 1, 33.333333333333, 33.333333333333)),
  rSuite('rates-june-lusaka', r12('Lusaka', '', '', { from: '2026-06-01', to: '2026-06-30' }), NULLS),
  // April: only Edge Four (local April 30 23:30 +02:00). Mary's April 3000 and Hope's April 100 are not their latest results.
  rSuite('rates-april', r12('', '', '', { from: '2026-04-01', to: '2026-04-30' }), rate(1, 1, 1, 100, 100)),
  rSuite('rates-empty-window', r12('', '', '', { from: '2025-01-01', to: '2025-01-31' }), NULLS),
  // R line 20: cast(ResultDate as date) between two dates, so the whole last day is in (not only midnight).
  rSuite('rates-last-day', r12('', '', '', { from: '2026-05-31', to: '2026-05-31' }), rate(1, 1, 0, 100, 0)),
  rSuite('rates-first-day', r12('', '', '', { from: '2026-05-01', to: '2026-05-01' }), rate(1, 1, 1, 100, 100)),
  // A date-only stamp is the day. The partial stamp '2026-05' (Partial Stamp) has no day: it is out and nothing raises.
  rSuite('rates-date-only', r12('', '', '', { from: '2026-05-20', to: '2026-05-20' }), rate(1, 1, 1, 100, 100)),
  // The floor (line 105): a result before 2017-01-01 is not in TND (Old Timer, local Dec 31 2016), and one on the local day Jan 1 2017 is (New Year).
  rSuite('rates-before-floor', r12('', '', '', { from: '2016-12-01', to: '2016-12-31' }), NULLS),
  rSuite('rates-on-floor', r12('', '', '', { from: '2017-01-01', to: '2017-01-01' }), rate(1, 1, 1, 100, 100)),
  // The ceiling (line 105): the future-dated 5000 is not in TND, so Future Self's newest result is the March one (100). Without the ceiling
  // her newest would be 2099 and March would hold no client.
  rSuite('rates-march-ceiling', r12('', '', '', { from: '2026-03-01', to: '2026-03-31' }), rate(1, 1, 1, 100, 100)),
  rSuite('rates-future-window', r12('', '', '', { from: '2099-01-01', to: '2099-12-31' }), NULLS),
  {
    name: 'rates-shape',
    count: 8,
    check() {
      const bad = [];
      if (!ratesQ) return ['query "Unique VL clients, 12-month rates" is missing'];
      const ids = ratesQ.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['province', 'district', 'facility', 'from', 'to'])) bad.push(`params: ${ids}`);
      const byId = Object.fromEntries(ratesQ.params.map((p) => [p.id, p]));
      for (const id of ['from', 'to']) if (!byId[id]?.required || byId[id].type !== 'text') bad.push(`${id} is a required text parameter (ruling 3)`);
      for (const id of ['province', 'district']) if (byId[id]?.required || byId[id]?.type !== 'select') bad.push(`${id} is an optional select`);
      if (byId.facility?.required || byId.facility?.type !== 'text') bad.push('facility is an optional text parameter');
      if (BANNED9.test(ratesQ.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (!/^\s*with\b/i.test(ratesQ.sql)) bad.push('does not start with "with"');
      return bad;
    },
  },
];

// ---- M: expected rows ----

const LM_COLUMNS = ['Year', 'Month', 'Laboratory', 'Requests', 'Tested'];
const labQ = queries().find((q) => q.name === 'VL requests and tests by lab and month');
const lm = (...v) => Object.fromEntries(LM_COLUMNS.map((c, i) => [c, v[i]]));
const lmSuite = (name, params, rows) => orderedSuite10(name, labQ?.sql ?? 'select 1', params, LM_COLUMNS, rows);
const NO_WINDOW = { from: '', to: '' };

// Requests by registered month (M lines 21-22, 48), Tested by authorised MONTH over all years (M lines 31-32).
// Lab T12X: May 2025 X1, X2 (2); March 2026 X9 ('T12x ') and X9b (2, shown as 'T12X', the smaller spelling); April X8 (1, one request in two OBR
// sets); May 2026 X3, X4, X5, X7 (4); June 2026 X6, registered at local June 1 00:30 (1). X10 (panel HIVPC), X11 (blank lab) and X12 (no report) are out.
// Tested by month for T12X: May X1 (2025), X3, X6 (authorised local May 1 00:30), X7 = 4 (X4 is not final, X5 is not HIVVL or HIVVC);
// June X2 = 1; March X9, X9b = 2; April X8 = 1. So May 2025 shows Tested 4, from four different years' worth of requests (the v1 quirk).
// Lab T12Y: March 2024 Y3 (1); March 2026 Y1 (and its twin 'T12-y1'), Y2, Y5 = 3 distinct requests; no date Y4 (1).
// Tested for T12Y in month 3: Y1, Y3, Y4 (2026-03-20), Y5 = 4 (Y2 was never authorised).
const LM_ALL = [
  lm(null, null, 'T12Y', 1, 0),
  lm(2024, 3, 'T12Y', 1, 4),
  lm(2025, 5, 'T12X', 2, 4),
  lm(2026, 3, 'T12X', 2, 2),
  lm(2026, 3, 'T12Y', 3, 4),
  lm(2026, 4, 'T12X', 1, 1),
  lm(2026, 5, 'T12X', 4, 4),
  lm(2026, 6, 'T12X', 1, 1),
];

const suitesLm = [
  // No window is v1. The R clients (blank lab) and the B requests (no lab) are not rows: no lab code.
  lmSuite('labmonth-all', NO_WINDOW, LM_ALL),
  // A window cuts the Requests (by registered local date) and not Tested, which keeps counting May of every year.
  lmSuite('labmonth-may-2026', { from: '2026-05-01', to: '2026-05-31' }, [lm(2026, 5, 'T12X', 4, 4)]),
  lmSuite('labmonth-mid-month', { from: '2026-05-13', to: '2026-05-31' }, [lm(2026, 5, 'T12X', 3, 4)]),
  // The local date of the stamp: X6 is registered at 2026-06-01T00:30+02:00 (June 1 locally, May 31 in UTC); X7 at 2026-05-31T23:30+02:00.
  lmSuite('labmonth-june-1', { from: '2026-06-01', to: '2026-06-01' }, [lm(2026, 6, 'T12X', 1, 1)]),
  lmSuite('labmonth-may-31', { from: '2026-05-31', to: '2026-05-31' }, [lm(2026, 5, 'T12X', 1, 4)]),
  lmSuite('labmonth-from-only', { from: '2026-06-01', to: '' }, [lm(2026, 6, 'T12X', 1, 1)]),
  lmSuite('labmonth-to-only', { from: '', to: '2024-12-31' }, [lm(2024, 3, 'T12Y', 1, 4)]),
  lmSuite('labmonth-empty-window', { from: '2030-01-01', to: '2030-12-31' }, []),
  {
    name: 'labmonth-shape',
    count: 6,
    check() {
      const bad = [];
      if (!labQ) return ['query "VL requests and tests by lab and month" is missing'];
      const ids = labQ.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['from', 'to'])) bad.push(`params: ${ids}`);
      for (const p of labQ.params) if (p.required || p.type !== 'text') bad.push(`${p.id} is an optional text parameter (v1 has no window)`);
      if (BANNED9.test(labQ.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (!/^\s*with\b/i.test(labQ.sql)) bad.push('does not start with "with"');
      return bad;
    },
  },
];

// ---- B: expected rows ----

const BD_COLUMNS = ['Year', 'Month', 'Total', 'Target Not Detected', '< 20 copies/ml', '< 1000 copies/ml', '>= 1000 copies/ml'];
const bandQ = queries().find((q) => q.name === 'VL result bands by month');
const bd = (...v) => Object.fromEntries(BD_COLUMNS.map((c, i) => [c, v[i]]));
const bdSuite = (name, params, rows) => orderedSuite10(name, bandQ?.sql ?? 'select 1', params, BD_COLUMNS, rows);

// March 2026 (the collected date, D line 25): 16 requests. Target Not Detected: Bb02 (coded LDL), Bb11 (coded 'ldl' with a number: D line 34 first) = 2.
// < 20: Bb01 (10), Bb07 (19.99), Bb08 (0), Bb12 (10), Bb18 (10, and its twin in another case: one request) = 5.
// < 1000 (20 up to 1000): Bb03 (20), Bb04 (999), Bb13 (HIVVD 500), Bb15 (a blank rejection code is not a rejection) = 4.
// >= 1000: Bb05 (1000, the boundary), Bb06 (1000.5), Bb12 (HIVVC 5000: one request in two bands) = 3.
// Unknown, counted in Total only: Bb09 (-1), Bb10 ('Pending'), Bb19 (no value). Out: Bb14 (rejected), Bb16 (panel HIVPC), Bb17 (observation XXXX).
const BD_ALL = [
  bd(null, null, 1, 0, 0, 0, 0),   // Bb24: no date at all, a < 20 result. v1 shows the Total and 0 in every band: its band subqueries match the date, never true for NULL
  bd(2025, 2, 1, 1, 0, 0, 0),      // Bb23: coded LDL
  bd(2026, 1, 1, 0, 0, 1, 0),      // Bb20: collected 2026-01-01T00:30+02:00, local Jan 1 (UTC Dec 31): 50
  bd(2026, 3, 16, 2, 5, 4, 3),
  bd(2026, 5, 1, 0, 0, 0, 1),      // Bb21: no collected date; received 2026-05-01T00:30+02:00 (local May 1) comes before the registered date (2025-02-01)
  bd(2026, 6, 1, 0, 1, 0, 0),      // Bb22: no collected or received date; registered 2026-06-01T00:30+02:00 (local June 1)
];

const suitesBd = [
  // No window is v1: every month. The R clients and M requests are rejected, so D drops them.
  bdSuite('bands-all', NO_WINDOW, BD_ALL),
  bdSuite('bands-march', { from: '2026-03-01', to: '2026-03-31' }, [bd(2026, 3, 16, 2, 5, 4, 3)]),
  // Local dates: Bb20 (Jan 1) is in a window ending January 1; the NULL-date row is out as soon as a window is given.
  bdSuite('bands-to-jan-1', { from: '', to: '2026-01-01' }, [BD_ALL[1], BD_ALL[2]]),
  bdSuite('bands-may-1', { from: '2026-05-01', to: '2026-05-01' }, [bd(2026, 5, 1, 0, 0, 0, 1)]),
  bdSuite('bands-from-june', { from: '2026-06-01', to: '' }, [bd(2026, 6, 1, 0, 1, 0, 0)]),
  bdSuite('bands-empty-window', { from: '2030-01-01', to: '2030-12-31' }, []),
  {
    name: 'bands-shape',
    count: 6,
    check() {
      const bad = [];
      if (!bandQ) return ['query "VL result bands by month" is missing'];
      const ids = bandQ.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['from', 'to'])) bad.push(`params: ${ids}`);
      for (const p of bandQ.params) if (p.required || p.type !== 'text') bad.push(`${p.id} is an optional text parameter (v1 has no window)`);
      if (BANNED9.test(bandQ.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (!/^\s*with\b/i.test(bandQ.sql)) bad.push('does not start with "with"');
      return bad;
    },
  },
];

// ---- The builder option: tndCte with rank: true (v1 TND.Rank, sp_GetPreviousVLResultforCohort2x lines 20-30) ----

// Every result of the R clients, with no window, and its visit number: row_number() over province, district, facility, panel, sex code,
// surname, first name and ART number (compared as SQL Server compares text), newest first. 44 results: A 28, B 7, C 2 (the partial stamp
// has no date and is out), D 5, F 2 (F03 and F04; F01 is before the 2017 floor and F02 is after the ceiling); the unmapped facility is out. Visit is 1 unless listed; ties (Tom Zulu) go to the smaller lab number.
const VISIT_NOT_1 = {
  'T12-A01a': 2, 'T12-A02a': 2, 'T12-A03a': 2, 'T12-A05a': 2, 'T12-A08b': 2, 'T12-A09a': 2, 'T12-A13a': 2, 'T12-B06a': 2,
};
const RANK_LABS = [
  ...['01a', '01b', '02a', '02b', '03a', '03b', '04', '05a', '05b', '06', '07a', '07b', '08a', '08b', '09a', '09b', '10', '11', '12', '13a', '13b',
    '14a', '14b', '15a', '15b', '16', '17', '18'].map((s) => `T12-A${s}`),
  ...['01', '02', '03', '04', '05', '06a', '06b'].map((s) => `T12-B${s}`),
  ...['01', '03'].map((s) => `T12-C${s}`),
  ...['01', '02', '03', '04', '05'].map((s) => `T12-D${s}`),
  'T12-F03', 'T12-F04',
];
const rankSuite = {
  name: 'tnd-rank-builder',
  setup: '',
  sql: `select 'tnd-rank-builder' || chr(9) || row_to_json(q)::text from (with ${tndCte('tn', { rank: true })}
select lab_id, panel_code, visit, result_date from tn order by lab_id) q;`,
  count: RANK_LABS.length + 8,
  check(got) {
    const failures = [];
    if (got.length !== RANK_LABS.length) failures.push(`expected ${RANK_LABS.length} rows, got ${got.length}`);
    for (const lab of RANK_LABS) {
      const row = got.find((g) => g.lab_id === lab);
      const want = VISIT_NOT_1[lab] ?? 1;
      if (!row) failures.push(`missing ${lab}`);
      else if (Number(row.visit) !== want) failures.push(`${lab}: expected visit ${want}, got ${row.visit}`);
    }
    // The panel is in the partition: Pan Els has a visit 1 in HIVVL and one in RTRI.
    const pan = got.filter((g) => g.lab_id.startsWith('T12-A14')).map((g) => `${g.panel_code}:${g.visit}`).sort();
    if (JSON.stringify(pan) !== JSON.stringify(['HIVVL:1', 'RTRI:1'])) failures.push(`Pan Els: expected HIVVL:1 and RTRI:1, got ${pan}`);
    // The window is gone: April and June results are rows (the default builder, windowed to May, would drop them).
    for (const lab of ['T12-A01a', 'T12-A02b', 'T12-B04']) if (!got.some((g) => g.lab_id === lab)) failures.push(`${lab} (outside May) must be a row`);
    // No date, or a partial one, and an unmapped facility: no row.
    for (const lab of ['T12-C02', 'T12-U01', 'T12-F01', 'T12-F02']) if (got.some((g) => g.lab_id === lab)) failures.push(`${lab} must not be a row`);
    // The M and B requests have no requesting facility: none of them is a row.
    if (got.some((g) => !g.lab_id.startsWith('T12-A') && !g.lab_id.startsWith('T12-B') && !g.lab_id.startsWith('T12-C') && !g.lab_id.startsWith('T12-D') && !g.lab_id.startsWith('T12-F'))) failures.push('a row outside the R clients');
    if (got.some((g) => g.lab_id.startsWith('T12-Bb'))) failures.push('a B request must not be a row');
    return failures;
  },
};
const rankShape = {
  name: 'tnd-rank-shape',
  count: 4,
  check() {
    const bad = [];
    if (tndCte('x', { rank: true }).includes('{{param.')) bad.push('rank: must not mention a parameter (no window)');
    if (!tndCte('x').includes('{{param.from}}')) bad.push('default: must keep the window');
    try { tndCte('x', { rank: true, orRegistered: true }); bad.push('rank with orRegistered must throw'); } catch { /* expected */ }
    if (!/visit/.test(tndCte('x', { rank: true })) || /visit/.test(tndCte('x'))) bad.push('only rank adds the visit column');
    return bad;
  },
};

// The rate cut is exact (SQL Server decimal(26,12): the quotient is cut, not rounded). Values measured on the local SQL Server with int variables:
// 203361 of 250002 is 81.343749250005 (a plain Postgres division and trunc gives ...006).
const rateCutSuite = caseSuite('rate-cut', ['top', 'n'], [
  { top: '203361', n: '250002', expected: 81.343749250005 },
  { top: '1', n: '3', expected: 33.333333333333 },
  { top: '2', n: '3', expected: 66.666666666666 },
  { top: '17', n: '24', expected: 70.833333333333 },
  { top: '8', n: '17', expected: 47.058823529411 },
  { top: '8', n: '13', expected: 61.538461538461 },
  { top: '24', n: '24', expected: 100 },
  { top: '0', n: '5', expected: 0 },
  { top: '5', n: '0', expected: null },
], rateCutSql('top::int', 'n::int'));

const suites12all = [rateCutSuite, ...suitesRates, ...suitesLm, ...suitesBd, rankSuite, rankShape];

export const groups = [{ name: 't2', suites }, { name: 't6', suites: suites6 }, { name: 't7', suites: [...suites7list, ...suites7trend] }, { name: 't8', suites: suites8 }, { name: 't9', suites: suites9 }, { name: 't10', suites: suites10 },
  { name: 't11', suites: [...suites11, ...suites12, ...suitesBuilders11] },
  { name: 't12', suites: suites12all }];

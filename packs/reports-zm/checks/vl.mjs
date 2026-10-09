// Check groups for the vl reports. Each task adds { name, suites } entries to this list.
//
// Group t2: the hivvl builder (v1 sp_update_HIVVLTable, Table__dbo_HIVVL.sql and
// sp_remove_dupsHIVVLEID). Fixture ids start with "t2-". Lab ids (lr.request_id) start with "T2-",
// "123-", "1E5-" or "12A-".
// "v1 line N" below means a line of StoredProcedure__dbo_sp_update_HIVVLTable.sql.

import { lit, inOrder } from '../../shared/pg-check.mjs';
import { ATTR_SYSTEM, hivvlCte } from '../zm-sql.mjs';
import { queries } from '../queries/vl.mjs';

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

export const groups = [{ name: 't2', suites }, { name: 't6', suites: suites6 }, { name: 't7', suites: [...suites7list, ...suites7trend] }, { name: 't8', suites: suites8 }];

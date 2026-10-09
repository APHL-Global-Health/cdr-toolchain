// Check groups for the vl reports. Each task adds { name, suites } entries to this list.
//
// Group t2: the hivvl builder (v1 sp_update_HIVVLTable, Table__dbo_HIVVL.sql and
// sp_remove_dupsHIVVLEID). Fixture ids start with "t2-". Lab ids (lr.request_id) start with "T2-",
// "123-", "1E5-" or "12A-".
// "v1 line N" below means a line of StoredProcedure__dbo_sp_update_HIVVLTable.sql.

import { lit, inOrder } from '../../shared/pg-check.mjs';
import { ATTR_SYSTEM, hivvlCte } from '../zm-sql.mjs';

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
const inDay = (r, from, to) => r.tested_date !== null && r.tested_date >= from && r.tested_date <= `${to}T23:59:59.999Z`;

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

export const groups = [{ name: 't2', suites }];

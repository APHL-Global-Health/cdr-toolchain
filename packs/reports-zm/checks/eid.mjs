// Check groups for the eid reports. Each task adds { name, suites } entries to this list.
//
// Group t3: the eid builder (v1 sp_update_EIDTable, Table__dbo_EID.sql and the eid half of
// sp_remove_dupsHIVVLEID). Fixture ids start with "t3-". Lab ids (lr.request_id) start with "T3-",
// "123-", "1E5-" or "12A-".
// "v1 line N" below means a line of StoredProcedure__dbo_sp_update_EIDTable.sql.

import { lit, inOrder } from '../../shared/pg-check.mjs';
import { ATTR_SYSTEM, eidCte } from '../zm-sql.mjs';
import { queries } from '../queries/eid.mjs';
import { epiFixture, facilityRows, orderedSuite as orderedSuite10, shapeSuite } from './epi-fixture.mjs';

// ---- Fixture builder ----

// The columns of Table__dbo_EID.sql in snake_case. v1 spells the fourth date "RecievedDate".
const COLUMNS = ['province', 'district', 'facility', 'lab_id', 'gender', 'age_group', 'tested_date',
  'positive', 'tat', 'tat_within14', 'run_date', 'recieved_date', 'registered_date', 'collected_date',
  'tested_at', 'referral', 'disalink', 'error', 'invalid', 'negative', 'indeterminate', 'poc', 'poc_w48h'];

const REQ_DEFAULTS = {
  panel: 'HIVPC', status: 'final', req: 'ZSOUT', sex: 'F', days: 100,
  authored: '2026-05-02T08:00:00Z', analysis: '2026-05-02T09:00:00Z',
  effective: '2026-05-01T07:00:00Z', issued: '2026-05-10T10:00:00Z', received: '2026-05-01T12:00:00Z',
  performer: 'LUS', results: [{ obs: 'HIVPR', text: 'Not Detected' }], attrs: [],
};
// What a default request produces. Written out by hand from the v1 text.
const D = {
  province: 'Southern', district: 'Choma', facility: 'Choma General Hospital', lab_id: null,
  gender: 'Female',
  age_group: '7 weeks to 6 Months',        // v1 line 22: AgeInDays 49 to 209
  tested_date: '2026-05-10T10:00:00Z',     // v1 line 30: AuthorisedDateTime
  positive: 0, error: 0, invalid: 0, indeterminate: 0,
  negative: 1,                             // v1 line 51: 'Not Detected' is on the negative list
  tat: 9,                                  // v1 line 73: datediff(dd, 05-01, 05-10)
  tat_within14: 1,                         // v1 line 74
  run_date: '2026-05-02T09:00:00Z', recieved_date: '2026-05-01T12:00:00Z',
  registered_date: '2026-05-02T08:00:00Z', collected_date: '2026-05-01T07:00:00Z',
  tested_at: 'LUS',
  referral: null,                          // ReceivingFacilityCode is not carried (ruling 7)
  disalink: 0,
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
const expected = [];
let seq = 0;

// One lab id with one or more request rows (v1 Requests rows sharing a RequestID). `want` is the
// eid row v1 would keep for the lab id (after sp_remove_dupsHIVVLEID), or null for no row.
function lab(labId, reqs, want) {
  for (const o of reqs) {
    const r = { ...REQ_DEFAULTS, ...o };
    const n = ++seq;
    const qid = `t3-q${pad(n)}`;
    let patientId = null;
    if (r.sex !== undefined && r.sex !== null) {
      patientId = `t3-p${pad(n)}`;
      patients.push(`(${lit(patientId)}, ${lit('P' + n)}, ${lit(r.sex)})`);
    }
    requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.authored)}, ${lit(r.analysis)}, ${lit(r.req)}, ${lit(patientId)}, ${num(r.days)})`);
    const sid = r.received ? `t3-s${pad(n)}` : null;
    if (sid) specimens.push(`(${lit(sid)}, ${lit(r.received)})`);
    reports.push(`(${lit(`t3-d${pad(n)}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.effective)}, ${lit(r.issued)}, ${lit(r.performer)}, ${lit(sid)})`);
    r.results.forEach((x, i) => {
      results.push(`(${lit(`t3-r${pad(n)}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${num(x.num)}, ${lit(x.cmp ?? null)})`);
    });
    r.attrs.forEach(([system, code, value], i) => {
      attrs.push(`(${lit(`t3-a${pad(n)}-${i + 1}`)}, ${lit(qid)}, ${lit(system)}, ${lit(code)}, ${lit(value)})`);
    });
  }
  if (want) expected.push({ ...D, ...want, lab_id: labId });
}

const ATTR = (code, value) => [ATTR_SYSTEM, code, value];
const res = (text) => [{ obs: 'HIVPR', text }];
const ZERO = { positive: 0, negative: 0, invalid: 0, error: 0, indeterminate: 0 };

// ---- The cases ----

// A default request: every column from the defaults.
lab('T3-BASIC', [{}], {});

// The filter (v1 lines 91-93): panel HIVPC, POCGH or POEID; observation HIVPC, HIVPR or PGHIV; final.
// IN compares ignoring case and trailing spaces, so 'poeid ' passes.
lab('T3-PANEL-POCGH', [{ panel: 'POCGH' }], {});
lab('T3-PANEL-POEID', [{ panel: 'poeid ' }], {});
lab('T3-OBS-HIVPC', [{ results: [{ obs: 'HIVPC', text: 'Positive' }] }], { positive: 1, negative: 0 });
// PGHIV makes it a POC test (line 75). Collected 219 hours before it was tested, so POCW48H is 0.
lab('T3-OBS-PGHIV', [{ results: [{ obs: 'PGHIV', text: 'Positive' }] }], { positive: 1, negative: 0, poc: 1, poc_w48h: 0 });
lab('T3-OBS-LOWER', [{ results: [{ obs: 'hivpr ', text: 'Positive' }] }], { positive: 1, negative: 0 });
lab('T3-OBS-OTHER', [{ results: [{ obs: 'HIVVL', text: 'Positive' }] }], null);   // v1 line 92
lab('T3-PANEL-VIRAL', [{ panel: 'HIVVL' }], null);                                // v1 line 91
lab('T3-STATUS-CANC', [{ status: 'cancelled', issued: null }], null);             // v1 line 93
lab('T3-STATUS-UNK', [{ status: 'unknown' }], null);
lab('T3-NOFINAL-ONE', [{ status: 'cancelled' }, { status: 'final', issued: '2026-05-12T10:00:00Z' }],
  { tested_date: '2026-05-12T10:00:00Z', tat: 11 });
// The requesting facility must be in the dictionary (v1 inner joins, lines 82-87).
lab('T3-UNMAPPED', [{ req: 'ZUNMP' }], null);
lab('T3-NOFAC', [{ req: 'ZNONE' }], null);
lab('T3-LUSAKA', [{ req: 'ZLUSA' }], { province: 'Lusaka', district: 'Lusaka', facility: 'Chilenje Clinic' });

// Result classes (v1 lines 43-72): five lists compared ignoring case and trailing spaces. A text on no
// list, a number, or no result at all sets none of them. No result filter exists (unlike hivvl).
const POS = ['Positive', 'Positive*', 'POS', 'Detected DBS', 'Detected', 'DET'];
const NEG = ['LDL', 'NDET', 'Negative*', 'Not Detected', 'Not Detected DBS', 'Negative', 'NDDB', 'NDT', 'NDTD'];
POS.forEach((t, i) => lab(`T3-POS-${i}`, [{ results: res(t) }], { ...ZERO, positive: 1 }));
NEG.forEach((t, i) => lab(`T3-NEG-${i}`, [{ results: res(t) }], { ...ZERO, negative: 1 }));
lab('T3-INV-1', [{ results: res('Invalid') }], { ...ZERO, invalid: 1 });
lab('T3-INV-2', [{ results: res('VALID') }], { ...ZERO, invalid: 1 });          // v1 line 57 says VALID
lab('T3-INV-INVAL', [{ results: res('INVAL') }], { ...ZERO });                  // not on the list: kept as v1
lab('T3-ERR', [{ results: res('Error') }], { ...ZERO, error: 1 });
lab('T3-IND-1', [{ results: res('Indeterminate') }], { ...ZERO, indeterminate: 1 });
lab('T3-IND-2', [{ results: res('NORES') }], { ...ZERO, indeterminate: 1 });
lab('T3-CASE', [{ results: res('detected dbs  ') }], { ...ZERO, positive: 1 });
lab('T3-CASE-NEG', [{ results: res('not detected dbs') }], { ...ZERO, negative: 1 });
lab('T3-OTHERTEXT', [{ results: res('Reactive') }], { ...ZERO });
lab('T3-NUMBER', [{ results: [{ obs: 'HIVPR', num: 5 }] }], { ...ZERO });
lab('T3-NORESULT', [{ results: [{ obs: 'HIVPR' }] }], { ...ZERO });
// Several results on one request give several source rows with one lab id. The dedupe keeps one; on a tie
// the port keeps the lowest result row id (v1 keeps either).
lab('T3-TWORES', [{ results: [{ obs: 'HIVPR', text: 'Positive' }, { obs: 'HIVPR', text: 'Negative' }] }], { ...ZERO, positive: 1 });

// The dedupe (sp_remove_dupsHIVVLEID lines 33-44): one row per lab id, the earliest tested date.
lab('T3-DUP', [
  { issued: '2026-05-12T10:00:00Z', results: res('Negative') },
  { panel: 'POEID', issued: '2026-05-08T10:00:00Z', authored: '2026-05-03T08:00:00Z', analysis: '2026-05-04T09:00:00Z',
    received: '2026-05-02T12:00:00Z', results: res('Positive') },
], { ...ZERO, positive: 1, tested_date: '2026-05-08T10:00:00Z', tat: 7, run_date: '2026-05-04T09:00:00Z',
  recieved_date: '2026-05-02T12:00:00Z', registered_date: '2026-05-03T08:00:00Z' });
// SQL Server sorts NULL first, so a row without a tested date wins. TAT is NULL, TATWithin14 is 0 (line 74 else).
lab('T3-DUPNULL', [{ issued: null }, { issued: '2026-05-14T10:00:00Z' }],
  { tested_date: null, tat: null, tat_within14: 0 });
// The earlier row is in April, outside the May window. It stays the only row, so the window shows nothing.
lab('T3-DUPOLD', [
  { effective: '2026-04-15T07:00:00Z', issued: '2026-04-20T10:00:00Z', authored: '2026-04-16T08:00:00Z',
    analysis: '2026-04-17T09:00:00Z', received: '2026-04-15T12:00:00Z' },
  { issued: '2026-05-15T10:00:00Z' },
], { tested_date: '2026-04-20T10:00:00Z', tat: 5, collected_date: '2026-04-15T07:00:00Z',
  registered_date: '2026-04-16T08:00:00Z', run_date: '2026-04-17T09:00:00Z', recieved_date: '2026-04-15T12:00:00Z' });
// The dedupe compares local times: 10:00+02:00 is 08:00 UTC, but local 10:00 is later than local 09:00.
lab('T3-DUPLOCAL', [
  { issued: '2026-05-12T09:00:00Z', results: res('Negative') },
  { issued: '2026-05-12T10:00:00+02:00', results: res('Positive') },
], { ...ZERO, negative: 1, tested_date: '2026-05-12T09:00:00Z', tat: 11 });

// A date-only tested date sorts as midnight of its date (v1 datetime), not as NULL: the 05-08 row wins over a
// 05-09 date-only row. The date-only row's result (Positive) would show positive 1 if it won.
lab('T3-DUPDATEONLY', [
  { issued: '2026-05-09', results: res('Positive') },
  { issued: '2026-05-08T10:00:00Z', results: res('Negative') },
], { tested_date: '2026-05-08T10:00:00Z', tat: 7 });

// The window edges (tested date 2026-05-01 to 2026-05-31). TAT counts date boundaries from 2026-04-28.
lab('T3-EDGE-IN1', [{ effective: '2026-04-28T10:00:00Z', issued: '2026-05-01T00:00:00Z' }],
  { tested_date: '2026-05-01T00:00:00Z', collected_date: '2026-04-28T10:00:00Z', tat: 3, tat_within14: 1 });
lab('T3-EDGE-IN2', [{ effective: '2026-04-28T10:00:00Z', issued: '2026-05-31T23:59:59Z' }],
  { tested_date: '2026-05-31T23:59:59Z', collected_date: '2026-04-28T10:00:00Z', tat: 33, tat_within14: 0 });
lab('T3-EDGE-OUT1', [{ effective: '2026-04-28T10:00:00Z', issued: '2026-04-30T23:59:59Z' }],
  { tested_date: '2026-04-30T23:59:59Z', collected_date: '2026-04-28T10:00:00Z', tat: 2, tat_within14: 1 });
lab('T3-EDGE-OUT2', [{ effective: '2026-04-28T10:00:00Z', issued: '2026-06-01T00:00:00Z' }],
  { tested_date: '2026-06-01T00:00:00Z', collected_date: '2026-04-28T10:00:00Z', tat: 34, tat_within14: 0 });
// Local stamps: the window is on the local date. 00:30+02:00 on 05-01 is in (UTC would be 04-30);
// 00:30+02:00 on 06-01 is out (UTC would be 05-31).
lab('T3-EDGE-TZ-IN', [{ effective: '2026-04-28T10:00:00+02:00', issued: '2026-05-01T00:30:00+02:00' }],
  { tested_date: '2026-05-01T00:30:00+02:00', collected_date: '2026-04-28T10:00:00+02:00', tat: 3, tat_within14: 1 });
lab('T3-EDGE-TZ-OUT', [{ effective: '2026-04-28T10:00:00+02:00', issued: '2026-06-01T00:30:00+02:00' }],
  { tested_date: '2026-06-01T00:30:00+02:00', collected_date: '2026-04-28T10:00:00+02:00', tat: 34, tat_within14: 0 });

// Age groups (v1 lines 19-29), by AgeInDays. A negative or missing age is NULL.
const AGES = [[0, 'At Birth'], [6, 'At Birth'], [7, '1 - 6 Weeks'], [48, '1 - 6 Weeks'], [49, '7 weeks to 6 Months'],
  [209, '7 weeks to 6 Months'], [210, '7 - 9 Months'], [299, '7 - 9 Months'], [300, '10 - 12 Months'],
  [389, '10 - 12 Months'], [390, '13 - 18 Months'], [569, '13 - 18 Months'], [570, '19 - 24 Months'],
  [749, '19 - 24 Months'], [750, '> 2 years'], [3000, '> 2 years'], [-1, null], [null, null]];
AGES.forEach(([days, group]) => lab(`T3-AGE-${days}`, [{ days }], { age_group: group }));

// Sex (v1 lines 12-18): F, M, I, U only; anything else, a missing value and a missing patient give NULL.
// The compare ignores case and trailing spaces.
const SEXES = [['F', 'Female'], ['M', 'Male'], ['I', 'Indeterminate'], ['U', 'Unknown'], ['X', null], ['O', null],
  ['N', null], ['m ', 'Male'], ['i', 'Indeterminate'], ['', null]];
SEXES.forEach(([sex, gender], i) => lab(`T3-SEX-${i}`, [{ sex }], { gender }));
lab('T3-SEX-NOPATIENT', [{ sex: null }], { gender: null });

// TestedAt (v1 lines 35-38). The testing code is the performer. ReceivingFacilityCode is not carried, so a blank
// testing code gives NULL. A 3-letter ZU code other than ZUE and ZUA becomes ZUL. SQL Server LIKE ignores trailing
// blanks in the matched text, so 'ZUB ' also becomes ZUL.
const TESTED_AT = [[null, null], ['', null], ['  ', null], ['ZUB', 'ZUL'], ['zub', 'ZUL'], ['ZU1', 'ZUL'],
  ['ZUA', 'ZUA'], ['zue', 'zue'], ['ZUEE', 'ZUEE'], ['ZU', 'ZU'], ['ZUB ', 'ZUL']];
TESTED_AT.forEach(([performer, testedAt], i) => lab(`T3-TA-${i}`, [{ performer }], { tested_at: testedAt }));

// TAT counts date boundaries, not 24-hour periods (v1 line 73). 14 days is within, 15 is not (line 74).
lab('T3-TAT-MID', [{ effective: '2026-05-01T23:30:00Z', issued: '2026-05-02T00:10:00Z' }],
  { tested_date: '2026-05-02T00:10:00Z', collected_date: '2026-05-01T23:30:00Z', tat: 1, tat_within14: 1 });
lab('T3-TAT-14', [{ effective: '2026-05-01T10:00:00Z', issued: '2026-05-15T01:00:00Z' }],
  { tested_date: '2026-05-15T01:00:00Z', collected_date: '2026-05-01T10:00:00Z', tat: 14, tat_within14: 1 });
lab('T3-TAT-15', [{ effective: '2026-05-01T10:00:00Z', issued: '2026-05-16T01:00:00Z' }],
  { tested_date: '2026-05-16T01:00:00Z', collected_date: '2026-05-01T10:00:00Z', tat: 15, tat_within14: 0 });
// Dates are local (DISA writes local wall time with its offset): TAT takes each date from the stamp's own text.
// In UTC the first row would be 04-30 to 05-15 (15 days, not within 14); v1 gives 14 and 1.
lab('T3-TZ-14', [{ effective: '2026-05-01T01:00:00+02:00', issued: '2026-05-15T10:00:00+02:00' }],
  { tested_date: '2026-05-15T10:00:00+02:00', collected_date: '2026-05-01T01:00:00+02:00', tat: 14, tat_within14: 1 });
// Local 05-03 to 05-04 is 1 day; in UTC it is 05-02 to 05-04 (2 days).
lab('T3-TZ-ORD', [{ effective: '2026-05-03T00:30:00+02:00', issued: '2026-05-04T23:45:00+02:00' }],
  { tested_date: '2026-05-04T23:45:00+02:00', collected_date: '2026-05-03T00:30:00+02:00', tat: 1, tat_within14: 1 });
// A date-only stamp still gives its date. A partial stamp ('2026-07') is not a date: TAT is NULL and the query does not fail.
lab('T3-TAT-DATEONLY', [{ effective: '2026-05-05' }], { collected_date: '2026-05-05', tat: 5, tat_within14: 1 });
lab('T3-TAT-PARTIAL', [{ effective: '2026-07' }], { collected_date: '2026-07', tat: null, tat_within14: 0 });
lab('T3-TAT-PARTIAL-TESTED', [{ issued: '2026-07' }], { tested_date: '2026-07', tat: null, tat_within14: 0 });
lab('T3-TAT-NOCOL', [{ effective: null }], { collected_date: null, tat: null, tat_within14: 0 });

// POC (v1 line 75): observation PGHIV, a numeric testing code, or a lab id whose first 3 characters are numeric.
// POCW48H (line 76) counts hour boundaries, so 24 boundaries pass even when 24h40m passed. It tests 24, not 48.
lab('T3-POC-PERF', [{ performer: '4567', effective: '2026-05-10T08:10:00Z', issued: '2026-05-11T08:50:00Z' }],
  { tested_date: '2026-05-11T08:50:00Z', collected_date: '2026-05-10T08:10:00Z', tested_at: '4567', tat: 1, poc: 1, poc_w48h: 1 });
lab('T3-POC-25H', [{ performer: '4567', effective: '2026-05-10T08:50:00Z', issued: '2026-05-11T09:10:00Z' }],
  { tested_date: '2026-05-11T09:10:00Z', collected_date: '2026-05-10T08:50:00Z', tested_at: '4567', tat: 1, poc: 1, poc_w48h: 0 });
lab('T3-POC-23H', [{ performer: '12', effective: '2026-05-10T08:30:00Z', issued: '2026-05-11T07:55:00Z' }],
  { tested_date: '2026-05-11T07:55:00Z', collected_date: '2026-05-10T08:30:00Z', tested_at: '12', tat: 1, poc: 1, poc_w48h: 1 });
lab('T3-POC-NOCOL', [{ performer: '4567', effective: null }],
  { collected_date: null, tested_at: '4567', tat: null, tat_within14: 0, poc: 1, poc_w48h: 0 });
// Hours between local stamps with an offset: the offset cancels. 05-02 22:30 UTC to 05-04 21:45 UTC is 47 boundaries.
lab('T3-POC-TZ', [{ performer: '4567', effective: '2026-05-03T00:30:00+02:00', issued: '2026-05-04T23:45:00+02:00' }],
  { tested_date: '2026-05-04T23:45:00+02:00', collected_date: '2026-05-03T00:30:00+02:00', tested_at: '4567', tat: 1, poc: 1, poc_w48h: 0 });
// Across local midnight but 21 hour boundaries: 05-10 21:30 UTC to 05-11 18:40 UTC.
lab('T3-POC-TZ-NEAR', [{ performer: '4567', effective: '2026-05-10T23:30:00+02:00', issued: '2026-05-11T20:40:00+02:00' }],
  { tested_date: '2026-05-11T20:40:00+02:00', collected_date: '2026-05-10T23:30:00+02:00', tested_at: '4567', tat: 1, poc: 1, poc_w48h: 1 });
// POC reads the result row that is kept: HIVPR (lowest result id) wins the tie, so PGHIV on the second row is not seen.
lab('T3-POC-ROW', [{ results: [{ obs: 'HIVPR', text: 'Positive' }, { obs: 'PGHIV', text: 'Positive' }] }], { ...ZERO, positive: 1 });
const SAME_DAY = { effective: '2026-05-10T10:00:00Z', issued: '2026-05-10T20:00:00Z' };
const SAME_DAY_WANT = { tested_date: '2026-05-10T20:00:00Z', collected_date: '2026-05-10T10:00:00Z', tat: 0 };
lab('123-LAB', [SAME_DAY], { ...SAME_DAY_WANT, poc: 1, poc_w48h: 1 });
lab('1E5-LAB', [SAME_DAY], { ...SAME_DAY_WANT, poc: 1, poc_w48h: 1 });   // ISNUMERIC('1E5') is 1
lab('12A-LAB', [SAME_DAY], { ...SAME_DAY_WANT, poc: 0, poc_w48h: 0 });
lab('T3-NOPOC-FAST', [SAME_DAY], { ...SAME_DAY_WANT, poc: 0, poc_w48h: 0 });

// Disalink (v1 lines 41-42): a pre-registration facility code, or a referring request id that starts with a
// known facility code (5 characters, not a number). Unlike hivvl, a referring id that starts with digits does
// not count.
const PREREG = 'prereg-registration-facility';
const REFERRING = 'referring-request-id';
lab('T3-DL-PREREG', [{ attrs: [ATTR(PREREG, 'ZSOUT')] }], { disalink: 1 });
lab('T3-DL-PREREG-BLANK', [{ attrs: [ATTR(PREREG, '  ')] }], { disalink: 0 });
lab('T3-DL-REF-FAC', [{ attrs: [ATTR(REFERRING, 'ZSOUT-0001')] }], { disalink: 1 });
lab('T3-DL-REF-LOWER', [{ attrs: [ATTR(REFERRING, 'zsout1')] }], { disalink: 1 });
lab('T3-DL-REF-UNKNOWN', [{ attrs: [ATTR(REFERRING, 'ZNONE-1')] }], { disalink: 0 });
lab('T3-DL-REF-UNMAPPED', [{ attrs: [ATTR(REFERRING, 'ZUNMP-1')] }], { disalink: 0 });
lab('T3-DL-REF-NUM3', [{ attrs: [ATTR(REFERRING, '123456')] }], { disalink: 0 });    // hivvl would say 1
lab('T3-DL-REF-NUM2', [{ attrs: [ATTR(REFERRING, '12')] }], { disalink: 0 });
lab('T3-DL-REF-NUMFAC', [{ attrs: [ATTR(REFERRING, '12345-9')] }], { disalink: 0 }); // known code, but numeric
lab('T3-DL-WRONGSYS', [{ attrs: [['urn:other', REFERRING, 'ZSOUT-1']] }], { disalink: 0 });
lab('T3-DL-BOTH', [{ attrs: [ATTR(PREREG, 'ZSOUT'), ATTR(REFERRING, 'ZNONE-1')] }], { disalink: 1 });

const SETUP = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t3-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t3-fm2', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('t3-fm3', '', '', 'ZUNMP', null, null, null, null),
  ('t3-fm4', '', '', '12345', 'reg-n', 'Numeric Code Clinic', 'Southern', 'Choma');
insert into patients (id, surname, sex) values ${patients.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_days) values ${requests.join(',\n  ')};
insert into specimens (id, received_time) values ${specimens.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, specimen_id) values ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator) values ${results.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${attrs.join(',\n  ')};`;

// ---- Suites ----

const bind = (sqlText, params) => Object.entries(params)
  .reduce((s, [k, v]) => s.replaceAll(`{{param.${k}}}`, `'${v.replace(/'/g, "''")}'`), sqlText);

// A suite over `select * from <cte>`: column order, then the exact row set with its count.
function builderSuite(name, setup, cteSql, rows) {
  const key = (r) => JSON.stringify(COLUMNS.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `with ${cteSql} select ${lit(name)} || chr(9) || row_to_json(q)::text from (select * from ed) q;`,
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
  builderSuite('eid-all', SETUP, eidCte('ed'), wantRows),
  builderSuite('eid-window', '', bind(eidCte('ed', { from: 'from', to: 'to' }), { from: '2026-05-01', to: '2026-05-31' }),
    wantRows.filter((r) => inDay(r, '2026-05-01', '2026-05-31'))),
  // Other parameter names, and a one-day window.
  builderSuite('eid-window-names', '', bind(eidCte('ed', { from: 'start', to: 'end' }), { start: '2026-05-08', end: '2026-05-08' }),
    wantRows.filter((r) => inDay(r, '2026-05-08', '2026-05-08'))),
  {
    name: 'eid-shape',
    count: 5,
    check() {
      const text = eidCte('anyname');
      const bad = [];
      if (!text.startsWith('anyname as (')) bad.push(`must start with "anyname as (": ${text.slice(0, 30)}`);
      if (eidCte('x').includes('{{param.')) bad.push('no window: must not mention a parameter');
      for (const half of [{ from: 'a' }, { to: 'b' }]) {
        try { eidCte('x', half); bad.push(`half a window ${JSON.stringify(half)} must throw`); } catch { /* expected */ }
      }
      const windowed = eidCte('x', { from: 'a', to: 'b' });
      if (!windowed.includes('{{param.a}}') || !windowed.includes('{{param.b}}')) bad.push('window: must use the given parameter names');
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(text.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      return bad;
    },
  },
];

// ============================================================================================
// Group t10-eid: "EID testing summary by province / by district / by facility" (v1 sp_getSummaryTestEpiDataEID, "P" below,
// sp_getSummaryTestEpiDataEIDDistrict, "D", sp_getSummaryTestEpiDataEIDFacility, "F"). Fixture ids start with "t10e-"; lab ids
// with "T10E-". "P line N" is a line of StoredProcedure__dbo_sp_getSummaryTestEpiDataEID.sql, "D line N" of ...EIDDistrict.sql,
// "F line N" of ...EIDFacility.sql. Expected rows are worked out by hand from the v1 text. Window: 2026-05-01 to 2026-05-31.
// The three procedures share every rule; they differ in the group column and the area filters. All end the window at `to` 00:00:00
// (no extra day). The joins hang off the TESTS part (P lines 106-113), the opposite of the VL procedures.
//
// The facilities (fixture codes ZT10x):
//   A  Choma General Hospital, Southern/Choma: every result text and turnaround case
//   B  Choma Clinic, Southern/Choma: window edges (local time, +02:00 stamps)
//   H  Choma Clinic, Southern/Choma: same name as B, so the facility level merges them
//   C  Monze Clinic, Southern/Monze: registered only (no tests: dropped, unlike the VL procedures)
//   N  Nowhere Clinic, Southern, no district
//   D  Chilenje Clinic, Lusaka/Lusaka;  F  Kabwata Clinic, Lusaka/Lusaka: tests but no registration in the window (kept)
//   G  Other Choma Clinic, Central/Choma: a district with the same name in another province
//   U  not in the register
// ============================================================================================

const F10E = epiFixture('t10e', {
  panel: 'HIVPC', obs: 'HIVPC', status: 'final', req: 'ZT10A',
  auth: '2026-05-02T08:00:00Z', ana: '2026-05-03T09:00:00Z', eff: '2026-05-01T07:00:00Z', iss: '2026-05-10T10:00:00Z',
  noReport: false, results: [{ text: 'Negative' }],
});
const q10e = F10E.req;
// Facility A. Default turnaround 9 days (05-01 to 05-10).
q10e('T10E-A01', { results: [{ text: 'Not Detected DBS' }] });                                 // test, negative
q10e('T10E-A02', { iss: '2026-05-12T10:00:00Z', results: [{ text: 'Negative' }] });          // negative; turnaround 11
q10e('T10E-A03', { results: [{ text: 'LDL' }] });                                             // negative
q10e('T10E-A04', { results: [{ text: 'Detected DBS' }] });                                    // positive
q10e('T10E-A05', { results: [{ text: 'Positive*' }] });                                       // positive
q10e('T10E-A06', { results: [{ text: 'POS' }] });                                             // positive
q10e('T10E-A07', { results: [{ text: 'Indeterminate' }] });                                   // a test (P has no text filter), neither split
q10e('T10E-A08', { results: [{ text: 'Invalid' }] });                                         // a test, neither split
q10e('T10E-A09', { status: 'cancelled', eff: null, iss: null, results: [] });               // registered only
q10e('T10E-A10', { results: [{ obs: 'HIVPR', text: 'Negative' }] });                         // registered; observation is not HIVPC: no test
q10e('T10E-A11', { panel: 'HIVVL', results: [{ text: 'Negative' }] });                       // other panel: nowhere
q10e('T10E-A12', { status: 'preliminary', results: [{ text: 'Negative' }] });                // registered; not final
q10e('T10E-A13', { eff: null, results: [{ text: 'Negative' }] });                             // a test, negative; no collection date: no turnaround
q10e('T10E-A14', { eff: '2026-01-01T07:00:00Z', results: [{ text: 'Positive' }] });          // a test, positive; 129 days: no turnaround
q10e('T10E-A15', { eff: '2026-02-09T07:00:00Z', results: [{ text: 'Negative' }] });          // negative; 90 days exactly: turnaround in
q10e('T10E-A16', { eff: '2026-05-01T23:30:00+02:00', iss: '2026-05-03T00:30:00+02:00', results: [{ text: 'Not Detected DBS' }] }); // local dates 05-01 and 05-03: 2 days (UTC would say 1)
q10e('T10E-A17', { results: [{ text: 'negative' }] });                                       // the list ignores case
q10e('T10E-A18', { results: [{ text: 'pos ' }] });                                            // and trailing spaces: positive
q10e('T10E-A19', { iss: '2026-05-08T10:00:00Z', results: [{ text: 'Negative' }, { text: 'Positive' }] }); // one test, in both splits; two turnaround rows of 7
// Facility B: the window edges. Registered (authored) edges first, no report.
const noRepE = { noReport: true, ana: null, results: [] };
q10e('T10E-B01', { req: 'ZT10B', auth: '2026-05-31T23:30:00+02:00', ...noRepE });          // local 05-31 23:30: out (the end is 05-31 00:00)
q10e('T10E-B02', { req: 'ZT10B', auth: '2026-06-01T00:00:00+02:00', ...noRepE });          // out
q10e('T10E-B03', { req: 'ZT10B', auth: '2026-06-01T00:00:01Z', ...noRepE });               // out
q10e('T10E-B04', { req: 'ZT10B', auth: '2026-05-31T00:00:00+02:00', ...noRepE });          // exactly 05-31 00:00 (UTC 05-30 22:00): in
q10e('T10E-B05', { req: 'ZT10B', auth: '2026-05-01T00:30:00+02:00', ...noRepE });          // local 05-01 (UTC 04-30): in
q10e('T10E-B06', { req: 'ZT10B', auth: '2026-04-30T23:30:00+02:00', ...noRepE });          // out
// Analysed edges (registered 05-02, so each also counts as a registration).
q10e('T10E-B07', { req: 'ZT10B', ana: '2026-05-31T23:30:00+02:00', iss: '2026-05-02T10:00:00Z', results: [{ text: 'Positive' }] }); // out
q10e('T10E-B08', { req: 'ZT10B', ana: '2026-06-01T00:00:00+02:00', iss: '2026-05-04T10:00:00Z', results: [{ text: 'Negative' }] }); // out of May; in June
q10e('T10E-B09', { req: 'ZT10B', ana: '2026-05-31T00:00:00+02:00', iss: '2026-05-06T10:00:00Z', results: [{ text: 'Negative' }] }); // in; turnaround 5
q10e('T10E-B10', { req: 'ZT10B', ana: '2026-04-30T23:30:00+02:00', results: [{ text: 'Positive' }] });                           // out
q10e('T10E-B11', { req: 'ZT10B', ana: '2026-05-01T00:30:00+02:00', iss: '2026-05-01T20:00:00Z', results: [{ text: 'Positive' }] }); // in; turnaround 0
q10e('T10E-B12', { req: 'ZT10B', ana: '2026-06-01T00:00:01Z', results: [{ text: 'Negative' }] });                                // out of May; in June
q10e('T10E-H01', { req: 'ZT10H', results: [{ text: 'Negative' }] });
q10e('T10E-C01', { req: 'ZT10C', ...noRepE });                                              // registered, no tests: dropped (the joins hang off tests)
q10e('T10E-N01', { req: 'ZT10N', results: [{ text: 'Negative' }] });
q10e('T10E-D01', { req: 'ZT10D', results: [{ text: 'Negative' }] });
q10e('T10E-F01', { req: 'ZT10F', auth: '2026-04-20T08:00:00Z', results: [{ text: 'Positive' }] }); // tests, no registration in May: kept, Registrations NULL
q10e('T10E-G01', { req: 'ZT10G', results: [{ text: 'Positive' }] });
q10e('T10E-U01', { req: 'ZT10U', results: [{ text: 'Negative' }] });                       // not in the register: dropped

const SETUP10E = F10E.setup(facilityRows('t10e', [
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

const COUNTS10E = ['Registrations', 'Tests', 'Negative', 'Positive', 'TATTests', 'TATpre'];
const rowE = (first) => {
  const columns = [first, ...COUNTS10E];
  return (...values) => Object.fromEntries(columns.map((c, i) => [c, values[i]]));
};
const pE = rowE('Province');
const dE = rowE('District');
const fE = rowE('Facility');
const eidSummary = (name) => queries().find((q) => q.name === name);
const provE = eidSummary('EID testing summary by province');
const distE = eidSummary('EID testing summary by district');
const facE = eidSummary('EID testing summary by facility');
const MAY_E = { from: '2026-05-01', to: '2026-05-31' };
const colsE = (first) => [first, ...COUNTS10E];

const suites10e = [
  // Province (P). Southern = A + B + H + N: registrations 18 + 8 (B04, B05, B07-B12) + 1 + 1 = 28; tests 15 + 2 + 1 + 1 = 19; negative 8 + 1 + 1 + 1 = 11;
  // positive 6 + 1 = 7. Turnaround: A has 14 rows summing 198, average 14.1 cut to 14, 13 requests, 182; B rows 5 and 0 average 2 (2.5 cut), 2 requests, 4;
  // H 9; N 9: TATTests 13 + 2 + 1 + 1 = 17, TATpre 182 + 4 + 9 + 9 = 204.
  // Lusaka = D + F: F has tests but no registration, and stays (the joins hang off tests): registrations 1, tests 2.
  // C (Monze) is registered only, so it has no row at all. U is not in the register.
  orderedSuite10('province-may', provE?.sql ?? 'select 1', MAY_E, colsE('Province'), [
    pE('Central', 1, 1, null, 1, 1, 9),
    pE('Lusaka', 1, 2, 1, 1, 2, 18),
    pE('Southern', 28, 19, 11, 7, 17, 204),
  ], SETUP10E),
  // One day: no extra day (the window is 05-31 00:00 to 05-31 00:00): B04 registered and B09 analysed at exactly that time.
  orderedSuite10('province-one-day-end', provE?.sql ?? 'select 1', { from: '2026-05-31', to: '2026-05-31' }, colsE('Province'), [pE('Southern', 1, 1, 1, null, 1, 5)]),
  orderedSuite10('province-june', provE?.sql ?? 'select 1', { from: '2026-06-01', to: '2026-06-30' }, colsE('Province'), [pE('Southern', 2, 2, 2, null, 2, 12)]),
  orderedSuite10('province-empty-window', provE?.sql ?? 'select 1', { from: '2025-01-01', to: '2025-01-31' }, colsE('Province'), []),
  // District (D), Southern. Choma = A + B + H: registrations 27, tests 18, negative 10, positive 7, turnaround 182 + 4 + 9 = 195 over 16. Monze has no tests: no row.
  // N has no district: a NULL district row, first.
  orderedSuite10('district-southern', distE?.sql ?? 'select 1', { province: 'Southern', ...MAY_E }, colsE('District'), [
    dE(null, 1, 1, 1, null, 1, 9),
    dE('Choma', 27, 18, 10, 7, 16, 195),
  ]),
  orderedSuite10('district-name-fold', distE?.sql ?? 'select 1', { province: 'southern  ', ...MAY_E }, colsE('District'), [
    dE(null, 1, 1, 1, null, 1, 9),
    dE('Choma', 27, 18, 10, 7, 16, 195),
  ]),
  orderedSuite10('district-central', distE?.sql ?? 'select 1', { province: 'Central', ...MAY_E }, colsE('District'), [dE('Choma', 1, 1, null, 1, 1, 9)]),
  orderedSuite10('district-lusaka', distE?.sql ?? 'select 1', { province: 'Lusaka', ...MAY_E }, colsE('District'), [dE('Lusaka', 1, 2, 1, 1, 2, 18)]),
  orderedSuite10('district-unknown', distE?.sql ?? 'select 1', { province: 'Nowhere', ...MAY_E }, colsE('District'), []),
  orderedSuite10('district-june', distE?.sql ?? 'select 1', { province: 'Southern', from: '2026-06-01', to: '2026-06-30' }, colsE('District'), [dE('Choma', 2, 2, 2, null, 2, 12)]),
  // Facility (F): province and district both. Choma Clinic merges B and H.
  orderedSuite10('facility-southern-choma', facE?.sql ?? 'select 1', { province: 'Southern', district: 'Choma', ...MAY_E }, colsE('Facility'), [
    fE('Choma Clinic', 9, 3, 2, 1, 3, 13),
    fE('Choma General Hospital', 18, 15, 8, 6, 13, 182),
  ]),
  orderedSuite10('facility-name-fold', facE?.sql ?? 'select 1', { province: 'SOUTHERN ', district: 'choma ', ...MAY_E }, colsE('Facility'), [
    fE('Choma Clinic', 9, 3, 2, 1, 3, 13),
    fE('Choma General Hospital', 18, 15, 8, 6, 13, 182),
  ]),
  // The same district name in another province does not mix here (F filters on both).
  orderedSuite10('facility-central-choma', facE?.sql ?? 'select 1', { province: 'Central', district: 'Choma', ...MAY_E }, colsE('Facility'), [fE('Other Choma Clinic', 1, 1, null, 1, 1, 9)]),
  orderedSuite10('facility-lusaka', facE?.sql ?? 'select 1', { province: 'Lusaka', district: 'Lusaka', ...MAY_E }, colsE('Facility'), [
    fE('Chilenje Clinic', 1, 1, 1, null, 1, 9),
    fE('Kabwata Clinic', null, 1, null, 1, 1, 9),
  ]),
  orderedSuite10('facility-wrong-province', facE?.sql ?? 'select 1', { province: 'Southern', district: 'Lusaka', ...MAY_E }, colsE('Facility'), []),
  orderedSuite10('facility-registered-only-district', facE?.sql ?? 'select 1', { province: 'Southern', district: 'Monze', ...MAY_E }, colsE('Facility'), []),
  shapeSuite('province-shape', provE, ['from', 'to'], ['text', 'text']),
  shapeSuite('district-shape', distE, ['from', 'to', 'province'], ['text', 'text', 'select']),
  shapeSuite('facility-shape', facE, ['from', 'to', 'province', 'district'], ['text', 'text', 'select', 'select']),
];

// ============================================================================================
// Group t13: "EID dashboard summary" (v1 sp_dash_getEID_V2, merging sp_dash_getEID), "EID dashboard by facility,
// sex and age" (v1 sp_dash_getEID_v2_List) and "EID monthly trend" (v1 sp_dash_getMonthlyEIDTrend). Fixture ids
// start with "t13-"; lab ids start with "T13-" (one is "123-B3", a POC lab id). "V2 line N" is a line of
// StoredProcedure__dbo_sp_dash_getEID_V2.sql, "List line N" of ...getEID_v2_List.sql, "Trend line N" of
// ...getMonthlyEIDTrend.sql. Expected rows are worked out by hand from the v1 text.
//
// Windows. V2 (line 21, 35): the end date moves one day forward and cast(TestedDate as date) is compared, so the
// whole day after `to` counts, on the LOCAL date. List (line 21, 33): the end date moves one day forward and the
// datetime TestedDate is compared with no cast, so a test counts from `from` 00:00:00 up to and including
// (to + 1 day) 00:00:00. Trend (lines 20-22): cast to date, no extra day.
// ============================================================================================

const P13 = [];
const R13 = [];
const S13 = [];
const D13 = [];
const L13 = [];
let n13 = 0;
const nz13 = (v) => (v === null || v === undefined ? 'null' : String(v));
// One lab id: a request with one result and one report. `o`: req (facility code), sex (null: no patient), age (days),
// obs, text (the result), coll (collected), iss (authorised), recv (received; none when null), perf (testing code),
// panel, status.
function lab13(labId, o) {
  const k = String(++n13).padStart(2, '0');
  const qid = `t13-q${k}`;
  let pid = null;
  if (o.sex !== null && o.sex !== undefined) {
    pid = `t13-p${k}`;
    P13.push(`(${lit(pid)}, ${lit('P' + k)}, ${lit(o.sex)})`);
  }
  R13.push(`(${lit(qid)}, ${lit(labId)}, ${lit(o.panel ?? 'HIVPC')}, '2026-05-02T08:00:00Z', '2026-05-02T09:00:00Z', ${lit(o.req)}, ${lit(pid)}, ${nz13(o.age)})`);
  const sid = o.recv ? `t13-s${k}` : null;
  if (sid) S13.push(`(${lit(sid)}, ${lit(o.recv)})`);
  D13.push(`(${lit(`t13-d${k}`)}, ${lit(qid)}, ${lit(o.status ?? 'final')}, ${lit(o.coll ?? null)}, ${lit(o.iss ?? null)}, ${lit(o.perf ?? 'LUS')}, ${lit(sid)})`);
  L13.push(`(${lit(`t13-r${k}`)}, ${lit(qid)}, ${lit(o.obs ?? 'HIVPR')}, ${lit(o.text ?? null)}, null, null)`);
}

const CHO13 = 'ZSOUT';   // Southern / Choma / Choma General Hospital
const CL213 = 'ZCHO2';   // Southern / Choma / Choma Clinic
const MAZ13 = 'ZMAZA';   // Southern / Mazabuka / Mazabuka Hospital
const LUS13 = 'ZLUSA';   // Lusaka / Lusaka / Chilenje Clinic
const KAF13 = 'ZKAFU';   // Lusaka / Kafue / Kafue District Hospital
const C1 = '2026-05-01T07:00:00Z';

// Each comment gives: gender, age group, result class, tat (local dates), POC, POC within 24 hours (V2 line 76 of
// sp_update_EIDTable), and for the List the local days from received to tested.
// Choma General Hospital.
lab13('T13-A01', { req: CHO13, sex: 'F', age: 3, text: 'Positive', coll: C1, iss: '2026-05-10T10:00:00Z', recv: '2026-05-02T09:00:00Z' });   // Female, At Birth, positive, tat 9, not POC; received 8 days before
lab13('T13-A02', { req: CHO13, sex: 'M', age: 20, text: 'Not Detected', coll: C1, iss: '2026-05-12T10:00:00Z', recv: '2026-05-03T09:00:00Z' }); // Male, 1 - 6 Weeks, negative, tat 11; 9 days
lab13('T13-A03', { req: CHO13, sex: 'F', age: 100, text: 'Positive*', coll: '2026-05-09T08:10:00Z', iss: '2026-05-10T08:50:00Z', recv: '2026-05-09T12:00:00Z', perf: '4567' }); // Female, 7 weeks to 6 Months, positive, tat 1, POC (numeric code), 24 hour boundaries so within; 1 day
lab13('T13-A04', { req: CHO13, sex: 'M', age: 250, obs: 'PGHIV', text: 'Indeterminate', coll: '2026-05-10T10:00:00Z', iss: '2026-05-12T10:00:00Z', recv: '2026-05-11T10:00:00Z' }); // Male, 7 - 9 Months, indeterminate, tat 2, POC (PGHIV), 48 hours so not within; 1 day
lab13('T13-A05', { req: CHO13, sex: 'I', age: 350, text: 'Negative', coll: C1, iss: '2026-05-16T10:00:00Z', recv: '2026-05-05T10:00:00Z' });  // Indeterminate, 10 - 12 Months, negative, tat 15 (not within 14); 11 days
lab13('T13-A06', { req: CHO13, sex: 'U', age: 450, text: 'Invalid', coll: C1, iss: '2026-05-04T10:00:00Z', recv: null });                    // Unknown, 13 - 18 Months, invalid, tat 3; no received date
lab13('T13-A07', { req: CHO13, sex: 'X', age: 600, text: 'Error', coll: '2026-05-20T10:00:00Z', iss: '2026-05-22T10:00:00Z', recv: '2026-05-21T10:00:00Z' }); // gender NULL (X), 19 - 24 Months, error, tat 2; 1 day
lab13('T13-A08', { req: CHO13, sex: 'F', age: 800, text: 'POS', coll: C1, iss: '2026-05-05T10:00:00Z', recv: '2026-05-01T08:00:00Z' });    // Female, > 2 years, positive, tat 4; 4 days
lab13('T13-A09', { req: CHO13, sex: null, age: null, text: 'Detected', coll: C1, iss: '2026-05-08T10:00:00Z', recv: '2026-05-08T09:00:00Z' }); // gender NULL, age group NULL, positive ('Detected' is on the eid positive list), tat 7; 0 days
lab13('T13-F01', { req: CHO13, sex: 'F', age: 100, text: 'Negative', coll: '2026-05-14', iss: '2026-05-15', recv: '2026-05-14' });            // date-only stamps: Female, 7 weeks to 6 Months, negative, tat 1; 1 day
// Choma Clinic.
lab13('T13-B01', { req: CL213, sex: 'M', age: 5, text: 'LDL', coll: C1, iss: '2026-05-06T10:00:00Z', recv: '2026-05-01T07:00:00Z' });          // Male, At Birth, negative, tat 5; 5 days
lab13('T13-B02', { req: CL213, sex: 'F', age: 30, text: 'Positive', coll: '2026-05-20T10:00:00Z', iss: '2026-05-22T10:00:00Z', recv: '2026-05-20T12:00:00Z', perf: '12' }); // Female, 1 - 6 Weeks, positive, tat 2, POC (numeric code), 48 hours; 2 days
lab13('123-B3', { req: CL213, sex: 'M', age: 60, text: 'Not Detected', coll: '2026-05-03T10:00:00Z', iss: '2026-05-03T20:00:00Z', recv: '2026-05-03T11:00:00Z' }); // Male, 7 weeks to 6 Months, negative, tat 0, POC (lab id starts with 123), 10 hours so within; 0 days
// Mazabuka Hospital: no POC, no positive.
lab13('T13-C01', { req: MAZ13, sex: 'F', age: 215, text: 'Negative', coll: C1, iss: '2026-05-05T10:00:00Z', recv: '2026-05-03T10:00:00Z' });  // Female, 7 - 9 Months, negative, tat 4; 2 days
lab13('T13-C02', { req: MAZ13, sex: 'M', age: 215, text: 'Negative', coll: C1, iss: '2026-05-07T10:00:00Z', recv: null });                    // Male, 7 - 9 Months, negative, tat 6; no received date
// Chilenje Clinic, with stamps that carry +02:00 near midnight and the edges of both windows.
lab13('T13-D01', { req: LUS13, sex: 'F', age: 25, text: 'Positive', coll: '2026-05-31T23:30:00+02:00', iss: '2026-06-01T23:30:00+02:00', recv: '2026-06-01T08:00:00+02:00', perf: '5551' }); // Female, 1 - 6 Weeks, positive, tat 1, POC, 24 hours so within; local 06-01 23:30; 0 days
lab13('T13-D02', { req: LUS13, sex: 'M', age: 600, text: 'Negative', coll: '2026-06-01T10:00:00+02:00', iss: '2026-06-02T00:30:00+02:00', recv: null });   // Male, 19 - 24 Months, negative, tat 1; local 06-02 (UTC 06-01)
lab13('T13-D03', { req: LUS13, sex: 'F', age: 300, text: 'Negative', coll: '2026-05-30T10:00:00Z', iss: '2026-06-02T10:00:00Z', recv: null });          // Female, 10 - 12 Months, negative, tat 3; 06-02
lab13('T13-D04', { req: LUS13, sex: 'M', age: 8, text: 'Positive', coll: '2026-04-29T10:00:00+02:00', iss: '2026-05-01T00:30:00+02:00', recv: '2026-04-30T10:00:00+02:00' }); // Male, 1 - 6 Weeks, positive, tat 2; local 05-01 00:30 (UTC 04-30); 1 day
lab13('T13-D05', { req: LUS13, sex: 'F', age: 400, text: 'Negative', coll: '2026-04-28T10:00:00Z', iss: '2026-04-30T23:30:00Z', recv: null });          // Female, 13 - 18 Months, negative, tat 2; 04-30 23:30
lab13('T13-D06', { req: LUS13, sex: 'F', age: 700, text: 'Negative', coll: '2026-05-12T10:00:00Z', iss: '2026-05-09T10:00:00Z', recv: '2026-05-08T10:00:00Z' }); // Female, 19 - 24 Months, negative, tat -3; 1 day
lab13('T13-D07', { req: LUS13, sex: 'M', age: 800, text: 'Positive', coll: '2026-05-15T10:00:00Z', iss: '2026-05-10T10:00:00Z', recv: '2026-05-12T10:00:00Z' }); // Male, > 2 years, positive, tat -5; -2 days
lab13('T13-D08', { req: LUS13, sex: 'F', age: 10, text: 'Negative', coll: '2026-06-03T10:00:00Z', iss: '2026-06-01T00:00:00+02:00', recv: '2026-05-29T23:30:00+02:00' }); // Female, 1 - 6 Weeks, negative, tat -2; local 06-01 00:00:00 exactly; 3 days on local dates (2 on UTC dates)
lab13('T13-D09', { req: LUS13, sex: 'M', age: 10, text: 'Negative', coll: '2026-06-04T10:00:00Z', iss: '2026-06-01T00:00:01+02:00', recv: null });    // Male, 1 - 6 Weeks, negative, tat -3; local 06-01 00:00:01
// Kafue District Hospital: a POC test that is not within 24 hours.
lab13('T13-K01', { req: KAF13, sex: 'F', age: 30, text: 'Positive', coll: '2026-05-02T07:00:00Z', iss: '2026-05-06T10:00:00Z', recv: '2026-05-03T07:00:00Z', perf: '5551' }); // Female, 1 - 6 Weeks, positive, tat 4, POC, 99 hours; 3 days
// Other months, for the trend.
lab13('T13-E01', { req: CHO13, sex: 'M', age: 100, text: 'Positive', coll: '2026-03-30T10:00:00Z', iss: '2026-04-01T00:30:00+02:00', recv: null });   // positive, tat 2; local 04-01 (UTC 03-31)
lab13('T13-E02', { req: CHO13, sex: 'M', age: 100, text: 'Negative', coll: '2026-03-29T10:00:00Z', iss: '2026-03-31T23:30:00+02:00', recv: null });   // negative, tat 2; local 03-31
lab13('T13-Y01', { req: LUS13, sex: 'F', age: 100, text: 'Negative', coll: '2025-12-30T10:00:00Z', iss: '2026-01-01T00:30:00+02:00', recv: null });   // negative, tat 2; local 2026-01-01 (UTC 2025-12-31)
lab13('T13-Y02', { req: LUS13, sex: 'M', age: 100, text: 'Positive', coll: '2025-12-10T10:00:00Z', iss: '2025-12-15T10:00:00Z', recv: null });       // positive, tat 5
// Partial stamps (July): a FHIR dateTime may be '2026-07'. It is not a date, so it gives NULL and the report does not fail.
lab13('T13-P1', { req: CHO13, sex: 'F', age: 100, text: 'Negative', coll: '2026-07-09T10:00:00Z', iss: '2026-07-10T10:00:00Z', recv: '2026-07' });   // Female, 7 weeks to 6 Months, negative, tat 1; received date present but partial: completed, in no bucket
lab13('T13-P2', { req: CHO13, sex: 'M', age: 100, text: 'Positive', coll: '2026-07', iss: '2026-07-11T10:00:00Z', recv: '2026-07-10T10:00:00Z' });   // Male, 7 weeks to 6 Months, positive, tat NULL (partial collected date), so not within 14; 1 day
lab13('T13-P3', { req: CHO13, sex: 'F', age: 100, text: 'Negative', coll: '2026-07-09T10:00:00Z', iss: '2026-07', recv: null });                    // partial authorised date: no tested date, in no window
// Left out whatever the window (sp_update_EIDTable lines 82-93): a facility not in the register, a cancelled report, another
// panel, and a final report with no authorised date (no tested date, so never in a window).
lab13('T13-X1', { req: 'ZUNMP', sex: 'F', age: 100, text: 'Positive', coll: C1, iss: '2026-05-10T10:00:00Z' });
lab13('T13-X2', { req: CHO13, sex: 'F', age: 100, text: 'Positive', coll: C1, iss: null, status: 'cancelled' });
lab13('T13-X3', { req: CHO13, sex: 'F', age: 100, text: 'Positive', coll: C1, iss: '2026-05-10T10:00:00Z', panel: 'HIVVL' });
lab13('T13-X4', { req: CHO13, sex: 'F', age: 100, text: 'Positive', coll: C1, iss: null });

const SETUP13 = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t13-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t13-fm2', '', '', 'ZCHO2', 'reg-c', 'Choma Clinic', 'Southern', 'Choma'),
  ('t13-fm3', '', '', 'ZMAZA', 'reg-m', 'Mazabuka Hospital', 'Southern', 'Mazabuka'),
  ('t13-fm4', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('t13-fm5', '', '', 'ZKAFU', 'reg-k', 'Kafue District Hospital', 'Lusaka', 'Kafue'),
  ('t13-fm6', '', '', 'ZUNMP', null, null, null, null);
insert into patients (id, surname, sex) values ${P13.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_days) values ${R13.join(',\n  ')};
insert into specimens (id, received_time) values ${S13.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, specimen_id) values ${D13.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator) values ${L13.join(',\n  ')};`;

const win13 = { from: '2026-05-01', to: '2026-05-31' };
const span13 = (from, to) => ({ from, to });
const dashQuery13 = queries().find((q) => q.name === 'EID dashboard summary');
const listQuery13 = queries().find((q) => q.name === 'EID dashboard by facility, sex and age');
const trendQuery13 = queries().find((q) => q.name === 'EID monthly trend');
const shape13 = (query, label, wantIds, wantTypes, wantRequired) => ({
  name: `${label}-shape`,
  count: 4 + wantIds.length,
  check() {
    if (!query) return [`query for ${label} is missing`];
    const bad = [];
    const ids = query.params.map((p) => p.id);
    if (JSON.stringify(ids) !== JSON.stringify(wantIds)) bad.push(`params: expected ${wantIds}, got ${ids}`);
    query.params.forEach((p, i) => {
      if (p.type !== wantTypes[i]) bad.push(`${p.id}: expected type ${wantTypes[i]}, got ${p.type}`);
      if (p.required !== wantRequired[i]) bad.push(`${p.id}: expected required ${wantRequired[i]}, got ${p.required}`);
    });
    if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(query.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
    if (!/^\s*with\b/i.test(query.sql)) bad.push('does not start with "with"');
    return bad;
  },
});

// ---- EID dashboard summary ----

// The 73 columns of every branch (V2 lines 25-114): 14 summary columns, 5 sex counts, the 9 age counts, then the 9 age counts
// again for each of the sex groups m, f, i, u and x (missing sex). The age count of a missing age is AgeMissing + suffix.
const AGE13 = ['At_Birth', '_1_to_6wks', '_7wks_to_6Ms', '_7_to_9Ms', '_10_to_12Ms', '_13_to_18Ms', '_19_to_24Ms', 'Over_2Y'];
const DASH13 = [
  'Province', 'District', 'Facility', 'Tests', 'Tests_POC', 'Positive', 'Positive_POC', 'Negative', 'PositivityRate', 'POCPositivityRate',
  'AverageTAT', 'POC_AverageTAT', 'TatWithin14', 'TatWithin48h_POC', 'Male', 'Female', 'IndeterminateGender', 'UnknownGender', 'MissingGender',
  ...AGE13, 'AgeMissing',
  ...['m', 'f', 'i', 'u', 'x'].flatMap((s) => [...AGE13.map((n) => `${n}_${s}`), `AgeMissing${s}`]),
];
// A row spec names only the columns that are not 0. These four are NULL unless set: each divides by the POC count or averages a
// set that can be empty (V2 lines 31, 33, 47 use nullif(sum(POC),0) or a case with no else).
const NULLABLE13 = new Set(['POCPositivityRate', 'AverageTAT', 'POC_AverageTAT', 'TatWithin48h_POC']);
const dash13 = (spec) => Object.fromEntries(DASH13.map((c) => [c, c in spec ? spec[c] : (NULLABLE13.has(c) ? null : 0)]));
const named13 = (spec, province, district, facility) => ({ ...spec, Province: province, District: district, Facility: facility });
// Nothing found. The all-Zambia branch still returns its one row (V2 line 24: an aggregate always gives a row): count() is 0 and every
// sum is NULL. The other branches return a row of blanks and zeros (lines 116, 225, 332, 439).
const EMPTY_NATIONAL13 = Object.fromEntries(DASH13.map((c) => [c, { Province: 'All', District: 'All', Facility: 'All', Tests: 0 }[c] ?? null]));
const NOT_FOUND13 = Object.fromEntries(DASH13.map((c) => [c, ['Province', 'District', 'Facility'].includes(c) ? '' : 0]));

// The age counts of A05, A06, A07 and A09 do not change with the area (they sit in Choma General Hospital).
const IUX13 = { _10_to_12Ms_i: 1, _13_to_18Ms_u: 1, _19_to_24Ms_x: 1, AgeMissingx: 1 };

// Choma General Hospital: A01 to A09 and F01 (10 tests). Positive A01 A03 A08 A09 = 4, of POC (A03 A04) 1. Rates 4/10 and 1/2.
// tat 9 11 1 2 15 3 2 4 7 1 = 55 / 10 = 5.5, an int average: 5. POC tat 1 2 = 3 / 2 = 1.5: 1. Within 14 days: all but A05, 9/10.
// POC within 24 hours: A03 only, 1/2.
const CHO_SPEC13 = {
  Tests: 10, Tests_POC: 2, Positive: 4, Positive_POC: 1, Negative: 6, PositivityRate: 4 / 10, POCPositivityRate: 1 / 2,
  AverageTAT: 5, POC_AverageTAT: 1, TatWithin14: 9 / 10, TatWithin48h_POC: 1 / 2,
  Male: 2, Female: 4, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 2,
  At_Birth: 1, _1_to_6wks: 1, _7wks_to_6Ms: 2, _7_to_9Ms: 1, _10_to_12Ms: 1, _13_to_18Ms: 1, _19_to_24Ms: 1, Over_2Y: 1, AgeMissing: 1,
  _1_to_6wks_m: 1, _7_to_9Ms_m: 1, At_Birth_f: 1, _7wks_to_6Ms_f: 2, Over_2Y_f: 1, ...IUX13,
};
// Southern / Choma: the hospital plus Choma Clinic B01 B02 B03 (13 tests). Positive 5 (B02 added), of POC (A03 A04 B02 B03) 2 of 4.
// tat 55 + 5 + 2 + 0 = 62 / 13 = 4.77: 4. POC tat 1 2 2 0 = 5 / 4 = 1.25: 1. Within 14 days 12/13. Within 24 hours: A03 B03 = 2/4.
const CHOMA_SPEC13 = {
  Tests: 13, Tests_POC: 4, Positive: 5, Positive_POC: 2, Negative: 8, PositivityRate: 5 / 13, POCPositivityRate: 2 / 4,
  AverageTAT: 4, POC_AverageTAT: 1, TatWithin14: 12 / 13, TatWithin48h_POC: 2 / 4,
  Male: 4, Female: 5, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 2,
  At_Birth: 2, _1_to_6wks: 2, _7wks_to_6Ms: 3, _7_to_9Ms: 1, _10_to_12Ms: 1, _13_to_18Ms: 1, _19_to_24Ms: 1, Over_2Y: 1, AgeMissing: 1,
  At_Birth_m: 1, _1_to_6wks_m: 1, _7wks_to_6Ms_m: 1, _7_to_9Ms_m: 1,
  At_Birth_f: 1, _1_to_6wks_f: 1, _7wks_to_6Ms_f: 2, Over_2Y_f: 1, ...IUX13,
};
// Mazabuka Hospital: C01 and C02. No POC test: Tests_POC is 0 (a sum over rows), the POC rate and the POC average are NULL (nullif, an
// avg over no rows), and TatWithin48h_POC is NULL (V2 line 47: a sum of a case with no else, over nothing, divided by nullif(0, 0)).
const MAZ_SPEC13 = {
  Tests: 2, Tests_POC: 0, Positive: 0, Positive_POC: 0, Negative: 2, PositivityRate: 0, AverageTAT: 5, TatWithin14: 1,
  Male: 1, Female: 1, _7_to_9Ms: 2, _7_to_9Ms_m: 1, _7_to_9Ms_f: 1,
};
// Southern = Choma + Mazabuka (15 tests). Positive 5, POC 4. tat 62 + 4 + 6 = 72 / 15 = 4.8: 4. Within 14 days 14/15.
const SOUTHERN_SPEC13 = {
  Tests: 15, Tests_POC: 4, Positive: 5, Positive_POC: 2, Negative: 10, PositivityRate: 5 / 15, POCPositivityRate: 2 / 4,
  AverageTAT: 4, POC_AverageTAT: 1, TatWithin14: 14 / 15, TatWithin48h_POC: 2 / 4,
  Male: 5, Female: 6, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 2,
  At_Birth: 2, _1_to_6wks: 2, _7wks_to_6Ms: 3, _7_to_9Ms: 3, _10_to_12Ms: 1, _13_to_18Ms: 1, _19_to_24Ms: 1, Over_2Y: 1, AgeMissing: 1,
  At_Birth_m: 1, _1_to_6wks_m: 1, _7wks_to_6Ms_m: 1, _7_to_9Ms_m: 2,
  At_Birth_f: 1, _1_to_6wks_f: 1, _7wks_to_6Ms_f: 2, _7_to_9Ms_f: 1, Over_2Y_f: 1, ...IUX13,
};
// Chilenje Clinic in the window (06-01 included): D01 D04 D06 D07 D08 D09 (6 tests). Positive D01 D04 D07 = 3, POC D01: 1 of 1.
// tat 1 2 -3 -5 -2 -3 = -10 / 6 = -1.67, an int average truncates toward zero: -1. POC tat 1. All within 14 days; D01 within 24 hours.
const CHILENJE_SPEC13 = {
  Tests: 6, Tests_POC: 1, Positive: 3, Positive_POC: 1, Negative: 3, PositivityRate: 3 / 6, POCPositivityRate: 1,
  AverageTAT: -1, POC_AverageTAT: 1, TatWithin14: 1, TatWithin48h_POC: 1,
  Male: 3, Female: 3, _1_to_6wks: 4, _19_to_24Ms: 1, Over_2Y: 1,
  _1_to_6wks_m: 2, Over_2Y_m: 1, _1_to_6wks_f: 2, _19_to_24Ms_f: 1,
};
// Kafue District Hospital: K01, a POC test collected 99 hours before it was tested: POC tests exist and none is within 24 hours, so
// TatWithin48h_POC is NULL, not 0 (a sum of a case with no else over no matches).
const KAFUE_SPEC13 = {
  Tests: 1, Tests_POC: 1, Positive: 1, Positive_POC: 1, Negative: 0, PositivityRate: 1, POCPositivityRate: 1,
  AverageTAT: 4, POC_AverageTAT: 4, TatWithin14: 1, Female: 1, _1_to_6wks: 1, _1_to_6wks_f: 1,
};
// Lusaka = Chilenje + Kafue (7 tests). Positive 4, POC 2 of 2. tat -10 + 4 = -6 / 7 = -0.86: 0. POC tat 1 4 = 5 / 2 = 2.5: 2. Within 24 hours: D01 = 1/2.
const LUSAKA_SPEC13 = {
  Tests: 7, Tests_POC: 2, Positive: 4, Positive_POC: 2, Negative: 3, PositivityRate: 4 / 7, POCPositivityRate: 1,
  AverageTAT: 0, POC_AverageTAT: 2, TatWithin14: 1, TatWithin48h_POC: 1 / 2,
  Male: 3, Female: 4, _1_to_6wks: 5, _19_to_24Ms: 1, Over_2Y: 1,
  _1_to_6wks_m: 2, Over_2Y_m: 1, _1_to_6wks_f: 3, _19_to_24Ms_f: 1,
};
// All of Zambia, 2026-05-01 to 2026-05-31, so tested dates 05-01 to 06-01 (V2 line 21): Southern 15 + Lusaka 7 = 22 tests.
// Positive 9, POC 6 (A03 A04 B02 B03 D01 K01), positive POC 4. tat 72 - 6 = 66 / 22 = 3. POC tat 1 2 2 0 1 4 = 10 / 6: 1.
// Within 14 days 21/22. Within 24 hours: A03 B03 D01 = 3/6.
const NATIONAL_SPEC13 = {
  Tests: 22, Tests_POC: 6, Positive: 9, Positive_POC: 4, Negative: 13, PositivityRate: 9 / 22, POCPositivityRate: 4 / 6,
  AverageTAT: 3, POC_AverageTAT: 1, TatWithin14: 21 / 22, TatWithin48h_POC: 3 / 6,
  Male: 8, Female: 10, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 2,
  At_Birth: 2, _1_to_6wks: 7, _7wks_to_6Ms: 3, _7_to_9Ms: 3, _10_to_12Ms: 1, _13_to_18Ms: 1, _19_to_24Ms: 2, Over_2Y: 2, AgeMissing: 1,
  At_Birth_m: 1, _1_to_6wks_m: 3, _7wks_to_6Ms_m: 1, _7_to_9Ms_m: 2, Over_2Y_m: 1,
  At_Birth_f: 1, _1_to_6wks_f: 4, _7wks_to_6Ms_f: 2, _7_to_9Ms_f: 1, _19_to_24Ms_f: 1, Over_2Y_f: 1, ...IUX13,
};

const dashSuite13 = (name, params, rows, setup = '') => orderedSuite10(name, dashQuery13?.sql ?? 'select 1', params, DASH13, rows, setup);
const area13 = (province, district, facility) => ({ province, district, facility });
const none13 = area13('', '', '');

const suites13dash = [
  // The four branches (V2 lines 22, 130, 239, 346). Names read 'All' above the level asked for.
  dashSuite13('dash-national', { ...none13, ...win13 }, [dash13(named13(NATIONAL_SPEC13, 'All', 'All', 'All'))], SETUP13),
  dashSuite13('dash-province', { ...area13('Southern', '', ''), ...win13 }, [dash13(named13(SOUTHERN_SPEC13, 'Southern', 'All', 'All'))]),
  dashSuite13('dash-district', { ...area13('Southern', 'Choma', ''), ...win13 }, [dash13(named13(CHOMA_SPEC13, 'Southern', 'Choma', 'All'))]),
  dashSuite13('dash-facility', { ...area13('Southern', 'Choma', 'Choma General Hospital'), ...win13 }, [dash13(named13(CHO_SPEC13, 'Southern', 'Choma', 'Choma General Hospital'))]),
  // Names compare as SQL Server does (case and trailing spaces ignored); the row shows the stored names.
  dashSuite13('dash-names-fold', { ...area13('SOUTHERN', 'choma', 'choma general hospital  '), ...win13 }, [dash13(named13(CHO_SPEC13, 'Southern', 'Choma', 'Choma General Hospital'))]),
  dashSuite13('dash-lusaka', { ...area13('Lusaka', '', ''), ...win13 }, [dash13(named13(LUSAKA_SPEC13, 'Lusaka', 'All', 'All'))]),
  dashSuite13('dash-lusaka-district', { ...area13('Lusaka', 'Lusaka', ''), ...win13 }, [dash13(named13(CHILENJE_SPEC13, 'Lusaka', 'Lusaka', 'All'))]),
  dashSuite13('dash-lusaka-facility', { ...area13('Lusaka', 'Lusaka', 'Chilenje Clinic'), ...win13 }, [dash13(named13(CHILENJE_SPEC13, 'Lusaka', 'Lusaka', 'Chilenje Clinic'))]),
  dashSuite13('dash-kafue', { ...area13('Lusaka', 'Kafue', ''), ...win13 }, [dash13(named13(KAFUE_SPEC13, 'Lusaka', 'Kafue', 'All'))]),
  dashSuite13('dash-kafue-facility', { ...area13('Lusaka', 'Kafue', 'Kafue District Hospital'), ...win13 }, [dash13(named13(KAFUE_SPEC13, 'Lusaka', 'Kafue', 'Kafue District Hospital'))]),
  // No POC test: the POC rate, the POC average and TatWithin48h_POC are NULL.
  dashSuite13('dash-no-poc', { ...area13('Southern', 'Mazabuka', ''), ...win13 }, [dash13(named13(MAZ_SPEC13, 'Southern', 'Mazabuka', 'All'))]),
  // Nothing found (V2 lines 24, 132, 241, 348). All of Zambia always returns its row: count() is 0, every sum NULL. A province, a district
  // or a facility with no tests returns the row of blanks and zeros (lines 225, 332, 439). The port gives the facility row v1's four
  // missing columns as 0.
  dashSuite13('dash-empty-national', { ...none13, from: '2026-08-01', to: '2026-08-31' }, [EMPTY_NATIONAL13]),
  dashSuite13('dash-empty-province', { ...area13('Western', '', ''), ...win13 }, [NOT_FOUND13]),
  dashSuite13('dash-empty-province-window', { ...area13('Southern', '', ''), from: '2026-08-01', to: '2026-08-31' }, [NOT_FOUND13]),
  dashSuite13('dash-empty-district', { ...area13('Southern', 'Kafue', ''), ...win13 }, [NOT_FOUND13]),
  dashSuite13('dash-empty-district-other-province', { ...area13('Lusaka', 'Choma', ''), ...win13 }, [NOT_FOUND13]),
  dashSuite13('dash-empty-facility', { ...area13('Southern', 'Choma', 'Nowhere'), ...win13 }, [NOT_FOUND13]),
  dashSuite13('dash-empty-facility-window', { ...area13('Southern', 'Choma', 'Choma General Hospital'), from: '2026-08-01', to: '2026-08-31' }, [NOT_FOUND13]),
  // A facility in another district does not match (V2 line 437 tests all three).
  dashSuite13('dash-facility-wrong-district', { ...area13('Southern', 'Mazabuka', 'Choma General Hospital'), ...win13 }, [NOT_FOUND13]),
  // A facility whose requests are not in the register has no rows: nothing in V2 either (inner joins in sp_update_EIDTable lines 82-87).
  dashSuite13('dash-unmapped-facility', { ...area13('Southern', 'Choma', 'Unmapped Clinic'), ...win13 }, [NOT_FOUND13]),
  // v1 has no branch for these (lines 22, 130, 239, 346): no result set at all.
  dashSuite13('dash-district-only', { ...area13('', 'Choma', ''), ...win13 }, []),
  dashSuite13('dash-facility-only', { ...area13('', '', 'Choma General Hospital'), ...win13 }, []),
  dashSuite13('dash-province-facility', { ...area13('Southern', '', 'Choma General Hospital'), ...win13 }, []),
  dashSuite13('dash-district-facility', { ...area13('', 'Choma', 'Choma General Hospital'), ...win13 }, []),
  // The window: the whole day after the end date is included (line 21), on the local date of the stamp.
  // 05-31: window 05-31 to 06-01. D01 (06-01 23:30), D08 (06-01 00:00:00) and D09 (06-01 00:00:01) are in; D02 and D03 (06-02) are out.
  // tat 1 -2 -3 = -4 / 3: -1. Positive D01. POC D01 only, within 24 hours.
  dashSuite13('dash-window-0531', { ...none13, from: '2026-05-31', to: '2026-05-31' }, [dash13(named13({
    Tests: 3, Tests_POC: 1, Positive: 1, Positive_POC: 1, Negative: 2, PositivityRate: 1 / 3, POCPositivityRate: 1,
    AverageTAT: -1, POC_AverageTAT: 1, TatWithin14: 1, TatWithin48h_POC: 1,
    Male: 1, Female: 2, _1_to_6wks: 3, _1_to_6wks_m: 1, _1_to_6wks_f: 2,
  }, 'All', 'All', 'All'))]),
  // 06-01: window 06-01 to 06-02. D01 D08 D09 and D02 (local 06-02 00:30, UTC 06-01) and D03 (06-02 10:00Z). tat 1 -2 -3 1 3 = 0.
  dashSuite13('dash-window-0601', { ...none13, from: '2026-06-01', to: '2026-06-01' }, [dash13(named13({
    Tests: 5, Tests_POC: 1, Positive: 1, Positive_POC: 1, Negative: 4, PositivityRate: 1 / 5, POCPositivityRate: 1,
    AverageTAT: 0, POC_AverageTAT: 1, TatWithin14: 1, TatWithin48h_POC: 1,
    Male: 2, Female: 3, _1_to_6wks: 3, _10_to_12Ms: 1, _19_to_24Ms: 1,
    _1_to_6wks_m: 1, _19_to_24Ms_m: 1, _1_to_6wks_f: 2, _10_to_12Ms_f: 1,
  }, 'All', 'All', 'All'))]),
  // 04-30: window 04-30 to 05-01. D05 (local 04-30 23:30) and D04 (local 05-01 00:30; its UTC date is 04-30). No POC. tat 2 2.
  dashSuite13('dash-window-0430', { ...none13, from: '2026-04-30', to: '2026-04-30' }, [dash13(named13({
    Tests: 2, Tests_POC: 0, Positive: 1, Positive_POC: 0, Negative: 1, PositivityRate: 1 / 2, AverageTAT: 2, TatWithin14: 1,
    Male: 1, Female: 1, _1_to_6wks: 1, _13_to_18Ms: 1, _1_to_6wks_m: 1, _13_to_18Ms_f: 1,
  }, 'All', 'All', 'All'))]),
  // 05-01: window 05-01 to 05-02. D04 only (local date 05-01). A date taken in UTC would put it on 04-30 and leave the window empty.
  dashSuite13('dash-window-0501', { ...none13, from: '2026-05-01', to: '2026-05-01' }, [dash13(named13({
    Tests: 1, Tests_POC: 0, Positive: 1, Positive_POC: 0, Negative: 0, PositivityRate: 1, AverageTAT: 2, TatWithin14: 1,
    Male: 1, _1_to_6wks: 1, _1_to_6wks_m: 1,
  }, 'All', 'All', 'All'))]),
  // Partial stamps (P1 P2 in July; P3 has no usable tested date and is in no window). P2's collected date is partial, so its tat is NULL:
  // AverageTAT averages P1 alone (1), and P2 is not within 14 days (the flag is 0). No POC test.
  dashSuite13('dash-partial-stamps', { ...none13, from: '2026-07-01', to: '2026-07-31' }, [dash13(named13({
    Tests: 2, Tests_POC: 0, Positive: 1, Positive_POC: 0, Negative: 1, PositivityRate: 1 / 2, AverageTAT: 1, TatWithin14: 1 / 2,
    Male: 1, Female: 1, _7wks_to_6Ms: 2, _7wks_to_6Ms_m: 1, _7wks_to_6Ms_f: 1,
  }, 'All', 'All', 'All'))]),
  shape13(dashQuery13, 'dash', ['province', 'district', 'facility', 'from', 'to'], ['select', 'select', 'text', 'text', 'text'], [false, false, false, true, true]),
  {
    name: 'dash-columns',
    count: 1,
    check() {
      return DASH13.length === 73 && new Set(DASH13).size === 73 ? [] : [`expected 73 distinct columns, got ${DASH13.length} (${new Set(DASH13).size} distinct)`];
    },
  },
];

// ---- EID dashboard by facility, sex and age ----

const LIST13 = ['Province', 'District', 'Facility', 'Gender', 'AgeGroup', 'Tests', 'Positive', 'Negative', 'Indeterminate', 'Error', 'Invalid',
  'RDateCompleted', 'LabTATWithin1', 'LabTATWithin2', 'LabTATWithin3', 'LabTATWithin7', 'LabTATWithin14', 'TATWithin14'];
// counts: Tests, Positive, Negative, Indeterminate, Error, Invalid, RDateCompleted, then the lab turnaround buckets 1, 2, 3, 7, 14
// (local days from received to tested, List lines 45-49), then TATWithin14.
const ls13 = (province, district, facility, gender, age, counts) => Object.fromEntries(LIST13.map((c, i) => [c, [province, district, facility, gender, age, ...counts][i]]));
const CHO_N = ['Southern', 'Choma', 'Choma General Hospital'];
const CL2_N = ['Southern', 'Choma', 'Choma Clinic'];
const MAZ_N = ['Southern', 'Mazabuka', 'Mazabuka Hospital'];
const LUS_N = ['Lusaka', 'Lusaka', 'Chilenje Clinic'];
const KAF_N = ['Lusaka', 'Kafue', 'Kafue District Hospital'];
// One row per facility, gender and age group (List lines 38-55, 81-99, 125-143). Each comment names the labs and their received-to-tested days.
const K01_ROW = ls13(...KAF_N, 'Female', '1 - 6 Weeks', [1, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1]);          // K01: 3 days
const D08_ROW = ls13(...LUS_N, 'Female', '1 - 6 Weeks', [1, 0, 1, 0, 0, 0, 1, 0, 0, 1, 1, 1, 1]);          // D08: 3 days on local dates (the UTC dates would say 2)
const D06_ROW = ls13(...LUS_N, 'Female', '19 - 24 Months', [1, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]);      // D06: 1 day
const D07_ROW = ls13(...LUS_N, 'Male', '> 2 years', [1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]);              // D07: -2 days, in every bucket (a negative is <= 1)
const D04_ROW = ls13(...LUS_N, 'Male', '1 - 6 Weeks', [1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]);            // D04: 1 day
const A08_ROW = ls13(...CHO_N, 'Female', '> 2 years', [1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1]);           // A08: 4 days
const B02_ROW = ls13(...CL2_N, 'Female', '1 - 6 Weeks', [1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1]);          // B02: 2 days
const C01_ROW = ls13(...MAZ_N, 'Female', '7 - 9 Months', [1, 0, 1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1]);        // C01: 2 days
const A03_ROW = ls13(...CHO_N, 'Female', '7 weeks to 6 Months', [2, 1, 1, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2]);  // A03 (positive) and F01 (negative): 1 day each
const A01_ROW = ls13(...CHO_N, 'Female', 'At Birth', [1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1]);            // A01: 8 days
const A05_ROW = ls13(...CHO_N, 'Indeterminate', '10 - 12 Months', [1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]); // A05: 11 days, tat 15 so not within 14
const A02_ROW = ls13(...CHO_N, 'Male', '1 - 6 Weeks', [1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1]);          // A02: 9 days
const A04_ROW = ls13(...CHO_N, 'Male', '7 - 9 Months', [1, 0, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1, 1]);         // A04: indeterminate, 1 day
const C02_ROW = ls13(...MAZ_N, 'Male', '7 - 9 Months', [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);         // C02: no received date, so no bucket and not completed
const B03_ROW = ls13(...CL2_N, 'Male', '7 weeks to 6 Months', [1, 0, 1, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]);   // B03: 0 days
const B01_ROW = ls13(...CL2_N, 'Male', 'At Birth', [1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 1, 1]);             // B01: 5 days
const A07_ROW = ls13(...CHO_N, 'Missing', '19 - 24 Months', [1, 0, 0, 0, 1, 0, 1, 1, 1, 1, 1, 1, 1]);     // A07: gender NULL, error, 1 day
const A09_ROW = ls13(...CHO_N, 'Missing', 'Missing', [1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1]);           // A09: gender and age NULL, 0 days
const A06_ROW = ls13(...CHO_N, 'Unknown', '13 - 18 Months', [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);    // A06: invalid, no received date
// The order (List lines 57-59, 101-103, 145-147): all of Zambia sorts by Province, Gender, AgeGroup only (District and Facility are not in its
// ORDER BY; the port breaks the ties on them); a province by Province, District, Gender, AgeGroup (Facility breaks the ties); a district by all five.
// Text order is SQL Server's: age groups sort '> 2 years', '1 - 6 Weeks', '10 - 12 Months', '13 - 18 Months', '19 - 24 Months', '7 - 9 Months',
// '7 weeks to 6 Months', 'At Birth', 'Missing' (measured on the local SQL Server, Latin1_General_CI_AS), genders Female, Indeterminate, Male, Missing, Unknown.
const NATIONAL_LIST13 = [
  K01_ROW, D08_ROW, D06_ROW, D07_ROW, D04_ROW,                                    // Lusaka: Female (1 - 6 Weeks: Kafue before Lusaka), then Male
  A08_ROW, B02_ROW, C01_ROW, A03_ROW, A01_ROW,                                    // Southern, Female
  A05_ROW, A02_ROW, A04_ROW, C02_ROW, B03_ROW, B01_ROW,                           // Indeterminate, then Male (7 - 9 Months: Choma before Mazabuka)
  A07_ROW, A09_ROW, A06_ROW,                                                      // Missing, then Unknown
];
const SOUTHERN_LIST13 = [
  A08_ROW, B02_ROW, A03_ROW, A01_ROW, A05_ROW, A02_ROW, A04_ROW, B03_ROW, B01_ROW, A07_ROW, A09_ROW, A06_ROW,   // Choma
  C01_ROW, C02_ROW,                                                                                              // Mazabuka
];
const CHOMA_LIST13 = [
  B02_ROW, B03_ROW, B01_ROW,                                                                          // Choma Clinic
  A08_ROW, A03_ROW, A01_ROW, A05_ROW, A02_ROW, A04_ROW, A07_ROW, A09_ROW, A06_ROW,                    // Choma General Hospital
];
const LUSAKA_LIST13 = [K01_ROW, D08_ROW, D06_ROW, D07_ROW, D04_ROW];
const LUSAKA_DISTRICT_LIST13 = [D08_ROW, D06_ROW, D07_ROW, D04_ROW];
// The "nothing found" row (List lines 61, 104, 148): blanks and zeros. v1's row has fewer columns and its own names (LabWithin14); the port
// gives the main column names, blank District and Facility, and 0 for LabTATWithin14.
const NOTHING_LIST13 = ls13('', '', '', '', '', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

const listSuite13 = (name, params, rows, setup = '') => orderedSuite10(name, listQuery13?.sql ?? 'select 1', params, LIST13, rows, setup);
const area2x13 = (province, district) => ({ province, district });

const suites13list = [
  listSuite13('list-national', { ...area2x13('', ''), ...win13 }, NATIONAL_LIST13),
  listSuite13('list-province', { ...area2x13('Southern', ''), ...win13 }, SOUTHERN_LIST13),
  listSuite13('list-district', { ...area2x13('Southern', 'Choma'), ...win13 }, CHOMA_LIST13),
  listSuite13('list-lusaka', { ...area2x13('Lusaka', ''), ...win13 }, LUSAKA_LIST13),
  listSuite13('list-lusaka-district', { ...area2x13('Lusaka', 'Lusaka'), ...win13 }, LUSAKA_DISTRICT_LIST13),
  // Names compare as SQL Server does (case and trailing spaces ignored); the rows show the stored names.
  listSuite13('list-names-fold', { ...area2x13('SOUTHERN ', 'choma  '), ...win13 }, CHOMA_LIST13),
  // Nothing found: only the blanks-and-zeros row, in every branch (lines 61, 104, 148).
  listSuite13('list-empty-national', { ...area2x13('', ''), from: '2026-08-01', to: '2026-08-31' }, [NOTHING_LIST13]),
  listSuite13('list-empty-province', { ...area2x13('Western', ''), ...win13 }, [NOTHING_LIST13]),
  listSuite13('list-empty-district', { ...area2x13('Southern', 'Kafue'), ...win13 }, [NOTHING_LIST13]),
  listSuite13('list-wrong-district', { ...area2x13('Lusaka', 'Choma'), ...win13 }, [NOTHING_LIST13]),
  // A district without a province matches no branch (lines 22, 63, 107): no result set at all, not even the blanks row.
  listSuite13('list-district-only', { ...area2x13('', 'Choma'), ...win13 }, []),
  listSuite13('list-district-only-empty', { ...area2x13('', 'Kafue'), ...win13 }, []),
  // The window is [from 00:00:00, to + 1 day 00:00:00] on the LOCAL wall time (lines 21, 33): TestedDate is a datetime, compared with no cast.
  // 05-31: D08 (exactly 06-01 00:00:00) is in. D09 (00:00:01) and D01 (06-01 23:30) are out.
  listSuite13('list-window-0531', { ...area2x13('', ''), from: '2026-05-31', to: '2026-05-31' }, [D08_ROW]),
  // 06-01: D01 (23:30), D08 (00:00:00) and D09 (00:00:01) are in; D02 (06-02 00:30 local, UTC 06-01) and D03 (06-02) are out.
  // D01 and D08 share a group: one positive, one negative; received days 0 and 3 give buckets 1 / 1 / 2 / 2 / 2.
  listSuite13('list-window-0601', { ...area2x13('', ''), from: '2026-06-01', to: '2026-06-01' }, [
    ls13(...LUS_N, 'Female', '1 - 6 Weeks', [2, 1, 1, 0, 0, 0, 2, 1, 1, 2, 2, 2, 2]),
    ls13(...LUS_N, 'Male', '1 - 6 Weeks', [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  ]),
  // 04-30: D05 (04-30 23:30) is in; D04 (local 05-01 00:30) is after the midnight that ends the window.
  listSuite13('list-window-0430', { ...area2x13('', ''), from: '2026-04-30', to: '2026-04-30' }, [
    ls13(...LUS_N, 'Female', '13 - 18 Months', [1, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]),
  ]),
  // 05-01: D04 is in (local 05-01 00:30; its UTC date is 04-30).
  listSuite13('list-window-0501', { ...area2x13('', ''), from: '2026-05-01', to: '2026-05-01' }, [D04_ROW]),
  // Partial stamps (July). P1: a received date that is present but partial, so it is completed and in no bucket. P2: received 07-10,
  // tested 07-11, one day; its tat is NULL, so TATWithin14 is 0.
  listSuite13('list-partial-stamps', { ...area2x13('', ''), from: '2026-07-01', to: '2026-07-31' }, [
    ls13(...CHO_N, 'Female', '7 weeks to 6 Months', [1, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1]),
    ls13(...CHO_N, 'Male', '7 weeks to 6 Months', [1, 1, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0]),
  ]),
  shape13(listQuery13, 'list', ['province', 'district', 'from', 'to'], ['select', 'select', 'text', 'text'], [false, false, true, true]),
];

// ---- EID monthly trend ----

const TREND13 = ['MonthID', 'Tests', 'Positive', 'Negative', 'Within14'];
const tr13 = (month, tests, positive, negative, within14) => Object.fromEntries(TREND13.map((c, i) => [c, [month, tests, positive, negative, within14][i]]));
const trendSuite13 = (name, params, rows, setup = '') => orderedSuite10(name, trendQuery13?.sql ?? 'select 1', params, TREND13, rows, setup);
const area3x13 = (province, district, facility) => ({ province, district, facility });
// Negative is Tests - Positive (line 17), so indeterminate, error and invalid results count as negative. Months of the local date.
const DEC = tr13('2025 - 12', 1, 1, 0, 1);      // Y02
const JAN = tr13('2026 - 01', 1, 0, 1, 1);      // Y01: local 2026-01-01 (UTC 2025-12-31)
const MAR = tr13('2026 - 03', 1, 0, 1, 1);      // E02: local 03-31
const APR = tr13('2026 - 04', 2, 1, 1, 2);      // E01 (local 04-01, UTC 03-31, positive) and D05 (04-30 23:30)
// May: A01-A09 F01 B01-B03 C01 C02 D04 D06 D07 K01 = 19 tests. Positive A01 A03 A08 A09 B02 D04 D07 K01 = 8. Within 14 days: all but A05 = 18.
const MAY = tr13('2026 - 05', 19, 8, 11, 18);
// June: D01 D08 D09 (06-01) D02 D03 (06-02) = 5 tests, positive D01. Tat 1 -2 -3 1 3: all within 14 days.
const JUN = tr13('2026 - 06', 5, 1, 4, 5);
const ALL13 = span13('2025-12-01', '2026-06-30');

const suites13trend = [
  trendSuite13('trend-national', { ...area3x13('', '', ''), ...ALL13 }, [DEC, JAN, MAR, APR, MAY, JUN]),
  trendSuite13('trend-apr-may', { ...area3x13('', '', ''), ...span13('2026-04-01', '2026-05-31') }, [APR, MAY]),
  trendSuite13('trend-may-june', { ...area3x13('', '', ''), ...span13('2026-05-01', '2026-06-30') }, [MAY, JUN]),
  // Southern (line 13): March E02; April E01; May A01-A09 F01 B01-B03 C01 C02 = 15 tests, positive A01 A03 A08 A09 B02 = 5, within 14: 14.
  trendSuite13('trend-province', { ...area3x13('Southern', '', ''), ...ALL13 }, [MAR, tr13('2026 - 04', 1, 1, 0, 1), tr13('2026 - 05', 15, 5, 10, 14)]),
  // Southern / Choma (line 28): May without Mazabuka = 13 tests, positive 5, within 14: 12.
  trendSuite13('trend-district', { ...area3x13('Southern', 'Choma', ''), ...ALL13 }, [MAR, tr13('2026 - 04', 1, 1, 0, 1), tr13('2026 - 05', 13, 5, 8, 12)]),
  // Choma Clinic (line 44): B01 B02 B03 in May, positive B02.
  trendSuite13('trend-facility', { ...area3x13('Southern', 'Choma', 'Choma Clinic'), ...ALL13 }, [tr13('2026 - 05', 3, 1, 2, 3)]),
  trendSuite13('trend-names-fold', { ...area3x13('southern', 'CHOMA ', 'choma clinic  '), ...ALL13 }, [tr13('2026 - 05', 3, 1, 2, 3)]),
  // Lusaka: December Y02, January Y01, April D05, May D04 D06 D07 K01 (positive D04 D07 K01), June D01 D08 D09 D02 D03.
  trendSuite13('trend-lusaka', { ...area3x13('Lusaka', '', ''), ...ALL13 }, [DEC, JAN, tr13('2026 - 04', 1, 0, 1, 1), tr13('2026 - 05', 4, 3, 1, 4), JUN]),
  trendSuite13('trend-lusaka-district', { ...area3x13('Lusaka', 'Lusaka', ''), ...ALL13 }, [DEC, JAN, tr13('2026 - 04', 1, 0, 1, 1), tr13('2026 - 05', 3, 2, 1, 3), JUN]),
  trendSuite13('trend-kafue', { ...area3x13('Lusaka', 'Kafue', ''), ...ALL13 }, [tr13('2026 - 05', 1, 1, 0, 1)]),
  // Any other combination falls to v1's last branch (line 61): nothing is filtered, so it is all of Zambia.
  trendSuite13('trend-district-only', { ...area3x13('', 'Choma', ''), ...ALL13 }, [DEC, JAN, MAR, APR, MAY, JUN]),
  trendSuite13('trend-facility-only', { ...area3x13('', '', 'Choma Clinic'), ...ALL13 }, [DEC, JAN, MAR, APR, MAY, JUN]),
  trendSuite13('trend-province-facility', { ...area3x13('Southern', '', 'Choma Clinic'), ...ALL13 }, [DEC, JAN, MAR, APR, MAY, JUN]),
  trendSuite13('trend-district-facility', { ...area3x13('', 'Choma', 'Choma Clinic'), ...ALL13 }, [DEC, JAN, MAR, APR, MAY, JUN]),
  // The month is the local month of the stamp, and there is no extra day (lines 20-22). D04 (local 05-01 00:30, UTC 04-30) is May;
  // E01 (local 04-01, UTC 03-31) is April; E02 (local 03-31) is March; D08 and D09 (local 06-01, UTC 05-31) are June.
  trendSuite13('trend-edge-0501', { ...area3x13('', '', ''), ...span13('2026-05-01', '2026-05-01') }, [tr13('2026 - 05', 1, 1, 0, 1)]),
  trendSuite13('trend-edge-0531', { ...area3x13('', '', ''), ...span13('2026-05-31', '2026-05-31') }, []),
  trendSuite13('trend-edge-0601', { ...area3x13('', '', ''), ...span13('2026-06-01', '2026-06-01') }, [tr13('2026 - 06', 3, 1, 2, 3)]),
  trendSuite13('trend-edge-0430', { ...area3x13('', '', ''), ...span13('2026-04-30', '2026-04-30') }, [tr13('2026 - 04', 1, 0, 1, 1)]),
  trendSuite13('trend-edge-0401', { ...area3x13('', '', ''), ...span13('2026-04-01', '2026-04-01') }, [tr13('2026 - 04', 1, 1, 0, 1)]),
  trendSuite13('trend-edge-0331', { ...area3x13('', '', ''), ...span13('2026-03-31', '2026-03-31') }, [MAR]),
  // The year turns: MonthID sorts 2025 - 12 before 2026 - 01. Y01 is local 2026-01-01 (UTC 2025-12-31).
  trendSuite13('trend-year-turn', { ...area3x13('', '', ''), ...span13('2025-12-01', '2026-01-31') }, [DEC, JAN]),
  trendSuite13('trend-year-edge', { ...area3x13('', '', ''), ...span13('2026-01-01', '2026-01-01') }, [JAN]),
  // Partial stamps: P1 and P2 are in July (P2's partial collected date only makes its tat NULL, so it is not within 14 days); P3 has no tested date.
  trendSuite13('trend-partial-stamps', { ...area3x13('', '', ''), ...span13('2026-07-01', '2026-07-31') }, [tr13('2026 - 07', 2, 1, 1, 1)]),
  // No test in the window: no row (a group by over no rows).
  trendSuite13('trend-empty', { ...area3x13('', '', ''), ...span13('2026-08-01', '2026-08-31') }, []),
  trendSuite13('trend-empty-province', { ...area3x13('Western', '', ''), ...ALL13 }, []),
  shape13(trendQuery13, 'trend', ['province', 'district', 'facility', 'from', 'to'], ['select', 'select', 'text', 'text', 'text'], [false, false, false, true, true]),
];

export const groups = [{ name: 't3', suites }, { name: 't10-eid', suites: suites10e },
  { name: 't13', suites: [...suites13dash, ...suites13list, ...suites13trend] }];

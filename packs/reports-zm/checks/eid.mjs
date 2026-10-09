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

export const groups = [{ name: 't3', suites }, { name: 't10-eid', suites: suites10e }];

// Custom queries for the lab-ops reports. Each task adds { name, sql, params } entries to the list.

import { foldSql, inListSql, isNumericSql } from '../../vl-reports-mz/vl-queries.mjs';
import {
  count1, dateParams, eidCte, hivvlCte, labNameSql, labNamesCte, localDate, localTs, sqlLit, ssTextKey, tbgnxCte, testedAtSql, testingCodeSql,
} from '../zm-sql.mjs';
import { rateCutSql } from './vl.mjs';

// ---- The three lab performance dashboards (Task 25) ----------------------------------------------------------------------------------
//
// Replaces sp_dash_getLabStats (VL), sp_dash_getLabStatsEID (EID) and sp_dash_getTBLabStats (TB). Each is a monthly dashboard with one row
// per testing laboratory. Each procedure joins two halves:
//   a  the tests: the copy table (HIVVL, EID, TBGNX), rebuilt here by hivvlCte, eidCte and tbgnxCte;
//   b  the requests: v1's Requests table, here lab_requests with its report (one row per request row and report).
// Both halves are grouped by testing lab, and the lab codes compare as SQL Server compares text (case and trailing spaces ignored).
//
// Parameters (spec ruling 3): `from` and `to`, YYYY-MM-DD, both required. v1 defaulted a missing start to the first day of the month before
// last and a missing end to the last day of last month, and added a day to a given end date (line 20). The day is added here too.
//
// Window. v1 compares DATETIME columns with the two dates, so a stamp counts from `from` 00:00:00 up to and including (to + 1 day) 00:00:00.
// A stamp at exactly midnight of the day after `to` is in, one second later is out (the same decision as Tasks 7 and 8). The time is the
// stamp's own local wall time. TB's authorised stamp is cast to a date first, so there the whole day after `to` counts.
//
// Testing lab (spec ruling 5). The testing lab of a test or a request is the performer of its report, which cdr writes from OPENLDR_LAB_CODE
// for each push (cdr v2-transform.ts:401). v1 uses the testing code and falls back to the receiving code when the testing code is blank
// (`len(TestingFacilityCode) = 0`, lines 41-43). CE does not carry the receiving code (spec ruling 7), so a request or test with a blank or
// no testing code has no lab. It is left out of the list (a NULL code is in no `in` list and is not numeric) and never counted.
//
// Rates are SQL Server's `int * 100.0 / int`: decimal(26,12), the quotient CUT at 12 decimals, not rounded (rateCutSql; measured on the
// local SQL Server: 2 of 3 gives 66.666666666666). TB's rate columns are float (`cast(.. as float) * 100.0 / nullif(.., 0)`). A rate over
// nothing is NULL, and so is any column read from a missing half of the join.
//
// Referrals (VL and EID) are NULL in every row. v1's Referral flag needs the receiving lab code, which CE does not carry (spec ruling 7;
// referralSql returns NULL), and `sum(Referral) * 100.0 / count(*)` over NULLs is NULL. It is not coalesced to 0, because v1 does not.
// Disalink comes from the builders' disalink column (the attributes prereg-registration-facility and referring-request-id); cdr does not
// fill them yet, so it is 0 until it does.
//
// Lab names (spec ruling 8). Each procedure has a constant CASE on the TEST lab code (a.TestedAt), and for any other lab reads the name from
// its Laboratories dictionary. The CASE is kept as it is. CE has no dictionary: the name is the report's (labNameSql: the display, else the
// register name of the mapped code, else the code) with ONE name per lab code, the Task 16 rule (labNamesCte): rows never split on per-report
// names; the group has the name of its rows that is not just the code, the smallest in byte order. The names are read from the REQUEST rows
// that are listed (VL, TB) or the TEST rows (EID), the half v1's dictionary join hangs off. Where a request row's own testing code differs from
// the folded lab code (ZUB in lab ZUL, ZLP in lab ZLR, ZUA in lab ZUE) it does not name the lab: the lab's name is then the code itself unless
// a row with that very code has a name. Why: v1 keys the dictionary on the folded code (VL lines 97-98, TB lines 89-90), so the name belongs to
// the folded code and not to any raw code that folds into it. The rule never changes a shown name in EID: its folds only touch codes that
// have a constant name (ZUL, ZLR, ZUE), and the constant wins over the dictionary name. The rows are ordered by lab name, as v1 orders by its first column, in SQL Server's text order
// (ssTextKey), then by every other column so that CE can page the result.
//
// Windows: the three queries take the same two parameters.

const START = '({{param.from}})::date::timestamp';
const END = '(({{param.to}})::date + 1)::timestamp';
// v1 `datetime BETWEEN @StartDate AND @EndDate` (dates, the end already moved a day).
const inWindow = (stamp) => `(${localTs(stamp)} >= ${START} and ${localTs(stamp)} <= ${END})`;
// v1 `cast(datetime as date) BETWEEN @StartDate AND @EndDate`: the whole local day counts at both ends.
const authorisedDay = (stamp) => `${localDate(stamp)} between ({{param.from}})::date and ({{param.to}})::date + 1`;

// decimal(26,12), cut. NULL when the count is 0 or either side is NULL.
const rate = (top, count) => `(${rateCutSql(top, count)})::numeric(26,12)`;
// float: `cast(top as float) * 100.0 / nullif(count, 0)`.
const floatRate = (top, count) => `(${top})::float8 * 100.0 / nullif(${count}, 0)`;

// The request half (v1 CTE b): a request row with its report. A request with no report has no testing code, so no lab. A request with two
// reports counts once per report (v1 has one testing code per request row; CE has one per report).
// Steps: rq (the rows of the panels registered in the window), rz (a code like ZU_ becomes ZUL unless the testing code is ZUE or ZUA; VL and
// EID only), rc (ZLP becomes ZLR; VL and EID only).
const requestsCte = (panels, { fold }) => `rq as (
  select lr.request_id, lr.analysis_at, dr.issued, dr.status, dr.performer as testing, ${testingCodeSql('dr')} as base, ${labNameSql('dr')} as report_name
  from lab_requests lr
  left join diagnostic_reports dr on dr.based_on_id = lr.id
  where ${inListSql('lr.panel_code', panels)}
    and ${inWindow('lr.authored_at')}
),
rz as (
  select q.*, ${fold ? testedAtSql('q.base', 'q.testing') : 'q.base'} as zu
  from rq q
),
rc as (
  select z.*, ${fold ? `case when ${foldSql('z.zu')} = 'zlp' then 'ZLR' else z.zu end` : 'z.zu'} as code
  from rz z
)`;

// The rows that name the labs, for labNamesCte (`src`: code, report_name). See "Lab names" above.
const nameRows = (rows) => `src as (
  select r.code as code, case when ${foldSql('r.testing')} = ${foldSql('r.code')} then r.report_name else r.code end as report_name
  from ${rows} r
)`;

// The constant CASE on the test lab: `key` is the folded lab code of the test half (NULL when the lab has no test).
const labCase = (key, pairs) => `case ${key} ${pairs.map(([code, name]) => `when ${sqlLit(code.toLowerCase())} then ${sqlLit(name)}`).join(' ')} else n.lab_name end`;

// The final select over `res` (columns c01, c02, ...): v1 names, and the order: the lab name, then every other column.
function finalSelect(labels) {
  const cols = labels.map((_, i) => `c${String(i + 1).padStart(2, '0')}`);
  const select = cols.map((c, i) => `res.${c} as "${labels[i]}"`).join(',\n  ');
  const order = [`${ssTextKey('res.c01')} collate "C" nulls first`, 'res.c01 collate "C" nulls first', ...cols.slice(1).map((c) => `res.${c} nulls first`)].join(',\n  ');
  return `select ${select}\nfrom res\norder by ${order}`;
}

// ---- VL lab performance -------------------------------------------------------------------------------------------------------------
//
// Replaces sp_dash_getLabStats. One row per testing lab that has a viral load request in the window.
//
// Columns (v1 names and order, 16): Laboratory, CollectedDate, ReceivedDate, VLTestRequests, ProcessedNotReviewed, ReviewedWithInvalids,
// ValidTests, ValidTestsTotal, LabThroughput1, LabThroughput2, Referrals, Disalink, Suppressed, LabTestedWithin3days, LabTestedWithin7days,
// LabTestedWithin14days.
//
// What v1 does (lines):
//   a (21-38)  the HIVVL rows (hivvlCte) whose lab is listed (27 codes, line 32) or numeric (a point-of-care site: isnumeric), tested in the
//              window (line 33); lab ZLP is lab ZLR (line 24). Per lab: CollectedDate and ReceivedDate are the share of tests with that date;
//              ValidTests the tests registered AND tested in the window (line 26); ValidTestsTotal all the tests; Referrals, Disalink and
//              Suppressed the share of tests with the flag; LabTestedWithin3/7/14days the share tested at most 3, 7 or 14 days after they
//              were registered (lines 28-30).
//   b (39-66)  the requests of the panels HIVVL, POCVR and POHVL registered in the window (lines 49, 60) whose lab code (after the ZU_ and ZLP
//              folds, lines 41-42) is listed or numeric (lines 50-59): VLTestRequests, ProcessedNotReviewed (analysis stamp) and
//              ReviewedWithInvalids (authorised stamp).
//   final      b LEFT JOIN a (lines 95-98): a lab with requests and no tests shows with every test column NULL; a lab with tests and no
//              request in the window does not show. LabThroughput1 is ValidTests and LabThroughput2 ValidTestsTotal, as a share of VLTestRequests.
//
// Kept v1 quirks (spec ruling 1):
//   - The join starts from the requests (above), so a lab's tests are lost when it has no request in the window.
//   - The constant lab name is chosen by the TEST lab (a.TestedAt, line 68). A lab with requests and no tests gets the dictionary's name
//     even if it is one of the 23 constants.
//   - ValidTests and ValidTestsTotal count tests, VLTestRequests counts request rows (count(requestid), line 45): a lab number with two
//     request rows (OBR sets) counts twice, and a request with no result counts although it has no test. A lab can be above 100%.
//   - Days from registration to test are datediff(dd): date boundaries of the LOCAL dates, taken from the stamp's own text. A test before
//     its registration counts in every cut-off; a test with no registered stamp in none (and is not a valid test).
//   - The two lab lists are one list (27 codes), so they repeat it: a, filtered on the raw lab, and b, filtered on the folded one. The ZUH,
//     ZUX and ZUP entries are dead (the ZU_ fold makes them ZUL before the list is read); ZLP is live in a.
//   - The ZU_ fold (line 41) matches ZUB and also 'ZU ' (likeVarcharSql) and takes ZUE and ZUA out of it.
//   - An `isnumeric` lab code is any text SQL Server calls a number: 001, 12, 1E5.
//   - The request half has no register join and no report status test: a request whose facility is not in the register, or whose report is
//     cancelled, counts in b. The test half needs a mapped facility and a final report (the builder).
//
// CE gaps (spec ruling 7): Referrals (above); a request or test whose report has no testing code is dropped (no receiving lab).
//
// Deviations (spec ruling 3): the default window becomes the required `from` and `to`.
const VL_LABS = ['ZAP', 'ZBP', 'ZCH', 'ZCM', 'ZCN', 'ZCD', 'ZCP', 'ZFP', 'ZKM', 'ZKS', 'ZKT', 'ZLR', 'ZLP', 'ZMB', 'ZMG', 'ZML', 'ZMP', 'ZNP', 'ZSJ',
  'ZSP', 'ZTV', 'ZUL', 'ZUA', 'ZUE', 'ZUH', 'ZUX', 'ZUP'];
const VL_PANELS = ['HIVVL', 'POCVR', 'POHVL'];
const VL_NAMES = [
  ['ZMP', 'Lewanika General Hospital'], ['ZCM', 'Choma General Hospital'], ['ZFP', 'Levy Mwanawasa UTH'], ['ZKM', 'Kaoma District Hospital'],
  ['ZKS', 'Kasama General Hospital'], ['ZSJ', 'Serenje District Hospital'], ['ZUL', 'UTH Virology Laboratory'],
  ['ZCP', 'Chipata Central Hospital'], ['ZML', 'Mansa General Hospital'], ['ZUA', 'UTH HAP ACOE'], ['ZCH', 'CHAZ Complex Laboratory'],
  ['ZNP', 'Ndola Teaching Hospital'], ['ZLR', 'Livingstone Teaching Hospital'], ['ZMG', 'Minga Mission Hospital'],
  ['ZBP', 'Kabwe General Hospital'], ['ZCN', 'Chinsali District Hospital'], ['ZCD', 'New Chinsali District Hospital'],
  ['ZKT', 'Kitwe Teaching Hospital'], ['ZMB', 'Mazabuka General Hospital'], ['ZSP', 'Solwezi General Hospital'],
  ['ZAP', 'Arthur Davison Childrens Hospital'], ['ZUE', 'UTH HAP PCOE'], ['ZTV', 'TDRC Laboratory'],
];

export function vlLabPerformanceSql() {
  const listed = (code) => `(${inListSql(code, VL_LABS)} or ${isNumericSql(code)})`;
  const days = (v, n) => count1(`${localDate(`${v}.tested_date`)} - ${localDate(`${v}.registered_date`)} <= ${n}`);
  return `with ${hivvlCte('hv', { from: 'from', to: 'to', extraDays: 1 })},
vt as (
  select case when ${foldSql('h.tested_at')} = 'zlp' then 'ZLR' else h.tested_at end as code,
    h.collected_date, h.received_date, h.registered_date, h.tested_date, h.referral, h.disalink, h.suppressed
  from hv h
  where ${listed('h.tested_at')}
    and ${localTs('h.tested_date')} <= ${END}
),
ag as (
  select ${foldSql('v.code')} as k, count(*) as n, count(v.collected_date) as n_collected, count(v.received_date) as n_received,
    ${count1(inWindow('v.registered_date'))} as valid, sum(v.referral) as referral, sum(v.disalink) as disalink, sum(v.suppressed) as suppressed,
    ${days('v', 3)} as w3, ${days('v', 7)} as w7, ${days('v', 14)} as w14
  from vt v
  group by ${foldSql('v.code')}
),
${requestsCte(VL_PANELS, { fold: true })},
rb as (
  select c.* from rc c where ${listed('c.code')}
),
${nameRows('rb')},
${labNamesCte()},
bg as (
  select ${foldSql('c.code')} as k, count(c.request_id) as n_req, ${count1('c.analysis_at is not null')} as n_proc, ${count1('c.issued is not null')} as n_rev
  from rb c
  group by ${foldSql('c.code')}
),
res as (
  select ${labCase('a.k', VL_NAMES)} as c01,
    ${rate('a.n_collected', 'a.n')} as c02, ${rate('a.n_received', 'a.n')} as c03,
    b.n_req as c04, b.n_proc as c05, b.n_rev as c06, a.valid as c07, a.n as c08,
    ${rate('a.valid', 'b.n_req')} as c09, ${rate('a.n', 'b.n_req')} as c10,
    ${rate('a.referral', 'a.n')} as c11, ${rate('a.disalink', 'a.n')} as c12, ${rate('a.suppressed', 'a.n')} as c13,
    ${rate('a.w3', 'a.n')} as c14, ${rate('a.w7', 'a.n')} as c15, ${rate('a.w14', 'a.n')} as c16
  from bg b
  left join ag a on a.k = b.k
  left join names n on n.code_key = b.k
)
${finalSelect(['Laboratory', 'CollectedDate', 'ReceivedDate', 'VLTestRequests', 'ProcessedNotReviewed', 'ReviewedWithInvalids', 'ValidTests',
    'ValidTestsTotal', 'LabThroughput1', 'LabThroughput2', 'Referrals', 'Disalink', 'Suppressed', 'LabTestedWithin3days', 'LabTestedWithin7days',
    'LabTestedWithin14days'])}`;
}

// ---- EID lab performance ------------------------------------------------------------------------------------------------------------
//
// Replaces sp_dash_getLabStatsEID. One row per testing lab that has a final EID test in the window.
//
// Columns (v1 names and order, 23): Laboratory, CollectedDate, ReceivedDate, EIDTestRequests, ProcessedNotReviewed, ReviewedWithInvalids,
// ValidTests, ValidTestsTotal, LabThroughput1, LabThroughput2, Rejections, Referrals, Disalink, Positive, Negative, Indeterminate, Error,
// Invalid, LabTestedWithin1days, LabTestedWithin2days, LabTestedWithin3days, LabTestedWithin7days, LabTestedWithin14days.
//
// What v1 does (lines):
//   a (21-46)  the EID rows (eidCte) of every lab but ZZZ, MNC, MZM, ZNN and XXX (line 39), tested in the window (line 40); ZLP is ZLR and ZUA
//              is ZUE (lines 23-26). Per lab: the share of tests with a collected date, a received date, the result classes the builder sets
//              (Positive, Negative, Indeterminate, Error, Invalid), and the share tested at most 1, 2, 3, 7 and 14 days after they were RECEIVED
//              (lines 33-37; the other two procedures count from registration). ValidTests, Referrals and Disalink as in the VL report.
//   b (47-70)  the requests of the panels HIVPC, POCGH and POEID registered in the window, with the same lab folds as the VL report but ZUA
//              kept as it is; EIDTestRequests, ProcessedNotReviewed, ReviewedWithInvalids and Rejections (report status X).
//   final      a LEFT JOIN b (lines 110-111, the opposite of the VL and TB reports): a lab with tests and no request in the window shows with
//              the b columns and both throughputs NULL; a lab with requests and no tests does not show.
//
// Kept v1 quirks (spec ruling 1):
//   - The left join (above). Division by a missing b is NULL in SQL Server (NULL arithmetic does not raise), so no error is possible: a b row
//     only exists when it has at least one request (a group), so the divisor is never 0. The port gives NULL as v1 does.
//   - ZUA is folded into ZUE in a (line 25) but not in b (line 49 keeps ZUA, and takes it out of the ZUL fold). A ZUA test is therefore counted
//     in the ZUE row ("UTH HAP PCOE"), while that row's request counts are those of testing code ZUE only. ZUA requests are a group of their
//     own that no test group matches, so they are never output. A lab with ZUA tests and no ZUE request shows NULL request columns, and a
//     lab with many ZUA tests and few ZUE requests shows a throughput above 100%.
//   - The constant name for ZUA ("UTH HAP PCOE", line 82) can never be reached, because a has no ZUA after the fold. It is kept.
//   - There is no list of labs, only the five excluded codes; any other code, numeric or not, is a lab. Excluded codes are tested in a and b.
//   - Days to test are datediff(dd, RecievedDate, TestedDate): LOCAL date boundaries; a test with no received stamp is in no cut-off; a test
//     before its receipt is in all of them.
//   - The result classes are the builder's lists ('INVAL' sets no class, 'VALID' sets Invalid). A result on no list counts in no class.
//   - Rejections counts requests with report status cancelled, which is v1's X. CE folds v1's other statuses to unknown, so those are not seen.
//
// CE gaps (spec ruling 7): Referrals (above). A request or test whose report has no testing code is dropped.
//
// Deviations (spec ruling 3): the default window becomes the required `from` and `to`.
const EID_OUT = ['ZZZ', 'MNC', 'MZM', 'ZNN', 'XXX'];
const EID_PANELS = ['HIVPC', 'POCGH', 'POEID'];
const EID_NAMES = [
  ...VL_NAMES.map(([code, name]) => [code, code === 'ZUA' ? 'UTH HAP PCOE' : name]),
  ['001', 'St. Luke Mission Hospital(Mphanshya)'], ['002', 'Chinyunyu Rural Health Center'], ['003', 'Chipata District Hospital'],
  ['004', 'Nyimba District Hospital'], ['005', 'Kalomo District Hospital'], ['013', 'Lundazi District Hospital'],
  ['ZMM', 'Musumali Health Post'], ['ZMT', 'Matero General Hospital'], ['ZMJ', 'Mwanjuni Health Post'], ['ZCW', 'Chawama General Hospital'],
];

export function eidLabPerformanceSql() {
  const days = (n) => count1(`${localDate('t.tested_date')} - ${localDate('t.recieved_date')} <= ${n}`);
  return `with ${eidCte('ed', { from: 'from', to: 'to', extraDays: 1, rowIds: true })},
et as (
  select case ${foldSql('e.tested_at')} when 'zlp' then 'ZLR' when 'zua' then 'ZUE' else e.tested_at end as code, e.tested_at as testing,
    ${labNameSql('dr')} as report_name, e.collected_date, e.recieved_date, e.registered_date, e.tested_date, e.referral, e.disalink,
    e.positive, e.negative, e.indeterminate, e.error, e.invalid
  from ed e
  join diagnostic_reports dr on dr.id = e.report_row_id
  where not (${inListSql('e.tested_at', EID_OUT)})
    and ${localTs('e.tested_date')} <= ${END}
),
ag as (
  select ${foldSql('t.code')} as k, count(*) as n, count(t.collected_date) as n_collected, count(t.recieved_date) as n_received,
    ${count1(inWindow('t.registered_date'))} as valid, sum(t.referral) as referral, sum(t.disalink) as disalink,
    sum(t.positive) as positive, sum(t.negative) as negative, sum(t.indeterminate) as indeterminate, sum(t.error) as error, sum(t.invalid) as invalid,
    ${days(1)} as w1, ${days(2)} as w2, ${days(3)} as w3, ${days(7)} as w7, ${days(14)} as w14
  from et t
  group by ${foldSql('t.code')}
),
${requestsCte(EID_PANELS, { fold: true })},
rb as (
  select c.* from rc c where not (${inListSql('c.code', EID_OUT)})
),
bg as (
  select ${foldSql('c.code')} as k, count(c.request_id) as n_req, ${count1('c.analysis_at is not null')} as n_proc, ${count1('c.issued is not null')} as n_rev,
    ${count1(`${foldSql('c.status')} = 'cancelled'`)} as n_rej
  from rb c
  group by ${foldSql('c.code')}
),
${nameRows('et')},
${labNamesCte()},
res as (
  select ${labCase('a.k', EID_NAMES)} as c01,
    ${rate('a.n_collected', 'a.n')} as c02, ${rate('a.n_received', 'a.n')} as c03,
    b.n_req as c04, b.n_proc as c05, b.n_rev as c06, a.valid as c07, a.n as c08,
    ${rate('a.valid', 'b.n_req')} as c09, ${rate('a.n', 'b.n_req')} as c10, b.n_rej as c11,
    ${rate('a.referral', 'a.n')} as c12, ${rate('a.disalink', 'a.n')} as c13, ${rate('a.positive', 'a.n')} as c14, ${rate('a.negative', 'a.n')} as c15,
    ${rate('a.indeterminate', 'a.n')} as c16, ${rate('a.error', 'a.n')} as c17, ${rate('a.invalid', 'a.n')} as c18,
    ${rate('a.w1', 'a.n')} as c19, ${rate('a.w2', 'a.n')} as c20, ${rate('a.w3', 'a.n')} as c21, ${rate('a.w7', 'a.n')} as c22, ${rate('a.w14', 'a.n')} as c23
  from ag a
  left join bg b on b.k = a.k
  left join names n on n.code_key = a.k
)
${finalSelect(['Laboratory', 'CollectedDate', 'ReceivedDate', 'EIDTestRequests', 'ProcessedNotReviewed', 'ReviewedWithInvalids', 'ValidTests',
    'ValidTestsTotal', 'LabThroughput1', 'LabThroughput2', 'Rejections', 'Referrals', 'Disalink', 'Positive', 'Negative', 'Indeterminate', 'Error',
    'Invalid', 'LabTestedWithin1days', 'LabTestedWithin2days', 'LabTestedWithin3days', 'LabTestedWithin7days', 'LabTestedWithin14days'])}`;
}

// ---- TB lab performance -------------------------------------------------------------------------------------------------------------
//
// Replaces sp_dash_getTBLabStats. One row per testing lab that has a GeneXpert request in the window.
//
// Columns (v1 names and order, 24): Laboratory, CollectedDate, ReceivedDate, TBTestRequests, TotalTests, ProcessedNotReviewed,
// ReviewedWithInvalids, LabThroughput, LabThroughput2, MTB_Positive, RIF_Positive, RIF_Indeterminate, NoResults, Errors, Invalids,
// MTB_Positivity, No_Result_Rate, RIF_IND_Rate, Error_Rate, Invalid_Rate, RIF_RES_Rate, TATW24H, TATW48H, TATW72H.
//
// What v1 does (lines):
//   a (21-46)  the TBGNX rows (tbgnxCte) of every lab but ZZZ, XXX and 000 (line 41), with NO date filter (line 42 is commented out). Per lab:
//              CollectedDate and ReceivedDate (shares), TotalTests (the only windowed measure, line 23), the counts MTB_Positive,
//              RIF_Positive, RIF_Indeterminate, Errors, Invalids and NoResults (lines 24-29), and the rates over all rows (lines 30-39).
//   b (47-59)  the requests of the panels TBGNX and POCGT registered in the window, with the lab not ZZZ, XXX, 000 or blank (line 55).
//              TBTestRequests, ProcessedNotReviewed and ReviewedWithInvalids. There is no ZU_ or ZLP fold in this report.
//   final      b LEFT JOIN a (lines 87-90), as in the VL report. LabThroughput is ReviewedWithInvalids and LabThroughput2 TotalTests, each as a
//              share of TBTestRequests; the first reads b alone, so it shows even for a lab with no tests. AverageTAT (line 36) is
//              computed and not returned.
//
// Kept v1 quirks (spec ruling 1, and the controller's ruling on the TB window gap):
//   - THE WINDOW GAP. Only TBTestRequests, ProcessedNotReviewed, ReviewedWithInvalids, LabThroughput and (through its two date conditions)
//     TotalTests depend on the dates. CollectedDate, ReceivedDate, MTB_Positive, RIF_Positive, RIF_Indeterminate, NoResults, Errors,
//     Invalids and every rate and TAT share count ALL tests, whatever their date. A lab's rates therefore do not change when the window
//     moves. v1's own note says to filter them too; that is a change, so it is not done. (The inventory suggests "fix by filtering all";
//     the spec's ruling 1 outranks it.)
//   - TotalTests needs RegisteredDateTime in the window (a datetime: midnight of the day after `to` is the last instant) AND the authorised
//     stamp cast to a date from `from` to the day after `to` (the whole last day counts).
//   - The join starts from the requests: a lab with tests and no request in the window does not show; a lab with requests and no test
//     ever shows the b columns and NULL for the rest. The constant name is chosen by the TEST lab (a.TestedAt), so such a lab gets the
//     dictionary's name.
//   - MTB_Positive is MTB = 'MTB Detected' and RIF_Positive RIF in (Detected, DET, Detected_Low) on the cleaned results (tbgnxCte). The rate
//     columns spell the last word 'DEtected_Low'; the collation makes it the same word. A reported 'Detected _ Low' (with spaces) is not on
//     the list.
//   - Errors, Invalids and NoResults test the MTB and the RIF result: any of the two. An empty MTB result counts as no result; a missing
//     one (NULL) does not.
//   - RIF_RES_Rate and RIF_IND_Rate divide by the MTB-positive count, so they are NULL for a lab with no MTB-positive test.
//   - The TB report has no lab fold: ZUB is its own lab, not ZUL.
//   - TBGNX has one row per GXMTB result with no dedupe, and v_GeneXpert joins GXRIF to GXMTB on equal facts (tbgnxCte, Task 4, not solved
//     again here): a request with a missing fact loses its RIF result, so it is not a RIF test.
//
// CE gaps (spec ruling 7): none of its own. A request or test whose report has no testing code is dropped (no receiving lab: line 49
// falls back to it in v1).
//
// Deviations (spec ruling 3): the default window becomes the required `from` and `to`.
const TB_OUT = ['ZZZ', 'XXX', '000'];
const TB_PANELS = ['TBGNX', 'POCGT'];
const TB_NAMES = [
  ['ZMP', 'Lewanika General Hospital'], ['ZCM', 'Choma General Hospital'], ['ZFP', 'Levy Mwanawasa UTH'], ['ZKM', 'Kaoma District Hospital'],
  ['ZKS', 'Kasama General Hospital'], ['ZSJ', 'Serenje District Hospital'], ['ZUL', 'UTH Virology Laboratory'],
  ['ZCP', 'Chipata Central Hospital'], ['ZML', 'Mansa General Hospital'], ['ZCH', 'CHAZ Complex Laboratory'],
  ['ZNP', 'Ndola Teaching Hospital'], ['ZLR', 'Livingstone Teaching Hospital'], ['ZMG', 'Minga Mission Hospital'],
  ['ZBP', 'Kabwe General Hospital'], ['ZCN', 'Chinsali District Hospital'], ['ZKT', 'Kitwe Teaching Hospital'],
  ['ZMB', 'Mazabuka General Hospital'], ['ZSP', 'Solwezi General Hospital'], ['ZAP', 'Arthur Davison Childrens Hospital'],
  ['ZTT', 'TDRC Laboratory'], ['ZNY', 'Nyimba District Hospital Laboratory'],
];

export function tbLabPerformanceSql() {
  // The tests of lines 24-29 on the cleaned results of tbgnxCte. Text compares ignore case and trailing spaces.
  const mtb = inListSql('t.mtb', ['MTB Detected']);
  const rifPositive = inListSql('t.rif', ['Detected', 'DET', 'Detected_Low']);
  const rifIndeterminate = inListSql('t.rif', ['Indeterminate']);
  const error = `(${inListSql('t.mtb', ['Error'])} or ${inListSql('t.rif', ['Error'])})`;
  const invalid = `(${inListSql('t.mtb', ['Invalid'])} or ${inListSql('t.rif', ['Invalid'])})`;
  const noResult = `(${inListSql('t.mtb', ['No Results', ''])} or ${inListSql('t.rif', ['No Results', ''])})`;
  return `with ${tbgnxCte('tb')},
tt as (
  select t.requestid, t.tested_at, t.specimen_date_time, t.received_date_time, t.registered_date_time, t.authorised_date_time, t.mtb, t.rif,
    t.w24h, t.w48h, t.w72h
  from tb t
  where not (${inListSql('t.tested_at', TB_OUT)})
),
ag as (
  select ${foldSql('t.tested_at')} as k, count(t.requestid) as n, count(t.specimen_date_time) as n_collected, count(t.received_date_time) as n_received,
    ${count1(`${inWindow('t.registered_date_time')} and ${authorisedDay('t.authorised_date_time')}`)} as total,
    ${count1(mtb)} as mtb_positive, ${count1(rifPositive)} as rif_positive, ${count1(rifIndeterminate)} as rif_indeterminate,
    ${count1(error)} as errors, ${count1(invalid)} as invalids, ${count1(noResult)} as no_results,
    ${count1(`${mtb} and ${rifPositive}`)} as mtb_rif_positive, ${count1(`${mtb} and ${rifIndeterminate}`)} as mtb_rif_indeterminate,
    sum(t.w24h) as w24, sum(t.w48h) as w48, sum(t.w72h) as w72
  from tt t
  group by ${foldSql('t.tested_at')}
),
${requestsCte(TB_PANELS, { fold: false })},
rb as (
  select c.* from rc c where not (${inListSql('c.code', [...TB_OUT, ''])})
),
${nameRows('rb')},
${labNamesCte()},
bg as (
  select ${foldSql('c.code')} as k, count(c.request_id) as n_req, ${count1('c.analysis_at is not null')} as n_proc, ${count1('c.issued is not null')} as n_rev
  from rb c
  group by ${foldSql('c.code')}
),
res as (
  select ${labCase('a.k', TB_NAMES)} as c01,
    ${rate('a.n_collected', 'a.n')} as c02, ${rate('a.n_received', 'a.n')} as c03,
    b.n_req as c04, a.total as c05, b.n_proc as c06, b.n_rev as c07,
    ${rate('b.n_rev', 'b.n_req')} as c08, ${rate('a.total', 'b.n_req')} as c09,
    a.mtb_positive as c10, a.rif_positive as c11, a.rif_indeterminate as c12, a.no_results as c13, a.errors as c14, a.invalids as c15,
    ${floatRate('a.mtb_positive', 'a.n')} as c16, ${floatRate('a.no_results', 'a.n')} as c17,
    ${floatRate('a.mtb_rif_indeterminate', 'a.mtb_positive')} as c18, ${floatRate('a.errors', 'a.n')} as c19, ${floatRate('a.invalids', 'a.n')} as c20,
    ${floatRate('a.mtb_rif_positive', 'a.mtb_positive')} as c21,
    ${floatRate('a.w24', 'a.n')} as c22, ${floatRate('a.w48', 'a.n')} as c23, ${floatRate('a.w72', 'a.n')} as c24
  from bg b
  left join ag a on a.k = b.k
  left join names n on n.code_key = b.k
)
${finalSelect(['Laboratory', 'CollectedDate', 'ReceivedDate', 'TBTestRequests', 'TotalTests', 'ProcessedNotReviewed', 'ReviewedWithInvalids',
    'LabThroughput', 'LabThroughput2', 'MTB_Positive', 'RIF_Positive', 'RIF_Indeterminate', 'NoResults', 'Errors', 'Invalids', 'MTB_Positivity',
    'No_Result_Rate', 'RIF_IND_Rate', 'Error_Rate', 'Invalid_Rate', 'RIF_RES_Rate', 'TATW24H', 'TATW48H', 'TATW72H'])}`;
}

export function queries() {
  return [
    { name: 'VL lab performance', sql: vlLabPerformanceSql(), params: dateParams(true) },
    { name: 'EID lab performance', sql: eidLabPerformanceSql(), params: dateParams(true) },
    { name: 'TB lab performance', sql: tbLabPerformanceSql(), params: dateParams(true) },
  ];
}

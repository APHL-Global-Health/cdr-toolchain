// Custom queries for the lab-ops reports. Each task adds { name, sql, params } entries to the list.

import { foldSql, inListSql, isNumericSql } from '../../vl-reports-mz/vl-queries.mjs';
import {
  ATTR_SYSTEM, count1, dateParams, eidCte, hivvlCte, labNameSql, labNamesCte, localDate, localTs, requestAttrSql, sqlLit, ssTextKey, tbgnxCte, testedAtSql,
  testingCodeSql,
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

// ---- The three data quality and DISA Link reports (Task 26) ---------------------------------------------------------------------------
//
// Replaces sp_DQ_DaysSinceLastVLEIDTans, sp_DQ_VLEIDSuspectedWrongSampleCollectionDateEntries and sp_getDisaLinkStats (with its body
// fn_WeeklyDisaLinkUpdate; fn_WeeklyDisaLinkUpdate2 and 3 are dropped). Lab names follow the Task 16 rule (labNamesCte).
//
// Parameters. All date parameters are text, YYYY-MM-DD, required (a final wave adds shared validation).
//
// Row order. v1 orders by its first columns and CE pages a result with LIMIT and OFFSET, so each query orders by every output column: text
// in SQL Server's word order (ssTextKey, then the plain text), a number as a number, a missing value first.
//
// Collection date. A report's collection date is diagnostic_reports.effective (SpecimenDateTime): the same source as the hivvl, eid and
// geneXpert/tbgnx builders (zm-sql.mjs:601 reportSourceSql, :1103 eidCte, :1184 geneXpertCte). specimens.collected_time is not read anywhere
// in the pack.

// ---- Days since last transmission ----
//
// Replaces sp_DQ_DaysSinceLastVLEIDTans (D below). One row per laboratory: the days since it last sent data, the smaller of two counts.
// Columns (v1 names and order): Province, LabCode, LabName, LastTransmission.
// Parameter `from`: v1's 2019 floor (D lines 30 and 44, `RegisteredDateTime > '20190101'`).
//
// What v1 does (lines):
//   a (18-36)  the requests registered after the floor, per lab: datediff(dd, max(RegisteredDateTime), getdate()). The lab is the receiving
//              code when one is set, else the testing code (reverse of the usual order); it must be in the Laboratories dictionary.
//   b (37-51)  per Laboratories row: the requests whose DISA Link pre-registration facility (LIMSPreReg_RegistrationFacilityCode) is the lab's
//              FacilityCode, registered after the floor: datediff(dd, max(AuthorisedDateTime), getdate()). Labs with no such request, or
//              with no authorised stamp, or with a value of -1, are left out (line 50).
//   final      a UNION b, per province (of the lab's facility), code and name: the MIN of the two counts. The lab code is not one of the
//              45 codes of line 62. Ordered by province, then lab name.
//
// Kept v1 quirks (spec ruling 1):
//   - THE DEFINITION. LastTransmission is the age of the latest REGISTRATION (a) or latest AUTHORISATION of a DISA Link pre-registration (b),
//     not the arrival of data in CE (ingest_events would be a different fact). The controller's ruling 1.
//   - The floor is strict: `RegisteredDateTime > 2019-01-01 00:00:00`. A stamp at exactly the floor's midnight is out, a second later is in.
//     The floor applies to the registered stamp in both parts (line 44 puts it in b's join).
//   - Days are date boundaries between the LOCAL date of the stamp's text and today's date in Zambia (datediff(dd), whole dates, not
//     24-hour periods, not UTC). A stamp tomorrow gives -1; part a keeps it. Part b drops a value of exactly -1 (line 50 tests
//     `isnull(x, -1) != -1`), so an authorised stamp one day ahead is dropped, two days ahead (-2) is kept.
//   - `having min(LastTransmission) < getdate()` (line 64) compares an int with a datetime (days since 1900). It is always true. Kept as
//     no condition at all.
//   - The exclusion list is v1's own constant (line 62, 45 lab codes). It is pack content and stays in the query. It applies to the folded
//     code, so case and trailing spaces do not matter, and a leading space does. It cuts part b rows as well.
//   - Part a counts every panel (D lines 18-36 have no panel condition): a lab whose only requests are TB, COVID or any other panel is listed.
//   - Part b has no panel or status condition: any request pre-registered at the facility counts.
//   - Text compares ignore case and trailing spaces. Two spellings of one lab code are one lab. The code shown is the smallest spelling in
//     byte order.
//   - A lab with a part a row but no part b row is shown with part a; a lab with a part b row but no part a row is shown with part b, provided
//     it has a report somewhere in CE (see the gap below).
//
// CE gaps (spec rulings 7 and 8):
//   - A DISA Link site in v1's Laboratories that never tests has a part b row only in v1. CE has no Laboratories list: a lab exists only through a
//     report's testing code, so such a site has no row in CE.
//   - v1's lab key is ReceivingFacilityCode when set, else TestingFacilityCode. CE carries no receiving code, so the key is the testing
//     code, diagnostic_reports.performer. cdr writes it from its configured OPENLDR_LAB_CODE for each push (cdr v2-transform.ts:401), so
//     the lab is the lab that PUSHED the data, which v1's receiving lab is not always. A request with no report, or a blank or missing
//     testing code, has no lab and is left out.
//   - There is no Laboratories dictionary, so the inner join to it (which drops codes it does not hold) is not reproduced: every code is a
//     lab. The name is the report's name with one name per code (labNamesCte), read from every report of the code (a dictionary does not
//     depend on the floor).
//   - Part b needs the lab's FacilityCode (Laboratories.FacilityCode), which CE does not hold. The port uses the register facility the lab
//     code is mapped to in facility_map (same source and performer systems as the report, registry_id set): a pre-registration belongs to
//     the lab when its facility code (request attribute 'prereg-registration-facility', read with requestAttrSql) maps to the SAME register
//     facility. The province is the region of that mapping (v1: HealthcareAreas via Facilities). A lab with no register mapping has no
//     province and no part b row. This is the port's assumption; the dictionary (QUESTIONS-FOR-ZM.md question 1) would settle it.
//   - The pre-registration attribute is not filled by cdr-toolchain yet and Zambia's feed is not measured: part b is empty on real data
//     until it is. Part a works now.
//   - "Today" is the Zambian date, (now() at time zone 'Africa/Lusaka')::date: v1's getdate() is the clock of Zambia's SQL Server.
//
// Deviations: none (the floor is a parameter, ruling 3).
const D_EXCLUDED = ['ZXZ', 'ZZZ', 'MZM', 'MNC', 'XXX', 'ZNA', 'ZNC', 'ZLA', '005', '144', '028', '004', 'ZFI', '022', 'POC', 'ZDR', 'MAC', 'MAF',
  'MDR', 'ZCX', 'ZLX', 'ZMR', '094', '095', '068', '108', '001', '015', '073', '054', '009', '055', '091', '128', '131', '153', '154', '155',
  '125', '132', '161', '074', '026', '115', '097'];
const PREREG = 'prereg-registration-facility';
const TODAY_ZM = `(now() at time zone 'Africa/Lusaka')::date`;

// The final select and ORDER BY over `res`, whose columns are c01, c02, ... in output order. `kinds`: 'text' or 'number'. `orderIdx`: the
// indexes of the columns in ORDER BY order (default: output order), all of them.
function finalSelect26(labels, kinds, orderIdx = labels.map((_, i) => i)) {
  const names = labels.map((_, i) => `c${String(i + 1).padStart(2, '0')}`);
  const select = names.map((n, i) => `res.${n} as "${labels[i]}"`).join(',\n  ');
  const order = orderIdx.map((i) => {
    const n = `res.${names[i]}`;
    if (kinds[i] === 'number') return `${n} nulls first`;
    return `${ssTextKey(n)} collate "C" nulls first, ${n} collate "C" nulls first`;
  }).join(',\n  ');
  return `select ${select}\nfrom res\norder by ${order}`;
}

export function daysSinceSql() {
  const floor = '({{param.from}})::date::timestamp';
  return `with lab_dist as (
  select distinct dr.performer, dr.performer_display, dr.source_system, dr.performer_system
  from diagnostic_reports dr
  where ${testingCodeSql('dr')} is not null
),
src as (
  select x.performer as code, ${labNameSql('x')} as report_name
  from lab_dist x
),
${labNamesCte()},
lab_fac as (
  select ${foldSql('x.performer')} as code_key, x.performer as spelling, fm.registry_id, fm.region, fm.id as map_id
  from lab_dist x
  join facility_map fm on fm.source_system = coalesce(x.source_system, '') and fm.performer_system = coalesce(x.performer_system, '')
    and fm.source_code = x.performer and fm.registry_id is not null
),
lab_prov as (
  select f.code_key, (array_agg(f.region order by (f.region is null), f.map_id))[1] as region
  from lab_fac f
  group by f.code_key
),
reqs as (
  select dr.performer as code, ${localDate('lr.authored_at')} as reg_day
  from lab_requests lr
  join diagnostic_reports dr on dr.based_on_id = lr.id
  where ${testingCodeSql('dr')} is not null
    and ${localTs('lr.authored_at')} > ${floor}
),
a as (
  select ${foldSql('q.code')} as k, min(q.code collate "C") as spelling, ${TODAY_ZM} - max(q.reg_day) as days
  from reqs q
  group by ${foldSql('q.code')}
),
pre as (
  select ${requestAttrSql('lr.id', PREREG)} as pcode,
    (select max(${localDate('dr.issued')}) from diagnostic_reports dr where dr.based_on_id = lr.id) as auth_day
  from lab_requests lr
  where ${localTs('lr.authored_at')} > ${floor}
    and exists (select 1 from lab_request_attributes pa where pa.lab_request_id = lr.id and pa.system = ${sqlLit(ATTR_SYSTEM)} and pa.code = ${sqlLit(PREREG)})
),
site as (
  select distinct ${foldSql('fm.source_code')} as code_key, fm.registry_id
  from facility_map fm
  where fm.registry_id is not null
),
b as (
  select f.code_key as k, min(f.spelling collate "C") as spelling, ${TODAY_ZM} - max(p.auth_day) as days
  from pre p
  join site s on s.code_key = ${foldSql('p.pcode')}
  join lab_fac f on f.registry_id = s.registry_id
  where rtrim(p.pcode) <> ''
  group by f.code_key
  having coalesce(${TODAY_ZM} - max(p.auth_day), -1) <> -1
),
c as (
  select a.k, a.spelling, a.days from a
  union all
  select b.k, b.spelling, b.days from b
),
res as (
  select lp.region as c01, min(c.spelling collate "C") as c02, n.lab_name as c03, min(c.days) as c04
  from c
  left join lab_prov lp on lp.code_key = c.k
  left join names n on n.code_key = c.k
  where not (${inListSql('c.k', D_EXCLUDED)})
  group by c.k, lp.region, n.lab_name
)
${finalSelect26(['Province', 'LabCode', 'LabName', 'LastTransmission'], ['text', 'text', 'text', 'number'], [0, 2, 1, 3])}`;
}

// ---- Suspect collection dates ----
//
// Replaces sp_DQ_VLEIDSuspectedWrongSampleCollectionDateEntries (S below). The viral load and EID requests registered more than 90 days
// after their sample was collected, so staff can correct the dates. Columns (v1 names and order): Laboratory, Test Type, RequestID,
// Days from collection to accessioning. Parameters: `from` and `to` (@StartDate, @EndDate).
//
// What v1 does (lines):
//   - Requests with a result row (inner join on RequestID and OBRSetID, line 29-31) of the panel HIVVL or HIVPC (38) and an observation
//     HIVVL, HIVVC or HIVPC (39, whatever the panel), more than 90 days between collection and registration (40), testing lab not ZZZ,
//     XXX or ZXZ (41), analysed BETWEEN the two dates (42).
//   - Test Type: HIVVL is 'Viral Load', HIVPC is 'EID' (23-26). Laboratory: the name of the lab in the dictionary (32-36).
//   - SELECT DISTINCT (22), ordered by lab name, then test type (44).
//
// Kept v1 quirks (spec ruling 1):
//   - datediff(dd, SpecimenDatetime, registeredDatetime) counts date boundaries of the LOCAL dates of the stamps' own text (90 days and two
//     minutes can be 91; 91 local days can be 90 in UTC). The 90-day threshold is v1's constant: more than 90 is in, exactly 90 is out.
//   - BETWEEN @StartDate AND @EndDate on a DATETIME: both dates are midnight, so the end day is NOT included, except its first instant
//     (a stamp at exactly 00:00:00 of the end date is in, a second later is out). Not the whole end day as in the dashboard reports.
//   - SELECT DISTINCT on the four output columns, with text that ignores case and trailing spaces: two request numbers that differ in case
//     or trailing spaces are one row (the smallest spelling shows), and so are two labs with one name. Several result rows, reports or
//     OBR sets of one request that give the same four values are one row.
//   - The observation list is not tied to the panel: a HIVVL request with an HIVPC observation is in.
//   - A testing code of NULL is out (`NULL not in (...)` is unknown). A testing code that is blank is not in the exclusion list, so the
//     row stays, with no lab name.
//   - A request with no collection date, a partial one ('2026-01'), no report or no registered date has no day count, so it is out.
//
// CE gaps (spec ruling 7 and 8):
//   - v1's lab is the testing code, else the receiving code (lines 33-36). CE has no receiving code: a request with a blank testing code
//     is listed with no lab name where v1 would name the receiving lab.
//   - Laboratory is the report's name with ONE name per testing code (labNamesCte, the Task 16 rule), chosen from the rows this query
//     returns: the report's display, else the register name of the mapped code, else the code. v1's join is to its dictionary.
//   - The collection date is diagnostic_reports.effective, the registered date lab_requests.authored_at, the analysis date
//     lab_requests.analysis_at.
//
// Deviations: none (the dates are parameters, as v1's).
export function suspectDatesSql() {
  const start = '({{param.from}})::date::timestamp';
  const end = '({{param.to}})::date::timestamp';
  return `with sel as (
  select ${testingCodeSql('dr')} as code,
    case ${foldSql('lr.panel_code')} when 'hivvl' then 'Viral Load' when 'hivpc' then 'EID' end as test_type,
    lr.request_id, ${localDate('lr.authored_at')} - ${localDate('dr.effective')} as days, ${labNameSql('dr')} as report_name
  from lab_requests lr
  join diagnostic_reports dr on dr.based_on_id = lr.id
  where ${inListSql('lr.panel_code', ['HIVVL', 'HIVPC'])}
    and exists (select 1 from lab_results l where l.request_id = lr.id and ${inListSql('l.observation_code', ['HIVVL', 'HIVVC', 'HIVPC'])})
    and ${localDate('lr.authored_at')} - ${localDate('dr.effective')} > 90
    and not (${inListSql('dr.performer', ['ZZZ', 'XXX', 'ZXZ'])})
    and ${localTs('lr.analysis_at')} between ${start} and ${end}
),
src as (
  select s.code, s.report_name
  from sel s
),
${labNamesCte()},
res as (
  select min(n.lab_name collate "C") as c01, s.test_type as c02, min(s.request_id collate "C") as c03, s.days as c04
  from sel s
  left join names n on n.code_key = ${foldSql('s.code')}
  group by ${foldSql('n.lab_name')}, s.test_type, ${foldSql('s.request_id')}, s.days
)
${finalSelect26(['Laboratory', 'Test Type', 'RequestID', 'Days from collection to accessioning'], ['text', 'text', 'text', 'number'])}`;
}

// ---- DISA Link weekly stats ----
//
// Replaces sp_getDisaLinkStats, which only selects from fn_WeeklyDisaLinkUpdate (L below) ordered by column 1. One row per DISA Link
// facility with a new registration in the period. Columns (v1 names and order): Facility, New Registrations, Tested, Reviewed,
// Tested from Old Requests, Tested & Reviewed from Old Requests. Parameters: `from` and `to` (@From, @To).
//
// What v1 does (lines):
//   - The requests of the panels HIVVL and HIVPC registered from `from` up to, not including, the day after `to` (37-39), joined to the
//     Facilities dictionary on the pre-registration facility code (36), grouped by the facility DESCRIPTION (41).
//   - New Registrations: count(distinct RequestID) (11). Tested: count(analysisDateTime) over request rows (12). Reviewed:
//     count(authorisedDateTime) (13).
//   - Tested from Old Requests (14-23): the requests of the same facility description registered BEFORE `from` (old), analysed in the
//     period (analysis from `from` up to the day after `to`), with a result row of observation HIVVL, HIVVC or HIVPC: count(distinct
//     RequestID). Tested & Reviewed from Old Requests (24-35): the same, and authorised in the period too.
//
// Kept v1 quirks (spec ruling 1):
//   - The end date is moved by a day: the whole `to` day counts, and the first instant of the day after does not (`< dateadd(dd,1,@To)`).
//   - The group key is the facility description, so two facility codes with one description (case and trailing spaces aside) are ONE row.
//   - The two old-request columns are NULL, not 0, when no old request qualifies: their sub-selects are `top 1 count(...) group by
//     FacilityCode`, and a group by over no rows returns no row. A facility with no description (NULL) never matches the sub-select
//     (`NULL = NULL` is not true), so its old columns are always NULL.
//   - The output starts from the new registrations: a facility with only old requests tested in the period has no row.
//   - Old requests need a result row of the observation list; the new-registration counts do not look at results at all.
//   - Text compares ignore case and trailing spaces (the pre-registration code, the panel, the request number, the description).
//
// CE gaps and choices (spec rulings 7 and 8):
//   - The Facilities dictionary is facility_map (registry_id set), by source_code; the description is its register name (one name per code,
//     the first mapped row). A code outside the register has no facility and its requests are left out, as v1's inner join does.
//   - The pre-registration facility is the request attribute 'prereg-registration-facility' (requestAttrSql). cdr-toolchain does not fill it
//     yet and Zambia's feed is not measured, so the report is empty on real data until it is.
//   - Authorised is the latest issued stamp of the request row's reports (v1 has one stamp per request row; a request row with two reports
//     counts once, not twice). A report with no issued stamp is not reviewed.
//   - v1's `top 1 ... group by FacilityCode` returns ONE arbitrary facility code's count when two codes share a description (TOP 1 with no
//     ORDER BY). The port adds them up (distinct requests of both codes), as New Registrations does. This is a deviation from an
//     undefined result (spec ruling 2). A facility with one code is exactly v1.
//
// Deviations: none besides the one above.
export function disaLinkSql() {
  const start = '({{param.from}})::date::timestamp';
  const end = '(({{param.to}})::date + 1)::timestamp';
  const inWindow = (stamp) => `${stamp} >= ${start} and ${stamp} < ${end}`;
  return `with fac as (
  select ${foldSql('fm.source_code')} as code_key, (array_agg(fm.name order by (fm.name is null), fm.id))[1] as name
  from facility_map fm
  where fm.registry_id is not null
  group by ${foldSql('fm.source_code')}
),
rq as (
  select lr.request_id, ${requestAttrSql('lr.id', PREREG)} as pcode,
    ${localTs('lr.authored_at')} as reg_ts, ${localTs('lr.analysis_at')} as ana_ts, lr.analysis_at is not null as tested,
    exists (select 1 from diagnostic_reports d where d.based_on_id = lr.id and d.issued is not null) as reviewed,
    (select max(${localTs('d.issued')}) from diagnostic_reports d where d.based_on_id = lr.id) as auth_ts,
    exists (select 1 from lab_results l where l.request_id = lr.id and ${inListSql('l.observation_code', ['HIVVL', 'HIVVC', 'HIVPC'])}) as has_obs
  from lab_requests lr
  where ${inListSql('lr.panel_code', ['HIVVL', 'HIVPC'])}
    and (${inWindow(localTs('lr.authored_at'))} or (${localTs('lr.authored_at')} < ${start} and ${inWindow(localTs('lr.analysis_at'))}))
    and exists (select 1 from lab_request_attributes pa where pa.lab_request_id = lr.id and pa.system = ${sqlLit(ATTR_SYSTEM)} and pa.code = ${sqlLit(PREREG)})
),
rf as (
  select r.request_id, r.reg_ts, r.ana_ts, r.tested, r.reviewed, r.auth_ts, r.has_obs, f.name, ${foldSql('f.name')} as nk
  from rq r
  join fac f on f.code_key = ${foldSql('r.pcode')}
),
ng as (
  select f.nk, min(f.name collate "C") as facility, count(distinct ${foldSql('f.request_id')}) as n_new,
    count(*) filter (where f.tested) as n_tested, count(*) filter (where f.reviewed) as n_reviewed
  from rf f
  where ${inWindow('f.reg_ts')}
  group by f.nk
),
og as (
  select f.nk, count(distinct ${foldSql('f.request_id')}) as n_old
  from rf f
  where f.has_obs and ${inWindow('f.ana_ts')} and f.reg_ts < ${start}
  group by f.nk
),
og2 as (
  select f.nk, count(distinct ${foldSql('f.request_id')}) as n_old
  from rf f
  where f.has_obs and ${inWindow('f.ana_ts')} and f.reg_ts < ${start} and ${inWindow('f.auth_ts')}
  group by f.nk
),
res as (
  select n.facility as c01, n.n_new as c02, n.n_tested as c03, n.n_reviewed as c04, o.n_old as c05, o2.n_old as c06
  from ng n
  left join og o on o.nk = n.nk
  left join og2 o2 on o2.nk = n.nk
)
${finalSelect26(['Facility', 'New Registrations', 'Tested', 'Reviewed', 'Tested from Old Requests', 'Tested & Reviewed from Old Requests'],
    ['text', 'number', 'number', 'number', 'number', 'number'])}`;
}

export function queries() {
  return [
    { name: 'VL lab performance', sql: vlLabPerformanceSql(), params: dateParams(true) },
    { name: 'EID lab performance', sql: eidLabPerformanceSql(), params: dateParams(true) },
    { name: 'TB lab performance', sql: tbLabPerformanceSql(), params: dateParams(true) },
    { name: 'Days since last transmission', sql: daysSinceSql(), params: [{ id: 'from', label: 'Registered after (YYYY-MM-DD; v1 used 2019-01-01)', type: 'text', required: true }] },
    { name: 'Suspect collection dates', sql: suspectDatesSql(), params: dateParams(true) },
    { name: 'DISA Link weekly stats', sql: disaLinkSql(), params: dateParams(true) },
  ];
}

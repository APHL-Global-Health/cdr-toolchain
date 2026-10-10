// Custom queries for the eid reports. Each task adds { name, sql, params } entries to the list.

import { inListSql, rpt, foldSql } from '../../vl-reports-mz/vl-queries.mjs';
import {
  sqlLit, given, blank, same, count1, ratio, provinceParam, districtParam, facilityParam, dateParams, epiSummarySql, eidCte, localDate, localTs, ssTextKey,
  inRange, requesterJoin, requestAttrSql, genderMissingSql, labNameSql,
} from '../zm-sql.mjs';

// ---- EID testing summary by province, by district, by facility --------------------------------------------------------
//
// Replaces sp_getSummaryTestEpiDataEID (province, "P"), sp_getSummaryTestEpiDataEIDDistrict ("D") and
// sp_getSummaryTestEpiDataEIDFacility ("F"). The inventory called D and F merges of P. They are three queries here (controller
// ruling): the first output column is named Province, District or Facility, so one column list could not match v1 at every level.
// One builder (epiSummarySql in zm-sql.mjs, shared with the VL summaries) holds the code they have in common.
//
// Columns (v1 names and order): Province (P), District (D) or Facility (F), then Registrations, Tests, Negative, Positive, TATTests,
// TATpre. TATpre = average days x TATTests; the caller divides TATpre by TATTests. Parameters as v1: P from, to; D from, to, province;
// F from, to, province, district. Province and district are required selects (v1 has no "all" mode: a blank name matches nothing);
// from and to are required (spec ruling 3).
//
// Rows. One per area name (P: province; D: district of the province, a NULL district is one row; F: facility name, so two register
// entries with one name merge), ordered as v1 orders them (SQL Server text order, NULL first).
//
// Counts, per requesting facility, then summed by area name:
//   Registrations   distinct lab numbers of panel HIVPC registered (RegisteredDateTime = lab_requests.authored_at) in the window, any status.
//   Tests           distinct lab numbers of panel HIVPC with a result of observation HIVPC, a final report (HL7ResultStatusCode F), analysed
//                   (lab_requests.analysis_at) in the window. v1 has the invalid-text filter commented out (P lines 45-46): no text filter.
//   Negative        Tests whose text is LDL, Negative or 'Not Detected DBS'.
//   Positive        Tests whose text is Positive, 'Positive*', POS or 'Detected DBS'.
//   TATTests/TATpre lab numbers with a collection date (diagnostic_reports.effective) and at most 90 days (local dates, datediff dd) from
//                   it to the authorised date (diagnostic_reports.issued); the average is a whole number, cut toward zero.
// v1's Neg and Pos parts also say "not in" the other split's list (P lines 63-65, 81-83); that is implied by the "in" list and adds nothing.
//
// Window. v1 compares datetimes with dates and does not move the end date: the window runs from `from` 00:00:00 to `to` 00:00:00
// inclusive (local wall time of the stamp's own text), for RegisteredDateTime and AnalysisDateTime alike. The end day is out apart from
// its first instant, and a one-day window holds only what happened at exactly midnight (spec ruling 1, kept).
//
// Kept v1 quirks (spec ruling 1):
//   - The joins hang off the TESTS part (P lines 106-113), the opposite of the VL procedures. A facility with registrations but no tests in
//     the window has no row (its registrations are dropped); a facility with tests but no registrations keeps its row with
//     Registrations NULL. A sum over nothing is NULL (Negative or Positive with no rows, for instance).
//   - A facility not in the register (no mapped ZMFAC row) has no area, so it drops out (v1 inner-joins the area names).
//   - The turnaround part has no result filter and averages over result rows (a request with two HIVPC results weighs twice), while TATTests
//     counts requests. The average is cut per facility before the weighting, so TATpre is a sum of (cut average x requests).
//   - D gives a NULL district its own row (a facility whose district is not in the register). F filters on province AND district, so the
//     same district name in another province does not mix here (unlike the VL facility summary).
//   - A province over 25 characters or a district over 50 would be cut by v1's varchar parameters and match nothing. The port matches the
//     full name (evident intent). Names compare ignoring case and trailing spaces, as SQL Server does.
//   - Facilities are keyed by the register row, where v1 keys by the facility code. Two codes mapped to one register row would merge here.
//
// Deviations (spec ruling 2): none.
//
// CE gaps (spec ruling 7): none. The area names are the register row's (mapped ZMFAC), so a name can differ from v1's Facilities and
// HealthcareAreas descriptions (README). v1 joins results on RequestID and OBRSetID; CE keeps one result list per request.
const EID_NEGATIVE = ['LDL', 'Negative', 'Not Detected DBS'];
const EID_POSITIVE = ['Positive', 'Positive*', 'POS', 'Detected DBS'];

export function eidTestingSummarySql(level) {
  const result = rpt('l');
  const lead = {
    province: [['Province', 'fmr.region']],
    district: [['District', 'fmr.district']],
    facility: [['Facility', 'fmr.name']],
  }[level];
  const area = {
    province: 'fmr.region is not null',
    district: `fmr.region is not null and ${foldSql('fmr.region')} = ${foldSql('{{param.province}}')}`,
    facility: `${foldSql('fmr.region')} = ${foldSql('{{param.province}}')} and ${foldSql('fmr.district')} = ${foldSql('{{param.district}}')}`,
  }[level];
  return epiSummarySql({
    panel: 'HIVPC',
    observations: ['HIVPC'],
    anchor: 'tests',
    lead,
    area,
    splits: [
      { column: 'Negative', cond: inListSql(result, EID_NEGATIVE) },
      { column: 'Positive', cond: inListSql(result, EID_POSITIVE) },
    ],
  });
}

// Required select parameters, as v1 has no "all" mode. The order is v1's: dates first, then the areas.
const requiredProvince = () => ({ ...provinceParam('province', true), label: 'Province' });
const requiredDistrict = () => ({ ...districtParam('district', true), label: 'District' });
export const eidTestingSummaryParams = (level) => ({
  province: () => [...dateParams(true)],
  district: () => [...dateParams(true), requiredProvince()],
  facility: () => [...dateParams(true), requiredProvince(), requiredDistrict()],
})[level]();

// ---- EID dashboard summary ---------------------------------------------------------------------------------------------
//
// Replaces sp_dash_getEID_V2 (the target) and folds in one other v1 object:
//   sp_dash_getEID   an older cut of the same procedure. Its five measures (Tests, Positive, Negative, PositivityRate, AverageTAT)
//                    are columns of this query. These things of its own are NOT carried:
//                      - it reads Requests and LabResults directly, not the eid table, with its own rules: panel HIVPC and
//                        observation HIVPC only, the result 'Indeterminate' left out (and a NULL result, because `not in` drops
//                        NULLs, line 69), positive texts 'Positive', 'Positive*', 'POS' and 'Detected DBS' only (no 'Detected' or
//                        'DET'), no dedupe per lab number, and a LEFT join to the facility dictionary, so a request of an
//                        unmapped facility counts in its all-Zambia row. This query counts
//                        what the eid table counts (V2's population), so the two give slightly different numbers;
//                      - its all-Zambia positivity column is spelled PositvityRate (line 75); this query uses V2's PositivityRate;
//                      - its first column is Province, District or Facility only when that level is given, and there is none for
//                        all of Zambia; this query always has V2's three name columns, which read 'All' above the chosen level;
//                      - for a province, district or facility with no tests it returns no row; this query returns V2's zero row.
//
// Rows come from the eid copy table (v1 sp_update_EIDTable), rebuilt by eidCte. V2 filters cast(TestedDate as date) between
// @StDate and @EDate (lines 35, 115, 221, 329, 436).
//
// One row. Which row depends on which of province, district and facility is given (V2 lines 22, 130, 239, 346):
//   none                         'All', 'All', 'All'            all of Zambia; always a row, even with no tests (line 24: an aggregate
//                                                               over nothing is still one row)
//   province                     <Province>, 'All', 'All'       with no tests, the row of blanks and zeros (line 225)
//   province and district        <Province>, <District>, 'All'  with no tests, the same row (line 332)
//   all three                    <Province>, <District>, <Facility>; with no tests, the same row (line 439)
// The names in the row are the stored ones; the parameters match ignoring case and trailing spaces, as SQL Server does.
//
// Kept v1 quirks (spec ruling 1):
//   - The day after `to` is included. V2 moves the end date one day forward (line 21) and tests the local date of TestedDate against
//     [from, to + 1]. So a window ending 05-31 counts a test authorised on 06-01.
//   - Other combinations (a district without a province, a facility without both) match no branch in V2 and return no row. They return
//     no row here.
//   - Negative is Tests minus Positive (lines 29, 41, 147, 256, 363), not the eid table's negative flag, so indeterminate, error and
//     invalid results count as negative. Tests counts every row of the eid table: there is no filter on the result.
//   - The positive texts are the eid table's: Positive, Positive*, POS, Detected DBS, Detected and DET.
//   - AverageTAT and POC_AverageTAT are whole numbers. V2 averages an int column, which truncates toward zero (-6 / 7 is 0, -10 / 6 is -1).
//   - TatWithin48h_POC (line 47) sums a case with no else, so it is NULL, not 0, when POC tests exist and none was tested within 24 hours.
//     The name says 48 hours; the table column tests 24 hours (sp_update_EIDTable line 76).
//   - POCPositivityRate, POC_AverageTAT and TatWithin48h_POC are NULL when there is no POC test.
//   - The age-by-sex columns of a missing age end AgeMissingm, AgeMissingf and so on (no underscore).
//   - With no test in the window, the all-Zambia row has Tests = 0 and every other count NULL (a sum over no rows). V2 does not stop
//     here: NULL divided by zero is NULL in SQL Server (measured on the local SQL Server).
//   - V2's @Province is varchar(20), @District and @Facility varchar(40). A name over that length is cut, never matches, and V2 returns
//     the zero row. This query matches the full name (evident intent).
//
// Result shape (not a ruling 2 case: V2 runs): the zero rows of V2 have their own column lists. The facility one lacks Positive,
// Positive_POC, POCPositivityRate and POC_AverageTAT (line 439); the others spell TATWithin14 and TATWithin48h_POC differently
// (lines 116, 225, 332). A result keyed by column name cannot change its columns, so the zero row uses the main column names and 0
// for the four columns V2 leaves out.
//
// CE gaps (spec ruling 7): none of its own. Everything comes from eidCte, so its gaps carry over, and this report uses none of them:
// Referral, Disalink and TestedAt are not read.
//
// Windows: `from` and `to` are required (spec ruling 3). V2 defaulted a missing start and end to last month.


// The age groups of the eid table (sp_update_EIDTable lines 19-29) with the V2 column name of each (lines 54-61).
const EID_BANDS = [['At_Birth', 'At Birth'], ['_1_to_6wks', '1 - 6 Weeks'], ['_7wks_to_6Ms', '7 weeks to 6 Months'],
  ['_7_to_9Ms', '7 - 9 Months'], ['_10_to_12Ms', '10 - 12 Months'], ['_13_to_18Ms', '13 - 18 Months'],
  ['_19_to_24Ms', '19 - 24 Months'], ['Over_2Y', '> 2 years']];
// The gender split of the age-by-sex columns (lines 64-112): suffix, and the test on the gender column.
const EID_GENDERS = [['m', "s.gender = 'Male'"], ['f', "s.gender = 'Female'"], ['i', "s.gender = 'Indeterminate'"],
  ['u', "s.gender = 'Unknown'"], ['x', 's.gender is null']];

// The aggregate columns, in V2's order (all-Zambia branch, lines 37-112): [output name, aggregate over the rows `s`].
function eidDashColumns() {
  const cols = [
    ['Tests', 'count(s.lab_id)'],
    ['Tests_POC', 'sum(s.poc)'],
    ['Positive', 'sum(s.positive)'],
    ['Positive_POC', count1('s.poc = 1 and s.positive = 1')],
    ['Negative', 'count(s.lab_id) - sum(s.positive)'],
    ['PositivityRate', ratio('sum(s.positive)', 'count(s.lab_id)')],
    ['POCPositivityRate', ratio(count1('s.poc = 1 and s.positive = 1'), 'sum(s.poc)')],
    ['AverageTAT', 'trunc(avg(s.tat))::int'],
    ['POC_AverageTAT', 'trunc(avg(case when s.poc = 1 then s.tat end))::int'],
    ['TatWithin14', ratio('sum(s.tat_within14)', 'count(s.lab_id)')],
    ['TatWithin48h_POC', ratio('sum(case when s.poc = 1 and s.poc_w48h = 1 then 1 end)', 'sum(s.poc)')],
    ['Male', count1("s.gender = 'Male'")],
    ['Female', count1("s.gender = 'Female'")],
    ['IndeterminateGender', count1("s.gender = 'Indeterminate'")],
    ['UnknownGender', count1("s.gender = 'Unknown'")],
    ['MissingGender', count1('s.gender is null')],
  ];
  const bands = (suffix, genderCond) => {
    const and = genderCond ? ` and ${genderCond}` : '';
    for (const [name, label] of EID_BANDS) cols.push([suffix ? `${name}_${suffix}` : name, count1(`s.age_group = ${sqlLit(label)}${and}`)]);
    cols.push([`AgeMissing${suffix}`, count1(`s.age_group is null${and}`)]);
  };
  bands('', null);
  for (const [suffix, cond] of EID_GENDERS) bands(suffix, cond);
  return cols;
}

export function eidDashboardSql() {
  const cols = eidDashColumns();
  // Which of the four shapes the area parameters make.
  const national = `(${blank('province')} and ${blank('district')} and ${blank('facility')})`;
  const provinceOnly = `(${given('province')} and ${blank('district')} and ${blank('facility')})`;
  const districtLevel = `(${given('province')} and ${given('district')} and ${blank('facility')})`;
  const facilityLevel = `(${given('province')} and ${given('district')} and ${given('facility')})`;
  const names = cols.map(([name]) => `a."${name}"`).join(', ');
  const zeros = cols.map(([name]) => `0 as "${name}"`).join(', ');
  return `with ${eidCte('ed', { from: 'from', to: 'to', extraDays: 1 })},
sc as (
  select * from ed
  where ${same('ed.province', 'province')}
    and ${same('ed.district', 'district')}
    and ${same('ed.facility', 'facility')}
),
agg as (
  select max(s.province) as province, max(s.district) as district, max(s.facility) as facility, count(*) as n,
    ${cols.map(([name, expr]) => `${expr} as "${name}"`).join(',\n    ')}
  from sc s
)
select case when ${national} then 'All' else a.province end as "Province",
  case when ${national} or ${provinceOnly} then 'All' else a.district end as "District",
  case when ${facilityLevel} then a.facility else 'All' end as "Facility",
  ${names}
from agg a
where ${national} or (a.n > 0 and (${provinceOnly} or ${districtLevel} or ${facilityLevel}))
union all
select '' as "Province", '' as "District", '' as "Facility", ${zeros}
from agg a
where (${provinceOnly} or ${districtLevel} or ${facilityLevel}) and a.n = 0
order by 1, 2, 3`;
}

export const eidDashboardParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  facilityParam(),
  ...dateParams(true),
];

// ---- EID dashboard by facility, sex and age ----------------------------------------------------------------------------
//
// Replaces sp_dash_getEID_v2_List.
//
// Result sets. The inventory counts a second set. There is one report and one fallback. In every branch v1 runs
// `if exists (<the grouping>) select <the grouping> ... else select <a row of blanks and zeros>` (lines 24-61, 65-104, 109-148), so
// the second set is the "nothing found" row and never comes with the first (the same ruling as the VL list). This query gives the
// grouping, or the fallback row when it is empty.
//
// Rows come from the eid copy table (v1 sp_update_EIDTable), rebuilt by eidCte. One row per facility, gender and age group:
//   no province, no district     Province, District, Facility, Gender, AgeGroup   all facilities (lines 38-55)
//   province                     the same, for the facilities of that province (lines 81-99)
//   province and district        the same, for the facilities of that district (lines 125-143)
// Unlike the VL list, all of Zambia is NOT grouped per province: the select in the first branch lists Province, District and
// Facility and groups by all three. (The `exists` above it groups by Province only; it just decides whether the select runs.)
// Gender and AgeGroup are 'Missing' when the eid value is NULL. The names in a row are the stored ones; the parameters match
// ignoring case and trailing spaces, as SQL Server does, and so does the grouping (rows whose names differ only in case or trailing
// spaces are one group, shown with one of the spellings).
//
// Order (lines 57-59, 101-103, 145-147), in SQL Server's text order (ssTextKey):
//   all of Zambia    Province, Gender, AgeGroup. District and Facility are NOT in v1's ORDER BY; the port breaks the ties on them.
//   province         Province, District, Gender, AgeGroup. Facility is not in it; the port breaks the ties on it.
//   district         Province, District, Facility, Gender, AgeGroup.
// Age groups therefore sort as text: '> 2 years', '1 - 6 Weeks', '10 - 12 Months', '13 - 18 Months', '19 - 24 Months', '7 - 9 Months',
// '7 weeks to 6 Months', 'At Birth', 'Missing'.
//
// Window (lines 17-21, 33, 52, 76, 96, 120, 140). TestedDate is a datetime. v1 moves the end date one day forward and then tests
// `TestedDate between @StDate and @EDate` with NO cast to date. So a test counts when its local wall time is from `from` 00:00:00 up to
// and including (to + 1 day) 00:00:00. A test at exactly midnight of the day after `to` is in; one second later is out. This differs
// from sp_dash_getEID_V2, which casts to a date and takes the whole day after `to` (the EID dashboard summary above). eidCte takes the
// wider whole-day window (extraDays 1) and the query then cuts it back to that midnight. The time is the stamp's own local time with
// the fraction dropped; DISA stamps have no fraction.
//
// Kept v1 quirks (spec ruling 1):
//   - The edge above: the first instant of the day after `to` is counted, so a test at exactly midnight shows in two windows that touch.
//   - A district without a province matches no branch (lines 22, 63, 107) and returns nothing, not even the fallback row. Here too.
//   - Negative, Indeterminate, Error and Invalid are the eid table's own result flags (lists in sp_update_EIDTable), so a result on no
//     list counts in Tests only. Negative is not Tests minus Positive here, unlike the summary.
//   - LabTATWithinN counts the rows with a received date whose local days from received to tested are N or fewer. Days are date
//     boundaries (datediff dd) of the local dates. A negative gap counts in every bucket; a row with no received date counts in none.
//     RDateCompleted counts the rows that have a received date. TATWithin14 sums the eid table's flag (collected to tested).
//   - Gender knows F, M, I and U only; anything else, and a request with no patient, is 'Missing'.
//   - A province over 20 characters or a district over 40 would be cut by v1's varchar parameters and match nothing. The port matches
//     the full name (evident intent).
//
// Result shape (v1 runs, so not a ruling 2 case): the fallback row in v1 has its own column list: no District (first branch), no
// Facility (first two), and the misspelled LabWithin14 (lines 61, 104, 148). A result keyed by column name cannot change its columns,
// so the fallback row uses the main column names, blank District and Facility, and 0 in LabTATWithin14.
//
// CE gaps (spec ruling 7): none of its own. Everything comes from eidCte, whose gaps carry over; this report uses none of them.
//
// Windows: `from` and `to` are required (spec ruling 3). v1 defaulted a missing start and end to last month.

const SEX_AGE_COLUMNS = ['Province', 'District', 'Facility', 'Gender', 'AgeGroup', 'Tests', 'Positive', 'Negative', 'Indeterminate', 'Error',
  'Invalid', 'RDateCompleted', 'LabTATWithin1', 'LabTATWithin2', 'LabTATWithin3', 'LabTATWithin7', 'LabTATWithin14', 'TATWithin14'];

export function eidSexAgeSql() {
  // A district without a province: no branch in v1.
  const supported = `not (${blank('province')} and ${given('district')})`;
  const key = (expr) => `${ssTextKey(expr)} collate "C"`;
  const within = (days) => count1(`s.lab_days <= ${days}`);
  return `with ${eidCte('ed', { from: 'from', to: 'to', extraDays: 1 })},
sc as (
  select ed.province, ed.district, ed.facility, coalesce(ed.gender, 'Missing') as gender, coalesce(ed.age_group, 'Missing') as age_group,
    ed.lab_id, ed.positive, ed.negative, ed.indeterminate, ed.error, ed.invalid, ed.recieved_date, ed.tat_within14,
    ${localDate('ed.tested_date')} - ${localDate('ed.recieved_date')} as lab_days
  from ed
  where ${supported}
    and ${localTs('ed.tested_date')} <= (({{param.to}})::date + 1)::timestamp
    and ${same('ed.province', 'province')}
    and ${same('ed.district', 'district')}
),
agg as (
  select min(s.province) as province, min(s.district) as district, min(s.facility) as facility, s.gender, s.age_group,
    count(s.lab_id) as tests, sum(s.positive) as positive, sum(s.negative) as negative, sum(s.indeterminate) as indeterminate,
    sum(s.error) as error, sum(s.invalid) as invalid, ${count1('s.recieved_date is not null')} as rdate,
    ${within(1)} as w1, ${within(2)} as w2, ${within(3)} as w3, ${within(7)} as w7, ${within(14)} as w14,
    sum(s.tat_within14) as t14
  from sc s
  group by ${foldSql('s.province')}, ${foldSql('s.district')}, ${foldSql('s.facility')}, s.gender, s.age_group
)
select ${SEX_AGE_COLUMNS.map((c) => `u."${c}"`).join(', ')}
from (
  select a.province as "Province", a.district as "District", a.facility as "Facility", a.gender as "Gender", a.age_group as "AgeGroup",
    a.tests as "Tests", a.positive as "Positive", a.negative as "Negative", a.indeterminate as "Indeterminate", a.error as "Error",
    a.invalid as "Invalid", a.rdate as "RDateCompleted", a.w1 as "LabTATWithin1", a.w2 as "LabTATWithin2", a.w3 as "LabTATWithin3",
    a.w7 as "LabTATWithin7", a.w14 as "LabTATWithin14", a.t14 as "TATWithin14"
  from agg a
  union all
  select ''::text, ''::text, ''::text, ''::text, ''::text,
    0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint
  where ${supported} and not exists (select 1 from agg)
) u
order by ${key('u."Province"')} nulls first,
  case when ${given('province')} then ${key('u."District"')} end nulls first,
  case when ${given('province')} and ${given('district')} then ${key('u."Facility"')} end nulls first,
  ${key('u."Gender"')}, ${key('u."AgeGroup"')},
  ${key('u."District"')} nulls first, ${key('u."Facility"')} nulls first,
  u."Province" collate "C" nulls first, u."District" collate "C" nulls first, u."Facility" collate "C" nulls first`;
}

export const eidSexAgeParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  ...dateParams(true),
];

// ---- EID monthly trend -------------------------------------------------------------------------------------------------
//
// Replaces sp_dash_getMonthlyEIDTrend. Rows come from the eid copy table, rebuilt by eidCte.
// One row per month that has a test: MonthID is 'YYYY - MM' of the local date of the authorised date (line 14:
// concat(Year(cast(TestedDate as date)), ' - ', Format(cast(TestedDate as date), 'MM'))), then the counts of that month, ordered by
// MonthID. A month with no test has no row.
//
// Which tests count depends on the area parameters (lines 13, 29, 44, 61):
//   province                     that province
//   province and district        that district
//   province, district, facility that facility
//   anything else                everything (no filter)
// The names match ignoring case and trailing spaces.
//
// Kept v1 quirks (spec ruling 1):
//   - Any other combination falls to the last branch and filters nothing (line 61): a district without a province, a facility without a
//     province, or a province and facility without a district all show all of Zambia. (The EID dashboard summary and the EID dashboard
//     by facility, sex and age return nothing for these.)
//   - Tests is count(distinct LabID), compared ignoring case and trailing spaces. Negative is Tests minus Positive (line 17), so
//     indeterminate, error and invalid results count as negative, unlike the eid table's own negative flag.
//   - The month is the local date of the stamp: a test authorised at 2026-05-01T00:30:00+02:00 is in May, not in April as its UTC date
//     would say.
//   - v1's @Province is varchar(20), @District and @Facility varchar(40). A name over that length never matches in v1. The port matches
//     the full name (evident intent).
//
// Deviation (spec ruling 3): v1's window is fixed, the 12 full months before the current month (lines 20-22). Here `from` and `to` are
// required and the grouping by month is unchanged, so the first and last month are partial when the window does not start and end on
// month edges. A 12-month trend is a window of 12 months. There is no extra day at the end of the window (the sp_dash_ summaries add one;
// this procedure does not).
//
// CE gaps (spec ruling 7): none of its own.

export function eidTrendSql() {
  // The three shapes v1 filters on (lines 13, 29, 44). Everything else is the unfiltered last branch.
  const filtered = `(${given('province')} and not (${blank('district')} and ${given('facility')}))`;
  const month = localDate('ed.tested_date');
  const tests = `count(distinct ${foldSql('ed.lab_id')})`;
  return `with ${eidCte('ed', { from: 'from', to: 'to' })}
select to_char(${month}, 'YYYY - MM') as "MonthID", ${tests} as "Tests", sum(ed.positive) as "Positive",
  ${tests} - sum(ed.positive) as "Negative", sum(ed.tat_within14) as "Within14"
from ed
where ${month} is not null
  and (not ${filtered} or (${same('ed.province', 'province')} and ${same('ed.district', 'district')} and ${same('ed.facility', 'facility')}))
group by 1
order by 1`;
}

export const eidTrendParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  facilityParam(),
  ...dateParams(true),
];

// ---- EID clients by province -------------------------------------------------------------------------------------------
//
// Replaces sp_SPHO_eid_clients_month. It is the EID twin of "VL clients by province" and has the same two changes: the province
// constant 'Southern' (lines 24 and 62) is the `province` parameter (blank = all provinces), and "last month" (lines 25-28 on TestedDate,
// 58-61 on RegisteredDateTime) is `from` and `to`, whole local days, both ends in. For a window of one calendar month the rows are
// v1's rows for that month.
//
// Two parts, joined with UNION as v1 joins them:
//   valid     the eid copy table (rebuilt by eidCte) joined to the patient of the kept request, windowed on TestedDate (the authorised date).
//   rejected  requests whose report is cancelled (HL7 status X), panel HIVPC or POCGH, registered in the window, whose lab number is not
//             among the valid rows of the same window and province (line 63). POEID is in valid but not here (line 57).
// Columns (v1 names and order, from the first select): Province, District, Facility, LabID, Name, AgeInYears, Gender, UNIQUEID,
// HealthcareNo, HOSPID, REFNO, CollectedDate, RegisteredDate, TestedDate, Result. The dates are CE's ISO text (CollectedDate =
// diagnostic_reports.effective, RegisteredDate = lab_requests.authored_at, TestedDate = diagnostic_reports.issued).
// Province, district and facility are the requesting facility's mapped register row (a facility not in the register drops out, as v1's
// inner joins on its dictionary drop it). Name is the first name, a space and the surname. UNIQUEID and REFNO are the request attributes
// unique-id and reference-numbers. v1 shows both raw here (unlike the VL twin, there is no ART number rule in this procedure, so none
// of the artNumber variants applies).
//
// Kept v1 quirks (spec ruling 1):
//   - AgeInYears of a valid row is datediff(YY, dob, registered date) (line 11): the calendar-year boundaries between the two LOCAL dates,
//     not the exact age. A baby born in December is 1 in May. Rejected rows show the request's own AgeInYears (line 37).
//   - Result of a valid row is the first of Positive, Negative, Indeterminate, Error (lines 13-18). A result that is Invalid, or on no
//     list, leaves it NULL.
//   - Gender of a valid row is the eid table's (F, M, I, U; anything else NULL); rejected rows say Missing instead (lines 38-39).
//   - Rejected rows are dropped when the lab number is valid in the same window and province, but not when the valid row is in another
//     month (the NOT IN reads the windowed valid part).
//   - UNION removes repeated rows (line 66), comparing text ignoring case and trailing spaces: requests of one lab number with the same
//     facts are one row, shown with the first spelling in byte order.
//   - v1 has no ORDER BY, so the port orders by every column (CE pages the rows).
//
// CE gaps (spec ruling 7) and CE choices:
//   - HealthcareNo and HOSPID are not carried: empty columns under their v1 names.
//   - Status Y and Z (rejected in v1) cannot be told from other non-final statuses in CE (all 'unknown'), so only cancelled (X) is
//     rejected here.
//   - v1 inner-joins Patients for valid rows. CE can hold a request without a patient row; it stays, with an empty name (a space), NULL
//     age and NULL gender (valid) or Missing (rejected), as slice 1's left join does.
//   - The patient, the attributes and the dates of a valid row are those of the request the eid table keeps (the earliest tested one
//     of the lab number).
//   - A date of birth that is not a full date ('2026-01') gives a NULL age; the query does not fail.
//   - A mapped register row with no province is kept when no province is asked for (v1's rejected part left-joins the area names).
//
// Windows: `from` and `to` are required (spec ruling 3).

export function eidClientsSql() {
  // The rejected part reads request rows; the key texts compare as SQL Server compares them.
  const keys = ['province', 'district', 'facility', 'lab_id', 'client_name', 'gender', 'unique_id', 'ref_no'];
  const fold = (c) => foldSql(c);
  const columns = 'province, district, facility, lab_id, client_name, age_years, gender, unique_id, healthcare_no, hospid, ref_no, collected_date, registered_date, tested_date, result';
  return `with ${eidCte('ed', { from: 'from', to: 'to', rowIds: true })},
zc_valid as (
  select ed.province, ed.district, ed.facility, ed.lab_id, concat(p.firstname, ' ', p.surname) as client_name,
    (extract(year from ${localDate('ed.registered_date')}) - extract(year from ${localDate('p.date_of_birth')}))::int as age_years,
    ed.gender, ${requestAttrSql('ed.request_row_id', 'unique-id')} as unique_id, null::text as healthcare_no, null::text as hospid,
    ${requestAttrSql('ed.request_row_id', 'reference-numbers')} as ref_no, ed.collected_date, ed.registered_date, ed.tested_date,
    case when ed.positive = 1 then 'Positive' when ed.negative = 1 then 'Negative' when ed.indeterminate = 1 then 'Indeterminate'
      when ed.error = 1 then 'Error' end as result
  from ed
  join lab_requests lr on lr.id = ed.request_row_id
  left join patients p on p.id = lr.patient_id
  where ${same('ed.province', 'province')}
),
zc_rows as (
  select fmr.region as province, fmr.district as district, fmr.name as facility, lr.request_id as lab_id,
    concat(p.firstname, ' ', p.surname) as client_name, lr.age_years as age_years, ${genderMissingSql('p.sex')} as gender,
    ${requestAttrSql('lr.id', 'unique-id')} as unique_id, null::text as healthcare_no, null::text as hospid,
    ${requestAttrSql('lr.id', 'reference-numbers')} as ref_no, dr.effective as collected_date, lr.authored_at as registered_date,
    dr.issued as tested_date, 'REJECTED'::text as result
  from lab_requests lr
  ${requesterJoin('lr', 'fmr')}
  join diagnostic_reports dr on dr.based_on_id = lr.id
  left join patients p on p.id = lr.patient_id
  where dr.status = 'cancelled'
    and ${inListSql('lr.panel_code', ['HIVPC', 'POCGH'])}
    and ${inRange('lr.authored_at')}
    and ${same('fmr.region', 'province')}
    and not exists (select 1 from zc_valid v where ${foldSql('v.lab_id')} = ${foldSql('lr.request_id')})
),
zc_rejected as (
  select distinct on (${keys.map(fold).join(', ')}, age_years, collected_date, registered_date, tested_date) ${columns}
  from zc_rows
  order by ${keys.map(fold).join(', ')}, age_years, collected_date, registered_date, tested_date,
    ${keys.map((c) => `${c} collate "C"`).join(', ')}
)
select u.province as "Province", u.district as "District", u.facility as "Facility", u.lab_id as "LabID", u.client_name as "Name",
  u.age_years as "AgeInYears", u.gender as "Gender", u.unique_id as "UNIQUEID", u.healthcare_no as "HealthcareNo", u.hospid as "HOSPID",
  u.ref_no as "REFNO", u.collected_date as "CollectedDate", u.registered_date as "RegisteredDate", u.tested_date as "TestedDate",
  u.result as "Result"
from (
  select ${columns} from zc_valid
  union all
  select ${columns} from zc_rejected
) u
order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15`;
}

export const eidClientsParams = () => [
  provinceParam('province', false),
  ...dateParams(true),
];

// ---- EID results -------------------------------------------------------------------------------------------------------
//
// Replaces fn_getEIDs (the target) and folds in vPCR as the parameter `list`. The inventory also merged vPCRInfo here; it is a separate
// query ("EID request answers") because its columns are different. The rule used: a merge becomes a parameter only when the output
// shape stays the same (spec ruling 1 outranks ruling 10 when it does not, as for the testing summaries by area). vPCR has the same 12
// columns as fn_getEIDs, the same result map and the same joins, and differs only in its age bands and two filters, so it is a choice
// of list. vPCRInfo has nine other columns (a request id and eight answers) and no area, age or result.
//   list blank or "All requests"                    fn_getEIDs
//   list "Under 2 years, no rejected requests"      vPCR: other age bands (<3, 3-6, 6-12 and 12-24 months), no request with a
//                                                   rejection code (V line 48), no age of 763 days or more or missing (line 49).
//
// Columns (v1 names and order): ProvinceID, ProvinceName, DistrictCode, DistrictName, RequestingFacilityCode, FacilityName, RequestID,
// SpecimenDateTime, RegisteredDateTime, Gender, AgeGroup, Result. One row per distinct combination of the twelve (line 15).
// ProvinceName, DistrictName and FacilityName come from v1's dbo.FacilityList (joined on the DISA facility code, line 49), a table the
// v1 script reads but does not define (inventory). CE has no such table; the requesting facility's mapped register row stands in for it,
// and a code with no mapped row keeps the request with empty names (a left join, as v1's). ProvinceID and DistrictCode have no CE
// source (the register holds names only), so they are empty columns under their v1 names (ruling 7).
// Gender is the raw sex code (HL7SexCode, not a word). SpecimenDateTime is diagnostic_reports.effective, RegisteredDateTime is
// lab_requests.authored_at (CE's ISO text). Result maps LIMSRptResult: DTS, POS and Positive are Detected; NDT, NEG and Negative are Not
// Detected; Indeterminate stays; anything else, a missing result too, is Unknown. There is no filter on the observation or the report
// status, so any result row of an HIVPC request counts and a non-result observation shows as Unknown.
//
// Age bands (AgeInDays). fn_getEIDs (lines 26-33): under 42 '< 6 Weeks'; 42-90 '< 3 Months'; 91-182 '3 - 6 Months'; 183-272 '6 - 9
// Months'; 273-365 '9 - 12 Months'; 367-762 '12 - 24 Months'; over 762 '> 2 Years'. vPCR (V lines 24-28): up to 90 '<3 Months'; 91-182
// '3 - 6 Months'; 183-365 '6 - 12 Months'; 367-762 '12 - 24 Months'.
//
// Kept v1 quirks (spec ruling 1):
//   - Day 366 is in no band, so its AgeGroup is NULL, in both lists. A missing age has no band (fn_getEIDs keeps the row; vPCR drops it).
//   - A request with several results of one class gives one row; with results of two classes, one row each.
//   - Only requests in panel HIVPC. Text compares ignore case and trailing spaces.
//   - Window (fn_getEIDs lines 54-55): coalesce(SpecimenDateTime, RegisteredDateTime) from `from` 00:00:00 to `to` 00:00:00, local wall
//     time of the stamp's own text. v1 compares a datetime with a date, so a request on the last day is out but for the first instant of
//     it (a one-day window holds only requests stamped exactly at midnight). A partial specimen date ('2026-07') counts as no date, so the
//     registered date decides; a request with neither is out.
//   - No ORDER BY in v1: the port orders by every column.
//
// Deviations: vPCR has no window in v1 (all time). It takes the same `from` and `to` here (ruling 3: a port needs one), but with the
// whole last day in (the datetime quirk above is not copied to a window v1 never had). `from` and `to` are required.
//
// CE gaps (ruling 7): ProvinceID, DistrictCode (above). Names come from the register mapping, not FacilityList, and can differ from v1's.

const EID_RESULTS_V_LIST = 'Under 2 years, no rejected requests';

export function eidResultsSql() {
  const result = rpt('l');
  // The local wall time the window tests: the specimen date, else the registered date (a partial stamp counts as missing).
  const ts = `coalesce(${localTs('dr.effective')}, ${localTs('lr.authored_at')})`;
  const vpcr = `${foldSql('{{param.list}}')} = ${foldSql(sqlLit(EID_RESULTS_V_LIST))}`;
  const age = 'lr.age_days';
  const fnBand = `case when ${age} < 42 then '< 6 Weeks' when ${age} >= 42 and ${age} < 91 then '< 3 Months'
      when ${age} >= 91 and ${age} <= 182 then '3 - 6 Months' when ${age} >= 183 and ${age} <= 272 then '6 - 9 Months'
      when ${age} >= 273 and ${age} <= 365 then '9 - 12 Months' when ${age} > 366 and ${age} <= 762 then '12 - 24 Months'
      when ${age} > 762 then '> 2 Years' end`;
  const vBand = `case when ${age} <= 90 then '<3 Months' when ${age} >= 91 and ${age} <= 182 then '3 - 6 Months'
      when ${age} >= 183 and ${age} <= 365 then '6 - 12 Months' when ${age} > 366 and ${age} <= 762 then '12 - 24 Months' end`;
  const keys = ['province', 'district', 'requester_code', 'facility', 'request_id', 'sex'].map((c) => foldSql(c)).join(', ');
  const plain = ['province', 'district', 'requester_code', 'facility', 'request_id', 'sex'].map((c) => `${c} collate "C"`).join(', ');
  return `with zr_rows as (
  select fmr.region as province, fmr.district as district, lr.requester_code, fmr.name as facility, lr.request_id,
    dr.effective as specimen_at, lr.authored_at as registered_at, p.sex,
    case when ${vpcr} then ${vBand} else ${fnBand} end as age_group,
    case when ${inListSql(result, ['DTS', 'POS', 'Positive'])} then 'Detected'
      when ${inListSql(result, ['Indeterminate'])} then 'Indeterminate'
      when ${inListSql(result, ['NDT', 'NEG', 'Negative'])} then 'Not Detected'
      else 'Unknown' end as result
  from lab_requests lr
  join lab_results l on l.request_id = lr.id
  left join diagnostic_reports dr on dr.based_on_id = lr.id
  left join patients p on p.id = lr.patient_id
  ${requesterJoin('lr', 'fmr', 'left join')}
  cross join lateral (select ${ts} as stamp) w
  where ${foldSql('lr.panel_code')} = 'hivpc'
    and w.stamp >= ({{param.from}})::date::timestamp
    and case when ${vpcr} then w.stamp < (({{param.to}})::date + 1)::timestamp else w.stamp <= ({{param.to}})::date::timestamp end
    and (not (${vpcr}) or (coalesce(rtrim(lr.rejection_code), '') = '' and lr.age_days < 763))
),
zr_one as (
  select distinct on (${keys}, specimen_at, registered_at, age_group, result)
    province, district, requester_code, facility, request_id, specimen_at, registered_at, sex, age_group, result
  from zr_rows
  order by ${keys}, specimen_at, registered_at, age_group, result, ${plain}
)
select null::text as "ProvinceID", province as "ProvinceName", null::text as "DistrictCode", district as "DistrictName",
  requester_code as "RequestingFacilityCode", facility as "FacilityName", request_id as "RequestID", specimen_at as "SpecimenDateTime",
  registered_at as "RegisteredDateTime", sex as "Gender", age_group as "AgeGroup", result as "Result"
from zr_one
order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12`;
}

export const eidResultsParams = () => [
  ...dateParams(true),
  {
    id: 'list', label: 'List (blank for all requests)', type: 'select', required: false,
    optionsSql: `select 'All requests' as list union all select ${sqlLit(EID_RESULTS_V_LIST)}`,
  },
];

// ---- EID request answers -----------------------------------------------------------------------------------------------
//
// Replaces vPCRInfo. For each request of panel HIVST, the first result of eight observations laid out as columns: CDHIV, CPMTC, INFBR,
// INFN, MOHIC, MPMTC, PCRT, PCRTT (lines 11-26). What the panel and the codes mean is not stated in the v1 script (QUESTIONS-FOR-ZM), so
// the columns keep their codes as names. Columns (v1 names and order): RequestID, CDHIV, CPMTC, INFBR, INFN, MOHIC, MPMTC, PCRT, PCRTT.
// vPCR and fn_getEIDs rows can be matched to it by RequestID. It is its own query, not a column group of "EID results": the shape is
// different (see there).
//
// One row per distinct combination (line 10) of the request id and the eight answers. A request row needs at least one result row of any
// observation (the inner join on lines 28-29), so a request with no results is out; one whose results are other observations shows with
// empty answers. The answers are looked up by request and OBR set (lines 11-26), that is, per request row: two request rows of one lab
// number can give two rows. Each answer is LIMSRptResult (rpt: the text, else the number, else the coded value).
//
// Kept v1 quirks (spec ruling 1): none that change the rows. Panel and observation codes compare ignoring case and trailing spaces;
// repeated rows are one, ignoring case and trailing spaces, shown with the first spelling in byte order.
//
// Deviation (ruling 2): where a request has two results for one observation, v1 takes `top 1` with no ORDER BY (lines 11-26: the pick is
// arbitrary and can change between runs). The port takes the lowest result row id, so the answer is stable.
//
// No parameters: v1 has none and no window, so the query returns every HIVST request, as v1 does (the other EID lists need a window
// because v1's function takes dates; this view does not). CE pages the rows.
// CE gaps: none.

const ANSWER_CODES = ['CDHIV', 'CPMTC', 'INFBR', 'INFN', 'MOHIC', 'MPMTC', 'PCRT', 'PCRTT'];

export function eidAnswersSql() {
  const result = rpt('l');
  const lower = (c) => c.toLowerCase();
  const keys = ['request_id', ...ANSWER_CODES.map(lower)].map((c) => foldSql(c)).join(', ');
  const plain = ['request_id', ...ANSWER_CODES.map(lower)].map((c) => `${c} collate "C"`).join(', ');
  const list = ['request_id', ...ANSWER_CODES.map(lower)].join(', ');
  return `with za_rows as (
  select lr.request_id,
    ${ANSWER_CODES.map((c) => `(array_agg(${result} order by l.id) filter (where ${foldSql('l.observation_code')} = ${sqlLit(lower(c))}))[1] as ${lower(c)}`).join(',\n    ')}
  from lab_requests lr
  join lab_results l on l.request_id = lr.id
  where ${foldSql('lr.panel_code')} = 'hivst'
  group by lr.id, lr.request_id
),
za_one as (
  select distinct on (${keys}) ${list}
  from za_rows
  order by ${keys}, ${plain}
)
select request_id as "RequestID", ${ANSWER_CODES.map((c) => `${lower(c)} as "${c}"`).join(', ')}
from za_one
order by 1, 2, 3, 4, 5, 6, 7, 8, 9`;
}

export const eidAnswersParams = () => [];

// ---- EID tests on GeneXpert --------------------------------------------------------------------------------------------
//
// Replaces v_GxEIDTests: the rows of the eid copy table (rebuilt by eidCte) whose lab number has a request in panel HIVPC, POCGH or POEID
// with an analyser code like 'G____' (a G and four characters), tested in the window, with the testing laboratory's name.
// Columns (v1 names and order, the eid table's with v1's spelling RecievedDate, then LabName): Province, District, Facility, LabID,
// Gender, AgeGroup, TestedDate, Positive, TAT, TATWithin14, RunDate, RecievedDate, RegisteredDate, CollectedDate, TestedAt, Referral,
// Disalink, Error, Invalid, Negative, Indeterminate, POC, POCW48H, LabName.
//
// The fixed window (TestedDate within the last 1,095 days, line 14; no upper bound) is `from` and `to` (spec ruling 3); both are required.
// The window is on the LOCAL date of the authorised date, both ends in.
//
// Kept v1 quirks (spec ruling 1):
//   - The join to Requests (lines 10-11) repeats a test once per request row of its lab number that is in one of the three panels and has
//     a G analyser code; v1 has no DISTINCT. Two such rows give two identical rows. The analyser code is a fact of any such request row,
//     not necessarily the row the eid table kept (the facts of the output are the kept row's).
//   - 'G____' follows SQL Server's LIKE for varchar, ignoring case; a trailing space can be the fourth character after the G, and further
//     trailing spaces do not count (measured: 'G123 ' and 'G1234  ' match, 'G1  ' and 'G12345' do not).
//   - No ORDER BY in v1: the port orders by every column.
//
// CE gaps (ruling 7):
//   - Referral stays NULL: CE holds no receiving facility (the eid builder's referral). Disalink reads the pre-registration attributes and
//     is 0 until cdr-toolchain fills them.
//   - v1 inner-joins its laboratory dictionary on TestedAt (lines 12-13): a test whose testing laboratory is not in it, or has no testing
//     code, is out. CE has no Zambia laboratory dictionary (ruling 8), so a test with no testing code is out and every other one stays.
//     LabName is the report's display, else the mapped register name, else the code (ruling 8). For a ZU code stored as ZUL (TestedAt),
//     the name is that of the report's own code, where v1 names ZUL.
//
// Deviations: none.

// SQL Server `x like 'G____'` on a varchar value: the first character is a G (any case), the text is at least five characters long,
// and its text without trailing spaces is at most five characters long (the characters in between can be anything, spaces too).
// Measured on SQL Server: 'G1234 ', 'G123 ', 'G123  ' and 'G    ' match; 'G123', 'G1  ' and 'G12345' do not.
const likeG4 = (x) => `(${x} ilike 'g%' and length(rtrim(${x})) <= 5 and length(${x}) >= 5)`;

export function eidGeneXpertSql() {
  return `with ${eidCte('ed', { from: 'from', to: 'to', rowIds: true })}
select ed.province as "Province", ed.district as "District", ed.facility as "Facility", ed.lab_id as "LabID", ed.gender as "Gender",
  ed.age_group as "AgeGroup", ed.tested_date as "TestedDate", ed.positive as "Positive", ed.tat as "TAT", ed.tat_within14 as "TATWithin14",
  ed.run_date as "RunDate", ed.recieved_date as "RecievedDate", ed.registered_date as "RegisteredDate", ed.collected_date as "CollectedDate",
  ed.tested_at as "TestedAt", ed.referral as "Referral", ed.disalink as "Disalink", ed.error as "Error", ed.invalid as "Invalid",
  ed.negative as "Negative", ed.indeterminate as "Indeterminate", ed.poc as "POC", ed.poc_w48h as "POCW48H", ${labNameSql('dr')} as "LabName"
from ed
join diagnostic_reports dr on dr.id = ed.report_row_id
join lab_requests gr on ${foldSql('gr.request_id')} = ${foldSql('ed.lab_id')}
  and ${inListSql('gr.panel_code', ['HIVPC', 'POCGH', 'POEID'])}
  and ${likeG4('gr.analyzer_code')}
where ed.tested_at is not null
order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24`;
}

export const eidGeneXpertParams = () => [...dateParams(true)];

export function queries() {
  return [
    { name: 'EID testing summary by province', sql: eidTestingSummarySql('province'), params: eidTestingSummaryParams('province') },
    { name: 'EID testing summary by district', sql: eidTestingSummarySql('district'), params: eidTestingSummaryParams('district') },
    { name: 'EID testing summary by facility', sql: eidTestingSummarySql('facility'), params: eidTestingSummaryParams('facility') },
    { name: 'EID dashboard summary', sql: eidDashboardSql(), params: eidDashboardParams() },
    { name: 'EID dashboard by facility, sex and age', sql: eidSexAgeSql(), params: eidSexAgeParams() },
    { name: 'EID monthly trend', sql: eidTrendSql(), params: eidTrendParams() },
    { name: 'EID clients by province', sql: eidClientsSql(), params: eidClientsParams() },
    { name: 'EID results', sql: eidResultsSql(), params: eidResultsParams() },
    { name: 'EID request answers', sql: eidAnswersSql(), params: eidAnswersParams() },
    { name: 'EID tests on GeneXpert', sql: eidGeneXpertSql(), params: eidGeneXpertParams() },
  ];
}

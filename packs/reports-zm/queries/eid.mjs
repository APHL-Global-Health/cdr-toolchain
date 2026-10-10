// Custom queries for the eid reports. Each task adds { name, sql, params } entries to the list.

import { inListSql, rpt, foldSql } from '../../vl-reports-mz/vl-queries.mjs';
import { sqlLit, provinceParam, districtParam, facilityParam, dateParams, epiSummarySql, eidCte, localDate, localTs, ssTextKey } from '../zm-sql.mjs';

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
//                        observation HIVPC only, the result 'Indeterminate' left out, positive texts 'Positive', 'Positive*',
//                        'POS' and 'Detected DBS' only (no 'Detected' or 'DET'), no dedupe per lab number, and a LEFT join to the
//                        facility dictionary, so a request of an unmapped facility counts in its all-Zambia row. This query counts
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

const given = (id) => `{{param.${id}}} <> ''`;
const blank = (id) => `{{param.${id}}} = ''`;
// A column against a parameter the way SQL Server compares text: case and trailing spaces ignored; a blank parameter passes everything.
const same = (column, id) => `(${blank(id)} or ${foldSql(column)} = ${foldSql(`{{param.${id}}}`)})`;
const count1 = (cond) => `sum(case when ${cond} then 1 else 0 end)`;
const ratio = (top, bottom) => `(${top})::float8 / nullif(${bottom}, 0)`;

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

export function queries() {
  return [
    { name: 'EID testing summary by province', sql: eidTestingSummarySql('province'), params: eidTestingSummaryParams('province') },
    { name: 'EID testing summary by district', sql: eidTestingSummarySql('district'), params: eidTestingSummaryParams('district') },
    { name: 'EID testing summary by facility', sql: eidTestingSummarySql('facility'), params: eidTestingSummaryParams('facility') },
    { name: 'EID dashboard summary', sql: eidDashboardSql(), params: eidDashboardParams() },
    { name: 'EID dashboard by facility, sex and age', sql: eidSexAgeSql(), params: eidSexAgeParams() },
    { name: 'EID monthly trend', sql: eidTrendSql(), params: eidTrendParams() },
  ];
}

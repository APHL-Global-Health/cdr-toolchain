// Custom queries for the tb reports. Each task adds { name, sql, params } entries to the list.

import { inListSql, foldSql } from '../../vl-reports-mz/vl-queries.mjs';
import {
  given, blank, same, count1, ratio, provinceParam, districtParam, facilityParam, dateParams, tbgnxCte, geneXpertCte, localDate, localTs, ssTextKey,
  dateParamSql,
} from '../zm-sql.mjs';

// ---- The measures the three TB GeneXpert dashboards share ---------------------------------------------------------------
//
// All three read the tbgnx copy table (v1 table TBGNX, filled by sp_getTBsLastHour), rebuilt by tbgnxCte. The columns it holds that
// matter here: province, district, description (the facility), gender, age_group, mtb and rif (the cleaned results), tat (hours),
// poc, w24h, w48h and w72h (flags). v1 has no dedupe, so a request with two GXMTB results is two rows and counts twice in every
// measure but the trend's Tests.
//
// The measure tests, as v1 writes them (TBGNX lines 25-36, the same in the list and the trend). Text compares ignore case and
// trailing spaces, as SQL Server's default collation does (inListSql):
//   MTB positive    MTB = 'MTB Detected'
//   RIF positive    RIF in ('Detected', 'DET', 'Detected_Low'). The rate columns spell the last one 'DEtected_Low'; the collation makes
//                   it the same word. 'Detected_Low' has an underscore and no spaces: the clean-up leaves a reported 'Detected _ Low'
//                   (with spaces) as it is, and that is NOT on this list.
//   Indeterminate   RIF = 'Indeterminate'
//   Error           MTB = 'Error' or RIF = 'Error'            (NULL or false is not an error)
//   Invalid         MTB = 'Invalid' or RIF = 'Invalid'
//   No result       MTB in ('No Results', '') or RIF in ('No Results', '')    (a blank counts; a NULL result does not)
const tbTests = (s) => ({
  mtb: inListSql(`${s}.mtb`, ['MTB Detected']),
  rif: inListSql(`${s}.rif`, ['Detected', 'DET', 'Detected_Low']),
  ind: inListSql(`${s}.rif`, ['Indeterminate']),
  err: `(${inListSql(`${s}.mtb`, ['Error'])} or ${inListSql(`${s}.rif`, ['Error'])})`,
  inv: `(${inListSql(`${s}.mtb`, ['Invalid'])} or ${inListSql(`${s}.rif`, ['Invalid'])})`,
  none: `(${inListSql(`${s}.mtb`, ['No Results', ''])} or ${inListSql(`${s}.rif`, ['No Results', ''])})`,
});

// The 21 measures of the summary and the list, in v1's order, as [output name, aggregate over the rows `s`].
// A rate is a float; v1 divides by nullif(.., 0), so a rate over nothing is NULL. AverageTAT averages an int column, which cuts
// toward zero (-1.5 is -1), and ignores a NULL tat. The POC measures are NULL when no POC row exists (nullif(sum(POC), 0)).
function tbMeasures() {
  const t = tbTests('s');
  const n = 'count(s.requestid)';
  const mtbPositive = count1(t.mtb);
  const pocFlag = (flag) => ratio(`sum(case when s.poc = 1 then s.${flag} else 0 end)`, 'sum(s.poc)');
  return [
    ['Tests', n],
    ['MTB_Positive', mtbPositive],
    ['RIF_Positive', count1(t.rif)],
    ['RIF_Indeterminate', count1(t.ind)],
    ['Errors', count1(t.err)],
    ['Invalids', count1(t.inv)],
    ['NoResults', count1(t.none)],
    ['MTB_Positivity', ratio(mtbPositive, n)],
    ['RIF_RES_Rate', ratio(count1(`${t.mtb} and ${t.rif}`), mtbPositive)],
    ['RIF_IND_Rate', ratio(count1(`${t.mtb} and ${t.ind}`), mtbPositive)],
    ['Error_Rate', ratio(count1(t.err), n)],
    ['Invalid_Rate', ratio(count1(t.inv), n)],
    ['No_Result_Rate', ratio(count1(t.none), n)],
    ['AverageTAT', 'trunc(avg(s.tat))::int'],
    ['AverageTAT_POC', 'trunc(avg(case when s.poc = 1 then s.tat end))::int'],
    ['TATW24H', ratio('sum(s.w24h)', n)],
    ['TATW48H', ratio('sum(s.w48h)', n)],
    ['TATW72H', ratio('sum(s.w72h)', n)],
    ['TATW24H_POC', pocFlag('w24h')],
    ['TATW48H_POC', pocFlag('w48h')],
    ['TATW72H_POC', pocFlag('w72h')],
  ];
}

// The text sample of a name: the smallest in byte order, so the same spelling comes back every run. v1 shows whichever spelling the
// group happens to hold first.
const sample = (expr) => `min(${expr} collate "C")`;

// ---- TB GeneXpert dashboard summary ------------------------------------------------------------------------------------
//
// Replaces sp_dash_getTBGNX (province, district, facility, from, to).
//
// One row. Which row depends on which of province, district and facility is given (TBGNX lines 22, 132, 244, 356):
//   none                         'All', 'All', 'All'            all of Zambia; always a row, even with no tests (line 24: an aggregate
//                                                               over nothing is still one row: Tests is 0, every other measure NULL)
//   province                     <Province>, 'All', 'All'       with no tests, NO row (lines 132-242 have no fallback)
//   province and district        <Province>, <District>, 'All'  with no tests, NO row (lines 244-354 have no fallback)
//   all three                    <Province>, <District>, <Facility>; with no tests, a row of blanks and zeros (line 579)
// The names in the row are the stored ones (a group shows one spelling); the parameters match ignoring case and trailing spaces, as
// SQL Server does. The facility is the register name (v1: the dictionary description).
//
// Columns (v1 names and order, 107): Province, District, Facility, Tests, MTB_Positive, RIF_Positive, RIF_Indeterminate, Errors,
// Invalids, NoResults, MTB_Positivity, RIF_RES_Rate, RIF_IND_Rate, Error_Rate, Invalid_Rate, No_Result_Rate, AverageTAT, AverageTAT_POC,
// TATW24H, TATW48H, TATW72H, TATW24H_POC, TATW48H_POC, TATW72H_POC (see tbMeasures), then Male, Female, IndeterminateGender,
// UnknownGender, MissingGender, then the 13 age counts (lt01, 1to4, 5to9, 10to14, 15to19, 20to24, 25to29, 30to34, 35to39, 40to44,
// 45to49, 50plus, AgeMissing), then the same 13 for each gender: suffix m, f, i, u and x (a missing gender), as in AgeMissingm.
//
// Window. tbgnxCte is called WITH its window on the authorised date and extraDays 1: v1 moves @EDate one day forward when it is given
// (line 21) and tests cast(AuthorisedDateTime as date) between @StDate and @EDate (lines 130, 240, 352, 464, 575). So the whole local
// day after `to` counts. Nothing else cuts the rows: tbgnxCte keeps the same rows it keeps without a window.
//
// Kept v1 quirks (spec ruling 1):
//   - The day after `to` is included (above).
//   - Any other combination of the area parameters matches no branch and returns NO row, not even the zero row: a district without a
//     province, a facility without a district, a province and a facility without a district (line 22 and the `else if`s).
//   - Only the all-Zambia row counts a test of a facility that is not in the register (no province): the other rows filter on names.
//   - AverageTAT and AverageTAT_POC are whole numbers that cut toward zero (an int AVG): 3.8 is 3 and -1.5 is -1.
//   - Tests counts rows, with no dedupe: a request with two GXMTB results counts twice.
//   - RIF_Positive does not count a reported 'Detected _ Low' (with spaces); see tbTests.
//   - A province over 20 characters, or a district or facility over 40, would be cut by v1's varchar parameters and match nothing. The
//     port matches the full name (evident intent).
//   - In the zero rows (facility branch), v1 repeats the AgeMissing column and spells RIF_Indeterminate as RIF_indeterminate (lines
//     582, 618-619); a result keyed by column name cannot repeat a column, so the port has the one AgeMissing and v1's main spelling.
//
// Deviations (spec ruling 3): v1's default window (last month, line 18-20) becomes the required `from` and `to`.
//
// CE gaps (spec ruling 7): none of its own. Everything comes from tbgnxCte, whose gaps carry over: a request whose report has a blank
// testing code is dropped (data cdr did not push; for cdr data a blank DISA testing code is credited to the pushing lab, which cdr writes as
// the performer for every push, v2-transform.ts:401), and the facility is the register name. This report reads none of
// the TBCOL answers.

const GENDERS = [['m', "s.gender = 'Male'"], ['f', "s.gender = 'Female'"], ['i', "s.gender = 'Indeterminate'"],
  ['u', "s.gender = 'Unknown'"], ['x', 's.gender is null']];
const AGE_BANDS = [['lt01', '<01'], ['1to4', '01-04'], ['5to9', '05-09'], ['10to14', '10-14'], ['15to19', '15-19'], ['20to24', '20-24'],
  ['25to29', '25-29'], ['30to34', '30-34'], ['35to39', '35-39'], ['40to44', '40-44'], ['45to49', '45-49'], ['50plus', '50+']];

// The gender counts and the age counts (TBGNX lines 45-127), in v1's order.
function tbDashColumns() {
  const cols = [
    ...tbMeasures(),
    ['Male', count1("s.gender = 'Male'")],
    ['Female', count1("s.gender = 'Female'")],
    ['IndeterminateGender', count1("s.gender = 'Indeterminate'")],
    ['UnknownGender', count1("s.gender = 'Unknown'")],
    ['MissingGender', count1('s.gender is null')],
  ];
  const bands = (suffix, genderCond) => {
    const and = genderCond ? ` and ${genderCond}` : '';
    for (const [name, label] of AGE_BANDS) cols.push([`${name}${suffix}`, count1(`s.age_group = '${label}'${and}`)]);
    cols.push([`AgeMissing${suffix}`, count1(`s.age_group is null${and}`)]);
  };
  bands('', null);
  for (const [suffix, cond] of GENDERS) bands(suffix, cond);
  return cols;
}

export function tbDashboardSql() {
  const cols = tbDashColumns();
  const national = `(${blank('province')} and ${blank('district')} and ${blank('facility')})`;
  const provinceOnly = `(${given('province')} and ${blank('district')} and ${blank('facility')})`;
  const districtLevel = `(${given('province')} and ${given('district')} and ${blank('facility')})`;
  const facilityLevel = `(${given('province')} and ${given('district')} and ${given('facility')})`;
  const names = cols.map(([name]) => `a."${name}"`).join(', ');
  const zeros = cols.map(([name]) => `0 as "${name}"`).join(', ');
  return `with ${tbgnxCte('tb', { from: 'from', to: 'to', extraDays: 1 })},
sc as (
  select * from tb
  where ${same('tb.province', 'province')}
    and ${same('tb.district', 'district')}
    and ${same('tb.description', 'facility')}
),
agg as (
  select ${sample('s.province')} as province, ${sample('s.district')} as district, ${sample('s.description')} as facility, count(*) as n,
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
where ${facilityLevel} and a.n = 0
order by 1, 2, 3`;
}

export const tbDashboardParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  facilityParam(),
  ...dateParams(true),
];

// ---- TB GeneXpert by facility, sex and age -----------------------------------------------------------------------------
//
// Replaces sp_dash_getTBGNX_List (province, district, from, to).
//
// Result sets. The inventory counts one. In every branch v1 runs `if exists (<the grouping>) select <the grouping> ... else select <a
// row of blanks and zeros>` (lines 24-85, 89-151, 156-220), so the second select is the "nothing found" row and never comes with the
// first. This query gives the grouping, or the fallback row when it is empty (the same ruling as the EID list).
//
// Rows. One per province, district, facility, gender and age group of the tbgnx rows in the window:
//   no province, no district     all facilities (lines 53-83)
//   province                     the facilities of that province (lines 119-150)
//   province and district        the facilities of that district (lines 187-219)
// Unlike the summary, all of Zambia is grouped by facility (province, district, facility), and the rows of a facility that is not in
// the register form one group with NULL names (line 77 groups by the names, NULL included). Gender and AgeGroup are 'Missing' when
// the table value is NULL. Names group ignoring case and trailing spaces and show one spelling.
//
// Columns (v1 names and order): Province, District, Facility, Gender, AgeGroup, then the 21 measures of tbMeasures (Tests ...
// TATW72H_POC).
//
// Order (lines 81-83, 148-150, 217-219): Province, District, Facility (the table's Description), Gender, AgeGroup, in SQL Server's text
// order (ssTextKey), NULL names first. The age groups therefore sort '<01', '01-04', '05-09', ..., '50+', 'Missing'.
//
// Window: as the summary (line 21, 48, 76, 114, 143, 182, 212): the whole local day after `to` counts.
//
// Kept v1 quirks (spec ruling 1):
//   - The day after `to` is included.
//   - A district without a province matches no branch (lines 22, 87, 154) and returns nothing, not even the fallback row.
//   - The all-Zambia branch has no filter, so the unmapped facility's group (NULL names) is listed first.
//   - AverageTAT cuts toward zero, as in the summary. Tests counts rows with no dedupe.
//   - A province over 20 characters or a district over 40 would be cut by v1's varchar parameters and match nothing. The port matches
//     the full name (evident intent).
//
// Result shape (v1 runs, so not a ruling 2 case): the fallback row in v1 has its own column list: no AverageTAT and AverageTAT_POC, and
// RIF_RES_rate for RIF_RES_Rate (line 85). A result keyed by column name cannot change its columns, so the fallback row uses the main
// column names and 0 in AverageTAT and AverageTAT_POC.
//
// Deviations (spec ruling 3): the default window becomes the required `from` and `to`.
//
// CE gaps (spec ruling 7): none of its own; those of tbgnxCte carry over.

const SEX_AGE_LEAD = ['Province', 'District', 'Facility', 'Gender', 'AgeGroup'];

export function tbSexAgeSql() {
  const supported = `not (${blank('province')} and ${given('district')})`;
  const key = (expr) => `${ssTextKey(expr)} collate "C"`;
  const cols = tbMeasures();
  return `with ${tbgnxCte('tb', { from: 'from', to: 'to', extraDays: 1 })},
sc as (
  select tb.province, tb.district, tb.description as facility, coalesce(tb.gender, 'Missing') as gender,
    coalesce(tb.age_group, 'Missing') as age_group, tb.requestid, tb.mtb, tb.rif, tb.tat, tb.poc, tb.w24h, tb.w48h, tb.w72h
  from tb
  where ${supported}
    and ${same('tb.province', 'province')}
    and ${same('tb.district', 'district')}
),
agg as (
  select ${sample('s.province')} as province, ${sample('s.district')} as district, ${sample('s.facility')} as facility, s.gender, s.age_group,
    ${cols.map(([name, expr]) => `${expr} as "${name}"`).join(',\n    ')}
  from sc s
  group by ${foldSql('s.province')}, ${foldSql('s.district')}, ${foldSql('s.facility')}, s.gender, s.age_group
)
select ${[...SEX_AGE_LEAD, ...cols.map(([name]) => name)].map((c) => `u."${c}"`).join(', ')}
from (
  select a.province as "Province", a.district as "District", a.facility as "Facility", a.gender as "Gender", a.age_group as "AgeGroup",
    ${cols.map(([name]) => `a."${name}" as "${name}"`).join(', ')}
  from agg a
  union all
  select ''::text, ''::text, ''::text, ''::text, ''::text, ${cols.map(() => '0').join(', ')}
  where ${supported} and not exists (select 1 from agg)
) u
order by ${key('u."Province"')} nulls first, ${key('u."District"')} nulls first, ${key('u."Facility"')} nulls first,
  ${key('u."Gender"')}, ${key('u."AgeGroup"')},
  u."Province" collate "C" nulls first, u."District" collate "C" nulls first, u."Facility" collate "C" nulls first`;
}

export const tbSexAgeParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  ...dateParams(true),
];

// ---- TB GeneXpert monthly trend ----------------------------------------------------------------------------------------
//
// Replaces sp_dash_getMonthlyTBTrend (province, district, facility, from, to). Rows come from the tbgnx copy table, rebuilt by tbgnxCte.
// One row per month that has a test: MonthID is 'YYYY - MM' of the local date of the authorised date (line 14: concat(Year(cast(
// AuthorisedDateTime as date)), ' - ', Format(cast(AuthorisedDateTime as date), 'MM'))), then the counts of that month, ordered by
// MonthID. A month with no test has no row.
// Columns (v1 names and order): MonthID, Tests, MTB_Positive, RIF_Positive, W24H, TATW48, W72H. Tests is count(distinct requestid)
// (compared ignoring case and trailing spaces). W24H, TATW48 and W72H are SUMS of the 0/1 flags (counts, not rates); v1 names the
// middle one TATW48. The other two measures are the dashboard's (MTB 'MTB Detected'; RIF in 'Detected', 'DET', 'Detected_Low').
//
// Which tests count depends on the area parameters (lines 13, 29, 45, 63):
//   province                     that province
//   province and district        that district
//   province, district, facility that facility
//   anything else                everything (no filter)
// The names match ignoring case and trailing spaces.
//
// Window. The trend has no @EDate and so no extra day (it never runs the dateadd of the dashboards): tbgnxCte gets its window on the
// authorised date with extraDays 0, and a test counts when its local authorised date is from `from` to `to`, both days in.
//
// Kept v1 quirks (spec ruling 1):
//   - Any other combination falls to the last branch and filters nothing (line 63): a district without a province, a facility without a
//     district, or a province and a facility without a district all show all of Zambia. (The summary and the list return nothing for
//     these.)
//   - Tests counts distinct request numbers; MTB_Positive, RIF_Positive and the three sums count ROWS, so a request with two GXMTB
//     results counts once in Tests and twice in the others.
//   - The month is the local month of the stamp: a test authorised at 2026-05-01T00:30:00+02:00 is in May, not in April as its UTC
//     date would say.
//   - A province over 20 characters or a district or facility over 40 would be cut by v1's varchar parameters and never match. The port
//     matches the full name (evident intent).
//
// Deviation (spec ruling 3): v1's window is fixed, the 12 full months before the current month (lines 20-22). Here `from` and `to` are
// required and the grouping by month is unchanged, so the first and last month are partial when the window does not start and end on
// month edges. A 12-month trend is a window of 12 months.
//
// CE gaps (spec ruling 7): none of its own; those of tbgnxCte carry over.

export function tbTrendSql() {
  // The three shapes v1 filters on (lines 13, 29, 45). Everything else is the unfiltered last branch.
  const filtered = `(${given('province')} and not (${blank('district')} and ${given('facility')}))`;
  const month = localDate('tb.authorised_date_time');
  const t = tbTests('tb');
  return `with ${tbgnxCte('tb', { from: 'from', to: 'to' })}
select to_char(${month}, 'YYYY - MM') as "MonthID", count(distinct ${foldSql('tb.requestid')}) as "Tests",
  ${count1(t.mtb)} as "MTB_Positive", ${count1(t.rif)} as "RIF_Positive",
  sum(tb.w24h) as "W24H", sum(tb.w48h) as "TATW48", sum(tb.w72h) as "W72H"
from tb
where ${month} is not null
  and (not ${filtered} or (${same('tb.province', 'province')} and ${same('tb.district', 'district')} and ${same('tb.description', 'facility')}))
group by 1
order by 1`;
}

export const tbTrendParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  facilityParam(),
  ...dateParams(true),
];

// ---- TB GeneXpert report ------------------------------------------------------------------------------------------------
//
// Replaces fn_GeneXpertReport (from, to): GeneXpert TB results counted by testing lab, age group and TB/HIV status.
// Unlike the three dashboards above, this one reads v1's view v_GeneXpert (geneXpertCte), not the tbgnx table, so the MTB and RIF
// results are the RAW reported texts, not the cleaned ones.
//
// Columns (v1 names and order, lines 14-64): TestedAt, LabName, AgeGroup, TBHIV, MTB_neg, MTBRIF_neg, MTBRIF_pos, MTBRIF_IND,
// Error_Results, Invalid_Results, No_Results. One row per group of TestedAt, AgeGroup and TBHIV.
//
// Rules (function lines):
//   AgeGroup  by the age in years: 0 to 14 is '0-14', 15 and over '15+' (lines 24-25). A missing age falls back to the TBCOL answer TBAGE:
//             'Adult' is '15+', 'Child' is '0-14' (lines 26-27). Anything else, including a NEGATIVE age, is 'Unknown' (line 28).
//   TBHIV     the TBCOL answer TBHIV: 'Non-Reactive' is 'Negative'; 'Reactive' and 'Pulmonary' are 'Positive'; no answer is 'Unknown';
//             any other text comes through as stored (lines 31-35).
//   MTB_neg        MTB = 'Not Detected'                                              (line 38)
//   MTBRIF_neg     RIF = 'Not Detected', whatever the MTB says                       (line 42)
//   MTBRIF_pos     MTB starts with 'Detected' and RIF = 'Detected'                   (line 46)
//   MTBRIF_IND     RIF = 'IND', whatever the MTB says                                (line 50)
//   Error_Results  MTB = 'Error' or RIF = 'Error'                                    (line 54)
//   Invalid_Results MTB = 'Invalid' or RIF = 'Invalid'                               (line 58)
//   No_Results     MTB = 'NORES' or RIF = 'NORES'                                    (line 62)
// Text compares ignore case and trailing spaces, as SQL Server's default collation does. A row counts in every measure it meets.
//
// Kept v1 quirks (spec ruling 1):
//   - The window (line 67) is AnalysisDateTime >= @From and <= @To with DATES, so the stamp is compared with midnight: analysis from `from`
//     00:00:00 up to and including `to` 00:00:00 (local wall time, the stamp's own text). The end day is out apart from its first
//     instant, and from = to holds only analyses stamped exactly at midnight. The same decision as the facility report (Task 7/8).
//   - The compare of MTB with 'Detected%' is a prefix match (line 46), the RIF side is an equality: a RIF of 'Detected _ Low' is not
//     'Detected', 'Indeterminate' is not 'IND', 'ERR' is not 'Error'. These are the raw texts, not the cleaned ones of the tbgnx table.
//   - A negative age is not NULL: it is 'Unknown' and TBAGE is not read.
//   - No dedupe (geneXpertCte): two GXMTB results, two GXRIF results or two TBHIV answers on one request number make several rows, and
//     each counts. A NULL request fact loses the RIF of a row (geneXpertCte), so that row counts the MTB measures only.
//   - Groups compare as SQL Server compares text: TestedAt and TBHIV that differ only in case or trailing spaces are one group
//     (and 'Negative' from 'Non-Reactive' is one group with a stored 'negative'). The row shows the smallest spelling in byte order
//     (v1 shows whichever spelling the group holds first).
//   - The window drops fractions of a second (localTs): an analysis stamped `to`T00:00:00.500 counts as in, where v1's datetime drops it
//     (measured: `to` 00:00:00 is in and 00:00:00.003 is out). DISA stamps carry no fraction, so this does not show on real data.
//   - A stored TBHIV of 'Unknown' is the same group as a missing answer.
//
// Deviations (ruling 3): v1's @From and @To are dates with no default that gives a window; here both are required.
//
// CE gaps (ruling 7, 8):
//   - v1 left-joins its laboratory dictionary on TestedAt (line 66), which gives one name per code, so v1 has one row per TestedAt,
//     AgeGroup and TBHIV. CE has no dictionary (ruling 8): each report has a name (the report's display, else the register name of the
//     mapped code, else the code). LabName is NOT a group key. Ruling 8 note: the row shows ONE name per testing code, the same on every
//     row of that code, chosen from the names of all the code's reports in the window: a name that is not just the code beats the bare
//     code, then the smallest in byte order. So the answer is total and does not depend on row order or on the age or TBHIV group.
//   - A report with a blank performer has TestedAt NULL here (v1 falls back to ReceivingFacilityCode, which CE does not carry; for cdr data a
//     blank DISA testing code is credited to the pushing lab, so only data cdr did not push is affected). Its LabName
//     is NULL too, as v1's join finds no lab for a NULL code, whatever the report's display says. Such a row has no RIF (a NULL fact in
//     geneXpertCte) and forms its own group.

export function tbReportSql() {
  const r = 'r';
  const hit = (word, side) => inListSql(`${r}.${side}`, [word]);
  const either = (word) => `(${hit(word, 'mtb')} or ${hit(word, 'rif')})`;
  const stamp = localTs('g.analysis_date_time');
  return `with ${geneXpertCte('gx', { from: 'from', to: 'to', on: 'analysis_at', labName: true })},
rep as (
  select g.tested_at, g.lab_name,
    case
      when g.age_in_years >= 0 and g.age_in_years < 15 then '0-14'
      when g.age_in_years >= 15 then '15+'
      when g.age_in_years is null and ${inListSql('g.tbage', ['Adult'])} then '15+'
      when g.age_in_years is null and ${inListSql('g.tbage', ['Child'])} then '0-14'
      else 'Unknown'
    end as age_group,
    case
      when ${inListSql('g.tbhiv', ['Non-Reactive'])} then 'Negative'
      when ${inListSql('g.tbhiv', ['Reactive'])} then 'Positive'
      when ${inListSql('g.tbhiv', ['Pulmonary'])} then 'Positive'
      when g.tbhiv is null then 'Unknown'
      else g.tbhiv
    end as tbhiv,
    g.mtb, g.rif
  from gx g
  where ${stamp} >= ${dateParamSql('from')}::timestamp and ${stamp} <= ${dateParamSql('to')}::timestamp
),
names as (
  select ${foldSql('p.tested_at')} as code_key,
    (array_agg(p.lab_name order by ${foldSql('p.lab_name')} = ${foldSql('p.tested_at')}, p.lab_name collate "C"))[1] as lab_name
  from rep p
  where p.tested_at is not null
  group by ${foldSql('p.tested_at')}
)
select ${sample(`${r}.tested_at`)} as "TestedAt", min(n.lab_name) as "LabName", ${r}.age_group as "AgeGroup",
  ${sample(`${r}.tbhiv`)} as "TBHIV",
  ${count1(hit('Not Detected', 'mtb'))} as "MTB_neg",
  ${count1(hit('Not Detected', 'rif'))} as "MTBRIF_neg",
  ${count1(`${r}.mtb ilike 'Detected%' and ${hit('Detected', 'rif')}`)} as "MTBRIF_pos",
  ${count1(hit('IND', 'rif'))} as "MTBRIF_IND",
  ${count1(either('Error'))} as "Error_Results",
  ${count1(either('Invalid'))} as "Invalid_Results",
  ${count1(either('NORES'))} as "No_Results"
from rep ${r}
left join names n on n.code_key = ${foldSql(`${r}.tested_at`)}
group by ${foldSql(`${r}.tested_at`)}, ${r}.age_group, ${foldSql(`${r}.tbhiv`)}
order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11`;
}

export const tbReportParams = () => [...dateParams(true)];

export function queries() {
  return [
    { name: 'TB GeneXpert dashboard summary', sql: tbDashboardSql(), params: tbDashboardParams() },
    { name: 'TB GeneXpert by facility, sex and age', sql: tbSexAgeSql(), params: tbSexAgeParams() },
    { name: 'TB GeneXpert monthly trend', sql: tbTrendSql(), params: tbTrendParams() },
    { name: 'TB GeneXpert report', sql: tbReportSql(), params: tbReportParams() },
  ];
}

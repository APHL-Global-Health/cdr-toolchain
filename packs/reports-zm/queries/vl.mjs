// Custom queries for the vl reports. Each task adds { name, sql, params } entries to the list.

import { foldSql, inListSql, rpt, isNumericSql } from '../../vl-reports-mz/vl-queries.mjs';
import {
  hivvlCte, tndCte, provinceParam, districtParam, facilityParam, dateParams, localDate, localTs, utcTs, sqlList, zmIdsCte, inRange,
  requesterJoin, given, blank, same, count1, ratio, artNumberShortSql, artNumberRawSql, numberOfTextSql, formAnswerSql, YES_WORDS, ssTextKey, epiSummarySql,
  labNameSql, likeVarcharSql,
} from '../zm-sql.mjs';

// ---- VL dashboard summary ----------------------------------------------------------------------
//
// Replaces sp_dash_getHIVVL_v2 (the target) and folds in one other v1 object:
//   sp_dash_getHIVVL   an older cut of the same procedure. Its 22 columns (Province, District, Facility, Tests,
//                      Suppressed, Unsuppressed, Undetectable, SuppressionRate, AverageTAT and the age bands) are all
//                      columns of this query. These things of its own are NOT carried:
//                        - its rate counts baseline tests (this query's rate leaves them out, as v2 does);
//                        - it reads Requests and LabResults directly, with shorter result lists (it lacks ND, <20CP,
//                          < 40, DET, PLTT), so its counts differ slightly from v2's;
//                        - it has no dedupe per lab id, so the HIVVL and HIVVC rows of one request both count;
//                        - it LEFT joins the facility dictionary, so an unmapped facility counts in the national row
//                          (here it is left out, as the hivvl table leaves it out);
//                        - it reads panel HIVVL only (no POCVR or POHVL).
//
// What this query gives by sex and age: TESTS. Every sex and age column (Male, Female, lt01 ... 50plus, the age-by-sex
// columns) counts tests; none of them splits suppressed from unsuppressed (v1 lines 37-119 never test Suppressed).
// Suppressed is a total (Suppressed, Suppressed_POC, Unsuppressed) plus the pregnant, breastfeeding and baseline splits.
//
// vSuppressionByFacility and vVLQuarterlyFacilitySuppressionRate (both broken in v1, spec ruling 2) are NOT covered here.
// They give suppressed and unsuppressed counts by sex and age group. "VL dashboard by sex and age"
// (sp_dash_getHIVVL_v2_List, which gives Suppressed and UnSuppressed per Gender and AgeGroup) covers them.
//
// Rows come from the hivvl copy table (v1 sp_update_HIVVLTable), rebuilt by hivvlCte. v1 filters
// cast(TestedDate as date) between @StDate and @EDate (lines 130, 242, 357, 470, 583).
//
// One row. Which row depends on which of province, district and facility is given (v1 lines 22, 132, 246, 360):
//   none                         'All', 'All', 'All'            all of Zambia; always a row, even with no tests
//   province                     <Province>, 'All', 'All'       a row only when it has tests
//   province and district        <Province>, <District>, 'All'  a row only when it has tests
//   all three                    <Province>, <District>, <Facility>; with no tests, the all-zero row with blank
//                                names (lines 587-693)
// The names in the row are the stored ones; the parameters match ignoring case and trailing spaces, as SQL Server does.
//
// Kept v1 quirks (spec ruling 1):
//   - The day after `to` is included. v1 moves the end date one day forward (line 21) and tests the local date of
//     TestedDate against [from, to + 1]. So a window ending 05-31 counts a test authorised on 06-01.
//   - Other combinations (a district without a province, a facility without both) match no branch in v1 and return
//     no row. They return no row here. A blank parameter means "all" only for the three listed shapes.
//   - AverageTAT and AverageTAT_POC are whole numbers. v1 averages an int column, which truncates toward zero.
//   - The age groups are the hivvl ones ('<01', '01-04' ... '45-49', '50+'); gender knows F, M, I and U only, so
//     other sex codes count under Missing (Gender is null).
//   - Pregnant, BreastFeeding, BaselineVL and ThreeMPostUnSuppressed are counted where the flag is 1; the sum of a flag
//     that is never set is NULL (ThreeMPostUnSuppressed) rather than 0.
//   - TatWithin48h_POC tests 24 hours, as the hivvl column does.
//   - With no test in the window, the national row has Tests = 0 and every other count is NULL (a sum over no rows).
//   - v1's @Facility is varchar(40) (line 8) but HIVVL.Facility is nvarchar(50). A name over 40 characters is cut,
//     never matches, and v1 returns the zero row. This query matches the full name (evident intent).
//
// Result shape (not a ruling 2 case: v1 runs):
//   - v1 lists [AgeMissing] twice in the province, district and facility branches (lines 165-166, 279-280, 393-394,
//     506-507) and once in the national branch (line 54): 109 columns against 108. A result keyed by column name
//     cannot hold two columns of one name, so one AgeMissing is kept: 108 columns in every branch.
//
// Deviations (spec ruling 2):
//   - SuppressionRate divides by (tests - baseline tests). When every test is a baseline test that is zero and v1
//     stops with "divide by zero" (lines 31, 142, 256, 370, 483). This query gives NULL, as v1 already does for
//     SuppressionRate_POC (nullif).
//
// CE gaps (spec ruling 7): none of its own. Everything comes from hivvlCte, so its gaps carry over: Referral and Disalink
// are not used by this report. Pregnant, BreastFeeding, BaselineVL and ThreeMPostUnSuppressed read the VIRAL form's text
// answers (spec ruling 6), so they are 0 until cdr-toolchain sends that form.
//
// Windows: `from` and `to` are required (spec ruling 3). v1 defaulted a missing start and end to last month.

const BANDS = [['lt01', '<01'], ['1to4', '01-04'], ['5to9', '05-09'], ['10to14', '10-14'], ['15to19', '15-19'],
  ['20to24', '20-24'], ['25to29', '25-29'], ['30to34', '30-34'], ['35to39', '35-39'], ['40to44', '40-44'],
  ['45to49', '45-49'], ['50plus', '50+']];
// The gender split of the age-by-sex columns (lines 55-119): suffix, and the test on the gender column.
const GENDERS = [['m', "s.gender = 'Male'"], ['f', "s.gender = 'Female'"], ['i', "s.gender = 'Indeterminate'"],
  ['u', "s.gender = 'Unknown'"], ['x', 's.gender is null']];


// The aggregate columns, in v1's order (national branch, lines 25-128): [output name, aggregate over the rows `s`].
function dashColumns() {
  const cols = [
    ['Tests', 'count(s.lab_id)'],
    ['Tests_POC', 'sum(s.poc)'],
    ['Suppressed', 'sum(s.suppressed)'],
    ['Suppressed_POC', count1('s.suppressed = 1 and s.poc = 1')],
    ['Unsuppressed', 'count(s.lab_id) - sum(s.suppressed)'],
    ['Undetectable', 'sum(s.uu)'],
    ['Undetectable_POC', count1('s.poc = 1 and s.uu = 1')],
    ['SuppressionRate', ratio(`sum(s.suppressed) - ${count1('s.baseline_vl = 1 and s.suppressed = 1')}`, `count(s.lab_id) - ${count1('s.baseline_vl = 1')}`)],
    ['SuppressionRate_POC', ratio(`sum(case when s.poc = 1 then s.suppressed end) - ${count1('s.baseline_vl = 1 and s.suppressed = 1 and s.poc = 1')}`, `sum(s.poc) - ${count1('s.baseline_vl = 1 and s.poc = 1')}`)],
    ['AverageTAT', 'trunc(avg(s.tat))::int'],
    ['AverageTAT_POC', 'trunc(avg(case when s.poc = 1 then s.tat end))::int'],
    ['TatWithin14', ratio('sum(s.tat_within14)', 'count(s.lab_id)')],
    ['TatWithin48h_POC', ratio('sum(case when s.poc = 1 then s.poc_w48h else 0 end)', 'sum(s.poc)')],
    ['Male', count1("s.gender = 'Male'")],
    ['Female', count1("s.gender = 'Female'")],
    ['IndeterminateGender', count1("s.gender = 'Indeterminate'")],
    ['UnknownGender', count1("s.gender = 'Unknown'")],
    ['MissingGender', count1('s.gender is null')],
  ];
  const bands = (suffix, genderCond) => {
    const and = genderCond ? ` and ${genderCond}` : '';
    for (const [name, label] of BANDS) cols.push([`${name}${suffix}`, count1(`s.age_group = '${label}'${and}`)]);
    cols.push([`AgeMissing${suffix}`, count1(`s.age_group is null${and}`)]);
  };
  bands('', null);
  for (const [suffix, cond] of GENDERS) bands(suffix, cond);
  cols.push(
    ['Pregnant', count1('s.pregnant = 1')],
    ['PregnantSup', count1('s.pregnant = 1 and s.suppressed = 1')],
    ['BreastFeeding', count1('s.breastfeeding = 1')],
    ['BreastFeedingSup', count1('s.breastfeeding = 1 and s.suppressed = 1')],
    ['BaselineVL', count1('s.baseline_vl = 1')],
    ['BaselineVLSup', count1('s.baseline_vl = 1 and s.suppressed = 1')],
    ['NonBaselineTests', `count(s.lab_id) - ${count1('s.baseline_vl = 1')}`],
    ['NonBaselineVLSuppressed', `sum(s.suppressed) - ${count1('s.baseline_vl = 1 and s.suppressed = 1')}`],
    ['ThreeMPostUnSuppressed', 'sum(s.three_m_post_unsuppressed)'],
  );
  return cols;
}

export function vlDashboardSql() {
  const cols = dashColumns();
  // Which of the four shapes the area parameters make.
  const national = `(${blank('province')} and ${blank('district')} and ${blank('facility')})`;
  const provinceOnly = `(${given('province')} and ${blank('district')} and ${blank('facility')})`;
  const districtLevel = `(${given('province')} and ${given('district')} and ${blank('facility')})`;
  const facilityLevel = `(${given('province')} and ${given('district')} and ${given('facility')})`;
  const names = cols.map(([name]) => `a."${name}"`).join(', ');
  const zeros = cols.map(([name]) => `0 as "${name}"`).join(', ');
  return `with ${hivvlCte('hv', { from: 'from', to: 'to', extraDays: 1 })},
sc as (
  select * from hv
  where ${same('hv.province', 'province')}
    and ${same('hv.district', 'district')}
    and ${same('hv.facility', 'facility')}
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
where ${facilityLevel} and a.n = 0
order by 1, 2, 3`;
}

export const vlDashboardParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  facilityParam(),
  ...dateParams(true),
];

// ---- VL dashboard by sex and age ---------------------------------------------------------------
//
// Replaces sp_dash_getHIVVL_v2_List (the target) and covers two broken v1 views (spec ruling 2, below).
//
// Result sets. The inventory counts two. There is one report and one fallback. In every branch v1 runs
// `if exists (<the grouping>) select <the grouping> ... else select <a row of blanks and zeros>` (lines 24-49,
// 53-80, 85-112), so the second set is the "nothing found" row and never comes with the first. There is no
// second report (no "totals" set). This query gives the grouping, or the fallback row when it is empty.
//
// Rows come from the hivvl copy table (v1 sp_update_HIVVLTable), rebuilt by hivvlCte. One row per group:
//   no province, no district         Province, 'All', 'All', Gender, AgeGroup   one group per province (lines 34-47)
//   province                         Province, District, Facility, Gender, AgeGroup   one group per facility (lines 65-78)
//   province and district            the same, for the districts that match (lines 97-110)
// Gender and AgeGroup are 'Missing' when the hivvl value is NULL. The names in a row are the stored ones; the
// parameters match ignoring case and trailing spaces, as SQL Server does. Rows are ordered as v1 orders them:
// Province, District, Facility, Gender, AgeGroup. SQL Server's collation is case-blind; the port compares names
// lower-cased by byte, orders age groups by their label ('<01' first, '50+' last) and puts 'Missing' last.
//
// Window (lines 17-21, 29, 40). TestedDate is a datetime. v1 moves the end date one day forward and then tests
// `TestedDate between @StDate and @EDate` with NO cast to date. So a test counts when its local wall time is from
// from 00:00:00 up to and including (to + 1 day) 00:00:00. A test at exactly midnight of the day after `to` is in;
// one second later is out. This differs from sp_dash_getHIVVL_v2, which casts to a date and takes the whole day
// after `to` (the VL dashboard summary above). hivvlCte takes the wider whole-day window (extraDays 1) and the
// query then cuts it back to that midnight. The time is the stamp's own local time with the fraction dropped;
// DISA stamps have no fraction.
//
// Kept v1 quirks (spec ruling 1):
//   - The edge above: the first instant of the day after `to` is counted, so a test at exactly midnight shows
//     in two windows that touch (to = 05-31 and from = 06-01).
//   - A district without a province matches no branch (lines 22, 51, 83) and returns nothing, not even the
//     fallback row. Here too.
//   - With no province and no district the groups are per province, and District and Facility say 'All'. The
//     facility level only exists once a province is given.
//   - Gender knows F, M, I and U only; anything else, and a request with no patient, is 'Missing'.
//   - Pregnant, BreastFeeding, BaselineVL and ThreeMPostUnSuppressed are counted where the flag is 1 (zero when
//     none is set); Tests counts lab ids; TATWithin14 counts tests with a TAT of 14 days or less.
//   - A province over 20 characters or a district over 40 would be cut by v1's varchar parameters and match
//     nothing. The port matches the full name (evident intent). No Zambian name is that long.
//
// Result shape (v1 runs, so not a ruling 2 case): the fallback row in v1 has its own column list (no UnSuppressed,
// 'BaselinVL', 'TATwithin14'). A result keyed by column name cannot change its columns, so the fallback row uses
// the main column names, with UnSuppressed 0.
//
// Merged views (spec ruling 2). vSuppressionByFacility and vVLQuarterlyFacilitySuppressionRate both cannot run
// against the v1 scripts as written (inventory: the first selects Quarter, Month and Week that its source view
// lacks, and counts the text '< 1000 copies/ml' that the source never emits; the second tests '>= 1000 copies/ml',
// which the source never emits, so its rate is always 100.0). Their evident intent is suppressed and unsuppressed
// counts (and a rate) by facility, sex and age group. v1's own List already carries that:
//   - Suppressed and UnSuppressed by facility, Gender and AgeGroup are the v2_List columns (lines 35-36), with
//     hivvl's rule for "suppressed" (a number under 1000, or a text on the suppressed list), not the views' text
//     lists.
//   - The views' rate is Suppressed / Tests as a percent (the second view, line 40). It is not a column, because the
//     List runs in v1 and keeps v1's 14 columns (spec ruling 1). Divide the two columns to get it.
//   NOT covered, and not claimed:
//   - The time split. vSuppressionByFacility groups by Year, Quarter, Month and Week, and vVLQuarterlyFacilitySuppressionRate
//     by Year. This query has no time column. Run it once per quarter, month or week (set from and to) to get that split.
//   - A facility level for the whole country. With no province the groups are per province (the List rule).
//   - RequestingFacilityCode (the first view) is not a column.
//   - The views' own age groups ('0-14' and '15+' in the second) and their text result lists. The age groups here
//     are hivvl's.
//   - The second view counts distinct request ids; here a test is a lab id after hivvl's one-row-per-lab-id dedupe,
//     which is the same unit.
//
// CE gaps (spec ruling 7): none of its own. Pregnant, BreastFeeding, BaselineVL and ThreeMPostUnSuppressed read
// the VIRAL form (spec ruling 6), so they are 0 until cdr-toolchain sends that form.
//
// Windows: `from` and `to` are required (spec ruling 3). v1 defaulted a missing start and end to last month.

const AGE_ORDER = ['<01', '01-04', '05-09', '10-14', '15-19', '20-24', '25-29', '30-34', '35-39', '40-44', '45-49', '50+', 'Missing'];
const SEX_AGE_COLUMNS = ['Province', 'District', 'Facility', 'Gender', 'AgeGroup', 'Tests', 'Suppressed', 'UnSuppressed', 'Undetectable',
  'TATWithin14', 'Pregnant', 'BreastFeeding', 'BaselineVL', 'ThreeMPostUnSuppressed'];

export function vlSexAgeSql() {
  const national = `(${blank('province')} and ${blank('district')})`;
  // A district without a province: no branch in v1.
  const supported = `not (${blank('province')} and ${given('district')})`;
  const label = (column) => `lower(rtrim(${column})) collate "C" nulls first, ${column} collate "C" nulls first`;
  return `with ${hivvlCte('hv', { from: 'from', to: 'to', extraDays: 1 })},
sc as (
  select hv.province, case when ${national} then null else hv.district end as district,
    case when ${national} then null else hv.facility end as facility,
    coalesce(hv.gender, 'Missing') as gender, coalesce(hv.age_group, 'Missing') as age_group,
    hv.lab_id, hv.suppressed, hv.uu, hv.tat_within14, hv.pregnant, hv.breastfeeding, hv.baseline_vl, hv.three_m_post_unsuppressed
  from hv
  where ${supported}
    and ${localTs('hv.tested_date')} <= (({{param.to}})::date + 1)::timestamp
    and ${same('hv.province', 'province')}
    and ${same('hv.district', 'district')}
),
agg as (
  select s.province, s.district, s.facility, s.gender, s.age_group,
    count(s.lab_id) as tests, sum(s.suppressed) as supp, sum(s.uu) as uu, sum(s.tat_within14) as w14,
    sum(coalesce(s.pregnant, 0)) as preg, sum(coalesce(s.breastfeeding, 0)) as bf,
    sum(coalesce(s.baseline_vl, 0)) as base, sum(coalesce(s.three_m_post_unsuppressed, 0)) as m3
  from sc s
  group by s.province, s.district, s.facility, s.gender, s.age_group
)
select ${SEX_AGE_COLUMNS.map((c) => `u."${c}"`).join(', ')}
from (
  select a.province as k1, a.district as k2, a.facility as k3, a.gender as k4, a.age_group as k5,
    a.province as "Province", case when ${national} then 'All' else a.district end as "District",
    case when ${national} then 'All' else a.facility end as "Facility", a.gender as "Gender", a.age_group as "AgeGroup",
    a.tests as "Tests", a.supp as "Suppressed", a.tests - a.supp as "UnSuppressed", a.uu as "Undetectable",
    a.w14 as "TATWithin14", a.preg as "Pregnant", a.bf as "BreastFeeding", a.base as "BaselineVL",
    a.m3 as "ThreeMPostUnSuppressed"
  from agg a
  union all
  select null::text, null::text, null::text, null::text, null::text,
    ''::text, ''::text, ''::text, ''::text, ''::text,
    0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint
  where ${supported} and not exists (select 1 from agg)
) u
order by ${label('u.k1')}, ${label('u.k2')}, ${label('u.k3')}, u.k4 collate "C",
  array_position(array[${sqlList(AGE_ORDER)}], u.k5), u.k5 collate "C"`;
}

export const vlSexAgeParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  ...dateParams(true),
];

// ---- VL monthly trend --------------------------------------------------------------------------
//
// Replaces sp_dash_getMonthlyVLTrend. Rows come from the hivvl copy table, rebuilt by hivvlCte.
// One row per month that has a test: MonthID is 'YYYY - MM' of the local date of the authorised date (line 14:
// concat(Year, ' - ', Format(TestedDate, 'MM'))), then the counts of that month, ordered by MonthID. A month with no
// test has no row.
//
// Which tests count depends on the area parameters (lines 13, 28, 43, 60):
//   province                     that province
//   province and district        that district
//   province, district, facility that facility
//   anything else                everything (no filter)
// The names match ignoring case and trailing spaces.
//
// Kept v1 quirks (spec ruling 1):
//   - Any other combination falls to the last branch and filters nothing (line 60): a district without a
//     province, a facility without a province, or a province and facility without a district all show all of
//     Zambia. (sp_dash_getHIVVL_v2_List and the VL dashboard summary return nothing for these.)
//   - Pregnant, BreastFeeding and Baseline (line 17) are sums of columns that are NULL unless the flag is set, so a month
//     with no flagged test shows NULL, not 0. Undetectable and Within14 are 0 when none.
//   - The month is the local date of the stamp: a test authorised at 2026-05-01T00:30:00+02:00 is in May, not in
//     April as its UTC date would say.
//   - v1's @Province is varchar(20), @District varchar(40) and @Facility varchar(40); hivvl's Facility is
//     nvarchar(50). A name over the parameter's length never matches in v1. The port matches the full name
//     (evident intent).
//
// Deviation (spec ruling 3): v1's window is fixed, the 12 full months before the current month (lines 19-21).
// Here `from` and `to` are required and the grouping by month is unchanged, so the first and last month are
// partial when the window does not start and end on month edges. A 12-month trend is a window of 12 months.
//
// CE gaps (spec ruling 7): none of its own. Pregnant, BreastFeeding and Baseline read the VIRAL form (spec ruling 6),
// so they are NULL until cdr-toolchain sends that form.

export function vlTrendSql() {
  // The three shapes v1 filters on (lines 13, 28, 43). Everything else is the unfiltered last branch.
  const filtered = `(${given('province')} and not (${blank('district')} and ${given('facility')}))`;
  const month = localDate('hv.tested_date');
  return `with ${hivvlCte('hv', { from: 'from', to: 'to' })}
select to_char(${month}, 'YYYY - MM') as "MonthID", count(hv.lab_id) as "Tests", sum(hv.suppressed) as "Suppressed",
  sum(hv.uu) as "Undetectable", sum(hv.tat_within14) as "Within14", sum(hv.pregnant) as "Pregnant",
  sum(hv.breastfeeding) as "BreastFeeding", sum(hv.baseline_vl) as "Baseline"
from hv
where ${month} is not null
  and (not ${filtered} or (${same('hv.province', 'province')} and ${same('hv.district', 'district')} and ${same('hv.facility', 'facility')}))
group by 1
order by 1`;
}

export const vlTrendParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  facilityParam(),
  ...dateParams(true),
];

// ---- Client by ART number ----------------------------------------------------------------------
//
// Replaces sp_GetDetailsFromARTNumber. Given an ART number, lists the lab number and the name of every client
// whose derived ART number equals it. One row per lab number; no date window, no panel filter, every request (v1
// scans all of Patients).
//
// The ART number (lookup lines 22-28), from the two request attributes reference-numbers (v1 REFNO) and unique-id
// (v1 UNIQUEID). artNumberShortSql follows this procedure: it has NO ",ELABS" text-extraction steps, which
// sp_GetPreviousVLResultforCohort2x (artNumberSql, used by "VL clients by province") has. So ",ELABS 12AT.3456" is
// 'ELABS123456' here and '3456' there. The rules, in v1's order:
//   REFNO blank after removing commas, "AT.", spaces and dashes   UNIQUEID without spaces and dashes
//   REFNO (less commas and "AT.") starts "ART." or "ELABS."       UNIQUEID without spaces and dashes
//   otherwise                                                     REFNO without commas, "AT.", spaces and dashes
// The comparison with the parameter ignores case and trailing spaces, as SQL Server does.
//
// Kept v1 quirks (spec ruling 1):
//   - The derived value has no dashes or spaces; the parameter is compared as typed. 'AB-1234' finds nothing when the
//     ART number is stored as 'AB-1234' in UNIQUEID (the dash is removed from the stored value, not from the parameter).
//   - A client with several requests gives one row per lab number, each with the same name, as v1 gives one per
//     Patients row.
//   - v1's @ARTNumber is varchar(20), so a longer parameter is cut and can match a shorter value by accident. The
//     port compares the full text (evident intent). No ART number is that long.
//
// Rows. v1 reads Patients, one row per RequestID. A warehouse request row (lab_requests) is the nearest unit; a lab
// number with several request rows (OBR sets) has the same patient and ids on each, so the port shows each (lab
// number, first name, surname) once (select distinct). HONEST NON-PROOF: the v1 Patients key is not in the pack's v1
// folder; the one-row-per-RequestID reading comes from sp_getFacilityVLClientDetails, which joins Patients on
// RequestID with no row multiplier. A request with no patient still lists, with empty names (v1's Patients row exists
// without them).
//
// CE gaps (spec ruling 7):
//   - HOSPID is not sent. v1 gives HOSPID as the ART number of a client whose REFNO is blank and whose HOSPID is set
//     (lookup line 23). CE has no such value, so that client is found by UNIQUEID (if that is what is typed) and not by
//     the hospital number.
//   - A missing attribute reads as '' (cdr sends nothing for an empty ID; v1 holds ''). A request with no attributes has
//     ART number '' and matches only a blank parameter.
//   - PII: this query returns patient names, as v1 does.
export function artLookupSql() {
  const art = artNumberShortSql("coalesce(zi.reference_numbers, '')", "coalesce(zi.unique_id, '')");
  return `with ${zmIdsCte('zm_ids')},
found as (
  select distinct lr.request_id as lab_number, p.firstname, p.surname
  from lab_requests lr
  left join zm_ids zi on zi.lab_request_id = lr.id
  left join patients p on p.id = lr.patient_id
  where ${foldSql(art)} = ${foldSql('{{param.art_number}}')}
)
select f.lab_number as "Lab Number", f.firstname as "FIRSTNAME", f.surname as "SURNAME"
from found f
order by f.lab_number collate "C", f.firstname collate "C", f.surname collate "C"`;
}

export const artLookupParams = () => [
  { id: 'art_number', label: 'ART number', type: 'text', required: true },
];

// ---- VL results for a facility's clients -------------------------------------------------------
//
// Replaces sp_getFacilityVLClientDetails. One row per final HIVVL/HIVVC result of one facility's clients with an
// analysis time in the window: the ART number, the result text, suppressed and unsuppressed flags and three
// turnaround times.
//
// Rows (facility lines 25-70): a request (lab_requests) with a result (lab_results) and a final report
// (diagnostic_reports; v1 HL7ResultStatusCode F, line 68). Panel HIVVL only (not POCVR or POHVL); observation HIVVL or HIVVC;
// the result text (rpt) is not NULL and not one of 13 texts (INVAL, Please repeat, Insufficient serum received,
// Insufficient for further tests, Indeterminate, Haemolysed, FAIL, Absent, Haemolysed ++, Icteric ++++, INV, This
// result has been checked, to confirm patient identity.). NOT IN drops a NULL result. Lists compare ignoring case and
// trailing spaces, as SQL Server does.
//
// Columns: Facility Name (the register name of the requesting facility), SerialNumber, ARTNo, VL Result (the reported
// text, rpt), Suppressed, Unsupressed (v1's spelling) and the three TATs:
//   Suppressed   1 when the text is on the list (<20 copies/mL, TAR, Target Not Detected, TARG, < 20, RNA not
//                detected, <30 copies/ml, <30 copies/mL, NDET), or the text is a number under 1000, or the result has
//                a coded value (length over 0). Else 0. (Facility lines 36-40.)
//   Unsupressed  1 when the text is a number of 1000 or more, or starts '>10000000'. Else 0. (Lines 41-44.)
//                So one result can be 1 in both (a number of 3000 with a coded value), and a text on neither list
//                (Negative, ND, a decimal that v1 cannot read) is 0 in both.
//   TAT1         days from collected (diagnostic_reports.effective) to registered (lab_requests.authored_at); NULL
//                when either is missing. TAT2 days from registered to analysis (lab_requests.analysis_at). Both are
//                v1's datediff(dd), the boundaries between LOCAL calendar dates, each taken from the stamp's own text.
//   TAT3         hours from analysis to authorised (diagnostic_reports.issued): v1's datediff(second) cast to
//                decimal(10,2) and divided by 3600. SQL Server gives decimal(15,7): 7 decimals, cut not rounded
//                (measured on the local SQL Server: 100 s is 0.0277777). The port truncates to 7 decimals. NULL
//                when either stamp is missing or not a full stamp.
//
// ART number (facility lines 28-34): artNumberRawSql, from the attributes reference-numbers (REFNO) and unique-id (UNIQUEID):
// REFNO less commas and "AT." blank, or starts "ART." or "ELABS.": UNIQUEID as it is; else that REFNO. Unlike the lookup
// above, spaces and dashes stay in the value.
//
// Kept v1 quirks (spec ruling 1):
//   - SerialNumber is row_number() over the whole window ordered by the lab number, computed BEFORE the facility
//     filter (CTE line 27, filter line 83). So the numbers of one facility have gaps and do not start at 1: rows of
//     other facilities, of a facility missing from the register, and of a code in no map are numbered too. The
//     numbering is over the rows of the window, so a different window renumbers. Ties (several results of one lab
//     number) are numbered in v1's unspecified order; the port breaks them on the row ids. The lab number sorts as
//     SQL Server sorts it (ssTextKey: the word sort of the Latin1_General_CI_AS columns of v1, ignoring case, trailing spaces, hyphens and
//     apostrophes; the hyphen ties 'U8-1' with 'U81'), then byte order.
//   - The window (line 66) is AnalysisDateTime BETWEEN @StartDate AND @EndDate with dates, i.e. midnight: analysis from from
//     00:00:00 up to and including to 00:00:00 (local wall time). So the end day is out apart from its first instant,
//     and from = to returns only analyses at exactly midnight. Same as fn_GeneXpertReport (spec ruling 1, kept).
//   - Suppressed = 1 for ANY coded value, even beside a number of 1000 or more (both flags 1), and for a coded value
//     alone (the VL Result is then the coded value).
//   - The suppressed list here is shorter than the hivvl copy table's: 'ND', '<20CP', '< 40', 'DET' and the rest are
//     not on it, so they count 0 here.
//   - The facility is matched on its name (Facilities.Description), not its code, and ignoring case and trailing
//     spaces. Two register entries with one name both show.
//   - v1 joins the facility dictionary and HealthcareAreas inside the CTE and never reads them (lines 59-61); not ported.
//   - v1's @Facility is varchar(50): a longer name is cut and matches nothing. The port compares the full name.
//
// Deviations (spec ruling 2):
//   - v1 casts the result text to bigint to test it against 1000 (lines 37, 41). A decimal text ('999.5'), a text with a
//     thousands comma or an exponent makes that cast fail, and v1 stops with a conversion error (measured on the local
//     SQL Server: try_cast gives NULL for all three). The port reads the number (numberOfTextSql: commas dropped, no
//     currency sign), so '999.5' is suppressed and '1200.5' is unsuppressed. Same handling as Task 5's surveillance
//     procedure. These expectations are intent, not v1 output.
//   - The facility parameter is required and has no "all" mode (v1 has none; the facilityParam used elsewhere means
//     "all" when blank). A blank name matches no facility.
//
// CE gaps (spec ruling 7): HOSPID is not sent, so the ART number of a client with blank REFNO and a HOSPID is UNIQUEID
// (see artNumberRawSql). A missing attribute reads as ''. Requesting facility and its name come from the mapped register
// row, so a name can differ from v1's Facilities.Description (README). Window: `from` and `to` are required (spec ruling 3).
const INVALID_VL_TEXTS = ['INVAL', 'Please repeat', 'Insufficient serum received', 'Insufficient for further tests', 'Indeterminate',
  'Haemolysed', 'FAIL', 'Absent', 'Haemolysed ++', 'Icteric ++++', 'INV', 'This result has been checked', 'to confirm patient identity.'];
const SUPPRESSED_VL_TEXTS = ['<20 copies/mL', 'TAR', 'Target Not Detected', 'TARG', '< 20', 'RNA not detected', '<30 copies/ml', '<30 copies/mL', 'NDET'];

export function facilityClientsSql() {
  const art = artNumberRawSql("coalesce(zi.reference_numbers, '')", "coalesce(zi.unique_id, '')");
  const result = rpt('l');
  const number = numberOfTextSql('s.result_text');
  const seconds = (to, from) => `extract(epoch from date_trunc('second', ${utcTs(to)}) - date_trunc('second', ${utcTs(from)}))::numeric`;
  return `with ${zmIdsCte('zm_ids')},
src as (
  select lr.id as request_row_id, dr.id as report_row_id, l.id as result_row_id, lr.request_id as lab_id,
    fmr.name as facility_name, ${result} as result_text, l.coded_value,
    lr.authored_at, lr.analysis_at, dr.effective, dr.issued,
    ${art} as art_no
  from lab_requests lr
  join lab_results l on l.request_id = lr.id
  join diagnostic_reports dr on dr.based_on_id = lr.id
  ${requesterJoin('lr', 'fmr', 'left join')}
  left join zm_ids zi on zi.lab_request_id = lr.id
  where ${inListSql('lr.panel_code', ['HIVVL'])}
    and ${inListSql('l.observation_code', ['HIVVL', 'HIVVC'])}
    and dr.status = 'final'
    and ${localTs('lr.analysis_at')} >= ({{param.from}})::date::timestamp
    and ${localTs('lr.analysis_at')} <= ({{param.to}})::date::timestamp
    and not ${inListSql(result, INVALID_VL_TEXTS)}
),
tests as (
  select row_number() over (order by ${ssTextKey('s.lab_id')} collate "C", s.lab_id collate "C", s.request_row_id, s.result_row_id, s.report_row_id) as serial,
    s.facility_name, s.art_no, s.result_text,
    case when (${inListSql('s.result_text', SUPPRESSED_VL_TEXTS)} or ${number} < 1000 or length(rtrim(s.coded_value)) > 0) then 1 else 0 end as suppressed,
    case when (${number} >= 1000 or s.result_text ilike '>10000000%') then 1 else 0 end as unsuppressed,
    ${localDate('s.authored_at')} - ${localDate('s.effective')} as tat1,
    ${localDate('s.analysis_at')} - ${localDate('s.authored_at')} as tat2,
    trunc(${seconds('s.issued', 's.analysis_at')} / 3600, 7) as tat3
  from src s
)
select t.facility_name as "Facility Name", t.serial as "SerialNumber", t.art_no as "ARTNo", t.result_text as "VL Result",
  t.suppressed as "Suppressed", t.unsuppressed as "Unsupressed", t.tat1 as "TAT1", t.tat2 as "TAT2", t.tat3 as "TAT3"
from tests t
where t.facility_name is not null and ${foldSql('t.facility_name')} = ${foldSql('{{param.facility}}')}
order by t.serial`;
}

export const facilityClientsParams = () => [
  { ...facilityParam(), label: 'Facility (name as in the register)', required: true },
  ...dateParams(true),
];

// ---- Earlier VL results of high-VL clients, VL results history by client ------------------------------
//
// Both queries read one client's results over time. A client is a (facility name, ART number) pair. They share two row sets,
// "x" (the history rows) and "z" (the cohort rows), built below from v1's CTEs x and z
// (sp_GetPreviousVLResultforCohort lines 20-102, sp_GetPreviousVLResultforCohort2 lines 20-110; the _Prega copy has the same x and z).
//
// x, the history rows: one row per request x result x final report (v1 HL7ResultStatusCode F is diagnostic_reports.status
// 'final'), with the mapped requesting facility (province, district and name of the register row; v1 inner-joins its facility
// dictionary), the patient's sex, the ART number and the result text (rpt). Panel HIVVL; observation HIVVL and HIVVC (T1) or also
// HIVVD (T2). The result text is not NULL and not one of 20 texts ('antibodies. @mat3', 'No', 'per request', 'Positive (Repeat
// sample)', 'Weak Positive', 'Yes', '', INVAL, Please repeat, Insufficient serum received, Insufficient for further tests,
// Indeterminate, Haemolysed, FAIL, Absent, Haemolysed ++, Icteric ++++, INV, This result has been checked, to confirm patient
// identity.). NOT IN drops a NULL result. Lists compare ignoring case and trailing spaces, as SQL Server does.
// History window (lines 55-56): datediff(dd, authorised, @StartDate) < 366 (T1) or < 730 (T2), and authorised < @EndDate. Dates are
// LOCAL: datediff counts the boundaries between local calendar dates and `authorised < @EndDate` compares the local wall time with
// the end date at 00:00:00. `authorised` is diagnostic_reports.issued; a partial stamp has no date and drops out.
// Visit (v1 row_number, lines 23-33): per (province, district, facility, panel, sex, ART number) ordered by authorised time, oldest
// first (T1) or newest first (T2). Equal times go to the lab number, then the row ids: v1 leaves them open.
// The ART number is artNumberShortSql: the rule of lines 25-29 has the HOSPID steps, and HOSPID is not sent (ruling 7), so HOSPID is
// read as blank. Then a blank REFNO sends the client to UNIQUEID, and the rule is the one of "Client by ART number".
//
// z, the cohort rows (T1 lines 74-102, T2 lines 74-110): request x result x final report with the mapped facility and the ART number
// whose authorised time is BETWEEN @StartDate AND @EndDate. With dates v1 compares at 00:00:00, so the window runs from the start
// date at 00:00:00 to the end date at 00:00:00, local time: the end day is out apart from its first instant, and a one-day window
// holds only results at exactly midnight (the same decision as the facility report). A partial stamp drops out.
//   T1 (lines 92-101): any panel, any observation; the result is a number of more than three characters (ISNUMERIC and
//     LEN(RTRIM(LTRIM(x))) > 3). The test is on the result text, not the number.
//   T2 (lines 92-108): panel HIVVL, observation HIVVL, HIVVC or HIVVD, result not NULL and not on the 20-text list.
// x joins z on the facility NAME and the ART number, both ignoring case and trailing spaces.
const COHORT_EXCLUDED_TEXTS = ['antibodies. @mat3', 'No', 'per request', 'Positive (Repeat sample)', 'Weak Positive', 'Yes', '', 'INVAL',
  'Please repeat', 'Insufficient serum received', 'Insufficient for further tests', 'Indeterminate', 'Haemolysed', 'FAIL', 'Absent',
  'Haemolysed ++', 'Icteric ++++', 'INV', 'This result has been checked', 'to confirm patient identity.'];

const cohortFrom = '({{param.from}})::date';
const cohortTo = '({{param.to}})::date::timestamp';
// The window of z (BETWEEN with dates at 00:00:00, local) on a local-time SQL expression.
const cohortWindow = (ts) => `${ts} >= ${cohortFrom}::timestamp and ${ts} <= ${cohortTo}`;
const cohortArt = () => artNumberShortSql("coalesce(zi.reference_numbers, '')", "coalesce(zi.unique_id, '')");

// The history rows x. `observations`: the observation codes; `days`: the history length; `direction`: 'asc' or 'desc'.
function cohortHistoryCtes({ observations, days, direction }) {
  const result = rpt('l');
  return `x_src as (
  select lr.id as request_row_id, dr.id as report_row_id, l.id as result_row_id, lr.request_id as lab_id,
    fmr.region as province, fmr.district as district, fmr.name as facility, lr.panel_code, p.sex,
    ${localTs('dr.issued')} as issued_ts, ${cohortArt()} as art_no, ${result} as result_text
  from lab_requests lr
  join lab_results l on l.request_id = lr.id
  join diagnostic_reports dr on dr.based_on_id = lr.id
  ${requesterJoin('lr', 'fmr')}
  left join zm_ids zi on zi.lab_request_id = lr.id
  left join patients p on p.id = lr.patient_id
  where ${inListSql('lr.panel_code', ['HIVVL'])}
    and ${inListSql('l.observation_code', observations)}
    and dr.status = 'final'
    and (${cohortFrom} - ${localDate('dr.issued')}) < ${days}
    and ${localTs('dr.issued')} < ${cohortTo}
    and not ${inListSql(result, COHORT_EXCLUDED_TEXTS)}
),
x as (
  select s.*, row_number() over (
    partition by ${foldSql('s.province')}, ${foldSql('s.district')}, ${foldSql('s.facility')}, ${foldSql('s.panel_code')}, ${foldSql('s.sex')}, ${foldSql('s.art_no')}
    order by s.issued_ts ${direction}, s.lab_id collate "C", s.request_row_id, s.result_row_id, s.report_row_id) as visit
  from x_src s
)`;
}

// The cohort rows z. `where` is the filter after the window (it reads the result text `result_text`).
function cohortRowsCte(where) {
  const result = rpt('l');
  return `z as (
  select fmr.name as facility, ${cohortArt()} as art_no
  from lab_requests lr
  join lab_results l on l.request_id = lr.id
  join diagnostic_reports dr on dr.based_on_id = lr.id
  ${requesterJoin('lr', 'fmr')}
  left join zm_ids zi on zi.lab_request_id = lr.id
  where dr.status = 'final'
    and ${cohortWindow(localTs('dr.issued'))}
    and ${where(result)}
)`;
}

const sameClient = (a, b) => `${foldSql(`${a}.facility`)} = ${foldSql(`${b}.facility`)} and ${foldSql(`${a}.art_no`)} = ${foldSql(`${b}.art_no`)}`;

// ---- Earlier VL results of high-VL clients (v1 sp_GetPreviousVLResultforCohort) ----
//
// Params: from, to (required text, YYYY-MM-DD, ruling 3). One row per client with a cohort result in the window: Province, District,
// Facility, ARTNumber, then the columns 1 to 10: the result text of visits 1 to 10, oldest first (v1 PIVOT with MAX, lines 114-119).
// A client with no x row has no output row.
//
// Kept v1 quirks (ruling 1):
//   - The cohort test has no panel or observation filter (lines 92-101): a result of ANY test that is a number of four characters or
//     more puts the client in the cohort ('3000' of an HIVTM row, '1,500', '1.5E10' all count; '300' does not). The history shown is
//     HIVVL and HIVVC only.
//   - Visits are numbered inside (province, district, facility, panel, SEX, ART number): a client whose sex differs between requests has
//     two series. The PIVOT groups by province, district, facility and ART number only, so the series are merged and MAX keeps the
//     greater TEXT of each visit slot ('120' beats '110'; '99' beats '100'; '2500' beats '<20 copies/mL', as the comparison is one of
//     SQL Server's text order: punctuation before digits before letters, case and trailing spaces ignored, hyphens and apostrophes ignored
//     as in v1's Latin1_General_CI_AS columns). The port takes the greater text in that order (ssTextKey), then byte order for equal texts.
//   - The client is the facility NAME and the ART number: ART numbers that differ only in case are one client (the case shown is the
//     one that sorts first in byte order; v1 shows either). A blank ART number (no REFNO and no UNIQUEID) groups with every other
//     such client of the facility.
//   - v1 joins x to z, so an x row repeats once per cohort row of the client; MAX takes the same value again, so the port tests
//     for a cohort row instead (same output).
//   - Visits past 10 are not shown (the PIVOT lists 1 to 10); a result at exactly the end date is not in x (authorised < end date)
//     though it can put the client in the cohort (BETWEEN includes it).
//   - ORDER BY province, district, facility, ART number (line 121), comparing as SQL Server does, then byte order.
//
// CE gaps (spec ruling 7): HOSPID is not sent (see artNumberShortSql). Facility, district and province are the mapped register row's;
// v1 also drops a facility whose province or district is missing from HealthcareAreas (lines 48-51), which the port does not do (as the
// other queries). The register can spell a name differently from v1's dictionary (README).
export function cohortSql() {
  const visits = Array.from({ length: 10 }, (_, i) => i + 1);
  const pick = (n) => `(array_agg(x.result_text order by ${ssTextKey('x.result_text')} collate "C" desc, x.result_text collate "C" desc) filter (where x.visit = ${n}))[1] as v${n}`;
  return `with ${zmIdsCte('zm_ids')},
${cohortHistoryCtes({ observations: ['HIVVL', 'HIVVC'], days: 366, direction: 'asc' })},
${cohortRowsCte((result) => `${isNumericSql(result)} and length(btrim(${result})) > 3`)}
select g.province as "Province", g.district as "District", g.facility as "Facility", g.art_no as "ARTNumber",
  ${visits.map((n) => `g.v${n} as "${n}"`).join(', ')}
from (
  select min(x.province collate "C") as province, min(x.district collate "C") as district, min(x.facility collate "C") as facility,
    min(x.art_no collate "C") as art_no,
    ${visits.map(pick).join(',\n    ')}
  from x
  where exists (select 1 from z where ${sameClient('z', 'x')})
  group by ${foldSql('x.province')}, ${foldSql('x.district')}, ${foldSql('x.facility')}, ${foldSql('x.art_no')}
) g
order by ${ssTextKey('g.province')} collate "C" nulls first, ${ssTextKey('g.district')} collate "C" nulls first,
  ${ssTextKey('g.facility')} collate "C" nulls first, ${ssTextKey('g.art_no')} collate "C" nulls first,
  g.province collate "C", g.district collate "C", g.facility collate "C", g.art_no collate "C"`;
}

export const cohortParams = () => dateParams(true);

// ---- VL results history by client (v1 sp_GetPreviousVLResultforCohort2, with sp_GetPreviousVLResultforCohort2_Prega merged in) ----
//
// Params: from, to (required text, YYYY-MM-DD, ruling 3), province (select, blank = all; v1's Cohort2 fixed it to 'Lusaka', line 124),
// pregnant_only (select 'no' or 'yes'; 'yes' is the _Prega copy, which had no province filter: leave province blank for it).
// One row per client result (long format): Province, District, Facility, ARTNumber, Rank (1 = the newest result), SuppressionStatus,
// ResultDate, Result. The rows are every x row of a client who has a cohort row (z) in the window. x reads 730 days of history and the
// observations HIVVL, HIVVC and HIVVD (lines 53-56). z is the cohort of Cohort2 lines 74-110.
//
// SuppressionStatus (lines 114-117): 'Suppressed' when the result is not a number, or a number under 1000; else 'UnSuppressed'.
// ResultDate (line 118): convert(varchar, authorised, 100), 'Mon dd yyyy hh:mmAM' with the day and the hour padded with a space
// ('May  9 2026  8:00AM'), the local wall time, seconds cut.
//
// pregnant_only = yes (Prega lines 111-129 and 142-144): only clients (facility name + ART number) with a VIRAL-panel answer in the
// window saying pregnant: ARTPR or VPREG answered Y (v1: LIMSCodedValue 'Y'), or ARTRS answered 'Pregnant Mother'. CE holds the VIRAL
// panel as the form hiv_vl_documentation (ruling 6) and the answer is the reported TEXT, so the port reads Yes, Y or Yest (the rule of the
// hivvl copy table; ignoring case and trailing spaces) for ARTPR and VPREG, and the text 'Pregnant Mother' for ARTRS. v1 reads the VIRAL
// REQUEST (panel VIRAL, authorised between @StartDate and @EndDate). CE has no VIRAL request, so the port takes each request row that
// holds the form (any panel), gets its facility and ART number from that row, and takes "authorised in the window" from the reports of
// the same lab number (any status: v1 has no status test there): the lab number has a report authorised in the window (the BETWEEN of z).
// y is distinct, so it adds no rows beyond the semi-join (Prega line 112 is select distinct).
//
// Kept v1 quirks (ruling 1):
//   - x is joined to z, which has one row per cohort result (not per client), so every history row of a client is repeated once per
//     result the client has in the window: a client with two valid results in the window shows each history row twice. The Prega
//     copy joins y as well (distinct), which does not repeat rows.
//   - SuppressionStatus calls any text that is not a number 'Suppressed', even junk the exclusion list misses.
//   - Rank 1 is the newest result; visits count per sex (a client's two sexes give two series) and the rows are not merged.
//   - The window is BETWEEN with dates (the end day is out apart from its first instant); a result at exactly the end date is a cohort
//     row but not a history row (authorised < end date).
//   - x joins z on the facility name and the ART number. A blank ART number groups with every such client of the facility.
//   - The Prega copy's province is not filtered: a blank province gives that.
//
// Deviations (ruling 2):
//   - cast(LIMSRptResult as int) (lines 115, 133) stops v1 for a decimal text ('123.4'), a thousands comma ('5,000') or an exponent
//     ('1E3'). The port reads the number (commas dropped): '123.4' is Suppressed, '5,000' and '1E3' (1000) are not. A currency sign has
//     no number here and counts as not a number (Suppressed).
//   - The Prega copy's VIRAL request has no counterpart in CE (see above); the window comes from the lab number's reports.
//
// CE gaps (spec ruling 7): HOSPID is not sent (artNumberShortSql). Province, district and facility are the register row's.
//
// Rows come out ordered by province, district, facility, ART number (line 131, comparing as SQL Server does). v1 orders no further; the
// port adds rank, then authorised time, then the result, so that paging is stable.
export function historySql() {
  const result = 'x.result_text';
  const number = numberOfTextSql(result);
  const t = 'x.issued_ts';
  const resultDate = `to_char(${t}, 'Mon') || ' ' || lpad(extract(day from ${t})::int::text, 2) || ' ' || to_char(${t}, 'YYYY') || ' ' || lpad(to_char(${t}, 'FMHH12'), 2) || ':' || to_char(${t}, 'MI') || to_char(${t}, 'AM')`;
  const pregnantAnswers = `${inListSql(formAnswerSql('q.id', 'VPREG'), YES_WORDS)} or ${inListSql(formAnswerSql('q.id', 'ARTPR'), YES_WORDS)} or ${inListSql(formAnswerSql('q.id', 'ARTRS'), ['Pregnant Mother'])}`;
  return `with ${zmIdsCte('zm_ids')},
${cohortHistoryCtes({ observations: ['HIVVL', 'HIVVC', 'HIVVD'], days: 730, direction: 'desc' })},
${cohortRowsCte((r) => `${r} is not null and not ${inListSql(r, COHORT_EXCLUDED_TEXTS)} and ${inListSql('lr.panel_code', ['HIVVL'])} and ${inListSql('l.observation_code', ['HIVVL', 'HIVVC', 'HIVVD'])}`)},
y as (
  select distinct fmr.name as facility, ${cohortArt()} as art_no
  from lab_requests q
  ${requesterJoin('q', 'fmr')}
  left join zm_ids zi on zi.lab_request_id = q.id
  where ${foldSql('{{param.pregnant_only}}')} = 'yes'
    and (${pregnantAnswers})
    and exists (select 1 from lab_requests q2 join diagnostic_reports d2 on d2.based_on_id = q2.id
      where q2.request_id = q.request_id and ${cohortWindow(localTs('d2.issued'))})
)
select x.province as "Province", x.district as "District", x.facility as "Facility", x.art_no as "ARTNumber", x.visit as "Rank",
  case when coalesce(${number} < 1000, true) then 'Suppressed' else 'UnSuppressed' end as "SuppressionStatus",
  ${resultDate} as "ResultDate", ${result} as "Result"
from x
join z on ${sameClient('z', 'x')}
where ${same('x.province', 'province')}
  and (${foldSql('{{param.pregnant_only}}')} <> 'yes' or exists (select 1 from y where ${sameClient('y', 'x')}))
order by ${ssTextKey('x.province')} collate "C" nulls first, ${ssTextKey('x.district')} collate "C" nulls first,
  ${ssTextKey('x.facility')} collate "C" nulls first, ${ssTextKey('x.art_no')} collate "C" nulls first,
  x.province collate "C", x.district collate "C", x.facility collate "C", x.art_no collate "C",
  x.visit, x.issued_ts, x.result_text collate "C"`;
}

// pregnant_only is a select with the two answers; blank counts as no.
const pregnantOnlyParam = () => ({
  id: 'pregnant_only', label: 'Pregnant clients only (yes or no)', type: 'select', required: false,
  optionsSql: "select 'no' as pregnant_only union all select 'yes'",
});

export const historyParams = () => [
  ...dateParams(true),
  provinceParam('province', false),
  pregnantOnlyParam(),
];

// ---- VL testing summary by province, by district, by facility ---------------------------------------------------------
//
// Replaces sp_getSummaryTestEpiData (province, "P"), sp_getSummaryTestEpiDataDistrict ("D") and sp_getSummaryTestEpiDataFacility
// ("F"). The inventory called D and F merges of P. They are three queries here (controller ruling): the three procedures
// return different column names (Province / District / District and Facility Name) and keep different rules, so one column list
// could not match v1 at every level. One builder (epiSummarySql in zm-sql.mjs) holds the code they have in common.
//
// Columns (v1 names and order). P: Province, Registrations, Tests, suppressed, Unsuppressed, TATTests, TATpre. D: District, then the
// same six. F: District, Facility Name, then the same six. TATpre = average days x TATTests; the caller divides TATpre by TATTests.
// Parameters as v1: P from, to; D province, from, to; F district, from, to. Province and district are required selects (v1 has no
// "all" mode: a blank name matches nothing); from and to are required (spec ruling 3).
//
// Rows. One per area name (P: province; D: district of the province, a NULL district is one row; F: district and facility name, so
// two register entries with one name merge), ordered as v1 orders them (SQL Server text order, NULL first).
//
// Counts, per requesting facility, then summed by area name:
//   Registrations   distinct lab numbers of panel HIVVL registered (RegisteredDateTime = lab_requests.authored_at) in the window,
//                   any status.
//   Tests           distinct lab numbers of panel HIVVL with a result of observation HIVVL, HIVVC or HIVVD, a final report
//                   (HL7ResultStatusCode F), analysed (lab_requests.analysis_at) in the window, whose result text is not on
//                   the invalid list. A NULL text is out (NOT IN drops NULL).
//   suppressed      Tests whose text is on the suppressed list, or whose number is under 1000, or that has a coded value.
//   Unsuppressed    Tests whose number is 1000 or more, or whose text starts with '>' (D adds the text GT10).
//   TATTests/TATpre lab numbers with a collection date (diagnostic_reports.effective) and at most 90 days (local dates, datediff dd)
//                   from it to the authorised date (diagnostic_reports.issued); the average is a whole number, cut toward zero.
//
// The three procedures use different rules; each level keeps its own (spec ruling 1):
//   - End date. P adds one day to the end date (P line 19) and D and F do not. v1 compares datetimes with dates, so the window runs
//     from `from` 00:00:00 to `to` + 1 day 00:00:00 inclusive at P, and to `to` 00:00:00 inclusive at D and F: at D and F a one-day
//     window holds only what happened at exactly midnight, and the end day is otherwise out. Local wall time of the stamp's own text.
//     The window applies to RegisteredDateTime and to AnalysisDateTime alike.
//   - Invalid texts. P: 16 (the 13 of D and F, plus Positive, Negative, No). D and F: 13.
//   - Suppressed texts. P: 10 ('<20 copies/mL', TAR, 'Target Not Detected', TARG, '< 20', 'RNA not detected', '<30 copies/ml',
//     '<30 copies/mL', NDET, ND). D and F add '<400 copies/mL', '<400', '<40 copies/mL'.
//   - GT10 is unsuppressed at D only (D line 101). At P and F it is a test that is neither suppressed nor unsuppressed.
//
// Kept v1 quirks (spec ruling 1):
//   - All five parts are joined on registrations.RequestingFacilityCode (P lines 107-112, D 126-131, F 126-131). A facility with tests
//     but no registration in the window has no row at all: every count of that facility is dropped, tests included. Registered
//     facilities with no tests keep NULL in the other columns (a sum over nothing).
//   - A facility not in the register (no mapped ZMFAC row) has no area, so it drops out (v1 inner-joins the area names).
//   - The turnaround part has no result filter: a request whose only result is on the invalid list still counts in TATTests, and it
//     is an average over result rows (a request with HIVVL and HIVVC rows weighs twice), while TATTests counts requests. The average is
//     cut per facility before the weighting, so TATpre is a sum of (cut average x requests).
//   - D gives a NULL district its own row (a registered facility whose district is not in the register); F needs the district.
//   - F filters on the district NAME only. Two provinces with a district of one name mix (v1's flaw, noted in the inventory).
//   - F's alias `a` is the district area where D's is the province area (inventory note). Here: D filters mapped region = province,
//     F filters mapped district = district.
//   - A province over 15 characters or a district over 20 would be cut by v1's varchar parameters and match nothing. The port matches
//     the full name (evident intent). Names compare ignoring case and trailing spaces, as SQL Server does.
//   - Facilities are keyed by the register row, where v1 keys by the facility code. Two codes mapped to one register row would merge here.
//
// Deviations (spec ruling 2):
//   - v1 casts the result text to bigint to test it against 1000 (all three procedures). A decimal text ('999.5'), a text with a thousands
//     comma or an exponent makes the cast fail and v1 stops with a conversion error. The port reads the number (numberOfTextSql), as the
//     facility report and the recency procedures do. Those expectations are intent, not v1 output.
//
// CE gaps (spec ruling 7): none. The area names are the register row's (mapped ZMFAC), so a name can differ from v1's Facilities and
// HealthcareAreas descriptions (README). v1 joins results on RequestID and OBRSetID; CE keeps one result list per request.
const VL_INVALID_P = [...INVALID_VL_TEXTS, 'Positive', 'Negative', 'No'];
const VL_SUPPRESSED_P = [...SUPPRESSED_VL_TEXTS, 'ND'];
const VL_SUPPRESSED_DF = [...VL_SUPPRESSED_P, '<400 copies/mL', '<400', '<40 copies/mL'];

export function vlTestingSummarySql(level) {
  const result = rpt('l');
  const number = numberOfTextSql(result);
  const province = level === 'province';
  const lead = {
    province: [['Province', 'fmr.region']],
    district: [['District', 'fmr.district']],
    facility: [['District', 'fmr.district'], ['Facility Name', 'fmr.name']],
  }[level];
  const area = {
    province: 'fmr.region is not null',
    district: `${foldSql('fmr.region')} = ${foldSql('{{param.province}}')}`,
    facility: `${foldSql('fmr.district')} = ${foldSql('{{param.district}}')}`,
  }[level];
  const unsuppressed = [`${number} >= 1000`, `${result} like '>%'`];
  if (level === 'district') unsuppressed.push(`${foldSql(result)} = 'gt10'`);
  return epiSummarySql({
    panel: 'HIVVL',
    observations: ['HIVVL', 'HIVVC', 'HIVVD'],
    anchor: 'reg',
    endExtraDays: province ? 1 : 0,
    lead,
    area,
    resultWhere: `not ${inListSql(result, province ? VL_INVALID_P : INVALID_VL_TEXTS)}`,
    splits: [
      { column: 'suppressed', cond: `(${inListSql(result, province ? VL_SUPPRESSED_P : VL_SUPPRESSED_DF)} or ${number} < 1000 or length(rtrim(l.coded_value)) > 0)` },
      { column: 'Unsuppressed', cond: `(${unsuppressed.join(' or ')})` },
    ],
  });
}

// Required select parameters, as v1 has no "all" mode.
const requiredProvince = () => ({ ...provinceParam('province', true), label: 'Province' });
const requiredDistrict = () => ({ ...districtParam('district', true), label: 'District' });
export const vlTestingSummaryParams = (level) => ({
  province: () => [...dateParams(true)],
  district: () => [requiredProvince(), ...dateParams(true)],
  facility: () => [requiredDistrict(), ...dateParams(true)],
})[level]();

// ---- Unique VL clients, Unique VL clients by facility (12 months) ------------------------------------------------------
//
// "Unique VL clients" replaces sp_getUniqueVLClientsInfo ("I", the target) and folds in two v1 objects:
//   sp_getUniqueVLClientsInfoList  ("L") the same counts as one row per sub-area. It has the same 72 column names as I, so it is
//                                  the `rows` parameter below ("One row per sub-area"), not a second query.
//   sp_getUniqueVLClientsInfo_bkup an exact copy of I (a diff of the two files shows the procedure name on line 6 only). Nothing to port.
// "Unique VL clients by facility (12 months)" replaces sp_getUniqueVLClientsLast12Months_SPHO_WPHO ("S"). It has other column names
// (Suppressed, UnSuppressed) and no age or sex columns, so it is its own query (the controller's rule: one query per output shape).
//
// Both read v1's TND copy table (tndCte) joined to the hivvl copy table (hivvlCte, labsInWindow) by lab number. Each client's newest
// result in the window counts. A client is the first name, surname and ART number at one facility (the same person at two facilities
// counts twice).
//
// Columns of "Unique VL clients" (v1 names and order): Province, District, Facility, Clients, SuppressedC, UnsuppressedC, UndetectableC,
// then 65 columns, each <band><sex>: the bands lt01, 1to4, 5to9, 10to14, 15to19, 20to24, 25to29, 30to34, 35to39, 40to44, 45to49,
// 50plus, AgeMissing; the sexes m, f, i, u, x (x = blank sex). Columns of S: Province, District, Facility, Clients, Suppressed,
// UnSuppressed.
//
// Parameters of "Unique VL clients": province and district (optional selects), facility (optional text, matched on the register name),
// from and to (required, ruling 3), rows (optional select: "Totals", the default, or "One row per sub-area").
//
// Which row, and how clients are ranked, depends on `rows` and on which of province, district and facility are given. The fold of a name
// ignores case and trailing spaces, as SQL Server does.
//   Totals (I lines 21, 107, 191, 277):
//     none given                       1  'All', 'All', 'All'        I line 21.  Always a row, even with no client (sums over no row are NULL).
//     province                         2  <Province>, 'All', 'All'   I line 107. Names rank first.
//     province, district               3  <Province>, <District>, 'All'          I line 191. Names rank first.
//     province, district, facility     4  <Province>, <District>, <Facility>     I line 277. Ranked by ART number only (line 282).
//   One row per sub-area (L lines 20, 104, 186):
//     none given                       5  one row per province  (<Province>, 'All', 'All').  Names rank first (L line 23).
//     province                         6  one row per district  (<Province>, <District>, 'All').  Ranked by ART number only (L line 107).
//     province, district               7  one row per facility.  Ranked by ART number only (L line 189).
//   Each branch needs a TND row for the area in the window (I lines 21, 107, 191, 278; L lines 20, 104, 186). Without one, or for any other
//   combination of parameters (a district alone, a facility without a district), v1 answers the all-zero row with blank names (I lines
//   365-430). With a TND row but no client left after the hivvl join, branch 1 answers one row of NULL sums and the grouped branches no row.
//   L has no facility parameter: with rows = sub-area a facility is ignored.
//
// Rules shared by every branch:
//   - Window (I lines 27, 113, 197, 285): cast(ResultDate as datetime) between two DATES, so from 00:00:00 up to and including to 00:00:00,
//     local wall time. A result later on the end day is out; a one-day window holds only results at exactly midnight. Spec ruling 1: kept.
//   - Baseline labs are left out BEFORE the ranking: the join to hivvl has "BaseLineVL = 0 or null" (lines 26, 112, 196, 284), so the rank is
//     among the client's non-baseline results in the window. A lab with no hivvl row (an RTRI-only lab, a result such as '<883 copies/mL'
//     that is not a valid hivvl result) is dropped by the join.
//   - Ranking is rank(), not row_number(): results of one client at the same time all rank 1 and all count.
//   - Names rank, partition and compare as SQL Server compares text (fold). Where the order of first name and surname picks the client
//     (branches 4, 6, 7), the order is ssTextKey; a hyphen or apostrophe in a name that SQL Server uses only to break a tie is ignored.
//   - A group's names are shown as stored (the smallest spelling in byte order, as v1 shows either).
//
// Counts for I (branches 1-4), over the ranked rows (rank 1):
//   Clients       the rows whose result is a number (ISNUMERIC) or one of 15 texts (I line 29). A result such as 'PTLTT' is not counted.
//   SuppressedC   the rows that are Clients and TND.Suppressed = 1.
//   UnsuppressedC Clients - SuppressedC.
//   UndetectableC the rows that are Clients and TND.UU = 1.
//   <band><sex>   every ranked row, whatever its result (lines 33-97): the sex-by-age columns can add up to more than Clients.
// Counts for L (branches 5-7): Clients = count(*), SuppressedC = sum(Suppressed), UnsuppressedC = count(*) - sum(Suppressed),
// UndetectableC = sum(UU), with no test on the result text (L line 29): the two procedures give different Clients for one scope when a
// client's newest result is a text outside the 15.
//
// Kept v1 quirks (spec ruling 1):
//   - Branch 3's UndetectableC list has 14 texts: it lacks '<883 copies/mL' (I line 202). A client whose newest result is '<883 copies/mL'
//     with a number under 200 is undetectable in branches 1, 2, 4 and not in 3.
//   - Branch 4 (and L's 6 and 7) ranks by ART number only. Two people with one ART number at a facility are one client: the one whose
//     first name (then surname) sorts first; all other branches count both. The partition of branches 1, 2, 3 and 5 includes first name and
//     surname; ties on a name rank together (a person with equal names and time ranks 1 twice).
//   - A client with no patient row, or a blank first name, has empty names: all such clients of a facility with one ART number are one person.
//   - The exists test is on TND alone (not on hivvl or baseline), and in the window of ResultDate.
//   - Branch 1 and branch 5 leave out a facility whose register row has no province (I line 102, L line 99); the other branches match a
//     province by name.
//   - Negative ages, and sex codes other than M, F, I, U and blank, fall in no sex-by-age column (but count in Clients).
//   - The sums of an empty branch 1 are NULL, not 0 (Clients, SuppressedC, UnsuppressedC, UndetectableC and all 65 columns).
//
// CE gaps (spec ruling 7) and CE choices:
//   - A NULL patients.sex counts as blank (the `x` columns): v1 holds '' for a blank sex code, and a NULL cannot be told apart in CE.
//     A NULL first name or surname is read as ''. A request with no patient row keeps its result (slice 1's left join); v1 inner-joins Patients.
//   - HOSPID is not sent, so the ART number is artNumberSql's with HOSPID read as blank. The register name is the facility, province and
//     district name (a facility not in the register drops out, as in v1's dictionary joins).
//   - The hivvl row is found by lab number, compared ignoring case and trailing spaces; hivvlCte keeps one row per lab number.
//   - v1's TND holds only results authorised from 2017-01-01 to the day the table was filled; the port has no floor or ceiling.
//   - v1 varchar parameters (Province 20, District 40, Facility 40) cut a longer name, which then matches nothing; the port compares the
//     whole name.
//
// Deviations (spec ruling 2): none for "Unique VL clients"; `from` and `to` are required (v1 defaults them to the previous month).
const UNIQUE_OK_TEXTS = ['<20 copies/mL', 'TAR', 'Target Not Detected', 'TARG', '< 20', 'RNA not detected', '<30 copies/ml', '<30 copies/mL',
  '<40 copies/mL', 'NDET', 'ND', '<20CP', '< 40', '<400 copies/mL', '<883 copies/mL'];
const UNIQUE_OK_UU_DISTRICT_TEXTS = UNIQUE_OK_TEXTS.filter((t) => t !== '<883 copies/mL');
const UNIQUE_BANDS = [
  ['lt01', (a) => `${a} = 0`], ['1to4', (a) => `${a} between 1 and 4`], ['5to9', (a) => `${a} between 5 and 9`],
  ['10to14', (a) => `${a} between 10 and 14`], ['15to19', (a) => `${a} between 15 and 19`], ['20to24', (a) => `${a} between 20 and 24`],
  ['25to29', (a) => `${a} between 25 and 29`], ['30to34', (a) => `${a} between 30 and 34`], ['35to39', (a) => `${a} between 35 and 39`],
  ['40to44', (a) => `${a} between 40 and 44`], ['45to49', (a) => `${a} between 45 and 49`], ['50plus', (a) => `${a} >= 50`],
  ['AgeMissing', (a) => `${a} is null`],
];
const UNIQUE_SEXES = ['m', 'f', 'i', 'u', 'x'];

// The window of TND on its ResultDate (a datetime) against two dates: from 00:00:00 up to and including to 00:00:00, local wall time.
const midnightWindow = (ts) => `${ts} >= ({{param.from}})::date::timestamp and ${ts} <= ({{param.to}})::date::timestamp`;

// The shared head of both queries. `w` holds TND rows of the window whose lab number has a hivvl row, with the lower-cased keys v1's
// text comparison ignores (case, trailing spaces) and `not_baseline` (hivvl.BaseLineVL = 0 or null). `wWhere` is the condition on w.
function uniqueClientsHead(wWhere) {
  const key = (x) => `lower(rtrim(${x}))`;
  return `${tndCte('tnd')},
tw as (
  select * from (select t.*, ${localTs('t.result_date')} as result_ts from tnd t) t
  where ${midnightWindow('t.result_ts')}
),
${hivvlCte('hv', { from: 'from', to: 'to', labsInWindow: true })},
hvk as (
  select ${key('h.lab_id')} as lab_key, bool_or(h.baseline_vl = 0 or h.baseline_vl is null) as not_baseline
  from hv h
  group by ${key('h.lab_id')}
),
w as (
  select t.province, t.district, t.facility, t.art_number, t.firstname, t.surname, t.result, t.age_years, t.sex,
    t.suppressed_flag, t.uu_flag, t.result_ts, k.not_baseline,
    ${key('t.province')} as k_province, ${key('t.district')} as k_district, ${key('t.facility')} as k_facility,
    ${key('t.art_number')} as k_art, ${key("coalesce(t.firstname, '')")} as k_first, ${key("coalesce(t.surname, '')")} as k_last
  from tw t
  join hvk k on k.lab_key = ${key('t.lab_id')}
  where ${wWhere}
)`;
}

export function uniqueClientsSql() {
  const eq = (column, id) => `${foldSql(column)} = ${foldSql(`{{param.${id}}}`)}`;
  const ok = (list) => `(${isNumericSql('r.result')} or ${inListSql('r.result', list)})`;
  const sub = `${foldSql('{{param.rows}}')} = 'one row per sub-area'`;
  const age = 'r.age_years';
  const band = `case ${UNIQUE_BANDS.map(([name, test]) => `when ${test(age)} then '${name}'`).join(' ')} end`;
  const sexClass = `case upper(rtrim(r.sex)) when 'M' then 'm' when 'F' then 'f' when 'I' then 'i' when 'U' then 'u' else case when coalesce(rtrim(r.sex), '') = '' then 'x' end end`;
  const live = 'filter (where p.live = 1)';
  const cells = UNIQUE_SEXES.flatMap((s) => UNIQUE_BANDS.map(([name]) => `sum(case when p.band = '${name}' and p.sex_class = '${s}' then 1 else 0 end) ${live} as "${name}${s}"`));
  // A TND row for the area in the window decides the branch (the exists tests of v1).
  const hasTnd = (...conds) => `exists (select 1 from tw${conds.length > 0 ? ` where ${conds.join(' and ')}` : ''})`;
  const inProvince = eq('tw.province', 'province');
  const inDistrict = eq('tw.district', 'district');
  const inFacility = eq('tw.facility', 'facility');
  return `with ${uniqueClientsHead('k.not_baseline')},
ranked as (
  select w.*,
    rank() over (partition by w.k_province, w.k_district, w.k_facility, w.k_art, w.k_first, w.k_last order by w.result_ts desc) as rk_names,
    rank() over (partition by w.k_province, w.k_district, w.k_facility, w.k_art
      order by ${ssTextKey("coalesce(w.firstname, '')")} collate "C", ${ssTextKey("coalesce(w.surname, '')")} collate "C", w.result_ts desc) as rk_art
  from w
),
scope as (
  select case
    when ${sub} then case
      when ${blank('province')} and ${blank('district')} and ${hasTnd()} then 5
      when ${given('province')} and ${blank('district')} and ${hasTnd(inProvince)} then 6
      when ${given('province')} and ${given('district')} and ${hasTnd(inProvince, inDistrict)} then 7
      else 0 end
    else case
      when ${blank('province')} and ${blank('district')} and ${blank('facility')} and ${hasTnd()} then 1
      when ${given('province')} and ${blank('district')} and ${blank('facility')} and ${hasTnd(inProvince)} then 2
      when ${given('province')} and ${given('district')} and ${blank('facility')} and ${hasTnd(inProvince, inDistrict)} then 3
      when ${given('province')} and ${given('district')} and ${given('facility')} and ${hasTnd(inProvince, inDistrict, inFacility)} then 4
      else 0 end
    end as branch
),
pick as (
  select case s.branch when 1 then 'All' else r.province end as l_province,
    case when s.branch in (3, 4, 6, 7) then r.district else 'All' end as l_district,
    case when s.branch in (4, 7) then r.facility else 'All' end as l_facility,
    case when s.branch in (5, 6, 7) then 1 when ${ok(UNIQUE_OK_TEXTS)} then 1 else 0 end as c,
    case when s.branch in (5, 6, 7) then r.suppressed_flag when r.suppressed_flag = 1 and ${ok(UNIQUE_OK_TEXTS)} then 1 else 0 end as s_flag,
    case when s.branch in (5, 6, 7) then r.uu_flag
      when r.uu_flag = 1 and (case when s.branch = 3 then ${ok(UNIQUE_OK_UU_DISTRICT_TEXTS)} else ${ok(UNIQUE_OK_TEXTS)} end) then 1 else 0 end as u_flag,
    ${band} as band, ${sexClass} as sex_class, 1 as live
  from ranked r
  cross join scope s
  where case s.branch
    when 1 then r.rk_names = 1 and r.province is not null
    when 2 then r.rk_names = 1 and ${eq('r.province', 'province')}
    when 3 then r.rk_names = 1 and ${eq('r.province', 'province')} and ${eq('r.district', 'district')}
    when 4 then r.rk_art = 1 and ${eq('r.province', 'province')} and ${eq('r.district', 'district')} and ${eq('r.facility', 'facility')}
    when 5 then r.rk_names = 1 and r.province is not null
    when 6 then r.rk_art = 1 and ${eq('r.province', 'province')}
    when 7 then r.rk_art = 1 and ${eq('r.province', 'province')} and ${eq('r.district', 'district')}
    else false end
  union all
  select 'All', 'All', 'All', null::int, null::int, null::int, null::text, null::text, null::int
  from scope s where s.branch = 1
  union all
  select '', '', '', 0, 0, 0, null::text, null::text, 1
  from scope s where s.branch = 0
)
select g.*
from (
  select min(p.l_province collate "C") as "Province", min(p.l_district collate "C") as "District", min(p.l_facility collate "C") as "Facility",
    sum(p.c) ${live} as "Clients",
    sum(p.s_flag) ${live} as "SuppressedC",
    sum(p.c) ${live} - sum(p.s_flag) ${live} as "UnsuppressedC",
    sum(p.u_flag) ${live} as "UndetectableC",
    ${cells.join(',\n    ')}
  from pick p
  group by lower(rtrim(p.l_province)), lower(rtrim(p.l_district)), lower(rtrim(p.l_facility))
) g
order by ${ssTextKey('g."Province"')} collate "C" nulls first, ${ssTextKey('g."District"')} collate "C" nulls first,
  ${ssTextKey('g."Facility"')} collate "C" nulls first,
  g."Province" collate "C" nulls first, g."District" collate "C" nulls first, g."Facility" collate "C" nulls first`;
}

const uniqueRowsParam = () => ({
  id: 'rows', label: 'Rows (blank for totals)', type: 'select', required: false,
  optionsSql: "select 'Totals' as choice union all select 'One row per sub-area'",
});

export const uniqueClientsParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  facilityParam(),
  ...dateParams(true),
  uniqueRowsParam(),
];

// ---- Unique VL clients by facility (12 months) ----
//
// Replaces sp_getUniqueVLClientsLast12Months_SPHO_WPHO ("S"). One row per facility of the provinces asked, with the unique clients
// (Clients), how many are suppressed (Suppressed) and the rest (UnSuppressed). Columns as v1: Province, District, Facility, Clients,
// Suppressed, UnSuppressed. Order: province, district, facility (S line 121), comparing as SQL Server does.
//
// The three things v1 fixes become parameters (ruling 3 and the inventory): the 12-month window is `from` and `to` (v1: the 12 full months
// before the current one); the province pair 'Southern' and 'Western' (S line 120) is the default of `province`, a blank province, and a
// province given replaces the pair. The query keeps its v1 name, whatever window is asked.
//
// Rules (S lines 10-17 and 87-95):
//   - x ranks every TND row of a lab that has a hivvl row, baseline or not, per client (province, district, facility, ART number, first
//     name, surname; newest result first; rank(), so equal times all rank 1). ART number must have a length (line 16).
//   - The baseline lab is dropped AFTER the ranking (line 93, rank 1 only): a client whose newest result is a baseline test leaves the
//     report entirely, where "Unique VL clients" falls back to the client's newest non-baseline result.
//   - Clients = count of the rank 1 rows, Suppressed = their TND.Suppressed, UnSuppressed = Clients - Suppressed. There is no test on the
//     result text (unlike I), so a text outside the 15 counts as a client.
//   - Window: ResultDate against two dates, up to and including `to` 00:00:00 (line 15), as "Unique VL clients".
//   - A facility whose register row has no province drops out (line 92).
//
// Deviations (spec ruling 2):
//   - v1 cannot run as dumped. Its select at line 93 names BaselineVL without a qualifier, and both x (TND.BaselineVL, Table__dbo_TND.sql
//     line 20) and the second hivvl join h (HIVVL.BaseLineVL, Table__dbo_HIVVL.sql line 19) have the column. The same shape (a CTE of t.*
//     joined to a table with that column, one unqualified name) was run on the local SQL Server and stops with "Ambiguous column name"
//     (Msg 209). The port reads the hivvl flag (h.BaseLineVL): it is the reason the procedure joins hivvl a second time, and the other
//     unique-client procedures use it. If Zambia's live TND lacks the column, v1 runs and reads the same flag.
//   - `from` and `to` replace the current-month arithmetic; `province` replaces the constant pair.
//
// Kept v1 quirks (ruling 1): the baseline test after the ranking, as above; the hivvl join of x with no baseline test; the end date
// at 00:00:00; names compared as SQL Server compares text, groups shown as stored (the smallest spelling in byte order).
//
// CE gaps (spec ruling 7): as "Unique VL clients" (HOSPID, NULL names read as blank, the lab number join, no TND floor or ceiling).
export function uniqueClientsFacilitySql() {
  const key = (x) => `lower(rtrim(${x}))`;
  const provinceTest = `case when {{param.province}} = '' then ${inListSql('x.province', ['Southern', 'Western'])} else ${foldSql('x.province')} = ${foldSql('{{param.province}}')} end`;
  return `with ${uniqueClientsHead('length(rtrim(t.art_number)) > 0')},
x as (
  select w.*, rank() over (partition by w.k_province, w.k_district, w.k_facility, w.k_art, w.k_first, w.k_last order by w.result_ts desc) as rk
  from w
)
select g.*
from (
  select min(x.province collate "C") as "Province", min(x.district collate "C") as "District", min(x.facility collate "C") as "Facility",
    count(*) as "Clients", sum(x.suppressed_flag) as "Suppressed", count(*) - sum(x.suppressed_flag) as "UnSuppressed"
  from x
  where x.rk = 1 and x.province is not null and x.not_baseline and ${provinceTest}
  group by ${key('x.province')}, ${key('x.district')}, ${key('x.facility')}
) g
order by ${ssTextKey('g."Province"')} collate "C" nulls first, ${ssTextKey('g."District"')} collate "C" nulls first,
  ${ssTextKey('g."Facility"')} collate "C" nulls first,
  g."Province" collate "C" nulls first, g."District" collate "C" nulls first, g."Facility" collate "C" nulls first`;
}

export const uniqueClientsFacilityParams = () => [
  ...dateParams(true),
  { ...provinceParam('province', false), label: 'Province (blank for Southern and Western)' },
];

// ---- Unique VL clients, 12-month rates ----
//
// Replaces sp_getUniqueVLClientsInfoLast1Year ("R" below). One row: the unique clients (VLClients), how many are suppressed (Suppressed)
// and undetectable (Undetectable), and the two rates (SuppressionRate, UndetectableRate). Columns as v1, in v1's order.
//
// What v1 does (R = StoredProcedure__dbo_sp_getUniqueVLClientsInfoLast1Year.sql):
//   - A client is one TND row with Rank = 1 (R lines 19, 35, 53, 70, 89, 107, 126, 143): the client's latest result EVER, ranked over
//     all of the client's results, not over the window. `tndCte` with `rank: true` gives that row (visit = 1).
//   - That row must have a date in the window (R line 20: cast(ResultDate as date) between two DATES, so the whole last day is in) and a
//     result that is a number (ISNUMERIC) or one of 13 texts (R lines 22-26, listed in RATE_TEXTS).
//   - Its lab number must have a hivvl row whose baseline flag is 0 or NULL (R lines 17-18, 27): the join drops a lab with no hivvl row
//     (RTRI, or a text such as '<883 copies/mL' that is not a valid hivvl result) and a baseline lab. The baseline test comes AFTER the
//     rank, so a client whose latest result is a baseline test (or has no hivvl row) is not in the report at all. The report does not
//     fall back to an earlier result, where "Unique VL clients" does.
//   - Area: HIVVL.Province / District / Facility equal the parameters (R lines 62, 79, 98, 116, 135, 152): the hivvl row's names, not TND's.
//   - VLClients = count(ARTNumber), Suppressed = sum(TND.Suppressed), Undetectable = sum(TND.UU); the rates are the sum x 100.0 /
//     count(ARTNumber) (R lines 14-16). SQL Server decimal arithmetic gives 12 decimals and CUTS them, it does not round (rateCutSql; measured on the
//     local SQL Server: 1 of 3 gives 33.333333333333, 2 of 3 gives 66.666666666666, 3 of 7 gives 42.857142857142).
//   - Branch by which parameters are given (R lines 12, 45, 81, 118): none = all Zambia; province; province and district; all three.
//     The `exists(select count(...) ...)` in each IF is an aggregate without GROUP BY, so it always returns a row and is always true
//     (measured on the local SQL Server): a branch never falls through on "no data". An area with no client gives VLClients 0 and NULL
//     for the other four columns (a sum of no rows is NULL, so are the rates). Any other combination of parameters (a district without a
//     province, a facility without a district, a facility with only a province) gives the all-zero row (R line 154: five integer 0).
//
// Kept v1 quirks (spec ruling 1):
//   - The district and facility branches' text list lacks 'ND' (R lines 110 and 146); the all-Zambia and province branches have it. The
//     inventory names only the district branch. A client whose latest result is the text 'ND' is not counted in those two branches.
//   - TND.Rank is row_number() over province, district, facility, panel, sex code, surname, first name and ART number, so a client with a
//     result in two panels, or with two sex codes, is two clients. Two results at one instant are ranked in an order v1 leaves open (the
//     port takes the lab number, then the result row).
//   - The latest result ever decides: a client whose newest result is a text on no list (PTLTT) or outside the window is not counted,
//     though an earlier result in the window was valid.
//   - The area names are the hivvl row's, compared ignoring case and trailing spaces.
//
// Window (spec ruling 3): v1's window is the 12 full months before the current one (R lines 20-21). `from` is the first day of that
// window (the first of the month, 12 months back) and `to` its last day (the end of last month), for example 2025-10-01 to 2026-09-30
// when run in October 2026. Both are required local dates, both days in. The rank is NOT limited to the window.
//
// CE gaps (spec ruling 7) and CE choices: as "Unique VL clients" (HOSPID is not sent, so the ART number is artNumberSql's with HOSPID
// blank; a request without a patient row is kept with empty names; v1 varchar parameters (20, 40, 40) cut a longer name, the port
// compares it whole; a result with no date, a partial one, before 2017-01-01 or in the future is out of the rank, as TND's floor and
// ceiling put it out). CE art_number is
// never NULL, so count(ARTNumber) counts every row (v1's NULL ART number, from a NULL REFNO, is not reproduced).
//
// Deviations (spec ruling 2): none. v1 runs and returns real data.
const RATE_TEXTS = ['<20 copies/mL', 'TAR', 'Target Not Detected', 'TARG', '< 20', 'RNA not detected', '<30 copies/ml', '<30 copies/mL', 'NDET', 'ND',
  '<400 copies/mL', '<400', '<40 copies/mL'];
const RATE_TEXTS_NO_ND = RATE_TEXTS.filter((t) => t !== 'ND');

// SQL Server's sum(int) * 100.0 / count(int): decimal(26,12), the quotient CUT at 12 decimals. Computed exactly with integers: the whole
// part of top x 100 x 10^12 / count, then moved back 12 places. (A plain numeric division in Postgres rounds at its own working scale, which
// can move the 12th decimal for large counts: 203361 of 250002 is 81.343749250005 on SQL Server.) NULL when the count is 0 or NULL.
export const rateCutSql = (top, count) =>
  `(div((${top})::numeric * 100 * 1000000000000, nullif(${count}, 0)::numeric) / 1000000000000::numeric)`;

export function uniqueClientsRatesSql() {
  const eq = (column, id) => `${foldSql(column)} = ${foldSql(`{{param.${id}}}`)}`;
  const textOk = `(${isNumericSql('t.result')} or (case when s.branch in (3, 4) then ${inListSql('t.result', RATE_TEXTS_NO_ND)} else ${inListSql('t.result', RATE_TEXTS)} end))`;
  const key = (x) => `lower(rtrim(${x}))`;
  const rate = (top) => rateCutSql(top, 'a.clients');
  return `with ${tndCte('tnd', { rank: true })},
${hivvlCte('hv', { from: 'from', to: 'to', labsInWindow: true })},
scope as (
  select case
    when ${blank('province')} and ${blank('district')} and ${blank('facility')} then 1
    when ${given('province')} and ${blank('district')} and ${blank('facility')} then 2
    when ${given('province')} and ${given('district')} and ${blank('facility')} then 3
    when ${given('province')} and ${given('district')} and ${given('facility')} then 4
    else 0 end as branch
),
j as (
  select t.art_number, t.suppressed_flag, t.uu_flag
  from tnd t
  join hv h on ${key('h.lab_id')} = ${key('t.lab_id')}
  cross join scope s
  where t.visit = 1
    and ${inRange('t.result_date')}
    and ${textOk}
    and (h.baseline_vl = 0 or h.baseline_vl is null)
    and case s.branch
      when 1 then true
      when 2 then ${eq('h.province', 'province')}
      when 3 then ${eq('h.province', 'province')} and ${eq('h.district', 'district')}
      when 4 then ${eq('h.province', 'province')} and ${eq('h.district', 'district')} and ${eq('h.facility', 'facility')}
      else false end
),
a as (
  select count(j.art_number) as clients, sum(j.suppressed_flag) as suppressed, sum(j.uu_flag) as undetectable
  from j
)
select case when s.branch = 0 then 0 else a.clients end as "VLClients",
  case when s.branch = 0 then 0 else a.suppressed end as "Suppressed",
  case when s.branch = 0 then 0 else a.undetectable end as "Undetectable",
  case when s.branch = 0 then 0 else ${rate('a.suppressed')} end as "SuppressionRate",
  case when s.branch = 0 then 0 else ${rate('a.undetectable')} end as "UndetectableRate"
from scope s
cross join a`;
}

export const uniqueClientsRatesParams = () => [
  provinceParam('province', false),
  districtParam('district', false),
  facilityParam(),
  ...dateParams(true),
];

// ---- VL requests and tests by lab and month ----
//
// Replaces the view vVLRequestsTestsByMonth ("M" below, View__dbo_vVLRequestsTestsByMonth.sql). One row per year, month and laboratory:
// the VL requests registered (Requests) and the VL tests finished (Tested). Columns as v1: Year, Month, Laboratory, Requests, Tested.
//
// What v1 does:
//   - Requests (M line 22): count(distinct RequestID) of the HIVVL requests (M line 46), grouped by the year and month of RegisteredDateTime
//     (M lines 21, 48) and the laboratory.
//   - Laboratory (M lines 21, 39-43): the testing facility code, or the receiving facility code when the testing code is blank, joined
//     to the Laboratories dictionary; the row shows the dictionary's LabCode.
//   - Tested (M lines 23-33): count(distinct RequestID) of HIVVL requests with a result of observation HIVVL or HIVVC (line 29), a final
//     report (line 30), authorised in the same MONTH as the row's registered month (line 31), and the same testing facility code as the row's laboratory (line 32).
//
// Kept v1 quirks (spec ruling 1):
//   - Tested matches the authorised month only, not the year (M line 31: datepart(mm, ...) = datepart(mm, ...)), so Tested for May 2026
//     also counts every other May (2025, 2024...) at that laboratory. The same number repeats on each year's May row.
//   - Tested matches the laboratory on the TESTING code only (M line 32), so a laboratory that appears only through a receiving code has
//     Tested 0. (CE holds no receiving code, so every laboratory is a testing code.)
//   - Tested counts requests authorised in that month, whatever month they were registered in.
//   - A request with no registration date is one row with NULL Year and Month, and Tested 0 (a month compared with NULL is never true).
//     Kept when no window is given.
//
// Window (spec ruling 3): v1 has no window. `from` and `to` are optional; blank means all history, which is v1. When given, they cut the
// REQUESTS by the local date of their registration (the row's own year-month key), both days in. Tested is not cut: it keeps counting every
// year, as above. A window that starts or ends inside a month therefore gives that month a partial Requests; a window from the first to the
// last day of whole months gives v1's rows for those months exactly.
//
// CE gaps (spec ruling 7 and 8):
//   - Laboratory is diagnostic_reports.performer (the testing lab code), shown as stored (the smallest spelling in byte order when
//     spellings differ by case or trailing spaces). CE has no Laboratories dictionary and no receiving facility code, so the inner join to the
//     dictionary (which drops a request whose lab code is not in it) is not reproduced: a request with a blank testing lab is out (v1 falls to
//     the receiving code, which CE lacks), and every other code is a laboratory.
//   - A request with no report has no testing lab in CE, so it is not counted in Requests.
//
// Deviations (spec ruling 2): none.
export function labMonthSql() {
  const rangeBlank = `({{param.from}} = '' or left(lr.authored_at, 10) >= {{param.from}}) and ({{param.to}} = '' or left(lr.authored_at, 10) <= {{param.to}})`;
  return `${labMonthSource(rangeBlank, 'g."Year", g."Month", g."Laboratory", g."Requests", coalesce(t.n, 0) as "Tested"')}
order by g."Year" nulls first, g."Month" nulls first, ${ssTextKey('g."Laboratory"')} collate "C", g."Laboratory" collate "C", g."Requests", coalesce(t.n, 0)`;
}

// The view's rows, shared by "VL requests and tests by lab and month" and "VL throughput by lab and month" (Task 27, which reads the same view
// through fn_annualrequestsTestsTrend). Returns SQL from `with` to the join of the monthly Tested counts (g is the group per year, month and
// lab; t holds Tested), with `columns` as the select list; the caller adds an optional `where` and the `order by`.
//   requestCond  the condition on the REQUESTS (lr, dr): a date window here, a year there. It never reaches Tested, which keeps counting
//                every year (the month-only quirk above).
//   columns      the select list over g (Year, Month, Laboratory, Requests, lab_key) and t (n).
export function labMonthSource(requestCond, columns) {
  const lab = foldSql('dr.performer');
  return `with sent as (
  select extract(year from ${localDate('lr.authored_at')})::int as yr, extract(month from ${localDate('lr.authored_at')})::int as mo,
    ${lab} as lab_key, dr.performer, lr.request_id
  from lab_requests lr
  join diagnostic_reports dr on dr.based_on_id = lr.id
  where ${foldSql('lr.panel_code')} = 'hivvl'
    and length(rtrim(dr.performer)) > 0
    and ${requestCond}
),
tested as (
  select extract(month from ${localDate('dr.issued')})::int as mo, ${lab} as lab_key, count(distinct ${foldSql('lr.request_id')}) as n
  from lab_requests lr
  join diagnostic_reports dr on dr.based_on_id = lr.id
  join lab_results l on l.request_id = lr.id
  where ${foldSql('lr.panel_code')} = 'hivvl'
    and ${inListSql('l.observation_code', ['HIVVL', 'HIVVC'])}
    and ${foldSql('dr.status')} = 'final'
    and length(rtrim(dr.performer)) > 0
  group by 1, 2
)
select ${columns}
from (
  select s.yr as "Year", s.mo as "Month", min(s.performer collate "C") as "Laboratory", count(distinct ${foldSql('s.request_id')}) as "Requests",
    s.lab_key
  from sent s
  group by s.yr, s.mo, s.lab_key
) g
left join tested t on t.mo = g."Month" and t.lab_key = g.lab_key`;
}

export const labMonthParams = () => dateParams(false);

// ---- VL result bands by month ----
//
// Replaces the view vVLResRangeBreakDownByMonth ("B" below, View__dbo_vVLResRangeBreakDownByMonth.sql), which reads the helper view
// vVLReportData ("D", View__dbo_vVLReportData.sql). One row per year and month: the VL requests (Total) and how many have a result in each
// band. Columns as v1: Year, Month, Total, Target Not Detected, < 20 copies/ml, < 1000 copies/ml, >= 1000 copies/ml.
//
// What v1 does:
//   - D reads the VL requests (panel HIVVL, D line 45) that are not rejected (rejection code NULL or blank, D line 45) joined to their
//     results of observation HIVVL, HIVVD and HIVVC (D lines 42-46). VLEIDRequests and VLEIDResults are plain copies of Requests and
//     LabResults (sp_UpdateVLEIDRequests, sp_UpdateVLEIDResults; the observations they hold include these three), so the port reads
//     lab_requests and lab_results directly: the join on (RequestID, OBRSetID) is the row link lab_results.request_id = lab_requests.id.
//     No builder is added: the copy table adds no rule of its own to restate.
//   - Month (D line 25; B lines 12-14): the year and month of coalesce(SpecimenDateTime, ReceivedDateTime, RegisteredDateTime), the
//     collection date, else the received date, else the registration date (the report's effective stamp, the specimen's received stamp,
//     the request's authored stamp). The local date of the stamp.
//   - D's last step (D lines 48-49) joins FACILITIES_NEW with a LEFT join and takes DISTINCT: it drops no row and changes no count of distinct requests,
//     so the area is not read.
//   - Total (B line 17) = count(distinct RequestID) of the month. Each band column (B lines 18-46) = count(distinct RequestID) of the month
//     whose result row has that band label. A request with results in two bands counts once in each band and once in Total.
//   - The band of a result (D lines 33-39): coded value 'LDL' is 'Target Not Detected'; SIValue 0 up to 20 is '< 20 copies/ml'; 20 to 1000
//     is '<= 1000 copies/ml'; over 1000 is '> 1000 copies/ml'; anything else is 'Unknown' (counted in Total only).
//
// Kept quirk (spec ruling 1): the row with no date (NULL Year and Month) shows its Total and 0 in every band column. Each v1 band column is a
// correlated subquery that matches datepart(yyyy, a.[Year]) = datepart(yyyy, rpd.[Year]), which is never true for NULL (measured on the
// local SQL Server: a NULL group with one request gives Total 1 and < 20 copies/ml 0). The port counts a band only for a request with a date.
//
// Deviation (spec ruling 2): v1 runs but its last two columns are constant 0. B tests the labels '< 1000 copies/ml' and '>= 1000 copies/ml'
// (B lines 38, 45), and D never produces them: it produces '<= 1000 copies/ml' and '> 1000 copies/ml' (D lines 36-37). The two other views
// that read D (vSuppressionByFacility line 11, vVLQuarterlyFacilitySuppressionRate line 22) test the same labels as B, and suppression is a
// result under 1000 in this pack, so the evident intent is the bands the column headers name: '< 1000 copies/ml' = 20 up to (not
// including) 1000; '>= 1000 copies/ml' = 1000 and over. Target Not Detected and '< 20 copies/ml' are v1's own and unchanged. A result of
// exactly 1000 is '<= 1000' in D, which by position is the '< 1000' column; the header says '>= 1000', so the port puts it there. Zambia may
// confirm the bands. Total and the first two band columns match v1 for the same data.
//
// Window (spec ruling 3): v1 has no window. `from` and `to` are optional; blank means all history, which is v1. When given, they cut the
// rows by the local date of the month key above (collected, else received, else registered), both days in.
//
// CE gaps: LIMSCodedValue is lab_results.coded_value and SIValue is numeric_value (a '<' comparator is not read). A request with no usable
// date at all is one row with NULL Year and Month (kept when no window is given).
export function resultBandsSql() {
  const band = `case
        when ${foldSql('l.coded_value')} = 'ldl' then 'tnd'
        when l.numeric_value >= 0 and l.numeric_value < 20 then 'lt20'
        when l.numeric_value >= 20 and l.numeric_value < 1000 then 'lt1000'
        when l.numeric_value >= 1000 then 'ge1000'
        else 'unknown' end`;
  const day = `coalesce(${localDate('dr.effective')}, ${localDate('s.received_time')}, ${localDate('lr.authored_at')})`;
  const count = (name) => `count(distinct ${foldSql('b.request_id')}) filter (where b.day is not null and b.band = '${name}')`;
  return `with b as (
  select lr.request_id, ${day} as day, ${band} as band
  from lab_requests lr
  join lab_results l on l.request_id = lr.id
  left join diagnostic_reports dr on dr.based_on_id = lr.id
  left join specimens s on s.id = dr.specimen_id
  where ${foldSql('lr.panel_code')} = 'hivvl'
    and (lr.rejection_code is null or rtrim(lr.rejection_code) = '')
    and ${inListSql('l.observation_code', ['HIVVL', 'HIVVD', 'HIVVC'])}
)
select extract(year from b.day)::int as "Year", extract(month from b.day)::int as "Month",
  count(distinct ${foldSql('b.request_id')}) as "Total",
  ${count('tnd')} as "Target Not Detected",
  ${count('lt20')} as "< 20 copies/ml",
  ${count('lt1000')} as "< 1000 copies/ml",
  ${count('ge1000')} as ">= 1000 copies/ml"
from b
where ({{param.from}} = '' or to_char(b.day, 'YYYY-MM-DD') >= {{param.from}}) and ({{param.to}} = '' or to_char(b.day, 'YYYY-MM-DD') <= {{param.to}})
group by extract(year from b.day), extract(month from b.day)
order by "Year" nulls first, "Month" nulls first`;
}

export const resultBandsParams = () => dateParams(false);

// ---- VL tests on GeneXpert ----
//
// Replaces v_GxVLTests: the rows of the hivvl copy table (rebuilt by hivvlCte) whose lab number has a request in panel HIVVL, POCVR or POHVL
// with an analyser code like 'G____' (a G and four characters), tested in the window, with the testing laboratory's name.
// Columns (v1 names and order, the hivvl table's then LabName): Province, District, Facility, LabID, Gender, AgeGroup, TestedDate, Suppressed,
// UU, TAT, TATWithin14, Pregnant, BreastFeeding, BaseLineVL, RunDate, ReceivedDate, RegisteredDate, CollectedDate, TestedAt, Referral,
// Disalink, ThreeMPostUnSuppressed, POC, POCW48H, LabName.
//
// The fixed window (TestedDate within the last 1,095 days, line 13; no upper bound) is `from` and `to` (spec ruling 3: a rolling window
// becomes from and to); both are required. The window is on the LOCAL date of the tested date, both ends in.
//
// Kept v1 quirks (spec ruling 1):
//   - The join to Requests (lines 9-10) repeats a test once per request row of its lab number that is in one of the three panels and has a G
//     analyser code; v1 has no DISTINCT. Two such rows give two identical rows. The analyser code is a fact of any such request row, not
//     necessarily the row the hivvl table kept (the facts of the output are the kept row's).
//   - 'G____' follows SQL Server's LIKE for varchar, ignoring case; a trailing space can be the fourth character after the G, and further
//     trailing spaces do not count (measured: 'G123 ' and 'G1234  ' match, 'G1  ' and 'G12345' do not).
//   - The lab number joins as SQL Server compares text (line 9): case and trailing spaces do not matter.
//   - No ORDER BY in v1: the port orders by every column.
//
// CE gaps (ruling 7):
//   - Referral stays NULL: CE holds no receiving facility (the hivvl builder's referral). Disalink reads the pre-registration attributes and
//     is 0 until cdr-toolchain fills them.
//   - v1 inner-joins its laboratory dictionary on TestedAt (lines 11-12): a test whose testing laboratory is not in it, or has no testing
//     code, is out. CE has no Zambia laboratory dictionary (ruling 8), so a test with no testing code is out and every other one stays.
//     LabName is the report's display, else the mapped register name, else the code (ruling 8), taken from the report of the row the hivvl
//     table kept. For a ZU code stored as ZUL (TestedAt), the name is that of the report's own code, where v1 names ZUL.
//
// Deviations (ruling 3): the rolling window becomes from and to (above).

export function gxVlSql() {
  return `with ${hivvlCte('hv', { from: 'from', to: 'to', rowIds: true })}
select hv.province as "Province", hv.district as "District", hv.facility as "Facility", hv.lab_id as "LabID", hv.gender as "Gender",
  hv.age_group as "AgeGroup", hv.tested_date as "TestedDate", hv.suppressed as "Suppressed", hv.uu as "UU", hv.tat as "TAT",
  hv.tat_within14 as "TATWithin14", hv.pregnant as "Pregnant", hv.breastfeeding as "BreastFeeding", hv.baseline_vl as "BaseLineVL",
  hv.run_date as "RunDate", hv.received_date as "ReceivedDate", hv.registered_date as "RegisteredDate", hv.collected_date as "CollectedDate",
  hv.tested_at as "TestedAt", hv.referral as "Referral", hv.disalink as "Disalink", hv.three_m_post_unsuppressed as "ThreeMPostUnSuppressed",
  hv.poc as "POC", hv.poc_w48h as "POCW48H", ${labNameSql('dr')} as "LabName"
from hv
join diagnostic_reports dr on dr.id = hv.report_row_id
join lab_requests gr on ${foldSql('gr.request_id')} = ${foldSql('hv.lab_id')}
  and ${inListSql('gr.panel_code', ['HIVVL', 'POCVR', 'POHVL'])}
  and ${likeVarcharSql('gr.analyzer_code', 'G', 4)}
where hv.tested_at is not null
order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25`;
}

export const gxVlParams = () => [...dateParams(true)];

export function queries() {
  return [
    { name: 'VL dashboard summary', sql: vlDashboardSql(), params: vlDashboardParams() },
    { name: 'VL dashboard by sex and age', sql: vlSexAgeSql(), params: vlSexAgeParams() },
    { name: 'VL monthly trend', sql: vlTrendSql(), params: vlTrendParams() },
    { name: 'Client by ART number', sql: artLookupSql(), params: artLookupParams() },
    { name: "VL results for a facility's clients", sql: facilityClientsSql(), params: facilityClientsParams() },
    { name: 'Earlier VL results of high-VL clients', sql: cohortSql(), params: cohortParams() },
    { name: 'VL results history by client', sql: historySql(), params: historyParams() },
    { name: 'VL testing summary by province', sql: vlTestingSummarySql('province'), params: vlTestingSummaryParams('province') },
    { name: 'VL testing summary by district', sql: vlTestingSummarySql('district'), params: vlTestingSummaryParams('district') },
    { name: 'VL testing summary by facility', sql: vlTestingSummarySql('facility'), params: vlTestingSummaryParams('facility') },
    { name: 'Unique VL clients', sql: uniqueClientsSql(), params: uniqueClientsParams() },
    { name: 'Unique VL clients by facility (12 months)', sql: uniqueClientsFacilitySql(), params: uniqueClientsFacilityParams() },
    { name: 'Unique VL clients, 12-month rates', sql: uniqueClientsRatesSql(), params: uniqueClientsRatesParams() },
    { name: 'VL requests and tests by lab and month', sql: labMonthSql(), params: labMonthParams() },
    { name: 'VL result bands by month', sql: resultBandsSql(), params: resultBandsParams() },
    { name: 'VL tests on GeneXpert', sql: gxVlSql(), params: gxVlParams() },
  ];
}

// Custom queries for the vl reports. Each task adds { name, sql, params } entries to the list.

import { foldSql, inListSql, rpt } from '../../vl-reports-mz/vl-queries.mjs';
import {
  hivvlCte, provinceParam, districtParam, facilityParam, dateParams, localDate, localTs, utcTs, sqlList, zmIdsCte,
  requesterJoin, artNumberShortSql, artNumberRawSql, numberOfTextSql,
} from '../zm-sql.mjs';

// Area parameters in SQL. An optional parameter arrives as '' when blank. `same` matches a column on a
// parameter the way SQL Server does (case and trailing spaces ignored), and passes everything when blank.
const given = (id) => `{{param.${id}}} <> ''`;
const blank = (id) => `{{param.${id}}} = ''`;
const same = (column, id) => `(${blank(id)} or ${foldSql(column)} = ${foldSql(`{{param.${id}}}`)})`;

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

const count1 = (cond) => `sum(case when ${cond} then 1 else 0 end)`;
const ratio = (top, bottom) => `(${top})::float8 / nullif(${bottom}, 0)`;

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
//     SQL Server sorts it, ignoring case and trailing spaces.
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
  select row_number() over (order by lower(rtrim(s.lab_id)) collate "C", s.lab_id collate "C", s.request_row_id, s.result_row_id, s.report_row_id) as serial,
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

export function queries() {
  return [
    { name: 'VL dashboard summary', sql: vlDashboardSql(), params: vlDashboardParams() },
    { name: 'VL dashboard by sex and age', sql: vlSexAgeSql(), params: vlSexAgeParams() },
    { name: 'VL monthly trend', sql: vlTrendSql(), params: vlTrendParams() },
    { name: 'Client by ART number', sql: artLookupSql(), params: artLookupParams() },
    { name: "VL results for a facility's clients", sql: facilityClientsSql(), params: facilityClientsParams() },
  ];
}

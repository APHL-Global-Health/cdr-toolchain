// Custom queries for the vl reports. Each task adds { name, sql, params } entries to the list.

import { foldSql } from '../../vl-reports-mz/vl-queries.mjs';
import { hivvlCte, provinceParam, districtParam, facilityParam, dateParams } from '../zm-sql.mjs';

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
  // Which of the four shapes the area parameters make. A blank parameter arrives as ''.
  const given = (id) => `{{param.${id}}} <> ''`;
  const blank = (id) => `{{param.${id}}} = ''`;
  const national = `(${blank('province')} and ${blank('district')} and ${blank('facility')})`;
  const provinceOnly = `(${given('province')} and ${blank('district')} and ${blank('facility')})`;
  const districtLevel = `(${given('province')} and ${given('district')} and ${blank('facility')})`;
  const facilityLevel = `(${given('province')} and ${given('district')} and ${given('facility')})`;
  const same = (column, id) => `(${blank(id)} or ${foldSql(column)} = ${foldSql(`{{param.${id}}}`)})`;
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

export function queries() {
  return [
    { name: 'VL dashboard summary', sql: vlDashboardSql(), params: vlDashboardParams() },
  ];
}

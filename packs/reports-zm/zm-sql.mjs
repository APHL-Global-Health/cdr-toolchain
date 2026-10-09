// Shared SQL helpers and parameter builders for Zambia's reports. The query files in queries/ and
// slice 1's zm-queries.mjs import from here. Each helper returns SQL text (or a parameter object)
// for a custom query; none of them reads data.
//
// Query parameters appear in SQL as {{param.<id>}}. CE puts the value in as a quoted literal, and a
// blank optional parameter arrives as ''.

import { lit as sqlLit, rpt, inListSql, foldSql, isNumericSql } from '../vl-reports-mz/vl-queries.mjs';

export { sqlLit };

export const ZM_REGISTER_URL = 'urn:openldr:zm:facilities';
export const ATTR_SYSTEM = 'urn:openldr:cs:request-attribute';

// 'a', 'b' from ['a', 'b']: single quotes doubled.
export const sqlList = (values) => values.map(sqlLit).join(', ');

// A text window on a date column: `expr >= from and expr <= to-day-end`. Dates compare as text
// (YYYY-MM-DD, or a full ISO stamp), so the end day is taken to its last millisecond.
export const inRange = (expr, fromParam = 'from', toParam = 'to') =>
  `${expr} >= {{param.${fromParam}}} and ${expr} <= ({{param.${toParam}}} || 'T23:59:59.999Z')`;

// ---- Parameters ----

// The picker queries run through CE's validateSelectSql and use the first column of each row.
export const provinceOptionsSql = (registerUrl) =>
  `select distinct region from facility_registry where facility_system = ${sqlLit(registerUrl)} and register_state = 'in_register' and region is not null and region <> '' order by region`;
export const districtOptionsSql = (registerUrl) =>
  `select distinct district from facility_registry where facility_system = ${sqlLit(registerUrl)} and register_state = 'in_register' and district is not null and district <> '' order by district`;

export const provinceParam = (id = 'province', required = false, registerUrl = ZM_REGISTER_URL) =>
  ({ id, label: 'Province (blank for all)', type: 'select', required, optionsSql: provinceOptionsSql(registerUrl) });
export const districtParam = (id = 'district', required = false, registerUrl = ZM_REGISTER_URL) =>
  ({ id, label: 'District (blank for all)', type: 'select', required, optionsSql: districtOptionsSql(registerUrl) });
// A text box, matched on the register name of the requesting facility (see areaFilter).
export const facilityParam = () =>
  ({ id: 'facility', label: 'Facility (name as in the register; blank for all)', type: 'text', required: false });
// A text box, matched on the testing lab code (diagnostic_reports.performer). CE has no Zambia lab register.
export const labParam = () =>
  ({ id: 'laboratory', label: 'Laboratory code (blank for all)', type: 'text', required: false });
// The from/to pair. `required` is true where v1 had a window.
export const dateParams = (required = true) => [
  { id: 'from', label: 'Date from (YYYY-MM-DD)', type: 'text', required },
  { id: 'to', label: 'Date to (YYYY-MM-DD)', type: 'text', required },
];

// ---- The requesting facility ----

// Join a lab request (`lrAlias`) to its mapped ZMFAC register row (`fmAlias`). Requests whose
// facility is not mapped drop out, as v1's inner joins drop facilities missing from its dictionary.
export const requesterJoin = (lrAlias, fmAlias) =>
  `join facility_map ${fmAlias} on ${fmAlias}.source_system = coalesce(${lrAlias}.source_system, '') and ${fmAlias}.performer_system = coalesce(${lrAlias}.requester_system, '') and ${fmAlias}.source_code = ${lrAlias}.requester_code and ${fmAlias}.registry_id is not null`;

// Conditions for the optional area parameters against the mapped row `fmAlias`. Each key of `ids`
// is the id of a parameter to apply (leave a key out to skip that filter). Returns SQL joined with
// "and", or `true` when no filter is asked for. Province and district compare as given; the
// facility compares on the register name ignoring case and trailing spaces, as SQL Server does.
export function areaFilter(ids = {}, fmAlias = 'fmr') {
  const blank = (p) => `{{param.${p}}} = ''`;
  const parts = [];
  if (ids.province) parts.push(`(${blank(ids.province)} or ${fmAlias}.region = {{param.${ids.province}}})`);
  if (ids.district) parts.push(`(${blank(ids.district)} or ${fmAlias}.district = {{param.${ids.district}}})`);
  if (ids.facility) parts.push(`(${blank(ids.facility)} or lower(rtrim(${fmAlias}.name)) = lower(rtrim({{param.${ids.facility}}})))`);
  return parts.length > 0 ? parts.join('\n    and ') : 'true';
}

// The two request attributes of the v1 ART number, one row per request. Returns a CTE item
// `name as (...)` to put in a `with` list.
export const zmIdsCte = (name) => `${name} as (
  select a.lab_request_id,
    max(case when a.code = 'reference-numbers' then a.value_text end) as reference_numbers,
    max(case when a.code = 'unique-id' then a.value_text end) as unique_id
  from lab_request_attributes a
  where a.system = ${sqlLit(ATTR_SYSTEM)} and a.code in ('reference-numbers', 'unique-id')
  group by a.lab_request_id
)`;

// ---- The ART number ----

// SQL Server's REPLACE ignores case under the default collation, so v1's replace(x, 'AT.', '')
// also removes 'at.'. Postgres replace() is case-sensitive, so that step is a regexp. The order of
// the steps is v1's: commas, then 'AT.', then spaces, then dashes.
const dropCommaAt = (x) => `regexp_replace(replace(${x}, ',', ''), 'AT\\.', '', 'gi')`;
const stripRef = (x) => `replace(replace(${dropCommaAt(x)}, ' ', ''), '-', '')`;
const stripId = (x) => `replace(replace(${x}, ' ', ''), '-', '')`;

// The ART number, v1 sp_GetPreviousVLResultforCohort2x. `ref` is REFNO and `uniqueId` UNIQUEID,
// both SQL text that is never NULL ('' when not sent). v1 LIKE ignores case, so ilike.
//   1. REFNO starts ",ELABS": the text after the first "T.". Follows v1's LEN/RIGHT arithmetic: LEN ignores
//      trailing spaces, RIGHT counts them.
//   2. REFNO contains ",ELABS": the part before ",elabs", less its first 3 characters. Follows v1's LEN/RIGHT
//      arithmetic. (v1 errors when that part is under 3 characters; port gives ''.)
//   3. v1: REFNO blank and HOSPID set gives HOSPID. HOSPID is not sent yet (spec section 3), so
//      this rule never fires and a blank REFNO falls to rule 4.
//   4. REFNO blank after stripping: UNIQUEID without spaces and dashes.
//   5. REFNO, less commas and "AT.", starts "ART." or "ELABS.": UNIQUEID without spaces and dashes.
//   6. Otherwise REFNO without commas, "AT.", spaces and dashes.
export function artNumberSql(ref, uniqueId) {
  return `case
    when ${ref} ilike ',ELABS%' then right(${ref}, greatest(length(rtrim(${ref})) - strpos(upper(${ref}), 'T.') - 1, 0))
    when ${ref} ilike '%,ELABS%' then right(left(${ref}, strpos(lower(${ref}), ',elabs') - 1), greatest(length(rtrim(left(${ref}, strpos(lower(${ref}), ',elabs') - 1))) - 3, 0))
    when ${stripRef(ref)} = '' then ${stripId(uniqueId)}
    when ${dropCommaAt(ref)} ilike 'ART.%' or ${dropCommaAt(ref)} ilike 'ELABS.%' then ${stripId(uniqueId)}
    else ${stripRef(ref)}
  end`;
}

// ---- Small v1 functions ----

// v1 dbo.getGenderFromSexCode. The comparison ignores case and trailing spaces, as SQL Server's does.
export const genderSql = (sexExpr) => `case upper(rtrim(${sexExpr}))
    when 'F' then 'Female' when 'M' then 'Male' when 'N' then 'Not Applicable' when 'O' then 'Other'
    when 'U' then 'Unknown' when 'I' then 'Indeterminate' else 'Not Specified'
  end`;

// v1 dbo.Agegroup, exactly. Its 45 to 54 branch is labelled '45-49', so ages 50 to 54 never reach
// '50+' (spec ruling 1: kept). A NULL age gives 'Not Captured', as in v1 where every test is unknown.
export function ageGroupSql(yearsExpr) {
  const a = `(${yearsExpr})`;
  return `case
    when ${a} < 1 then '<1'
    when ${a} between 1 and 4 then '1-4'
    when ${a} between 5 and 9 then '5-9'
    when ${a} between 10 and 14 then '10-14'
    when ${a} between 15 and 19 then '15-19'
    when ${a} between 20 and 24 then '20-24'
    when ${a} between 25 and 29 then '25-29'
    when ${a} between 30 and 34 then '30-34'
    when ${a} between 35 and 39 then '35-39'
    when ${a} between 40 and 44 then '40-44'
    when ${a} between 45 and 54 then '45-49'
    when ${a} >= 50 then '50+'
    else 'Not Captured'
  end`;
}

// ---- Data from CE's own tables ----

export const VL_FORM_CODE = 'hiv_vl_documentation';

// The text answer of one VIRAL form question for a request (spec ruling 6). CE keeps the answers
// of Zambia's VIRAL panel as one questionnaire_responses row per request: `items` is a JSON array
// of { linkId: <observation code>, answer: [{ valueString } | { valueDecimal }] }. Returns the first
// answer's valueString, else its valueDecimal as text, else NULL. `requestIdExpr` is the lab
// request's id. If a request has several responses, the latest authored one is used.
export const formAnswerSql = (requestIdExpr, observationCode) => `(select coalesce(zit.item -> 'answer' -> 0 ->> 'valueString', zit.item -> 'answer' -> 0 ->> 'valueDecimal')
    from questionnaire_responses zqr
    cross join lateral jsonb_array_elements(zqr.items::jsonb) as zit(item)
    where zqr.form_code = ${sqlLit(VL_FORM_CODE)} and zqr.based_on_id = ${requestIdExpr} and zit.item ->> 'linkId' = ${sqlLit(observationCode)}
    order by zqr.authored desc nulls last, zqr.id
    limit 1)`;

// The testing laboratory's name (spec ruling 8): the report's performer_display, else the register
// name of the performer's mapped facility, else the performer's code. `drAlias` is a
// diagnostic_reports alias. A blank display counts as missing.
export const labNameSql = (drAlias) => `coalesce(
    case when btrim(${drAlias}.performer_display) <> '' then ${drAlias}.performer_display end,
    (select zfm.name from facility_map zfm
      where zfm.source_system = coalesce(${drAlias}.source_system, '') and zfm.performer_system = coalesce(${drAlias}.performer_system, '')
        and zfm.source_code = ${drAlias}.performer and zfm.registry_id is not null
      order by zfm.id limit 1),
    ${drAlias}.performer)`;

// ---- The hivvl copy table (spec ruling 5) ----

// v1 sp_update_HIVVLTable: the three result lists (lines 124, 87, 95). v1 compares with SQL Server's
// default collation, so inListSql ignores case and trailing spaces.
const HIVVL_VALID = ['<20 copies/mL', 'TAR', 'Target not detected', 'Target Not Detected', 'TARG', '< 20', 'RNA not detected',
  '<30 copies/ml', '<30 copies/mL', '<40 copies/mL', 'NDET', 'ND', '<20CP', '<400 copies/mL', '< 40', 'PTLTT', 'PTLTV'];
const HIVVL_SUPPRESSED = ['<20 copies/mL', 'TAR', 'Target not detected', 'Target Not Detected', 'TARG', '< 20', 'RNA not detected',
  '<30 copies/ml', '<30 copies/mL', '<40 copies/mL', 'NDET', 'DET', 'ND', '<20CP', '< 40', '<400 copies/mL', '<883 copies/mL', 'PLTT', 'PTLTV'];
const HIVVL_UU = ['TAR', 'Target Not Detected', 'Target not detected', 'TARG', 'RNA not detected', 'NDET', 'ND', 'DET'];
const YES_WORDS = ['Yes', 'Y', 'Yest'];

// Stamps are CE's ISO text, and DISA's local wall time keeps its offset ('2026-05-01T01:00:00+02:00').
// A FHIR dateTime may also be partial ('2026-07') or a date. Every cast is guarded: text that is not
// the full pattern gives NULL and never raises.
const FULL_STAMP = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}'";
const DATE_START = "'^[0-9]{4}-[0-9]{2}-[0-9]{2}'";
// The LOCAL calendar date of a stamp, taken from its own text (v1 datediff(dd) counts local dates).
const localDate = (x) => `(case when ${x} ~ ${DATE_START} then left(${x}, 10)::date end)`;
// The local wall time of a stamp (offset dropped), for ordering as v1 does.
const localTs = (x) => `substring(${x} from '^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(:[0-9]{2})?)')::timestamp`;
// A UTC timestamp, for hour differences (the offsets are fixed whole hours).
const utcTs = (x) => `(case when ${x} ~ ${FULL_STAMP} then ${x}::timestamptz at time zone 'UTC' end)`;

// Zambia's `hivvl` copy table, rebuilt as a CTE: `<name> as (...)`. Put it in a `with` list.
//   hivvlCte('hv')                              all rows
//   hivvlCte('hv', { from: 'from', to: 'to' })  only rows whose tested_date is in the window; the two
//                                               values are parameter names, compared as in inRange
// v1 fills the table with sp_update_HIVVLTable (a MERGE that also deletes rows missing from its source)
// and then sp_remove_dupsHIVVLEID. The CTE returns what the table holds after both.
//
// Columns, in the order of Table__dbo_HIVVL.sql:
//   province, district, facility, lab_id, gender, age_group, tested_date, suppressed, uu, tat,
//   tat_within14, pregnant, breastfeeding, baseline_vl, run_date, received_date, registered_date,
//   collected_date, tested_at, referral, disalink, three_m_post_unsuppressed, poc, poc_w48h
// The five dates are CE's ISO text (tested_date = diagnostic_reports.issued, run_date =
// lab_requests.analysis_at, received_date = specimens.received_time, registered_date =
// lab_requests.authored_at, collected_date = diagnostic_reports.effective).
//
// One row per final result: a request row (lab_requests) with a result row (lab_results) in panel
// HIVVL, POCVR or POHVL and observation HIVVL, HIVVC, HIVTM, HIVVD, POCVR or POCVC, whose report is
// final and whose result is on the valid list or is a number (v1 lines 120-133). The requesting
// facility must be mapped to a ZMFAC register row, as v1 inner-joins its dictionary (line 109).
//
// The dedupe keeps one row per lab id, the earliest tested_date (sp_remove_dupsHIVVLEID). v1 sorts
// NULL first, so a row with no tested date wins. Ties are broken on the request row id, the report row id, then the
// result row id; v1 keeps either one. The dedupe runs over all rows of the lab id before the window,
// so a lab id whose earliest row is outside the window shows nothing in it.
//
// Kept v1 quirks (spec ruling 1):
//   - age_group has its own labels: '<01', '01-04', '05-09', ... '45-49', '50+' (lines 56-70). A
//     negative or missing age gives NULL. It is not the dbo.Agegroup of the other reports.
//   - gender knows only F, M, I and U; everything else, including N and O, is NULL (lines 49-55).
//   - pregnant, breastfeeding, baseline_vl and three_m_post_unsuppressed are 1 or NULL, never 0
//     (lines 30-44: a left join to the rows where the flag is 1).
//   - suppressed counts any number under 1000, and a text only when it is on the list (line 87).
//     v1 reads the number (SIValue; here numeric_value) apart from the text, and so does the port. A result
//     held only as text ('5,000', '120') passes the valid-result filter (ISNUMERIC on the text) and has
//     no numeric value, so it is neither suppressed nor UU. This is not a v1 defect; it is what the
//     checks show. UU is a number under 200 or a not-detected text (line 95).
//   - tat counts date boundaries of the LOCAL dates (datediff dd), each date taken from the stamp's own
//     text, not shifted to UTC. tat_within14 is 0, not NULL, when tat is NULL.
//     poc_w48h counts hour boundaries (datediff hh) and tests 24, although its name says 48.
//   - The valid list holds 'PTLTT' where the suppressed list holds 'PLTT'. DET, PLTT and
//     '<883 copies/mL' are suppressed texts that never pass the valid-result filter.
//   - ISNUMERIC counts '1E5' and '12' as numbers: a lab id like '1E5-X' or a testing code like '12' is POC.
//   - tested_at: a 3-character ZU code other than ZUE and ZUA becomes ZUL (lines 76-79). SQL Server
//     LIKE ignores trailing blanks in the matched text, so 'ZUB ' also becomes ZUL (the port trims first).
//   - Partial stamps ('2026-07') give NULL dates and TAT, and never raise. A date-only stamp gives its date.
//
// CE gaps:
//   - ReceivingFacilityCode is not carried (ruling 7). receiving_code is a NULL column in the first
//     CTE, so the v1 expressions keep their form. tested_at uses only the testing code (the
//     performer). referral is NULL; when a receiving code arrives it follows line 80 (1 or 0).
//   - Disalink reads the request attributes prereg-registration-facility (LIMSPreReg_RegistrationFacilityCode)
//     and referring-request-id (ReferringRequestID). cdr-toolchain does not fill them yet, so disalink
//     is 0 until it does. v1's facility list is the mapped facility_map codes.
//   - The VIRAL answers come from questionnaire_responses (ruling 6), not LabResults. The form keeps the
//     reported text, so v1's coded-value test (LIMSCodedValue = 'BASE', line 22) is covered by the text
//     test (ARTRS text like '%Base%') only. A form on any request row of the lab id counts, because v1
//     keys the flags on RequestID. RTRI is a lab panel: any result row on an RTRI request is a baseline test.
export function hivvlCte(name, { from, to } = {}) {
  if ((from === undefined) !== (to === undefined)) throw new Error('hivvlCte: give both from and to, or neither');
  const windowed = from !== undefined && to !== undefined;
  const result = rpt('l');
  // Rows of the lab ids that have a report issued in the window: the dedupe needs their other rows too.
  const prefilter = windowed
    ? `and lr.request_id in (select lr2.request_id from lab_requests lr2 join diagnostic_reports dr2 on dr2.based_on_id = lr2.id where ${inRange('dr2.issued', from, to)})`
    : '';
  const finalRange = windowed ? `and ${inRange('r.tested_date', from, to)}` : '';
  return `${name} as (
  with ${name}_src as (
    select lr.id as request_row_id, dr.id as report_row_id, l.id as result_row_id, lr.request_id as lab_id,
      fmr.region as province, fmr.district as district, fmr.name as facility,
      p.sex, lr.age_years,
      dr.issued as tested_date, lr.analysis_at as run_date, s.received_time as received_date,
      lr.authored_at as registered_date, dr.effective as collected_date,
      dr.performer as testing_code, null::text as receiving_code,
      ${result} as result_text, l.numeric_value
    from lab_requests lr
    join lab_results l on l.request_id = lr.id
    ${requesterJoin('lr', 'fmr')}
    join diagnostic_reports dr on dr.based_on_id = lr.id
    left join specimens s on s.id = dr.specimen_id
    left join patients p on p.id = lr.patient_id
    where lr.panel_code in ('HIVVL', 'POCVR', 'POHVL')
      and l.observation_code in ('HIVVL', 'HIVVC', 'HIVTM', 'HIVVD', 'POCVR', 'POCVC')
      and dr.status = 'final'
      and (${inListSql(result, HIVVL_VALID)} or ${isNumericSql(result)})
      ${prefilter}
  ),
  ${name}_ranked as (
    select s.*, row_number() over (partition by s.lab_id order by ${localTs('s.tested_date')} nulls first, s.request_row_id, s.report_row_id, s.result_row_id) as seq
    from ${name}_src s
  ),
  ${name}_flags as (
    select q.request_id as lab_id,
      max(case when ${inListSql('a.vpreg', YES_WORDS)} or ${inListSql('a.artpr', YES_WORDS)} or ${inListSql('a.artrs', ['Pregnant Mother'])} then 1 end) as pregnant,
      max(case when ${inListSql('a.vbrea', YES_WORDS)} or ${inListSql('a.artbr', YES_WORDS)} or ${inListSql('a.artrs', ['Lactating Mother'])} then 1 end) as breastfeeding,
      max(case when a.artrs ilike '%Base%' or (q.panel_code = 'RTRI' and exists (select 1 from lab_results x where x.request_id = q.id)) then 1 end) as baseline_vl,
      max(case when ${inListSql('a.visit', ['3 months post unsuppressed VL result'])} or ${inListSql('a.artrs', ['Confirmation of Treatment Failure (repeat VL at 3M)', 'Post EAC'])} then 1 end) as three_m_post_unsuppressed
    from lab_requests q
    cross join lateral (select
      ${formAnswerSql('q.id', 'ARTPR')} as artpr, ${formAnswerSql('q.id', 'VPREG')} as vpreg,
      ${formAnswerSql('q.id', 'ARTBR')} as artbr, ${formAnswerSql('q.id', 'VBREA')} as vbrea,
      ${formAnswerSql('q.id', 'ARTRS')} as artrs, ${formAnswerSql('q.id', 'VISIT')} as visit) a
    where q.request_id in (select s.lab_id from ${name}_src s)
    group by q.request_id
  )
  select r.province, r.district, r.facility, r.lab_id,
    case upper(rtrim(r.sex)) when 'F' then 'Female' when 'M' then 'Male' when 'I' then 'Indeterminate' when 'U' then 'Unknown' end as gender,
    case
      when r.age_years = 0 then '<01'
      when r.age_years between 1 and 4 then '01-04'
      when r.age_years between 5 and 9 then '05-09'
      when r.age_years between 10 and 14 then '10-14'
      when r.age_years between 15 and 19 then '15-19'
      when r.age_years between 20 and 24 then '20-24'
      when r.age_years between 25 and 29 then '25-29'
      when r.age_years between 30 and 34 then '30-34'
      when r.age_years between 35 and 39 then '35-39'
      when r.age_years between 40 and 44 then '40-44'
      when r.age_years between 45 and 49 then '45-49'
      when r.age_years >= 50 then '50+'
    end as age_group,
    r.tested_date,
    case when (${inListSql('r.result_text', HIVVL_SUPPRESSED)} or (r.numeric_value < 1000 and r.result_text not like '>%')) then 1 else 0 end as suppressed,
    case when (${inListSql('r.result_text', HIVVL_UU)} or r.numeric_value < 200) then 1 else 0 end as uu,
    c.tat,
    case when c.tat <= 14 then 1 else 0 end as tat_within14,
    f.pregnant, f.breastfeeding, f.baseline_vl,
    r.run_date, r.received_date, r.registered_date, r.collected_date,
    case when rtrim(c.base_code) ilike 'ZU_' and ${foldSql('r.testing_code')} not in ('zue', 'zua') then 'ZUL' else c.base_code end as tested_at,
    case
      when r.receiving_code is null then null::int
      when length(rtrim(r.receiving_code)) > 0 and ${foldSql('r.receiving_code')} <> ${foldSql('r.testing_code')} then 1
      else 0
    end as referral,
    case
      when length(rtrim(c.prereg_facility)) > 0 then 1
      when exists (select 1 from facility_map fd where fd.registry_id is not null and ${foldSql('fd.source_code')} = ${foldSql('left(c.referring_id, 5)')})
        and not ${isNumericSql('left(c.referring_id, 5)')} then 1
      when ${isNumericSql('left(c.referring_id, 3)')} then 1
      else 0
    end as disalink,
    f.three_m_post_unsuppressed,
    case when c.is_poc then 1 else 0 end as poc,
    case when c.is_poc and c.hours_taken <= 24 then 1 else 0 end as poc_w48h
  from ${name}_ranked r
  left join ${name}_flags f on f.lab_id = r.lab_id
  cross join lateral (select
    ${localDate('r.tested_date')} - ${localDate('r.collected_date')} as tat,
    extract(epoch from date_trunc('hour', ${utcTs('r.tested_date')}) - date_trunc('hour', ${utcTs('r.collected_date')})) / 3600 as hours_taken,
    ${isNumericSql('r.testing_code')} or ${isNumericSql('left(r.lab_id, 3)')} as is_poc,
    case when length(rtrim(r.testing_code)) = 0 then r.receiving_code else r.testing_code end as base_code,
    (select max(a.value_text) from lab_request_attributes a where a.lab_request_id = r.request_row_id and a.system = ${sqlLit(ATTR_SYSTEM)} and a.code = 'prereg-registration-facility') as prereg_facility,
    (select max(a.value_text) from lab_request_attributes a where a.lab_request_id = r.request_row_id and a.system = ${sqlLit(ATTR_SYSTEM)} and a.code = 'referring-request-id') as referring_id) c
  where r.seq = 1
    ${finalRange}
)`;
}

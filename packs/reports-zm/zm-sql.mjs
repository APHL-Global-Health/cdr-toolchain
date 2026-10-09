// Shared SQL helpers and parameter builders for Zambia's reports. The query files in queries/ and
// slice 1's zm-queries.mjs import from here. Each helper returns SQL text (or a parameter object)
// for a custom query; none of them reads data.
//
// Query parameters appear in SQL as {{param.<id>}}. CE puts the value in as a quoted literal, and a
// blank optional parameter arrives as ''.

import { lit as sqlLit } from '../vl-reports-mz/vl-queries.mjs';

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

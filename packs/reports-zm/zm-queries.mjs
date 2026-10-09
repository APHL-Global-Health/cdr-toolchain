// SQL for Zambia's reports, ported from v1's OpenLDRReporting database
// (corlix/fixtures/Zambia_views/script.sql, UTF-16). build.mjs puts them in the custom-queries step
// of dist/pack.json. The SQL may differ from v1's; the output must match.

import { lit as sqlLit, rpt, inListSql, isNumericSql } from '../vl-reports-mz/vl-queries.mjs';

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

export const ZM_REGISTER_URL = 'urn:openldr:zm:facilities';

// Zambia's v1 panel and observation codes (content, so they live in the pack).
export const ZM_CODES = {
  // TND: the valid results of part 1.
  validPanels: ['HIVVL', 'RTRI'],
  validObservations: ['HIVVL', 'HIVVC', 'HIVTM', 'HIVVD', 'POCVR', 'POCVC'],
  // Parts 2 and 3.
  vlPanel: 'HIVVL',
  unclearObservations: ['HIVVL', 'HIVVC', 'HIVVD'],
};

const ATTR_SYSTEM = 'urn:openldr:cs:request-attribute';

// v1 TND (sp_GetPreviousVLResultforCohort2x): results left out as not a viral load.
export const INVALID_RESULTS = [
  'antibodies. @mat3', 'FAIL', 'Haemolysed', 'Haemolysed ++', 'Insufficient for further tests',
  'Insufficient serum received', 'INV', 'INVAL', 'Negative', 'No', 'Please repeat', 'Positive',
  'to confirm patient identity.', 'Weak Positive', 'Invalid', 'Absent', 'antibodies.', 'AT', 'Failed',
  'Icteric ++++', 'Indeterminate', 'per request', 'Positive (Repeat sample)',
  'This result has been checked', 'VAL', '@con1 @con2',
];
// v1 TND: results counted as suppressed, beside any number under 1000.
export const SUPPRESSED_RESULTS = [
  '<20 copies/mL', 'TAR', 'Target Not Detected', 'TARG', '< 20', 'RNA not detected', '<30 copies/ml',
  '<30 copies/mL', 'NDET', 'ND', '<20CP', '< 40', '<40 copies/mL', '<400 copies/mL', '<400',
  '<883 copies/mL',
];
// v1 sp_*_hivvl_clients_month, part "incs": texts that are not unclear although not a number.
export const BELOW_LIMIT_RESULTS = [
  '< 20', '<30 copies/mL', '> 10000000', 'NDET', 'Target Not Detected', 'RNA Not Detected',
  '<400 copies/mL', '<400', '<40 copies/mL',
];

const sqlList = (values) => values.map(sqlLit).join(', ');
const inRange = (x) => `${x} >= {{param.from}} and ${x} <= ({{param.to}} || 'T23:59:59.999Z')`;

// The province picker: the register's provinces. CE runs it through validateSelectSql and uses the
// first column of each row.
export const provinceOptionsSql = (registerUrl) =>
  `select distinct region from facility_registry where facility_system = ${sqlLit(registerUrl)} and register_state = 'in_register' and region is not null and region <> '' order by region`;

// "VL clients by province": v1's 12 sp_<province>_hivvl_clients_month/_quarter procedures as one
// query. Three parts joined with UNION, as v1's are:
//   zm_valid    v1 TND: every final VL result in the range that is not an invalid text.
//   zm_rejected cancelled HIVVL requests registered in the range, not in zm_valid.
//   zm_unclear  final HIVVL results that are neither a number nor a below-limit text, not in zm_valid.
// v1 reads its copy tables TND and hivvl; this rebuilds them from the warehouse. Province, district
// and facility come from the requesting facility's mapped ZMFAC row; unmapped facilities drop out,
// as v1's inner joins drop facilities missing from its dictionary. zm_req pre-filters by panel and date, so the
// query reads only the requests in the range. Gender and the two dates always
// come from the request (v1 part 1 leaves them blank when its hivvl table lacks the request).
// Part 1 builds the ART number with artNumberSql; parts 2 and 3 show the unique id raw, as v1 does.
export function provinceClientsSql(codes) {
  const result = rpt('r');
  return `with zm_ids as (
  select a.lab_request_id,
    max(case when a.code = 'reference-numbers' then a.value_text end) as reference_numbers,
    max(case when a.code = 'unique-id' then a.value_text end) as unique_id
  from lab_request_attributes a
  where a.system = ${sqlLit(ATTR_SYSTEM)} and a.code in ('reference-numbers', 'unique-id')
  group by a.lab_request_id
),
zm_req as (
  select lr.id, lr.request_id, lr.panel_code, lr.age_years, lr.authored_at,
    fmr.region as province, fmr.district, fmr.name as facility,
    concat(p.firstname, ' ', p.surname) as client_name,
    case p.sex when 'F' then 'Female' when 'M' then 'Male' when 'U' then 'Unknown' when 'I' then 'Indeterminate' else 'Missing' end as gender,
    zi.reference_numbers, zi.unique_id,
    dr.status as report_status, dr.effective as collected_date, dr.issued as result_date
  from lab_requests lr
  join facility_map fmr on fmr.source_system = coalesce(lr.source_system, '') and fmr.performer_system = coalesce(lr.requester_system, '') and fmr.source_code = lr.requester_code and fmr.registry_id is not null
  left join diagnostic_reports dr on dr.based_on_id = lr.id
  left join patients p on p.id = lr.patient_id
  left join zm_ids zi on zi.lab_request_id = lr.id
  where ({{param.province}} = '' or fmr.region = {{param.province}})
    and lr.panel_code in (${sqlList([...new Set([...codes.validPanels, codes.vlPanel])])})
    and (${inRange('dr.issued')} or ${inRange('lr.authored_at')})
),
zm_valid as (
  select q.province, q.district, q.facility, q.request_id as lab_id, q.client_name, q.age_years, q.gender,
    ${artNumberSql("coalesce(q.reference_numbers, '')", "coalesce(q.unique_id, '')")} as art_number,
    q.collected_date, q.authored_at as registered_date, q.result_date,
    ${result} as result,
    case when ${inListSql(result, SUPPRESSED_RESULTS)} or r.numeric_value < 1000 then 'Yes' else 'No' end as suppressed
  from zm_req q
  join lab_results r on r.request_id = q.id
  where q.panel_code in (${sqlList(codes.validPanels)})
    and r.observation_code in (${sqlList(codes.validObservations)})
    and q.report_status = 'final'
    and ${inRange('q.result_date')}
    and ${result} is not null
    and not ${inListSql(result, INVALID_RESULTS)}
),
zm_rejected as (
  select q.province, q.district, q.facility, q.request_id as lab_id, q.client_name, q.age_years, q.gender,
    q.unique_id as art_number, q.collected_date, q.authored_at as registered_date, q.result_date,
    'REJECTED' as result, null::text as suppressed
  from zm_req q
  where q.panel_code = ${sqlLit(codes.vlPanel)}
    and q.report_status = 'cancelled'
    and ${inRange('q.authored_at')}
    and not exists (select 1 from zm_valid v where v.lab_id = q.request_id)
),
zm_unclear as (
  select q.province, q.district, q.facility, q.request_id as lab_id, q.client_name, q.age_years, q.gender,
    q.unique_id as art_number, q.collected_date, q.authored_at as registered_date, q.result_date,
    ${result} as result, null::text as suppressed
  from zm_req q
  join lab_results r on r.request_id = q.id
  where q.panel_code = ${sqlLit(codes.vlPanel)}
    and r.observation_code in (${sqlList(codes.unclearObservations)})
    and q.report_status = 'final'
    and ${inRange('q.result_date')}
    and ${result} is not null
    and not ${isNumericSql(result)}
    and not ${inListSql(result, BELOW_LIMIT_RESULTS)}
    and not exists (select 1 from zm_valid v where v.lab_id = q.request_id)
)
select province as "Province", district as "District", facility as "Facility", lab_id as "LabID",
  client_name as "Name", age_years as "AgeInYears", gender as "Gender", art_number as "ARTNumber",
  collected_date as "CollectedDate", registered_date as "RegisteredDate", result_date as "ResultDate",
  result as "Result", suppressed as "Suppressed"
from (
  select * from zm_valid
  union
  select * from zm_rejected
  union
  select * from zm_unclear
) zm
order by 1, 2, 3, 4, 11, 12, 5, 6, 7, 8, 9, 10, 13`;
}

export const zmParams = (registerUrl) => [
  { id: 'province', label: 'Province (blank for all)', type: 'select', required: false, optionsSql: provinceOptionsSql(registerUrl) },
  { id: 'from', label: 'Date from (YYYY-MM-DD)', type: 'text', required: true },
  { id: 'to', label: 'Date to (YYYY-MM-DD)', type: 'text', required: true },
];

export function zmQueryFile() {
  return {
    format: 'openldr.custom-queries',
    version: 1,
    exportedAt: new Date().toISOString(),
    queries: [
      { name: 'VL clients by province', sql: provinceClientsSql(ZM_CODES), params: zmParams(ZM_REGISTER_URL) },
    ],
  };
}

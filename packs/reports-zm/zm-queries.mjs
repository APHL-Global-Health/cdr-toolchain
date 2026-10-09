// SQL for Zambia's reports, ported from v1's OpenLDRReporting database
// (corlix/fixtures/Zambia_views/script.sql, UTF-16). build.mjs puts them in the custom-queries step
// of dist/pack.json. The SQL may differ from v1's; the output must match.

import { rpt, inListSql, isNumericSql } from '../vl-reports-mz/vl-queries.mjs';
import {
  sqlLit, sqlList, inRange, ZM_REGISTER_URL, provinceOptionsSql, provinceParam, dateParams, artNumberSql,
  areaFilter, tndCte, TND_PANELS, TND_OBSERVATIONS, TND_INVALID_RESULTS, TND_SUPPRESSED_RESULTS,
} from './zm-sql.mjs';

// These moved to zm-sql.mjs; slice 1's importers still get them from here.
export { artNumberSql, ZM_REGISTER_URL, provinceOptionsSql };

// Zambia's v1 panel and observation codes (content, so they live in the pack).
export const ZM_CODES = {
  // TND: the valid results of part 1.
  validPanels: TND_PANELS,
  validObservations: TND_OBSERVATIONS,
  // Parts 2 and 3.
  vlPanel: 'HIVVL',
  unclearObservations: ['HIVVL', 'HIVVC', 'HIVVD'],
};

// The TND lists moved to zm-sql.mjs (tndCte); these names stay for the importers of this file.
export const INVALID_RESULTS = TND_INVALID_RESULTS;
export const SUPPRESSED_RESULTS = TND_SUPPRESSED_RESULTS;
// v1 sp_*_hivvl_clients_month, part "incs": texts that are not unclear although not a number.
export const BELOW_LIMIT_RESULTS = [
  '< 20', '<30 copies/mL', '> 10000000', 'NDET', 'Target Not Detected', 'RNA Not Detected',
  '<400 copies/mL', '<400', '<40 copies/mL',
];

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
// zm_req and zm_valid are built by tndCte (zm-sql.mjs), which Task 11's "Unique VL clients" also reads. The panels and observations of
// part 1 are the TND ones (codes.validPanels and validObservations hold the same lists).
export function provinceClientsSql(codes) {
  const result = rpt('r');
  return `with ${tndCte('zm_valid', { reqName: 'zm_req', where: areaFilter({ province: 'province' }, 'fmr'), extraPanels: [codes.vlPanel], orRegistered: true })},
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
  select province, district, facility, lab_id, client_name, age_years, gender, art_number, collected_date, registered_date, result_date,
    result, case when suppressed_flag = 1 then 'Yes' else 'No' end as suppressed
  from zm_valid
  union
  select * from zm_rejected
  union
  select * from zm_unclear
) zm
order by 1, 2, 3, 4, 11, 12, 5, 6, 7, 8, 9, 10, 13`;
}

export const zmParams = (registerUrl) => [
  provinceParam('province', false, registerUrl),
  ...dateParams(true),
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

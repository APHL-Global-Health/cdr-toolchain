// Custom queries for the eid reports. Each task adds { name, sql, params } entries to the list.

import { inListSql, rpt, foldSql } from '../../vl-reports-mz/vl-queries.mjs';
import { provinceParam, districtParam, dateParams, epiSummarySql } from '../zm-sql.mjs';

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

export function queries() {
  return [
    { name: 'EID testing summary by province', sql: eidTestingSummarySql('province'), params: eidTestingSummaryParams('province') },
    { name: 'EID testing summary by district', sql: eidTestingSummarySql('district'), params: eidTestingSummaryParams('district') },
    { name: 'EID testing summary by facility', sql: eidTestingSummarySql('facility'), params: eidTestingSummaryParams('facility') },
  ];
}

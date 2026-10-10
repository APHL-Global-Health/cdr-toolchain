// Custom queries for the tests reports. Each task adds { name, sql, params } entries to the list.

import { foldSql } from '../../vl-reports-mz/vl-queries.mjs';
import { dateParams, recencyCte, recencySurveillanceCte, requestAttrSql, ssTextKey } from '../zm-sql.mjs';

// ---- The three recency queries (Task 17) ---------------------------------------------------------------------------------
//
// v1 fills two copy tables (Recency by sp_getTestLevelRecency_CIDRZ, Recency_Surveillance by sp_recency_surveillance) and three
// procedures read them. recencyCte and recencySurveillanceCte rebuild the tables; the queries below are the three procedures.
// None of the three procedures has a date filter of its own, so the only window is the builders' (RegisteredDateTime from
// 2023-10-01 to the end of the current week). It becomes the required `from` and `to` (spec ruling 3), compared on the LOCAL date
// of lab_requests.authored_at (see recencyCte). The whole first day is in, where v1 starts at 00:00:00.001.
//
// Row order. v1 has no ORDER BY (a table scan), so the rows come in no set order. CE pages a result with LIMIT and OFFSET, so each
// query orders by every output column: text in SQL Server's word order with case and trailing spaces ignored (ssTextKey), the plain
// text as the tie-break, a missing value first (SQL Server sorts NULL lowest). This is display order only; no v1 value depends on it.

// Order by one output column. `num` marks a number column.
const textOrder = (e) => `${ssTextKey(e)} collate "C" nulls first, ${e} collate "C" nulls first`;
const numberOrder = (e) => `${e} nulls first`;
const selectItems = (columns) => columns.map((c) => `${c.e} as "${c.as}"`).join(',\n  ');
const orderItems = (columns) => columns.map((c) => (c.num ? numberOrder(c.e) : textOrder(c.e))).join(',\n  ');

// v1 R lines 22-25 (and Z lines 22-25): a baseline that is NULL or equal to '' is replaced by tb_edits.result. CE has no tb_edits (see
// the gaps), so the replacement is always NULL: an empty baseline becomes NULL. SQL Server's '' = '   ' is true, so a baseline of
// spaces only is blank too. A tab, or text with trailing spaces after other characters, is not blank and comes through as stored.
// (A NULL baseline is already NULL, so the "is null" half of v1's test has nothing left to do.)
const BASELINE = "case when rtrim(rc.baseline_vl_result) = '' then null else rc.baseline_vl_result end";

// The columns of get_Test_level_Recency (R lines 45-55) in v1's order, and of the ZNPHI version (Z lines 45-56), which adds ClientName
// and REFNO after Lab ID. The names are the final select's own spelling, which SQL Server returns as written: BreastFeeding (the
// copy table says Breastfeeding), measured on the local SQL Server.
function recencyColumns(withClient) {
  const c = (e, as, num = false) => ({ e, as, num });
  return [
    c('rc.province', 'Province'), c('rc.district', 'District'), c('rc.facility', 'Facility'),
    c('rc.moh_facility_code', 'MOHFacilityCode'), c('rc.ip', 'IP'), c('rc.lab_id', 'Lab ID'),
    ...(withClient ? [c("concat(pt.firstname, ' ', pt.surname)", 'ClientName'), c('pt.refno', 'REFNO')] : []),
    c('rc.gender', 'Gender'), c('rc.age_in_years', 'AgeInYears', true), c('rc.recency_result', 'Recency Result'),
    c(BASELINE, 'Baseline VL Result'), c('rc.suppression_status', 'Suppression Status'),
    c('rc.testing_laboratory', 'Testing Laboratory'), c('rc.sample_collection_date', 'Sample Collection Date'),
    c('rc.date_registered', 'Date Registered'), c('rc.tested_date', 'Tested Date'), c('rc.reviewed_date', 'Reviewed Date'),
    c('rc.reporting_status', 'Reporting Status'), c('rc.modality', 'Modality'), c('rc.pregnant', 'Pregnant'),
    c('rc.breastfeeding', 'BreastFeeding'), c('rc.recency_test_date', 'Recency Test Date'),
  ];
}

const windowParams = () => [...dateParams(true)];

// ---- Recency tests ------------------------------------------------------------------------------------------------------
//
// Replaces get_Test_level_Recency (no parameters). One row per RTRI test result of a lab number, with the client's baseline viral
// load, suppression status and reporting status. The rows are the Recency table's; recencyCte documents the rules (which requests
// count, the 13 lab names, the suppressed list, the answers). Columns, v1's 21: Province, District, Facility, MOHFacilityCode, IP,
// Lab ID, Gender, AgeInYears, Recency Result, Baseline VL Result, Suppression Status, Testing Laboratory, Sample Collection Date,
// Date Registered, Tested Date, Reviewed Date, Reporting Status, Modality, Pregnant, BreastFeeding, Recency Test Date.
//
// What this query adds to the table (R lines 22-55):
//   - Baseline VL Result: a blank becomes NULL (BASELINE above).
//   - Suppression Status: v1 takes the table's status and, only when that is NULL, works one out from tb_edits.result. With no tb_edits
//     row the second part is NULL, so the status is the table's. v1's second part also has a branch that can never run (line 28 asks
//     isnumeric(result) = 0 and isnumeric(result) = 1 together), so a number from tb_edits never gave 'Suppressed' there. Neither
//     matters here.
//   - Reporting Status: v1 works it out again from Recency Result and Suppression Status (lines 49-54). The result is the table's,
//     because the status did not change.
//
// Kept v1 quirks (spec ruling 1):
//   - Rows multiply: a lab number with two baseline results, or two answers to one question, gives a row each.
//   - A text baseline on no list ('Failed') stays, with no suppression status.
//   - A Recency Result other than 'Long Term' and 'Recent' has no reporting status.
//   - Age, dates and answers come through as stored. The four dates are CE's ISO text with the offset DISA wrote.
//
// CE gaps (spec ruling 7): IP (the implementing partner) has no CE source and is NULL. tb_edits, v1's hand-kept table of corrected
// baselines, has no source in CE: a lab number v1 patched shows the baseline the lab results hold. MOHFacilityCode is the register's
// national code. Recency Test Date is read from the RTRTD result text (recencyCte). Testing Laboratory follows ruling 8 for any
// lab number outside the 13 prefixes.
export function recencyTestsSql() {
  const columns = recencyColumns(false);
  return `with ${recencyCte('rc', { from: 'from', to: 'to' })}
select ${selectItems(columns)}
from rc
order by ${orderItems(columns)}`;
}

// ---- Recency tests with client names ------------------------------------------------------------------------------------
//
// Replaces get_Test_level_Recency_ZNPHI (no parameters). The same rows as Recency tests, with ClientName and REFNO after Lab ID, for
// the national public health institute. Kept as its own query so that the personal columns can be given to a reader apart from the
// plain list (inventory verdict PORT, PII: first name, surname, REFNO). Columns, v1's 23: Province, District, Facility,
// MOHFacilityCode, IP, Lab ID, ClientName, REFNO, then Gender to Recency Test Date as in Recency tests.
//
// The client (Z lines 46 and 57-59): v1 inner-joins Patients on the lab number. ClientName is concat(FIRSTNAME, ' ', surname), and
// concat treats a NULL as empty, so a missing first name gives ' Banda' and a missing surname 'Mary '. REFNO is Patients.REFNO.
//   - Patients: CE keeps the client on the request rows (lab_requests.patient_id), one row per OBR set, so the lab number's patients
//     are those of ALL its request rows, in either panel and outside the window. The lab numbers compare ignoring case and trailing
//     spaces, as SQL Server's join does.
//   - Several request rows of one lab number that name the same person (the same first name and surname) are one client, as v1's
//     one Patients row per request number is. Two different people under one lab number give a row each, as a join does.
//   - REFNO is the text of the reference-numbers request attribute (the raw text, not the ART number). When a client's rows hold
//     several values, the greater text in byte order is shown (v1 holds one value).
//   - The inner join drops a lab number with no patient row, or whose patient_id points at no patients row, as v1 does.
//
// Kept quirks, deviations and gaps: as Recency tests. The only extra deviation is the REFNO pick above.
export function recencyTestsWithClientNamesSql() {
  const columns = recencyColumns(true);
  return `with ${recencyCte('rc', { from: 'from', to: 'to' })},
pat as (
  select ${foldSql('lr.request_id')} as lab_key, p.firstname, p.surname,
    max(${requestAttrSql('lr.id', 'reference-numbers')} collate "C") as refno
  from lab_requests lr
  join patients p on p.id = lr.patient_id
  where ${foldSql('lr.request_id')} in (select ${foldSql('c.lab_id')} from rc c)
  group by ${foldSql('lr.request_id')}, p.firstname, p.surname
)
select ${selectItems(columns)}
from rc
join pat pt on pt.lab_key = ${foldSql('rc.lab_id')}
order by ${orderItems(columns)}`;
}

// ---- Recency surveillance counts ----------------------------------------------------------------------------------------
//
// Replaces get_Test_level_Recency_Surveillance (no parameters), which is `select * from Recency_Surveillance` (S lines 9-10). The
// rows are the table's, so recencySurveillanceCte documents every rule (the age groups, the 7-text suppressed list, the modality
// list, year, quarter, month and week of the registered date, the count of distinct lab numbers). Columns, v1's 15 and their spelling
// (Table__dbo_Recency_Surveillance.sql): Province, District, Facility, Implementing Partner, AgeGroup, Gender, Recency Result,
// Suppression Status, Reporting Status, Modality, Reg_Year, Reg_Quarter, Month, week, Count.
//
// Kept v1 quirks (spec ruling 1), all from the builder: age 50 is '<15'; Week is datepart(wk) (Sunday first, week 1 holds 1 January);
// '<883 copies/mL' is not suppressed here; a lab number with baselines in two classes counts once in each group; groups merge
// spellings that differ in case or trailing spaces (and show the smallest spelling).
//
// CE gaps and deviations: Implementing Partner has no CE source and is NULL (ruling 7). v1 stops on a decimal baseline (CONVERT to
// int); this reads the number (see recencySurveillanceCte). The window is the required `from` and `to` on the local registered date.
export function recencySurveillanceSql() {
  const c = (as, num = false) => ({ e: `rs.${as}`, as, num });
  const columns = [
    { e: 'rs.province', as: 'Province' }, { e: 'rs.district', as: 'District' }, { e: 'rs.facility', as: 'Facility' },
    { e: 'rs.implementing_partner', as: 'Implementing Partner' }, { e: 'rs.age_group', as: 'AgeGroup' },
    { e: 'rs.gender', as: 'Gender' }, { e: 'rs.recency_result', as: 'Recency Result' },
    { e: 'rs.suppression_status', as: 'Suppression Status' }, { e: 'rs.reporting_status', as: 'Reporting Status' },
    { e: 'rs.modality', as: 'Modality' },
    { ...c('reg_year', true), as: 'Reg_Year' }, { ...c('reg_quarter', true), as: 'Reg_Quarter' },
    { ...c('month', true), as: 'Month' }, { ...c('week', true), as: 'week' }, { ...c('count', true), as: 'Count' },
  ];
  return `with ${recencySurveillanceCte('rs', { from: 'from', to: 'to' })}
select ${selectItems(columns)}
from rs
order by ${orderItems(columns)}`;
}

export function queries() {
  return [
    { name: 'Recency tests', sql: recencyTestsSql(), params: windowParams() },
    { name: 'Recency surveillance counts', sql: recencySurveillanceSql(), params: windowParams() },
    { name: 'Recency tests with client names', sql: recencyTestsWithClientNamesSql(), params: windowParams() },
  ];
}

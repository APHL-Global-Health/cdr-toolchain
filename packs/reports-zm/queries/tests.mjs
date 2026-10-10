// Custom queries for the tests reports. Each task adds { name, sql, params } entries to the list.

import { foldSql, inListSql, isNumericSql, rpt } from '../../vl-reports-mz/vl-queries.mjs';
import {
  dateParams, eidCte, hivvlCte, inRange, labNameSql, localDate, localTs, numberOfTextSql, provinceParam, recencyCte, recencySurveillanceCte,
  requesterJoin, requestAttrSql, ssTextKey, tndCte,
} from '../zm-sql.mjs';

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

// ---- DBS monitoring (VL and EID) ----------------------------------------------------------------------------------------
//
// Replaces sp_CIDRZ_DBS_Monitoring (and the saved-output table DBSMonitor, which has the same 12 columns and no reader). One row per
// viral load or EID sample of last month: valid results, rejections, and viral load results that are not clear, with the specimen
// type and the rejection reason. Columns, v1's 12 and their spelling: Province, District, Facility, LabID, CollectedDate,
// ReceivedDate, RegisteredDate, ResultDate, Result, SpecimenType, Test, RejectionReason. Test is 'VL' or 'EID'. The five dates are
// CE's ISO text (CollectedDate = diagnostic_reports.effective, ReceivedDate = specimens.received_time, RegisteredDate =
// lab_requests.authored_at, ResultDate = diagnostic_reports.issued).
//
// Parameters (spec ruling 3):
//   - `from` and `to` replace "last calendar month" (v1 lines 28-29, 66-67, 104-105, 160-161, 196-197: the first and the last day of the
//     month before getdate()). Both ends are whole local days, both in. v1 has no dateadd on the end date, so no extra day. For a window
//     of one calendar month the rows are v1's rows for that month.
//   - `province` replaces the constant list Lusaka, Southern, Eastern, Western, North-Western (lines 27, 68, 121, 158, 199). Blank means
//     that list, exactly as v1 lists it. A province given replaces the list (any province of the register, also one v1 leaves out). The
//     label says so. Names compare ignoring case and trailing spaces, as SQL Server does.
//
// What v1 does, in five parts. Each part has the province test and its own window:
//   VL valid    (lines 8-33) the TND copy table (tndCte) joined to the hivvl copy table (hivvlCte) on the lab number, windowed on the
//               result date. Result is the TND result text. The three dates come from the hivvl row. TND holds RTRI results and
//               texts that the hivvl table does not accept ('<883 copies/mL'): for those the hivvl row is missing, the three dates are
//               empty and the specimen type is 'Other' (below).
//   VL rejected (lines 34-70) requests with a rejected status (HL7 X, Y, Z), panel HIVVL, POCVR or POHVL, registered in the window,
//               whose lab number is not among the VL valid rows (line 69: the window and province of VL valid). Result is 'REJECTED'.
//   VL unclear  (lines 71-123) final results of those panels and of the observations HIVVL, HIVVC, HIVVD, HIVTM, POCVR, POCVC, authorised
//               in the window, whose text is not a number and not one of 14 texts (the list below). There is no test against VL valid, so
//               a lab number can have a valid row and an unclear row.
//   EID valid   (lines 135-163) the eid copy table (eidCte) windowed on the tested date, joined to the lab number's requests in the EID
//               panels HIVPC, POEID, POCGH. Result: Positive, Negative, Indeterminate or Error (in that order); an Invalid result or a text
//               on no list gives an empty Result.
//   EID rejected (lines 164-201) as VL rejected, with the EID panels and the EID valid rows.
// The five parts are joined with UNION (lines 127, 129, 204, 212), so repeated rows go (below).
//
// The specimen type (lines 13-19, repeated in every part): LIMSSpecimenSourceCode DBS is 'Dry Blood Spot'; B and BLD are 'Blood'; WB is
// 'Whole Blood'; P is 'Plasma'; an empty code (spaces too) is 'Unrecorded'; any other code, and a missing one, is 'Other'.
// CE: a specimen that joined but has a NULL or blank type_code is 'Unrecorded' (v1 holds a blank DISA code as '', see the CE gaps).
// 'Other' is kept for a code on no list and for a join that misses (no specimen row).
//   - VL valid takes it from the Requests rows of the hivvl lab number in the three VL panels (line 25), so a lab number with several
//     request rows gives a row per type, and a row with no hivvl row gets 'Other'. EID valid joins the EID-panel requests (inner join).
//   - The other parts take it from the request row itself.
//   - CE has no source code on the request. The port reads specimens.type_code of the specimen of the request's report
//     (diagnostic_reports.specimen_id). A request with no report, or a report with no specimen, has no specimen row: 'Other'. That
//     happens only with data that did not come through cdr, which always writes a Specimen and links it from each report.
//
// The rejection reason (lines 208-216). The last select joins Requests again on the lab number, the Result being 'REJECTED' (compared as
// SQL Server does: any case), a reason with a length (len() ignores trailing spaces, so spaces only is none) and a panel of the test (the
// three VL panels for a VL row, the three EID panels for an EID row). It takes the reason of EVERY such request row of the lab number: any
// status, any date, any facility. A lab number with two different reasons therefore gives two rows. With none, the reason is empty.
//
// Row repeats and order. UNION removes repeated rows, comparing every text column the way SQL Server does (ignoring case and trailing
// spaces; NULLs equal; the dates by their exact text). The port groups on those and shows the whole row that is smaller in byte order
// (province first, then the rest), so that the output is stable; v1 shows any of them. v1 orders by Province, District, Facility only
// (line 218), in SQL Server text order (ssTextKey). The port adds every other column so that paging is stable (NULL first).
//
// Kept v1 quirks (spec ruling 1):
//   - A Result of 'REJECTED' is a test of the text, so a lab result that says 'rejected' (any case) gets the reason join too.
//   - The unclear list is v1's fourth variant (14 texts, with DET, PLTV, the '>9999999' forms and '<883 copies/mL'); it is not the list
//     of the province procedures. '>9999999' and '> 9999999' are different texts.
//   - The reject parts leave out a lab number that is valid, but only valid in the same window and province. A lab number rejected in
//     Lusaka with a valid result in Northern is a rejected row.
//   - The Patients and LabResults joins of the reject parts add no column; they only repeat rows, which UNION removes.
//   - RTRI rows (TND holds them) have no hivvl row: empty dates, 'Other'.
//   - EID valid: Result has no Invalid class; the repeated 'Positive' branch (line 143) is dead.
//
// CE gaps (spec ruling 7) and CE choices:
//   - The code mapping is settled: cdr writes v1's LIMSSpecimenSourceCode unchanged into the specimen type (cdr apps/cli/src/export/
//     v1-transform.ts:251,298, v2-transform.ts:298-308, fhir-transform.ts:195) and CE projects it into specimens.type_code
//     (openldr_ce packages/db/src/relational/specimen.ts:8,17). DBS, B, BLD, WB and P arrive unchanged.
//   - A blank code. Measured on the local v1 OpenLDRData.Requests (Tanzania, 3,602,986 rows): a blank code is '' in 45,889 rows and
//     NULL in only 16. So v1 shows 'Unrecorded' for a blank code. cdr drops a blank code on the CE path (v2-transform.ts:34-41,
//     fhir-primitives.ts:99-103), so type_code is NULL. The port shows 'Unrecorded' for a specimen row with a NULL or blank type_code.
//     The 16 rows that v1 holds as NULL would show 'Other' in v1; CE cannot tell them from blanks, so they show 'Unrecorded'.
//   - v1 rejects statuses X, Y and Z. CE holds cancelled (X) only; Y and Z cannot be told from the other statuses (unknown), so they
//     are not rejected here.
//   - A request with no report cannot reach a specimen (CE links the specimen to the report), so its specimen type is 'Other'. This
//     happens only with data that did not come through cdr.
//   - TND in v1 starts at 2017-01-01 and ends now (the builder's floor and ceiling); the window is the caller's.
//   - Province, district and facility are the requesting facility's mapped register row. A facility not in the register drops out, as
//     v1's inner join on its dictionary drops it. A register row with no province is never in a province list.
//
// Deviations (spec ruling 2): none. v1 runs and returns real data.
const DBS_PROVINCES = ['Lusaka', 'Southern', 'Eastern', 'Western', 'North-Western'];
const DBS_VL_PANELS = ['HIVVL', 'POCVR', 'POHVL'];
const DBS_EID_PANELS = ['HIVPC', 'POEID', 'POCGH'];
const DBS_VL_OBSERVATIONS = ['HIVVL', 'HIVVC', 'HIVVD', 'HIVTM', 'POCVR', 'POCVC'];
// v1 lines 109-122 (the unclear part): texts that are not unclear although they are not numbers.
const DBS_CLEAR_TEXTS = ['< 20', '<30 copies/mL', '<40 copies/mL', '> 10000000', 'DET', '>9999999', '> 9999999', '>9999999 copies/mL',
  '> 9999999 copies/mL', 'NDET', 'PLTV', 'Target Not Detected', 'RNA Not Detected', '<883 copies/mL'];

// v1 lines 13-19: the CASE on LIMSSpecimenSourceCode. `rowId` is the id of the joined specimen: no row (the join missed) is 'Other';
// a row whose code is NULL or blank is 'Unrecorded' (v1 stores a blank code as '', see the CE gaps).
const dbsSpecimenTypeSql = (code, rowId) => `case when ${rowId} is null then 'Other'
      when ${inListSql(code, ['DBS'])} then 'Dry Blood Spot'
      when ${inListSql(code, ['B'])} then 'Blood'
      when ${inListSql(code, ['BLD'])} then 'Blood'
      when ${inListSql(code, ['WB'])} then 'Whole Blood'
      when ${inListSql(code, ['P'])} then 'Plasma'
      when coalesce(rtrim(${code}), '') = '' then 'Unrecorded'
      else 'Other' end`;

// The province test: v1's five when the parameter is blank, else the one given.
const dbsProvinceSql = (x) => `case when {{param.province}} = '' then ${inListSql(x, DBS_PROVINCES)} else ${foldSql(x)} = ${foldSql('{{param.province}}')} end`;

export function dbsMonitoringSql() {
  const result = rpt('l');
  // A request row of the rejected or unclear parts: the mapped facility, the report, the report's specimen.
  const requestFrom = `from lab_requests lr
  ${requesterJoin('lr', 'fmr')}
  join diagnostic_reports dr on dr.based_on_id = lr.id
  left join specimens s on s.id = dr.specimen_id`;
  const requestColumns = `fmr.region as province, fmr.district as district, fmr.name as facility, lr.request_id as lab_id,
    dr.effective as collected_date, s.received_time as received_date, lr.authored_at as registered_date, dr.issued as result_date`;
  const rejects = (name, panels, test, validName) => `${name} as (
  select ${requestColumns},
    'REJECTED'::text as result, ${dbsSpecimenTypeSql('s.type_code', 's.id')} as specimen_type, ${test} as test
  ${requestFrom}
  where dr.status = 'cancelled'
    and ${inListSql('lr.panel_code', panels)}
    and ${inRange('lr.authored_at')}
    and ${dbsProvinceSql('fmr.region')}
    and ${foldSql('lr.request_id')} not in (select ${foldSql('v.lab_id')} from ${validName} v)
)`;
  const columns = 'province, district, facility, lab_id, collected_date, received_date, registered_date, result_date, result, specimen_type, test';
  const keys = ['province', 'district', 'facility', 'lab_id', 'collected_date', 'received_date', 'registered_date', 'result_date',
    'result', 'specimen_type', 'test', 'reason'];
  // Text columns compare folded, dates and the two constants as they are.
  const folded = new Set(['province', 'district', 'facility', 'lab_id', 'result', 'reason']);
  const keyOf = (c) => (folded.has(c) ? foldSql(c) : c);
  const plain = ['province', 'district', 'facility', 'lab_id', 'result', 'reason'].map((c) => `${c} collate "C"`).join(', ');
  return `with ${tndCte('tn', { from: 'from', to: 'to' })},
${hivvlCte('hv', { from: 'from', to: 'to', labsInWindow: true })},
${eidCte('ed', { from: 'from', to: 'to' })},
sp_vl as (
  select distinct ${foldSql('rq.request_id')} as lab_key, ${dbsSpecimenTypeSql('sx.type_code', 'sx.id')} as specimen_type
  from lab_requests rq
  left join diagnostic_reports rd on rd.based_on_id = rq.id
  left join specimens sx on sx.id = rd.specimen_id
  where ${inListSql('rq.panel_code', DBS_VL_PANELS)}
    and ${foldSql('rq.request_id')} in (select ${foldSql('h.lab_id')} from hv h)
),
sp_eid as (
  select distinct ${foldSql('rq.request_id')} as lab_key, ${dbsSpecimenTypeSql('sx.type_code', 'sx.id')} as specimen_type
  from lab_requests rq
  left join diagnostic_reports rd on rd.based_on_id = rq.id
  left join specimens sx on sx.id = rd.specimen_id
  where ${inListSql('rq.panel_code', DBS_EID_PANELS)}
    and ${foldSql('rq.request_id')} in (select ${foldSql('e.lab_id')} from ed e)
),
vl_valid as (
  select t.province, t.district, t.facility, t.lab_id, h.collected_date, h.received_date, h.registered_date, t.result_date, t.result,
    coalesce(sp.specimen_type, 'Other') as specimen_type, 'VL'::text as test
  from tn t
  left join hv h on ${foldSql('h.lab_id')} = ${foldSql('t.lab_id')}
  left join sp_vl sp on sp.lab_key = ${foldSql('h.lab_id')}
  where ${dbsProvinceSql('t.province')}
),
${rejects('vl_rejects', DBS_VL_PANELS, "'VL'::text", 'vl_valid')},
vl_incs as (
  select ${requestColumns},
    ${result} as result, ${dbsSpecimenTypeSql('s.type_code', 's.id')} as specimen_type, 'VL'::text as test
  from lab_requests lr
  join lab_results l on l.request_id = lr.id
  ${requesterJoin('lr', 'fmr')}
  join diagnostic_reports dr on dr.based_on_id = lr.id
  left join specimens s on s.id = dr.specimen_id
  where dr.status = 'final'
    and ${inListSql('lr.panel_code', DBS_VL_PANELS)}
    and ${inRange('dr.issued')}
    and ${inListSql('l.observation_code', DBS_VL_OBSERVATIONS)}
    and not ${isNumericSql(result)}
    and not ${inListSql(result, DBS_CLEAR_TEXTS)}
    and ${dbsProvinceSql('fmr.region')}
),
eid_valid as (
  select e.province, e.district, e.facility, e.lab_id, e.collected_date, e.recieved_date as received_date, e.registered_date,
    e.tested_date as result_date,
    case when e.positive = 1 then 'Positive' when e.negative = 1 then 'Negative' when e.indeterminate = 1 then 'Indeterminate'
      when e.error = 1 then 'Error' end as result,
    sp.specimen_type, 'EID'::text as test
  from ed e
  join sp_eid sp on sp.lab_key = ${foldSql('e.lab_id')}
  where ${dbsProvinceSql('e.province')}
),
${rejects('eid_rejects', DBS_EID_PANELS, "'EID'::text", 'eid_valid')},
rows_all as (
  select ${columns} from vl_valid
  union all select ${columns} from vl_rejects
  union all select ${columns} from vl_incs
  union all select ${columns} from eid_valid
  union all select ${columns} from eid_rejects
),
reasoned as (
  select s.*, q.rejection_reason as reason
  from rows_all s
  left join lab_requests q on ${foldSql('s.result')} = 'rejected'
    and ${foldSql('q.request_id')} = ${foldSql('s.lab_id')}
    and length(rtrim(q.rejection_reason)) > 0
    and case when s.test = 'VL' then ${inListSql('q.panel_code', DBS_VL_PANELS)} else ${inListSql('q.panel_code', DBS_EID_PANELS)} end
),
dd as (
  select distinct on (${keys.map(keyOf).join(', ')})
    ${keys.join(', ')}
  from reasoned
  order by ${keys.map(keyOf).join(', ')}, ${plain}
)
select dd.province as "Province", dd.district as "District", dd.facility as "Facility", dd.lab_id as "LabID",
  dd.collected_date as "CollectedDate", dd.received_date as "ReceivedDate", dd.registered_date as "RegisteredDate",
  dd.result_date as "ResultDate", dd.result as "Result", dd.specimen_type as "SpecimenType", dd.test as "Test", dd.reason as "RejectionReason"
from dd
order by ${ssTextKey('dd.province')} collate "C" nulls first, ${ssTextKey('dd.district')} collate "C" nulls first,
  ${ssTextKey('dd.facility')} collate "C" nulls first,
  dd.province collate "C" nulls first, dd.district collate "C" nulls first, dd.facility collate "C" nulls first,
  ${ssTextKey('dd.lab_id')} collate "C" nulls first, dd.lab_id collate "C" nulls first,
  dd.collected_date collate "C" nulls first, dd.received_date collate "C" nulls first, dd.registered_date collate "C" nulls first,
  dd.result_date collate "C" nulls first, ${ssTextKey('dd.result')} collate "C" nulls first, dd.result collate "C" nulls first,
  dd.specimen_type collate "C" nulls first, dd.test collate "C" nulls first,
  ${ssTextKey('dd.reason')} collate "C" nulls first, dd.reason collate "C" nulls first`;
}

export const dbsMonitoringParams = () => [
  ...dateParams(true),
  { ...provinceParam('province', false), label: 'Province (blank for Lusaka, Southern, Eastern, Western and North-Western)' },
];

// ---- CD4 by area, age and sex (Task 19) -----------------------------------------------------------------------------------
//
// Replaces sp_get_CDC_CD4_data_month (no parameters in v1). One row per month, province, district, facility, age band and sex, with the
// number of CD4 absolute-count tests in each count range and the number of CD4% tests in each percentage range.
//
// Columns (v1 names and order, lines 6-72 and 137): Year, Month, MonthName, Province, District, Facility, AgeGroup, Sex,
// CD4 Absolute Count Range, CD4 Absolute Count Tests, CD4 Percent Range, CD4 Percent Tests.
//
// How v1 builds it. Two groups of rows, joined at the end (lines 137-140):
//   - the absolute rows (CTE a, lines 6-72): panel CD4, observation CD4, grouped by month, area, age band, sex and count range;
//   - the percent rows (CTE b, lines 73-136): panel CD4, observation CD4L, grouped the same way with the percentage range;
//   - a left join of a to b on year, month, province, district, facility, age band and sex, and `Province is not null` (line 140).
// Both read Requests joined to LabResults on RequestID and OBRSetID, which is lab_results.request_id = lab_requests.id in CE. Neither reads a
// report: v1 has no status or authorised-date test, so a request with no report, or a cancelled one, counts.
//
// Rules, with v1 lines:
//   Count range (lines 28-32)   the result text as a number, ROUNDED to a whole number (v1 casts to numeric with no scale; measured on the
//                               local SQL Server: '199.5' gives 200, '409.5' 410, '1590.5' 1591). Under 200 'Advanced HIV', 200 to 409
//                               'CD4 count below normal range', 410 to 1590 'CD4 count Within normal range', over 1590 'CD4 count Above normal
//                               range'; anything that is not a number 'Missing Absolute CD4 Count Result'.
//   Percent range (lines 94-97) the same number: under 31 'CD4 percentage below normal range', 31 to 60 'CD4 percentage Within normal range',
//                               over 60 'CD4 percentage above normal range', else 'Missing CD4% Result'.
//   Age band (lines 10-23)      0 '<01', 1-4 '01-04', 5-9 '05-09', ... 45-49, 50 and over '50+', anything else (no age, a negative age) 'Missing'.
//                               Not the dbo.Agegroup of the other reports: here 50 to 54 is '50+'.
//   Sex (lines 24-27)           the HL7 sex letter as stored; '' is 'Missing'.
//   Tests                       count(distinct RequestID), so a request with two results in one range counts once there, and a request with
//                               results in two ranges counts in each.
//   Province, District, Facility the mapped register row of the requesting facility (v1: the Facilities and HealthcareAreas dictionaries).
//
// Kept v1 quirks (spec ruling 1):
//   - The join of the two groups is many to many: each absolute row meets each percent row of the same cell, so a cell with 2 count ranges
//     and 3 percent ranges gives 6 rows, each carrying its own absolute count and its own percent count.
//   - A request with both a CD4 and a CD4L result counts in both groups.
//   - The join compares text with `=`, so a cell whose district or facility has no name never meets its percent row: the percent columns are
//     NULL there (null never equals null). A percent row with no absolute row in its cell is not shown at all.
//   - The three area names, the sex and the join compare as SQL Server compares text: case and trailing spaces do not count. Two register
//     rows spelled 'Chilenje Clinic' and 'CHILENJE CLINIC ' are one group; the row shows the smallest spelling of each name in byte order
//     (v1 shows whichever it meets first).
//   - The labels are v1's, with their capitals: 'CD4 count Within normal range', 'CD4 count Above normal range', 'CD4 percentage Within normal
//     range'.
//   - A request whose requesting facility is not in the register, or whose register row has no province, is dropped (line 140).
//   - The month is the LOCAL month of RegisteredDateTime: '2026-05-01T00:30:00+02:00' is in May, where its UTC date says April.
//
// Deviations:
//   - Spec ruling 3: v1's window is fixed, last calendar month (lines 41-44). `from` and `to` are required; a window of several months gives
//     one set of rows per month, and the months are not joined to each other.
//   - Spec ruling 2: v1 stops with a conversion error on a result that ISNUMERIC accepts and CAST to numeric rejects: '1,000', '1E5', '$5', '-',
//     '.' (measured on the local SQL Server). A report that stops has no output, so the port reads the number as the shared numberOfTextSql does
//     (thousands commas and an exponent are read; a currency sign, a lone '-' or '.' are not numbers). Results over 18 digits are read too.
//   - The number comes from the result TEXT (rpt, v1's LIMSRptResult), not from numeric_value, as v1 does. A censored value such as '< 20' is
//     therefore not a number, as in v1.
//
// CE gaps (spec ruling 7):
//   - CE cannot tell a missing sex from an empty one. v1 holds '' for a blank sex code and shows 'Missing'; a client with no sex, or a request
//     with no client row, is NULL in CE and shows 'Missing' too.
//   - Area names are the register's (facility_map), where v1 reads its dictionaries; they differ where Zambia's dictionary is spelled differently.
const CD4_AGE_BANDS = [['01-04', 1, 4], ['05-09', 5, 9], ['10-14', 10, 14], ['15-19', 15, 19], ['20-24', 20, 24], ['25-29', 25, 29],
  ['30-34', 30, 34], ['35-39', 35, 39], ['40-44', 40, 44], ['45-49', 45, 49]];
const cd4AgeGroupSql = (x) => `case when ${x} = 0 then '<01' ${CD4_AGE_BANDS.map(([name, lo, hi]) => `when ${x} between ${lo} and ${hi} then '${name}'`).join(' ')} when ${x} >= 50 then '50+' else 'Missing' end`;
const MONTH_NAMES_SQL = "array['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']";

export function cd4Sql() {
  const n = `round(${numberOfTextSql(rpt('l'))})`;
  const columns = [
    { e: 'res.year', as: 'Year', num: true }, { e: 'res.month', as: 'Month', num: true }, { e: 'res.month_name', as: 'MonthName' },
    { e: 'res.province', as: 'Province' }, { e: 'res.district', as: 'District' }, { e: 'res.facility', as: 'Facility' },
    { e: 'res.age_group', as: 'AgeGroup' }, { e: 'res.sex', as: 'Sex' },
    { e: 'res.abs_range', as: 'CD4 Absolute Count Range' }, { e: 'res.abs_tests', as: 'CD4 Absolute Count Tests', num: true },
    { e: 'res.pct_range', as: 'CD4 Percent Range' }, { e: 'res.pct_tests', as: 'CD4 Percent Tests', num: true },
  ];
  // The same cell in both groups: year, month, the three names and the sex compared as SQL Server compares text, and the age band.
  const cell = 's.yr, s.mo, s.kp, s.kd, s.kf, s.age_group, s.ks';
  const group = (name, obsWord, rangeColumn) => `${name} as (
  select s.yr, s.mo, s.kp, s.kd, s.kf, s.age_group, s.ks, s.${rangeColumn} as rng,
    min(s.province collate "C") as province, min(s.district collate "C") as district, min(s.facility collate "C") as facility,
    min(s.sex collate "C") as sex, count(distinct s.req_key) as cnt
  from src s
  where ${inListSql('s.obs', [obsWord])}
  group by ${cell}, s.${rangeColumn}
)`;
  const sexText = "case when coalesce(rtrim(p.sex), '') = '' then 'Missing' else p.sex end";
  return `with src as (
  select extract(year from ld.d)::int as yr, extract(month from ld.d)::int as mo,
    fmr.region as province, fmr.district as district, fmr.name as facility,
    ${foldSql('fmr.region')} as kp, ${foldSql('fmr.district')} as kd, ${foldSql('fmr.name')} as kf,
    ${cd4AgeGroupSql('lr.age_years')} as age_group,
    ${sexText} as sex, ${foldSql(sexText)} as ks,
    ${foldSql('lr.request_id')} as req_key, l.observation_code as obs,
    case when ${n} < 200 then 'Advanced HIV'
      when ${n} between 200 and 409 then 'CD4 count below normal range'
      when ${n} between 410 and 1590 then 'CD4 count Within normal range'
      when ${n} > 1590 then 'CD4 count Above normal range'
      else 'Missing Absolute CD4 Count Result' end as abs_range,
    case when ${n} < 31 then 'CD4 percentage below normal range'
      when ${n} between 31 and 60 then 'CD4 percentage Within normal range'
      when ${n} > 60 then 'CD4 percentage above normal range'
      else 'Missing CD4% Result' end as pct_range
  from lab_requests lr
  join lab_results l on l.request_id = lr.id
  left join patients p on p.id = lr.patient_id
  ${requesterJoin('lr', 'fmr')}
  cross join lateral (select ${localDate('lr.authored_at')} as d) ld
  where ${inListSql('lr.panel_code', ['CD4'])}
    and ${inListSql('l.observation_code', ['CD4', 'CD4L'])}
    and ${inRange('lr.authored_at')}
    and fmr.region is not null
),
${group('abs_g', 'CD4', 'abs_range')},
${group('pct_g', 'CD4L', 'pct_range')},
res as (
  select a.yr as year, a.mo as month, (${MONTH_NAMES_SQL})[a.mo] as month_name, a.province, a.district, a.facility, a.age_group, a.sex,
    a.rng as abs_range, a.cnt as abs_tests, b.rng as pct_range, b.cnt as pct_tests
  from abs_g a
  left join pct_g b on a.yr = b.yr and a.mo = b.mo and a.kp = b.kp and a.kd = b.kd and a.kf = b.kf and a.age_group = b.age_group and a.ks = b.ks
)
select ${selectItems(columns)}
from res
order by ${orderItems(columns)}`;
}

// ---- HPV results by month (Task 19) ---------------------------------------------------------------------------------------
//
// Replaces sp_get_HPV_data (no parameters in v1). One row per month, province, district, facility, testing lab and lab type, with the number
// of HPV tests, of positive tests, and of positive HPV16, HPV18, other and high-risk tests.
//
// Columns (v1 names and order, line 213): Province, District, Description (the facility name), LabName, LabType, Year, Month, Tests,
// Positives, HPV16, HPV18, HPVOT, HPVHR.
//
// How v1 builds it. Six CTEs over the same rows (lines 4-211), each grouped by province, district, facility, lab name, lab type, year and
// month, each counting distinct requests; the final select (line 213) takes Tests and left-joins the other five:
//   Tests      panel in HPV, POHPV, HPVGT; observation not STXT or SCOM; authorised in the window
//   Positives  the same and the result is one of POSITIVE, Positive, Positive*, REACTIVE (SQL Server ignores case, so 'positive' and
//              'POSITIVE' are the same text; 'Positive*' is its own text)
//   HPV16, HPV18, HPVOT, HPVHR   the same as Positives and the observation is that code
// A request counts in a CTE when any of its results meets the condition, so a request with HPV16 and HPV18 positive counts once in Positives
// and once in each type. The commented-out `sum(...)` lines in v1 (lines 14-20 and repeats) do nothing and are not ported.
//
// Rules, with v1 lines:
//   LabType (lines 12-14)  analyser code like 'GEN%' is 'GeneXpert'; empty (or spaces) is 'Unrecorded'; everything else, a missing code too,
//                          'Conventional'. The `like` ignores case; a leading space is not 'GEN'.
//   Year, Month            of AuthorisedDateTime (diagnostic_reports.issued), taken from the stamp's own text, which is the LOCAL date:
//                          '2026-05-01T00:30:00+02:00' is in May, where its UTC date says April.
//   Window (line 37)       AuthorisedDateTime between '20200101 00:00:01' and the end of last month at 23:59:59. A stamp at exactly midnight on
//                          the first day is OUT; the last day runs to 23:59:59. v1's fixed window becomes `from` (00:00:01) to `to` (23:59:59)
//                          on the local wall time of the stamp (the same method as the facility report of Tasks 7 and 8).
//   Province, District, Description   the mapped register row of the requesting facility; `Province is not null` (line 220): a facility
//                          that is not in the register, or has no province, is dropped.
//   LabName (line 11)      see CE gaps.
//
// Kept v1 quirks (spec ruling 1):
//   - THE ROWS MULTIPLY. The final joins (lines 215-219) match on province, district, facility, lab name, year and month, but NOT on lab type.
//     A test row of one lab type therefore meets the Positives, HPV16, HPV18, HPVOT and HPVHR rows of EVERY lab type of the same facility, lab
//     and month, and the output holds one row per combination. Where a facility's lab has both GeneXpert and Conventional tests in a month,
//     each Tests row appears several times, with the positive counts of the other lab type. Where no lab type has positives, there is no
//     multiplication. (One line to fix: add t.LabType = p.LabType and so on to the five joins.)
//   - The joins use `=` on text, so a row whose district, facility name or lab has no value never meets its positives: Positives, HPV16, HPV18,
//     HPVOT and HPVHR are 0 there, whatever the data holds (null never equals null).
//   - No status test: a report of any status with an authorised date counts; a request with no report has no authorised date and is out.
//   - 'Tests' counts any non-comment result, including observations that are none of the four types.
//   - Text compares ignore case and trailing spaces: the panel and observation lists, the result list, and the grouping of the three area
//     names and the lab. Two register rows spelled 'Chilenje Clinic' and 'CHILENJE CLINIC ' are one group; the row shows the smallest
//     spelling of each name in byte order (v1 shows whichever it meets first).
//   - `NOT IN ('STXT', 'SCOM')` drops a result with no observation code (unknown, not true).
//
// Deviations:
//   - Spec ruling 2 (controller ruling): the HPVOT join (line 218) compares t.Month = hot.Year. A month never equals a year, so v1's HPVOT is
//     always 0. The port joins t.Month = hot.Month, like the other four.
//   - Spec ruling 3: the window is `from` and `to`, required (v1: 2020-01-01 to the end of last month).
//   - A stamp with a fraction of a second is cut to whole seconds (localTs): 23:59:59.500 on the last day counts as in, where v1's datetime
//     drops it. DISA stamps carry no fraction.
//
// CE gaps (spec ruling 7, 8):
//   - v1 gets LabName from its Laboratories dictionary, keyed on the testing lab code. CE has no dictionary (ruling 8): a report has a name
//     (the report's display, else the register name of the mapped code, else the code). The rows are grouped and joined on the testing lab
//     CODE (case and trailing spaces ignored), and the row shows ONE name per code, the same on every row of that code: chosen from the names
//     of all the code's reports in the window (any requesting facility), a name that is not just the code beats the bare code, then the
//     smallest in byte order. So the answer is total and does not depend on row order or on the facility. This is the ruling of Task 16.
//     Two codes that share a name in Zambia's dictionary are two groups here (v1 groups on the name).
//   - A report with no testing code (or spaces only) has a NULL LabName, as v1's join finds no lab for a NULL code, whatever the report's
//     display says. Such rows form their own group and meet no positives.
//   - In v1 a testing code that is missing from the Laboratories dictionary also has a NULL LabName, so its rows never join their positives and
//     all five measures are 0. CE names every code (ruling 8), so those rows get their positives.
const HPV_PANELS = ['HPV', 'POHPV', 'HPVGT'];
const HPV_POSITIVE = ['POSITIVE', 'Positive', 'Positive*', 'REACTIVE'];

export function hpvSql() {
  const stamp = localTs('dr.issued');
  const columns = [
    { e: 'res.province', as: 'Province' }, { e: 'res.district', as: 'District' }, { e: 'res.description', as: 'Description' },
    { e: 'res.lab_name', as: 'LabName' }, { e: 'res.lab_type', as: 'LabType' },
    { e: 'res.year', as: 'Year', num: true }, { e: 'res.month', as: 'Month', num: true }, { e: 'res.tests', as: 'Tests', num: true },
    { e: 'res.positives', as: 'Positives', num: true }, { e: 'res.hpv16', as: 'HPV16', num: true }, { e: 'res.hpv18', as: 'HPV18', num: true },
    { e: 'res.hpvot', as: 'HPVOT', num: true }, { e: 'res.hpvhr', as: 'HPVHR', num: true },
  ];
  const positive = inListSql('s.result', HPV_POSITIVE);
  const measure = (name, cond) => `${name} as (
  select s.kp, s.kd, s.kf, s.lab_key, s.yr, s.mo, s.lab_type, count(distinct s.req_key) as cnt
  from src s
  where ${cond}
  group by s.kp, s.kd, s.kf, s.lab_key, s.yr, s.mo, s.lab_type
)`;
  const joinOn = (a) => `t.kp = ${a}.kp and t.kd = ${a}.kd and t.kf = ${a}.kf and t.lab_key = ${a}.lab_key and t.yr = ${a}.yr and t.mo = ${a}.mo`;
  return `with src as (
  select ${foldSql('lr.request_id')} as req_key,
    fmr.region as province, fmr.district as district, fmr.name as description,
    ${foldSql('fmr.region')} as kp, ${foldSql('fmr.district')} as kd, ${foldSql('fmr.name')} as kf,
    ${foldSql("case when rtrim(dr.performer) = '' then null else dr.performer end")} as lab_key,
    ${labNameSql('dr')} as report_name,
    case when lr.analyzer_code ilike 'GEN%' then 'GeneXpert' when rtrim(lr.analyzer_code) = '' then 'Unrecorded' else 'Conventional' end as lab_type,
    extract(year from ld.d)::int as yr, extract(month from ld.d)::int as mo,
    l.observation_code as obs, ${rpt('l')} as result
  from lab_requests lr
  join lab_results l on l.request_id = lr.id
  join diagnostic_reports dr on dr.based_on_id = lr.id
  ${requesterJoin('lr', 'fmr', 'left join')}
  cross join lateral (select ${localDate('dr.issued')} as d) ld
  where ${inListSql('lr.panel_code', HPV_PANELS)}
    and not ${inListSql('l.observation_code', ['STXT', 'SCOM'])}
    and ${stamp} >= ({{param.from}})::date + time '00:00:01'
    and ${stamp} <= ({{param.to}})::date + time '23:59:59'
),
names as (
  select s.lab_key, (array_agg(s.report_name order by ${foldSql('s.report_name')} = s.lab_key, s.report_name collate "C"))[1] as lab_name
  from src s
  where s.lab_key is not null
  group by s.lab_key
),
tests as (
  select s.kp, s.kd, s.kf, s.lab_key, s.lab_type, s.yr, s.mo,
    min(s.province collate "C") as province, min(s.district collate "C") as district, min(s.description collate "C") as description,
    min(nm.lab_name) as lab_name, count(distinct s.req_key) as cnt
  from src s
  left join names nm on nm.lab_key = s.lab_key
  group by s.kp, s.kd, s.kf, s.lab_key, s.lab_type, s.yr, s.mo
),
${measure('positives', positive)},
${measure('hpv16', `${inListSql('s.obs', ['HPV16'])} and ${positive}`)},
${measure('hpv18', `${inListSql('s.obs', ['HPV18'])} and ${positive}`)},
${measure('hpvot', `${inListSql('s.obs', ['HPVOT'])} and ${positive}`)},
${measure('hpvhr', `${inListSql('s.obs', ['HPVHR'])} and ${positive}`)},
res as (
  select t.province, t.district, t.description, t.lab_name, t.lab_type, t.yr as year, t.mo as month, t.cnt as tests,
    coalesce(p.cnt, 0) as positives, coalesce(h16.cnt, 0) as hpv16, coalesce(h18.cnt, 0) as hpv18, coalesce(hot.cnt, 0) as hpvot,
    coalesce(hr.cnt, 0) as hpvhr
  from tests t
  left join positives p on ${joinOn('p')}
  left join hpv16 h16 on ${joinOn('h16')}
  left join hpv18 h18 on ${joinOn('h18')}
  left join hpvot hot on ${joinOn('hot')}
  left join hpvhr hr on ${joinOn('hr')}
  where t.province is not null
)
select ${selectItems(columns)}
from res
order by ${orderItems(columns)}`;
}

export function queries() {
  return [
    { name: 'Recency tests', sql: recencyTestsSql(), params: windowParams() },
    { name: 'Recency surveillance counts', sql: recencySurveillanceSql(), params: windowParams() },
    { name: 'Recency tests with client names', sql: recencyTestsWithClientNamesSql(), params: windowParams() },
    { name: 'DBS monitoring (VL and EID)', sql: dbsMonitoringSql(), params: dbsMonitoringParams() },
    { name: 'CD4 by area, age and sex', sql: cd4Sql(), params: windowParams() },
    { name: 'HPV results by month', sql: hpvSql(), params: windowParams() },
  ];
}

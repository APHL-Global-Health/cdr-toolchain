// Custom queries for the covid reports. Each task adds { name, sql, params } entries to the list.

import { foldSql, inListSql, rpt } from '../../vl-reports-mz/vl-queries.mjs';
import { dateParams, genderFmiuSql, inRange, likeVarcharSql, localDate, localTs, requestAttrSql, requesterJoin, ssTextKey } from '../zm-sql.mjs';

// ---- The COVID-19 counts (Task 22) -----------------------------------------------------------------------------------------------
//
// Three queries replace four v1 procedures:
//   COVID-19 by testing lab        sp_COV2_LabStats (v1 file StoredProcedure__dbo_sp_COV2_LabStats.sql)
//   COVID-19 by source facility    sp_COV2_SourceStats, with sp_COV2_PSources and sp_COV2_TSources folded in as the `show` parameter
//   COVID-19 positive patients     sp_COV2_PListing
// "LabStats", "SourceStats", "PSources", "TSources" and "PListing" below mean the files StoredProcedure__dbo_sp_COV2_<name>.sql.
//
// The four counts (LabStats lines 21-261, SourceStats lines 21-256). v1 builds four CTEs, reg, Tested, Authorised and pos, each grouped by
// (Laboratory, Lab Description, RequestingFacilityCode, Facility, District, Province) with count(distinct RequestID), then left-joins the
// other three onto reg. covidCountsCte builds the same table in one pass over the requests, and both queries read it:
//   Registered   panel in the list and RegisteredDateTime in the window (LabStats line 54)
//                -> lab_requests.authored_at
//   Tested       panel, observation code in COV2, COV68, CO751, CO752, CVGXN, AnalysisDateTime in the window (lines 113-115)
//                -> lab_requests.analysis_at, and a result row with one of the codes
//   Authorised   as Tested, with HL7ResultStatusCode = 'F' and AuthorisedDateTime in the window (lines 175-178)
//                -> diagnostic_reports.status = 'final' and diagnostic_reports.issued
//   Positive     as Authorised, with LIMSRptResult = 'SARs-Cov-2 Genes Detected' on the same result row (line 239)
// The counts are of distinct RequestID, so a lab number with two request rows counts once in a group. A lab number can sit in two groups
// (two facility codes, two labs); each group counts it, and LabStats adds the groups up, as v1 does.
//
// Windows (LabStats lines 54, 115, 178; the same in SourceStats). The three stamps are datetimes and @StartDate and @EndDate are dates, so
// `between` runs from the start date at 00:00:00 up to and including the end date at 00:00:00. The end day is out apart from its first
// instant, and a one-day window holds only what happened at exactly midnight (spec ruling 1, kept; the same decision as Tasks 7 and 8). The
// time is the stamp's own local wall time (localTs: offset and fraction dropped). A stamp that is missing or has no full date is outside.
//
// The join (LabStats lines 262-271). The other three tables attach to reg on Laboratory, Lab Description, RequestingFacilityCode and
// Facility. Facility is the dictionary description, and `NULL = NULL` is not true, so:
//   - A request from a facility the dictionary does not know has Facility NULL. It counts as Registered and never as Tested, Authorised or
//     Positive. CE: an unmapped requester (no facility_map row with a register id) has a NULL facility, the same.
//   - Tested, Authorised and Positive attach only to a group that also has a registration in the window. A group with tests and no
//     registration in the window is dropped, tests and all. covidCountsCte keeps only groups with Registered >= 1, and the three other
//     counts are NULL (not 0) where nothing matched, so a facility with no matching rows is told apart from one with a count.
//   - Laboratory is part of the key. A test at lab ZTV never attaches to a registration at lab ZTT, though both read TDRC.
// The join is on the facility NAME, not on a code. CE has the mapped register row, so the name is the register name (fmr.name), and
// province and district are the register's region and district. Names compare the way SQL Server compares text (case and trailing spaces
// ignored), so 'Choma General Hospital' and 'CHOMA GENERAL HOSPITAL ' are one facility, in the join and in SourceStats' last GROUP BY
// (which merges codes that share a name, as v1 does). A merged group shows one spelling of each name: the smallest in byte order, so the
// spelling does not depend on row order.
//
// Lab Description (LabStats lines 27-39, repeated in each CTE): a fixed CASE on TestingFacilityCode. ZU_ -> UTH, ZTT and ZTV -> TDRC,
// ZSP, ZAP, ZL_ (Livingstone TH), ZBP, ZMP, ZML, ZKS, ZCH to a name, any other code as it is. `like 'ZU_'` is SQL Server's varchar LIKE
// (likeVarcharSql: 'ZUA' and 'ZU ' match, 'ZU' does not). A blank code gives a blank description and v1 drops it (`len(...) > 0`, line
// 273); CE's testing code is the report's performer, so a request with no report, or a report with no performer, is dropped the same way.
// Lab Description is v1's column and v1's parameter, so it stays this CASE and is not replaced by labNameSql (spec ruling 8): ZUA and ZUB
// are one row, UTH. Lab codes that pass through show the smallest spelling of the group (the group ignores case and trailing spaces).
//
// Panels and codes compare the way SQL Server does (inListSql: case and trailing spaces ignored).
//
// CE facts and gaps (spec ruling 7):
//   - Laboratory is `case TestingFacilityCode when '' then ReceivingFacilityCode ...`. A row with a blank testing code is dropped whatever
//     the receiving code, so CE not carrying ReceivingFacilityCode changes no row.
//   - The testing lab is on the report (diagnostic_reports.performer). cdr pushes a DiagnosticReport for every OBR, resulted or not
//     (fhir-transform.ts:306-339, obr-sets.ts:52-54, v2-transform.ts:768-770), and writes performer whenever testing_facility_code is set
//     (fhir-transform.ts:326-337). That value is buildLabConcept(site) ?? facilityConcept (v2-transform.ts:401), which is the configured
//     OPENLDR_LAB_CODE (site-config.ts:39-42, 64-74). So the real dependency is that each lab's push sets OPENLDR_LAB_CODE equal to its v1
//     TestingFacilityCode (ZUA, ZTT and so on). If it is unset, the 'lab' is the requesting clinic. A report with no performer, or a request
//     with no report, has no lab and is dropped, as a blank TestingFacilityCode is.
//   - A request with two reports at two labs counts under each lab.
const COVID_OBSERVATIONS = ['COV2', 'COV68', 'CO751', 'CO752', 'CVGXN'];
const COVID_POSITIVE = 'SARs-Cov-2 Genes Detected';

// v1's Lab Description for a testing code `c`. A NULL or blank code gives itself and is dropped by the caller.
const labDescSql = (c) => `case
      when ${likeVarcharSql(c, 'ZU', 1)} then 'UTH'
      when ${inListSql(c, ['ZTT', 'ZTV'])} then 'TDRC'
      when ${inListSql(c, ['ZSP'])} then 'Solwezi General'
      when ${inListSql(c, ['ZAP'])} then 'Arthur Davison'
      when ${likeVarcharSql(c, 'ZL', 1)} then 'Livingstone TH'
      when ${inListSql(c, ['ZBP'])} then 'Kabwe General'
      when ${inListSql(c, ['ZMP'])} then 'Lewanika General'
      when ${inListSql(c, ['ZML'])} then 'Mansa General'
      when ${inListSql(c, ['ZKS'])} then 'Kasama General'
      when ${inListSql(c, ['ZCH'])} then 'CHAZ Complex Lab'
      else ${c}
    end`;

// `stamp` between the start date at 00:00:00 and the end date at 00:00:00 plus `extraDays` days, on the local wall time. False for a
// stamp that is missing or has no full date. The parameters are YYYY-MM-DD.
const inWindow = (stamp, extraDays = 0) => `coalesce(${localTs(stamp)} >= ({{param.from}})::date::timestamp
      and ${localTs(stamp)} <= ({{param.to}})::date::timestamp + interval '${extraDays} day', false)`;

// Text order of a display column: SQL Server's word order first, then byte order; a missing value first. A total order needs both.
const textOrder = (e) => `${ssTextKey(e)} collate "C" nulls first, ${e} collate "C" nulls first`;

// The shared base of COVID-19 by testing lab and COVID-19 by source facility. Returns two CTE items, `<name>_src` and `<name>`.
// `<name>` has one row per v1 group (testing code, description, requesting code, facility, district, province; the last four ignore
// case and trailing spaces) with these columns:
//   lab_desc, province, district, facility    the group's display spelling (smallest in byte order)
//   registered                                 distinct lab numbers registered in the window; always 1 or more
//   tested, authorised, positive               distinct lab numbers; NULL when there are none, and always NULL for a NULL facility
// `panels` is the panel list. `onlyLab` keeps the groups whose Lab Description is the `laboratory` parameter.
export function covidCountsCte(name, { panels, onlyLab = false }) {
  const withCode = (extra = '') => `exists (select 1 from lab_results l where l.request_id = lr.id and ${inListSql('l.observation_code', COVID_OBSERVATIONS)}${extra})`;
  const authorised = `${foldSql('dr.status')} = 'final' and ${inWindow('dr.issued')}`;
  return `${name}_src as (
  select ${foldSql('lr.request_id')} as req_key, dr.performer as lab_code, ${labDescSql('dr.performer')} as lab_desc,
    lr.requester_code as req_code, fmr.region as province, fmr.district as district, fmr.name as facility,
    ${inWindow('lr.authored_at')} as is_registered,
    (${inWindow('lr.analysis_at')} and ${withCode()}) as is_tested,
    (${authorised} and ${withCode()}) as is_authorised,
    (${authorised} and ${withCode(` and ${inListSql(rpt('l'), [COVID_POSITIVE])}`)}) as is_positive
  from lab_requests lr
  left join diagnostic_reports dr on dr.based_on_id = lr.id
  ${requesterJoin('lr', 'fmr', 'left join')}
  where ${inListSql('lr.panel_code', panels)}
    and rtrim(dr.performer) <> ''
),
${name} as (
  select min(s.lab_desc collate "C") as lab_desc, min(s.province collate "C") as province, min(s.district collate "C") as district,
    min(s.facility collate "C") as facility,
    count(distinct s.req_key) filter (where s.is_registered) as registered,
    case when min(s.facility) is not null then nullif(count(distinct s.req_key) filter (where s.is_tested), 0) end as tested,
    case when min(s.facility) is not null then nullif(count(distinct s.req_key) filter (where s.is_authorised), 0) end as authorised,
    case when min(s.facility) is not null then nullif(count(distinct s.req_key) filter (where s.is_positive), 0) end as positive
  from ${name}_src s
  ${onlyLab ? `where ${foldSql('s.lab_desc')} = ${foldSql('{{param.laboratory}}')}` : ''}
  group by ${foldSql('s.lab_code')}, ${foldSql('s.lab_desc')}, ${foldSql('s.req_code')}, ${foldSql('s.facility')}, ${foldSql('s.district')}, ${foldSql('s.province')}
  having count(distinct s.req_key) filter (where s.is_registered) > 0
)`;
}

// ---- COVID-19 by testing lab (sp_COV2_LabStats) ----
//
// Params: from, to (required, YYYY-MM-DD, spec ruling 3). One row per Lab Description: Lab Description, Registered, Tested,
// Tested and Authorised, Positive. Panels COVID, COVII and COVIS. See the notes above for the counts, the windows, the join and the
// Lab Description.
//
// Kept v1 quirks (spec ruling 1):
//   - The final select is `sum(...)` with no coalesce (line 262), so Tested, Tested and Authorised and Positive are NULL for a lab whose
//     groups have none (SourceStats coalesces them to 0; this one does not).
//   - The window ends at midnight of the end date (see above).
//   - Facility NULL and no-registration groups lose their tests (see above).
// Row order: v1 has no ORDER BY, and CE pages with LIMIT and OFFSET, so the rows are ordered by every column (text in SQL Server's word
// order, a missing number first).
export function labStatsSql() {
  return `with ${covidCountsCte('cv', { panels: ['COVID', 'COVII', 'COVIS'] })},
res as (
  select min(c.lab_desc collate "C") as lab_desc, sum(c.registered)::bigint as registered, sum(c.tested)::bigint as tested,
    sum(c.authorised)::bigint as authorised, sum(c.positive)::bigint as positive
  from cv c
  group by ${foldSql('c.lab_desc')}
)
select res.lab_desc as "Lab Description", res.registered as "Registered", res.tested as "Tested", res.authorised as "Tested and Authorised",
  res.positive as "Positive"
from res
order by ${textOrder('res.lab_desc')}, res.registered, res.tested nulls first, res.authorised nulls first, res.positive nulls first`;
}

// ---- COVID-19 by source facility (sp_COV2_SourceStats, with sp_COV2_PSources and sp_COV2_TSources) ----
//
// Params: from, to, laboratory (required), show (optional select). One row per province, district and facility with Registered, Tested,
// Tested and Authorised and Positive for one testing lab. Panel COVID only (SourceStats line 53). Province, District and Facility are the
// mapped register row; a request whose facility is not mapped is one NULL row (v1: Facility NULL), and all such requests merge into it.
//
// `laboratory` (SourceStats line 14, 268) is a Lab Description, as COVID-19 by testing lab shows it ('UTH', 'TDRC', 'Solwezi General', or an
// unmapped code such as 'ZNP'), not a lab code: ZUA is found by 'UTH', and the text 'ZUA' finds nothing. It is a text box because any
// code that is not in the CASE is a valid description, so a fixed list would leave those labs out. It is compared the way SQL Server
// compares text. Required, as in v1; blank finds nothing. Ruling 4 says a lab parameter is matched on the lab code; this one cannot be,
// because v1's parameter is the description, and ruling 1 wins.
//
// `show` folds the three v1 procedures into one (the joins differ, the rest of the text is the same; PSources vs SourceStats at line 274
// and TSources vs PSources at line 268):
//   all (or blank)  every facility with a registration in the window     sp_COV2_SourceStats (left joins)
//   positive        only facilities with a Positive count                 sp_COV2_PSources (`inner join pos`)
//   tested          only facilities with a Tested count and a Positive    sp_COV2_TSources (`inner join tested` and `inner join pos`)
// 'tested' is therefore not "all that were tested": TSources still inner-joins pos. A facility with positives authorised in the window and
// no tests analysed in the window is in 'positive' and out of 'tested'. PSources and TSources write ZTT and ZTV as two WHENs where
// SourceStats writes IN (...); the text is the same TDRC.
//
// Kept v1 quirks (spec ruling 1): the window and join notes above; `coalesce(sum(...), 0)` on every count (line 258), so a facility
// with no tests shows 0, not NULL; two facility codes with one name are one row (the last GROUP BY, line 270, is on the names).
// Row order: by every column, as the first query.
export function sourceStatsSql() {
  return `with ${covidCountsCte('cv', { panels: ['COVID'], onlyLab: true })},
res as (
  select min(c.province collate "C") as province, min(c.district collate "C") as district, min(c.facility collate "C") as facility,
    coalesce(sum(c.registered), 0)::bigint as registered, coalesce(sum(c.tested), 0)::bigint as tested,
    coalesce(sum(c.authorised), 0)::bigint as authorised, coalesce(sum(c.positive), 0)::bigint as positive
  from cv c
  where {{param.show}} not in ('tested', 'positive')
    or ({{param.show}} = 'positive' and c.positive is not null)
    or ({{param.show}} = 'tested' and c.positive is not null and c.tested is not null)
  group by ${foldSql('c.province')}, ${foldSql('c.district')}, ${foldSql('c.facility')}
)
select res.province as "Province", res.district as "District", res.facility as "Facility", res.registered as "Registered",
  res.tested as "Tested", res.authorised as "Tested and Authorised", res.positive as "Positive"
from res
order by ${textOrder('res.province')}, ${textOrder('res.district')}, ${textOrder('res.facility')},
  res.registered, res.tested, res.authorised, res.positive`;
}

const laboratoryParam = () => ({
  id: 'laboratory',
  label: 'Laboratory (as named in COVID-19 by testing lab, for example UTH or TDRC; an unlisted lab is its code)',
  type: 'text',
  required: true,
});
export const sourceStatsParams = () => [
  ...dateParams(true),
  laboratoryParam(),
  {
    id: 'show', label: 'Show facilities: all, positive (with positives, v1 PSources) or tested (tested and positive, v1 TSources); blank is all', type: 'select', required: false,
    optionsSql: "select 'all' as show union all select 'tested' union all select 'positive'",
  },
];

// ---- COVID-19 positive patients (sp_COV2_PListing) ----
//
// Params: from, to, laboratory, facility (all required). One row per positive result row of a final COVID report authorised in the
// window, at one lab and one facility: Province, District, Facility, Epid, Lab Number, Disalab Number, FIRSTNAME, SURNAME,
// Sample Collection Date, Tested Date, Results Review Date, Result, Lab Description. Panel COVID only (line 71).
//
// What v1 does:
//   Window     `@EndDate = dateadd(dd, 1, @EndDate)` (line 22) and `AuthorisedDateTime between @StartDate and @EndDate` (line 74): from the
//              start date at 00:00:00 up to and including the day AFTER the end date at 00:00:00. So the end day is in, and so is the first
//              instant of the next day. Local wall time of diagnostic_reports.issued.
//   Filter     observation code in COV2, COV68, CO751, CO752, CVGXN; HL7ResultStatusCode 'F' (status final); LIMSRptResult =
//              'SARs-Cov-2 Genes Detected' (lines 71-75); Lab Description = @TestingLab and Facility = @Facility (lines 83-84).
//   Columns    Epid is Patients.REFNO (the reference-numbers request attribute); Disalab Number is RequestID; the names are the patient's;
//              Sample Collection Date is SpecimenDateTime (diagnostic_reports.effective), Tested Date AnalysisDateTime
//              (lab_requests.analysis_at), Results Review Date AuthorisedDateTime (diagnostic_reports.issued). All stamps are CE's text.
//   Rows       one per positive result row, per report and per patient row: a request with two positive result rows shows twice.
//
// Kept v1 quirks (spec ruling 1):
//   - Result (lines 54-58) is `case LIMSRptResult when 'SARs-Cov-2 Genes Detected' then 'Positive' when 'SARs-Cov-2 Genes Detected' then
//     'Negative' when 'Inconclusive' ...`. The filter keeps only the first text, the second WHEN repeats it and can never fire, and
//     'Inconclusive' is filtered out before the CASE. So the column is 'Positive' on every row, and the port writes the constant.
//   - Facility is matched by name (case and trailing spaces ignored), as the facility parameter of Task 8. Two register entries with one
//     name both show, each with its own spelling.
//   - A request with no Patients row is kept (left join), with empty names.
//   - v1's @TestingLab is varchar(30) and @Facility varchar(50): a longer text is cut in v1. The port compares the whole text.
//   - No lab filter on a blank code (the CASE would give a blank description that matches nothing but a blank parameter): a blank testing
//     code is dropped, as the counts do.
//
// `laboratory` is a Lab Description, as in COVID-19 by source facility. `facility` is the register name (fmr.name), a text box, required.
//
// CE gaps (spec ruling 7): Lab Number is v1 Patients.HOSPID. CE's request-attribute code system has reference-numbers and unique-id and no
// hospital number, so the column is NULL (the same as the HOSPID rule of the ART number). It holds data once a code for it exists.
// PII: names and the reference number (spec ruling 12). A request with two final reports in the window shows once per report, where v1
// has one request row.
// Row order: by every column.
export function positiveListSql() {
  return `with src as (
  select fmr.region as province, fmr.district as district, fmr.name as facility,
    ${requestAttrSql('lr.id', 'reference-numbers')} as epid, lr.request_id as lab_id, p.firstname as firstname, p.surname as surname,
    dr.effective as collected, lr.analysis_at as tested_date, dr.issued as reviewed, ${labDescSql('dr.performer')} as lab_desc
  from lab_requests lr
  join diagnostic_reports dr on dr.based_on_id = lr.id
  join lab_results l on l.request_id = lr.id
  left join patients p on p.id = lr.patient_id
  ${requesterJoin('lr', 'fmr', 'left join')}
  where ${inListSql('lr.panel_code', ['COVID'])}
    and ${inListSql('l.observation_code', COVID_OBSERVATIONS)}
    and ${foldSql('dr.status')} = 'final'
    and ${inWindow('dr.issued', 1)}
    and ${inListSql(rpt('l'), [COVID_POSITIVE])}
    and rtrim(dr.performer) <> ''
)
select s.province as "Province", s.district as "District", s.facility as "Facility", s.epid as "Epid", null::text as "Lab Number",
  s.lab_id as "Disalab Number", s.firstname as "FIRSTNAME", s.surname as "SURNAME", s.collected as "Sample Collection Date",
  s.tested_date as "Tested Date", s.reviewed as "Results Review Date", 'Positive' as "Result", s.lab_desc as "Lab Description"
from src s
where ${foldSql('s.lab_desc')} = ${foldSql('{{param.laboratory}}')}
  and ${foldSql('s.facility')} = ${foldSql('{{param.facility}}')}
order by ${textOrder('s.province')}, ${textOrder('s.district')}, ${textOrder('s.facility')}, ${textOrder('s.epid')},
  ${textOrder('s.lab_id')}, ${textOrder('s.firstname')}, ${textOrder('s.surname')}, s.collected collate "C" nulls first,
  s.tested_date collate "C" nulls first, s.reviewed collate "C" nulls first, ${textOrder('s.lab_desc')}`;
}

export const positiveListParams = () => [
  ...dateParams(true),
  laboratoryParam(),
  { id: 'facility', label: 'Facility (name as in the register)', type: 'text', required: true },
];

// ---- COVID-19 daily line list (Task 23) -------------------------------------------------------------------------------------------
//
// Replaces sp_cov_getDayLineList (the target) with sp_cov_getDayLineList_Levy merged in. "Target" lines below are lines of
// StoredProcedure__dbo_sp_cov_getDayLineList.sql, "Levy" lines of the _Levy file. A diff of the two shows four differences:
//   1. Levy adds `RequestingFacilityCode in ('LVCVD', 'LPMGH')` (Levy line 214).
//   2. Levy windows on AnalysisDateTime and orders by it (Levy lines 215-217); the target uses AuthorisedDateTime (target lines 221-222).
//   3. Levy joins Patients with a LEFT join (Levy line 199); the target uses an INNER join (target line 205).
//   4. Levy's Result map lacks 'IgM/IgG Negative', 'IgM Negative' (target lines 112-113) and 'INVAL', 'Invalid' (target lines 122-123).
// The four belong to one report, so the `version` parameter switches all four together: 'standard' (also when blank) is the target, 'Levy'
// is the Levy copy. The `facility` parameter is a requesting facility CODE (lr.requester_code, v1 RequestingFacilityCode). Blank, standard
// lists every facility (the target has no facility filter) and Levy lists v1's two constants LVCVD and LPMGH. A code given replaces both: it
// narrows standard to that facility, and Levy lists that facility instead of its two (spec ruling 1: output parity first; a given value
// replaces the v1 constant, as in the province parameter of DBS monitoring). Codes compare ignoring case and trailing blanks. A facility of
// only blanks counts as blank (rtrim); the shared areaFilter compares the raw text to '', so this departs from it.
//
// Params: from, to (required), version (select), facility (text). One row per distinct combination of the 26 columns below, newest
// first: Epid, Lab Number, Disalab Number, Patient Name, Contact Number, Gender, AgeinYears, Collected Date, Registered Date, Province,
// District, Location, Tested Date, Date Result Reported, Result, Instrument, Testing Laboratory, TestType, Authorization Status, Sore Throat,
// Fever, Shortness of Breath, Body Pains, Other(Specified), Hospitalised, Outcome.
//
// The window (spec ruling 3). v1 ran yesterday 04:00 to today 04:00 (`dateadd(hour, 4, datediff(d, 0, getdate() - 1))` to the same for
// today, target line 221). `from` and `to` take that 04:00 as text, YYYY-MM-DDTHH:MM (a space for the T, and seconds, also work; a date alone is
// midnight). CE custom queries have three parameter types: text, select and daterange, and daterange only carries a date (custom-query-run.ts
// assertDate rejects a time), so a date and time is a text parameter. The text is checked against YYYY-MM-DD, then an optional T or space and
// HH:MM, then optional :SS; anything else raises an error that names the parameter and shows the value (the message is cast to a
// timestamp, so Postgres reports "invalid input syntax" with the message in it). Without the check, ::timestamp reads '01/06/2026 04:00' as
// 6 January, accepts 'yesterday', and drops the offset of '2026-06-01T04:00+05' silently. A blank value is refused by CE (required). A
// well-formed but impossible date such as 2026-02-30 is refused by Postgres' own range error. The stamp's own local wall time is compared (localTs: offset and fraction dropped,
// a date-only stamp is midnight, a partial stamp such as '2026-07' is outside). v1 `between` is inclusive at both ends and so is this. A
// DISA stamp has no fraction, so dropping it changes nothing.
//
// The rows (target lines 204-220). Requests joined to Patients (inner or left), LabResults (inner, on RequestID and OBRSetID, which is
// one lab_requests row here), the facility dictionary (left) and seven symptom CTEs (left, on RequestID alone). Filters: panel in COVID,
// COVII, COVAB, COVAG, COVRP and observation code in COV2, COV68, CVGXN, CO751, CO752, COVRP (lines 219-220), both ignoring case and trailing
// blanks. There is no HL7 status filter, so a preliminary report with an issued stamp is listed.
//
// Columns:
//   Epid                  Patients.REFNO: the request attribute reference-numbers (requestAttrSql). NULL when there is no patient row (Levy).
//   Lab Number            Patients.HOSPID. CE has no request-attribute code for it (checked in the code system), so the column is NULL
//                         (spec ruling 7: a CE gap).
//   Disalab Number        `p.requestid` (target line 89): the PATIENT row's RequestID, so it is NULL when there is no patient row (Levy).
//   Patient Name          concat(firstname, ' ', surname): a missing part leaves a blank, and no patient is one blank.
//   Contact Number        v1 takes mobile, else TELHOME, else TELWORK, each only when len() > 0 (lines 91-95). CE holds ONE phone on
//                         patients: cdr writes `Phone ?? Mobile` (v2-transform.ts:229, so DISA's Phone first, then Mobile), and DISA's work
//                         phone goes to patient_data and is not in the warehouse. So the column is that phone when it has text, else NULL.
//                         This is not v1's order (v1 prefers the mobile) and has no TELWORK: a CE gap (ruling 7), listed in the README.
//   Gender                the sex code (lines 96-101): F, M, U, I only; N, O and anything else give NULL. v1 reads Requests.HL7SexCode and
//                         CE keeps the sex on the patient, so a Levy row with no patient has no Gender (a CE gap).
//   AgeinYears            lab_requests.age_years.
//   Collected Date        SpecimenDateTime -> diagnostic_reports.effective. Registered Date -> lab_requests.authored_at.
//   Tested Date           AnalysisDateTime -> lab_requests.analysis_at. Date Result Reported -> diagnostic_reports.issued. All CE text.
//   Province, District, Location    the mapped register row (region, district, name); empty when the facility is not in the register.
//   Result                the CASE of lines 110-126 on LIMSRptResult (rpt()). No ELSE, so a text that is not listed gives NULL. The accent
//                         on the I of 'Inconclusive' (line 120, U+00CD) is v1's text and stays: the plain 'Inconclusive' gives NULL, as in v1.
//                         DATABASE NOTE (for the README): the fold lower() must lower-case the accented I, which needs a database whose
//                         LC_CTYPE is UTF-8 (for example en_US.utf8). In a C-locale database 'Ínconclusive' typed in capitals would not match.
//   Instrument            the CASE of lines 127-135 on LIMSAnalyzerCode (lr.analyzer_code); others NULL.
//   Testing Laboratory    the CASE of lines 136-189 on `case TestingFacilityCode when '' then ReceivingFacilityCode else TestingFacilityCode`.
//                         CE's testing code is the report's performer (see Task 22's cross-cutting note on OPENLDR_LAB_CODE). It has no
//                         ReceivingFacilityCode (ruling 7). A blank code matches no WHEN, so it gives NULL here, where v1 would try the receiving
//                         code. A request with no report has no performer and shows NULL. `like 'ZU_'` and `like 'ZL_'` are varchar LIKE (likeVarcharSql).
//                         This CASE is NOT the one of the counts: it has no ZCH, and the names are long ('University Teaching Hospital').
//   TestType              'Rapid' for panels COVAB, COVAG, COVRP, else 'PCR Based' (lines 190-193).
//   Authorization Status  'Reviewed' when AuthorisedDateTime is not null, else 'Pending Review' (lines 194-196). In the standard version the
//                         window already needs the stamp, so every row is Reviewed; in Levy a request that is not authorised shows Pending.
//   Sore Throat ... Outcome   one value per symptom CTE (below).
//
// The symptoms (lines 9-83). Seven CTEs read panel ADCOE and one observation code each: CSORT -> Sore Throat, CFERV -> Fever, CSHBR -> Shortness
// of Breath, CMYBO -> Body Pains, COTHE -> Other(Specified), CPTHO -> Hospitalised, COUT -> Outcome; the value is LIMSRptResult. The first CTE
// (cough, CCOUG, lines 9-18) is built and never joined or selected, so it changes nothing and the port leaves it out. The CTEs join on
// RequestID alone, so the ADCOE answers can sit on a different OBR row than the COVID result, and the lab number compares ignoring case and
// trailing blanks. Kept (ruling 1): several different answers to one question multiply the rows (two fevers and two sore throats make four
// rows), and a missing answer is a value of its own (NULL beside 'Yes' is two rows). Read from lab_results by observation code, as v1 reads
// LabResults, not from a form.
//
// SELECT DISTINCT (line 86). Kept: identical rows collapse, so two result rows that map to the same Result, or two equal answers, give one row.
// Under SQL Server's collation DISTINCT also treats texts that differ only in case or trailing blanks as one value, so the port groups on the
// folded text and shows the smallest spelling in byte order (v1 does not say which one it keeps).
//
// Order: newest first on Date Result Reported (standard) or Tested Date (Levy), a missing stamp last (SQL Server puts NULL last in DESC), then
// every column in byte order, a missing value first, so the order is total. v1 orders by that stamp alone; the rest only fixes ties.
//
// Patients is one row per request in v1 (HONEST NON-PROOF: Task 17 could not check it on Tanzania's data, which has no Patients table).
// PII: names, phone and Epid (spec ruling 12).
const LINE_PANELS = ['COVID', 'COVII', 'COVAB', 'COVAG', 'COVRP'];
const LINE_OBSERVATIONS = ['COV2', 'COV68', 'CVGXN', 'CO751', 'CO752', 'COVRP'];
const RAPID_PANELS = ['COVAB', 'COVAG', 'COVRP'];
const LEVY_FACILITIES = ['LVCVD', 'LPMGH'];
// Result map (target lines 110-126). The Levy file has the same map without the `_STANDARD` entries (target lines 112-113, 122-123).
const RESULT_NEGATIVE = ['SARS-Cov-2 Genes Not Detected', 'Negative'];
const RESULT_NEGATIVE_STANDARD = ['IgM/IgG Negative', 'IgM Negative'];
const RESULT_POSITIVE = ['SARS-Cov-2 Genes Detected', 'IgG Positive', 'IgM Positive', 'IgM/IgG Positive', 'Positive'];
// The first text below has an acute accent on the I (U+00CD), as in v1 line 120; the file keeps it as an escape.
const RESULT_RETEST = ['\u00cdnconclusive', 'No AFB seen.'];
const RESULT_RETEST_STANDARD = ['INVAL', 'Invalid'];
const SYMPTOMS = [
  ['sx_sore_throat', 'CSORT', 'sore_throat'], ['sx_fever', 'CFERV', 'fever'], ['sx_breath', 'CSHBR', 'breath'], ['sx_body', 'CMYBO', 'body_pains'],
  ['sx_other', 'COTHE', 'other'], ['sx_hosp', 'CPTHO', 'hospitalised'], ['sx_outcome', 'COUT', 'outcome'],
];
// [output name, key in the src and res CTEs, 'text' (grouped on the folded text) or 'plain' (grouped on the value)].
const LINE_OUT = [
  ['Epid', 'epid', 'text'], ['Lab Number', 'lab_number', 'text'], ['Disalab Number', 'disalab', 'text'], ['Patient Name', 'patient_name', 'text'],
  ['Contact Number', 'contact', 'text'], ['Gender', 'gender', 'plain'], ['AgeinYears', 'age', 'plain'], ['Collected Date', 'collected', 'plain'],
  ['Registered Date', 'registered', 'plain'], ['Province', 'province', 'text'], ['District', 'district', 'text'], ['Location', 'location', 'text'],
  ['Tested Date', 'tested', 'plain'], ['Date Result Reported', 'reported', 'plain'], ['Result', 'result', 'plain'], ['Instrument', 'instrument', 'plain'],
  ['Testing Laboratory', 'test_lab', 'plain'], ['TestType', 'test_type', 'plain'], ['Authorization Status', 'auth_status', 'plain'],
  ['Sore Throat', 'sore_throat', 'text'], ['Fever', 'fever', 'text'], ['Shortness of Breath', 'breath', 'text'], ['Body Pains', 'body_pains', 'text'],
  ['Other(Specified)', 'other', 'text'], ['Hospitalised', 'hospitalised', 'text'], ['Outcome', 'outcome', 'text'],
];

// One symptom CTE: the answers of one ADCOE observation code, keyed on the lab number the way SQL Server compares it.
const symptomCte = (name, code) => `${name} as (
  select ${foldSql('s.request_id')} as req_key, ${rpt('x')} as answer
  from lab_requests s
  join lab_results x on x.request_id = s.id
  where ${inListSql('s.panel_code', ['ADCOE'])} and ${inListSql('x.observation_code', [code])}
)`;

// The Result CASE on the result text `r`. The standard version adds the four texts that Levy's map lacks.
const lineResultSql = (r) => `case
      when ${inListSql(r, RESULT_NEGATIVE)} or (not w.is_levy and ${inListSql(r, RESULT_NEGATIVE_STANDARD)}) then 'Negative'
      when ${inListSql(r, RESULT_POSITIVE)} then 'Positive'
      when ${inListSql(r, RESULT_RETEST)} or (not w.is_levy and ${inListSql(r, RESULT_RETEST_STANDARD)}) then 'To be retested'
    end`;

// The Instrument CASE (target lines 127-135) on the analyser code `a`.
const instrumentSql = (a) => `case
      when ${inListSql(a, ['FRTP', 'FRTB'])} then 'AB7500'
      when ${inListSql(a, ['C6800'])} then 'C6800'
      when ${inListSql(a, ['GENEX', 'GENEB'])} then 'GeneXpert'
      when ${inListSql(a, ['PNTHR', 'PNTHB'])} then 'Hologic Panther'
    end`;

// The Testing Laboratory CASE (target lines 136-189) on the testing code `c` (NULL when blank). The WHENs keep v1's order.
const longLabSql = (c) => `case
      when ${likeVarcharSql(c, 'ZU', 1)} then 'University Teaching Hospital'
      when ${inListSql(c, ['ZAP'])} then 'Arthur Davison Childrens'' Hospital'
      when ${inListSql(c, ['ZSP'])} then 'Solwezi General Hospital'
      when ${inListSql(c, ['ZBP'])} then 'Kabwe General Hospital'
      when ${likeVarcharSql(c, 'ZL', 1)} then 'Livingstone Teaching Hospital'
      when ${inListSql(c, ['ZMP'])} then 'Lewanika General Hospital'
      when ${inListSql(c, ['ZKS'])} then 'Kasama General Hospital'
      when ${inListSql(c, ['ZML'])} then 'Mansa General Hospital'
      when ${inListSql(c, ['ZTV'])} then 'TDRC'
      when ${inListSql(c, ['ZTT'])} then 'TDRC'
    end`;

// A date-time parameter as a timestamp, or an error that names the parameter. The pattern is YYYY-MM-DD with an optional T or space and
// HH:MM, and optional :SS. The cast sits outside the CASE: a bad value turns into the message text, and casting the message fails with the
// message inside Postgres' error text. (A cast of the value inside the THEN branch would be folded at plan time and raise Postgres' own error first.)
const dateTimeParamSql = (id) => {
  const v = `{{param.${id}}}`;
  return `(case when ${v} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ][0-9]{2}:[0-9]{2}(:[0-9]{2})?)?$' then ${v}
      else '${id} must be YYYY-MM-DDTHH:MM, got ' || ${v} end)::timestamp`;
};

export function lineListSql() {
  const symptomJoins = SYMPTOMS.map(([name, , key]) => `left join ${name} ${key} on ${key}.req_key = ${foldSql('lr.request_id')}`).join('\n  ');
  const symptomColumns = SYMPTOMS.map(([, , key]) => `${key}.answer as ${key}`).join(',\n    ');
  const groupBy = LINE_OUT.map(([, key, kind]) => (kind === 'text' ? foldSql(`s.${key}`) : `s.${key}`)).join(', ');
  const picks = LINE_OUT.map(([, key, kind]) => (kind === 'text' ? `min(s.${key} collate "C") as ${key}` : `min(s.${key}) as ${key}`)).join(',\n    ');
  const orders = LINE_OUT.map(([, key]) => (key === 'age' ? 'r.age nulls first' : `r.${key} collate "C" nulls first`));
  return `with win as (
  select ${dateTimeParamSql('from')} as w_from, ${dateTimeParamSql('to')} as w_to, ${foldSql('{{param.version}}')} = 'levy' as is_levy
),
${SYMPTOMS.map(([name, code]) => symptomCte(name, code)).join(',\n')},
src as (
  select case when p.id is not null then ${requestAttrSql('lr.id', 'reference-numbers')} end as epid,
    null::text as lab_number,
    case when p.id is not null then lr.request_id end as disalab,
    concat(p.firstname, ' ', p.surname) as patient_name,
    case when length(rtrim(p.phone)) > 0 then p.phone end as contact,
    ${genderFmiuSql('p.sex')} as gender,
    lr.age_years as age,
    dr.effective as collected,
    lr.authored_at as registered,
    fmr.region as province, fmr.district as district, fmr.name as location,
    lr.analysis_at as tested,
    dr.issued as reported,
    ${lineResultSql('rr.val')} as result,
    ${instrumentSql('lr.analyzer_code')} as instrument,
    ${longLabSql('dr.performer')} as test_lab,
    case when ${inListSql('lr.panel_code', RAPID_PANELS)} then 'Rapid' else 'PCR Based' end as test_type,
    case when dr.issued is not null then 'Reviewed' else 'Pending Review' end as auth_status,
    ${symptomColumns}
  from win w
  cross join lab_requests lr
  left join patients p on p.id = lr.patient_id
  left join diagnostic_reports dr on dr.based_on_id = lr.id
  join lab_results l on l.request_id = lr.id
  ${requesterJoin('lr', 'fmr', 'left join')}
  cross join lateral (select ${rpt('l')} as val) rr
  ${symptomJoins}
  where ${inListSql('lr.panel_code', LINE_PANELS)}
    and ${inListSql('l.observation_code', LINE_OBSERVATIONS)}
    and (p.id is not null or w.is_levy)
    and ${localTs('case when w.is_levy then lr.analysis_at else dr.issued end')} between w.w_from and w.w_to
    and case when rtrim({{param.facility}}) = '' then (not w.is_levy or ${inListSql('lr.requester_code', LEVY_FACILITIES)})
      else ${foldSql('lr.requester_code')} = ${foldSql('{{param.facility}}')} end
),
res as (
  select ${picks}
  from src s
  group by ${groupBy}
)
select ${LINE_OUT.map(([name, key]) => `r.${key} as "${name}"`).join(', ')}
from res r
cross join win w
order by ${localTs('case when w.is_levy then r.tested else r.reported end')} desc nulls last,
  ${orders.join(',\n  ')}`;
}

export const lineListParams = () => [
  { id: 'from', label: 'From, date and time (YYYY-MM-DDTHH:MM, local time; v1 ran from yesterday 04:00)', type: 'text', required: true },
  { id: 'to', label: 'To, date and time (YYYY-MM-DDTHH:MM, local time; v1 ran to today 04:00)', type: 'text', required: true },
  {
    id: 'version', label: 'Version: standard (default; window on the date the result was reported) or Levy (window on the date tested, patient optional, shorter result list)',
    type: 'select', required: false, optionsSql: "select 'standard' as version union all select 'Levy'",
  },
  {
    id: 'facility', label: 'Requesting facility code (blank: standard shows all facilities, Levy shows LVCVD and LPMGH; a code given replaces both)',
    type: 'text', required: false,
  },
];

// ---- COVID-19 daily positivity (Task 23) ------------------------------------------------------------------------------------------
//
// Replaces sp_dash_covid_7d_moving_avg (no parameters in v1). Params: from, to (required, YYYY-MM-DD). One row per day that has data:
// TestDate, Tests, Positive, Positivity Rate, Svn_d_moving_average, oldest first.
//
// What v1 does (lines 10-50):
//   Rows      requests joined to LabResults on RequestID and OBRSetID, panel in COVID, COVII and observation code in CVGXN, CO751, CO752, cov2,
//             cov68 (lines 33-34), TestingFacilityCode not in ZZZ, XXX, ZXZ, ZCX, ZLX (line 37). Text compares ignore case and trailing blanks.
//   Window    AuthorisedDateTime between '20210101 00:00:01' and getdate() (line 35). Spec ruling 3: the 2021 floor and "now" become from and
//             to, whole days of the local date of diagnostic_reports.issued (inRange). Deviation: v1's floor excluded a stamp at exactly
//             2021-01-01 00:00:00; the port includes a stamp at 00:00:00 on the from date. Run it with from 2021-01-01 to match v1's series.
//             The average is over the days inside the window only, so the first rows average fewer days than they would in v1.
//   Day       cast(AuthorisedDatetime as date): the LOCAL date of the stamp (localDate), not the UTC date.
//   Tests     count(*): RESULT ROWS, not distinct requests (a request with two result rows counts twice). Kept.
//   Positive  result rows whose LIMSCodedValue is DET or POS (line 21): lab_results.coded_value, not the result text. A positive text with no
//             coded value is not positive. Kept.
//   Rate      Positive * 1.0 / Tests. MEASURED on SQL Server 16: decimal(24,12), and the division TRUNCATES, so 2/3 is 0.666666666666, not
//             ...667. The port computes the same integer division on 12 places (div), exactly, with no float.
//   Average   avg(rate) over the last 7 ROWS (rows between 6 preceding and current row, lines 23-26), ordered by day: the mean of the last 7
//             daily rates that have data, not 7 calendar days and not pooled positives over tests. A day with no result rows has no row and is
//             skipped. MEASURED: decimal(38,12), also truncated (the mean of 0.333333333333 and 0.666666666666 is 0.499999999999). The port
//             sums the 12-place rates as integers and divides with div, so it truncates the same way.
//   Excluded labs   `TestingFacilityCode not in (...)` is unknown for a NULL code, so a report with no performer is dropped; a blank code is not
//             in the list and is counted. Kept. The list is v1's constant and stays in the query (ruling 1); CE's performer is the configured
//             OPENLDR_LAB_CODE (see Task 22), so each lab's push must set it to its v1 code for the exclusion to work.
//   No status filter: a preliminary report with an issued stamp counts. A report with no issued stamp, or a partial one, is outside.
//   The commented-out Platform columns (lines 11-19, 36, 40-48) are not output and not ported.
export const positivityParams = () => [
  { id: 'from', label: 'Date from (YYYY-MM-DD). To match the v1 series set it to 2021-01-01; the first 6 averages cover fewer days than 7', type: 'text', required: true },
  { id: 'to', label: 'Date to (YYYY-MM-DD), the whole day included', type: 'text', required: true },
];

export function positivitySql() {
  return `with src as (
  select ${localDate('dr.issued')} as test_date, case when ${inListSql('l.coded_value', ['DET', 'POS'])} then 1 else 0 end as is_positive
  from lab_requests lr
  join diagnostic_reports dr on dr.based_on_id = lr.id
  join lab_results l on l.request_id = lr.id
  where ${inListSql('lr.panel_code', ['COVID', 'COVII'])}
    and ${inListSql('l.observation_code', ['CVGXN', 'CO751', 'CO752', 'cov2', 'cov68'])}
    and ${inRange('dr.issued')}
    and ${foldSql('dr.performer')} not in ('zzz', 'xxx', 'zxz', 'zcx', 'zlx')
),
daily as (
  select s.test_date, count(*) as tests, sum(s.is_positive) as positive, div(sum(s.is_positive)::numeric * 1000000000000, count(*)) as rate12
  from src s
  group by s.test_date
),
averaged as (
  select d.test_date, d.tests, d.positive, d.rate12, div(sum(d.rate12) over w, count(d.rate12) over w) as average12
  from daily d
  window w as (order by d.test_date rows between 6 preceding and current row)
)
select a.test_date as "TestDate", a.tests::int as "Tests", a.positive::int as "Positive", (a.rate12 / 1000000000000)::numeric(24,12) as "Positivity Rate",
  (a.average12 / 1000000000000)::numeric(38,12) as "Svn_d_moving_average"
from averaged a
order by a.test_date`;
}

export function queries() {
  return [
    { name: 'COVID-19 by testing lab', sql: labStatsSql(), params: dateParams(true) },
    { name: 'COVID-19 positive patients', sql: positiveListSql(), params: positiveListParams() },
    { name: 'COVID-19 by source facility', sql: sourceStatsSql(), params: sourceStatsParams() },
    { name: 'COVID-19 daily line list', sql: lineListSql(), params: lineListParams() },
    { name: 'COVID-19 daily positivity', sql: positivitySql(), params: positivityParams() },
  ];
}

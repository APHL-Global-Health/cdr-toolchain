// Custom queries for the covid reports. Each task adds { name, sql, params } entries to the list.

import { foldSql, inListSql, rpt } from '../../vl-reports-mz/vl-queries.mjs';
import { dateParams, likeVarcharSql, localTs, requestAttrSql, requesterJoin, ssTextKey } from '../zm-sql.mjs';

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

export function queries() {
  return [
    { name: 'COVID-19 by testing lab', sql: labStatsSql(), params: dateParams(true) },
    { name: 'COVID-19 positive patients', sql: positiveListSql(), params: positiveListParams() },
    { name: 'COVID-19 by source facility', sql: sourceStatsSql(), params: sourceStatsParams() },
  ];
}

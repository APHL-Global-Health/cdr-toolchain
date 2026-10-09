// SQL for "VL info" and "VL results": v1's viewVL_Info and viewVL_Result ported to the
// CE Postgres warehouse. build.mjs puts them in the custom-queries step of dist/pack.json.
//
// The codes below are Mozambique content (the v1 panel and observation codes). The SQL takes
// them as input so a test copy can swap in another country's codes without editing the SQL.
//
// Column names and order follow v1. A v1 column with no CE source is NULL under its v1 name.
// The columns v1 computed with GetReasonForTest, ViralLoadResultMerge and ViralLoadFinalResult
// are ported as SQL expressions below. The merge reads the coded-result descriptions from the
// pack's value set urn:openldr:mz:vl-coded-results.

export const MOZ_CODES = {
  infoPanel: 'VIRAL',
  resultPanel: 'HIVVL',
  // viewVL_Result observation slots, v1 alias -> code
  result: { HIVVD: 'HIVVD', HIVVR: 'HIVVR', HIVVC: 'HIVVC', HIVVF: 'HIVVF', HIVRL: 'HIVRL' },
  // viewVL_Info observation slots
  info: {
    ENCON: 'ENCON', AMAME: 'AMAME', VIRAP: 'VIRAP', LABDA: 'LABDA', LABHO: 'LABHO',
    TARVD: 'TARVD', TARVP: 'TARVP', TARVS: 'TARVS', ESCOL: 'ESCOL', TARVQ: 'TARVQ',
    LABTI: 'LABTI', VIRAD: 'VIRAD', VIRR1: 'VIRR1', LABNO: 'LABNO', CONSE: 'CONSE', LABLO: 'LABLO',
  },
};

const POC_VALUE_SET = 'urn:openldr:mz:poc-sites';
const LINK_VALUE_SET = 'urn:openldr:mz:link-sites';
const ATTR_SYSTEM = 'urn:openldr:cs:request-attribute';

export const VL_CODED_SYSTEM = 'urn:openldr:mz:cs:vl-coded-results';
export const VL_CODED_VALUE_SET = 'urn:openldr:mz:vl-coded-results';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

// v1 LIMSRptResult: CE text value, else numeric value as text, else coded value.
// A numeric result outside the reporting range shows as v1 shows it: the comparator, a space,
// the limit ("< 20"). A null numeric value makes the whole middle term null.
const rpt = (a) =>
  `coalesce(${a}.text_value, coalesce(${a}.numeric_comparator || ' ', '') || ${a}.numeric_value::text, ${a}.coded_value)`;

// ---- v1's VL functions as inline SQL. A custom query is one SELECT and cannot create SQL
// functions, so each function is an expression. Source: the Mozambique team's
// openldr-functions-script.sql (2026-10-09). v1 compares with SQL Server's default collation:
// case-insensitive, and trailing spaces do not count. So the port compares lower(rtrim(x)).

// SQL Server's ISNUMERIC: a sign, digits with thousands commas, a decimal point, an exponent, a
// currency sign, surrounding spaces. It also accepts a lone "+", "$" or ".". This does not; none is
// a plausible viral load result. Tabs around digits are accepted (\s matches them); only a lone tab
// is rejected.
const ISNUMERIC_RE = String.raw`^\s*[-+]?[$£€¥]?(\d[\d,]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$`;

export const isNumericSql = (x) => `coalesce(${x} ~ ${lit(ISNUMERIC_RE)}, false)`;

// SQL Server's "x = ''" is also true for spaces only. NULL counts as blank here too.
export const blankSql = (x) => `coalesce(rtrim(${x}), '') = ''`;
const foldSql = (x) => `lower(rtrim(${x}))`;
const inListSql = (x, words) => `${foldSql(x)} in (${words.map((w) => lit(w.toLowerCase())).join(', ')})`;

// GetReasonForTest: v1's English text for Mozambique's reason-for-test answers. Mozambique
// content, so it lives in the pack, not in CE.
const REASON_FOR_TEST = [
  ['Nao Prenchido', 'Not Specified'],
  ['Suspect treatment failure', 'Suspected treatment failure'],
  ['Repiticas apos AMA', 'Repeat after breastfeeding'],
  ['Rotina', 'Routine'],
];

export function reasonForTestSql(x) {
  const whens = REASON_FOR_TEST.map(([from, to]) => `when ${foldSql(x)} = ${lit(from.toLowerCase())} then ${lit(to)}`).join(' ');
  return `case when ${blankSql(x)} then 'Reason Not Specified' ${whens} else ${x} end`;
}

// The reported value without rpt()'s coded fallback: text value, else comparator and numeric
// value. ViralLoadResultMerge needs it blank when only a code was reported. With rpt() it would
// never be blank, and the merge would return the code where v1 returns its description.
export const reportedSql = (a) =>
  `coalesce(${a}.text_value, coalesce(${a}.numeric_comparator || ' ', '') || ${a}.numeric_value::text)`;

// The coded-result descriptions, read once per run. terminology_codes holds every value set and
// is indexed on value_set_id only, so a lookup per row would scan it each time.
export const vlCodedCte = `vl_coded as materialized (
  select upper(code) as code, display from terminology_codes where value_set_url = ${lit(VL_CODED_VALUE_SET)}
)`;

// ViralLoadResultMerge(reported, coded): the reported value. When it is blank, the description of
// the coded value. v1 reads the descriptions from OpenLDRDict.dbo.LIMSCodedValues; the pack ships
// them as the coded-results value set. A code not in the set gives NULL, as in v1: its
// "SELECT @OutString = ... WHERE Code = @code" matches no row and leaves @OutString NULL.
export const resultMergeSql = (reported, coded) =>
  `case when ${blankSql(reported)} then (select vc.display from vl_coded vc where vc.code = upper(rtrim(${coded})) limit 1) else ${reported} end`;

// ViralLoadFinalResult's error list. v1 lists Indeterminado twice. Its rule 1 counts matches and
// works; rules 2 and 3 use "(SELECT 1 ...) = 1", which raises SQL Server error 512 on two rows.
// The port cannot raise an error per row, so it treats Indeterminado as the list means: NULL.
const VL_ERROR_WORDS = ['POS', 'Positive', 'Invalid', 'INVAL', 'Valid', 'Indeterminado', 'NEGAT', 'Reactive', 'Negative'];
const NOT_DETECTED = ['Target not detected', 'NOT DETECTED'];
const hasRangeSql = (x) => `(${x} like '%<%' or ${x} like '%>%')`;
// v1 rule 2: an error word gives NULL, a range keeps the value, anything else is INDETECTAVEL.
// There is no numeric branch, so a plain number alone in HIVVD becomes INDETECTAVEL. v1 does this.
const resultOnlySql = (x) =>
  `case when ${inListSql(x, VL_ERROR_WORDS)} then null when ${hasRangeSql(x)} then ${x} else 'INDETECTAVEL' end`;

// ViralLoadFinalResult(result, capctm). The rules, in v1's order:
//   1. capctm set, result NULL: error word NULL; range or number keeps capctm; else INDETECTAVEL.
//   2. capctm NULL, result set: resultOnlySql(result).
//   3. otherwise: the two joined are numeric, capctm (v1 tests the joined text, '20'||'1000');
//      either is "not detected", INDETECTAVEL; equal ignoring case, rule 2 on result; else NULL.
// A numeric value comes back as CE stores it (61.736, where v1 shows 62).
export function finalResultSql(result, capctm) {
  return `case
    when ${capctm} is not null and ${result} is null then
      case when ${inListSql(capctm, VL_ERROR_WORDS)} then null when ${hasRangeSql(capctm)} then ${capctm} when ${isNumericSql(capctm)} then ${capctm} else 'INDETECTAVEL' end
    when ${capctm} is null and ${result} is not null then ${resultOnlySql(result)}
    when ${isNumericSql(`coalesce(${result}, '') || coalesce(${capctm}, '')`)} then ${capctm}
    when ${inListSql(capctm, NOT_DETECTED)} or ${inListSql(result, NOT_DETECTED)} then 'INDETECTAVEL'
    when ${foldSql(result)} = ${foldSql(capctm)} then ${resultOnlySql(result)}
  end`;
}

// Request attributes (urn:openldr:cs:request-attribute), one row per request and code.
const ATTRS = [
  ['prereg_registration_time', 'prereg-registration-time'],
  ['prereg_received_time', 'prereg-received-time'],
  ['prereg_registration_facility', 'prereg-registration-facility'],
  ['loinc_panel_code', 'loinc-panel-code'],
  ['admit_attend_time', 'admit-attend-time'],
  ['collection_volume', 'collection-volume'],
  ['icd10_clinical_info', 'icd10-clinical-info'],
  ['hl7_specimen_source', 'hl7-specimen-source'],
  ['hl7_specimen_site', 'hl7-specimen-site'],
  ['specimen_site_code', 'specimen-site-code'],
  ['specimen_site_desc', 'specimen-site-desc'],
  ['work_units', 'work-units'],
  ['cost_units', 'cost-units'],
  ['ordering_notes', 'ordering-notes'],
  ['encrypted_patient_id', 'encrypted-patient-id'],
  ['ethnic_group', 'ethnic-group'],
  ['deceased', 'deceased'],
  ['newborn', 'newborn'],
  ['patient_class', 'patient-class'],
  ['referring_request_id', 'referring-request-id'],
  ['therapy', 'therapy'],
  ['target_time_days', 'target-time-days'],
  ['target_time_mins', 'target-time-mins'],
  ['repeated', 'repeated'],
];

const attrCte = `attrs as (
  select a.lab_request_id,
${ATTRS.map(([col, code]) => `    max(case when a.code = ${lit(code)} then coalesce(a.value_text, a.value_number::text, a.value_datetime, a.value_boolean::text) end) as ${col}`).join(',\n')}
  from lab_request_attributes a
  where a.system = ${lit(ATTR_SYSTEM)}
  group by a.lab_request_id
)`;

// Joins shared by both queries. The requesting facility's facility_map key is the one the
// observed-facility scan builds for requesters (facility-reconcile.ts readObservedFacilityRows):
// source_system and requester_system coalesced to '', code = requester_code. The testing lab's
// key is the same shape over diagnostic_reports.performer (report-seeds.ts q-facilities).
const commonJoins = `left join diagnostic_reports dr on dr.based_on_id = lr.id
left join specimens s on s.id = dr.specimen_id
left join patients p on p.id = lr.patient_id
left join attrs ax on ax.lab_request_id = lr.id
left join facility_map fmr on fmr.source_system = coalesce(lr.source_system, '') and fmr.performer_system = coalesce(lr.requester_system, '') and fmr.source_code = lr.requester_code
left join facility_map fml on fml.source_system = coalesce(dr.source_system, '') and fml.performer_system = coalesce(dr.performer_system, '') and fml.source_code = dr.performer`;

const obsJoin = (alias, code) =>
  `left join lab_results ${alias} on ${alias}.request_id = lr.id and ${alias}.observation_code = ${lit(code)}`;

const where = (panel) => `where lr.panel_code = ${lit(panel)}
  and lr.authored_at >= {{param.from}}
  and lr.authored_at <= ({{param.to}} || 'T23:59:59.999Z')
  and ({{param.facility}} = '' or lr.requester_code = {{param.facility}})
order by lr.authored_at, lr.id`;

// The last block of columns, the same in both views.
function sharedTail() {
  return `  lr.request_type as "RequestTypeCode",
  ax.icd10_clinical_info as "ICD10ClinicalInfoCodes",
  lr.clinical_info as "ClinicalInfo",
  ax.hl7_specimen_source as "HL7SpecimenSourceCode",
  s.type_code as "LIMSSpecimenSourceCode",
  s.type_text as "LIMSSpecimenSourceDesc",
  ax.hl7_specimen_site as "HL7SpecimenSiteCode",
  ax.specimen_site_code as "LIMSSpecimenSiteCode",
  ax.specimen_site_desc as "LIMSSpecimenSiteDesc",
  ax.work_units as "WorkUnits",
  ax.cost_units as "CostUnits",
  dr.section_code as "HL7SectionCode",
  dr.status as "HL7ResultStatusCode",
  lr.registered_by as "RegisteredBy",
  lr.tested_by as "TestedBy",
  dr.authorised_by as "AuthorisedBy",
  ax.ordering_notes as "OrderingNotes",
  ax.encrypted_patient_id as "EncryptedPatientID",
  ax.ethnic_group as "HL7EthnicGroupCode",
  ax.deceased as "Deceased",
  ax.newborn as "Newborn",
  ax.patient_class as "HL7PatientClassCode",
  lr.requester_practitioner as "AttendingDoctor",
  ax.referring_request_id as "ReferringRequestID",
  ax.therapy as "Therapy",
  lr.analyzer_code as "LIMSAnalyzerCode",
  ax.target_time_days as "TargetTimeDays",
  ax.target_time_mins as "TargetTimeMins",
  ax.repeated as "Repeated",
  case when exists (select 1 from terminology_codes tl where tl.value_set_url = ${lit(LINK_VALUE_SET)} and tl.code = lr.requester_code) then 1 else 0 end as "IsDisaLink",
  case when exists (select 1 from terminology_codes tp where tp.value_set_url = ${lit(POC_VALUE_SET)} and tp.code = lr.requester_code) then 1 else 0 end as "IsDisaPoc"`;
}

function facilityBlock(testingProvinceAlias) {
  return `  lr.created_at as "DateTimeStamp",
  null as "Versionstamp",
  null as "LIMSDateTimeStamp",
  null as "LIMSVersionstamp",
  ax.loinc_panel_code as "LOINCPanelCode",
  lr.priority as "HL7PriorityCode",
  ax.admit_attend_time as "AdmitAttendDateTime",
  ax.collection_volume as "CollectionVolume",
  null as "RequestingFacilityNationalCode",
  null as "LIMSFacilityCode",
  null as "LIMSFacilityName",
  null as "LIMSProvinceName",
  null as "LIMSDistrictName",
  lr.requester_code as "RequestingFacilityCode",
  fmr.name as "RequestingFacilityName",
  fmr.region as "RequestingProvinceName",
  fmr.district as "RequestingDistrictName",
  null as "ReceivingFacilityCode",
  null as "ReceivingFacilityName",
  null as "ReceivingProvinceName",
  null as "ReceivingDistrictName",
  dr.performer as "TestingFacilityCode",
  fml.name as "TestingFacilityName",
  fml.region as "${testingProvinceAlias}",
  fml.district as "TestingDistrictName",
  lr.point_of_care as "LIMSPointOfCareDesc",`;
}

export function vlResultSql(codes) {
  const r = codes.result;
  const merged = (alias) => resultMergeSql(reportedSql(alias), `${alias}.coded_value`);
  // Two lateral subqueries name each slot's merged value once, so the SQL stays readable. Postgres
  // flattens them and evaluates each reference on its own. They also name FinalViralLoadResult's
  // second input: the first of HIVVR, HIVVC, HIVVF with a reported value, else HIVVR. v1 tests
  // LEN(LIMSRptResult) > 0, and LEN ignores trailing spaces, as blankSql does.
  return `with ${attrCte},
${vlCodedCte}
select
  lr.request_id as "RequestID",
  lr.obr_set_id as "OBRSetID",
  lr.panel_code as "LIMSPanelCode",
  lr.panel_desc as "LIMSPanelDesc",
  dr.issued as "HIVVL_AuthorisedDateTime",
  lr.rejection_code as "HIVVL_LIMSRejectionCode",
  lr.rejection_reason as "HIVVL_LIMSRejectionDesc",
  vlm.vd as "HIVVL_ViralLoadResult",
  vlm.vr as "HIVVL_ViralLoadCAPCTM",
  vlm.vc as "HIVVL_Low_value",
  vlm.vf as "HIVVL_Viral",
  ${rpt('hivrl')} as "HIVVL_VRLogValue",
  ${finalResultSql('vlm.vd', 'vlc.capctm')} as "FinalViralLoadResult",
  lr.age_years as "AgeInYears",
  lr.age_days as "AgeInDays",
  p.sex as "HL7SexCode",
  dr.effective as "SpecimenDatetime",
  lr.authored_at as "RegisteredDateTime",
  s.received_time as "ReceivedDateTime",
  dr.issued as "AuthorisedDateTime",
  lr.analysis_at as "AnalysisDateTime",
  lr.rejection_code as "LIMSRejectionCode",
  lr.rejection_reason as "LIMSRejectionDesc",
${facilityBlock('testingProvinceName')}
${sharedTail()}
from lab_requests lr
${commonJoins}
${obsJoin('hivvd', r.HIVVD)}
${obsJoin('hivvr', r.HIVVR)}
${obsJoin('hivvc', r.HIVVC)}
${obsJoin('hivvf', r.HIVVF)}
${obsJoin('hivrl', r.HIVRL)}
cross join lateral (select
  ${merged('hivvd')} as vd,
  ${merged('hivvr')} as vr,
  ${merged('hivvc')} as vc,
  ${merged('hivvf')} as vf
) vlm
cross join lateral (select case
  when not ${blankSql(reportedSql('hivvr'))} then vlm.vr
  when not ${blankSql(reportedSql('hivvc'))} then vlm.vc
  when not ${blankSql(reportedSql('hivvf'))} then vlm.vf
  else vlm.vr end as capctm
) vlc
${where(codes.resultPanel)}`;
}

export function vlInfoSql(codes) {
  const c = codes.info;
  const unreported = (alias, name) => `  case when ${rpt(alias)} is null then 'Unreported' else ${rpt(alias)} end as "${name}",`;
  const plain = (alias, name) => `  ${rpt(alias)} as "${name}",`;
  return `with ${attrCte}
select
  lr.request_id as "RequestID",
  lr.obr_set_id as "OBRSetID",
  lr.panel_code as "LIMSPanelCode",
  lr.panel_desc as "LIMSPanelDesc",
  lr.age_years as "AgeInYears",
  lr.age_days as "AgeInDays",
  p.sex as "HL7SexCode",
  ax.prereg_registration_time as "LIMSPreReg_RegistrationDateTime",
  ax.prereg_received_time as "LIMSPreReg_ReceivedDateTime",
  ax.prereg_registration_facility as "LIMSPreReg_RegistrationFacilityCode",
  dr.effective as "SpecimenDatetime",
  lr.authored_at as "RegisteredDateTime",
  s.received_time as "ReceivedDateTime",
  dr.issued as "AuthorisedDateTime",
  lr.analysis_at as "AnalysisDateTime",
  lr.rejection_code as "LIMSRejectionCode",
  lr.rejection_reason as "LIMSRejectionDesc",
${unreported('preg', 'Pregnant')}
${unreported('bf', 'BreastFeeding')}
${unreported('ft', 'FirstTime')}
${unreported('cday', 'CollectedDate')}
${plain('ctime', 'CollectedTime')}
${plain('tarvd', 'DataDeInicioDoTARV')}
${plain('tarvp', 'PrimeiraLinha')}
${plain('tarvs', 'SegundaLinha')}
${plain('tarvq', 'ARTRegimen')}
${plain('labti', 'TypeOfSampleCollection')}
${plain('virad', 'LastViralLoadDate')}
${plain('virr1', 'LastViralLoadResult')}
${plain('labno', 'RequestingClinician')}
${plain('conse', 'ConsentimentoParaContacto')}
${plain('lablo', 'LocalDeColheita')}
  ${reasonForTestSql(rpt('motivo'))} as "ReasonForTest",
${facilityBlock('TestingProvinceName')}
${sharedTail()}
from lab_requests lr
${commonJoins}
${obsJoin('preg', c.ENCON)}
${obsJoin('bf', c.AMAME)}
${obsJoin('ft', c.VIRAP)}
${obsJoin('cday', c.LABDA)}
${obsJoin('ctime', c.LABHO)}
${obsJoin('tarvd', c.TARVD)}
${obsJoin('tarvp', c.TARVP)}
${obsJoin('tarvs', c.TARVS)}
${obsJoin('motivo', c.ESCOL)}
${obsJoin('tarvq', c.TARVQ)}
${obsJoin('labti', c.LABTI)}
${obsJoin('virad', c.VIRAD)}
${obsJoin('virr1', c.VIRR1)}
${obsJoin('labno', c.LABNO)}
${obsJoin('conse', c.CONSE)}
${obsJoin('lablo', c.LABLO)}
${where(codes.infoPanel)}`;
}

export const VL_PARAMS = [
  { id: 'from', label: 'Registered from (YYYY-MM-DD)', type: 'text', required: true },
  { id: 'to', label: 'Registered to (YYYY-MM-DD)', type: 'text', required: true },
  { id: 'facility', label: 'Requesting facility code (blank for all)', type: 'text', required: false },
];

export function vlQueryFile(codes) {
  return {
    format: 'openldr.custom-queries',
    version: 1,
    exportedAt: new Date().toISOString(),
    queries: [
      { name: 'VL info', sql: vlInfoSql(codes), params: VL_PARAMS },
      { name: 'VL results', sql: vlResultSql(codes), params: VL_PARAMS },
    ],
  };
}

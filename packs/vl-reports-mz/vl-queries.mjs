// SQL for "VL info" and "VL results": v1's viewVL_Info and viewVL_Result ported to the
// CE Postgres warehouse. build.mjs puts them in the custom-queries step of dist/pack.json.
//
// The codes below are Mozambique content (the v1 panel and observation codes). The SQL takes
// them as input so a test copy can swap in another country's codes without editing the SQL.
//
// Column names and order follow v1. A v1 column with no CE source is NULL under its v1 name.
// The columns v1 computed with ViralLoadResultMerge, ViralLoadFinalResult and GetReasonForTest
// are left out, because those functions are not in the views script. The raw reported value and
// coded value of each input observation are returned in their place.

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
// currency sign, surrounding spaces. It also accepts a lone "+", "$" or "." and tabs. This does
// not; none is a plausible viral load result.
const ISNUMERIC_RE = String.raw`^\s*[-+]?[$£€¥]?(\d[\d,]*(\.\d*)?|\.\d+)([eE][-+]?\d+)?\s*$`;

export const isNumericSql = (x) => `coalesce(${x} ~ ${lit(ISNUMERIC_RE)}, false)`;

// SQL Server's "x = ''" is also true for spaces only. NULL counts as blank here too.
const blankSql = (x) => `coalesce(rtrim(${x}), '') = ''`;
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
  const raw = (alias) => `  ${rpt(alias.toLowerCase())} as "${alias}_LIMSRptResult",
  ${alias.toLowerCase()}.coded_value as "${alias}_LIMSCodedValue",`;
  return `with ${attrCte}
select
  lr.request_id as "RequestID",
  lr.obr_set_id as "OBRSetID",
  lr.panel_code as "LIMSPanelCode",
  lr.panel_desc as "LIMSPanelDesc",
  dr.issued as "HIVVL_AuthorisedDateTime",
  lr.rejection_code as "HIVVL_LIMSRejectionCode",
  lr.rejection_reason as "HIVVL_LIMSRejectionDesc",
${raw('HIVVD')}
${raw('HIVVR')}
${raw('HIVVC')}
${raw('HIVVF')}
  ${rpt('hivrl')} as "HIVVL_VRLogValue",
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
  ${rpt('motivo')} as "ESCOL_LIMSRptResult",
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

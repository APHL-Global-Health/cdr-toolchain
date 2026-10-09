// Check groups for the lab-ops reports. Each task adds { name, suites } entries to this list.
//
// Group t5-vleid: the vleidrequests builder (v1 sp_UpdateVLEIDRequests and Table__dbo_VLEIDRequests.sql). Fixture ids
// start with "t5v-". Lab ids (lr.request_id) start with "T5V-".
// "v1 line N" below means a line of StoredProcedure__dbo_sp_UpdateVLEIDRequests.sql unless a file is named.

import { lit, inOrder } from '../../shared/pg-check.mjs';
import { ATTR_SYSTEM, vleidRequestsCte } from '../zm-sql.mjs';

// The columns of Table__dbo_VLEIDRequests.sql in snake_case (56 columns; the inventory says 57).
const COLUMNS = ['date_time_stamp', 'versionstamp', 'lims_date_time_stamp', 'lims_versionstamp', 'request_id', 'obr_set_id',
  'loinc_panel_code', 'lims_panel_code', 'lims_panel_desc', 'hl7_priority_code', 'specimen_date_time', 'registered_date_time',
  'received_date_time', 'analysis_date_time', 'authorised_date_time', 'admit_attend_date_time', 'collection_volume',
  'requesting_facility_code', 'receiving_facility_code', 'lims_point_of_care_desc', 'request_type_code',
  'icd10_clinical_info_codes', 'clinical_info', 'hl7_specimen_source_code', 'lims_specimen_source_code',
  'lims_specimen_source_desc', 'hl7_specimen_site_code', 'lims_specimen_site_code', 'lims_specimen_site_desc', 'work_units',
  'cost_units', 'hl7_section_code', 'hl7_result_status_code', 'registered_by', 'tested_by', 'authorised_by', 'ordering_notes',
  'encrypted_patient_id', 'age_in_years', 'age_in_days', 'hl7_sex_code', 'hl7_ethnic_group_code', 'deceased', 'newborn',
  'hl7_patient_class_code', 'attending_doctor', 'testing_facility_code', 'referring_request_id', 'therapy',
  'lims_analyzer_code', 'target_time_days', 'target_time_mins', 'lims_rejection_code', 'lims_rejection_desc',
  'lims_facility_code', 'repeated'];

const FORM = 'hiv_vl_documentation';
const A0 = '2026-05-02T08:00:00Z';
const num = (v) => (v === null || v === undefined ? 'null' : String(v));
const pad = (n) => String(n).padStart(3, '0');

// ---- Fixture builder ----

const patients = [];
const requests = [];
const reports = [];
const specimens = [];
const attrs = [];
const forms = [];
const expected = [];
let seq = 0;

// One request row. Every field is optional. `report` is { status, effective, issued, performer, section, authBy,
// received, typeCode, typeText } or absent for a request with no report. `forms` lists form codes answered on it.
function request(labId, o) {
  const s = { panel: 'HIVVL', authored: A0, req: 'ZSOUT', obr: 1, ...o };
  const n = ++seq;
  const qid = `t5v-q${pad(n)}`;
  let patientId = null;
  if (s.sex !== undefined && s.sex !== null) {
    patientId = `t5v-p${pad(n)}`;
    patients.push(`(${lit(patientId)}, ${lit('P' + n)}, ${lit(s.sex)})`);
  }
  requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(patientId)}, ${lit(s.panel)}, ${lit(s.desc)}, ${lit(s.priority)}, ${lit(s.authored)}, ${lit(s.req)}, ${lit(s.analysis)}, ${lit(s.poc)}, ${lit(s.rtype)}, ${lit(s.regBy)}, ${lit(s.testedBy)}, ${lit(s.doctor)}, ${lit(s.info)}, ${lit(s.analyzer)}, ${lit(s.rejCode)}, ${lit(s.rejDesc)}, ${num(s.obr)}, ${num(s.years)}, ${num(s.days)})`);
  if (s.report) {
    const r = s.report;
    let specimenId = null;
    if (r.received || r.typeCode || r.typeText) {
      specimenId = `t5v-s${pad(n)}`;
      specimens.push(`(${lit(specimenId)}, ${lit(r.received)}, ${lit(r.typeCode)}, ${lit(r.typeText)})`);
    }
    reports.push(`(${lit(`t5v-d${pad(n)}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.effective)}, ${lit(r.issued)}, ${lit(r.performer)}, ${lit(specimenId)}, ${lit(r.section)}, ${lit(r.authBy)})`);
  }
  if (s.ref !== undefined) attrs.push(`(${lit(`t5v-a${pad(n)}`)}, ${lit(qid)}, ${lit(s.refSystem ?? ATTR_SYSTEM)}, 'referring-request-id', ${lit(s.ref)})`);
  (s.forms ?? []).forEach((code, i) => addForm(`t5v-f${pad(n)}-${i + 1}`, code, qid));
  return qid;
}
function addForm(id, code, basedOn) {
  forms.push(`(${lit(id)}, ${lit(code)}, ${lit(basedOn)}, '[]', '2026-05-02T08:00:00Z')`);
}

const NULLS = Object.fromEntries(COLUMNS.map((c) => [c, null]));
const row = (o) => ({ ...NULLS, ...o });
// The row of a bare request (no patient, no report): its lab number, OBR set, panel, registered date and facility.
const min = (labId, o = {}) => row({ request_id: labId, obr_set_id: 1, lims_panel_code: 'HIVVL', registered_date_time: A0, requesting_facility_code: 'ZSOUT', lims_facility_code: 'ZSOUT', ...o });

// One lab number: its request rows, and the rows v1 would hold for them.
function lab(labId, specs, wants) {
  specs.forEach((s) => request(labId, s));
  for (const w of wants) expected.push(w);
}

// ---- Which rows (v1 line 23): panels HIVPC, HIVST, HIVVL and VIRAL ----
lab('T5V-MIN', [{}], [min('T5V-MIN')]);
['HIVPC', 'HIVST', 'VIRAL'].forEach((panel) => lab(`T5V-PANEL-${panel}`, [{ panel }], [min(`T5V-PANEL-${panel}`, { lims_panel_code: panel })]));
// IN compares ignoring case and trailing spaces (SQL Server collation); the panel code comes through as stored.
lab('T5V-PANEL-CASE', [{ panel: 'hivvl ' }], [min('T5V-PANEL-CASE', { lims_panel_code: 'hivvl ' })]);
lab('T5V-PANEL-RTRI', [{ panel: 'RTRI' }], []);
lab('T5V-PANEL-NULL', [{ panel: null }], []);
lab('T5V-PANEL-OTHER', [{ panel: 'HIVWB' }], []);
// The grain is the request row, one per OBR set (the key is RequestID, panel and OBRSetID).
lab('T5V-TWO-OBR', [{ panel: 'HIVVL', obr: 1 }, { panel: 'HIVPC', obr: 2 }],
  [min('T5V-TWO-OBR'), min('T5V-TWO-OBR', { obr_set_id: 2, lims_panel_code: 'HIVPC' })]);
// No facility join: a facility that is not in the register still gives a row. A request with no facility too.
lab('T5V-UNMAPPED', [{ req: 'ZUNMP' }], [min('T5V-UNMAPPED', { requesting_facility_code: 'ZUNMP', lims_facility_code: 'ZUNMP' })]);
lab('T5V-NOFACILITY', [{ req: null }], [min('T5V-NOFACILITY', { requesting_facility_code: null, lims_facility_code: null })]);

// ---- Every column, from a full request (the table columns, in order) ----
// The request fields are lab_requests, the report fields diagnostic_reports and specimens (CE keeps the specimen
// dates and codes on the report's specimen). Columns CE does not carry are NULL: the v1 load stamps, LOINC panel,
// admit date, volume, receiving facility, ICD codes, specimen source and site codes (HL7), site fields, work and cost
// units, ordering notes, encrypted patient id, ethnic group, deceased, newborn, class, therapy, target times, repeated.
lab('T5V-FULL', [{
  panel: 'HIVVL', obr: 2, desc: 'Viral Load', priority: 'urgent', authored: '2026-05-02T08:00:00Z', analysis: '2026-05-02T09:00:00Z',
  req: 'ZSOUT', poc: 'Ward 3', rtype: 'RT1', regBy: 'Reg Clerk', testedBy: 'Tech A', doctor: 'Dr Banda', info: 'On ART',
  analyzer: 'G001', rejCode: 'R01', rejDesc: 'Haemolysed', years: 30, days: 10950, sex: 'F', ref: 'REF-9',
  report: { status: 'final', effective: '2026-05-01T07:00:00Z', issued: '2026-05-10T10:00:00Z', performer: 'LUS', section: 'CHM',
    authBy: 'Dr Phiri', received: '2026-05-01T12:00:00Z', typeCode: 'SER', typeText: 'Serum' },
}], [row({
  request_id: 'T5V-FULL', obr_set_id: 2, lims_panel_code: 'HIVVL', lims_panel_desc: 'Viral Load',
  hl7_priority_code: 'U',                                       // urgent -> U (the cdr mapping R/U/S, reversed)
  specimen_date_time: '2026-05-01T07:00:00Z', registered_date_time: '2026-05-02T08:00:00Z',
  received_date_time: '2026-05-01T12:00:00Z', analysis_date_time: '2026-05-02T09:00:00Z', authorised_date_time: '2026-05-10T10:00:00Z',
  requesting_facility_code: 'ZSOUT', lims_point_of_care_desc: 'Ward 3', request_type_code: 'RT1', clinical_info: 'On ART',
  lims_specimen_source_code: 'SER', lims_specimen_source_desc: 'Serum', hl7_section_code: 'CHM',
  hl7_result_status_code: 'F',                                  // final -> F
  registered_by: 'Reg Clerk', tested_by: 'Tech A', authorised_by: 'Dr Phiri', age_in_years: 30, age_in_days: 10950,
  hl7_sex_code: 'F', attending_doctor: 'Dr Banda', testing_facility_code: 'LUS', referring_request_id: 'REF-9',
  lims_analyzer_code: 'G001', lims_rejection_code: 'R01', lims_rejection_desc: 'Haemolysed', lims_facility_code: 'ZSOUT',
})]);

// ---- Priority and result status ----
// Priority: CE holds the FHIR word (cdr maps R, U and S to routine, urgent and stat); anything else is NULL.
[['routine', 'R'], ['urgent', 'U'], ['stat', 'S'], ['STAT ', 'S'], ['asap', null], [null, null], ['', null]]
  .forEach(([priority, code], i) => lab(`T5V-PRIO-${i}`, [{ priority }], [min(`T5V-PRIO-${i}`, { hl7_priority_code: code })]));
// Result status: final is F and cancelled is X. CE folds every other v1 status to unknown, so unknown is NULL here.
[['final', 'F'], ['FINAL ', 'F'], ['cancelled', 'X'], ['unknown', null], ['preliminary', null], [null, null]]
  .forEach(([status, code], i) => lab(`T5V-STATUS-${i}`, [{ report: { status } }], [min(`T5V-STATUS-${i}`, { hl7_result_status_code: code })]));
// No report: every report column is NULL. The request columns stay.
lab('T5V-NOREPORT', [{ analysis: '2026-05-02T09:00:00Z' }], [min('T5V-NOREPORT', { analysis_date_time: '2026-05-02T09:00:00Z' })]);
// A report without a specimen: no received date and no specimen codes.
lab('T5V-NOSPECIMEN', [{ report: { status: 'final', effective: '2026-05-01T07:00:00Z', performer: 'LUS' } }],
  [min('T5V-NOSPECIMEN', { hl7_result_status_code: 'F', specimen_date_time: '2026-05-01T07:00:00Z', testing_facility_code: 'LUS' })]);
// Sex is the patient's value as stored (v1 HL7SexCode is a code, CE keeps the code). No patient is NULL.
['M', 'U', 'Z', ''].forEach((sex, i) => lab(`T5V-SEX-${i}`, [{ sex }], [min(`T5V-SEX-${i}`, { hl7_sex_code: sex })]));
// The referring request id is the request attribute. Another system's attribute does not count.
lab('T5V-REF', [{ ref: 'R-1' }], [min('T5V-REF', { referring_request_id: 'R-1' })]);
lab('T5V-REF-OTHERSYS', [{ ref: 'R-1', refSystem: 'urn:other' }], [min('T5V-REF-OTHERSYS')]);

// ---- VIRAL (v1 line 23): CE keeps Zambia's VIRAL panel as a form answered on the first request, not as a request ----
// A form on a request gives one extra VIRAL row that copies the request's registration facts. The analysis date, the
// authorised date, the result status, the section, the tested and authorised by, the analyzer and the rejection are the
// test's, not the form's: those are NULL on the VIRAL row.
const viralSpec = {
  desc: 'Viral Load', priority: 'routine', analysis: '2026-05-02T09:00:00Z', req: 'ZSOUT', poc: 'Ward 3', rtype: 'RT1', regBy: 'Reg Clerk',
  testedBy: 'Tech A', doctor: 'Dr Banda', info: 'On ART', analyzer: 'G001', rejCode: 'R01', rejDesc: 'Haemolysed', years: 30, days: 10950,
  sex: 'F', ref: 'REF-9',
  report: { status: 'final', effective: '2026-05-01T07:00:00Z', issued: '2026-05-10T10:00:00Z', performer: 'LUS', section: 'CHM',
    authBy: 'Dr Phiri', received: '2026-05-01T12:00:00Z', typeCode: 'SER', typeText: 'Serum' },
};
const viralFacts = {
  hl7_priority_code: 'R', specimen_date_time: '2026-05-01T07:00:00Z', registered_date_time: A0, received_date_time: '2026-05-01T12:00:00Z',
  requesting_facility_code: 'ZSOUT', lims_point_of_care_desc: 'Ward 3', request_type_code: 'RT1', clinical_info: 'On ART',
  lims_specimen_source_code: 'SER', lims_specimen_source_desc: 'Serum', registered_by: 'Reg Clerk', age_in_years: 30, age_in_days: 10950,
  hl7_sex_code: 'F', attending_doctor: 'Dr Banda', testing_facility_code: 'LUS', referring_request_id: 'REF-9', lims_facility_code: 'ZSOUT',
};
// The HIVVL request keeps its own row, with the test's columns.
const hivvlOwn = (labId, o = {}) => row({
  request_id: labId, obr_set_id: 1, lims_panel_code: 'HIVVL', lims_panel_desc: 'Viral Load', ...viralFacts,
  analysis_date_time: '2026-05-02T09:00:00Z', authorised_date_time: '2026-05-10T10:00:00Z', hl7_section_code: 'CHM',
  hl7_result_status_code: 'F', tested_by: 'Tech A', authorised_by: 'Dr Phiri', lims_analyzer_code: 'G001',
  lims_rejection_code: 'R01', lims_rejection_desc: 'Haemolysed', ...o,
});
const viralRow = (labId, o = {}) => row({ request_id: labId, obr_set_id: 1, lims_panel_code: 'VIRAL', ...viralFacts, ...o });

lab('T5V-VF-1', [{ ...viralSpec, forms: [FORM] }], [hivvlOwn('T5V-VF-1'), viralRow('T5V-VF-1')]);
// The form is answered on a request whose panel is not in the list (the first ordered panel can be any panel): only
// the VIRAL row shows.
lab('T5V-VF-RTRI', [{ ...viralSpec, panel: 'RTRI', forms: [FORM] }], [viralRow('T5V-VF-RTRI')]);
lab('T5V-VF-HIVPC', [{ ...viralSpec, panel: 'HIVPC', forms: [FORM] }],
  [hivvlOwn('T5V-VF-HIVPC', { lims_panel_code: 'HIVPC' }), viralRow('T5V-VF-HIVPC')]);
// Two answers to the form on one request are still one VIRAL request.
lab('T5V-VF-TWICE', [{ ...viralSpec, forms: [FORM, FORM] }], [hivvlOwn('T5V-VF-TWICE'), viralRow('T5V-VF-TWICE')]);
// Another form is not the VIRAL panel.
lab('T5V-VF-OTHERFORM', [{ ...viralSpec, forms: ['other_form'] }], [hivvlOwn('T5V-VF-OTHERFORM')]);
// A form with no request, or one that points at a request that is not there, gives nothing.
addForm('t5v-f-loose-1', FORM, null);
addForm('t5v-f-loose-2', FORM, 't5v-q-missing');
// A VIRAL request that CE does hold (lab_requests) is a row as it is, and the form does not add a second one.
lab('T5V-VF-REAL', [{ ...viralSpec, forms: [FORM] }, { panel: 'VIRAL', obr: 2, req: 'ZSOUT' }],
  [hivvlOwn('T5V-VF-REAL'), min('T5V-VF-REAL', { obr_set_id: 2, lims_panel_code: 'VIRAL' })]);
lab('T5V-VF-REALONLY', [{ panel: 'VIRAL', forms: [FORM] }], [min('T5V-VF-REALONLY', { lims_panel_code: 'VIRAL' })]);

// ---- The window ----
// A request registered 00:30+02:00 on 05-01 is local May 1: in (UTC would say April 30). 00:30+02:00 on 06-01 is out.
const report = (o) => ({ status: 'final', ...o });
// Registered date.
lab('T5V-W-REG-IN-TZ', [{ authored: '2026-05-01T00:30:00+02:00' }], [min('T5V-W-REG-IN-TZ', { registered_date_time: '2026-05-01T00:30:00+02:00' })]);
lab('T5V-W-REG-OUT-TZ', [{ authored: '2026-06-01T00:30:00+02:00' }], [min('T5V-W-REG-OUT-TZ', { registered_date_time: '2026-06-01T00:30:00+02:00' })]);
lab('T5V-W-REG-OUT', [{ authored: '2026-04-30T23:59:59Z' }], [min('T5V-W-REG-OUT', { registered_date_time: '2026-04-30T23:59:59Z' })]);
lab('T5V-W-REG-LAST', [{ authored: '2026-05-31T23:59:59Z' }], [min('T5V-W-REG-LAST', { registered_date_time: '2026-05-31T23:59:59Z' })]);
// The period date: the specimen date, else the received date, else the registered date. The bucket date of
// vReceivedRequestsSummary (View lines 25-28) is the specimen date, else the registered date: it skips the received date.
// A request with a received date and no specimen date shows the difference: PER-RECEIVED is in a 'period' window and out
// of a 'specimen_or_registered' one (registered 04-01); SOR-RECEIVED-LATE is the other way round (received 06-20).
lab('T5V-W-PER-SPECIMEN', [{ authored: '2026-06-10T08:00:00Z', report: report({ effective: '2026-05-20T10:00:00Z' }) }],
  [min('T5V-W-PER-SPECIMEN', { registered_date_time: '2026-06-10T08:00:00Z', specimen_date_time: '2026-05-20T10:00:00Z', hl7_result_status_code: 'F' })]);
lab('T5V-W-PER-RECEIVED', [{ authored: '2026-04-01T08:00:00Z', report: report({ received: '2026-05-15T09:00:00Z' }) }],
  [min('T5V-W-PER-RECEIVED', { registered_date_time: '2026-04-01T08:00:00Z', received_date_time: '2026-05-15T09:00:00Z', hl7_result_status_code: 'F' })]);
lab('T5V-W-PER-SPECIMEN-OUT', [{ authored: '2026-05-10T08:00:00Z', report: report({ effective: '2026-04-01T07:00:00Z' }) }],
  [min('T5V-W-PER-SPECIMEN-OUT', { registered_date_time: '2026-05-10T08:00:00Z', specimen_date_time: '2026-04-01T07:00:00Z', hl7_result_status_code: 'F' })]);
lab('T5V-W-SOR-RECEIVED-LATE', [{ authored: '2026-05-12T08:00:00Z', report: report({ received: '2026-06-20T09:00:00Z' }) }],
  [min('T5V-W-SOR-RECEIVED-LATE', { registered_date_time: '2026-05-12T08:00:00Z', received_date_time: '2026-06-20T09:00:00Z', hl7_result_status_code: 'F' })]);
// The analysis date, with a form on the request: the VIRAL row has no analysis date, so it is out of an analysis window.
lab('T5V-W-AN-IN', [{ authored: '2026-04-01T08:00:00Z', analysis: '2026-05-31T23:30:00+02:00', forms: [FORM] }],
  [min('T5V-W-AN-IN', { registered_date_time: '2026-04-01T08:00:00Z', analysis_date_time: '2026-05-31T23:30:00+02:00' }),
    min('T5V-W-AN-IN', { registered_date_time: '2026-04-01T08:00:00Z', lims_panel_code: 'VIRAL' })]);
lab('T5V-W-AN-OUT', [{ authored: '2026-04-01T08:00:00Z', analysis: '2026-06-01T00:30:00+02:00' }],
  [min('T5V-W-AN-OUT', { registered_date_time: '2026-04-01T08:00:00Z', analysis_date_time: '2026-06-01T00:30:00+02:00' })]);
// The authorised date (diagnostic_reports.issued).
lab('T5V-W-AUTH-IN', [{ authored: '2026-04-01T08:00:00Z', report: report({ issued: '2026-05-01T00:30:00+02:00' }), forms: [FORM] }],
  [min('T5V-W-AUTH-IN', { registered_date_time: '2026-04-01T08:00:00Z', authorised_date_time: '2026-05-01T00:30:00+02:00', hl7_result_status_code: 'F' }),
    min('T5V-W-AUTH-IN', { registered_date_time: '2026-04-01T08:00:00Z', lims_panel_code: 'VIRAL' })]);
lab('T5V-W-AUTH-OUT', [{ authored: '2026-04-01T08:00:00Z', report: report({ issued: '2026-04-30T23:59:59Z' }) }],
  [min('T5V-W-AUTH-OUT', { registered_date_time: '2026-04-01T08:00:00Z', authorised_date_time: '2026-04-30T23:59:59Z', hl7_result_status_code: 'F' })]);
// A form on a request registered in the window gives a VIRAL row in the window; one registered out gives none.
lab('T5V-W-VIRAL-IN', [{ authored: '2026-05-05T08:00:00Z', forms: [FORM] }],
  [min('T5V-W-VIRAL-IN', { registered_date_time: '2026-05-05T08:00:00Z' }), min('T5V-W-VIRAL-IN', { registered_date_time: '2026-05-05T08:00:00Z', lims_panel_code: 'VIRAL' })]);
lab('T5V-W-VIRAL-OUT', [{ authored: '2026-06-05T08:00:00Z', forms: [FORM] }],
  [min('T5V-W-VIRAL-OUT', { registered_date_time: '2026-06-05T08:00:00Z' }), min('T5V-W-VIRAL-OUT', { registered_date_time: '2026-06-05T08:00:00Z', lims_panel_code: 'VIRAL' })]);

const SETUP = `insert into patients (id, surname, sex) values ${patients.join(',\n  ')};
insert into lab_requests (id, request_id, patient_id, panel_code, panel_desc, priority, authored_at, requester_code, analysis_at, point_of_care, request_type, registered_by, tested_by, requester_practitioner, clinical_info, analyzer_code, rejection_code, rejection_reason, obr_set_id, age_years, age_days) values ${requests.join(',\n  ')};
insert into specimens (id, received_time, type_code, type_text) values ${specimens.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, specimen_id, section_code, authorised_by) values ${reports.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${attrs.join(',\n  ')};
insert into questionnaire_responses (id, form_code, based_on_id, items, authored) values ${forms.join(',\n  ')};`;

// ---- Suites ----

const bind = (sqlText, params) => Object.entries(params)
  .reduce((s, [k, v]) => s.replaceAll(`{{param.${k}}}`, `'${v.replace(/'/g, "''")}'`), sqlText);

// A suite over `select * from vl`: column order, then the exact row set (duplicates counted) with its count.
function builderSuite(name, setup, cteSql, rows) {
  const key = (r) => JSON.stringify(COLUMNS.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `with ${cteSql} select ${lit(name)} || chr(9) || row_to_json(q)::text from (select * from vl) q;`,
    count: rows.length + 1,
    check(got) {
      const failures = [];
      if (got.length !== rows.length) failures.push(`expected ${rows.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), COLUMNS));
        if (Object.keys(got[0]).length !== COLUMNS.length) failures.push(`expected ${COLUMNS.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const tally = (list) => list.reduce((m, k) => m.set(k, (m.get(k) ?? 0) + 1), new Map());
      const have = tally(got.map(key));
      const want = tally(rows.map(key));
      for (const [k, n] of want) if ((have.get(k) ?? 0) !== n) failures.push(`row wanted ${n} time(s), got ${have.get(k) ?? 0}: ${k}`);
      for (const [k, n] of have) if (!want.has(k)) failures.push(`unexpected row (${n}): ${k}`);
      return failures;
    },
  };
}

// The rows whose date column is on a day from 2026-05-01 to 2026-05-31 (the first ten characters of the stamp).
const inDay = (stamp) => stamp !== null && stamp.slice(0, 10) >= '2026-05-01' && stamp.slice(0, 10) <= '2026-05-31';
const WINDOW = { from: '2026-05-01', to: '2026-05-31' };
const windowed = (on) => bind(vleidRequestsCte('vl', { from: 'from', to: 'to', ...(on ? { on } : {}) }), WINDOW);

const suites = [
  builderSuite('vleid-all', SETUP, vleidRequestsCte('vl'), expected),
  builderSuite('vleid-registered', '', windowed(), expected.filter((r) => inDay(r.registered_date_time))),
  builderSuite('vleid-registered-explicit', '', windowed('registered'), expected.filter((r) => inDay(r.registered_date_time))),
  builderSuite('vleid-period', '', windowed('period'), expected.filter((r) => inDay(r.specimen_date_time ?? r.received_date_time ?? r.registered_date_time))),
  builderSuite('vleid-specimen-or-registered', '', windowed('specimen_or_registered'), expected.filter((r) => inDay(r.specimen_date_time ?? r.registered_date_time))),
  builderSuite('vleid-analysis', '', windowed('analysis'), expected.filter((r) => inDay(r.analysis_date_time))),
  builderSuite('vleid-authorised', '', windowed('authorised'), expected.filter((r) => inDay(r.authorised_date_time))),
  {
    name: 'vleid-shape',
    count: 6,
    check() {
      const text = vleidRequestsCte('anyname');
      const bad = [];
      if (!text.startsWith('anyname as (')) bad.push(`must start with "anyname as (": ${text.slice(0, 30)}`);
      if (text.includes('{{param.')) bad.push('no window: must not mention a parameter');
      for (const half of [{ from: 'a' }, { to: 'b' }]) {
        try { vleidRequestsCte('x', half); bad.push(`half a window ${JSON.stringify(half)} must throw`); } catch { /* expected */ }
      }
      try { vleidRequestsCte('x', { from: 'a', to: 'b', on: 'nonsense' }); bad.push('an unknown "on" must throw'); } catch { /* expected */ }
      const withWindow = vleidRequestsCte('x', { from: 'a', to: 'b' });
      if (!withWindow.includes('{{param.a}}') || !withWindow.includes('{{param.b}}')) bad.push('window: must use the given parameter names');
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(text.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      return bad;
    },
  },
];

export const groups = [{ name: 't5-vleid', suites }];

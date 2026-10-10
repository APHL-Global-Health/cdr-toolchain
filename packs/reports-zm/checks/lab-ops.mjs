// Check groups for the lab-ops reports. Each task adds { name, suites } entries to this list.
//
// Group t5-vleid: the vleidrequests builder (v1 sp_UpdateVLEIDRequests and Table__dbo_VLEIDRequests.sql). Fixture ids
// start with "t5v-". Lab ids (lr.request_id) start with "T5V-".
// "v1 line N" below means a line of StoredProcedure__dbo_sp_UpdateVLEIDRequests.sql unless a file is named.

import { lit, inOrder } from '../../shared/pg-check.mjs';
import { ATTR_SYSTEM, vleidRequestsCte } from '../zm-sql.mjs';
import { queries } from '../queries/lab-ops.mjs';
import { facilityRows, orderedSuite, shapeSuite } from './epi-fixture.mjs';

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


// ==========================================================================================================================
// Group t25: the lab performance dashboards (v1 sp_dash_getLabStats, sp_dash_getLabStatsEID, sp_dash_getTBLabStats). Fixture ids start
// with "t25-". Lab numbers (lr.request_id) start with "T25-V-" (viral load), "T25-E-" (EID) and "T25-T-" (TB).
// "VL line N", "EID line N" and "TB line N" mean a line of StoredProcedure__dbo_sp_dash_getLabStats.sql, ..._getLabStatsEID.sql and
// ..._getTBLabStats.sql.
//
// The window is 2026-05-01 to 2026-05-31 unless a suite says otherwise. v1 adds a day to the end date and compares DATETIME columns
// with it, so a stamp counts from 2026-05-01 00:00:00 up to and including 2026-06-01 00:00:00 (local wall time of the stamp's text);
// only TB's authorised date is cast to a date, so its whole last day (2026-06-01) counts.
// Every rate is SQL Server's int * 100.0 / int: decimal(26,12), the quotient cut (not rounded) at 12 decimals. TB's rate columns are
// float. A value below is written the way it is worked out in the comment next to it.

const LAB_VL = 'VL lab performance';
const LAB_EID = 'EID lab performance';
const LAB_TB = 'TB lab performance';
const t25query = (name) => queries().find((q) => q.name === name);

const VL_COLUMNS = ['Laboratory', 'CollectedDate', 'ReceivedDate', 'VLTestRequests', 'ProcessedNotReviewed', 'ReviewedWithInvalids',
  'ValidTests', 'ValidTestsTotal', 'LabThroughput1', 'LabThroughput2', 'Referrals', 'Disalink', 'Suppressed', 'LabTestedWithin3days',
  'LabTestedWithin7days', 'LabTestedWithin14days'];
const EID_COLUMNS = ['Laboratory', 'CollectedDate', 'ReceivedDate', 'EIDTestRequests', 'ProcessedNotReviewed', 'ReviewedWithInvalids',
  'ValidTests', 'ValidTestsTotal', 'LabThroughput1', 'LabThroughput2', 'Rejections', 'Referrals', 'Disalink', 'Positive', 'Negative',
  'Indeterminate', 'Error', 'Invalid', 'LabTestedWithin1days', 'LabTestedWithin2days', 'LabTestedWithin3days', 'LabTestedWithin7days',
  'LabTestedWithin14days'];
const TB_COLUMNS = ['Laboratory', 'CollectedDate', 'ReceivedDate', 'TBTestRequests', 'TotalTests', 'ProcessedNotReviewed',
  'ReviewedWithInvalids', 'LabThroughput', 'LabThroughput2', 'MTB_Positive', 'RIF_Positive', 'RIF_Indeterminate', 'NoResults', 'Errors',
  'Invalids', 'MTB_Positivity', 'No_Result_Rate', 'RIF_IND_Rate', 'Error_Rate', 'Invalid_Rate', 'RIF_RES_Rate', 'TATW24H', 'TATW48H',
  'TATW72H'];

// The constant lab names of each procedure, typed again here from the v1 text (VL lines 69-91, EID lines 73-105, TB lines 62-82).
const VL_NAMES = [
  ['ZMP', 'Lewanika General Hospital'], ['ZCM', 'Choma General Hospital'], ['ZFP', 'Levy Mwanawasa UTH'], ['ZKM', 'Kaoma District Hospital'],
  ['ZKS', 'Kasama General Hospital'], ['ZSJ', 'Serenje District Hospital'], ['ZUL', 'UTH Virology Laboratory'],
  ['ZCP', 'Chipata Central Hospital'], ['ZML', 'Mansa General Hospital'], ['ZUA', 'UTH HAP ACOE'], ['ZCH', 'CHAZ Complex Laboratory'],
  ['ZNP', 'Ndola Teaching Hospital'], ['ZLR', 'Livingstone Teaching Hospital'], ['ZMG', 'Minga Mission Hospital'],
  ['ZBP', 'Kabwe General Hospital'], ['ZCN', 'Chinsali District Hospital'], ['ZCD', 'New Chinsali District Hospital'],
  ['ZKT', 'Kitwe Teaching Hospital'], ['ZMB', 'Mazabuka General Hospital'], ['ZSP', 'Solwezi General Hospital'],
  ['ZAP', 'Arthur Davison Childrens Hospital'], ['ZUE', 'UTH HAP PCOE'], ['ZTV', 'TDRC Laboratory'],
];
const EID_NAMES = [
  ['ZMP', 'Lewanika General Hospital'], ['ZCM', 'Choma General Hospital'], ['ZFP', 'Levy Mwanawasa UTH'], ['ZKM', 'Kaoma District Hospital'],
  ['ZKS', 'Kasama General Hospital'], ['ZSJ', 'Serenje District Hospital'], ['ZUL', 'UTH Virology Laboratory'],
  ['ZCP', 'Chipata Central Hospital'], ['ZML', 'Mansa General Hospital'], ['ZUA', 'UTH HAP PCOE'], ['ZCH', 'CHAZ Complex Laboratory'],
  ['ZNP', 'Ndola Teaching Hospital'], ['ZLR', 'Livingstone Teaching Hospital'], ['ZMG', 'Minga Mission Hospital'],
  ['ZBP', 'Kabwe General Hospital'], ['ZCN', 'Chinsali District Hospital'], ['ZCD', 'New Chinsali District Hospital'],
  ['ZKT', 'Kitwe Teaching Hospital'], ['ZMB', 'Mazabuka General Hospital'], ['ZSP', 'Solwezi General Hospital'],
  ['ZAP', 'Arthur Davison Childrens Hospital'], ['ZUE', 'UTH HAP PCOE'], ['ZTV', 'TDRC Laboratory'],
  ['001', 'St. Luke Mission Hospital(Mphanshya)'], ['002', 'Chinyunyu Rural Health Center'], ['003', 'Chipata District Hospital'],
  ['004', 'Nyimba District Hospital'], ['005', 'Kalomo District Hospital'], ['013', 'Lundazi District Hospital'],
  ['ZMM', 'Musumali Health Post'], ['ZMT', 'Matero General Hospital'], ['ZMJ', 'Mwanjuni Health Post'], ['ZCW', 'Chawama General Hospital'],
];
const TB_NAMES = [
  ['ZMP', 'Lewanika General Hospital'], ['ZCM', 'Choma General Hospital'], ['ZFP', 'Levy Mwanawasa UTH'], ['ZKM', 'Kaoma District Hospital'],
  ['ZKS', 'Kasama General Hospital'], ['ZSJ', 'Serenje District Hospital'], ['ZUL', 'UTH Virology Laboratory'],
  ['ZCP', 'Chipata Central Hospital'], ['ZML', 'Mansa General Hospital'], ['ZCH', 'CHAZ Complex Laboratory'],
  ['ZNP', 'Ndola Teaching Hospital'], ['ZLR', 'Livingstone Teaching Hospital'], ['ZMG', 'Minga Mission Hospital'],
  ['ZBP', 'Kabwe General Hospital'], ['ZCN', 'Chinsali District Hospital'], ['ZKT', 'Kitwe Teaching Hospital'],
  ['ZMB', 'Mazabuka General Hospital'], ['ZSP', 'Solwezi General Hospital'], ['ZAP', 'Arthur Davison Childrens Hospital'],
  ['ZTT', 'TDRC Laboratory'], ['ZNY', 'Nyimba District Hospital Laboratory'],
];

const T25_ATTR = 'urn:openldr:cs:request-attribute';

function group25() {
  // ---- The fixture ----
  const patients = [];
  const requests = [];
  const reports = [];
  const specimens = [];
  const results = [];
  const attrs = [];
  let n = 0;
  const numSql = (v) => (v === null || v === undefined ? 'null' : String(v));

  // One request row with its report (a lab number can have several rows). `perf` is the report's testing lab code (OPENLDR_LAB_CODE).
  function addReq(labId, perf, base, o = {}) {
    const r = { ...base, ...o };
    n += 1;
    const qid = `t25-q${n}`;
    let pid = null;
    if (r.sex) {
      pid = `t25-p${n}`;
      patients.push(`(${lit(pid)}, ${lit(`S${n}`)}, ${lit(r.sex)})`);
    }
    requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(pid)}, ${lit(r.panel)}, ${lit(r.authored)}, ${lit(r.req)}, ${lit(r.analysis)}, ${numSql(r.obr)}, ${numSql(r.years)}, ${numSql(r.days)})`);
    if (r.report) {
      const sid = r.recv ? `t25-s${n}` : null;
      if (sid) specimens.push(`(${lit(sid)}, ${lit(r.recv)})`);
      reports.push(`(${lit(`t25-d${n}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.eff)}, ${lit(r.iss)}, ${lit(perf)}, ${lit(r.display)}, ${lit(sid)})`);
    }
    r.results.forEach((x, i) => {
      results.push(`(${lit(`t25-r${n}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${numSql(x.num)}, ${lit(x.cmp ?? null)}, ${lit(x.coded ?? null)})`);
    });
    r.attrs.forEach((a, i) => {
      attrs.push(`(${lit(`t25-a${n}-${i + 1}`)}, ${lit(qid)}, ${lit(T25_ATTR)}, ${lit(a.code)}, ${lit(a.value)})`);
    });
  }

  const COMMON = { req: 'ZSOUT', report: true, status: 'final', display: null, obr: 1, attrs: [], sex: null, years: null, days: null, analysis: null };
  const VLB = { ...COMMON, panel: 'HIVVL', authored: '2026-05-05T08:00:00Z', eff: '2026-05-04T08:00:00Z', recv: '2026-05-04T12:00:00Z',
    iss: '2026-05-06T10:00:00Z', results: [{ obs: 'HIVVL', num: 500 }] };
  const EIDB = { ...VLB, panel: 'HIVPC', results: [{ obs: 'HIVPC', text: 'Negative' }] };
  const gx = (mtb, rif) => [...(mtb === undefined ? [] : [{ obs: 'GXMTB', text: mtb }]), ...(rif === undefined ? [] : [{ obs: 'GXRIF', text: rif }])];
  const TBB = { ...COMMON, panel: 'TBGNX', authored: '2026-05-02T08:00:00Z', analysis: '2026-05-02T09:00:00Z', eff: '2026-05-01T07:00:00Z',
    recv: '2026-05-01T12:00:00Z', iss: '2026-05-03T10:00:00Z', sex: 'F', years: 30, days: 10950, results: gx('Detected', 'Not Detected') };
  const vl = (tag, perf, o) => addReq(`T25-V-${tag}`, perf, VLB, o);
  const eid = (tag, perf, o) => addReq(`T25-E-${tag}`, perf, EIDB, o);
  const tb = (tag, perf, o) => addReq(`T25-T-${tag}`, perf, TBB, o);
  const noResults = { results: [] };
  const mk = (columns) => (...v) => Object.fromEntries(columns.map((c, i) => [c, v[i]]));
  const byName = (rows) => [...rows].sort((a, b) => (a.Laboratory.toLowerCase() < b.Laboratory.toLowerCase() ? -1 : a.Laboratory.toLowerCase() > b.Laboratory.toLowerCase() ? 1 : 0));

  // =========================================================================================================================
  // VL
  // =========================================================================================================================
  const vlRow = mk(VL_COLUMNS);
  const vlExpected = [];
  // A lab with one request and one test, all defaults: registered 05-05, collected and received 05-04, tested 05-06, result 500.
  // Collected 1/1, Received 1/1, requests 1, processed 0 (no analysis stamp), reviewed 1 (authorised), valid 1, total 1, throughput 100,
  // referrals NULL (no receiving lab in CE), disalink 0, suppressed 1/1 (500 < 1000), tested 1 day after registration (within 3, 7, 14).
  const vlGen = (name, count = 1) => vlRow(name, 100, 100, count, 0, count, count, count, 100, 100, null, 0, 100, 100, 100, 100);

  // -- Choma (ZCM): counts, cut-not-round, the b rows that are not tests, the registered edges (VL lines 26-31, 45-47, 49, 60) --
  vl('ZCM-1', 'ZCM', { authored: '2026-05-02T08:00:00Z', analysis: '2026-05-02T12:00:00Z', eff: '2026-05-01T08:00:00Z', recv: '2026-05-01T12:00:00Z', iss: '2026-05-03T10:00:00Z', results: [{ obs: 'HIVVL', num: 500 }] });
  vl('ZCM-2', 'ZCM', { authored: '2026-05-02T08:00:00Z', eff: '2026-05-01T08:00:00Z', recv: null, iss: '2026-05-06T10:00:00Z', results: [{ obs: 'HIVVL', num: 5000 }], attrs: [{ code: 'prereg-registration-facility', value: 'ZSOUT' }] });
  vl('ZCM-3', 'ZCM', { authored: '2026-05-01T08:00:00Z', eff: null, recv: null, iss: '2026-05-09T10:00:00Z', results: [{ obs: 'HIVVL', num: 2000 }], attrs: [{ code: 'referring-request-id', value: 'ZSOUT-123' }] });
  vl('ZCM-4', 'ZCM', { authored: '2026-04-20T08:00:00Z', eff: '2026-04-20T08:00:00Z', recv: '2026-04-21T08:00:00Z', iss: '2026-05-05T10:00:00Z', results: [{ obs: 'HIVVL', num: 100 }] });
  vl('ZCM-B1', 'ZCM', { authored: '2026-05-10T08:00:00Z', status: 'cancelled', eff: null, recv: null, iss: null, ...noResults });
  vl('ZCM-B2', 'ZCM', { panel: 'POCVR', authored: '2026-05-12T08:00:00Z', analysis: '2026-05-13T08:00:00Z', iss: '2026-05-14T08:00:00Z', ...noResults });
  vl('ZCM-B3', 'ZCM', { panel: 'RTRI', authored: '2026-05-12T08:00:00Z', ...noResults });
  vl('ZCM-B4', 'ZCM', { authored: '2026-05-12T08:00:00Z', report: false, ...noResults });
  vl('ZCM-B5', 'ZCM', { panel: 'POHVL', authored: '2026-06-01T00:00:00+02:00', status: 'cancelled', iss: null, ...noResults });
  vl('ZCM-B6', 'ZCM', { authored: '2026-06-01T00:00:01+02:00', status: 'cancelled', iss: null, ...noResults });
  vl('ZCM-B7', 'ZCM', { authored: '2026-05-01T00:00:00+02:00', iss: '2026-05-20T08:00:00Z', ...noResults });
  // a: ZCM-1..4 (tested 05-03, 05-06, 05-09, 05-05). collected: 1, 2, 4 = 3 of 4 = 75. received: 1, 4 = 2 of 4 = 50.
  // ValidTests: registered in the window: 1, 2, 3 (ZCM-4 was registered in April) = 3. Total 4.
  // b (VL lines 45-49, 60): ZCM-1, 2, 3, B1, B2, B5 (06-01 00:00:00 is the end, in), B7 (05-01 00:00:00+02:00 is the start, in) = 7.
  //   Not counted: ZCM-4 (registered April), B3 (panel RTRI), B4 (no report, so no lab), B6 (one second after the end).
  //   processed (analysis stamp): ZCM-1, B2 = 2. reviewed (authorised stamp): ZCM-1, 2, 3, B2, B7 = 5.
  // Throughput1 3 x 100 / 7 = 42.857142857142|857 -> cut 42.857142857142. Throughput2 4 x 100 / 7 = 57.142857142857|142 -> 57.142857142857.
  // Disalink: ZCM-2 (pre-registration facility) and ZCM-3 (referring id starts with the known code ZSOUT) = 2 of 4 = 50.
  // Suppressed: 500 and 100 = 2 of 4 = 50. Days from registration to test: 1, 4, 8, 15: within 3 = 1 (25), within 7 = 2 (50), within 14 = 3 (75).
  vlExpected.push(vlRow('Choma General Hospital', 75, 50, 7, 2, 5, 3, 4, 42.857142857142, 57.142857142857, null, 50, 50, 25, 50, 75));

  // -- Lewanika (ZMP): date-boundary timeliness, local dates, and the tested edges (VL lines 28-30, 33) --
  const zmp = (k, o) => vl(`ZMP-${k}`, 'ZMP', o);
  zmp(1, { authored: '2026-05-01T23:50:00+02:00', iss: '2026-05-04T00:10:00+02:00' });   // 05-01 to 05-04: 3 date boundaries (20 minutes short of 3 days)
  zmp(2, { authored: '2026-05-01T00:30:00+02:00', iss: '2026-05-04T03:00:00+02:00' });   // local 05-01 to 05-04: 3 (as UTC 04-30 to 05-04 it would be 4)
  zmp(3, { authored: '2026-05-01T00:01:00Z', iss: '2026-05-04T23:59:00Z' });              // 3 boundaries although 3 days 23 hours passed
  zmp(4, { authored: '2026-05-01T23:59:00Z', iss: '2026-05-05T00:01:00Z' });              // 4 boundaries although only 3 days 2 minutes passed
  zmp(5, { authored: '2026-05-02T08:00:00Z', iss: '2026-05-09T08:00:00Z' });              // 7
  zmp(6, { authored: '2026-05-02T08:00:00Z', iss: '2026-05-16T08:00:00Z' });              // 14
  zmp(7, { authored: '2026-05-02T08:00:00Z', iss: '2026-05-17T08:00:00Z' });              // 15
  zmp(8, { authored: '2026-05-20T08:00:00Z', iss: '2026-05-10T08:00:00Z' });              // -10 (tested before registered: within every cut-off)
  zmp(9, { authored: null, iss: '2026-05-10T08:00:00Z' });                                // no registered stamp: in no cut-off, not valid, not a request in the window
  zmp(10, { authored: '2026-05-30T08:00:00Z', iss: '2026-06-01T00:00:00+02:00' });        // tested at the end instant (06-01 00:00:00): in. 2 days
  zmp(11, { authored: '2026-05-30T08:00:00Z', iss: '2026-06-01T00:00:01+02:00' });        // one second later: not a test in the window, still a request
  zmp(12, { authored: '2026-05-10T08:00:00Z', iss: '2026-05-01T00:00:00+02:00' });        // tested at the start instant (UTC 04-30): in. -9 days
  zmp(13, { authored: '2026-05-10T08:00:00Z', iss: '2026-04-30T23:59:59+02:00' });        // one second before the start: out of a, a request in b
  // a: ZMP-1..10 and 12 = 11 tests. Days: 3, 3, 3, 4, 7, 14, 15, -10, null, 2, -9.
  //   within 3: 1, 2, 3, 8, 10, 12 = 6. within 7: those and 4, 5 = 8. within 14: those and 6 = 9.
  //   valid: registered in the window: all but ZMP-9 = 10. collected and received: all 11 have both.
  // b: ZMP-1..8, 10, 11, 12, 13 = 12 (ZMP-9 has no registered stamp). reviewed: all 12 have an authorised stamp. processed 0.
  // 10 x 100 / 12 = 83.3333333333333|3 -> 83.333333333333. 11 x 100 / 12 = 91.66666666666666|7 -> 91.666666666666 (a rounded rate ends 667).
  // 6/11 = 54.545454545454|54, 8/11 = 72.727272727272|72, 9/11 = 81.818181818181|81 (all cut). Suppressed 11 of 11 (500 each).
  vlExpected.push(vlRow('Lewanika General Hospital', 100, 100, 12, 0, 12, 10, 11, 83.333333333333, 91.666666666666, null, 0, 100, 54.545454545454, 72.727272727272, 81.818181818181));

  // -- Serenje (ZSJ): a request needs no register row and any report status; the tests need both (VL lines 31, 48-60 against the builder) --
  vl('ZSJ-1', 'ZSJ', {});
  vl('ZSJ-2', 'ZSJ', { req: 'ZUNMP' });                                           // facility not in the register: no test, still a request
  vl('ZSJ-3', 'ZSJ', { status: 'cancelled', iss: null });                         // not final: no test, still a request
  vl('ZSJ-4', 'ZSJ', { panel: 'pohvl ' });                                        // the panel compares ignoring case and trailing spaces
  // a: ZSJ-1 and ZSJ-4 = 2. b: all four = 4. reviewed: all but the cancelled one = 3. valid 2. Throughput 2 x 100 / 4 = 50.
  vlExpected.push(vlRow('Serenje District Hospital', 100, 100, 4, 0, 3, 2, 2, 50, 50, null, 0, 100, 100, 100, 100));

  // -- Solwezi (ZSP): VLTestRequests counts request rows, not lab numbers (VL line 45); a test registered before the window is not valid --
  vl('ZSP-1', 'ZSP', {});
  vl('ZSP-2', 'ZSP', { panel: 'POCVR', results: [{ obs: 'POCVR', num: 500 }] });
  addReq('T25-V-ZSP-1', 'ZSP', VLB, { obr: 2, ...noResults });                    // a second request row of lab number ZSP-1 (OBR set 2)
  vl('ZSP-3', 'ZSP', { authored: '2026-04-10T08:00:00Z' });
  // a: ZSP-1, 2, 3 = 3 (days 1, 1, 26). b: ZSP-1, ZSP-1 again, ZSP-2 = 3 (ZSP-3 was registered in April). valid 2. reviewed 3.
  // 2 x 100 / 3 = 66.666666666666|66 -> cut 66.666666666666 (a rounded rate ends 667). 3 x 100 / 3 = 100. within 3, 7 and 14: 2 of 3.
  vlExpected.push(vlRow('Solwezi General Hospital', 100, 100, 3, 0, 3, 2, 3, 66.666666666666, 100, null, 0, 100, 66.666666666666, 66.666666666666, 66.666666666666));

  // -- ZU_ codes become ZUL, except ZUE and ZUA (VL lines 41, 56, 62; the builder for the tests) --
  vl('ZUL-1', 'ZUB', { display: 'Bravo Name' });
  vl('ZUL-2', 'ZUH', {});
  vl('ZUL-3', 'zul', { display: 'Zul Named' });                                   // the ZU_ fold gives ZUL; this row's own code is zul
  vlExpected.push(vlGen('UTH Virology Laboratory', 3));
  vl('ZUE-1', 'ZUE', {});
  vlExpected.push(vlGen('UTH HAP PCOE'));
  vl('ZUA-1', 'ZUA', {});
  vlExpected.push(vlGen('UTH HAP ACOE'));

  // -- ZLP becomes ZLR (VL lines 24, 35, 42, 63). Lab codes compare ignoring case and trailing spaces. --
  vl('ZLR-1', 'ZLP', {});
  vl('ZLR-2', 'ZLR', {});
  vl('ZLR-3', 'zlr ', {});
  vlExpected.push(vlGen('Livingstone Teaching Hospital', 3));

  // -- The other 14 listed labs, one request and one test each. ZKM is written in lower case and has a display that the constant name ignores --
  const vlSimple = ['ZFP', 'ZKS', 'ZCP', 'ZML', 'ZCH', 'ZNP', 'ZMG', 'ZBP', 'ZCN', 'ZCD', 'ZKT', 'ZMB', 'ZAP', 'ZTV'];
  for (const code of vlSimple) {
    vl(code, code, {});
    vlExpected.push(vlGen(VL_NAMES.find(([c]) => c === code)[1]));
  }
  vl('ZKM', 'zkm', { display: 'Kaoma Dict Name' });
  vlExpected.push(vlGen('Kaoma District Hospital'));

  // -- Numeric codes are point-of-care labs (isnumeric, VL line 32). The name is the dictionary's: one name per code (Task 16 rule) --
  vl('N001-1', '001', { display: 'zeta two' });
  vl('N001-2', '001', { display: 'alpha one' });
  vl('N001-3', '001', {});                                                         // no display: the name is the code itself
  vlExpected.push(vlGen('alpha one', 3));                                          // the smallest name that is not just the code
  vl('N12', '12', {});                                                             // the register names it
  vlExpected.push(vlGen('Twelve Register Name'));
  vl('N1E5', '1E5', {});                                                           // isnumeric is true for 1E5; no name anywhere: the code
  vlExpected.push(vlGen('1E5'));
  // -- Repeating fractions, so that SQL Server's decimal(26,12) cut can be told from a float (v1 lines 26-27 of the VL procedure: count(x) * 100.0 / count(*)).
  // Lab 99 (numeric, so a POC lab), 3 tests, all registered 05-05 and tested 05-06:
  //   collected: Q1 and Q2 have a collected date, Q3 not = 2 of 3 = 66.666666666666 (a float gives 66.66666666666667)
  //   received: only Q1 has a received date = 1 of 3 = 33.333333333333 (a float: 33.333333333333336)
  //   disalink: only Q1 has a pre-registration facility = 1 of 3 = 33.333333333333
  //   suppressed: Q1 (500) and Q3 (500), not Q2 (5000) = 2 of 3 = 66.666666666666
  vl('REP-1', '99', { attrs: [{ code: 'prereg-registration-facility', value: 'ZSOUT' }] });
  vl('REP-2', '99', { recv: null, results: [{ obs: 'HIVVL', num: 5000 }] });
  vl('REP-3', '99', { eff: null, recv: null });
  vlExpected.push(vlRow('99', 66.666666666666, 33.333333333333, 3, 0, 3, 3, 3, 100, 100, null, 33.333333333333, 66.666666666666, 100, 100, 100));
  // Two labs with one name: ordered by the next column (requests 1, then 2).
  vl('N88', '88', { display: 'Tied Name' });
  vl('N89-1', '89', { display: 'Tied Name' });
  vl('N89-2', '89', {});
  vlExpected.push(vlGen('Tied Name'), vlGen('Tied Name', 2));

  // -- The join starts from the requests (VL line 95): a lab with a test and no request in the window does not show --
  vl('N77-AONLY', '77', { authored: '2026-04-10T08:00:00Z' });

  // -- Left out: a code that is not listed and not a number, and a test with no testing lab (receiving lab is not carried) --
  ['ZXX', 'ZCX', 'ABC12', 'ZZZ'].forEach((code) => vl(`OUT-${code}`, code, {}));
  vl('OUT-BLANK', '', {});
  vl('OUT-SPACES', '   ', {});
  vl('OUT-NULL', null, {});

  // -- Variants of this fixture --
  // Choma and the other labs of the first window are not in this one; a b-only lab: Kaoma has requests and no result.
  // (See the variant suites below.)

  // =========================================================================================================================
  // EID
  // =========================================================================================================================
  const eidRow = mk(EID_COLUMNS);
  const eidExpected = [];
  // One request, one test, all defaults: result Negative, received 05-04, tested 05-06 (2 days: not within 1, within 2, 3, 7, 14).
  const eidGen = (name, count = 1) => eidRow(name, 100, 100, count, 0, count, count, count, 100, 100, 0, null, 0, 0, 100, 0, 0, 0, 0, 100, 100, 100, 100);

  // -- Lewanika (ZMP): timeliness from the RECEIVED date (EID lines 33-37), the join, and the edges --
  const ezmp = (k, o) => eid(`ZMP-${k}`, 'ZMP', o);
  ezmp(1, { recv: '2026-05-01T23:50:00+02:00', iss: '2026-05-02T00:10:00+02:00', analysis: '2026-05-02T08:00:00Z' });   // 1 boundary
  ezmp(2, { recv: '2026-05-01T00:30:00+02:00', iss: '2026-05-02T03:00:00+02:00' });   // local 05-01 to 05-02: 1 (as UTC 04-30 to 05-02 it would be 2)
  ezmp(3, { authored: '2026-04-28T08:00:00Z', recv: '2026-05-01T08:00:00Z', iss: '2026-05-03T08:00:00Z' });  // 2; registered in April
  ezmp(4, { recv: '2026-05-01T08:00:00Z', iss: '2026-05-04T08:00:00Z' });   // 3
  ezmp(5, { eff: null, recv: '2026-05-01T08:00:00Z', iss: '2026-05-08T08:00:00Z' });   // 7
  ezmp(6, { recv: '2026-05-01T08:00:00Z', iss: '2026-05-15T08:00:00Z' });   // 14
  ezmp(7, { eff: null, recv: '2026-05-01T08:00:00Z', iss: '2026-05-16T08:00:00Z' });   // 15
  ezmp(8, { recv: '2026-05-20T08:00:00Z', iss: '2026-05-10T08:00:00Z' });   // -10: in every bucket
  ezmp(9, { recv: null, iss: '2026-05-06T10:00:00Z' });                     // not received: in no bucket
  ezmp(10, { recv: '2026-05-01T00:01:00Z', iss: '2026-05-02T23:59:00Z' });  // 1 boundary although 1 day 23 hours passed
  ezmp(11, { recv: '2026-05-01T23:59:00Z', iss: '2026-05-03T00:01:00Z' });  // 2 boundaries although only 1 day 2 minutes passed
  ezmp(12, { authored: '2026-05-30T08:00:00Z', recv: '2026-05-30T08:00:00Z', iss: '2026-06-01T00:00:00+02:00' });   // tested at the end instant: in. 2
  ezmp(13, { recv: '2026-05-30T08:00:00Z', iss: '2026-06-01T00:00:01+02:00', analysis: '2026-06-01T08:00:00Z' });   // one second later: a request only
  ezmp(14, { recv: '2026-04-30T08:00:00Z', iss: '2026-05-01T00:00:00+02:00' });   // tested at the start instant: in. 1
  ezmp(15, { iss: '2026-04-30T23:59:59+02:00' });                           // one second before the start: a request only
  ezmp(16, { status: 'cancelled', iss: null, recv: null, eff: null, ...noResults });  // rejected: counts in Rejections and in requests, not reviewed
  // a: EZ-1..12 and 14 = 13 tests, days 1, 1, 2, 3, 7, 14, 15, -10, null, 1, 2, 2, 1.
  //   within 1: 1, 2, 8, 10, 14 = 5. within 2: those and 3, 11, 12 = 8. within 3: and 4 = 9. within 7: and 5 = 10. within 14: and 6 = 11.
  //   received: all but EZ-9 = 12 of 13. collected: all but EZ-5 and EZ-7 = 11 of 13 (11/13 = 84.615384615384|615). valid (registered in the window): all but EZ-3 = 12.
  // b: every request but EZ-3 (registered in April) = 15. processed: EZ-1 and EZ-13 = 2. reviewed: all but EZ-16 = 14. rejections 1 (EZ-16).
  // 12 x 100 / 15 = 80. 13 x 100 / 15 = 86.66666666666666|7 -> 86.666666666666. 12/13 = 92.307692307692|307, 5/13 = 38.461538461538|46,
  // 8/13 = 61.538461538461|538 (rounded: ...462), 9/13 = 69.230769230769|23, 10/13 = 76.923076923076|92 (rounded: ...077), 11/13 = 84.615384615384|615 (rounded: ...385).
  eidExpected.push(eidRow('Lewanika General Hospital', 84.615384615384, 92.307692307692, 15, 2, 14, 12, 13, 80, 86.666666666666, 1, null, 0, 0, 100, 0, 0, 0, 38.461538461538, 61.538461538461, 69.230769230769, 76.923076923076, 84.615384615384));

  // -- Choma (ZCM): the result classes, Disalink, Rejections, the panels (EID lines 28-32, 56, 58) --
  const ezcm = (k, text, o = {}) => eid(`ZCM-${k}`, 'ZCM', { results: [{ obs: 'HIVPC', text }], ...o });
  ezcm(1, 'Positive');
  ezcm(2, 'POS');
  ezcm(3, 'Negative');
  ezcm(4, 'NDET');
  ezcm(5, 'Indeterminate');
  ezcm(6, 'Error');
  ezcm(7, 'Invalid');
  ezcm(8, 'INVAL');                                                       // on no list (v1 lists VALID): no class
  ezcm(9, 'Weird');                                                       // on no list
  ezcm(10, 'Detected DBS', { attrs: [{ code: 'prereg-registration-facility', value: 'ZSOUT' }] });
  ezcm(16, 'NORES');                                                      // Indeterminate (the builder lists Indeterminate and NORES)
  ezcm(17, 'VALID');                                                      // Invalid (v1 lists Invalid and VALID)
  ezcm(18, 'Invalid');
  eid('ZCM-11', 'ZCM', { panel: 'POCGH', analysis: '2026-05-06T09:00:00Z', ...noResults });
  eid('ZCM-12', 'ZCM', { panel: 'POEID', status: 'cancelled', iss: null, ...noResults });
  eid('ZCM-13', 'ZCM', { panel: 'RTRI', ...noResults });
  eid('ZCM-14', 'ZCM', { report: false, ...noResults });
  eid('ZCM-15', 'ZCM', { panel: 'hivpc ', status: 'cancelled', iss: null, ...noResults });
  // a: ZCM-1..10 and 16..18 = 13 tests. Positive: 1, 2, 10 = 3 of 13 = 23.076923076923|07. Negative: 3, 4 = 2 of 13 = 15.384615384615|38.
  //   Indeterminate: 5, 16 = 2 of 13 = 15.384615384615. Error: 6 = 1 of 13 = 7.692307692307|69 (a rounded rate ends 308). Invalid: 7, 17, 18 = 23.076923076923.
  //   Disalink: ZCM-10 = 1 of 13 = 7.692307692307.
  // b: ZCM-1..10, 16..18, ZCM-11 (POCGH), ZCM-12 (POEID), ZCM-15 (panel in lower case) = 16. ZCM-13 is RTRI and ZCM-14 has no report.
  //   processed: ZCM-11 = 1. reviewed: the 13 tests and ZCM-11 = 14. rejections: ZCM-12 and ZCM-15 = 2 (cancelled is v1's X).
  // 13 x 100 / 16 = 81.25. Received 2 days after: within 1 = 0, the others 100.
  eidExpected.push(eidRow('Choma General Hospital', 100, 100, 16, 1, 14, 13, 13, 81.25, 81.25, 2, null, 7.692307692307, 23.076923076923, 15.384615384615, 15.384615384615, 7.692307692307, 23.076923076923, 0, 100, 100, 100, 100));

  // -- ZUA is folded into ZUE in the tests but not in the requests (EID lines 25, 43, 49-51) --
  eid('ZUA-1', 'ZUA', {});
  eid('ZUA-2', 'ZUA', {});
  eid('ZUA-3', 'ZUA', noResults);
  eid('ZUE-1', 'ZUE', {});
  eid('ZUE-2', 'ZUE', noResults);
  // a: ZUA-1, ZUA-2, ZUE-1 = 3 tests in group ZUE. b: group ZUE holds ZUE-1 and ZUE-2 only = 2 requests (the 3 ZUA requests are group ZUA,
  // which no test has). Throughput 3 x 100 / 2 = 150. reviewed 2.
  eidExpected.push(eidRow('UTH HAP PCOE', 100, 100, 2, 0, 2, 3, 3, 150, 150, 0, null, 0, 0, 100, 0, 0, 0, 0, 100, 100, 100, 100));

  // -- The join starts from the tests (EID lines 110-111): a lab with tests and no request in the window still shows --
  eid('ZKM-1', 'ZKM', { authored: '2026-04-10T08:00:00Z' });
  // a: 1 test, registered in April: ValidTests 0, ValidTestsTotal 1. b: none, so every b column and both throughputs are NULL.
  eidExpected.push(eidRow('Kaoma District Hospital', 100, 100, null, null, null, 0, 1, null, null, null, null, 0, 0, 100, 0, 0, 0, 0, 100, 100, 100, 100));
  // ... and a lab with requests and no test does not show.
  eid('ZB1-1', 'ZB1', noResults);

  // -- ZLP becomes ZLR, ZU_ becomes ZUL (not ZUE, ZUA) --
  eid('ZLR-1', 'ZLP', {});
  eid('ZLR-2', 'ZLR', {});
  eid('ZLR-3', 'zlr ', {});
  eidExpected.push(eidGen('Livingstone Teaching Hospital', 3));
  eid('ZUL-1', 'ZUB', {});
  eid('ZUL-2', 'ZUH', {});
  eid('ZUL-3', 'ZUL', {});
  addReq('T25-E-ZUL-1', 'ZUB', EIDB, { obr: 2, ...noResults });                // a second request row of lab number ZUL-1: EIDTestRequests counts rows
  // 3 tests, 4 request rows: throughput 3 x 100 / 4 = 75.
  eidExpected.push(eidRow('UTH Virology Laboratory', 100, 100, 4, 0, 4, 3, 3, 75, 75, 0, null, 0, 0, 100, 0, 0, 0, 0, 100, 100, 100, 100));

  // -- The other 26 labs with a constant name; ZFP has a display that the constant name ignores --
  const eidSimple = ['ZFP', 'ZKS', 'ZSJ', 'ZCP', 'ZML', 'ZCH', 'ZNP', 'ZMG', 'ZBP', 'ZCN', 'ZCD', 'ZKT', 'ZMB', 'ZSP', 'ZAP', 'ZTV', '001', '002', '003', '004',
    '005', '013', 'ZMM', 'ZMT', 'ZMJ', 'ZCW'];
  for (const code of eidSimple) {
    eid(`S-${code}`, code, code === 'ZFP' ? { display: 'Ignored Display' } : {});
    eidExpected.push(eidGen(EID_NAMES.find(([c]) => c === code)[1]));
  }

  // -- A code with no constant name: the dictionary's name. Any code but the five excluded ones is a lab (no list, no isnumeric test) --
  eid('D-ZXD', 'ZXD', { display: 'Display Dict EID' });
  eidExpected.push(eidGen('Display Dict EID'));
  eid('D-777', '777', {});
  eidExpected.push(eidGen('777'));
  // -- Throughput as a repeating fraction (decimal, cut): 1 test and 3 requests give 1 x 100 / 3 = 33.333333333333 for both throughputs. --
  eid('R3-1', 'ZR3', {});
  eid('R3-2', 'ZR3', noResults);
  eid('R3-3', 'ZR3', noResults);
  eidExpected.push(eidRow('ZR3', 100, 100, 3, 0, 3, 1, 1, 33.333333333333, 33.333333333333, 0, null, 0, 0, 100, 0, 0, 0, 0, 100, 100, 100, 100));

  // -- Left out: the five excluded codes (any case, trailing spaces), and a test with no testing lab --
  ['ZZZ', 'MNC', 'MZM', 'ZNN', 'XXX', 'xxx '].forEach((code, i) => eid(`OUT-${i}`, code, {}));
  eid('OUT-BLANK', '', {});
  eid('OUT-NULL', null, {});

  // =========================================================================================================================
  // TB
  // =========================================================================================================================
  const tbRow = mk(TB_COLUMNS);
  const tbExpected = [];
  // One request, one test, all defaults: MTB Detected, RIF Not Detected, registered 05-02, authorised 05-03, 51 hours from the specimen.
  // Everything is 1 of 1. RIF resistance and indeterminate rates: none of the one MTB-positive test is resistant or indeterminate = 0.
  // 51 hours is under 72 only.
  const tbGen = (name) => tbRow(name, 100, 100, 1, 1, 1, 1, 100, 100, 1, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 100);

  // -- Choma (ZCM): the all-time measures against the window (TB lines 23-44, 50-58) --
  const tzcm = (k, o) => tb(`ZCM-${k}`, 'ZCM', o);
  const wide = '2026-06-01T10:00:00+02:00';
  tzcm(1, {});
  tzcm(2, { eff: '2026-05-02T08:00:00Z', iss: '2026-05-02T20:00:00Z', results: gx('Detected', 'Detected') });                // 12 hours
  tzcm(3, { eff: '2026-05-02T08:00:00Z', iss: '2026-05-04T07:00:00Z', results: gx('Detected', 'Indeterminate') });         // 47 hours
  tzcm(4, { results: gx('Not Detected', 'Error') });
  tzcm(5, { results: gx('Invalid', 'Not Detected') });
  tzcm(6, { results: gx('NORES', 'NORES') });
  tzcm(7, { results: gx('', 'Not Detected') });                                                                          // an empty MTB text counts as no result
  tzcm(8, { authored: '2026-03-10T08:00:00Z', eff: '2026-03-10T08:00:00Z', iss: '2026-03-12T10:00:00Z', results: gx('Detected', 'Detected_Low') });  // March: outside the window
  tzcm(9, { authored: '2026-05-30T08:00:00Z', iss: '2026-06-01T20:00:00+02:00', results: gx('Not Detected', 'Not Detected') });   // authorised on the day after the end: in
  tzcm(10, { authored: '2026-05-30T08:00:00Z', iss: '2026-06-02T00:30:00+02:00', results: gx('Not Detected', 'Not Detected') });  // two days after the end: out
  tzcm(11, { authored: '2026-06-01T00:00:00+02:00', iss: wide, results: gx('Not Detected', 'Not Detected') });             // registered at the end instant: in
  tzcm(12, { authored: '2026-06-01T00:00:01+02:00', iss: wide, results: gx('Not Detected', 'Not Detected') });             // one second later: out
  tzcm(13, { authored: '2026-05-01T00:00:00+02:00', results: gx('Not Detected', 'Not Detected') });                       // registered at the start instant: in
  tzcm(14, { authored: '2026-05-01T08:00:00Z', iss: '2026-04-30T23:30:00+02:00', results: gx('Not Detected', 'Not Detected') });   // authorised before the start: out
  tzcm(15, { eff: null, recv: null, results: gx('Not Detected') });                                                       // no collected or received date, no RIF result
  tzcm(16, { recv: null, results: gx('Detected') });                                                                      // no received date, no RIF result
  tb('ZCM-B1', 'ZCM', { analysis: '2026-05-11T09:00:00Z', iss: '2026-05-12T10:00:00Z', authored: '2026-05-10T08:00:00Z', ...noResults });
  tb('ZCM-B2', 'ZCM', { panel: 'POCGT', authored: '2026-05-10T08:00:00Z', status: 'cancelled', analysis: null, iss: null, ...noResults });
  tb('ZCM-B3', 'ZCM', { panel: 'RTRI', authored: '2026-05-10T08:00:00Z', ...noResults });
  tb('ZCM-B4', 'ZCM', { authored: '2026-05-10T08:00:00Z', report: false, ...noResults });
  tb('ZCM-B5', 'ZCM', { panel: 'tbgnx ', authored: '2026-05-10T08:00:00Z', analysis: null, ...noResults });
  // a (all time, TB lines 23-40): ZCM-1..16 = 16 rows. collected (specimen date): all but 15 = 15 -> 93.75. received: all but 15, 16 = 14 -> 87.5.
  //   MTB 'MTB Detected': 1, 2, 3, 8, 16 = 5. RIF in (Detected, DET, Detected_Low): 2, 8 = 2. RIF Indeterminate: 3 = 1.
  //   Errors (MTB or RIF 'Error'): 4. Invalids: 5. No results (MTB or RIF 'No Results' or an empty MTB): 6, 7 = 2.
  //   Positivity 5/16 = 31.25. No result 2/16 = 12.5. RIF indeterminate rate (MTB positive and RIF indeterminate) 1/5 = 20.
  //   Error rate 1/16 = 6.25. Invalid rate 6.25. RIF resistance rate (MTB positive and RIF positive) 2/5 = 40.
  //   Hours from the specimen to the authorised stamp: 51, 12, 47, 51, 51, 51, 51, 50, 755, 759, 745, 745, 51, -10, null, 51.
  //   under 24: 12 and -10 = 2 -> 12.5. under 48: 12, 47, -10 = 3 -> 18.75. under 72: 51 x 6 (1, 4, 5, 6, 7, 13), 16, 12, 47, 50, -10 = 11 -> 68.75.
  // TotalTests (line 23): registered in the window AND authored on a day from 05-01 to 06-01: 1-7, 9, 11, 13, 15, 16 = 12.
  //   Out: 8 (March), 10 (authored 06-02), 12 (registered 00:00:01 after the end), 14 (authored 04-30).
  // b (lines 50-58): the tests registered in the window: 1-7, 9, 10, 11, 13, 14, 15, 16 = 14, and B1, B2 (POCGT), B5 (panel in lower case) = 17.
  //   Not counted: ZCM-8 and ZCM-12 (registered outside), B3 (panel RTRI), B4 (no report).
  //   processed (analysis stamp): the 14 tests and B1 = 15. reviewed (authorised stamp): the 14 tests, B1 and B5 = 16.
  // LabThroughput 16 x 100 / 17 = 94.11764705882352|9 -> 94.117647058823. LabThroughput2 12 x 100 / 17 = 70.58823529411764|7 -> 70.588235294117.
  const zcmTb = tbRow('Choma General Hospital', 93.75, 87.5, 17, 12, 15, 16, 94.117647058823, 70.588235294117, 5, 2, 1, 2, 1, 1, 31.25, 12.5, 20, 6.25, 6.25, 40, 12.5, 18.75, 68.75);
  tbExpected.push(zcmTb);

  // -- The other 20 labs with a constant name. ZSJ is written in lower case with a trailing space, ZMG has the panel POCGT in lower case,
  // ZNY has a display (the constant name wins), ZBP has no MTB-positive test --
  const tbSimple = TB_NAMES.map(([c]) => c).filter((c) => c !== 'ZCM');
  for (const code of tbSimple) {
    const o = code === 'ZSJ' ? { perf: 'zsj ' } : {};
    const extra = code === 'ZMG' ? { panel: 'pocgt ' } : code === 'ZNY' ? { display: 'Nyimba Dict Lab' }
      : code === 'ZBP' ? { results: gx('Not Detected', 'Not Detected') } : {};
    tb(`S-${code}`, o.perf ?? code, extra);
    const name = TB_NAMES.find(([c]) => c === code)[1];
    // ZBP: MTB_Positive 0, positivity 0, and both RIF rates are NULL (nullif(sum, 0)).
    tbExpected.push(code === 'ZBP' ? tbRow(name, 100, 100, 1, 1, 1, 1, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0, null, 0, 0, null, 0, 0, 100) : tbGen(name));
  }
  // -- TBTestRequests counts request rows (line 50): a second request row of lab number ZKT. 1 test, 2 requests: processed 2, reviewed 2,
  // LabThroughput 2 x 100 / 2 = 100, LabThroughput2 1 x 100 / 2 = 50. (The ZKT row is replaced below.) --
  addReq('T25-T-S-ZKT', 'ZKT', TBB, { obr: 2, ...noResults });
  tbExpected.splice(tbExpected.findIndex((r) => r.Laboratory === 'Kitwe Teaching Hospital'), 1,
    tbRow('Kitwe Teaching Hospital', 100, 100, 2, 1, 2, 2, 100, 50, 1, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 0, 100));
  // -- TotalTests: authorised on the first day of the window (the whole day counts, TB line 23). 2 hours from the specimen: under 24, 48 and 72. --
  tb('EDGE', 'ZEDGE', { authored: '2026-05-01T08:00:00Z', recv: '2026-05-01T08:00:00Z', iss: '2026-05-01T09:00:00Z', results: gx('Not Detected', 'Not Detected') });
  tbExpected.push(tbRow('ZEDGE', 100, 100, 1, 1, 1, 1, 100, 100, 0, 0, 0, 0, 0, 0, 0, 0, null, 0, 0, null, 100, 100, 100));
  // -- The result words (TB lines 24-29, 31-32), after the builder's clean-up. Lab ZRIF is written two ways (ZRIF, zrif ): one lab. --
  // R1 MTB Detected, RIF 'DET' (the clean-up leaves it as it is, and it is on the list). R2 RIF 'Detected _ Low' (spaces: not on the list).
  // R3 'Positive' and 'R' become MTB Detected and Detected. R4 MTB negative with RIF Detected (RIF positive, not a resistant MTB case).
  // R5 MTB negative with RIF Indeterminate. R6 RIF Invalid. R7 MTB Error. R8 RIF no result (NORES). R9 MTB no result (NORES).
  // R10 RIF Error. R11 an empty MTB result.
  const zr = (k, perf, mtb, rif) => tb(`RIF-${k}`, perf, { results: gx(mtb, rif) });
  zr(1, 'ZRIF', 'Detected', 'DET');
  zr(2, 'ZRIF', 'Detected', 'Detected _ Low');
  zr(3, 'ZRIF', 'Positive', 'R');
  zr(4, 'ZRIF', 'Not Detected', 'Detected');
  zr(5, 'ZRIF', 'Not Detected', 'Indeterminate');
  zr(6, 'zrif ', 'Detected', 'Invalid');
  zr(7, 'zrif ', 'Error', 'Not Detected');
  zr(8, 'zrif ', 'Not Detected', 'NORES');
  zr(9, 'zrif ', 'NORES', 'Not Detected');
  zr(10, 'zrif ', 'Not Detected', 'Error');
  zr(11, 'zrif ', '', 'Not Detected');
  // 11 tests, 11 requests, all valid, 51 hours (under 72 only). MTB Detected: R1, R2, R3, R6 = 4. RIF Detected/DET/Detected_Low: R1, R3, R4 = 3.
  // RIF Indeterminate: R5 = 1. Errors (MTB or RIF): R7, R10 = 2. Invalids: R6 = 1. No result (either, or an empty MTB): R8, R9, R11 = 3.
  // Positivity 4/11, no result 3/11, error 2/11, invalid 1/11 (as floats). RIF indeterminate rate: MTB positive and RIF indeterminate: none = 0 of 4.
  // RIF resistance rate: MTB positive and RIF positive: R1, R3 = 2 of 4 = 50. TAT: 100 percent under 72, none under 24 or 48.
  tbExpected.push(tbRow('ZRIF', 100, 100, 11, 11, 11, 11, 100, 100, 4, 3, 1, 3, 2, 1, (4 * 100) / 11, (3 * 100) / 11, 0, (2 * 100) / 11, (1 * 100) / 11, 50, 0, 0, 100));
  // -- Decimal against float (TB lines 23, 30-39). CollectedDate and ReceivedDate are count(x) * 100.0 / nullif(count(*), 0): decimal(26,12), cut.
  // RIF_IND_Rate, RIF_RES_Rate and TATW24H/48H/72H are cast(.. as float) * 100.0 / nullif(.., 0): float. Lab ZREP has 6 tests, so that every one of
  // the seven is a repeating fraction (a decimal and a float then differ in the last digits). All six are registered 05-02 and authorised 05-03 or 05-04.
  //   P1 MTB Detected, RIF Detected, 12 hours.   P2 MTB Detected, RIF Detected, 47 hours.   P3 MTB Detected, RIF Indeterminate, 51 hours.
  //   P4 MTB and RIF Not Detected, 51 hours.     P5 MTB only, no collected and no received date, so no TAT.   P6 MTB only, no received date, 51 hours.
  //   (P5 and P6 have no GXRIF result because a missing fact loses the RIF in v_GeneXpert; P1 to P4 have every fact.)
  // collected: all but P5 = 5 of 6 = 83.333333333333 (decimal; a float is 83.33333333333333). received: all but P5 and P6 = 4 of 6 = 66.666666666666.
  // MTB positive 3 (P1 to P3). RIF indeterminate rate 1 of 3 MTB positive = 33.333333333333336. RIF resistance rate 2 of 3 = 66.66666666666667.
  // Under 24 hours: P1 = 1 of 6 = 16.666666666666668. Under 48: P1, P2 = 2 of 6 = 33.333333333333336. Under 72: P1 to P4 and P6 = 5 of 6 = 83.33333333333333.
  // Positivity 3 of 6 = 50. Six requests, six valid, all reviewed and processed.
  const rep = (k, o) => tb(`REP-${k}`, 'ZREP', o);
  rep(1, { eff: '2026-05-02T08:00:00Z', iss: '2026-05-02T20:00:00Z', results: gx('Detected', 'Detected') });
  rep(2, { eff: '2026-05-02T08:00:00Z', iss: '2026-05-04T07:00:00Z', results: gx('Detected', 'Detected') });
  rep(3, { results: gx('Detected', 'Indeterminate') });
  rep(4, { results: gx('Not Detected', 'Not Detected') });
  rep(5, { eff: null, recv: null, results: gx('Not Detected') });
  rep(6, { recv: null, results: gx('Not Detected') });
  tbExpected.push(tbRow('ZREP', 83.333333333333, 66.666666666666, 6, 6, 6, 6, 100, 100, 3, 2, 1, 0, 0, 0, 50, 0, (1 * 100) / 3, 0, 0, (2 * 100) / 3, (1 * 100) / 6, (2 * 100) / 6, (5 * 100) / 6));
  // -- No constant name: the dictionary's name. TB does not fold ZU_ codes. --
  tb('D-ZDX', 'ZDX', { display: 'Dictionary TB Lab' });
  tbExpected.push(tbGen('Dictionary TB Lab'));
  tb('D-ZNO', 'ZNO', {});
  tbExpected.push(tbGen('ZNO'));
  tb('D-ZUB', 'ZUB', {});
  tbExpected.push(tbGen('ZUB'));
  // -- The join starts from the requests (TB line 87): a lab with a test and no request in the window does not show --
  tb('A-ONLY', 'ZAO', { authored: '2026-04-10T08:00:00Z', iss: '2026-04-12T10:00:00Z' });
  // -- Left out: ZZZ, XXX, 000, in any case with trailing spaces; no lab (blank, spaces, none) --
  ['ZZZ', 'XXX', '000', 'zzz '].forEach((code, i) => tb(`OUT-${i}`, code, {}));
  tb('OUT-BLANK', '', {});
  tb('OUT-SPACES', '   ', {});
  tb('OUT-NULL', null, {});

  // =========================================================================================================================
  // The warehouse rows
  // =========================================================================================================================
  const FACILITIES = facilityRows('t25', [
    ['ZSOUT', 'Choma General Hospital', 'Southern', 'Choma'],
    ['ZUNMP', null, null, null, false],
    ['12', 'Twelve Register Name', 'Central', 'Kabwe'],
  ]);
  const setup = `${FACILITIES}
insert into patients (id, surname, sex) values ${patients.join(',\n  ')};
insert into lab_requests (id, request_id, patient_id, panel_code, authored_at, requester_code, analysis_at, obr_set_id, age_years, age_days) values
  ${requests.join(',\n  ')};
insert into specimens (id, received_time) values ${specimens.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, performer_display, specimen_id) values
  ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values
  ${results.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${attrs.join(',\n  ')};`;

  // =========================================================================================================================
  // Suites
  // =========================================================================================================================
  const MAY = { from: '2026-05-01', to: '2026-05-31' };
  const sqlOf = (name) => t25query(name)?.sql ?? `select 'x'::text as "Laboratory"`;

  // The exact rows IN ORDER (v1 orders by the first column). `only` keeps the rows of those laboratories (for the variants).
  function listSuite(name, queryName, params, columns, wanted, { only, before = '' } = {}) {
    const text = only ? `select z.* from (${sqlOf(queryName)}) z where z."Laboratory" in (${only.map(lit).join(', ')})` : sqlOf(queryName);
    const s = orderedSuite(name, text, params, columns, wanted);
    if (!t25query(queryName)) {
      const check = s.check;
      s.check = (got) => [`query "${queryName}" is missing`, ...check(got)];
    }
    if (before) {
      const sp = `sp_${name.replace(/[^a-z0-9]/gi, '_')}`;
      s.sql = `savepoint ${sp};\n${before}\n${s.sql}\nrollback to savepoint ${sp};`;
    }
    return s;
  }

  const shape = (name, queryName) => shapeSuite(name, t25query(queryName), ['from', 'to'], ['text', 'text']);

  // CE pages a result with LIMIT and OFFSET, so the ORDER BY must be total: the lab name in SQL Server's word order, then every other column.
  const orderSuite = (name, queryName, columns) => ({
    name,
    count: columns.length,
    check() {
      const q = t25query(queryName);
      if (!q) return [`query "${queryName}" is missing`];
      const tail = q.sql.slice(q.sql.lastIndexOf('order by'));
      const bad = [];
      if (!tail.includes('translate(rtrim(res.c01)')) bad.push('ORDER BY must start with the lab name in SQL Server word order (ssTextKey)');
      columns.forEach((c, i) => {
        const id = `res.c${String(i + 1).padStart(2, '0')}`;
        if (!tail.includes(id)) bad.push(`ORDER BY must list ${id} (${c})`);
      });
      return bad;
    },
  });

  const suites25 = [
    { name: 't25-setup', setup, count: 0, check: () => [] },
    shape('t25-shape-vl', LAB_VL),
    shape('t25-shape-eid', LAB_EID),
    shape('t25-shape-tb', LAB_TB),
    orderSuite('t25-order-vl', LAB_VL, VL_COLUMNS),
    orderSuite('t25-order-eid', LAB_EID, EID_COLUMNS),
    orderSuite('t25-order-tb', LAB_TB, TB_COLUMNS),
    listSuite('t25-vl-all', LAB_VL, MAY, VL_COLUMNS, byName(vlExpected)),
    listSuite('t25-eid-all', LAB_EID, MAY, EID_COLUMNS, byName(eidExpected)),
    listSuite('t25-tb-all', LAB_TB, MAY, TB_COLUMNS, byName(tbExpected)),
  ];

  // ---- Variants: the same fixture with some rows removed, or another window ----

  // VL: Kaoma with a request and no result is a b-only lab (the join starts from the requests). The constant name is read from the TEST lab
  // (a.TestedAt, VL line 68), which is missing: the name is the dictionary's, here the report's display.
  suites25.push(listSuite('t25-vl-b-only', LAB_VL, MAY, VL_COLUMNS, [
    vlRow('Kaoma Dict Name', null, null, 1, 0, 1, null, null, null, null, null, null, null, null, null, null),
  ], { only: ['Kaoma Dict Name', 'Kaoma District Hospital'], before: `delete from lab_results where request_id in (select id from lab_requests where request_id = 'T25-V-ZKM');` }));
  // VL: the ZU_ group with requests and no tests: the name comes from rows whose own code is ZUL (the code), not from ZUB's display.
  suites25.push(listSuite('t25-vl-b-only-zu', LAB_VL, MAY, VL_COLUMNS, [
    vlRow('Zul Named', null, null, 3, 0, 3, null, null, null, null, null, null, null, null, null, null),
  ], { only: ['ZUL', 'Zul Named', 'Bravo Name', 'UTH Virology Laboratory'], before: `delete from lab_results where request_id in (select id from lab_requests where request_id in ('T25-V-ZUL-1', 'T25-V-ZUL-2', 'T25-V-ZUL-3'));` }));
  // EID: ZUA tests alone. The tests are group ZUE, the requests are group ZUA, so no request count matches.
  suites25.push(listSuite('t25-eid-zua-only', LAB_EID, MAY, EID_COLUMNS, [
    eidRow('UTH HAP PCOE', 100, 100, null, null, null, 2, 2, null, null, null, null, 0, 0, 100, 0, 0, 0, 0, 100, 100, 100, 100),
  ], { only: ['UTH HAP PCOE'], before: `delete from lab_requests where request_id like 'T25-E-ZUE-%';` }));
  // TB: the same Choma request count in a March window, with every all-time measure unchanged (the window gap, TB lines 23-44).
  // b: ZCM-8 only (registered 03-10) = 1; TotalTests: registered 03-10 and authorised 03-12, both in [03-01, 04-01] = 1; processed 1, reviewed 1.
  suites25.push(listSuite('t25-tb-march', LAB_TB, { from: '2026-03-01', to: '2026-03-31' }, TB_COLUMNS, [
    tbRow('Choma General Hospital', 93.75, 87.5, 1, 1, 1, 1, 100, 100, 5, 2, 1, 2, 1, 1, 31.25, 12.5, 20, 6.25, 6.25, 40, 12.5, 18.75, 68.75),
  ]));
  // TB: Nyimba with requests and no result: b only. The constant name needs the test lab, so the name is the dictionary's (the display).
  // processed 1 (analysis stamp), reviewed 1, LabThroughput 1 x 100 / 1 = 100 comes from b alone; the a columns and LabThroughput2 are NULL.
  suites25.push(listSuite('t25-tb-b-only', LAB_TB, MAY, TB_COLUMNS, [
    tbRow('Nyimba Dict Lab', null, null, 1, null, 1, 1, 100, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null),
  ], { only: ['Nyimba Dict Lab', 'Nyimba District Hospital Laboratory'], before: `delete from lab_results where request_id in (select id from lab_requests where request_id = 'T25-T-S-ZNY');` }));

  return { name: 't25', suites: suites25 };
}

// ==========================================================================================================================
// Group t26: Days since last transmission, Suspect collection dates, DISA Link weekly stats (v1 sp_DQ_DaysSinceLastVLEIDTans,
// sp_DQ_VLEIDSuspectedWrongSampleCollectionDateEntries, sp_getDisaLinkStats over fn_WeeklyDisaLinkUpdate). Fixture ids start with
// "t26d-" (days since last transmission), "t26s-" (suspect dates) and "t26l-" (DISA Link). All three queries read the same tables, so
// every suite first deletes the rows of the other two (isolate) and runs inside a savepoint.
// "D line N", "S line N" and "L line N" mean a line of StoredProcedure__dbo_sp_DQ_DaysSinceLastVLEIDTans.sql,
// ..._VLEIDSuspectedWrongSampleCollectionDateEntries.sql and UserDefinedFunction__dbo_fn_WeeklyDisaLinkUpdate.sql.
//
// "Today" is the Zambian date (Africa/Lusaka, UTC+2): v1 getdate() is the clock of Zambia's SQL Server. Every stamp of the days
// fixture is written relative to it, so the expected days do not move. The fixture reads the date once, so the check can fail only if
// it runs across midnight in Lusaka.

const DAYS_Q = 'Days since last transmission';
const SUSPECT_Q = 'Suspect collection dates';
const DISALINK_Q = 'DISA Link weekly stats';
const t26query = (name) => queries().find((q) => q.name === name);

const DAYS_COLUMNS = ['Province', 'LabCode', 'LabName', 'LastTransmission'];
const SUSPECT_COLUMNS = ['Laboratory', 'Test Type', 'RequestID', 'Days from collection to accessioning'];
const DISALINK_COLUMNS = ['Facility', 'New Registrations', 'Tested', 'Reviewed', 'Tested from Old Requests', 'Tested & Reviewed from Old Requests'];

// The lab codes of D line 62, typed again from the v1 text (45 codes).
const D_EXCLUDED = ['ZXZ', 'ZZZ', 'MZM', 'MNC', 'XXX', 'ZNA', 'ZNC', 'ZLA', '005', '144', '028', '004', 'ZFI', '022', 'POC', 'ZDR', 'MAC',
  'MAF', 'MDR', 'ZCX', 'ZLX', 'ZMR', '094', '095', '068', '108', '001', '015', '073', '054', '009', '055', '091', '128', '131', '153', '154',
  '155', '125', '132', '161', '074', '026', '115', '097'];

const zmToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lusaka', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const utcDay = (iso) => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
const addDays = (iso, n) => new Date(utcDay(iso) + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((utcDay(b) - utcDay(a)) / 86400000);

// SQL Server's word sort for the characters the fixture uses: case and trailing spaces ignored, hyphens ignored, NULL first. Ties fall
// to the plain text (byte order), as the ORDER BY does.
const textKey = (s) => s.toLowerCase().replace(/-/g, '').trimEnd();
function byColumns(cols) {
  return (x, y) => {
    for (const [c, kind] of cols) {
      const a = x[c];
      const b = y[c];
      if (a === b) continue;
      if (a === null) return -1;
      if (b === null) return 1;
      if (kind === 'number') return a < b ? -1 : 1;
      const ka = textKey(a);
      const kb = textKey(b);
      if (ka !== kb) return ka < kb ? -1 : 1;
      return a < b ? -1 : 1;
    }
    return 0;
  };
}

function group26() {
  const TODAY = zmToday();
  const d = (n) => addDays(TODAY, -n);
  // A stamp n days before today at 10:00 local (+02:00, DISA's offset).
  const at = (n, time = '10:00:00') => `${d(n)}T${time}+02:00`;

  // ---- The fixture ----
  const requests = [];
  const reports = [];
  const results = [];
  const attrs = [];
  const maps = [];
  let n = 0;
  let m = 0;
  const num = (v) => (v === null || v === undefined ? 'null' : String(v));

  // One request row. `reports`: [{ perf, display, eff, iss, status, ss, ps }]. `results`: observation codes. `attrs`: [{ code, value, system }].
  const BASE = { panel: 'HIVVL', obr: 1, authored: null, analysis: null, reports: [], results: [], attrs: [] };
  function add(prefix, requestId, o = {}) {
    const r = { ...BASE, ...o };
    n += 1;
    const qid = `${prefix}q${n}`;
    requests.push(`(${lit(qid)}, ${lit(requestId)}, ${lit(r.panel)}, ${lit(r.authored)}, ${lit(r.analysis)}, ${num(r.obr)})`);
    r.reports.forEach((x, i) => reports.push(`(${lit(`${prefix}d${n}-${i + 1}`)}, ${lit(qid)}, ${lit(x.status ?? 'final')}, ${lit(x.eff ?? null)}, ${lit(x.iss ?? null)}, ${lit(x.perf ?? null)}, ${lit(x.display ?? null)}, ${lit(x.ss ?? null)}, ${lit(x.ps ?? null)})`));
    r.results.forEach((obs, i) => results.push(`(${lit(`${prefix}r${n}-${i + 1}`)}, ${lit(qid)}, ${lit(obs)})`));
    r.attrs.forEach((a, i) => attrs.push(`(${lit(`${prefix}a${n}-${i + 1}`)}, ${lit(qid)}, ${lit(a.system ?? T25_ATTR)}, ${lit(a.code)}, ${lit(a.value)})`));
    return qid;
  }
  // One facility_map row. `reg` is the register id (null: not in the register).
  function map(prefix, code, reg, name, region, { ss = '', ps = '' } = {}) {
    m += 1;
    maps.push(`(${lit(`${prefix}fm${m}`)}, ${lit(ss)}, ${lit(ps)}, ${lit(code)}, ${lit(reg)}, ${lit(name)}, ${lit(region)}, null)`);
  }

  // =========================================================================================================================
  // Days since last transmission (prefix t26d-)
  // =========================================================================================================================
  const D = 't26d-';
  const dRows = [];
  const dExpect = (province, code, name, days) => dRows.push({ Province: province, LabCode: code, LabName: name, LastTransmission: days });
  // A lab with its requests: `stamps` are registered stamps; every request has a report by `perf`.
  function dLab(perf, display, stamps, o = {}) {
    stamps.forEach((s, i) => add(D, `T26-D-${perf.trim() || 'BLANK'}-${i + 1}`, { authored: s, reports: [{ perf, display, ...(o.report ?? {}) }] }));
  }

  // -- Part a (D lines 18-36): the days since the latest registration of the lab's requests, whole local days --
  // D line 23: datediff(dd, max(RegisteredDateTime), getdate()) counts date boundaries. The latest of 10 and 3 days ago is 3.
  map(D, 'ZA1', 'RG-ZA1', 'Alpha Register', 'Southern');
  dLab('ZA1', 'Alpha Lab', [at(10), at(3)]);
  dExpect('Southern', 'ZA1', 'Alpha Lab', 3);
  // Today at 23:30+02:00 is 0. Today at 00:30+02:00 is 0 too (UTC says yesterday, which would give 1).
  map(D, 'ZA2', 'RG-ZA2', 'x', 'central');
  dLab('ZA2', 'Bravo Lab', [at(0, '23:30:00')]);
  dExpect('central', 'ZA2', 'Bravo Lab', 0);
  map(D, 'ZA3', 'RG-ZA3', 'x', 'Copperbelt');
  dLab('ZA3', 'Charlie Lab', [at(0, '00:30:00')]);
  dExpect('Copperbelt', 'ZA3', 'Charlie Lab', 0);
  // Five days ago at 23:59:59: date boundaries give 5. Elapsed whole days would give 4.
  map(D, 'ZA4', 'RG-ZA4', 'x', 'Lusaka');
  dLab('ZA4', 'Delta Lab', [at(5, '23:59:59')]);
  dExpect('Lusaka', 'ZA4', 'Delta Lab', 5);
  // A date-only stamp (midnight) yesterday is 1.
  map(D, 'ZA5', 'RG-ZA5', 'x', 'Lusaka');
  dLab('ZA5', 'Echo Lab', [d(1)]);
  dExpect('Lusaka', 'ZA5', 'Echo Lab', 1);
  // D line 64 compares an int with getdate() and is always true: a stamp tomorrow gives -1 and the row stays.
  dLab('ZNEG', 'Negative Lab', [at(-1, '09:00:00')]);
  dExpect(null, 'ZNEG', 'Negative Lab', -1);
  // D lines 18-36 have no panel condition: a lab whose only request is a TB panel is listed.
  add(D, 'T26-D-ZTB-1', { panel: 'TBGNX', authored: at(12), reports: [{ perf: 'ZTB', display: 'Tb Lab' }] });
  dExpect(null, 'ZTB', 'Tb Lab', 12);

  // -- The floor (D line 30): RegisteredDateTime > 2019-01-01 00:00:00, strictly --
  const since2019 = daysBetween('2019-01-01', TODAY);
  dLab('ZF1', 'Floor One', ['2019-01-01T00:00:00+02:00']);                    // = midnight: out
  dLab('ZF2', 'Floor Two', ['2019-01-01T00:00:01+02:00']);                    // one second after: in
  dExpect(null, 'ZF2', 'Floor Two', since2019);
  dLab('ZF3', 'Floor Three', ['2018-12-31T23:59:59+02:00']);                  // before: out
  dLab('ZF4', 'Floor Four', ['2019-01-01']);                                  // a date only is midnight: out
  dLab('ZF5', 'Floor Five', ['2019-01-01T01:00:00+02:00']);                   // local 01:00 is in (UTC would be 2018-12-31 and out)
  dExpect(null, 'ZF5', 'Floor Five', since2019);
  dLab('ZF6', 'Floor Six', ['2018-06-01T10:00:00+02:00']);                    // an old stamp of a lab with no other request: out
  // The floor is the parameter: three labs around a floor of six days ago (the variant suite moves the floor).
  dLab('ZV1', 'Vee One', [at(6, '00:00:00')]);
  dExpect(null, 'ZV1', 'Vee One', 6);
  dLab('ZV2', 'Vee Two', [at(6, '00:00:01')]);
  dExpect(null, 'ZV2', 'Vee Two', 6);
  dLab('ZV3', 'Vee Three', [at(7, '23:59:59')]);
  dExpect(null, 'ZV3', 'Vee Three', 7);

  // -- Lab codes compare ignoring case and trailing spaces (SQL Server collation). The spelling shown is the smallest in byte order. --
  // Two spellings are one lab; the latest request of either counts; the name is the smallest of the displays (Task 16 rule).
  map(D, 'ZN2', 'RG-ZN2', 'x', 'Lusaka');
  add(D, 'T26-D-ZN2-1', { authored: at(9), reports: [{ perf: 'ZN2', display: 'Zulu Name' }] });
  add(D, 'T26-D-ZN2-2', { authored: at(4), reports: [{ perf: 'zn2 ', display: 'Alpha Name' }] });
  dExpect('Lusaka', 'ZN2', 'Alpha Name', 4);

  // -- Lab names (spec ruling 8): the display, else the register name of the mapped code, else the code --
  map(D, 'ZR1', 'RG-ZR1', 'Register Lab Name', 'Lusaka');
  dLab('ZR1', null, [at(2)]);
  dExpect('Lusaka', 'ZR1', 'Register Lab Name', 2);
  dLab('ZC1', null, [at(6)]);
  dExpect(null, 'ZC1', 'ZC1', 6);
  dLab('ZC2', '  ', [at(7)]);
  dExpect(null, 'ZC2', 'ZC2', 7);
  // Two labs with one name stay two rows (v1 groups on the code and the name).
  dLab('ZS1', 'Same Name', [at(8)]);
  dLab('ZS2', 'Same Name', [at(8)]);
  dExpect(null, 'ZS1', 'Same Name', 8);
  dExpect(null, 'ZS2', 'Same Name', 8);
  // The facility mapping needs the report's own systems; a mapping of another performer system gives no province.
  map(D, 'ZSYS', 'RG-ZSYS', 'x', 'Southern');
  dLab('ZSYS', 'Sys Lab', [at(3)], { report: { ps: 'urn:sys' } });
  dExpect(null, 'ZSYS', 'Sys Lab', 3);
  // A mapping that is not in the register gives no province.
  map(D, 'ZUM', null, 'x', 'Lusaka');
  dLab('ZUM', 'Unmapped Reg Lab', [at(4)]);
  dExpect(null, 'ZUM', 'Unmapped Reg Lab', 4);

  // -- No testing lab: v1 falls back to the receiving code, which CE does not carry. The request is left out. --
  dLab('', 'No Code Lab', [at(1)]);
  dLab('   ', 'Spaces Lab', [at(1)]);
  add(D, 'T26-D-NULLCODE', { authored: at(1), reports: [{ perf: null, display: 'Null Lab' }] });
  add(D, 'T26-D-NOREPORT', { authored: at(1) });

  // -- The exclusion list (D line 62): one lab per code, each registered yesterday. None may show. --
  // Three codes are spelled another way (lower case with a trailing space, mixed case, trailing spaces) with no plain spelling beside them,
  // so a compare that is not SQL Server's would let them through.
  const D_VARIANTS = { ZXZ: 'zxz ', POC: 'Poc', MAF: 'MAF  ' };
  D_EXCLUDED.forEach((code) => dLab(D_VARIANTS[code] ?? code, `Excluded ${code}`, [at(1)]));
  // Near misses are labs: a longer code, a leading space, a code without its zeros.
  dLab('ZZZ1', 'Near Miss One', [at(1)]);
  dExpect(null, 'ZZZ1', 'Near Miss One', 1);
  dLab(' XXX', 'Near Miss Two', [at(1)]);
  dExpect(null, ' XXX', 'Near Miss Two', 1);
  dLab('5', 'Near Miss Five', [at(1)]);
  dExpect(null, '5', 'Near Miss Five', 1);

  // -- Part b (D lines 37-51): DISA Link pre-registrations. The lab is the one whose register facility is the pre-registration facility. --
  // The pre-registered requests are tested by ZZZ (excluded, so they make no part a row) and carry the attribute. `auth` is the report's
  // issued stamp; `reg` the registered stamp.
  const PREP = { panel: 'HIVWB' };
  function pre(tag, code, auth, o = {}) {
    add(D, `T26-D-PRE-${tag}`, { ...PREP, authored: o.reg ?? at(30), reports: [{ perf: 'ZZZ', iss: auth }], attrs: [{ code: 'prereg-registration-facility', value: code }] });
  }
  // Lab ZB1: part a is 20, part b is the latest issued stamp of its pre-registrations (4 and 11 days ago, and one with no result): MIN is 4.
  map(D, 'ZB1', 'RG-B1', 'x', 'Lusaka');
  map(D, 'PRE1', 'RG-B1', 'Pre Site 1', 'Lusaka');
  dLab('ZB1', 'Bee One', [at(20)]);
  pre('B1-1', 'PRE1', at(4));
  pre('B1-2', 'PRE1', at(11));
  pre('B1-3', 'PRE1', null);
  dExpect('Lusaka', 'ZB1', 'Bee One', 4);
  // Part a is smaller than part b: MIN is a.
  map(D, 'ZB2', 'RG-B2', 'x', 'Southern');
  map(D, 'PRE2', 'RG-B2', 'x', 'Southern');
  dLab('ZB2', 'Bee Two', [at(2)]);
  pre('B2', 'PRE2', at(8));
  dExpect('Southern', 'ZB2', 'Bee Two', 2);
  // A lab with no request after the floor is a part b row only.
  map(D, 'ZB3', 'RG-B3', 'x', 'Southern');
  map(D, 'PRE3', 'RG-B3', 'x', 'Southern');
  dLab('ZB3', 'Bee Three', ['2018-05-05T10:00:00+02:00']);
  pre('B3', 'PRE3', at(6), { reg: at(8) });
  dExpect('Southern', 'ZB3', 'Bee Three', 6);
  // Pre-registrations with no issued stamp give no part b row (D line 50).
  map(D, 'ZB4', 'RG-B4', 'x', 'Lusaka');
  map(D, 'PRE4', 'RG-B4', 'x', 'Lusaka');
  dLab('ZB4', 'Bee Four', [at(3)]);
  pre('B4', 'PRE4', null);
  dExpect('Lusaka', 'ZB4', 'Bee Four', 3);
  // D line 50: a part b value of -1 (issued tomorrow) is dropped; -2 is kept.
  map(D, 'ZB5', 'RG-B5', 'x', 'Lusaka');
  map(D, 'PRE5', 'RG-B5', 'x', 'Lusaka');
  dLab('ZB5', 'Bee Five', [at(9)]);
  pre('B5', 'PRE5', at(-1));
  dExpect('Lusaka', 'ZB5', 'Bee Five', 9);
  map(D, 'ZB6', 'RG-B6', 'x', 'Lusaka');
  map(D, 'PRE6', 'RG-B6', 'x', 'Lusaka');
  dLab('ZB6', 'Bee Six', [at(9)]);
  pre('B6', 'PRE6', at(-2));
  dExpect('Lusaka', 'ZB6', 'Bee Six', -2);
  // D line 44: the pre-registration counts only if registered after the floor (strictly).
  map(D, 'ZB7', 'RG-B7', 'x', 'Lusaka');
  map(D, 'PRE7', 'RG-B7', 'x', 'Lusaka');
  dLab('ZB7', 'Bee Seven', [at(5)]);
  pre('B7', 'PRE7', at(1), { reg: '2019-01-01T00:00:00+02:00' });
  dExpect('Lusaka', 'ZB7', 'Bee Seven', 5);
  map(D, 'ZB12', 'RG-B12', 'x', 'Lusaka');
  map(D, 'PRE12', 'RG-B12', 'x', 'Lusaka');
  dLab('ZB12', 'Bee Twelve', [at(9)]);
  pre('B12', 'PRE12', at(1), { reg: '2019-01-01T00:00:01+02:00' });
  dExpect('Lusaka', 'ZB12', 'Bee Twelve', 1);
  // The facility code compares ignoring case and trailing spaces. Part b (7) is below part a (12).
  map(D, 'ZB8', 'RG-B8', 'x', 'Lusaka');
  map(D, 'PRE8', 'RG-B8', 'x', 'Lusaka');
  dLab('ZB8', 'Bee Eight', [at(12)]);
  pre('B8', 'pre8 ', at(7));
  dExpect('Lusaka', 'ZB8', 'Bee Eight', 7);
  // A lab whose mapping is not in the register has no facility: no part b row, and no province.
  map(D, 'ZB9', null, 'x', 'Lusaka');
  map(D, 'PRE9', 'RG-B9', 'x', 'Lusaka');
  dLab('ZB9', 'Bee Nine', [at(6)]);
  pre('B9', 'PRE9', at(1));
  dExpect(null, 'ZB9', 'Bee Nine', 6);
  // A pre-registration facility that is not in the dictionary gives nothing.
  map(D, 'ZB10', 'RG-B10', 'x', 'Lusaka');
  dLab('ZB10', 'Bee Ten', [at(7)]);
  pre('B10', 'PREX', at(1));
  dExpect('Lusaka', 'ZB10', 'Bee Ten', 7);
  // The date of the issued stamp is its local date: 5 days ago at 00:30+02:00 is 5 (UTC would be 6).
  map(D, 'ZB11', 'RG-B11', 'x', 'Southern');
  map(D, 'PRE11', 'RG-B11', 'x', 'Southern');
  dLab('ZB11', 'Bee Eleven', [at(20)]);
  pre('B11', 'PRE11', at(5, '00:30:00'));
  dExpect('Southern', 'ZB11', 'Bee Eleven', 5);
  // Not the attribute: the wrong code, a blank value and another system are all ignored.
  map(D, 'ZB13', 'RG-B13', 'x', 'Lusaka');
  map(D, 'PRE13', 'RG-B13', 'x', 'Lusaka');
  map(D, '', 'RG-B13', 'x', 'Lusaka');                    // a dictionary row with a blank code: a blank attribute must not match it (D line 44)
  dLab('ZB13', 'Bee Thirteen', [at(4)]);
  add(D, 'T26-D-PRE-B13-1', { ...PREP, authored: at(30), reports: [{ perf: 'ZZZ', iss: at(1) }], attrs: [{ code: 'referring-request-id', value: 'PRE13' }] });
  add(D, 'T26-D-PRE-B13-2', { ...PREP, authored: at(30), reports: [{ perf: 'ZZZ', iss: at(1) }], attrs: [{ code: 'prereg-registration-facility', value: '  ' }] });
  add(D, 'T26-D-PRE-B13-3', { ...PREP, authored: at(30), reports: [{ perf: 'ZZZ', iss: at(1) }], attrs: [{ code: 'prereg-registration-facility', value: 'PRE13', system: 'urn:other' }] });
  dExpect('Lusaka', 'ZB13', 'Bee Thirteen', 4);
  // One lab in two spellings, only the second one mapped: part a shows the smaller spelling (ZB14), part b would show the mapped one.
  map(D, 'zb14 ', 'RG-B14', 'x', 'Lusaka');
  map(D, 'PRE14', 'RG-B14', 'x', 'Lusaka');
  add(D, 'T26-D-ZB14-1', { authored: at(9), reports: [{ perf: 'ZB14', display: 'Bee Fourteen' }] });
  add(D, 'T26-D-ZB14-2', { authored: at(14), reports: [{ perf: 'zb14 ', display: 'Bee Fourteen' }] });
  pre('B14', 'PRE14', at(6));
  dExpect('Lusaka', 'ZB14', 'Bee Fourteen', 6);
  // Two labs of one facility both get the part b value.
  map(D, 'ZB15', 'RG-B15', 'x', 'Lusaka');
  map(D, 'ZB16', 'RG-B15', 'x', 'Lusaka');
  map(D, 'PRE15', 'RG-B15', 'x', 'Lusaka');
  dLab('ZB15', 'Bee Fifteen', [at(10)]);
  dLab('ZB16', 'Bee Sixteen', [at(1)]);
  pre('B15', 'PRE15', at(3));
  dExpect('Lusaka', 'ZB15', 'Bee Fifteen', 3);
  dExpect('Lusaka', 'ZB16', 'Bee Sixteen', 1);
  // The exclusion list applies to part b rows too: ZLA has a pre-registration row (2 days) and a part a row (1 day, from the exclusion
  // loop above). Neither may show.
  map(D, 'ZLA', 'RG-EX', 'x', 'Lusaka');
  map(D, 'PREEX', 'RG-EX', 'x', 'Lusaka');
  pre('EX', 'PREEX', at(2));

  // =========================================================================================================================
  // Suspect collection dates (prefix t26s-). Window 2026-05-01 to 2026-05-31 unless a suite says otherwise.
  // =========================================================================================================================
  const S = 't26s-';
  const sRows = [];
  const sExpect = (lab, type, id, days) => sRows.push({ Laboratory: lab, 'Test Type': type, RequestID: id, 'Days from collection to accessioning': days });
  // Defaults: panel HIVVL, observation HIVVL, lab ZQ1 'Quartz Lab', collected 2026-01-01, registered 2026-04-02 (91 days: January 31 +
  // February 28 + March 31 = 90 days to 04-01), analysed 2026-05-10.
  const SP = { eff: '2026-01-01T08:00:00+02:00', reg: '2026-04-02T08:00:00+02:00', ana: '2026-05-10T09:00:00+02:00', perf: 'ZQ1', display: 'Quartz Lab', obs: ['HIVVL'] };
  function susp(id, o = {}) {
    const x = { ...SP, ...o };
    return add(S, id, { panel: 'panel' in o ? o.panel : 'HIVVL', authored: x.reg, analysis: x.ana, obr: x.obr ?? 1, results: x.obs, reports: x.noReport ? [] : (x.reports ?? [{ perf: x.perf, display: x.display, eff: x.eff }]) });
  }
  // S lines 40-42, 38: a request over 90 days. The default is 91.
  susp('T26-S-BASIC');
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-BASIC', 91);
  // The threshold is > 90: 90 is out, 92 is in.
  susp('T26-S-90', { reg: '2026-04-01T08:00:00+02:00' });
  susp('T26-S-92', { reg: '2026-04-03T08:00:00+02:00' });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-92', 92);
  // datediff(dd) counts date boundaries: 90 days and 2 minutes apart, but 91 boundaries.
  susp('T26-S-BOUND', { eff: '2026-01-01T23:59:00+02:00', reg: '2026-04-02T00:01:00+02:00' });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-BOUND', 91);
  // Local dates, not UTC: 91 local days (90 in UTC) is in; 90 local days (91 in UTC) is out.
  susp('T26-S-UTCIN', { eff: '2026-01-01T23:30:00+02:00', reg: '2026-04-02T00:30:00+02:00' });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-UTCIN', 91);
  susp('T26-S-UTCOUT', { eff: '2026-01-02T00:30:00+02:00', reg: '2026-04-02T23:30:00+02:00' });
  susp('T26-S-DATEONLY', { eff: '2026-01-01', reg: '2026-04-02' });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-DATEONLY', 91);
  // A partial, missing or earlier collection date gives no row.
  susp('T26-S-PARTIAL-SP', { eff: '2026-01' });
  susp('T26-S-PARTIAL-REG', { reg: '2026-04' });
  susp('T26-S-BEFORE', { eff: '2026-04-10T08:00:00+02:00' });
  susp('T26-S-NOSPEC', { eff: null });
  susp('T26-S-NOREP', { noReport: true });

  // Panels: HIVVL is Viral Load, HIVPC is EID (S lines 23-26). Case and trailing spaces do not matter. Other panels are out.
  susp('T26-S-EID', { panel: 'HIVPC', obs: ['HIVPC'] });
  sExpect('Quartz Lab', 'EID', 'T26-S-EID', 91);
  susp('T26-S-EIDCASE', { panel: 'hivpc ' });
  sExpect('Quartz Lab', 'EID', 'T26-S-EIDCASE', 91);
  susp('T26-S-PANELCASE', { panel: 'hivvl ' });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-PANELCASE', 91);
  susp('T26-S-RTRI', { panel: 'RTRI' });
  susp('T26-S-NOPANEL', { panel: null });
  // Observations HIVVL, HIVVC and HIVPC (S line 39), whatever the panel. Others, and no result, are out.
  susp('T26-S-OBSVC', { obs: ['HIVVC'] });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-OBSVC', 91);
  susp('T26-S-OBSPC', { obs: ['HIVPC'] });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-OBSPC', 91);
  susp('T26-S-EIDOBSVL', { panel: 'HIVPC', obs: ['HIVVL'] });
  sExpect('Quartz Lab', 'EID', 'T26-S-EIDOBSVL', 91);
  susp('T26-S-OBSCASE', { obs: ['hivvc '] });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-OBSCASE', 91);
  susp('T26-S-OBSBAD', { obs: ['HIVTM'] });
  susp('T26-S-NORES', { obs: [] });

  // SELECT DISTINCT (S line 22): several results, several reports and several OBR sets of one request are one row.
  susp('T26-S-TWORES', { obs: ['HIVVL', 'HIVVC'] });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-TWORES', 91);
  susp('T26-S-TWOREP', { reports: [{ perf: 'ZQ1', display: 'Quartz Lab', eff: SP.eff }, { perf: 'ZQ1', display: 'Quartz Lab', eff: SP.eff }] });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-TWOREP', 91);
  susp('T26-S-TWOOBR', { obr: 1 });
  susp('T26-S-TWOOBR', { obr: 2 });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-TWOOBR', 91);
  // Different days, or a different test type, are different rows.
  susp('T26-S-TWODAYS', { reg: '2026-04-02T08:00:00+02:00' });
  susp('T26-S-TWODAYS', { reg: '2026-04-03T08:00:00+02:00' });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-TWODAYS', 91);
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-TWODAYS', 92);
  susp('T26-S-PANELS', { panel: 'HIVVL' });
  susp('T26-S-PANELS', { panel: 'HIVPC' });
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-PANELS', 91);
  sExpect('Quartz Lab', 'EID', 'T26-S-PANELS', 91);
  // The distinct is on text that ignores case and trailing spaces: the request number, and the lab name. The smallest spelling shows.
  susp('T26-S-Fold');
  susp('t26-s-fold ');
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-Fold', 91);
  susp('T26-S-TWIN', { perf: 'ZT1', display: 'Twin Lab' });
  susp('T26-S-TWIN', { perf: 'ZT2', display: 'Twin Lab' });
  susp('T26-S-TWIN', { perf: 'ZT3', display: 'twin lab ' });
  sExpect('Twin Lab', 'Viral Load', 'T26-S-TWIN', 91);
  // Order: the request number in word order, not byte order ('aaa' before 'BASIC').
  susp('T26-S-aaa');
  sExpect('Quartz Lab', 'Viral Load', 'T26-S-aaa', 91);

  // The testing lab (S line 41): ZZZ, XXX and ZXZ are out, in any case with trailing spaces. No code at all (NULL) is out; a blank code is
  // not in the list, so the row stays, with no lab name (v1 would read the receiving lab, which CE does not carry).
  ['ZZZ', 'XXX', 'ZXZ', 'zzz '].forEach((perf, i) => susp(`T26-S-X${i}`, { perf, display: `Excluded ${i}` }));
  susp('T26-S-NEAR', { perf: 'ZZZ1', display: 'Near Lab' });
  sExpect('Near Lab', 'Viral Load', 'T26-S-NEAR', 91);
  susp('T26-S-NULLLAB', { perf: null, display: 'Null Lab' });
  susp('T26-S-BLANK', { perf: '', display: 'Blank Lab' });
  sExpect(null, 'Viral Load', 'T26-S-BLANK', 91);
  susp('T26-S-SPACES', { perf: '   ', display: 'Spaces Lab' });
  sExpect(null, 'Viral Load', 'T26-S-SPACES', 91);

  // The window (S line 42): AnalysisDateTime BETWEEN the two dates taken as midnight. The end day is not in, except its first instant.
  const anaCase = (id, ana, into) => { susp(id, { ana }); if (into) sExpect('Quartz Lab', 'Viral Load', id, 91); };
  anaCase('T26-S-AN-START', '2026-05-01T00:00:00+02:00', true);
  anaCase('T26-S-AN-BEFORE', '2026-04-30T23:59:59+02:00', false);
  anaCase('T26-S-AN-ENDMID', '2026-05-31T00:00:00+02:00', true);
  anaCase('T26-S-AN-ENDPLUS', '2026-05-31T00:00:01+02:00', false);
  anaCase('T26-S-AN-DATEONLY', '2026-05-31', true);
  anaCase('T26-S-AN-TZIN', '2026-05-01T00:30:00+02:00', true);
  anaCase('T26-S-AN-TZOUT', '2026-05-31T01:00:00+02:00', false);
  anaCase('T26-S-AN-LAST', '2026-05-30T23:59:59+02:00', true);
  anaCase('T26-S-AN-NULL', null, false);
  anaCase('T26-S-AN-PARTIAL', '2026-05', false);

  // Lab names (spec ruling 8, Task 16 rule): ONE name per code, chosen from the rows the query returns.
  susp('T26-S-N1', { perf: 'ZN1', display: 'Zeta Name' });
  susp('T26-S-N2', { perf: 'ZN1', display: 'Alpha Name' });
  sExpect('Alpha Name', 'Viral Load', 'T26-S-N1', 91);
  sExpect('Alpha Name', 'Viral Load', 'T26-S-N2', 91);
  map(S, 'ZN2', 'RG-S2', 'Mapped Lab Name', 'Lusaka');
  susp('T26-S-N3', { perf: 'ZN2', display: null });
  sExpect('Mapped Lab Name', 'Viral Load', 'T26-S-N3', 91);
  susp('T26-S-N4', { perf: 'ZN3', display: null });
  sExpect('ZN3', 'Viral Load', 'T26-S-N4', 91);
  // A name that is not just the code wins over the bare code.
  susp('T26-S-N5', { perf: 'ZN4', display: null });
  susp('T26-S-N6', { perf: 'ZN4', display: 'Real Name' });
  sExpect('Real Name', 'Viral Load', 'T26-S-N5', 91);
  sExpect('Real Name', 'Viral Load', 'T26-S-N6', 91);
  // A row the query leaves out (10 days only) does not name the lab.
  susp('T26-S-N7', { perf: 'ZN5', display: null });
  susp('T26-S-N8', { perf: 'ZN5', display: 'Hidden Name', reg: '2026-01-11T08:00:00+02:00' });
  sExpect('ZN5', 'Viral Load', 'T26-S-N7', 91);

  // =========================================================================================================================
  // DISA Link weekly stats (prefix t26l-). Window 2026-05-04 to 2026-05-10.
  // =========================================================================================================================
  const L = 't26l-';
  const lRows = [];
  const lExpect = (facility, newReg, tested, reviewed, old, oldReviewed) => lRows.push({ Facility: facility, 'New Registrations': newReg, Tested: tested, Reviewed: reviewed, 'Tested from Old Requests': old, 'Tested & Reviewed from Old Requests': oldReviewed });
  // The facility dictionary (Facilities): the mapped facility_map rows. DL1 has a second row of another system, which must not double rows.
  map(L, 'DL1', 'RG-L1', 'Alpha Clinic', 'Lusaka');
  map(L, 'DL1', 'RG-L1', 'Alpha Clinic', 'Lusaka', { ss: 'urn:other' });
  map(L, 'DL2', 'RG-L2', 'Beta Clinic', 'Lusaka');
  map(L, 'DL3A', 'RG-L3A', 'Gamma Clinic', 'Lusaka');
  map(L, 'DL3B', 'RG-L3B', 'gamma clinic ', 'Lusaka');
  map(L, 'DL4', 'RG-L4', null, 'Lusaka');
  map(L, 'DL5', null, 'Unmapped Clinic', 'Lusaka');
  map(L, 'DL6', 'RG-L6', 'delta Clinic', 'Lusaka');
  map(L, 'DL7', 'RG-L7', 'Echo Clinic', 'Lusaka');
  // A request: panel, registered, analysed, the pre-registration code, report issued stamps (none: no report), result observations.
  function link(id, code, reg, o = {}) {
    return add(L, id, {
      panel: o.panel ?? 'HIVVL', authored: reg, analysis: o.ana ?? null, obr: o.obr ?? 1,
      reports: (o.iss ?? []).map((iss) => ({ perf: 'ZL1', iss })), results: o.obs ?? [],
      attrs: code === undefined ? [] : [{ code: 'prereg-registration-facility', value: code, ...(o.attr ?? {}) }],
    });
  }
  const W = (day, time = '08:00:00') => `2026-05-${day}T${time}+02:00`;

  // -- DL1, Alpha Clinic: window 05-04 00:00:00 up to, not including, 05-11 00:00:00 (L lines 37-38) --
  link('T26L-A1', 'DL1', W('04', '00:00:00'), { ana: W('05', '10:00:00'), iss: [W('06', '10:00:00')], obs: ['HIVVL'] });   // new, tested, reviewed
  link('T26L-A2', 'DL1', W('10', '23:59:59'), { panel: 'HIVPC' });                                                           // new (last second)
  link('T26L-A3', 'DL1', W('11', '00:00:00'), { ana: W('08', '10:00:00'), iss: [W('09', '10:00:00')], obs: ['HIVVL'] });   // registered after: not new, not old
  link('T26L-A4', 'DL1', W('03', '23:59:59'), { ana: W('04', '00:00:00'), iss: [W('12', '10:00:00')], obs: ['HIVVL'] });   // old, tested at the first instant; reviewed after the window
  link('T26L-A5', 'DL1', '2026-04-20T08:00:00+02:00', { ana: W('10', '23:59:59'), iss: [W('10', '00:00:00')], obs: ['HIVVC'] }); // old, tested and reviewed in the window
  link('T26L-A6', 'DL1', '2026-04-28T08:00:00+02:00', { ana: W('11', '00:00:00'), iss: [W('05', '10:00:00')], obs: ['HIVVL'] }); // analysed at the end instant: out
  link('T26L-A7', 'DL1', '2026-04-20T08:00:00+02:00', { panel: 'RTRI', ana: W('06'), obs: ['HIVVL'] });                         // another panel: nothing
  link('T26L-A7B', 'DL1', W('05'), { panel: 'RTRI', ana: W('06') });
  link('T26L-A8', 'DL1', '2026-04-20T08:00:00+02:00', { ana: W('06') });                                                       // old, no result row: not counted
  link('T26L-A9', 'DL1', '2026-04-20T08:00:00+02:00', { ana: W('06'), obs: ['XYZ'] });                                         // old, another observation: not counted
  link('T26L-A10', 'DL1', W('04', '01:00:00'), { ana: W('04', '00:30:00'), obs: ['HIVVL'] });                                // new on its local date (UTC says 05-03)
  link('T26L-A11', 'DL1', W('11', '01:00:00'));                                                                              // local 05-11 (UTC says 05-10): out
  link('T26L-DUP', 'DL1', W('05'), { ana: W('06'), iss: [W('07')], obr: 1 });                                                // two OBR sets: one request, two tested, two reviewed
  link('T26L-DUP', 'DL1', W('05'), { ana: W('06'), iss: [W('08')], obr: 2 });                                                // (both rows have a report: two reviewed, one request)
  link('T26L-CASE', 'DL1', W('06'));                                                                                         // one request number in two spellings
  link('t26l-case ', 'DL1', W('06'));
  link('T26L-A19', 'DL1', '2026-04-20T08:00:00+02:00', { panel: 'HIVPC', ana: W('06'), obs: ['HIVPC'] });                  // old, panel and observation HIVPC: tested
  link('T26L-A20', 'DL1', '2026-04-20T08:00:00+02:00', { ana: W('06'), iss: [W('06'), W('20')], obs: ['HIVVL'] }); // old, two reports: the LATEST issued stamp (05-20) counts, so tested but not reviewed in the period
  link('T26L-A15', 'dl1 ', W('07'), { panel: 'hivvl ' });                                                                    // code and panel ignore case and trailing spaces
  link('T26L-TWOREP', 'DL1', W('08'), { ana: W('09'), iss: [W('09'), W('10')] });                                            // two reports: still one tested and one reviewed
  link('T26L-A17', 'DL1', W('08'), { ana: W('08'), iss: [null] });                                                           // a report with no issued stamp: tested, not reviewed
  link('T26L-A18', 'DL1', '2026-05', { ana: W('08') });                                                                       // a partial registered date: out
  link('T26L-OLD', 'DL1', '2026-04-10T08:00:00+02:00', { ana: W('07'), iss: [W('08')], obs: ['HIVVL'] });                     // two old rows, one request
  link('T26L-OLD', 'DL1', '2026-04-10T08:00:00+02:00', { ana: W('07'), iss: [W('08')], obs: ['HIVVL'], obr: 2 });
  link('T26L-OLDC', 'DL1', '2026-04-11T08:00:00+02:00', { ana: W('07'), iss: [W('08')], obs: ['HIVVL'] });                    // one old request number in two spellings
  link('t26l-oldc ', 'DL1', '2026-04-11T08:00:00+02:00', { ana: W('07'), iss: [W('08')], obs: ['HIVVL'] });
  link('T26L-A21', 'DL1', '2026-04-20T08:00:00+02:00', { ana: W('06'), iss: [W('07')] });                                      // old, reviewed in the period, no result row: neither old column
  link('T26L-A22', 'DL1', '2026-04-20T08:00:00+02:00', { ana: W('06'), iss: [W('07')], obs: ['XYZ'] });                        // old, reviewed in the period, another observation: neither
  link('T26L-A23', 'DL1', '2026-04-20T08:00:00+02:00', { ana: W('06'), iss: ['2026-05-11T01:00:00+02:00'], obs: ['HIVVL'] }); // reviewed on local 05-11 (UTC says 05-10): tested, not reviewed in the period
  link('T26L-A25', 'DL1', '2026-04-20T08:00:00+02:00', { ana: W('06'), iss: ['2026-05-11T00:30:00+02:00'], obs: ['HIVVL'] }); // reviewed on local 05-11 again (a second one, so a UTC error cannot cancel out)
  link('T26L-A24', 'DL1', '2026-04-20T08:00:00+02:00', { ana: W('06'), iss: ['2026-05-04T01:00:00+02:00'], obs: ['HIVVL'] }); // reviewed on local 05-04 (UTC says 05-03): in the period
  // Not facilities of the dictionary: no attribute, a blank one, another system, another code, an unknown code, a code outside the register.
  link('T26L-NOATTR', undefined, W('05'), { ana: W('06') });
  link('T26L-BLANK', '  ', W('05'), { ana: W('06') });
  link('T26L-SYSTEM', 'DL1', W('05'), { ana: W('06'), attr: { system: 'urn:other' } });
  add(L, 'T26L-CODE', { authored: W('05'), analysis: W('06'), attrs: [{ code: 'referring-request-id', value: 'DL1' }] });
  link('T26L-NOPE', 'NOPE', W('05'), { ana: W('06') });
  link('T26L-UNREG', 'DL5', W('05'), { ana: W('06') });
  // New: A1, A2, A10, DUP, CASE, A15, TWOREP, A17 = 8 requests. Tested (rows with an analysis stamp): A1, A10, DUP x2, TWOREP, A17 = 6.
  // Reviewed (rows with a report issued stamp): A1, DUP x2, TWOREP = 4.
  // Old tested (distinct requests with a result row of the list): A4, A5, OLD, OLDC, A19, A20, A23, A25, A24 = 9 (A21 and A22 have no such result).
  // Old tested and reviewed (latest issued stamp in the period): A5, OLD, OLDC, A24 = 4 (A4 05-12, A20 05-20, A23 and A25 on 05-11 local are out).
  lExpect('Alpha Clinic', 8, 6, 4, 9, 4);

  // -- DL2, Beta Clinic: an old request only, no new registration in the window: no row (the outer query starts from new requests) --
  link('T26L-B1', 'DL2', '2026-04-20T08:00:00+02:00', { ana: W('06'), iss: [W('07')], obs: ['HIVVL'] });

  // -- DL3A and DL3B: two codes with one name (case and trailing space aside) are one row. The old counts add up, where v1's TOP 1 over
  //    FacilityCode groups would return one of the two arbitrarily. --
  link('T26L-G1', 'DL3A', W('05'), { ana: W('05'), iss: [W('06')] });
  link('T26L-G2', 'DL3A', '2026-04-01T08:00:00+02:00', { ana: W('05'), iss: [W('06')], obs: ['HIVVL'] });
  link('T26L-G3', 'DL3B', W('06'));
  link('T26L-G4', 'DL3B', '2026-04-02T08:00:00+02:00', { ana: W('06'), iss: [W('20')], obs: ['HIVVL'] });
  lExpect('Gamma Clinic', 2, 1, 1, 2, 1);

  // -- DL4, no description: one row with NULL Facility, and the old columns stay NULL (NULL = NULL is not true, L line 21) --
  link('T26L-N1', 'DL4', W('05'), { ana: W('05') });
  link('T26L-N2', 'DL4', '2026-04-01T08:00:00+02:00', { ana: W('06'), iss: [W('07')], obs: ['HIVVL'] });
  lExpect(null, 1, 1, 0, null, null);

  // -- DL6: a new registration and nothing else: Tested 0 and Reviewed 0, the old columns NULL (the TOP 1 sub-select returns no row) --
  link('T26L-D1', 'DL6', W('05'));
  lExpect('delta Clinic', 1, 0, 0, null, null);

  // -- DL7: tested from an old request, reviewed after the window: the second old column is NULL, not 0 --
  link('T26L-E1', 'DL7', W('05'), { ana: W('05'), iss: [W('06')] });
  link('T26L-E2', 'DL7', '2026-04-01T08:00:00+02:00', { ana: W('06'), iss: [W('20')], obs: ['HIVVL'] });
  lExpect('Echo Clinic', 1, 1, 1, 1, null);

  // =========================================================================================================================
  // The warehouse rows
  // =========================================================================================================================
  const setup = `insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, obr_set_id) values
  ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, performer_display, source_system, performer_system) values
  ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code) values
  ${results.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values
  ${attrs.join(',\n  ')};
insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ${maps.join(',\n  ')};`;

  // =========================================================================================================================
  // Suites
  // =========================================================================================================================
  // Remove the rows of the other two queries, so a suite sees only its own fixture (ids start with the prefix).
  const isolate = (keep) => ['lab_results', 'lab_request_attributes', 'diagnostic_reports', 'lab_requests', 'facility_map']
    .map((t) => `delete from ${t} where id not like '${keep}%';`).join('\n');
  let sp = 0;
  // The exact rows in order. `only` keeps the rows of those values of one column (for the variants).
  function listSuite(name, queryName, params, columns, wanted, keep, { only, onlyColumn, before = '' } = {}) {
    const q = t26query(queryName);
    const sqlText = q?.sql ?? `select 'x'::text as "${onlyColumn ?? 'x'}"`;
    const text = only ? `select z.* from (${sqlText}) z where z."${onlyColumn}" in (${only.map(lit).join(', ')})` : sqlText;
    const s = orderedSuite(name, text, params, columns, wanted);
    if (!q) {
      const check = s.check;
      s.check = (got) => [`query "${queryName}" is missing`, ...check(got)];
    }
    sp += 1;
    s.sql = `savepoint t26sp${sp};\n${isolate(keep)}\n${before}\n${s.sql}\nrollback to savepoint t26sp${sp};`;
    return s;
  }
  // A suite that prints one JSON object of values and compares it.
  function valueSuite(name, queryName, keep, selectExpr, want) {
    const q = t26query(queryName);
    sp += 1;
    if (!q) return { name, count: 1, check: () => [`query "${queryName}" is missing`] };
    return {
      name,
      count: 1,
      sql: `savepoint t26sp${sp};\n${isolate(keep)}\nselect ${lit(name)} || chr(9) || (${selectExpr(q.sql)})::text;\nrollback to savepoint t26sp${sp};`,
      check: (got) => (JSON.stringify(got) === JSON.stringify([want]) ? [] : [`expected ${JSON.stringify([want])}, got ${JSON.stringify(got)}`]),
    };
  }
  const shape = (name, queryName, ids) => shapeSuite(name, t26query(queryName), ids, ids.map(() => 'text'));
  // CE pages a result with LIMIT and OFFSET, so the ORDER BY must be total: it names every output column.
  const orderSuite = (name, queryName, count) => ({
    name,
    count,
    check() {
      const q = t26query(queryName);
      if (!q) return [`query "${queryName}" is missing`];
      const tail = q.sql.slice(q.sql.lastIndexOf('order by'));
      const bad = [];
      for (let i = 1; i <= count; i += 1) {
        const id = `res.c${String(i).padStart(2, '0')}`;
        if (!tail.includes(id)) bad.push(`ORDER BY must list ${id}`);
      }
      return bad;
    },
  });

  const MAY = { from: '2026-05-01', to: '2026-05-31' };
  const WEEK = { from: '2026-05-04', to: '2026-05-10' };
  const FLOOR = { from: '2019-01-01' };
  const daysOrder = byColumns([['Province', 'text'], ['LabName', 'text'], ['LabCode', 'text'], ['LastTransmission', 'number']]);
  const suspectOrder = byColumns([['Laboratory', 'text'], ['Test Type', 'text'], ['RequestID', 'text'], ['Days from collection to accessioning', 'number']]);
  const disalinkOrder = byColumns([['Facility', 'text']]);

  const suites26 = [
    { name: 't26-setup', setup, count: 0, check: () => [] },
    shape('t26-shape-days', DAYS_Q, ['from']),
    shape('t26-shape-suspect', SUSPECT_Q, ['from', 'to']),
    shape('t26-shape-disalink', DISALINK_Q, ['from', 'to']),
    orderSuite('t26-order-days', DAYS_Q, 4),
    orderSuite('t26-order-suspect', SUSPECT_Q, 4),
    orderSuite('t26-order-disalink', DISALINK_Q, 6),
    // Static: the days query counts to today's date in Zambia, whatever the server's clock zone. The rows above cannot tell Lusaka's date
    // from UTC's between 00:00 and 22:00 UTC, so this reads the SQL.
    {
      name: 't26-today-lusaka',
      count: 1,
      check: () => (t26query(DAYS_Q)?.sql.includes("(now() at time zone 'Africa/Lusaka')::date") ? [] : ["today must be (now() at time zone 'Africa/Lusaka')::date"]),
    },
    listSuite('t26-days-all', DAYS_Q, FLOOR, DAYS_COLUMNS, [...dRows].sort(daysOrder), D),
    // The floor is the parameter: from six days ago, ZV1 (exactly midnight) and ZV3 (before) are out and ZV2 is in.
    listSuite('t26-days-floor', DAYS_Q, { from: d(6) }, DAYS_COLUMNS, [dRows.find((r) => r.LabCode === 'ZV2')], D, { only: ['ZV1', 'ZV2', 'ZV3'], onlyColumn: 'LabCode' }),
    // Today is the date in Zambia whatever the session time zone: the same rows with the session far east and far west of Lusaka.
    listSuite('t26-days-tz-east', DAYS_Q, FLOOR, DAYS_COLUMNS, [...dRows].sort(daysOrder), D, { before: "set local time zone 'Pacific/Kiritimati';" }),
    listSuite('t26-days-tz-west', DAYS_Q, FLOOR, DAYS_COLUMNS, [...dRows].sort(daysOrder), D, { before: "set local time zone 'Pacific/Pago_Pago';" }),
    valueSuite('t26-days-type', DAYS_Q, D, (sqlText) => `select json_build_object('days', pg_typeof(q."LastTransmission")::text) from (${bind(sqlText, FLOOR)}) q limit 1`, { days: 'integer' }),
    listSuite('t26-suspect-all', SUSPECT_Q, MAY, SUSPECT_COLUMNS, [...sRows].sort(suspectOrder), S),
    valueSuite('t26-suspect-type', SUSPECT_Q, S, (sqlText) => `select json_build_object('days', pg_typeof(q."Days from collection to accessioning")::text) from (${bind(sqlText, MAY)}) q limit 1`, { days: 'integer' }),
    listSuite('t26-disalink-all', DISALINK_Q, WEEK, DISALINK_COLUMNS, [...lRows].sort(disalinkOrder), L),
    valueSuite('t26-disalink-type', DISALINK_Q, L, (sqlText) => `select json_build_object('n', pg_typeof(q."New Registrations")::text, 't', pg_typeof(q."Tested")::text, 'r', pg_typeof(q."Reviewed")::text, 'o', pg_typeof(q."Tested from Old Requests")::text, 'or', pg_typeof(q."Tested & Reviewed from Old Requests")::text) from (${bind(sqlText, WEEK)}) q limit 1`, { n: 'bigint', t: 'bigint', r: 'bigint', o: 'bigint', or: 'bigint' }),
    // One day only: Alpha Clinic has A1 and A10 registered on 05-04 (the first and the end day are both whole days), both tested, A1 reviewed.
    // Old: A4 (registered 05-03 23:59:59, analysed 05-04 00:00:00, reviewed 05-12) is tested; none is reviewed in the window.
    listSuite('t26-disalink-day', DISALINK_Q, { from: '2026-05-04', to: '2026-05-04' }, DISALINK_COLUMNS, [
      { Facility: 'Alpha Clinic', 'New Registrations': 2, Tested: 2, Reviewed: 1, 'Tested from Old Requests': 1, 'Tested & Reviewed from Old Requests': null },
    ], L, { only: ['Alpha Clinic'], onlyColumn: 'Facility' }),
  ];
  return { name: 't26', suites: suites26 };
}

// ==========================================================================================================================
// Group t27: VL and EID weekly stats, Tests authorised by lab and type, VL throughput by lab and month (v1 sp_getVLEIDstats over
// fn_WeeklyLISUpdate, sp_LabTestingSummary, sp_LabThroughputTrendbyYear over fn_annualrequestsTestsTrend and vVLRequestsTestsByMonth).
// Fixture ids start with "t27w-" (weekly stats), "t27s-" (testing summary) and "t27t-" (throughput). The three queries read the same
// tables, so every suite first deletes the rows of the other two (isolate) and runs inside a savepoint.
// "F line N", "S line N" and "M line N" mean a line of UserDefinedFunction__dbo_fn_WeeklyLISUpdate.sql,
// StoredProcedure__dbo_sp_LabTestingSummary.sql and View__dbo_vVLRequestsTestsByMonth.sql. sp_getVLEIDstats ("W line N") only calls the function.

const WS_Q = 'VL and EID weekly stats';
const SUM_Q = 'Tests authorised by lab and type';
const THR_Q = 'VL throughput by lab and month';
const t27query = (name) => queries().find((q) => q.name === name);

const WS_COLUMNS = ['TestType', 'Lab', 'LabName', 'Requests', 'Tests', 'TestedAuthorised', 'BacklogTests', 'BacklogTestsAuthorised', 'Rejects', 'ORejects',
  'Invalids', 'Suppressed', 'Positives', 'Indeterminates', 'LabTAT'];
const SUM_LEAD = ['Province', 'District', 'Facility', 'FacilityCode', 'FacilityType', 'LabCode'];
// The 16 test-type columns of S lines 9-93, in order.
const SUM_TYPES = ['Full Blood Count', 'ALT', 'Creatinine', 'AST', 'Total Bilirubin', 'Direct Bilirubin', 'HIV Rapid', 'RPR', 'Hepatitis B', 'HIV VL',
  'HIV EID', 'HPV', 'TB', 'Malaria Rapid', 'TB Microscopy', 'Glucose'];
const SUM_COLUMNS = [...SUM_LEAD, ...SUM_TYPES];
const THR_COLUMNS = ['Laboratory', 'Month', 'MonthDescription', 'Requests', 'Tested'];

// S lines 9-93, typed by panel code: the columns each panel code is counted in. HSDUO is in two (S lines 36-37 and 41-42).
const SUM_MAP = {
  FBC: ['Full Blood Count'], FBCP: ['Full Blood Count'], FBCD4: ['Full Blood Count'], ALT: ['ALT'], CREA: ['Creatinine'], AST: ['AST'],
  TBIL: ['Total Bilirubin'], DBIL: ['Direct Bilirubin'], HIVR: ['HIV Rapid'], HSDUO: ['HIV Rapid', 'RPR'], RPR: ['RPR'], HEPB: ['Hepatitis B'],
  HIVVL: ['HIV VL'], POCVR: ['HIV VL'], POHVL: ['HIV VL'], POEID: ['HIV EID'], POCGH: ['HIV EID'], HIVPC: ['HIV EID'], HPV: ['HPV'], POHPV: ['HPV'],
  HPVGT: ['HPV'], TBGNX: ['TB'], POCGT: ['TB'], POCML: ['Malaria Rapid'], MALRD: ['Malaria Rapid'], TBA1: ['TB Microscopy'], TBA2: ['TB Microscopy'],
  TBA3: ['TB Microscopy'], TBZ1: ['TB Microscopy'], TBZ2: ['TB Microscopy'], TBZ3: ['TB Microscopy'], GLUCR: ['Glucose'], GLUCF: ['Glucose'],
  POCGL: ['Glucose'], GLUC: ['Glucose'], GLUCS: ['Glucose'],
};
// S line 112: the testing codes left out.
const SUM_OUT = ['ZXZ', 'POC', '000', 'ZZZ', 'XXX'];
// W lines 23-32: the constant lab names (the dictionary name is used for every other lab).
const WS_CONSTANT = [['ZUL', 'UTH Virology'], ['ZUX', 'UTH High Cost'], ['ZUC', 'UTH Cytology'], ['ZUP', 'UTH Pediatrics'], ['ZUA', 'UTH-HAP ACOE'],
  ['ZUE', 'UTH-HAP PCOE'], ['ZLP', 'Livingstone Main Lab'], ['ZLR', 'Livingstone PCR']];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function group27() {
  const requests = [];
  const reports = [];
  const results = [];
  const maps = [];
  const regs = [];
  let n = 0;
  const num = (v) => (v === null || v === undefined ? 'null' : String(v));

  // One request row with one report (noReport for none). The ids start with `prefix`. `results`: [{ obs, text, num, cmp, coded }].
  function add(prefix, o) {
    const s = { panel: 'HIVVL', obr: 1, ...o };
    n += 1;
    const qid = `${prefix}q${n}`;
    requests.push(`(${lit(qid)}, ${lit(s.id)}, ${lit(s.panel)}, ${lit(s.reg ?? null)}, ${lit(s.ana ?? null)}, ${num(s.obr)}, ${lit(s.rej ?? null)})`);
    if (!s.noReport) reports.push(`(${lit(`${prefix}d${n}`)}, ${lit(qid)}, ${lit(s.status ?? 'final')}, ${lit(s.iss ?? null)}, ${lit(s.perf ?? null)}, ${lit(s.display ?? null)}, ${lit(s.ss ?? null)}, ${lit(s.ps ?? null)})`);
    (s.results ?? []).forEach((x, i) => results.push(`(${lit(`${prefix}r${n}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${num(x.num)}, ${lit(x.cmp ?? null)}, ${lit(x.coded ?? null)})`));
    return qid;
  }
  // One facility_map row (id given, or numbered). `regId` null: the code is not in the register.
  function map(id, code, regId, name, region, district, national, { ss = '', ps = '' } = {}) {
    maps.push(`(${lit(id)}, ${lit(ss)}, ${lit(ps)}, ${lit(code)}, ${lit(regId)}, ${lit(name)}, ${lit(region)}, ${lit(district)}, ${lit(national)})`);
  }

  // =========================================================================================================================
  // VL and EID weekly stats (prefix t27w-)
  // =========================================================================================================================
  const W = 't27w-';
  const REG = '2026-05-10T08:00:00+02:00';
  const ANA = '2026-05-11T09:00:00+02:00';
  const ISS = '2026-05-12T10:00:00+02:00';
  const RB = '2026-04-30T23:59:59+02:00'; // registered the second before the window: v1 RegisteredDateTime < @From
  const E0 = '2026-05-01T00:00:00+02:00'; // the first instant of the window
  const E1 = '2026-05-31T23:59:59+02:00'; // the last second of the window
  const J1 = '2026-06-01T00:00:00+02:00'; // the first instant after it: v1 < dateadd(dd, 1, @To)
  const BA0 = '2026-05-02T09:00:00+02:00';
  const VLR = { obs: 'HIVVL', text: '1500' };

  const stats = { EID: new Map(), HIVVL: new Map() };
  const names = new Map(); // lab key -> expected LabName (a dictionary: one name per lab, in both halves)
  const keyOf = (lab) => lab.toLowerCase().trimEnd();
  function rec(type, lab) {
    const m = stats[type];
    const k = keyOf(lab);
    if (!m.has(k)) m.set(k, { lab, rq: 0, te: 0, ta: 0, bk: 0, ba: 0, rj: 0, orj: 0, inv: 0, su: 0, po: 0, id: 0, tat: [] });
    return m.get(k);
  }
  let wn = 0;
  // A request of `lab` in the VL half (panel HIVVL, test type HIVVL) or the EID half (panel HIVPC); `spec` overrides the bare request
  // (registered REG, no analysis, no authorisation, no results); `d` is what v1 counts for it, worked out by hand.
  function row(type, lab, spec, d = {}) {
    wn += 1;
    add(W, { id: `T27W-${lab.trim()}-${wn}`, panel: type === 'EID' ? 'HIVPC' : 'HIVVL', reg: REG, perf: lab, display: `Lab ${lab.trim().toUpperCase()}`, ...spec });
    const r = rec(type, lab);
    for (const k of ['rq', 'te', 'ta', 'bk', 'ba', 'rj', 'orj', 'inv', 'su', 'po', 'id']) r[k] += d[k] ?? 0;
    if (d.tat !== undefined) r.tat.push(d.tat);
    if (!names.has(keyOf(lab))) names.set(keyOf(lab), `Lab ${lab.trim().toUpperCase()}`);
  }
  const vl = (lab, spec, d) => row('HIVVL', lab, spec, d);
  const eid = (lab, spec, d) => row('EID', lab, spec, d);

  // -- WR1: Requests and the window (F lines 16 and 260-262): RegisteredDateTime >= @From and < @To + 1 day, on LOCAL time --
  vl('WR1', { reg: E0 }, { rq: 1 });                                  // the first instant is in
  vl('WR1', { reg: '2026-05-01T00:30:00+02:00' }, { rq: 1 });         // local May 1 (UTC says April 30)
  vl('WR1', { reg: E1 }, { rq: 1 });                                  // the last second is in
  vl('WR1', { reg: J1 }, {});                                         // out (UTC says May 31 and would count it)
  vl('WR1', { reg: RB }, {});                                         // out
  vl('WR1', { reg: '2026-05-15' }, { rq: 1 });                        // a date alone is midnight of that day
  vl('WR1', { reg: null }, {});                                       // no registered stamp
  vl('WR1', { id: 'T27W-WR1-DUP', obr: 1 }, { rq: 1 });               // one lab number in two OBR sets and two spellings is ONE request
  vl('WR1', { id: 'T27W-WR1-DUP', obr: 2 }, {});
  vl('WR1', { id: 't27w-wr1-dup ', obr: 3 }, {});
  vl('WR1', { panel: 'TBGNX' }, {});                                  // another panel is in neither half
  vl('WR1', { panel: 'hivvl ' }, { rq: 1 });                          // the panel compares ignoring case and trailing spaces
  vl('WR1', { noReport: true }, {});                                  // no report, no testing lab
  vl('WR1', { perf: '' }, {});                                        // no testing lab: v1 would use the receiving lab, CE has none
  vl('WR1', { perf: '   ' }, {});
  vl('WR1', { perf: null }, {});

  // -- WT1: Tests (F lines 18-38): registered AND analysed in the window, with a result of observation HIVV_ --
  const tests = (spec, d) => vl('WT1', { ana: ANA, ...spec }, { rq: 1, ...d });
  tests({ results: [VLR] }, { te: 1 });
  tests({ results: [{ obs: 'hivvc', text: '1500' }] }, { te: 1 });   // LIKE ignores case
  tests({ results: [{ obs: 'HIVVD ', text: '1500' }] }, { te: 1 });  // and a trailing blank fills the underscore
  tests({ results: [{ obs: 'HIVPC', text: '1500' }] }, {});          // HIVP_ is the EID pattern
  tests({ results: [{ obs: 'HIVV', text: '1500' }] }, {});           // one character too short
  tests({ results: [{ obs: 'HIVVLX', text: '1500' }] }, {});         // one too long
  tests({ ana: E0, results: [VLR] }, { te: 1 });                     // analysed at the first instant
  tests({ ana: E1, results: [VLR] }, { te: 1 });                     // and the last second
  tests({ ana: J1, results: [VLR] }, {});                            // the first instant after
  tests({ ana: '2026-04-30T23:59:59+02:00', results: [VLR] }, {});   // the last second before
  tests({ ana: '2026-05-12', results: [VLR] }, { te: 1 });           // a date alone
  tests({ results: [VLR, { obs: 'HIVVC', text: '900' }] }, { te: 1 });         // two results, one test
  tests({ results: [{ obs: 'HIVPC', text: '1500' }, VLR] }, { te: 1 });
  tests({ ana: null, results: [VLR] }, {});
  tests({ results: [] }, {});

  // -- WA1: TestedAuthorised (F lines 40-65), and what LabTAT averages (F line 253) --
  const auth = (spec, d) => vl('WA1', { ana: ANA, iss: ISS, results: [VLR], ...spec }, { rq: 1, te: 1, ta: 1, tat: 2, ...d });
  auth({}, {});                                                      // a final report, a valid text
  auth({ status: 'preliminary' }, { ta: 0 });                        // HL7ResultStatusCode = 'F' only
  auth({ status: 'FINAL ' }, {});                                    // compared ignoring case and trailing spaces
  auth({ status: 'cancelled' }, { ta: 0 });
  auth({ iss: J1 }, { ta: 0, tat: 22 });                             // authorised the first instant after
  auth({ iss: '2026-04-30T23:59:59+02:00' }, { ta: 0, tat: -10 });  // and the last second before
  auth({ iss: E0 }, { tat: -9 });                                    // the first instant is in
  auth({ iss: E1 }, { tat: 21 });                                    // and the last second
  auth({ iss: null }, { ta: 0, tat: undefined });                    // not authorised: no turnaround either
  auth({ results: [{ obs: 'HIVVL' }] }, { ta: 0 });                  // a result with no value: NOT IN of NULL is unknown
  auth({ results: [{ obs: 'HIVVL', text: 'Haemolysed' }, VLR] }, { orj: 1 });   // one valid result is enough
  auth({ ana: '2026-06-02T09:00:00+02:00' }, { te: 0, ta: 0 });      // analysed after the window
  auth({ results: [{ obs: 'HIVPC', text: '1500' }] }, { te: 0, ta: 0 });

  // -- WB1: BacklogTests and BacklogTestsAuthorised (F lines 66-112): analysed in the window, registered before @From --
  const back = (spec, d) => vl('WB1', { reg: RB, ana: BA0, results: [VLR], ...spec }, d);
  back({}, { bk: 1 });
  back({ reg: '2026-04-15T08:00:00+02:00', iss: '2026-05-03T10:00:00+02:00' }, { bk: 1, ba: 1 });
  back({ iss: '2026-05-03T10:00:00+02:00', status: 'preliminary' }, { bk: 1 });
  back({ iss: '2026-05-03T10:00:00+02:00', results: [{ obs: 'HIVVL', text: 'FAIL' }] }, { bk: 1, orj: 1 });
  back({ iss: J1 }, { bk: 1 });
  back({ ana: E0 }, { bk: 1 });
  back({ ana: E1 }, { bk: 1 });
  back({ ana: J1 }, {});
  back({ results: [] }, {});
  back({ results: [{ obs: 'HIVPC', text: '1500' }] }, {});
  back({ id: 'T27W-WB1-DUP', obr: 1 }, { bk: 1 });                  // one lab number in two OBR sets counts once
  back({ id: 'T27W-WB1-DUP', obr: 2 }, {});
  back({ reg: null }, {});                                           // no registered stamp is not "before"
  back({ reg: '2026-04' }, {});                                      // nor is a partial one (as text it sorts before the window)
  // registered in the window: a test, not a backlog (the first instant, and 00:30 local, which is April 30 in UTC)
  vl('WB1', { reg: E0, ana: BA0, results: [VLR] }, { rq: 1, te: 1 });
  vl('WB1', { reg: '2026-05-01T00:30:00+02:00', ana: BA0, results: [VLR] }, { rq: 1, te: 1 });

  // -- WK1: a lab with a backlog test and no request registered in the period is not listed (F lines 255-262) --
  vl('WK1', { reg: RB, ana: BA0, results: [VLR] }, { bk: 1 });

  // -- WJ1: Rejects (F lines 113-130): analysed in the window with a rejection code; no result and no registered stamp needed --
  const rej = (spec, d) => vl('WJ1', { reg: RB, ana: ANA, ...spec }, d);
  vl('WJ1', {}, { rq: 1 });                                          // the lab's first request
  rej({ rej: 'R01' }, { rj: 1 });
  vl('WJ1', { rej: 'R02', ana: ANA }, { rq: 1, rj: 1 });
  vl('WJ1', { rej: '  ', ana: ANA }, { rq: 1 });                     // LEN of spaces is 0
  vl('WJ1', { rej: '', ana: ANA }, { rq: 1 });
  vl('WJ1', { rej: null, ana: ANA }, { rq: 1 });
  vl('WJ1', { rej: 'R03', ana: '2026-06-02T09:00:00+02:00' }, { rq: 1 });   // analysed after the window
  vl('WJ1', { rej: 'R04', ana: null }, { rq: 1 });
  rej({ rej: 'R05', id: 'T27W-WJ1-DUP', obr: 1 }, { rj: 1 });        // two OBR sets, one request
  rej({ rej: 'R05', id: 'T27W-WJ1-DUP', obr: 2 }, {});
  vl('WJ1', { rej: 'R06', ana: ANA, results: [VLR] }, { rq: 1, te: 1, rj: 1 });
  rej({ rej: 'R07', ana: E1 }, { rj: 1 });
  rej({ rej: 'R08', ana: J1 }, {});
  rej({ rej: ' R09' }, { rj: 1 });                                   // a leading space counts
  rej({ rej: 'R10', status: 'cancelled' }, { rj: 1 });               // no status test

  // -- WX: ORejects (F lines 131-154), Invalids (155-177), Suppressed (178-203), Positives and Indeterminates by result text --
  // Each row: a request registered, analysed and authorised in the window with a final report and one result. [ta, orj, inv, su] by hand:
  //   ta   not in the 13 invalid texts (F lines 56, 101, 192)         orj  not numeric and not in the 15 known texts (F line 145)
  //   inv  not numeric and LIKE 'INV%' (F line 168)                   su   not invalid and (one of 10 texts, a number under 1000, or a coded value)
  const text = (t, ta, orj, inv, su, extra = {}) => ({ r: { obs: 'HIVVL', text: t, ...extra }, ta, orj, inv, su });
  const WX = [
    // the 13 invalid texts (F line 56)
    text('INVAL', 0, 0, 1, 0), text('Please repeat', 0, 1, 0, 0), text('Insufficient serum received', 0, 1, 0, 0),
    text('Insufficient for further tests', 0, 1, 0, 0), text('Indeterminate', 0, 1, 0, 0), text('Haemolysed', 0, 1, 0, 0), text('FAIL', 0, 1, 0, 0),
    text('Absent', 0, 1, 0, 0), text('Haemolysed ++', 0, 1, 0, 0), text('Icteric ++++', 0, 1, 0, 0), text('INV', 0, 0, 1, 0),
    text('This result has been checked', 0, 1, 0, 0), text('to confirm patient identity.', 0, 1, 0, 0),
    // the 15 known texts (F line 145) that are not invalid texts
    text('NDET', 1, 0, 0, 1), text('<30 copies/mL', 1, 0, 0, 1), text('<30 copies/ml', 1, 0, 0, 1), text('Target Not Detected', 1, 0, 0, 1),
    text('TAR', 1, 0, 0, 1), text('RNA not detected', 1, 0, 0, 1), text('< 20', 1, 0, 0, 1), text('<20', 1, 0, 0, 0), text('<20 copies/ml', 1, 0, 0, 1),
    text('> 10000000', 1, 0, 0, 0), text('Target Not Detected.', 1, 0, 0, 0), text('INVALID', 1, 0, 1, 0), text('ND', 1, 0, 0, 1),
    // the suppressed texts (F line 194) that are not known texts
    text('TARG', 1, 1, 0, 1), text('<20 copies/mL', 1, 0, 0, 1),
    // spellings: case and trailing spaces are ignored, a leading space is not
    text('target not detected  ', 1, 0, 0, 1), text('nd ', 1, 0, 0, 1), text('ndet', 1, 0, 0, 1), text('haemolysed ', 0, 1, 0, 0), text('inv', 0, 0, 1, 0),
    text(' INV', 1, 1, 0, 0), text(' nd', 1, 1, 0, 0),
    // other texts
    text('Positive', 1, 1, 0, 0), text('Negative', 1, 1, 0, 0), text('inv123', 1, 1, 1, 0), text('XINV', 1, 1, 0, 0), text('', 1, 1, 0, 0), text('  ', 1, 1, 0, 0),
    // numbers: ISNUMERIC is true, so not an ORejects text; under 1000 is suppressed (F line 195)
    text('1500', 1, 0, 0, 0), text('999', 1, 0, 0, 1), text('1000', 1, 0, 0, 0), text('0', 1, 0, 0, 1), text('-5', 1, 0, 0, 1), text(' 12 ', 1, 0, 0, 1),
    // v1 stops with a conversion error on a decimal (cast to bigint); the port reads the number (spec ruling 2)
    text('999.5', 1, 0, 0, 1), text('1200.5', 1, 0, 0, 0),
    // a value held as a number (the comparator and the number make the text)
    { r: { obs: 'HIVVL', num: 500 }, ta: 1, orj: 0, inv: 0, su: 1 },
    { r: { obs: 'HIVVL', num: 1000 }, ta: 1, orj: 0, inv: 0, su: 0 },
    { r: { obs: 'HIVVL', cmp: '<', num: 20 }, ta: 1, orj: 0, inv: 0, su: 1 },
    { r: { obs: 'HIVVL', cmp: '>', num: 10000000 }, ta: 1, orj: 0, inv: 0, su: 0 },
    // a coded value: any non-empty one is suppressed (F line 195), a blank one is not
    text('Positive', 1, 1, 0, 1, { coded: 'X' }), text('Positive', 1, 1, 0, 0, { coded: '  ' }), text('Positive', 1, 1, 0, 0, { coded: '' }),
    text('FAIL', 0, 1, 0, 0, { coded: 'X' }), text('1500', 1, 0, 0, 1, { coded: 'N' }),
    { r: { obs: 'HIVVL', coded: 'X' }, ta: 1, orj: 1, inv: 0, su: 1 },                          // only a coded value: the text is the code
    { r: { obs: 'HIVVL', coded: 'P' }, ta: 1, orj: 1, inv: 0, su: 1, po: 1 },
    { r: { obs: 'HIVVL', text: 'Positive', coded: 'POS' }, ta: 1, orj: 1, inv: 0, su: 1, po: 1 },
    { r: { obs: 'HIVVL', text: 'Indet', coded: 'I' }, ta: 1, orj: 1, inv: 0, su: 1, id: 1 },
  ];
  WX.forEach((x) => vl('WX', { ana: ANA, iss: ISS, results: [x.r] }, { rq: 1, te: 1, ta: x.ta, orj: x.orj, inv: x.inv, su: x.su, po: x.po ?? 0, id: x.id ?? 0, tat: 2 }));
  // not final: only ORejects and Invalids (no status test) count
  vl('WX', { ana: ANA, iss: ISS, status: 'preliminary', results: [{ obs: 'HIVVL', text: 'ND' }] }, { rq: 1, te: 1, tat: 2 });
  vl('WX', { ana: ANA, iss: ISS, status: 'preliminary', results: [{ obs: 'HIVVL', text: 'Garbage' }] }, { rq: 1, te: 1, orj: 1, tat: 2 });
  vl('WX', { ana: ANA, iss: ISS, status: 'preliminary', results: [{ obs: 'HIVVL', text: 'inv9' }] }, { rq: 1, te: 1, orj: 1, inv: 1, tat: 2 });
  vl('WX', { ana: ANA, iss: ISS, status: 'cancelled', results: [{ obs: 'HIVVL', text: '999' }] }, { rq: 1, te: 1, tat: 2 });
  // authorised after the window, analysed after the window, not authorised, wrong observation: none of the five counts
  vl('WX', { ana: ANA, iss: J1, results: [{ obs: 'HIVVL', text: 'Garbage' }] }, { rq: 1, te: 1, tat: 22 });
  vl('WX', { ana: ANA, iss: J1, results: [{ obs: 'HIVVL', text: 'inv9' }] }, { rq: 1, te: 1, tat: 22 });
  vl('WX', { ana: ANA, iss: J1, results: [{ obs: 'HIVVL', text: 'ND' }] }, { rq: 1, te: 1, tat: 22 });
  vl('WX', { ana: J1, iss: ISS, results: [{ obs: 'HIVVL', text: 'Garbage' }] }, { rq: 1, tat: 2 });
  vl('WX', { ana: J1, iss: ISS, results: [{ obs: 'HIVVL', text: 'ND' }] }, { rq: 1, tat: 2 });
  vl('WX', { ana: J1, iss: ISS, results: [{ obs: 'HIVVL', text: 'inv9' }] }, { rq: 1, tat: 2 });
  // registered BEFORE the period: Invalids (F 155-177) read no registered stamp. A backlog test (INVALID is no invalid text, so it is also
  // authorised) that is an Invalid; 'INVALID' is a known text, so it is no ORejects.
  vl('WX', { reg: RB, ana: BA0, iss: '2026-05-03T10:00:00+02:00', results: [{ obs: 'HIVVL', text: 'INVALID' }] }, { bk: 1, ba: 1, inv: 1 });
  vl('WX', { ana: ANA, iss: null, results: [{ obs: 'HIVVL', text: 'Garbage' }] }, { rq: 1, te: 1 });
  vl('WX', { ana: ANA, iss: ISS, results: [{ obs: 'HIVPC', text: 'Garbage' }] }, { rq: 1, tat: 2 });
  vl('WX', { ana: ANA, iss: ISS, results: [{ obs: 'HIVPC', text: 'inv9' }] }, { rq: 1, tat: 2 });
  vl('WX', { ana: ANA, iss: ISS, results: [{ obs: 'HIVPC', text: 'ND' }] }, { rq: 1, tat: 2 });
  // two results of one request: counted once, and each count looks at its own result
  vl('WX', { ana: ANA, iss: ISS, results: [{ obs: 'HIVVL', text: 'Garbage' }, { obs: 'HIVVC', text: 'Other' }] }, { rq: 1, te: 1, ta: 1, orj: 1, tat: 2 });
  vl('WX', { ana: ANA, iss: ISS, results: [{ obs: 'HIVVL', text: 'ND' }, { obs: 'HIVVC', text: 'Garbage' }] }, { rq: 1, te: 1, ta: 1, orj: 1, su: 1, tat: 2 });

  // -- WP1: Positives (F lines 204-228) and Indeterminates (229-252): the coded value, no status test, no registered stamp needed --
  const coded = (c, spec, d) => vl('WP1', { ana: ANA, iss: ISS, status: 'preliminary', results: [{ obs: 'HIVVL', text: '1500', coded: c }], ...spec }, { rq: 1, te: 1, tat: 2, ...d });
  coded('P', {}, { po: 1 });
  coded('pos ', {}, { po: 1 });
  coded('DTS', {}, { po: 1 });
  coded('POSITIVE', {}, {});
  coded('N', {}, {});
  coded(' P', {}, {});
  coded('P', { iss: J1 }, { tat: 22 });
  coded('P', { iss: null }, { tat: undefined });
  coded('P', { ana: J1 }, { te: 0 });
  coded('P', { results: [{ obs: 'HIVPC', text: '1500', coded: 'P' }] }, { te: 0 });
  coded('P', { reg: RB }, { rq: 0, te: 0, po: 1, bk: 1, tat: undefined });
  coded('P', { results: [{ obs: 'HIVVL', text: '1500', coded: 'P' }, { obs: 'HIVVC', text: '1500', coded: 'P' }] }, { po: 1 });
  coded('I', {}, { id: 1 });
  coded('i ', {}, { id: 1 });
  coded('IND', {}, {});
  coded(' I', {}, {});
  coded('I', { iss: J1 }, { tat: 22 });
  coded('I', { ana: J1 }, { te: 0 });
  // an invalid text with a coded value: Positives and Indeterminates (F 204-252) do not look at the text, so both count; TestedAuthorised does
  // (FAIL is an invalid text), and ORejects counts FAIL.
  vl('WP1', { ana: ANA, iss: ISS, results: [{ obs: 'HIVVL', text: 'FAIL', coded: 'P' }] }, { rq: 1, te: 1, orj: 1, po: 1, tat: 2 });
  vl('WP1', { ana: ANA, iss: ISS, results: [{ obs: 'HIVVL', text: 'FAIL', coded: 'I' }] }, { rq: 1, te: 1, orj: 1, id: 1, tat: 2 });
  coded('I', { results: [{ obs: 'HIVPC', text: '1500', coded: 'I' }] }, { te: 0 });
  coded('I', { reg: RB }, { rq: 0, te: 0, id: 1, bk: 1, tat: undefined });
  coded('P', { results: [{ obs: 'HIVVL', text: '1500', coded: 'P' }, { obs: 'HIVVC', text: '1500', coded: 'I' }] }, { po: 1, id: 1 });

  // -- WL1 to WL8: LabTAT (F line 253): the whole-day average of local dates, cut toward zero, over the requests registered in the window --
  const noTat = (lab, reg, iss) => vl(lab, { reg, iss }, { rq: 1 });
  const tatDays = (lab, reg, iss, days) => vl(lab, { reg, iss }, { rq: 1, tat: days });
  tatDays('WL1', '2026-05-10T08:00:00+02:00', '2026-05-11T09:00:00+02:00', 1);
  tatDays('WL1', '2026-05-10T08:00:00+02:00', '2026-05-12T09:00:00+02:00', 2);
  tatDays('WL1', '2026-05-10T08:00:00+02:00', '2026-05-12T10:00:00+02:00', 2);          // 5 / 3 = 1.67 gives 1 (rounding gives 2)
  tatDays('WL2', '2026-05-10T08:00:00+02:00', '2026-05-09T09:00:00+02:00', -1);
  tatDays('WL2', '2026-05-10T08:00:00+02:00', '2026-05-08T09:00:00+02:00', -2);         // -3 / 2 = -1.5 gives -1 (flooring gives -2)
  noTat('WL3', REG, null);                                                               // nothing authorised: NULL
  tatDays('WL4', '2026-05-10T08:00:00+02:00', '2026-05-13T08:00:00+02:00', 3);
  vl('WL4', { reg: RB, ana: BA0, iss: '2026-05-30T08:00:00+02:00' }, {});               // registered before: not in the average
  tatDays('WL5', '2026-05-10T08:00:00+02:00', '2026-05-13T08:00:00+02:00', 3);
  noTat('WL5', REG, null);                                                               // NULL is left out (an average of 3, 4 and 0 would be 2)
  tatDays('WL5', '2026-05-10T08:00:00+02:00', '2026-05-14T08:00:00+02:00', 4);
  vl('WL6', { id: 'T27W-WL6-X', obr: 1, iss: '2026-05-11T08:00:00+02:00' }, { rq: 1, tat: 1 });   // one request in two OBR sets: two rows in the average
  vl('WL6', { id: 'T27W-WL6-X', obr: 2, iss: '2026-05-11T08:00:00+02:00' }, { tat: 1 });
  vl('WL6', { id: 'T27W-WL6-Y', iss: '2026-05-15T08:00:00+02:00' }, { rq: 1, tat: 5 });          // (1 + 1 + 5) / 3 = 2; per request it would be 3
  tatDays('WL7', '2026-05-10T23:30:00+02:00', '2026-05-11T00:30:00+02:00', 1);          // an hour apart across midnight: 1 date boundary (UTC says 0)
  tatDays('WL8', '2026-05-10T08:00:00+02:00', '2026-05-10T09:00:00+02:00', 0);          // the same day: 0, not NULL

  // -- WD1: the end day is a whole day (F line 262). The one-day suite asks for May 12 only. --
  ['2026-05-11T23:59:59+02:00', '2026-05-12T00:00:00+02:00', '2026-05-12T23:59:59+02:00', '2026-05-13T00:00:00+02:00'].forEach((reg) => vl('WD1', { reg }, { rq: 1 }));

  // -- Both halves, one dictionary: the EID half (panel HIVPC, observations HIVP_) --
  const geid = (lab, spec, d) => eid(lab, { ana: ANA, iss: ISS, results: [{ obs: 'HIVPC', text: 'Negative', coded: 'N' }], ...spec }, d);
  geid('WE1', {}, { rq: 1, te: 1, ta: 1, orj: 1, su: 1, tat: 2 });
  geid('WE1', { results: [{ obs: 'HIVPC', text: 'Positive', coded: 'P' }] }, { rq: 1, te: 1, ta: 1, orj: 1, su: 1, po: 1, tat: 2 });
  geid('WE1', { results: [{ obs: 'HIVPC', text: 'Inconclusive', coded: 'I' }] }, { rq: 1, te: 1, ta: 1, orj: 1, su: 1, id: 1, tat: 2 });
  geid('WE1', { results: [{ obs: 'HIVPR', text: '1500' }] }, { rq: 1, te: 1, ta: 1, tat: 2 });          // HIVP_ matches
  geid('WE1', { results: [{ obs: 'HIVVL', text: '1500' }] }, { rq: 1, tat: 2 });                           // HIVV_ is the VL pattern
  geid('WE1', { status: 'preliminary' }, { rq: 1, te: 1, orj: 1, tat: 2 });
  geid('WE1', { reg: RB, ana: BA0, iss: '2026-05-03T10:00:00+02:00' }, { bk: 1, ba: 1, orj: 1, su: 1 });
  geid('WE1', { reg: RB, ana: BA0, iss: null, results: [{ obs: 'HIVPC', text: '1500' }], rej: 'R01' }, { bk: 1, rj: 1 });
  geid('WE1', { results: [{ obs: 'HIVPC', text: 'INVALID' }] }, { rq: 1, te: 1, ta: 1, inv: 1, tat: 2 });
  vl('WE1', { ana: ANA, iss: ISS, results: [VLR] }, { rq: 1, te: 1, ta: 1, tat: 2 });                      // the same lab in the VL half
  vl('WE1', { reg: RB, ana: BA0, iss: null, results: [VLR] }, { bk: 1 });
  // the panel decides the half, not the observation: an EID request with a VL result has no test
  eid('WE2', { ana: ANA, iss: ISS, results: [VLR] }, { rq: 1, tat: 2 });

  // -- Lab spellings: case and trailing spaces are one lab; the spelling shown is the smallest in byte order --
  vl('WC1', { ana: ANA, iss: ISS, results: [VLR], perf: 'WC1' }, { rq: 1, te: 1, ta: 1, tat: 2 });
  vl('WC1', { ana: ANA, iss: ISS, results: [VLR], perf: 'wc1 ', display: 'Case Lab' }, { rq: 1, te: 1, ta: 1, tat: 2 });
  names.set('wc1', 'Case Lab');
  // the same request number at two spellings of the lab is one request of that lab
  vl('WC2', { id: 'T27W-WC2-S', perf: 'WC2' }, { rq: 1 });
  vl('WC2', { id: 'T27W-WC2-S', perf: 'wc2 ', obr: 2 }, {});

  // -- Lab names (spec ruling 8): the constant CASE of W lines 23-32 (every constant lab, in both halves; the dictionary name must lose
  // to the constant; three are spelled another way), then the dictionary (labNamesCte) --
  WS_CONSTANT.forEach(([code, constant]) => {
    const spelled = { ZUX: 'zux', ZUC: 'ZUC  ', ZLR: 'zlr ' }[code] ?? code;
    vl(spelled, { display: `Dict ${code}` }, { rq: 1 });
    eid(spelled, { display: `Dict ${code}` }, { rq: 1 });
    names.set(keyOf(spelled), constant);
  });
  // a lab named by its report in one half only: one name for the lab in both halves
  vl('WN1', { display: 'Name One' }, { rq: 1 });
  eid('WN1', { display: null }, { rq: 1 });
  names.set('wn1', 'Name One');
  // no report name: the register name of the mapped code
  vl('WN2', { display: null }, { rq: 1 });
  map('t27w-fm-n2', 'WN2', 't27w-reg-n2', 'Mapped Name Two', 'Lusaka', 'Lusaka', '9');
  names.set('wn2', 'Mapped Name Two');
  // neither: the code; a blank report name counts as missing
  vl('WN3', { display: null }, { rq: 1 });
  names.set('wn3', 'WN3');
  vl('WN4', { display: '  ' }, { rq: 1 });
  names.set('wn4', 'WN4');
  // two names: the smallest in byte order; a name that is only the code loses to a real one
  vl('WN5', { display: 'Zeta Name' }, { rq: 1 });
  vl('WN5', { display: 'Alpha Name' }, { rq: 1 });
  names.set('wn5', 'Alpha Name');
  vl('WN6', { display: 'WN6' }, { rq: 1 });
  vl('WN6', { display: 'Real Name' }, { rq: 1 });
  names.set('wn6', 'Real Name');

  // The expected rows. v1 lists a lab only when it has a request registered in the window (F lines 255-262).
  const wsRows = [];
  for (const type of ['EID', 'HIVVL']) {
    for (const [k, r] of stats[type]) {
      if (r.rq === 0) continue;
      wsRows.push({
        TestType: type, Lab: r.lab, LabName: names.get(k), Requests: r.rq, Tests: r.te, TestedAuthorised: r.ta, BacklogTests: r.bk, BacklogTestsAuthorised: r.ba,
        Rejects: r.rj, ORejects: r.orj, Invalids: r.inv, Suppressed: r.su, Positives: r.po, Indeterminates: r.id,
        LabTAT: r.tat.length === 0 ? null : Math.trunc(r.tat.reduce((a, b) => a + b, 0) / r.tat.length),
      });
    }
  }
  const wsDayRow = { TestType: 'HIVVL', Lab: 'WD1', LabName: 'Lab WD1', Requests: 2, Tests: 0, TestedAuthorised: 0, BacklogTests: 0, BacklogTestsAuthorised: 0,
    Rejects: 0, ORejects: 0, Invalids: 0, Suppressed: 0, Positives: 0, Indeterminates: 0, LabTAT: null };

  // =========================================================================================================================
  // Tests authorised by lab and type (prefix t27s-)
  // =========================================================================================================================
  const S = 't27s-';
  const SANA = '2026-05-06T09:00:00+02:00';
  const SISS = '2026-05-07T10:00:00+02:00';
  const NO_LEAD = [null, null, null, null, null];
  const sums = new Map(); // lab key -> { lead, counts }
  let sn = 0;
  // A request of lab `lab` (as stored) with panel `panel`, authorised SISS unless `o` says otherwise; `types` are the columns v1 counts it in.
  // `lead` is the lab's expected six leading columns, or null for a request that has no row (it is left out, or its lab has none).
  function sreq(lab, lead, panel, types, o = {}) {
    sn += 1;
    add(S, { id: `T27S-${sn}`, panel, reg: '2026-05-01T08:00:00+02:00', ana: SANA, iss: SISS, perf: lab, ...o });
    if (lead === null) return;
    const key = lab.toLowerCase().trimEnd();
    if (!sums.has(key)) sums.set(key, { lead, counts: Object.fromEntries(SUM_TYPES.map((t) => [t, 0])) });
    for (const t of types) sums.get(key).counts[t] += 1;
  }

  // register rows and the mapping of the labs to them (the lab's own facility)
  const ZM = 'urn:openldr:zm:facilities';
  const reg = (id, code, name, extras) => regs.push(`(${lit(id)}, ${lit(ZM)}, ${lit(code)}, ${lit(name)}, 'in_register', ${lit(extras)})`);
  reg('t27s-reg1', '1001', 'Choma General Hospital', '{"hims_code":"30010001","type":"Hospital"}');
  reg('t27s-reg2', '1002', 'Chilenje Clinic', '{ "type" : "Clinic" , "hims_code":"x"}');
  reg('t27s-reg4', '1004', 'No Extras Clinic', null);
  reg('t27s-reg5', '1005', 'Own Type Post', '{"ownership_type":"Public","type":"Health Post"}');
  reg('t27s-reg8', '1008', 'Case Hospital', '{"type":"District Hospital"}');
  reg('t27s-reg9', '1009', 'Second Mapping Hospital', '{"type":"Other Type"}');
  reg('t27s-reg10', '1010', 'Src Hospital', '{"type":"Provincial Hospital"}');
  map('t27s-fm-sl1-a', 'SL1', 't27s-reg1', 'Choma General Hospital', 'Southern', 'Choma', '1001');
  map('t27s-fm-sl1-b', 'SL1', 't27s-reg9', 'Second Mapping Hospital', 'Western', 'Mongu', '1009');   // the later id loses
  map('t27s-fm-sl2', 'SL2', 't27s-reg2', 'Chilenje Clinic', 'Lusaka', 'Lusaka', '1002');
  map('t27s-fm-sl4', 'SL4', 't27s-reg4', 'No Extras Clinic', 'Central', 'Kabwe', '1004');
  map('t27s-fm-sl5', 'SL5', 't27s-reg5', 'Own Type Post', 'Copperbelt', 'Kitwe', '1005');
  map('t27s-fm-sl6', 'SL6', null, 'Unregistered Name', 'Northern', 'Kasama', '1006');               // not in the register
  map('t27s-fm-sl7', 'SL7', 't27s-reg1', 'Wrong System', 'Southern', 'Choma', '1001', { ps: 'urn:other' });
  map('t27s-fm-sl8', 'SL8', 't27s-reg8', 'Case Hospital', 'Eastern', 'Chipata', '1008');
  map('t27s-fm-sl10', 'SL10', 't27s-reg10', 'Src Hospital', 'North-Western', 'Solwezi', '1010', { ss: 'urn:src', ps: 'urn:perf' });
  map('t27s-fm-sl11', 'SL11', 't27s-reg10', 'Src Hospital', 'North-Western', 'Solwezi', '1010', { ss: 'urn:src' });

  // FacilityCode is NULL everywhere (ruling 7); the mapped rows still carry a national code, which must not show.
  const L1 = ['Southern', 'Choma', 'Choma General Hospital', null, 'Hospital', 'SL1'];
  // SL1: request rows, not distinct requests (S line 9 sums rows); the window is the local date of the authorised stamp (S line 109)
  sreq('SL1', L1, 'ALT', ['ALT']);
  sreq('SL1', L1, 'ALT', ['ALT'], { id: 'T27S-DUP', obr: 1 });
  sreq('SL1', L1, 'ALT', ['ALT'], { id: 'T27S-DUP', obr: 2 });                                      // the same lab number twice counts twice
  sreq('SL1', L1, 'fbc', ['Full Blood Count']);                                                      // case and trailing spaces are ignored
  sreq('SL1', L1, 'FBCD4 ', ['Full Blood Count']);
  sreq('SL1', L1, 'CREA', ['Creatinine'], { iss: '2026-05-04T00:00:00+02:00' });                     // the first instant
  sreq('SL1', L1, 'CREA', ['Creatinine'], { iss: '2026-05-04T00:30:00+02:00' });                     // local May 4 (UTC says May 3)
  sreq('SL1', L1, 'CREA', ['Creatinine'], { iss: '2026-05-10T23:59:59+02:00' });                     // the last second
  sreq('SL1', L1, 'CREA', [], { iss: '2026-05-03T23:59:59+02:00' });                                 // the second before
  sreq('SL1', L1, 'CREA', [], { iss: '2026-05-11T00:00:00+02:00' });                                 // the first instant after (UTC says May 10)
  sreq('SL1', L1, 'AST', [], { ana: null });                                                         // not analysed (S line 110)
  sreq('SL1', L1, 'AST', [], { iss: null });                                                         // not authorised (S line 111)
  sreq('SL1', L1, 'AST', [], { iss: '2026-05' });                                                    // a partial stamp has no date
  sreq('SL1', L1, 'TBGXP', []);                                                                      // a panel that is not listed
  sreq('SL1', L1, 'HEPB', ['Hepatitis B'], { status: 'cancelled' });                                 // no status test (S line 114 is commented out)
  sreq('SL1', L1, 'HEPB', ['Hepatitis B'], { status: 'preliminary' });
  sreq('SL1', L1, 'GLUC', ['Glucose'], { reg: null });                                               // the registered stamp is not read
  // the other labs
  sreq('SL2', ['Lusaka', 'Lusaka', 'Chilenje Clinic', null, 'Clinic', 'SL2'], 'HIVVL', ['HIV VL']);
  sreq('SL2', ['Lusaka', 'Lusaka', 'Chilenje Clinic', null, 'Clinic', 'SL2'], 'POCVR', ['HIV VL']);
  sreq('SL3', [...NO_LEAD, 'SL3'], 'AST', ['AST']);                                                  // not mapped: NULL province, district, facility
  sreq('SL4', ['Central', 'Kabwe', 'No Extras Clinic', null, null, 'SL4'], 'ALT', ['ALT']);        // no extras: NULL type
  sreq('SL5', ['Copperbelt', 'Kitwe', 'Own Type Post', null, 'Health Post', 'SL5'], 'ALT', ['ALT']);   // "ownership_type" is not "type"
  sreq('SL6', [...NO_LEAD, 'SL6'], 'ALT', ['ALT']);                                                  // the mapping has no register row
  sreq('SL7', [...NO_LEAD, 'SL7'], 'ALT', ['ALT']);                                                  // the mapping is for another performer system
  sreq('SL8', ['Eastern', 'Chipata', 'Case Hospital', null, 'District Hospital', 'SL8'], 'ALT', ['ALT']);
  sreq('sl8 ', ['Eastern', 'Chipata', 'Case Hospital', null, 'District Hospital', 'SL8'], 'ALT', ['ALT']);   // another spelling: the same lab
  sreq('SL10', ['North-Western', 'Solwezi', 'Src Hospital', null, 'Provincial Hospital', 'SL10'], 'ALT', ['ALT'], { ss: 'urn:src', ps: 'urn:perf' });
  sreq('SL11', [...NO_LEAD, 'SL11'], 'ALT', ['ALT'], { ps: null, ss: null });                        // the mapping needs the report's source system too
  sreq('XXXX', [...NO_LEAD, 'XXXX'], 'ALT', ['ALT']);                                                // only the five codes are left out, not a longer one
  // no testing code: v1 falls back to the receiving lab, which CE does not carry. The counts stay, in a row with no lab.
  sreq('', [null, null, null, null, null, null], 'ALT', ['ALT']);
  sreq('   ', [null, null, null, null, null, null], 'ALT', ['ALT']);
  sreq(null, null, 'ALT', []);                                                                       // NULL: left out (S line 112: NOT IN of NULL is unknown)
  // the five excluded testing codes, in other spellings too
  SUM_OUT.forEach((code, i) => sreq(i === 1 ? `${code.toLowerCase()} ` : i === 2 ? code.toLowerCase() : code, null, 'ALT', []));
  sreq('SX1', null, 'ALT', [], { noReport: true });                                                  // no report: not authorised
  // every panel code, one lab each, so a code in the wrong column shows (the first three spelled another way)
  Object.entries(SUM_MAP).forEach(([code, types], i) => {
    const panel = i % 3 === 1 ? code.toLowerCase() : i % 3 === 2 ? `${code} ` : code;
    sreq(`SP-${code}`, [...NO_LEAD, `SP-${code}`], panel, types);
  });
  // panel codes that are not listed: a lab with only those has no row
  ['TBGXP', 'COVID', 'HIVR2', 'FBC1', ' ', ''].forEach((panel) => sreq('SOUT', null, panel, []));

  const sumRows = [...sums.values()].map((s) => ({
    Province: s.lead[0], District: s.lead[1], Facility: s.lead[2], FacilityCode: s.lead[3], FacilityType: s.lead[4], LabCode: s.lead[5], ...s.counts,
  }));
  const sumDayRows = [{ Province: 'Southern', District: 'Choma', Facility: 'Choma General Hospital', FacilityCode: null, FacilityType: 'Hospital', LabCode: 'SL1',
    ...Object.fromEntries(SUM_TYPES.map((t) => [t, t === 'Creatinine' ? 1 : 0])) }];

  // =========================================================================================================================
  // VL throughput by lab and month (prefix t27t-)
  // =========================================================================================================================
  const T = 't27t-';
  let tn = 0;
  // A VL request of `lab` registered `reg`; a result row of observation `obs` makes it a test once the report is final.
  const treq = (lab, reg, o = {}) => { tn += 1; return add(T, { id: `T27T-${tn}`, perf: lab, reg, ...o }); };
  const fin = (iss, obs = 'HIVVL', o = {}) => ({ iss, results: [{ obs }], ...o });
  treq('TA1', '2026-05-03T10:00:00+02:00', fin('2026-05-04T10:00:00+02:00'));                                  // r1: tested in May
  treq('TA1', '2026-05-31T23:30:00+02:00', fin('2026-06-02T10:00:00+02:00', 'HIVVC'));                         // r2: registered in May, tested in June
  treq('TA1', '2026-05-20T10:00:00+02:00', fin('2026-05-21T10:00:00+02:00', 'HIVVL', { status: 'preliminary' }));   // r3: not final
  treq('TA1', '2026-06-01T00:30:00+02:00');                                                                    // r4: June in Zambia (UTC says May)
  treq('TA1', '2025-05-10T10:00:00+02:00', fin('2025-05-12T10:00:00+02:00'));                                  // r5: May 2025
  treq('TA1', '2025-05-15T10:00:00+02:00');                                                                    // r6
  treq('TA1', '2024-06-05T10:00:00+02:00', fin('2024-06-06T10:00:00+02:00'));                                  // r7: June 2024
  treq('TA1', '2026-07-01T10:00:00+02:00', fin('2026-07-02T10:00:00+02:00', 'HIVPC'));                         // r8: a result that is not HIVVL or HIVVC
  treq('TA1', '2026-05-12T10:00:00+02:00', fin('2026-05-13T10:00:00+02:00', 'HIVVL', { panel: 'HIVPC' }));     // r9: another panel
  treq('ta1 ', '2026-05-07T10:00:00+02:00', fin('2026-05-08T10:00:00+02:00'));                                 // r11: another spelling of the lab
  treq('TA1', null, fin('2026-05-09T10:00:00+02:00'));                                                         // r15: no registered stamp: Tested only
  treq('TA1', '2026-01-01T01:00:00+02:00');                                                                    // r17: January 2026 (UTC says December 2025)
  treq('TA1', '2025-12-31T23:30:00+02:00');                                                                    // r18
  treq('TA1', '2026-12-31T23:59:59+02:00');                                                                    // r19
  treq('TA1', '2026-05-25T10:00:00+02:00', { iss: '2026-05-26T10:00:00+02:00', results: [{ obs: 'HIVVL' }, { obs: 'HIVVC' }] });   // r21: two results, one test
  treq('TA2', '2026-05-05T10:00:00+02:00', fin('2026-05-06T10:00:00+02:00'));                                  // r10
  treq('TA2', '2026-06-10T10:00:00+02:00', fin('2026-06-01T00:30:00+02:00'));                                  // tested at 00:30 on June 1 (UTC says May)
  treq('TA1', '2026-08-03T10:00:00+02:00', { id: 'T27T-DUP' });                                                // one request number, two spellings: one request
  treq('TA1', '2026-08-04T10:00:00+02:00', { id: 't27t-dup ' });
  treq('TA1', '2026-09-03T10:00:00+02:00', { panel: 'hivvl ' });                                               // the panel compares ignoring case and spaces
  treq('  ', '2026-05-09T10:00:00+02:00', fin('2026-05-10T10:00:00+02:00'));                                   // no testing lab
  treq(null, '2026-05-09T10:00:00+02:00', fin('2026-05-10T10:00:00+02:00'));
  treq('TA1', '2026-05-09T10:00:00+02:00', { noReport: true });                                                // no report
  treq('TB1', '2025-03-03T10:00:00+02:00', fin('2025-03-04T10:00:00+02:00'));                                  // r20
  MONTH_NAMES.forEach((_, i) => treq('TM1', `2027-${String(i + 1).padStart(2, '0')}-15T12:00:00+02:00`));      // every month of 2027
  const thr = (lab, month, requests, tested) => ({ Laboratory: lab, Month: month, MonthDescription: MONTH_NAMES[month - 1], Requests: requests, Tested: tested });
  const thrRows = {
    // The Tested of a month is every year's tests of that month (M line 31), so May 2026 holds r1, r11, r15, r21 and May 2025's r5.
    2026: [thr('TA1', 1, 1, 0), thr('TA1', 5, 5, 5), thr('TA1', 6, 1, 2), thr('TA1', 7, 1, 0), thr('TA1', 8, 1, 0), thr('TA1', 9, 1, 0), thr('TA1', 12, 1, 0),
      thr('TA2', 5, 1, 1), thr('TA2', 6, 1, 1)],
    2025: [thr('TA1', 5, 2, 5), thr('TA1', 12, 1, 0), thr('TB1', 3, 1, 1)],
    2024: [thr('TA1', 6, 1, 2)],
    2027: MONTH_NAMES.map((_, i) => thr('TM1', i + 1, 1, 0)),
    2023: [],
  };

  // =========================================================================================================================
  // The warehouse rows
  // =========================================================================================================================
  const setup = `insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, obr_set_id, rejection_code) values
  ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, issued, performer, performer_display, source_system, performer_system) values
  ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values
  ${results.join(',\n  ')};
insert into facility_registry (id, facility_system, facility_code, name, register_state, extras) values
  ${regs.join(',\n  ')};
insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district, national_code) values
  ${maps.join(',\n  ')};`;

  // =========================================================================================================================
  // Suites
  // =========================================================================================================================
  // Remove the rows of the other two queries, so a suite sees only its own fixture (ids start with the prefix).
  const isolate = (keep) => ['lab_results', 'diagnostic_reports', 'lab_requests', 'facility_map', 'facility_registry']
    .map((t) => `delete from ${t} where id not like '${keep}%';`).join('\n');
  let sp = 0;
  // The exact rows in order. `only` keeps the rows of those values of one column.
  function listSuite(name, queryName, params, columns, wanted, keep, { only, onlyColumn } = {}) {
    const q = t27query(queryName);
    const sqlText = q?.sql ?? `select 'x'::text as "${onlyColumn ?? 'x'}"`;
    const text2 = only ? `select z.* from (${sqlText}) z where z."${onlyColumn}" in (${only.map(lit).join(', ')})` : sqlText;
    const s = orderedSuite(name, text2, params, columns, wanted);
    if (!q) {
      const check = s.check;
      s.check = (got) => [`query "${queryName}" is missing`, ...check(got)];
    }
    sp += 1;
    s.sql = `savepoint t27sp${sp};\n${isolate(keep)}\n${s.sql}\nrollback to savepoint t27sp${sp};`;
    return s;
  }
  // A suite that prints one JSON object of values and compares it.
  function valueSuite(name, queryName, keep, selectExpr, want) {
    const q = t27query(queryName);
    sp += 1;
    if (!q) return { name, count: 1, check: () => [`query "${queryName}" is missing`] };
    return {
      name,
      count: 1,
      sql: `savepoint t27sp${sp};\n${isolate(keep)}\nselect ${lit(name)} || chr(9) || (${selectExpr(q.sql)})::text;\nrollback to savepoint t27sp${sp};`,
      check: (got) => (JSON.stringify(got) === JSON.stringify([want]) ? [] : [`expected ${JSON.stringify([want])}, got ${JSON.stringify(got)}`]),
    };
  }
  const shape = (name, queryName, ids) => shapeSuite(name, t27query(queryName), ids, ids.map(() => 'text'));
  // CE pages a result with LIMIT and OFFSET, so the ORDER BY must be total: it names every output column.
  const orderSuite = (name, queryName, count, idOf = (i) => `res.c${String(i).padStart(2, '0')}`) => ({
    name,
    count,
    check() {
      const q = t27query(queryName);
      if (!q) return [`query "${queryName}" is missing`];
      const tail = q.sql.slice(q.sql.lastIndexOf('order by'));
      const bad = [];
      for (let i = 1; i <= count; i += 1) if (!tail.includes(idOf(i))) bad.push(`ORDER BY must list ${idOf(i)}`);
      return bad;
    },
  });

  const MAY = { from: '2026-05-01', to: '2026-05-31' };
  const WEEK = { from: '2026-05-04', to: '2026-05-10' };
  const wsOrder = byColumns([['TestType', 'text'], ['Lab', 'text'], ['LabName', 'text'], ...WS_COLUMNS.slice(3).map((c) => [c, 'number'])]);
  const sumOrder = byColumns([...SUM_LEAD.map((c) => [c, 'text']), ...SUM_TYPES.map((c) => [c, 'number'])]);
  const thrOrder = byColumns([['Laboratory', 'text'], ['Month', 'number'], ['MonthDescription', 'text'], ['Requests', 'number'], ['Tested', 'number']]);
  const typesOf = (columns, params) => (sqlText) => `select json_build_object(${columns.map((c) => `${lit(c)}, pg_typeof(q."${c}")::text`).join(', ')}) from (${bind(sqlText, params)}) q limit 1`;

  const suites27 = [
    { name: 't27-setup', setup, count: 0, check: () => [] },
    shape('t27-shape-ws', WS_Q, ['from', 'to']),
    shape('t27-shape-sum', SUM_Q, ['from', 'to']),
    shape('t27-shape-thr', THR_Q, ['year']),
    orderSuite('t27-order-ws', WS_Q, 15),
    orderSuite('t27-order-sum', SUM_Q, 22),
    orderSuite('t27-order-thr', THR_Q, 4, (i) => ['g."Laboratory"', 'g."Month"', 'g."Requests"', 'coalesce(t.n, 0)'][i - 1]),
    listSuite('t27-ws-all', WS_Q, MAY, WS_COLUMNS, [...wsRows].sort(wsOrder), W),
    // The end day is a whole day: May 12 alone holds the 00:00:00 and the 23:59:59 request and neither neighbour.
    listSuite('t27-ws-day', WS_Q, { from: '2026-05-12', to: '2026-05-12' }, WS_COLUMNS, [wsDayRow], W, { only: ['WD1'], onlyColumn: 'Lab' }),
    listSuite('t27-sum-all', SUM_Q, WEEK, SUM_COLUMNS, [...sumRows].sort(sumOrder), S),
    listSuite('t27-sum-day', SUM_Q, { from: '2026-05-10', to: '2026-05-10' }, SUM_COLUMNS, sumDayRows, S, { only: ['SL1'], onlyColumn: 'LabCode' }),
    ...[2026, 2025, 2024, 2027, 2023].map((year) => listSuite(`t27-thr-${year}`, THR_Q, { year: String(year) }, THR_COLUMNS, [...thrRows[year]].sort(thrOrder), T)),
    // Types: counts are bigint and the turnaround an integer (SQL Server int), the month an integer.
    valueSuite('t27-ws-type', WS_Q, W, typesOf(WS_COLUMNS.slice(3), MAY), Object.fromEntries(WS_COLUMNS.slice(3).map((c) => [c, c === 'LabTAT' ? 'integer' : 'bigint']))),
    valueSuite('t27-sum-type', SUM_Q, S, typesOf(SUM_TYPES, WEEK), Object.fromEntries(SUM_TYPES.map((c) => [c, 'bigint']))),
    valueSuite('t27-thr-type', THR_Q, T, typesOf(['Month', 'Requests', 'Tested'], { year: '2026' }), { Month: 'integer', Requests: 'bigint', Tested: 'bigint' }),
  ];
  return { name: 't27', suites: suites27 };
}

// ==========================================================================================================================
// Group t28: Rejections by facility and reason, VL rejections by facility (total), VL rejections by lab (v1 views
// vAllSampleRejectionsByFacility <= vEIDSampleRejectionsByFacility, vVLSampleRejectionsByFacility; vVLTotalRejectionsByFacility;
// vVLSpecimenRejections). Fixture ids start with "t28a-" (by reason), "t28t-" (total) and "t28l-" (by lab); request numbers with
// "T28A-", "T28T-" and "T28L-". The three queries read the same tables, so every suite first deletes the rows of the other two (isolate)
// and runs inside a savepoint.
// "A line N", "E line N", "V line N", "T line N" and "L line N" mean a line of View__dbo_vAllSampleRejectionsByFacility.sql,
// View__dbo_vEIDSampleRejectionsByFacility.sql, View__dbo_vVLSampleRejectionsByFacility.sql, View__dbo_vVLTotalRejectionsByFacility.sql and
// View__dbo_vVLSpecimenRejections.sql.

const REJ_Q = 'Rejections by facility and reason';
const TOT_Q = 'VL rejections by facility (total)';
const LAB_Q = 'VL rejections by lab';
const t28query = (name) => queries().find((q) => q.name === name);

// A lines 13-264: the 28 reason columns in order: [LIMSRejectionCode, column name]. Two names are cut at 30 characters in v1 and stay cut.
const T28_REASONS = [
  ['WRONG', 'Blood received in wrong tube'],
  ['CLOT', 'Specimen clotted'],
  ['LEAK', 'Leaked sample'],
  ['HAEM', 'Specimen haemolysed'],
  ['AOOO', 'ANALYSER OUT OF ORDER'],
  ['NOQC', 'Quality Control Failed'],
  ['TEST', 'No test requested'],
  ['SPUN', 'Specimen unlabelled'],
  ['007', 'Specimen more than 7 days old'],
  ['UNS', 'Unsuitable for testing'],
  ['INS', 'Insufficient blood received'],
  ['FORM', 'Request form incomplete.'],
  ['LOCOU', 'Low Count Error'],
  ['LAC', 'Limited analyser capacity.'],
  ['INVOL', 'Volume of Blood Exceeds Limit'],
  ['ACC', 'Laboratory Accident'],
  ['NAMES', 'Mismatched names on Form n Spe'],
  ['SNR', 'SPECIMEN NOT RECEIVED IN LAB'],
  ['EMPT', 'Empty Specimen containers rece'],
  ['NOESR', 'ESR Tubes are Out of Stock'],
  ['NRQF', 'No request form received'],
  ['WRGCO', 'Wrong Sputum Container Used'],
  ['SAMFN', 'Sample fibrin - Clot detected'],
  ['OLD', 'Specimen too old for testing'],
  ['INSF', 'Sample insufficient to culture'],
  ['SWC', 'Sample Withdrawn by Client'],
  ['DAY3', 'Specimen 3 days old on receipt'],
  ['OS', 'Not done. Reagent out of stock'],
];
// A lines 7-12: the nine columns before the reasons.
const REJ_LEAD = ['ProvinceName', 'DistrictName', 'FacilityName', 'RequestingFacilityCode', 'Year', 'Quarter', 'Month', 'Week', 'TotalSampleRejections'];
const REJ_COLUMNS = [...REJ_LEAD, ...T28_REASONS.map(([, name]) => name)];

function group28() {
  const maps = [];
  const requests = [];
  const reports = [];
  let n = 0;
  const foldKey = (x) => (x === null ? null : x.replace(/ +$/, '').toLowerCase());
  const nonEmpty = (code) => code !== null && code.replace(/ +$/, '') !== '';

  // A mapped register row. `regId` null: the code is not in the register (the map row has no register row).
  function fmap(prefix, id, code, regId, name, region, district) {
    maps.push(`(${lit(`${prefix}fm${id}`)}, '', '', ${lit(code)}, ${lit(regId ? `reg-${prefix}${id}` : null)}, ${lit(name)}, ${lit(region)}, ${lit(district)})`);
  }
  // One request row with its reports. `eff`: a list with one entry per report (its collection stamp, null for none); absent: no report.
  // `reps`: reports as { perf, display, eff } (the lab queries).
  function add(prefix, o) {
    n += 1;
    const qid = `${prefix}q${n}`;
    requests.push(`(${lit(qid)}, ${lit(o.rid)}, ${lit(o.panel)}, ${lit(o.auth)}, ${lit(o.req)}, ${lit(o.rej)})`);
    const reps = o.reps ?? (o.eff ?? []).map((eff) => ({ eff }));
    reps.forEach((r, i) => reports.push(`(${lit(`${prefix}d${n}-${i + 1}`)}, ${lit(qid)}, ${lit(r.eff ?? null)}, ${lit(r.perf ?? null)}, ${lit(r.display ?? null)})`));
    return qid;
  }

  // =========================================================================================================================
  // Rejections by facility and reason (prefix t28a-)
  // =========================================================================================================================
  const A = 't28a-';
  // Facility triples [province, district, facility] by EXACT requester code (the register mapping). ZUNMP has a map row with no register
  // row, ZNONE has no map row at all: v1's left join gives both NULL names (A line 268).
  const FAC = {
    ZSOUT: ['Southern', 'Choma', 'Choma General Hospital'],
    ZLUSA: ['Lusaka', 'Lusaka', 'Chilenje Clinic'],
    ZKAFU: ['Lusaka', 'Kafue', 'Kafue District Hospital'],
    ZEDGE: ['Southern', 'Choma', 'Edge Clinic'],
    ZWIN: ['Western', 'Mongu', 'Window Clinic'],
    ZDUP: ['Western', 'Kaoma', 'Dup Clinic'],
    // Two spellings of one code, mapped to different register rows: the names must come from ONE row (the smaller facility name).
    ZMIX: ['Southern', 'Choma', 'Mix Clinic B'],
    'zmix ': ['Lusaka', 'Kafue', 'Mix Clinic A'],
  };
  Object.entries(FAC).forEach(([code, [region, district, name]], i) => fmap(A, i + 1, code, true, name, region, district));
  fmap(A, 9, 'ZUNMP', false, null, null, null);

  // A bucket: the local date and its year, quarter, month (from the date) and v1 Datepart(wk) (worked out by hand: week 1 holds 1 January
  // and each Sunday starts the next week). `null`: no date.
  const B = (date, week) => ({ d: date.slice(0, 10), y: Number(date.slice(0, 4)), q: Math.ceil(Number(date.slice(5, 7)) / 3), m: Number(date.slice(5, 7)), w: week });
  const specs = [];
  // One rejected (or not) request. `all`: the bucket of the all and EID views (RegisteredDateTime); `vl`: the bucket of the VL view
  // (coalesce(SpecimenDateTime, RegisteredDateTime)), the same as `all` unless given.
  function req(o) {
    const s = { panel: 'HIVVL', req: 'ZSOUT', rej: 'CLOT', auth: null, ...o };
    s.rid = o.rid === undefined ? `T28A-${specs.length + 1}` : o.rid;
    if (!('vl' in o)) s.vl = s.all;
    add(A, s);
    specs.push(s);
    return s;
  }
  const MAY4 = '2026-05-04T08:00:00+02:00';
  const W19 = (extra = {}) => ({ auth: MAY4, all: B(MAY4, 19), ...extra });

  // -- S1: ZSOUT, 4 May 2026 (Monday; week 19 starts Sunday 3 May). Panels and code spellings (A 269, E 269, V 271 and the sub-selects) --
  req({ ...W19(), rej: 'WRONG' });                                  // a1  HIVVL
  req({ ...W19(), rej: 'WRONG' });                                  // a2
  req({ ...W19(), panel: 'VIRAL', rej: 'WRONG' });                  // a3  VIRAL: in the VL view
  req({ ...W19(), panel: 'HIVPC', rej: 'CLOT' });                   // a4  EID
  req({ ...W19(), panel: 'TBGNX', rej: 'LEAK' });                   // a5  other panel: only the all view
  req({ ...W19(), panel: null, rej: 'HAEM' });                      // a6  no panel: only the all view
  req({ ...W19(), panel: 'hivpc ', rej: 'CLOT' });                  // a7  panel ignores case and trailing spaces
  req({ ...W19(), panel: 'hivvl ', rej: 'wrong' });                 // a8  the same, and the code ignores case
  req({ ...W19(), rej: ' WRONG' });                                 // a9  a leading space is a different code: in the total only
  req({ ...W19(), rej: 'WRONG  ' });                                // a10 trailing spaces are ignored
  req({ ...W19(), rej: 'ZZZZ' });                                   // a11 a code with no column: in the total only
  req({ ...W19({ eff: ['2026-04-20T10:00:00+02:00'] }), panel: 'HIVPC', rej: 'OS' }); // a12 EID: bucket stays the registered date
  req({ ...W19(), req: 'zsout ', rej: 'WRONG' });                   // a13 the facility code ignores case and trailing spaces (one group)
  // Not rejected: A line 269 `NOT (code is null or code = '')`; spaces equal ''. None of these is in any count.
  req({ ...W19(), rej: '', all: null, vl: null });
  req({ ...W19(), rej: '   ', all: null, vl: null });
  req({ ...W19(), rej: null, all: null, vl: null });

  // -- S2: ZLUSA, code CLOT: the VL view's bucket date is coalesce(SpecimenDateTime, RegisteredDateTime) (V lines 10-13) --
  const s2 = (o) => req({ req: 'ZLUSA', rej: 'CLOT', ...o });
  s2({ ...W19({ eff: ['2026-04-28T10:00:00+02:00'] }), vl: B('2026-04-28', 18) });                                    // b1 collected before it was registered
  s2({ auth: '2026-01-02T08:00:00+02:00', eff: ['2025-12-31T23:30:00+02:00'], all: B('2026-01-02', 1), vl: B('2025-12-31', 53) }); // b2 across the year
  s2({ ...W19({ eff: [null] }) });                                                                                     // b3 report without a collection date
  s2({ ...W19() });                                                                                                    // b4 no report
  s2({ ...W19({ eff: ['2026-07'] }) });                                                                                // b5 partial stamp: not a date
  s2({ auth: null, eff: ['2026-02-02T09:00:00+02:00'], all: null, vl: B('2026-02-02', 6) });                           // b6 no registered date
  s2({ auth: '2026-03-20T09:00:00+02:00', eff: ['2026-03-15T10:00:00+02:00', '2026-03-08T10:00:00+02:00'], all: B('2026-03-20', 12), vl: B('2026-03-08', 11) }); // b7 two reports
  s2({ ...W19({ eff: ['2026-04-28T10:00:00+02:00'] }), panel: 'VIRAL', vl: B('2026-04-28', 18) });                     // b8 VIRAL
  s2({ ...W19({ eff: [''] }) });                                                                                       // b9 blank collection stamp
  s2({ ...W19({ eff: ['2026-04-28T10:00:00+02:00'] }), panel: 'HIVPC', rej: 'CLOT' });                                  // b10 EID: collection date is ignored
  s2({ auth: '2026-06-05T09:00:00+02:00', eff: ['2026-06-01T00:30:00+02:00'], all: B('2026-06-05', 23), vl: B('2026-06-01', 23) });  // b11 collected local 1 June (UTC 31 May)

  // -- S3: ZKAFU on 10 February 2026 (Tuesday, week 7): code i gets i+1 requests, so a swapped or missing column shows --
  const FEB10 = '2026-02-10T09:00:00+02:00';
  T28_REASONS.forEach(([code], i) => {
    for (let k = 0; k <= i; k += 1) req({ req: 'ZKAFU', rej: code, auth: FEB10, all: B(FEB10, 7), rid: `T28A-LOOP-${i}-${k}` });
  });
  req({ req: 'ZKAFU', rej: 'ZZZZ', auth: FEB10, all: B(FEB10, 7), rid: 'T28A-LOOP-X' });

  // -- S4: week, quarter and year edges on local dates (ZEDGE, code SWC). Each week is worked out by hand: a Sunday starts a week --
  const edge = (auth, all) => req({ req: 'ZEDGE', rej: 'SWC', auth, all });
  edge('2025-12-31T23:30:00+02:00', B('2025-12-31', 53));  // e1  Wednesday, the 53rd week of 2025
  edge('2026-01-01T00:30:00+02:00', B('2026-01-01', 1));   // e2  local 1 January (UTC is still 2025-12-31, week 53)
  edge('2026-01-03T23:30:00+02:00', B('2026-01-03', 1));   // e3  Saturday: still week 1
  edge('2026-01-04T00:30:00+02:00', B('2026-01-04', 2));   // e4  local Sunday (UTC is Saturday): week 2
  edge('2026-03-31T23:30:00+02:00', B('2026-03-31', 14));  // e5  last day of quarter 1
  edge('2026-04-01T00:30:00+02:00', B('2026-04-01', 14));  // e6  local 1 April (UTC is 31 March): quarter 2, month 4
  edge('2026-06-30T10:00:00Z', B('2026-06-30', 27));       // e7  last day of quarter 2
  edge('2026-07-01T00:00:00Z', B('2026-07-01', 27));       // e8  first day of quarter 3
  edge('2026-12-31T22:30:00Z', B('2026-12-31', 53));       // e9  2026 has 53 weeks
  edge('2027-01-01T01:00:00+02:00', B('2027-01-01', 1));   // e10 local 1 January 2027 (UTC is 2026-12-31)
  edge('2027-01-02', B('2027-01-02', 1));                  // e11 a date alone
  edge('2027-01-03', B('2027-01-03', 2));                  // e12 Sunday
  edge('2023-01-01', B('2023-01-01', 1));                  // e13 a year that starts on a Sunday
  edge('2023-01-07', B('2023-01-07', 1));                  // e14 its first Saturday
  edge('2023-01-08', B('2023-01-08', 2));                  // e15
  edge('2022-12-31', B('2022-12-31', 53));                 // e16 Saturday before it, week 53 of 2022
  edge('2024-12-31', B('2024-12-31', 53));                 // e17 leap year

  // -- S5: facility code spellings and missing values (A lines 7 and 268-270), and NULL RequestID (A line 12) --
  req({ ...W19(), req: 'ZUNMP' });                         // c1 map row without a register row: NULL names
  req({ ...W19(), req: 'ZNONE' });                         // c2 no map row
  req({ ...W19(), req: null });                            // c3 no facility code
  req({ ...W19(), req: null });                            // c4 v1: NULL = NULL is unknown, so no reason column counts these two
  req({ ...W19(), req: '' });                              // c5 an empty code is a code: `'' = ''` is true
  req({ ...W19(), req: '  ', rej: 'OS' });                 // c6 spaces equal '': the same group as c5
  const AUG10 = '2026-08-10T09:00:00+02:00';
  req({ req: 'ZSOUT', auth: AUG10, all: B(AUG10, 33), rid: null });  // d1 NULL RequestID: Count(RequestID) skips it, so does the sub-select
  req({ req: 'ZSOUT', auth: AUG10, all: B(AUG10, 33) });             // d2
  const SEP14 = '2026-09-14T09:00:00+02:00';
  req({ req: 'ZSOUT', auth: SEP14, all: B(SEP14, 38), rid: null });  // d3 a group of NULL RequestIDs only: Total 0

  // -- S6: the optional window, on the bucket date (ZWIN, code LEAK, week 24 holds 7 to 13 June) --
  const win = (o) => req({ req: 'ZWIN', rej: 'LEAK', ...o });
  win({ auth: '2026-06-10T00:30:00+02:00', all: B('2026-06-10', 24) });   // w1  local 10 June (UTC is 9 June)
  win({ auth: '2026-06-10T00:45:00+02:00', all: B('2026-06-10', 24) });   // w1b
  win({ auth: '2026-06-10T23:30:00+02:00', all: B('2026-06-10', 24) });   // w2
  win({ auth: '2026-06-09T23:30:00+02:00', all: B('2026-06-09', 24) });   // w3
  win({ auth: '2026-06-11T00:30:00+02:00', all: B('2026-06-11', 24) });   // w4  local 11 June (UTC is 10 June)
  win({ auth: '2026-06', all: null });                                    // w5  a partial stamp is no date
  win({ auth: null, all: null });                                         // w6
  win({ auth: '2026-06-20T09:00:00+02:00', eff: ['2026-06-10T12:00:00+02:00'], all: B('2026-06-20', 25), vl: B('2026-06-10', 24) }); // w7

  // -- S7: rows against distinct requests (A line 12 Count(RequestID), sub-select count(rq.requestid): rows). ZDUP, code CLOT --
  const MAY11 = '2026-05-11T09:00:00+02:00';   // Monday, week 20 (Sunday 10 May starts it)
  const JUN15 = '2026-06-15T09:00:00+02:00';   // Monday, week 25 (Sunday 14 June starts it)
  const dup = (o) => req({ req: 'ZDUP', ...o });
  dup({ auth: MAY11, all: B(MAY11, 20), rid: 'T28A-X' });                    // x1 one RequestID on two panels (two OBR sets): two rows
  dup({ auth: MAY11, all: B(MAY11, 20), rid: 'T28A-X', panel: 'HIVPC' });    // x2
  dup({ auth: JUN15, all: B(JUN15, 25), rid: 'T28A-X' });                    // x3 the same RequestID again in another spelling: still two rows
  dup({ auth: JUN15, all: B(JUN15, 25), rid: 't28a-x ' });                   // x4

  // -- S8: one folded code, two observed spellings, two register rows --
  req({ ...W19(), req: 'ZMIX' });                                            // m1
  req({ ...W19(), req: 'zmix ' });                                           // m2

  // ---- The model: what v1 returns for the fixture, grouped by facility code (ignoring case and trailing spaces) and bucket ----
  const panelOk = (mode, panel) => {
    const p = foldKey(panel);
    if (mode === 'eid') return p === 'hivpc';
    if (mode === 'vl') return p === 'hivvl' || p === 'viral';
    return mode === 'all';
  };
  function expectedRows(mode, { from = '', to = '' } = {}, facility = null) {
    const groups = new Map();
    for (const s of specs) {
      if (!nonEmpty(s.rej) || !panelOk(mode, s.panel)) continue;
      const b = mode === 'vl' ? s.vl : s.all;
      if ((from !== '' || to !== '') && (b === null || (from !== '' && b.d < from) || (to !== '' && b.d > to))) continue;
      const key = JSON.stringify([foldKey(s.req), b && [b.y, b.q, b.m, b.w]]);
      if (!groups.has(key)) groups.set(key, { members: [], b });
      groups.get(key).members.push(s);
    }
    const rows = [];
    for (const g of groups.values()) {
      // The chosen register row: the smallest facility name, then province, then district (byte order).
      const named = g.members.filter((s) => s.req !== null && FAC[s.req]).map((s) => FAC[s.req])
        .sort((p, q) => (p[2] < q[2] ? -1 : p[2] > q[2] ? 1 : p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : p[1] < q[1] ? -1 : p[1] > q[1] ? 1 : 0));
      const names = named.length > 0 ? named[0] : [null, null, null];
      const spellings = g.members.map((s) => s.req).filter((r) => r !== null).sort();
      const row = {
        ProvinceName: names[0], DistrictName: names[1], FacilityName: names[2], RequestingFacilityCode: spellings.length > 0 ? spellings[0] : null,
        Year: g.b ? g.b.y : null, Quarter: g.b ? g.b.q : null, Month: g.b ? g.b.m : null, Week: g.b ? g.b.w : null,
        TotalSampleRejections: g.members.filter((s) => s.rid !== null).length,
      };
      T28_REASONS.forEach(([code, name]) => {
        // A line 15-20: the sub-select needs the same facility code (NULL matches nothing), the same bucket (NULL matches nothing) and a RequestID.
        row[name] = g.members.filter((s) => s.rid !== null && s.req !== null && g.b !== null && foldKey(s.rej) === code.toLowerCase()).length;
      });
      rows.push(row);
    }
    const order = byColumns([['ProvinceName', 'text'], ['DistrictName', 'text'], ['FacilityName', 'text'], ['RequestingFacilityCode', 'text'], ['Year', 'number'], ['Quarter', 'number'], ['Month', 'number'], ['Week', 'number']]);
    return rows.filter((r) => facility === null || r.FacilityName === facility).sort(order);
  }

  // =========================================================================================================================
  // VL rejections by facility (total) (prefix t28t-)
  // =========================================================================================================================
  const T = 't28t-';
  fmap(T, 1, 'ZSOUT', true, 'Choma General Hospital', 'Southern', 'Choma');
  fmap(T, 2, 'ZKAFU', true, 'Kafue District Hospital', 'Lusaka', 'Kafue');
  fmap(T, 3, 'ZKAF2', true, 'kafue district hospital ', 'Lusaka', 'Kafue');   // the same name in another spelling: one group (T line 13)
  fmap(T, 4, 'ZLUSA', true, 'Chilenje Clinic', 'Lusaka', 'Lusaka');
  fmap(T, 5, 'ZUNMP', false, null, null, null);
  const MAY = '2026-05-04T08:00:00+02:00';
  const tot = (o) => add(T, { panel: 'HIVVL', auth: MAY, rej: 'CLOT', ...o });
  tot({ req: 'ZSOUT', rid: 'T28T-1' });
  tot({ req: 'ZSOUT', rid: 'T28T-2', rej: 'wrong' });
  tot({ req: 'ZSOUT', rid: 'T28T-2', rej: 'CLOT' });          // t3 the same request in another OBR set: counted once (T line 9, count distinct)
  tot({ req: 'ZSOUT', rid: 't28t-2 ' });                       // and in another spelling
  tot({ req: 'ZSOUT', rid: 'T28T-4', panel: 'VIRAL' });        // T line 11: panel HIVVL only, not VIRAL
  tot({ req: 'ZSOUT', rid: 'T28T-5', panel: 'HIVPC' });
  tot({ req: 'ZSOUT', rid: 'T28T-6', rej: '' });               // not rejected
  tot({ req: 'ZSOUT', rid: 'T28T-6B', rej: '   ' });
  tot({ req: 'ZSOUT', rid: 'T28T-6C', rej: null });
  tot({ req: 'ZSOUT', rid: 'T28T-7', panel: 'hivvl ', rej: 'LEAK' });  // panel ignores case and trailing spaces
  tot({ req: 'ZSOUT', rid: null });                                      // NULL RequestID: count(distinct) skips it
  tot({ req: 'ZSOUT', rid: 'T28T-8', panel: null });
  tot({ req: 'ZKAFU', rid: 'T28T-K1' });
  tot({ req: 'ZKAFU', rid: 'T28T-K2' });
  tot({ req: 'ZKAF2', rid: 'T28T-K3' });
  tot({ req: 'ZKAF2', rid: 'T28T-K1' });                       // counted once across the two codes of one name
  tot({ req: 'ZUNMP', rid: 'T28T-U1' });                       // T line 8: right join, no name: one NULL group for all of these
  tot({ req: 'ZNONE', rid: 'T28T-U2' });
  tot({ req: null, rid: 'T28T-U3' });
  tot({ req: 'ZUNMP', rid: 'T28T-U1' });
  // The window is on the same date as the VL view's bucket: collection date, else registered date.
  const chil = (o) => tot({ req: 'ZLUSA', ...o });
  chil({ rid: 'T28T-L1', auth: '2026-06-10T00:30:00+02:00' });                                  // local 10 June (UTC 9 June)
  chil({ rid: 'T28T-L1B', auth: '2026-06-10T00:45:00+02:00' });
  chil({ rid: 'T28T-L2', auth: '2026-06-11T00:30:00+02:00' });                                  // local 11 June (UTC 10 June)
  chil({ rid: 'T28T-L3', auth: '2026-06-20T09:00:00+02:00', eff: ['2026-06-10T12:00:00+02:00'] }); // collected in the window, registered later
  chil({ rid: 'T28T-L3B', auth: '2026-06-21T09:00:00+02:00', eff: ['2026-06-10T09:00:00+02:00'] });
  chil({ rid: 'T28T-L4', auth: '2026-06-10T09:00:00+02:00', eff: ['2026-06-20T09:00:00+02:00'] }); // registered in the window, collected later
  chil({ rid: 'T28T-L5', auth: null });
  chil({ rid: 'T28T-L6', auth: '2026-06' });
  chil({ rid: 'T28T-L7', auth: '2026-06-10T09:00:00+02:00', eff: ['2026-06-10', '2026-06-25'] }); // two reports: the earliest date; counted once
  chil({ rid: 'T28T-L8', auth: '2026-07-01T09:00:00+02:00', eff: ['2026-06-11T00:30:00+02:00'] }); // collected local 11 June (UTC 10 June)

  // =========================================================================================================================
  // VL rejections by lab (prefix t28l-)
  // =========================================================================================================================
  const L = 't28l-';
  fmap(L, 1, 'ZMP', true, 'Mapped Lab Name', 'Lusaka', 'Lusaka');                // a lab with no display name takes the register name
  const lab = (o) => add(L, { panel: 'HIVVL', auth: MAY, rej: 'CLOT', ...o });
  const rep = (perf, display, eff) => [{ perf, display, eff }];
  lab({ rid: 'T28L-1', reps: rep('ZAB', 'Lab Alpha') });
  lab({ rid: 'T28L-2', reps: rep('zab ', null), rej: 'WRONG' });               // the same lab in another spelling, no name of its own
  lab({ rid: 'T28L-1', reps: rep('ZAB', 'Lab Alpha') });                       // L line 9: count(distinct RequestID)
  lab({ rid: 't28l-1 ', reps: rep('ZAB', 'Lab Alpha') });
  lab({ rid: null, reps: rep('ZAB', 'Lab Alpha') });
  lab({ rid: 'T28L-3', reps: rep('ZGH', 'Lab Shared') });
  lab({ rid: 'T28L-4', reps: rep('ZEF', 'lab shared ') });                       // two codes with one name: one group (L line 28, group by LabName)
  lab({ rid: 'T28L-5', reps: rep('ZMP', null) });
  lab({ rid: 'T28L-6', reps: rep('ZXX', null) });                              // not named anywhere: the name is the code
  lab({ rid: 'T28L-7', reps: [] });                                            // no report: no lab
  lab({ rid: 'T28L-8', reps: rep('', null) });                                 // blank testing code: v1 would use the receiving code, CE has none
  lab({ rid: 'T28L-9', reps: rep(null, null) });
  lab({ rid: 'T28L-10', reps: rep('ZAB', 'Lab Alpha'), panel: 'VIRAL' });      // L line 26: panel HIVVL only
  lab({ rid: 'T28L-11', reps: rep('ZAB', 'Lab Alpha'), panel: 'HIVPC' });
  lab({ rid: 'T28L-12', reps: rep('ZGH', 'Lab Shared'), rej: '' });
  lab({ rid: 'T28L-13', reps: rep('ZGH', 'Lab Shared'), rej: '  ' });
  lab({ rid: 'T28L-14', reps: rep('ZGH', 'Lab Shared'), rej: null });
  lab({ rid: 'T28L-15', reps: rep('ZGH', 'Lab Shared'), panel: 'hivvl ' });    // panel ignores case and trailing spaces
  const wl = (o) => lab({ reps: rep('ZWL', 'Lab Window'), ...o });
  wl({ rid: 'T28L-W1', auth: '2026-06-10T00:30:00+02:00' });                    // local 10 June (UTC 9 June)
  wl({ rid: 'T28L-W1B', auth: '2026-06-10T00:45:00+02:00' });
  wl({ rid: 'T28L-W2', auth: '2026-06-11T00:30:00+02:00' });                    // local 11 June (UTC 10 June)
  wl({ rid: 'T28L-W3', auth: '2026-06-09T23:30:00+02:00' });
  wl({ rid: 'T28L-W4', auth: null });
  wl({ rid: 'T28L-W5', auth: '2026-06' });
  wl({ rid: 'T28L-W6', auth: '2026-06-20T09:00:00+02:00', reps: rep('ZWL', 'Lab Window', '2026-06-10T12:00:00+02:00') }); // the collection date is not the window's
  wl({ rid: 'T28L-W6B', auth: '2026-06-21T09:00:00+02:00', reps: rep('ZWL', 'Lab Window', '2026-06-10T12:00:00+02:00') });
  wl({ rid: 'T28L-W7', auth: '2026-06-10T12:00:00+02:00', reps: rep('ZWL', 'Lab Window', '2026-06-20T12:00:00+02:00') });

  const setup = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ${maps.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, requester_code, rejection_code) values
  ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, effective, performer, performer_display) values
  ${reports.join(',\n  ')};`;

  // ---- Suites ----
  // Remove the rows of the other two queries, so a suite sees only its own fixture (ids start with the prefix).
  const isolate = (keep) => ['diagnostic_reports', 'lab_requests', 'facility_map'].map((t) => `delete from ${t} where id not like '${keep}%';`).join('\n');
  let sp = 0;
  // The exact rows in order. `only` is a WHERE condition on the query's own columns.
  function listSuite(name, queryName, params, columns, wanted, keep, { where, subset } = {}) {
    const q = t28query(queryName);
    const sqlText = q?.sql ?? `select null::text as "x"`;
    const text = q && (where || subset) ? `select ${subset ? columns.map((c) => `z."${c}"`).join(', ') : 'z.*'} from (${sqlText}) z${where ? ` where ${where}` : ''}` : sqlText;
    const s = orderedSuite(name, text, params, columns, wanted);
    if (!q) {
      const check = s.check;
      s.check = (got) => [`query "${queryName}" is missing`, ...check(got)];
    }
    sp += 1;
    s.sql = `savepoint t28sp${sp};\n${isolate(keep)}\n${s.sql}\nrollback to savepoint t28sp${sp};`;
    return s;
  }
  // One JSON object of values, compared whole.
  function valueSuite(name, queryName, keep, selectExpr, want) {
    const q = t28query(queryName);
    sp += 1;
    if (!q) return { name, count: 1, check: () => [`query "${queryName}" is missing`] };
    return {
      name,
      count: 1,
      sql: `savepoint t28sp${sp};\n${isolate(keep)}\nselect ${lit(name)} || chr(9) || (${selectExpr(q.sql)})::text;\nrollback to savepoint t28sp${sp};`,
      check: (got) => (JSON.stringify(got) === JSON.stringify([want]) ? [] : [`expected ${JSON.stringify([want])}, got ${JSON.stringify(got)}`]),
    };
  }
  // The declared parameters: ids in order, types, all optional (v1 has no window), the SQL a plain read-only SELECT.
  const BANNED28 = /--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i;
  const shape28 = (name, queryName, wantIds, wantTypes) => ({
    name,
    count: 4 + wantIds.length,
    check() {
      const q = t28query(queryName);
      if (!q) return [`query "${queryName}" is missing`];
      const bad = [];
      const ids = q.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(wantIds)) bad.push(`params: expected ${wantIds}, got ${ids}`);
      q.params.forEach((p, i) => {
        if (p.required) bad.push(`${p.id} is optional (v1 has no window)`);
        if (p.type !== wantTypes[i]) bad.push(`${p.id}: expected type ${wantTypes[i]}, got ${p.type}`);
      });
      if (BANNED28.test(q.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (!/^\s*with\b/i.test(q.sql)) bad.push('does not start with "with"');
      return bad;
    },
  });
  // CE pages a result with LIMIT and OFFSET, so the ORDER BY must be total (the sort key names the group key).
  const orderHas = (name, queryName, needles) => ({
    name,
    count: needles.length,
    check() {
      const q = t28query(queryName);
      if (!q) return [`query "${queryName}" is missing`];
      const tail = q.sql.slice(q.sql.lastIndexOf('order by'));
      return needles.filter((x) => !tail.includes(x)).map((x) => `ORDER BY must list ${x}`);
    },
  });
  const typesOf = (columns, params) => (sqlText) => `select json_build_object(${columns.map((c) => `${lit(c)}, pg_typeof(q."${c}")::text`).join(', ')}) from (${bind(sqlText, params)}) q limit 1`;

  const NONE = { test_type: '', from: '', to: '' };
  const rej = (name, params, mode, window, facility = null) => listSuite(name, REJ_Q, { ...NONE, ...params }, REJ_COLUMNS, expectedRows(mode, window, facility), A,
    facility === null ? {} : { where: `z."FacilityName" = ${lit(facility)}` });

  // S1 by hand (A line 13 onwards): the 4 May group of ZSOUT, whose row is the only May row of Choma General Hospital.
  const s1Row = (counts) => ({
    ProvinceName: 'Southern', DistrictName: 'Choma', FacilityName: 'Choma General Hospital', RequestingFacilityCode: 'ZSOUT',
    Year: 2026, Quarter: 2, Month: 5, Week: 19,
    ...Object.fromEntries(T28_REASONS.map(([, name]) => [name, 0])), ...counts,
  });
  const s1Where = `z."FacilityName" = 'Choma General Hospital' and z."Month" = 5`;
  const NAME = Object.fromEntries(T28_REASONS.map(([code, name]) => [code, name]));
  // All panels: a1 a2 a3 a8 a10 a13 are WRONG (6), a4 a7 CLOT (2), a5 LEAK, a6 HAEM, a12 OS; a9 and a11 are in the total only: 13 rows.
  const s1All = s1Row({ TotalSampleRejections: 13, [NAME.WRONG]: 6, [NAME.CLOT]: 2, [NAME.LEAK]: 1, [NAME.HAEM]: 1, [NAME.OS]: 1 });
  // EID (E): a4 a7 (CLOT) and a12 (OS).
  const s1Eid = s1Row({ TotalSampleRejections: 3, [NAME.CLOT]: 2, [NAME.OS]: 1 });
  // VL (V): HIVVL and VIRAL: a1 a2 a3 a8 a10 a13 are WRONG (6), a9 and a11 add to the total: 8 rows.
  const s1Vl = s1Row({ TotalSampleRejections: 8, [NAME.WRONG]: 6 });

  const TOTAL_COLUMNS = ['FacilityName', 'Rejections'];
  const LAB_COLUMNS = ['Laboratory', 'Rejections'];
  const day10 = { from: '2026-06-10', to: '2026-06-10' };
  const suites28 = [
    { name: 't28-setup', setup, count: 0, check: () => [] },
    shape28('t28-shape-rej', REJ_Q, ['test_type', 'from', 'to'], ['select', 'text', 'text']),
    shape28('t28-shape-tot', TOT_Q, ['from', 'to'], ['text', 'text']),
    shape28('t28-shape-lab', LAB_Q, ['from', 'to'], ['text', 'text']),
    {
      name: 't28-test-type-options',
      count: 1,
      check() {
        const p = t28query(REJ_Q)?.params.find((x) => x.id === 'test_type');
        if (!p) return ['test_type is missing'];
        return ['all', 'EID', 'VL'].filter((x) => !(p.optionsSql ?? '').includes(`'${x}'`)).map((x) => `test_type options lack ${x}`).concat(p.optionsSql ? [] : ['no optionsSql']);
      },
    },
    orderHas('t28-order-rej', REJ_Q, ['g.code_key', 'g.y', 'g.q', 'g.m', 'g.w']),
    orderHas('t28-order-tot', TOT_Q, ['g.rejections']),
    orderHas('t28-order-lab', LAB_Q, ['g.rejections']),

    // The whole result for each test type: blank and 'all' are the all view, EID the EID view, VL the VL view.
    rej('t28-rej-blank', {}, 'all', {}),
    rej('t28-rej-all', { test_type: 'all' }, 'all', {}),
    rej('t28-rej-all-spelled', { test_type: 'All  ' }, 'all', {}),
    rej('t28-rej-eid', { test_type: 'EID' }, 'eid', {}),
    rej('t28-rej-eid-spelled', { test_type: 'eid ' }, 'eid', {}),
    rej('t28-rej-vl', { test_type: 'VL' }, 'vl', {}),
    rej('t28-rej-vl-spelled', { test_type: 'vl' }, 'vl', {}),
    rej('t28-rej-unknown', { test_type: 'TB' }, 'none', {}),
    // S1 and S2 by hand, whatever the model says.
    listSuite('t28-rej-s1-all', REJ_Q, NONE, REJ_COLUMNS, [s1All], A, { where: s1Where }),
    listSuite('t28-rej-s1-eid', REJ_Q, { ...NONE, test_type: 'EID' }, REJ_COLUMNS, [s1Eid], A, { where: s1Where }),
    listSuite('t28-rej-s1-vl', REJ_Q, { ...NONE, test_type: 'VL' }, REJ_COLUMNS, [s1Vl], A, { where: s1Where }),
    // The VL bucket switch (V lines 10-13, 15-18): Chilenje Clinic (all rows are code CLOT).
    listSuite('t28-rej-s2-all', REJ_Q, NONE, REJ_COLUMNS, [
      // all view: Datepart on RegisteredDateTime. b1 b3 b4 b5 b8 b9 b10 on 4 May (b8 is VIRAL, b10 HIVPC); b2 on 2 Jan; b6 has none; b7 on 20 March.
      { ProvinceName: 'Lusaka', DistrictName: 'Lusaka', FacilityName: 'Chilenje Clinic', RequestingFacilityCode: 'ZLUSA', Year: null, Quarter: null, Month: null, Week: null, TotalSampleRejections: 1 },
      { ProvinceName: 'Lusaka', DistrictName: 'Lusaka', FacilityName: 'Chilenje Clinic', RequestingFacilityCode: 'ZLUSA', Year: 2026, Quarter: 1, Month: 1, Week: 1, TotalSampleRejections: 1, [NAME.CLOT]: 1 },
      { ProvinceName: 'Lusaka', DistrictName: 'Lusaka', FacilityName: 'Chilenje Clinic', RequestingFacilityCode: 'ZLUSA', Year: 2026, Quarter: 1, Month: 3, Week: 12, TotalSampleRejections: 1, [NAME.CLOT]: 1 },
      { ProvinceName: 'Lusaka', DistrictName: 'Lusaka', FacilityName: 'Chilenje Clinic', RequestingFacilityCode: 'ZLUSA', Year: 2026, Quarter: 2, Month: 5, Week: 19, TotalSampleRejections: 7, [NAME.CLOT]: 7 },
      // b11 is registered on 5 June (Friday, week 23).
      { ProvinceName: 'Lusaka', DistrictName: 'Lusaka', FacilityName: 'Chilenje Clinic', RequestingFacilityCode: 'ZLUSA', Year: 2026, Quarter: 2, Month: 6, Week: 23, TotalSampleRejections: 1, [NAME.CLOT]: 1 },
    ].map((r) => ({ ...Object.fromEntries(T28_REASONS.map(([, name]) => [name, 0])), ...r })), A, { where: `z."FacilityName" = 'Chilenje Clinic'` }),
    listSuite('t28-rej-s2-vl', REJ_Q, { ...NONE, test_type: 'VL' }, REJ_COLUMNS, [
      // VL view: coalesce(SpecimenDateTime, RegisteredDateTime). b2 on 31 Dec 2025 (week 53), b6 on 2 Feb, b7 on its earliest report (8 March),
      // b1 and b8 on 28 April (week 18); b3 b4 b5 b9 on 4 May. b10 is HIVPC: not a VL row.
      { Year: 2025, Quarter: 4, Month: 12, Week: 53, TotalSampleRejections: 1, [NAME.CLOT]: 1 },
      { Year: 2026, Quarter: 1, Month: 2, Week: 6, TotalSampleRejections: 1, [NAME.CLOT]: 1 },
      { Year: 2026, Quarter: 1, Month: 3, Week: 11, TotalSampleRejections: 1, [NAME.CLOT]: 1 },
      { Year: 2026, Quarter: 2, Month: 4, Week: 18, TotalSampleRejections: 2, [NAME.CLOT]: 2 },
      { Year: 2026, Quarter: 2, Month: 5, Week: 19, TotalSampleRejections: 4, [NAME.CLOT]: 4 },
      // b11: collected on local 1 June 00:30 (Monday, week 23; UTC says 31 May).
      { Year: 2026, Quarter: 2, Month: 6, Week: 23, TotalSampleRejections: 1, [NAME.CLOT]: 1 },
    ].map((r) => ({ ProvinceName: 'Lusaka', DistrictName: 'Lusaka', FacilityName: 'Chilenje Clinic', RequestingFacilityCode: 'ZLUSA', ...Object.fromEntries(T28_REASONS.map(([, name]) => [name, 0])), ...r })),
    A, { where: `z."FacilityName" = 'Chilenje Clinic'` }),
    // The reason columns: code i has i+1 requests (S3), whatever the model says.
    listSuite('t28-rej-s3-reasons', REJ_Q, NONE, REJ_COLUMNS, [{
      ProvinceName: 'Lusaka', DistrictName: 'Kafue', FacilityName: 'Kafue District Hospital', RequestingFacilityCode: 'ZKAFU',
      Year: 2026, Quarter: 1, Month: 2, Week: 7, TotalSampleRejections: 407,
      ...Object.fromEntries(T28_REASONS.map(([, name], i) => [name, i + 1])),
    }], A, { where: `z."FacilityName" = 'Kafue District Hospital'` }),
    // Rows, not distinct requests (S7), by hand. Bucket 11 May (week 20): one RequestID on a HIVVL and a HIVPC row. Bucket 15 June (week 25): the same
    // RequestID in two spellings on two HIVVL rows. v1 counts rows (Count(RequestID), count(rq.requestid)): all views 2 and 2; EID and VL see one row of
    // the first bucket each.
    ...[['', [2, 2]], ['EID', [1, 0]], ['VL', [1, 2]]].map(([type, [may, jun]]) => listSuite(`t28-rej-s7-rows-${type || 'all'}`, REJ_Q, { ...NONE, test_type: type }, REJ_COLUMNS,
      [[may, 20, 5], [jun, 25, 6]].filter(([n]) => n > 0).map(([n, week, month]) => ({
        ProvinceName: 'Western', DistrictName: 'Kaoma', FacilityName: 'Dup Clinic', RequestingFacilityCode: 'ZDUP', Year: 2026, Quarter: 2, Month: month, Week: week,
        TotalSampleRejections: n, ...Object.fromEntries(T28_REASONS.map(([, name]) => [name, 0])), [NAME.CLOT]: n,
      })), A, { where: `z."FacilityName" = 'Dup Clinic'` })),
    // One folded code, two spellings on two register rows (S8): all three names from the row with the smaller facility name ('Mix Clinic A').
    listSuite('t28-rej-s8-one-row', REJ_Q, NONE, REJ_COLUMNS, [{
      ProvinceName: 'Lusaka', DistrictName: 'Kafue', FacilityName: 'Mix Clinic A', RequestingFacilityCode: 'ZMIX', Year: 2026, Quarter: 2, Month: 5, Week: 19,
      TotalSampleRejections: 2, ...Object.fromEntries(T28_REASONS.map(([, name]) => [name, 0])), [NAME.CLOT]: 2,
    }], A, { where: `z."FacilityName" like 'Mix Clinic%'` }),
    // The edges (S4): a hand list of the group keys and counts, whatever the model says.
    listSuite('t28-rej-s4-edges', REJ_Q, NONE, ['FacilityName', 'RequestingFacilityCode', 'Year', 'Quarter', 'Month', 'Week', 'TotalSampleRejections', NAME.SWC], [
      [2022, 4, 12, 53, 1], [2023, 1, 1, 1, 2], [2023, 1, 1, 2, 1], [2024, 4, 12, 53, 1], [2025, 4, 12, 53, 1], [2026, 1, 1, 1, 2], [2026, 1, 1, 2, 1],
      [2026, 1, 3, 14, 1], [2026, 2, 4, 14, 1], [2026, 2, 6, 27, 1], [2026, 3, 7, 27, 1], [2026, 4, 12, 53, 1], [2027, 1, 1, 1, 2], [2027, 1, 1, 2, 1],
    ].map(([Year, Quarter, Month, Week, total]) => ({
      FacilityName: 'Edge Clinic', RequestingFacilityCode: 'ZEDGE', Year, Quarter, Month, Week, TotalSampleRejections: total, [NAME.SWC]: total,
    })), A, { where: `z."FacilityName" = 'Edge Clinic'`, subset: true }),
    // Unmapped, missing and spelled facility codes (S5): by the model, and the quirk rows by hand.
    listSuite('t28-rej-s5-nameless', REJ_Q, NONE, ['ProvinceName', 'DistrictName', 'FacilityName', 'RequestingFacilityCode', 'Year', 'Month', 'TotalSampleRejections', NAME.CLOT, NAME.OS], [
      // c3 c4: NULL facility code. Both count in the total, neither in a reason column (NULL = NULL is unknown).
      [null, 2, 0, 0],
      // c5 c6: '' and spaces are one group; c5 is CLOT, c6 is OS. min('' , '  ') is ''.
      ['', 2, 1, 1],
      [`ZNONE`, 1, 1, 0],
      [`ZUNMP`, 1, 1, 0],
    ].map(([code, total, clot, os]) => ({
      ProvinceName: null, DistrictName: null, FacilityName: null, RequestingFacilityCode: code, Year: 2026, Month: 5, TotalSampleRejections: total, [NAME.CLOT]: clot, [NAME.OS]: os,
    })), A, { where: `z."FacilityName" is null and z."Month" = 5`, subset: true }),
    // NULL RequestID (S5 d1-d3): d1 and d2 are one group with Total 1 and CLOT 1; d3 alone is Total 0 and CLOT 0.
    listSuite('t28-rej-s5-null-id', REJ_Q, NONE, ['FacilityName', 'Year', 'Month', 'Week', 'TotalSampleRejections', NAME.CLOT], [
      { FacilityName: 'Choma General Hospital', Year: 2026, Month: 8, Week: 33, TotalSampleRejections: 1, [NAME.CLOT]: 1 },
      { FacilityName: 'Choma General Hospital', Year: 2026, Month: 9, Week: 38, TotalSampleRejections: 0, [NAME.CLOT]: 0 },
    ], A, { where: `z."FacilityName" = 'Choma General Hospital' and z."Month" >= 8`, subset: true }),
    // The optional window (S6, Window Clinic): inclusive local dates; a side left blank is open; no window is every row.
    rej('t28-rej-win-none', {}, 'all', {}, 'Window Clinic'),
    rej('t28-rej-win-day', { from: '2026-06-10', to: '2026-06-10' }, 'all', day10, 'Window Clinic'),
    rej('t28-rej-win-from', { from: '2026-06-11' }, 'all', { from: '2026-06-11' }, 'Window Clinic'),
    rej('t28-rej-win-to', { to: '2026-06-09' }, 'all', { to: '2026-06-09' }, 'Window Clinic'),
    rej('t28-rej-win-vl', { test_type: 'VL', from: '2026-06-10', to: '2026-06-10' }, 'vl', day10, 'Window Clinic'),
    rej('t28-rej-win-eid', { test_type: 'EID', from: '2026-06-10', to: '2026-06-10' }, 'eid', day10, 'Window Clinic'),
    // The whole result for a month (all facilities, the quarter and week edges inside it).
    rej('t28-rej-win-may', { from: '2026-05-01', to: '2026-05-31' }, 'all', { from: '2026-05-01', to: '2026-05-31' }),
    valueSuite('t28-rej-types', REJ_Q, A, typesOf(['Year', 'Quarter', 'Month', 'Week', 'TotalSampleRejections', NAME.CLOT, NAME.OS], NONE), {
      Year: 'integer', Quarter: 'integer', Month: 'integer', Week: 'integer', TotalSampleRejections: 'bigint', [NAME.CLOT]: 'bigint', [NAME.OS]: 'bigint',
    }),

    // ---- VL rejections by facility (total) ----
    // T line 8-13: HIVVL only, distinct RequestIDs, one row per facility name (case and trailing spaces ignored), a NULL name for the rest.
    // Choma: T28T-1, T28T-2 (three spellings and OBR sets), T28T-7 = 3. Kafue: K1 K2 K3 = 3 (K1 under two codes). No name: U1 U2 U3 = 3.
    // Chilenje: L1 L1B L2 L3 L3B L4 L5 L6 L7 L8 = 10.
    listSuite('t28-tot-all', TOT_Q, { from: '', to: '' }, TOTAL_COLUMNS, [
      { FacilityName: null, Rejections: 3 },
      { FacilityName: 'Chilenje Clinic', Rejections: 10 },
      { FacilityName: 'Choma General Hospital', Rejections: 3 },
      { FacilityName: 'Kafue District Hospital', Rejections: 3 },
    ], T),
    // The window is on collection date, else registered date, local. 10 June: L1 L1B (registered), L3 L3B L7 (collected); L4 is collected on the 20th.
    listSuite('t28-tot-day', TOT_Q, day10, TOTAL_COLUMNS, [{ FacilityName: 'Chilenje Clinic', Rejections: 5 }], T),
    // From 11 June: L2 (local 11 June), L4 (collected 20 June), L8 (collected local 11 June).
    listSuite('t28-tot-from', TOT_Q, { from: '2026-06-11', to: '' }, TOTAL_COLUMNS, [{ FacilityName: 'Chilenje Clinic', Rejections: 3 }], T),
    // To 9 June: the May rows only (the 4 May requests of the other facilities).
    listSuite('t28-tot-to', TOT_Q, { from: '', to: '2026-06-09' }, TOTAL_COLUMNS, [
      { FacilityName: null, Rejections: 3 },
      { FacilityName: 'Choma General Hospital', Rejections: 3 },
      { FacilityName: 'Kafue District Hospital', Rejections: 3 },
    ], T),
    valueSuite('t28-tot-types', TOT_Q, T, typesOf(['Rejections'], { from: '', to: '' }), { Rejections: 'bigint' }),

    // ---- VL rejections by lab ----
    // L line 9-30: HIVVL only, distinct RequestIDs, one row per lab name. Lab Alpha: 1 and 2 (ZAB, zab ). Lab Shared: 3 and 4 and 15 (two codes, one
    // name). Lab Window: W1 W1B W2 W3 W4 W5 W6 W6B W7 = 9. Mapped Lab Name: 5. ZXX: 6. No lab: 7 (no report), 8 (blank code), 9 (no code).
    listSuite('t28-lab-all', LAB_Q, { from: '', to: '' }, LAB_COLUMNS, [
      { Laboratory: null, Rejections: 3 },
      { Laboratory: 'Lab Alpha', Rejections: 2 },
      { Laboratory: 'Lab Shared', Rejections: 3 },
      { Laboratory: 'Lab Window', Rejections: 9 },
      { Laboratory: 'Mapped Lab Name', Rejections: 1 },
      { Laboratory: 'ZXX', Rejections: 1 },
    ], L),
    // The window is on the registered date, local: W1 W1B (10 June) and W7 (registered 10 June, collected 20 June).
    listSuite('t28-lab-day', LAB_Q, day10, LAB_COLUMNS, [{ Laboratory: 'Lab Window', Rejections: 3 }], L),
    // From 11 June: W2 (local 11 June), W6 and W6B (registered 20 and 21 June).
    listSuite('t28-lab-from', LAB_Q, { from: '2026-06-11', to: '' }, LAB_COLUMNS, [{ Laboratory: 'Lab Window', Rejections: 3 }], L),
    // To 9 June: the 4 May rows of the other labs, and W3.
    listSuite('t28-lab-to', LAB_Q, { from: '', to: '2026-06-09' }, LAB_COLUMNS, [
      { Laboratory: null, Rejections: 3 },
      { Laboratory: 'Lab Alpha', Rejections: 2 },
      { Laboratory: 'Lab Shared', Rejections: 3 },
      { Laboratory: 'Lab Window', Rejections: 1 },
      { Laboratory: 'Mapped Lab Name', Rejections: 1 },
      { Laboratory: 'ZXX', Rejections: 1 },
    ], L),
    valueSuite('t28-lab-types', LAB_Q, L, typesOf(['Rejections'], { from: '', to: '' }), { Rejections: 'bigint' }),
  ];
  return { name: 't28', suites: suites28 };
}

// ==========================================================================================================================
// Group t29a: Date completeness (v1 views vDatesCompletionRatesByFacility <= ByFacilityEID, ByFacilityVL; ByProvince; ByDistrict; ByLab;
// ByLabEID <= ByLabVL; ByLabArea). Fixture ids start with "t29a-f" (facility world), "t29a-l" (lab world), "t29a-r" (rounding world) and
// "t29a-z" (division by zero); request numbers with "T29A-". The six queries read the same tables, so every suite first deletes the rows of
// the other worlds (isolate) and runs inside a savepoint.
// "F line N", "FE line N", "FV line N", "P line N", "D line N", "L line N", "LE line N", "LV line N" and "A line N" mean a line of
// View__dbo_vDatesCompletionRatesByFacility.sql, ...FacilityEID, ...FacilityVL, ...Province, ...District, ...Lab, ...LabEID, ...LabVL and
// ...LabArea.
// Expected rows come from a small model of the v1 text (modelRows below) and from rows worked out by hand ("by hand").

const Q29 = {
  prov: 'Date completeness by province',
  dist: 'Date completeness by district',
  fac: 'Date completeness by facility',
  lab: 'Date completeness by lab',
  labfac: 'Date completeness by lab facility',
  area: 'Date completeness by lab area',
};
const t29query = (name) => queries().find((x) => x.name === name);
// Every view ends in the same six columns (F lines 7-11): Requests, then the five rates.
const T29_TAIL = ['Requests', 'SampleCollectionDate', 'SampleReceivedDate', 'RegisteredDate', 'AnalyzedDate', 'AuthorisedDate'];
const T29_COLUMNS = {
  prov: ['ProvinceName', ...T29_TAIL],
  dist: ['DistrictName', ...T29_TAIL],
  fac: ['FacilityName', ...T29_TAIL],
  lab: ['LabPrefix', 'LabFacility', ...T29_TAIL],
  labfac: ['LabFacility', ...T29_TAIL],
  area: ['LabName', ...T29_TAIL],
};

// ---- The v1 model ----
// A v1 datetime is a real date, so a text counts as a date only when it starts with YYYY-MM-DD (not '', not '2026-07', not 'garbage').
const t29valid = (x) => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}/.test(x);
const t29day = (x) => (t29valid(x) ? x.slice(0, 10) : null);
const t29min = (list) => list.map(t29day).filter((x) => x !== null).sort()[0] ?? null;
const t29fold = (x) => (x === null || x === undefined ? null : x.replace(/ +$/, '').toLowerCase());
// round((count(col) as decimal) / (count(id) as decimal) * 100, 1): half away from zero, in whole tenths (integer maths, no float).
// A count of 0 requests raises in v1 (Divide by zero error encountered); the model throws too.
function t29rate(c, n) {
  if (n === 0) throw new Error('division by zero');
  return Math.floor((2000 * c + n) / (2 * n)) / 10;
}
const t29byteCmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// SQL Server's text order for the plain names of this fixture (letters, digits, spaces): case and trailing spaces ignored, then bytes.
const t29textCmp = (a, b) => {
  if (a === null || b === null) return (a === null ? 0 : 1) - (b === null ? 0 : 1);
  return t29byteCmp(a.replace(/ +$/, '').toLowerCase(), b.replace(/ +$/, '').toLowerCase()) || t29byteCmp(a, b);
};
const T29_PANELS = { eid: ['hivpc'], vl: ['hivvl', 'viral'], lab: ['hivvl', 'hivpc', 'viral', 'hivst'] };
// The window date: the first date of the specimen collection, the received time and the registered time (L line 23).
const t29windowDay = (row) => row.spec ?? row.recv ?? row.reg;
function t29inWindow(row, from, to) {
  if (from === '' && to === '') return true;
  const d = t29windowDay(row);
  return d !== null && (from === '' || d >= from) && (to === '' || d <= to);
}

function group29a() {
  const P = 't29a-';
  let n = 0;
  const fm = []; // facility_map rows of every world
  const reqRows = [];
  const repRows = [];
  const specRows = [];
  const regs = { f: [], l: [], z: [], r: [] }; // the register rows of each world
  const recs = { f: [], l: [], z: [], r: [] };

  // A register row (facility_map). A row with `mapped` false has no register id: the code is not in the register.
  function fmap(w, code, region, district, name, mapped = true) {
    const i = fm.length + 1;
    fm.push(`(${lit(`${P}${w}-fm${i}`)}, '', '', ${lit(code)}, ${lit(mapped ? `reg-${P}${w}-${i}` : null)}, ${lit(name)}, ${lit(region)}, ${lit(district)})`);
    if (mapped) regs[w].push({ code, region, district, name });
  }
  const num = (v) => (v === null || v === undefined ? 'null' : String(v));
  // One request row. Dates: spec (the report's effective), recv (the specimen's received time), reg (authored_at), ana (analysis_at),
  // auth (the report's issued). `report: false`: no report (so no spec, recv, auth). `reports`: several reports as { spec, recv, auth, perf,
  // display }. `fac`: the requester code. `perf`, `display`: the report's performer and name.
  function add(w, o) {
    const r = { panel: 'HIVVL', rid: undefined, reg: null, spec: null, recv: null, ana: null, auth: null, report: true, fac: null, perf: null, display: null, obr: null, ...o };
    n += 1;
    r.id = `${P}${w}-q${n}`;
    if (r.rid === undefined) r.rid = `T29A-${w.toUpperCase()}${n}`;
    r.reps = r.reports ?? (r.report === false ? [] : [{ spec: r.spec, recv: r.recv, auth: r.auth, perf: r.perf, display: r.display }]);
    reqRows.push(`(${lit(r.id)}, ${lit(r.rid)}, ${lit(r.panel)}, ${lit(r.reg)}, ${lit(r.ana)}, ${lit(r.fac)}, ${num(r.obr)})`);
    r.reps.forEach((rep, i) => {
      let specimenId = null;
      if (rep.recv !== null && rep.recv !== undefined) {
        specimenId = `${r.id}-s${i + 1}`;
        specRows.push(`(${lit(specimenId)}, ${lit(rep.recv)})`);
      }
      repRows.push(`(${lit(`${r.id}-d${i + 1}`)}, ${lit(r.id)}, ${lit(rep.spec ?? null)}, ${lit(rep.auth ?? null)}, ${lit(rep.perf ?? null)}, ${lit(rep.display ?? null)}, ${lit(specimenId)})`);
    });
    recs[w].push(r);
    return r;
  }

  // The five dates by letter: S collection, V received, R registered, A analysed, U authorised. Different forms of a real date on purpose
  // (offset, Z, date only, fraction).
  const STAMPS = { S: '2026-05-04T09:30:00+02:00', V: '2026-05-05T10:00:00Z', R: '2026-05-06', A: '2026-05-07T11:00:00.000+02:00', U: '2026-05-08T23:50:00+02:00' };
  const KEYS = { S: 'spec', V: 'recv', R: 'reg', A: 'ana', U: 'auth' };
  const dates = (letters) => Object.fromEntries([...letters].map((c) => [KEYS[c], STAMPS[c]]));
  // Every date column holds `text`.
  const allDates = (text) => Object.fromEntries(Object.values(KEYS).map((k) => [k, text]));

  // ===========================================================================================================================
  // World f: the facility levels (province, district, facility)
  // ===========================================================================================================================
  const f = (o) => add('f', o);
  // F line 21: inner join FacilityList on RequestingFacilityCode = DisaCodes. The register mapping stands in for FacilityList.
  fmap('f', 'ZF1', 'Lusaka', 'Lusaka', 'Alpha Clinic');
  fmap('f', 'ZF2', 'Lusaka', 'Lusaka', 'Beta Clinic');
  fmap('f', 'ZF3', 'Lusaka', 'Kafue', 'Gamma Clinic');
  fmap('f', 'ZF4', 'Southern', 'Kafue', 'Delta Clinic');       // district Kafue again, in another province: the district view has one row for both
  fmap('f', 'ZF5', 'Lusaka', 'Lusaka', 'Merge Clinic');
  fmap('f', 'ZF6', 'LUSAKA ', 'lusaka', 'merge clinic ');       // the same names in other spellings: one row at every level
  fmap('f', 'ZF7', null, null, 'Nowhere Clinic');               // no province, no district: a NULL group
  fmap('f', 'ZF8', 'Western', 'Mongu', 'Panel Clinic');
  fmap('f', 'ZF9', 'Eastern', 'Chipata', 'Window Clinic');
  fmap('f', 'ZFA', 'Copperbelt', 'Ndola', 'Multi Clinic');
  fmap('f', 'ZFB', 'Northern', 'Kasama', 'Multi Window Clinic');
  fmap('f', 'ZUNMAP', 'Ghost', 'Ghost', 'Unmapped Clinic', false); // a map row with no register row: not in FacilityList

  // -- Alpha (ZF1): one date column per count, 1 to 5 of 10 requests; every column has a row where it is the only date --
  f({ fac: 'ZF1', ...dates('S') });       // a1
  f({ fac: 'ZF1', ...dates('V') });       // a2
  f({ fac: 'ZF1', ...dates('VR') });      // a3
  f({ fac: 'ZF1', ...dates('R') });       // a4
  f({ fac: 'ZF1', ...dates('RAU') });     // a5
  f({ fac: 'ZF1', ...dates('A') });       // a6
  f({ fac: 'ZF1', ...dates('AU') });      // a7
  f({ fac: 'ZF1', ...dates('AU') });      // a8
  f({ fac: 'ZF1', ...dates('U') });       // a9
  f({ fac: 'ZF1', ...dates('U') });       // a10
  // -- Beta (ZF2): a v1 datetime cannot hold '' or a partial date, so none of these count (2 of 6 do) --
  f({ fac: 'ZF2', ...dates('SVRAU') });                                                      // b1 counts
  f({ fac: 'ZF2', ...allDates('') });                                                        // b2 blank text
  f({ fac: 'ZF2', ...allDates('2026-07') });                                                 // b3 a month only
  f({ fac: 'ZF2', report: false });                                                          // b4 no report, nothing else
  f({ fac: 'ZF2', ...allDates('2026-5-1') });                                                // b5 not a date
  f({ fac: 'ZF2', ...allDates('2026-05-01') });                                              // b6 a date without a time counts
  // -- Gamma (ZF3): Count(RequestID) counts rows (F line 8): the same RequestID on several OBR rows counts each time; a NULL RequestID is not
  // counted, but its dates are (so a rate can pass 100) --
  f({ fac: 'ZF3', rid: 'T29A-DUP', obr: 1, ...dates('S') });                                // g1
  f({ fac: 'ZF3', rid: 'T29A-DUP', obr: 2, ...dates('SV') });                               // g2
  f({ fac: 'ZF3', rid: 'T29A-DUP', obr: 3 });                                               // g3
  f({ fac: 'ZF3', rid: 't29a-dup ', obr: 4, ...dates('V') });                               // g4 same id, other case and a trailing space
  f({ fac: 'ZF3', rid: null, ...dates('S') });                                              // g5
  f({ fac: 'ZF3', rid: null, ...dates('S') });                                              // g6
  f({ fac: 'ZF3', rid: null, ...dates('S') });                                              // g7
  // -- Delta (ZF4, Southern): and the only EID request here --
  f({ fac: 'ZF4', ...dates('SVRAU') });                                                     // d1
  f({ fac: 'ZF4', ...dates('S') });                                                         // d2
  f({ fac: 'ZF4' });                                                                        // d3
  f({ fac: 'ZF4', panel: 'HIVPC', ...dates('S') });                                         // d4
  // -- Merge (ZF5 and ZF6): one facility under two register rows and spellings --
  f({ fac: 'ZF5', ...dates('SVRAU') });                                                     // m1
  f({ fac: 'ZF5' });                                                                        // m2
  f({ fac: 'ZF6', ...dates('S') });                                                         // m3
  f({ fac: 'ZF6' });                                                                        // m4
  f({ fac: 'ZF6', ...dates('VR') });                                                        // m5
  // -- Nowhere (ZF7): register fields NULL --
  f({ fac: 'ZF7', ...dates('SVRAU') });                                                     // n1
  f({ fac: 'ZF7' });                                                                        // n2
  // -- Multi (ZFA): a request with two reports is one request row in v1 --
  f({ fac: 'ZFA', reg: STAMPS.R, ana: STAMPS.A, reports: [{ spec: STAMPS.S }, { spec: '2026-05-03T09:00:00+02:00', recv: STAMPS.V, auth: STAMPS.U }] }); // x1
  f({ fac: 'ZFA', reports: [{}, {}] });                                                      // x2 two reports, no dates
  // -- Multi Window (ZFB): reports with different dates. The request has the earliest, whatever the report order. --
  f({ fac: 'ZFB', reports: [{ spec: '2026-06-10T09:00:00+02:00' }, { spec: '2026-06-20T09:00:00+02:00' }] });   // y1
  f({ fac: 'ZFB', reports: [{ spec: '2026-06-20T09:00:00+02:00' }, { spec: '2026-06-10T09:00:00+02:00' }] });   // y2
  // -- Not in FacilityList: none of these is in any result (F line 21, inner join) --
  f({ fac: 'ZUNMAP', ...dates('SVRAU') });                                                  // u1 map row without a register row
  f({ fac: 'ZNOMAP', ...dates('SVRAU') });                                                  // u2 no map row
  f({ fac: null, ...dates('SVRAU') });                                                      // u3 no requester code
  // -- Panel (ZF8): one date per request, so each panel filter shows in the counts. FE line 21: HIVPC. FV line 21: HIVVL, VIRAL. --
  const pan = (panel, letters) => f({ fac: 'ZF8', panel, ...dates(letters) });
  pan('HIVVL', 'S');         // p1
  pan('VIRAL', 'V');         // p2
  pan('HIVPC', 'R');         // p3
  pan('hivpc ', 'A');        // p4 SQL Server ignores case and trailing spaces
  pan('hivvl', 'U');         // p5
  pan('HIVST', 'SVRAU');     // p6 in no EID or VL view
  pan('TBGNX', 'S');         // p7
  pan(null, 'V');            // p8 no panel: only the all view
  pan('viral ', 'R');        // p9
  // -- Window: the window date is the first date of collection, received and registered (L line 23). All stamps are local June 2026. --
  const windowRows = (w, extra) => {
    add(w, { ...extra, spec: '2026-06-10T00:30:00+02:00', ana: '2026-06-10T01:00:00+02:00' });             // w1 local 10 June (UTC 9 June)
    add(w, { ...extra, spec: '2026-06-11T00:30:00+02:00' });                                               // w2 local 11 June (UTC 10 June)
    add(w, { ...extra, recv: '2026-06-10T22:30:00Z' });                                                    // w3 no collection date: the received date
    add(w, { ...extra, spec: '', reg: '2026-06-10' });                                                     // w4 blank collection stamp: the registered date
    add(w, { ...extra, spec: '2026-06', reg: '2026-06-12' });                                              // w5 a month is not a date
    add(w, { ...extra, spec: '2026-06-20T09:00:00+02:00', reg: '2026-06-10T09:00:00+02:00' });             // w6 the collection date wins over the registered date
    add(w, { ...extra, ana: '2026-06-10T09:00:00+02:00', auth: '2026-06-10T09:00:00+02:00' });             // w7 no window date: only without a window
    add(w, { ...extra, spec: '2026-06-10T23:59:59.999Z' });                                                // w8 local 10 June, last millisecond
    add(w, { ...extra, spec: '2026-06-09T23:59:59+02:00' });                                               // w9 local 9 June
    add(w, { ...extra, recv: '2026-06-12T09:00:00+02:00' });                                               // w10
  };
  windowRows('f', { fac: 'ZF9' });

  // ===========================================================================================================================
  // World l: the lab levels (lab, lab facility, lab area). The lab is the report's performer; the name is the report's.
  // ===========================================================================================================================
  fmap('l', 'ZMP', 'Lusaka', 'Lusaka', 'Mapped Lab Name');  // a lab with no display name takes its register name (ruling 8)
  const l = (o) => add('l', o);
  const who = (perf, display) => ({ perf, display });
  // -- Lab Alpha: the Alpha design again, over two spellings of one code --
  ['S', 'V', 'VR', 'R', 'RAU', 'A', 'AU', 'AU', 'U', 'U'].forEach((letters, i) =>
    l({ ...who(i % 2 === 0 ? 'ZAB' : 'zab ', i % 3 === 0 ? 'Lab Alpha' : null), ...dates(letters) }));
  // -- Lab Shared: two codes, one name (case and trailing spaces ignored): two rows in the lab view, one in the lab facility and area views --
  l({ ...who('ZGH', 'Lab Shared'), ...dates('SVRAU') });
  l({ ...who('ZGH', 'Lab Shared'), ...dates('S') });
  l({ ...who('ZGH', 'Lab Shared') });
  l({ ...who('ZEF', 'lab shared '), ...dates('VR') });
  l({ ...who('ZEF', 'lab shared '), ...dates('SVRAU') });
  // -- A lab with no display name takes the register name; a lab named nowhere is shown by its code --
  l({ ...who('ZMP', null), ...dates('S') });
  l({ ...who('ZMP', null) });
  l({ ...who('ZXX', null), ...dates('SVRAU') });
  // -- One lab, three names on its reports: one name for the lab (not the code, then the smallest in byte order) --
  l({ ...who('ZNC', 'Name B'), ...dates('S') });
  l({ ...who('ZNC', 'Name A'), ...dates('S') });
  l({ ...who('ZNC', null), ...dates('S') });
  // -- A code that sorts before its name: the lab is named by the report's name, not by the smaller of the names and the code --
  l({ ...who('AAB', 'Zulu Lab'), ...dates('S') });
  l({ ...who('AAB', null), ...dates('V') });
  // -- No testing lab: no report, a blank code, no code. LabList cannot match these (inner join): none is in any result. --
  l({ report: false, ...dates('SVRAU') });
  l({ ...who('   ', 'Blank Lab'), ...dates('SVRAU') });
  l({ ...who(null, 'No Code Lab'), ...dates('SVRAU') });
  // -- Panel Lab: the panel rows again (L line 24: HIVVL, HIVPC, VIRAL, HIVST; LE: HIVPC; LV: HIVVL, VIRAL) --
  const lp = (panel, letters) => l({ ...who('ZPN', 'Panel Lab'), panel, ...dates(letters) });
  lp('HIVVL', 'S'); lp('VIRAL', 'V'); lp('HIVPC', 'R'); lp('hivpc ', 'A'); lp('hivvl', 'U'); lp('HIVST', 'SVRAU'); lp('TBGNX', 'S'); lp(null, 'V'); lp('viral ', 'R');
  // -- Window Lab --
  windowRows('l', { ...who('ZWL', 'Window Lab') });
  // -- One request, two reports from two labs: v1 has one testing code per request row; CE counts the request for each lab --
  l({ reports: [{ perf: 'ZTW1', display: 'Two One', spec: STAMPS.S }, { perf: 'ZTW2', display: 'Two Two', recv: STAMPS.V }] });

  // ===========================================================================================================================
  // World z: a group whose RequestIDs are all NULL. Count(RequestID) is 0, and v1 raises "Divide by zero error encountered".
  // ===========================================================================================================================
  fmap('z', 'ZZ1', 'Zero', 'Zero', 'Zero Clinic');
  add('z', { fac: 'ZZ1', rid: null, perf: 'ZZL', display: 'Zero Lab', ...dates('S') });
  add('z', { fac: 'ZZ1', rid: null, perf: 'ZZL', display: 'Zero Lab', ...dates('V') });

  // ===========================================================================================================================
  // World r: rounding. One facility per rule: n requests, of which the first c_k have the k-th date (S, V, R, A, U).
  // v1: round(c / n * 100, 1), half away from zero, on exact decimals.
  // ===========================================================================================================================
  const rounding = [
    // [name, n, [cS, cV, cR, cA, cU], wanted rates]
    ['Tie Sixteen', 16, [1, 3, 5, 7, 9], [6.3, 18.8, 31.3, 43.8, 56.3]],        // x.25 and x.75 round up (half away from zero)
    ['Tie Eighty', 80, [1, 23, 41, 51, 79], [1.3, 28.8, 51.3, 63.8, 98.8]],     // 23/80 and 41/80, 51/80: ties that a float product puts just below
    ['Third', 3, [1, 2, 3, 0, 1], [33.3, 66.7, 100.0, 0.0, 33.3]],            // repeating fractions: 66.67 rounds up, 33.33 down
    ['Seventh', 7, [1, 3, 5, 6, 7], [14.3, 42.9, 71.4, 85.7, 100.0]],
    ['Ninth', 9, [1, 8, 4, 5, 2], [11.1, 88.9, 44.4, 55.6, 22.2]],
  ];
  rounding.forEach(([name], i) => fmap('r', `ZR${i + 1}`, 'Rounding', 'Rounding', name));
  rounding.forEach(([, count, counts], i) => {
    for (let k = 0; k < count; k += 1) {
      add('r', { fac: `ZR${i + 1}`, ...Object.fromEntries(Object.keys(KEYS).map((letter, j) => [KEYS[letter], k < counts[j] ? STAMPS[letter] : null])) });
    }
  });

  const setup = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ${fm.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, obr_set_id) values
  ${reqRows.join(',\n  ')};
insert into specimens (id, received_time) values
  ${specRows.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, effective, issued, performer, performer_display, specimen_id) values
  ${repRows.join(',\n  ')};`;

  // ---- The model: v1's result for the rows of a world ----
  // The rows v1 reads (Requests joined to FacilityList or LabList), as { rid, panel, spec, recv, reg, ana, auth, ... }.
  function facilityRowsOf(w) {
    const out = [];
    for (const r of recs[w]) {
      const reg = regs[w].find((x) => x.code === r.fac); // FacilityList: an exact code
      if (!reg) continue;
      out.push({
        rid: r.rid, panel: r.panel, province: reg.region, district: reg.district, facility: reg.name,
        spec: t29min(r.reps.map((x) => x.spec)), recv: t29min(r.reps.map((x) => x.recv)), reg: t29day(r.reg), ana: t29day(r.ana), auth: t29min(r.reps.map((x) => x.auth)),
      });
    }
    return out;
  }
  function labRowsOf(w) {
    const out = [];
    for (const r of recs[w]) {
      for (const x of r.reps) {
        if (x.perf === null || x.perf === undefined || x.perf.replace(/ +$/, '') === '') continue; // no testing code: LabList cannot match
        const mapped = regs[w].find((m) => m.code === x.perf);
        const display = x.display !== null && x.display !== undefined && x.display.trim() !== '' ? x.display : null;
        out.push({
          rid: r.rid, panel: r.panel, code: x.perf, name: display ?? mapped?.name ?? x.perf,
          spec: t29day(x.spec), recv: t29day(x.recv), reg: t29day(r.reg), ana: t29day(r.ana), auth: t29day(x.auth),
        });
      }
    }
    return out;
  }
  // The panel filter of each query, by test type ('' and 'all' are no filter where the view exists).
  function panelOk(row, level, type) {
    const p = t29fold(row.panel);
    if (level === 'lab') return T29_PANELS.lab.includes(p);
    if (level === 'area' || level === 'prov' || level === 'dist') return true;
    const t = t29fold(type);
    const kind = (t === 'eid' && T29_PANELS.eid.includes(p)) || (t === 'vl' && T29_PANELS.vl.includes(p));
    return level === 'labfac' ? kind : (t === '' || t === 'all' || kind);
  }
  // One name per lab code from the listed rows: a name that is not just the code first, then the smallest in byte order.
  function labNames(rows) {
    const byCode = new Map();
    for (const r of rows) {
      const k = t29fold(r.code);
      if (!byCode.has(k)) byCode.set(k, []);
      byCode.get(k).push(r);
    }
    const names = new Map();
    for (const [k, list] of byCode) {
      const sorted = list.map((r) => r.name).sort((a, b) => ((t29fold(a) === k) - (t29fold(b) === k)) || t29byteCmp(a, b));
      names.set(k, sorted[0]);
    }
    return names;
  }
  // The rows of a query as the model sees them: filter, group, count, rate, order.
  function modelRows(level, { test_type = '', from = '', to = '' } = {}) {
    const isLab = level === 'lab' || level === 'labfac' || level === 'area';
    const rows = (isLab ? labRowsOf('l') : facilityRowsOf('f')).filter((r) => panelOk(r, level, test_type) && t29inWindow(r, from, to));
    const names = isLab ? labNames(rows) : null;
    const keyOf = (r) => {
      if (level === 'prov') return r.province;
      if (level === 'dist') return r.district;
      if (level === 'fac') return r.facility;
      return names.get(t29fold(r.code));
    };
    // The lab view groups on the code (the name follows from it); the others on the key text.
    const groupKey = (r) => (level === 'lab' ? t29fold(r.code) : t29fold(keyOf(r)));
    const groups = new Map();
    for (const r of rows) {
      const k = groupKey(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const out = [];
    for (const list of groups.values()) {
      const counted = list.filter((r) => r.rid !== null).length; // Count(RequestID) skips NULL
      const rates = ['spec', 'recv', 'reg', 'ana', 'auth'].map((c) => t29rate(list.filter((r) => r[c] !== null).length, counted));
      const tail = Object.fromEntries(T29_TAIL.map((c, i) => [c, i === 0 ? counted : rates[i - 1]]));
      if (level === 'lab') {
        const spellings = list.map((r) => r.code).sort(t29byteCmp);
        out.push({ LabPrefix: spellings[0], LabFacility: names.get(t29fold(list[0].code)), ...tail });
      } else {
        const spellings = list.map((r) => keyOf(r)).sort((a, b) => (a === null ? -1 : b === null ? 1 : t29byteCmp(a, b)));
        out.push({ [T29_COLUMNS[level][0]]: spellings[0], ...tail });
      }
    }
    const lead = T29_COLUMNS[level].length - T29_TAIL.length;
    return out.sort((a, b) => {
      for (let i = 0; i < lead; i += 1) {
        const c = T29_COLUMNS[level][i];
        const d = t29textCmp(a[c], b[c]);
        if (d !== 0) return d;
      }
      for (const c of T29_TAIL) if (a[c] !== b[c]) return a[c] - b[c];
      return 0;
    });
  }

  // ---- Suites ----
  // Remove the rows of the other worlds, so a suite sees only its own fixture (ids start with the prefix and the world letter).
  const isolate = (w) => ['diagnostic_reports', 'specimens', 'lab_requests', 'facility_map'].map((t) => `delete from ${t} where id not like '${P}${w}-%';`).join('\n');
  const WORLD = { prov: 'f', dist: 'f', fac: 'f', lab: 'l', labfac: 'l', area: 'l' };
  let sp = 0;
  const NONE = { test_type: '', from: '', to: '' };
  // The exact rows in order. `where` is a condition on the query's own columns (z); `w` picks the world.
  function listSuite(name, level, params, wanted, { where, w = WORLD[level] } = {}) {
    const q = t29query(Q29[level]);
    const text = q && where ? `select z.* from (${q.sql}) z where ${where}` : (q?.sql ?? 'select null::text as "x"');
    const s = orderedSuite(name, text, { ...NONE, ...params }, T29_COLUMNS[level], wanted);
    if (!q) {
      const check = s.check;
      s.check = (got) => [`query "${Q29[level]}" is missing`, ...check(got)];
    }
    sp += 1;
    s.sql = `savepoint t29sp${sp};\n${isolate(w)}\n${s.sql}\nrollback to savepoint t29sp${sp};`;
    return s;
  }
  // The whole result against the model.
  const modelSuite = (name, level, params = {}) => {
    let want;
    try { want = modelRows(level, params); } catch (e) { return { name, count: 1, check: () => [`model: ${e.message}`] }; }
    return listSuite(name, level, params, want);
  };
  // One JSON value, compared whole.
  function valueSuite(name, level, w, selectExpr, want) {
    const q = t29query(Q29[level]);
    sp += 1;
    if (!q) return { name, count: 1, check: () => [`query "${Q29[level]}" is missing`] };
    return {
      name,
      count: 1,
      sql: `savepoint t29sp${sp};\n${isolate(w)}\nselect ${lit(name)} || chr(9) || (${selectExpr(q.sql)})::text;\nrollback to savepoint t29sp${sp};`,
      check: (got) => (JSON.stringify(got) === JSON.stringify([want]) ? [] : [`expected ${JSON.stringify([want])}, got ${JSON.stringify(got)}`]),
    };
  }
  const typesOf = (columns, params) => (sqlText) => `select json_build_object(${columns.map((c) => `${lit(c)}, pg_typeof(q."${c}")::text`).join(', ')}) from (${bind(sqlText, { ...NONE, ...params })}) q limit 1`;
  const rateTypes = (level) => Object.fromEntries(T29_COLUMNS[level].slice(-5).map((c) => [c, 'double precision']));
  // v1 raises on a group with no RequestID: so does the port. The suite catches the error and reports its name.
  function raisesSuite(name, level) {
    const q = t29query(Q29[level]);
    sp += 1;
    if (!q) return { name, count: 1, check: () => [`query "${Q29[level]}" is missing`] };
    const text = bind(q.sql, { ...NONE, test_type: level === 'labfac' ? 'VL' : '' });
    return {
      name,
      count: 1,
      sql: `savepoint t29sp${sp};\n${isolate('z')}\ncreate temp table t29_err (msg text);
do $do$ begin
  begin
    perform 1 from (${text}) q;
    insert into t29_err values ('no error');
  exception when division_by_zero then
    insert into t29_err values ('division by zero');
  end;
end $do$;
select ${lit(name)} || chr(9) || to_json((select msg from t29_err))::text;\nrollback to savepoint t29sp${sp};`,
      check: (got) => (JSON.stringify(got) === JSON.stringify(['division by zero']) ? [] : [`expected ["division by zero"], got ${JSON.stringify(got)}`]),
    };
  }

  const BANNED29 = /--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i;
  // The declared parameters: ids in order, types, which are required; the SQL a plain read-only SELECT.
  const shape29 = (name, level, wantIds, wantTypes, wantRequired) => ({
    name,
    count: 2 + 2 * wantIds.length,
    check() {
      const q = t29query(Q29[level]);
      if (!q) return [`query "${Q29[level]}" is missing`];
      const bad = [];
      const ids = q.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(wantIds)) bad.push(`params: expected ${wantIds}, got ${ids}`);
      q.params.forEach((p, i) => {
        if (p.required !== wantRequired[i]) bad.push(`${p.id}: required should be ${wantRequired[i]}`);
        if (p.type !== wantTypes[i]) bad.push(`${p.id}: expected type ${wantTypes[i]}, got ${p.type}`);
      });
      if (BANNED29.test(q.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (!/^\s*with\b/i.test(q.sql)) bad.push('does not start with "with"');
      return bad;
    },
  });
  // CE pages a result with LIMIT and OFFSET, so the ORDER BY must be total (v1 has none): it must name every output column.
  const orderHas = (name, level, needles) => ({
    name,
    count: needles.length,
    check() {
      const q = t29query(Q29[level]);
      if (!q) return [`query "${Q29[level]}" is missing`];
      const tail = q.sql.slice(q.sql.lastIndexOf('order by'));
      return needles.filter((x) => !tail.includes(x)).map((x) => `ORDER BY must list ${x}`);
    },
  });
  const optionsAre = (name, level, words) => ({
    name,
    count: 1,
    check() {
      const p = t29query(Q29[level])?.params.find((x) => x.id === 'test_type');
      if (!p || !p.optionsSql) return ['test_type has no optionsSql'];
      const got = [...p.optionsSql.matchAll(/'([^']*)'/g)].map((m) => m[1]);
      return JSON.stringify(got) === JSON.stringify(words) ? [] : [`expected options ${JSON.stringify(words)}, got ${JSON.stringify(got)}`];
    },
  });

  const W10 = { from: '2026-06-10', to: '2026-06-10' };
  const W11 = { from: '2026-06-11' };
  const W09 = { to: '2026-06-09' };
  const WMAY = { from: '2026-05-01', to: '2026-05-31' };
  const WMAY5 = { from: '2026-05-05', to: '2026-05-05' };
  const row = (first, tail) => ({ ...first, ...Object.fromEntries(T29_TAIL.map((c, i) => [c, tail[i]])) });
  const onlyName = (level, name) => `z."${T29_COLUMNS[level][0]}" = ${lit(name)}`;
  const ORDER_TAIL = ['g.requests', 'g.r1', 'g.r2', 'g.r3', 'g.r4', 'g.r5'];
  const suites29 = [
    { name: 't29a-setup', setup, count: 0, check: () => [] },

    // ---- Declared shape ----
    shape29('t29a-shape-prov', 'prov', ['from', 'to'], ['text', 'text'], [false, false]),
    shape29('t29a-shape-dist', 'dist', ['from', 'to'], ['text', 'text'], [false, false]),
    shape29('t29a-shape-fac', 'fac', ['test_type', 'from', 'to'], ['select', 'text', 'text'], [false, false, false]),
    shape29('t29a-shape-lab', 'lab', ['from', 'to'], ['text', 'text'], [false, false]),
    shape29('t29a-shape-labfac', 'labfac', ['test_type', 'from', 'to'], ['select', 'text', 'text'], [true, false, false]),
    shape29('t29a-shape-area', 'area', ['from', 'to'], ['text', 'text'], [false, false]),
    optionsAre('t29a-options-fac', 'fac', ['all', 'EID', 'VL']),
    optionsAre('t29a-options-labfac', 'labfac', ['EID', 'VL']),
    orderHas('t29a-order-prov', 'prov', ['g.k', ...ORDER_TAIL]),
    orderHas('t29a-order-dist', 'dist', ['g.k', ...ORDER_TAIL]),
    orderHas('t29a-order-fac', 'fac', ['g.k', ...ORDER_TAIL]),
    orderHas('t29a-order-lab', 'lab', ['g.prefix', 'g.facility', ...ORDER_TAIL]),
    orderHas('t29a-order-labfac', 'labfac', ['g.k', ...ORDER_TAIL]),
    orderHas('t29a-order-area', 'area', ['g.k', ...ORDER_TAIL]),

    // ---- By hand: the facility rows (F lines 7-23) ----
    // Alpha: S1 V2 R3 A4 U5 of 10 requests (the rates are 10, 20, 30, 40, 50). Every column has a row where it is the only date.
    listSuite('t29a-hand-alpha', 'fac', {}, [row({ FacilityName: 'Alpha Clinic' }, [10, 10.0, 20.0, 30.0, 40.0, 50.0])], { where: onlyName('fac', 'Alpha Clinic') }),
    // Beta: '', '2026-07', 'no date', no report, '2026-5-1' do not count; a full stamp and a date-only stamp do: 2 of 6 in every column.
    listSuite('t29a-hand-beta', 'fac', {}, [row({ FacilityName: 'Beta Clinic' }, [6, 33.3, 33.3, 33.3, 33.3, 33.3])], { where: onlyName('fac', 'Beta Clinic') }),
    // Gamma: g1-g4 are 4 rows (one RequestID on 3 OBR rows, plus its other spelling); g5-g7 have no RequestID (not counted) but their dates
    // are: S = g1 g2 g5 g6 g7 = 5 of 4. V = g2 g4 = 2 of 4.
    listSuite('t29a-hand-gamma', 'fac', {}, [row({ FacilityName: 'Gamma Clinic' }, [4, 125.0, 50.0, 0.0, 0.0, 0.0])], { where: onlyName('fac', 'Gamma Clinic') }),
    // Delta: d1 d2 d4 have a collection date; the other columns only d1. 4 requests.
    listSuite('t29a-hand-delta', 'fac', {}, [row({ FacilityName: 'Delta Clinic' }, [4, 75.0, 25.0, 25.0, 25.0, 25.0])], { where: onlyName('fac', 'Delta Clinic') }),
    // Merge: two register rows (and two spellings of the name) are one group (group by FacilityName, SQL Server's collation); the shown
    // spelling is the smaller in byte order. S = m1 m3 = 2, V = m1 m5 = 2, R = m1 m5 = 2, A = m1, U = m1 of 5.
    listSuite('t29a-hand-merge', 'fac', {}, [row({ FacilityName: 'Merge Clinic' }, [5, 40.0, 40.0, 40.0, 20.0, 20.0])], { where: `lower(rtrim(z."FacilityName")) = 'merge clinic'` }),
    // Multi: a request with two reports is one request row; x2 has two reports and no date.
    listSuite('t29a-hand-multi', 'fac', {}, [row({ FacilityName: 'Multi Clinic' }, [2, 50.0, 50.0, 50.0, 50.0, 50.0])], { where: onlyName('fac', 'Multi Clinic') }),
    // Nowhere: the register row has no province and no district.
    listSuite('t29a-hand-nowhere', 'fac', {}, [row({ FacilityName: 'Nowhere Clinic' }, [2, 50.0, 50.0, 50.0, 50.0, 50.0])], { where: onlyName('fac', 'Nowhere Clinic') }),
    // Panel Clinic over the three views (F, FE line 21, FV line 21). p1..p9 as marked above.
    // All nine: S = p1 p6 p7 = 3, V = p2 p6 p8 = 3, R = p3 p6 p9 = 3, A = p4 p6 = 2, U = p5 p6 = 2.
    listSuite('t29a-hand-panel-blank', 'fac', {}, [row({ FacilityName: 'Panel Clinic' }, [9, 33.3, 33.3, 33.3, 22.2, 22.2])], { where: onlyName('fac', 'Panel Clinic') }),
    listSuite('t29a-hand-panel-all', 'fac', { test_type: 'all' }, [row({ FacilityName: 'Panel Clinic' }, [9, 33.3, 33.3, 33.3, 22.2, 22.2])], { where: onlyName('fac', 'Panel Clinic') }),
    // EID: HIVPC, and 'hivpc ' (p3 R, p4 A): 2 requests.
    listSuite('t29a-hand-panel-eid', 'fac', { test_type: 'EID' }, [row({ FacilityName: 'Panel Clinic' }, [2, 0.0, 0.0, 50.0, 50.0, 0.0])], { where: onlyName('fac', 'Panel Clinic') }),
    // VL: HIVVL, VIRAL, 'hivvl', 'viral ' (p1 S, p2 V, p5 U, p9 R): 4 requests.
    listSuite('t29a-hand-panel-vl', 'fac', { test_type: 'VL' }, [row({ FacilityName: 'Panel Clinic' }, [4, 25.0, 25.0, 25.0, 0.0, 25.0])], { where: onlyName('fac', 'Panel Clinic') }),
    // Delta has one EID request (d4, collection date only) and three VL requests (d1, d2, d3).
    listSuite('t29a-hand-delta-eid', 'fac', { test_type: 'EID' }, [row({ FacilityName: 'Delta Clinic' }, [1, 100.0, 0.0, 0.0, 0.0, 0.0])], { where: onlyName('fac', 'Delta Clinic') }),
    listSuite('t29a-hand-delta-vl', 'fac', { test_type: 'VL' }, [row({ FacilityName: 'Delta Clinic' }, [3, 66.7, 33.3, 33.3, 33.3, 33.3])], { where: onlyName('fac', 'Delta Clinic') }),

    // A request with two reports takes the earliest report date (the window date), whatever the report order: 10 June, not 20 June.
    listSuite('t29a-hand-multi-win10', 'fac', W10, [row({ FacilityName: 'Multi Window Clinic' }, [2, 100.0, 0.0, 0.0, 0.0, 0.0])], { where: onlyName('fac', 'Multi Window Clinic') }),
    listSuite('t29a-hand-multi-win11', 'fac', W11, [], { where: onlyName('fac', 'Multi Window Clinic') }),
    listSuite('t29a-hand-multi-win-none', 'fac', {}, [row({ FacilityName: 'Multi Window Clinic' }, [2, 100.0, 0.0, 0.0, 0.0, 0.0])], { where: onlyName('fac', 'Multi Window Clinic') }),

    // ---- By hand: province and district rows (P lines 6-22, D lines 6-22) ----
    // Southern is Delta alone; Western is the Panel Clinic alone; the NULL province is Nowhere alone.
    listSuite('t29a-hand-prov-southern', 'prov', {}, [row({ ProvinceName: 'Southern' }, [4, 75.0, 25.0, 25.0, 25.0, 25.0])], { where: onlyName('prov', 'Southern') }),
    listSuite('t29a-hand-prov-western', 'prov', {}, [row({ ProvinceName: 'Western' }, [9, 33.3, 33.3, 33.3, 22.2, 22.2])], { where: onlyName('prov', 'Western') }),
    listSuite('t29a-hand-prov-null', 'prov', {}, [row({ ProvinceName: null }, [2, 50.0, 50.0, 50.0, 50.0, 50.0])], { where: 'z."ProvinceName" is null' }),
    // Lusaka: Alpha 10, Beta 6, Gamma 4 and the Merge Clinic 5 (its register row 'LUSAKA ' is the same province): 25 requests, shown as
    // 'LUSAKA ' (the smaller spelling in byte order). S = 1+2+5+2 = 10, V = 2+2+2+2 = 8, R = 3+2+0+2 = 7, A = 4+2+0+1 = 7, U = 5+2+0+1 = 8.
    listSuite('t29a-hand-prov-lusaka', 'prov', {}, [row({ ProvinceName: 'LUSAKA ' }, [25, 40.0, 32.0, 28.0, 28.0, 32.0])], { where: `lower(rtrim(z."ProvinceName")) = 'lusaka'` }),
    // Kafue: Gamma (Lusaka) and Delta (Southern) are one district: 8 requests, S = 5+3 = 8, V = 2+1, R = 0+1, A = 0+1, U = 0+1.
    listSuite('t29a-hand-dist-kafue', 'dist', {}, [row({ DistrictName: 'Kafue' }, [8, 100.0, 37.5, 12.5, 12.5, 12.5])], { where: onlyName('dist', 'Kafue') }),
    listSuite('t29a-hand-dist-null', 'dist', {}, [row({ DistrictName: null }, [2, 50.0, 50.0, 50.0, 50.0, 50.0])], { where: 'z."DistrictName" is null' }),
    // Lusaka district: Alpha, Beta, Merge (both spellings, 'Lusaka' and 'lusaka'): 21 requests. S = 1+2+2 = 5, V = 2+2+2 = 6, R = 3+2+2 = 7,
    // A = 4+2+1 = 7, U = 5+2+1 = 8 over 21: 23.8, 28.6, 33.3, 33.3, 38.1.
    listSuite('t29a-hand-dist-lusaka', 'dist', {}, [row({ DistrictName: 'Lusaka' }, [21, 23.8, 28.6, 33.3, 33.3, 38.1])], { where: `lower(z."DistrictName") = 'lusaka'` }),
    listSuite('t29a-hand-dist-mongu', 'dist', {}, [row({ DistrictName: 'Mongu' }, [9, 33.3, 33.3, 33.3, 22.2, 22.2])], { where: onlyName('dist', 'Mongu') }),

    // ---- Whole results against the model ----
    modelSuite('t29a-prov-all', 'prov'),
    modelSuite('t29a-dist-all', 'dist'),
    modelSuite('t29a-fac-blank', 'fac'),
    modelSuite('t29a-fac-all', 'fac', { test_type: 'all' }),
    modelSuite('t29a-fac-all-spelled', 'fac', { test_type: 'All  ' }),
    modelSuite('t29a-fac-eid', 'fac', { test_type: 'EID' }),
    modelSuite('t29a-fac-eid-spelled', 'fac', { test_type: 'eid ' }),
    modelSuite('t29a-fac-vl', 'fac', { test_type: 'VL' }),
    modelSuite('t29a-fac-vl-spelled', 'fac', { test_type: 'vl' }),
    modelSuite('t29a-fac-unknown', 'fac', { test_type: 'TB' }),
    modelSuite('t29a-lab-all', 'lab'),
    modelSuite('t29a-area-all', 'area'),
    modelSuite('t29a-labfac-eid', 'labfac', { test_type: 'EID' }),
    modelSuite('t29a-labfac-eid-spelled', 'labfac', { test_type: 'eid ' }),
    modelSuite('t29a-labfac-vl', 'labfac', { test_type: 'VL' }),
    modelSuite('t29a-labfac-vl-spelled', 'labfac', { test_type: 'vl' }),
    // v1 has no all view of the lab facility: a blank or other type gives no rows.
    modelSuite('t29a-labfac-blank', 'labfac', { test_type: '' }),
    modelSuite('t29a-labfac-all', 'labfac', { test_type: 'all' }),

    // ---- Windows (L line 23): the date is the first of collection, received, registered ----
    modelSuite('t29a-prov-win10', 'prov', W10),
    modelSuite('t29a-dist-win10', 'dist', W10),
    modelSuite('t29a-fac-win10', 'fac', W10),
    modelSuite('t29a-fac-win11', 'fac', W11),
    modelSuite('t29a-fac-win09', 'fac', W09),
    modelSuite('t29a-fac-winmay', 'fac', WMAY),
    modelSuite('t29a-fac-winmay5', 'fac', WMAY5),
    modelSuite('t29a-fac-win10-eid', 'fac', { ...W10, test_type: 'EID' }),
    modelSuite('t29a-prov-winmay', 'prov', WMAY),
    modelSuite('t29a-dist-winmay5', 'dist', WMAY5),
    modelSuite('t29a-lab-win10', 'lab', W10),
    modelSuite('t29a-lab-win11', 'lab', W11),
    modelSuite('t29a-lab-winmay', 'lab', WMAY),
    modelSuite('t29a-area-win10', 'area', W10),
    modelSuite('t29a-area-win09', 'area', W09),
    modelSuite('t29a-labfac-win10-vl', 'labfac', { ...W10, test_type: 'VL' }),
    modelSuite('t29a-labfac-winmay-vl', 'labfac', { ...WMAY, test_type: 'VL' }),
    // By hand: the Window Clinic. 10 June: w1 (local 10, UTC 9), w3 (received), w4 (registered), w8 (local 10, last millisecond).
    // w2 (local 11, UTC 10), w5 (a month, then the registered 12th), w6 (collected the 20th), w7 (no window date), w9 (9th), w10 (12th) are out.
    // S = w1 w8 = 2, V = w3, R = w4, A = w1, U = 0, over 4.
    listSuite('t29a-hand-win10', 'fac', W10, [row({ FacilityName: 'Window Clinic' }, [4, 50.0, 25.0, 25.0, 25.0, 0.0])], { where: onlyName('fac', 'Window Clinic') }),
    // From 11 June: w2 (11th), w5 (12th), w6 (20th), w10 (12th): S = w2 w6, V = w10, R = w5 w6, over 4.
    listSuite('t29a-hand-win11', 'fac', W11, [row({ FacilityName: 'Window Clinic' }, [4, 50.0, 25.0, 50.0, 0.0, 0.0])], { where: onlyName('fac', 'Window Clinic') }),
    // No window: all ten, w7 too. S = w1 w2 w6 w8 w9 = 5, V = w3 w10 = 2, R = w4 w5 w6 = 3, A = w1 w7 = 2, U = w7 = 1.
    listSuite('t29a-hand-win-none', 'fac', {}, [row({ FacilityName: 'Window Clinic' }, [10, 50.0, 20.0, 30.0, 20.0, 10.0])], { where: onlyName('fac', 'Window Clinic') }),
    // To 9 June: the Window Clinic has w9 alone; the May rows of the other facilities are in.
    listSuite('t29a-hand-win09', 'fac', W09, [row({ FacilityName: 'Window Clinic' }, [1, 100.0, 0.0, 0.0, 0.0, 0.0])], { where: onlyName('fac', 'Window Clinic') }),
    // May: Alpha a1-a5 only (a window date is a collection, received or registered date; a6-a10 have none): S1 V2 R3 A1 U1 of 5.
    listSuite('t29a-hand-win-may', 'fac', WMAY, [row({ FacilityName: 'Alpha Clinic' }, [5, 20.0, 40.0, 60.0, 20.0, 20.0])], { where: onlyName('fac', 'Alpha Clinic') }),

    // ---- By hand: the lab rows (L lines 6-26, LE, LV, A) ----
    // Lab Alpha: ZAB and 'zab ' are one lab; the Alpha design again (S1 V2 R3 A4 U5 of 10). The name is the report's.
    listSuite('t29a-hand-lab-alpha', 'lab', {}, [row({ LabPrefix: 'ZAB', LabFacility: 'Lab Alpha' }, [10, 10.0, 20.0, 30.0, 40.0, 50.0])], { where: `z."LabPrefix" = 'ZAB'` }),
    // Lab Shared: ZGH 3 requests (S 2, V 1, R 1, A 1, U 1), ZEF 2 requests (S 1, V 2, R 2, A 1, U 1). One name per CODE (the Task 16 rule):
    // ZEF keeps its own spelling 'lab shared ' here; the name views below merge the two names.
    listSuite('t29a-hand-lab-shared', 'lab', {}, [
      row({ LabPrefix: 'ZEF', LabFacility: 'lab shared ' }, [2, 50.0, 100.0, 100.0, 50.0, 50.0]),
      row({ LabPrefix: 'ZGH', LabFacility: 'Lab Shared' }, [3, 66.7, 33.3, 33.3, 33.3, 33.3]),
    ], { where: `lower(rtrim(z."LabFacility")) = 'lab shared'` }),
    // The lab facility and lab area views group on the name: ZGH and ZEF are one row of 5. S = 3, V = 3, R = 3, A = 2, U = 2.
    listSuite('t29a-hand-labfac-shared', 'labfac', { test_type: 'VL' }, [row({ LabFacility: 'Lab Shared' }, [5, 60.0, 60.0, 60.0, 40.0, 40.0])], { where: onlyName('labfac', 'Lab Shared') }),
    listSuite('t29a-hand-area-shared', 'area', {}, [row({ LabName: 'Lab Shared' }, [5, 60.0, 60.0, 60.0, 40.0, 40.0])], { where: onlyName('area', 'Lab Shared') }),
    // Names: a lab with no display name takes its register name; ZXX is shown by its code; ZNC takes the smallest name that is not the code.
    listSuite('t29a-hand-lab-names', 'lab', {}, [
      row({ LabPrefix: 'AAB', LabFacility: 'Zulu Lab' }, [2, 50.0, 50.0, 0.0, 0.0, 0.0]),
      row({ LabPrefix: 'ZMP', LabFacility: 'Mapped Lab Name' }, [2, 50.0, 0.0, 0.0, 0.0, 0.0]),
      row({ LabPrefix: 'ZNC', LabFacility: 'Name A' }, [3, 100.0, 0.0, 0.0, 0.0, 0.0]),
      row({ LabPrefix: 'ZXX', LabFacility: 'ZXX' }, [1, 100.0, 100.0, 100.0, 100.0, 100.0]),
    ], { where: `z."LabPrefix" in ('AAB', 'ZMP', 'ZNC', 'ZXX')` }),
    listSuite('t29a-hand-area-zulu', 'area', {}, [row({ LabName: 'Zulu Lab' }, [2, 50.0, 50.0, 0.0, 0.0, 0.0])], { where: onlyName('area', 'Zulu Lab') }),
    // The panel lab. The lab view takes HIVVL, HIVPC, VIRAL and HIVST (7 of 9; L line 24): S = p1 p6, V = p2 p6, R = p3 p6 p9, A = p4 p6, U = p5 p6.
    listSuite('t29a-hand-lab-panel', 'lab', {}, [row({ LabPrefix: 'ZPN', LabFacility: 'Panel Lab' }, [7, 28.6, 28.6, 42.9, 28.6, 28.6])], { where: `z."LabPrefix" = 'ZPN'` }),
    // The lab area view has no panel filter (A has none): all 9.
    listSuite('t29a-hand-area-panel', 'area', {}, [row({ LabName: 'Panel Lab' }, [9, 33.3, 33.3, 33.3, 22.2, 22.2])], { where: onlyName('area', 'Panel Lab') }),
    // EID (LE line 20: HIVPC): p3 R, p4 A. VL (LV line 20: HIVVL, VIRAL): p1 S, p2 V, p5 U, p9 R.
    listSuite('t29a-hand-labfac-eid', 'labfac', { test_type: 'EID' }, [row({ LabFacility: 'Panel Lab' }, [2, 0.0, 0.0, 50.0, 50.0, 0.0])], { where: onlyName('labfac', 'Panel Lab') }),
    listSuite('t29a-hand-labfac-vl', 'labfac', { test_type: 'VL' }, [row({ LabFacility: 'Panel Lab' }, [4, 25.0, 25.0, 25.0, 0.0, 25.0])], { where: onlyName('labfac', 'Panel Lab') }),
    // No lab, no result: the requests with no report, a blank code or no code are in no row.
    listSuite('t29a-hand-no-lab', 'area', {}, [], { where: `z."LabName" in ('Blank Lab', 'No Code Lab') or z."LabName" is null or rtrim(z."LabName") = ''` }),
    // One request, two reports from two labs: each lab counts it (v1 holds one testing code per request row).
    listSuite('t29a-hand-two-labs', 'lab', {}, [
      row({ LabPrefix: 'ZTW1', LabFacility: 'Two One' }, [1, 100.0, 0.0, 0.0, 0.0, 0.0]),
      row({ LabPrefix: 'ZTW2', LabFacility: 'Two Two' }, [1, 0.0, 100.0, 0.0, 0.0, 0.0]),
    ], { where: `z."LabPrefix" in ('ZTW1', 'ZTW2')` }),
    // The window lab, the same ten rows as the Window Clinic.
    listSuite('t29a-hand-lab-win10', 'lab', W10, [row({ LabPrefix: 'ZWL', LabFacility: 'Window Lab' }, [4, 50.0, 25.0, 25.0, 25.0, 0.0])], { where: `z."LabPrefix" = 'ZWL'` }),
    listSuite('t29a-hand-area-win-none', 'area', {}, [row({ LabName: 'Window Lab' }, [10, 50.0, 20.0, 30.0, 20.0, 10.0])], { where: onlyName('area', 'Window Lab') }),

    // ---- Rounding (world r): half away from zero on exact decimals ----
    listSuite('t29a-rounding', 'fac', {}, rounding.map(([name, count, , rates]) => row({ FacilityName: name }, [count, ...rates]))
      .sort((a, b) => t29textCmp(a.FacilityName, b.FacilityName)), { w: 'r' }),
    // The same rows as one province: 115 requests; S = 5, V = 39, R = 58, A = 69, U = 98 (the sums of the counts), over 115.
    listSuite('t29a-rounding-prov', 'prov', {}, [row({ ProvinceName: 'Rounding' }, [115, 4.3, 33.9, 50.4, 60.0, 85.2])], { w: 'r' }),

    // ---- Types: Requests is a count (bigint), every rate a double precision (convert(Double precision, ...)) ----
    valueSuite('t29a-types-prov', 'prov', 'f', typesOf(T29_COLUMNS.prov, {}), { ProvinceName: 'text', Requests: 'bigint', ...rateTypes('prov') }),
    valueSuite('t29a-types-dist', 'dist', 'f', typesOf(T29_COLUMNS.dist, {}), { DistrictName: 'text', Requests: 'bigint', ...rateTypes('dist') }),
    valueSuite('t29a-types-fac', 'fac', 'f', typesOf(T29_COLUMNS.fac, {}), { FacilityName: 'text', Requests: 'bigint', ...rateTypes('fac') }),
    valueSuite('t29a-types-lab', 'lab', 'l', typesOf(T29_COLUMNS.lab, {}), { LabPrefix: 'text', LabFacility: 'text', Requests: 'bigint', ...rateTypes('lab') }),
    valueSuite('t29a-types-labfac', 'labfac', 'l', typesOf(T29_COLUMNS.labfac, { test_type: 'VL' }), { LabFacility: 'text', Requests: 'bigint', ...rateTypes('labfac') }),
    valueSuite('t29a-types-area', 'area', 'l', typesOf(T29_COLUMNS.area, {}), { LabName: 'text', Requests: 'bigint', ...rateTypes('area') }),

    // ---- A group with no RequestID: v1 raises (Divide by zero error encountered); so does the port ----
    raisesSuite('t29a-zero-fac', 'fac'),
    raisesSuite('t29a-zero-lab', 'lab'),
  ];
  return { name: 't29a', suites: suites29 };
}

export const groups = [{ name: 't5-vleid', suites }, group25(), group26(), group27(), group28(), group29a()];

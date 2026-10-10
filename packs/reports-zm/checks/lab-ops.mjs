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

export const groups = [{ name: 't5-vleid', suites }, group25(), group26()];

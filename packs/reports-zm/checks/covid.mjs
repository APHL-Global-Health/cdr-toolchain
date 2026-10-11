// Check groups for the covid reports. Each task adds { name, suites } entries to this list (t22 below, t23 at the end of the file).
//
// Group t22: COVID-19 by testing lab (sp_COV2_LabStats), COVID-19 by source facility (sp_COV2_SourceStats, with sp_COV2_PSources and
// sp_COV2_TSources) and COVID-19 positive patients (sp_COV2_PListing). Fixture ids start with "t22-"; lab numbers start with "T22-".
// "v1 line N" means a line of StoredProcedure__dbo_sp_COV2_<name>.sql: LabStats unless a case names another. The counts in LabStats and
// SourceStats are the same text (LabStats lines 21-275, SourceStats lines 21-270); PSources and TSources differ from SourceStats at line
// 274 and 268 only.

import { lit, inOrder } from '../../shared/pg-check.mjs';
import { queries } from '../queries/covid.mjs';
import { bind, facilityRows, orderedSuite, errorSuite as errorSuiteOf, dateErrorSuites } from './epi-fixture.mjs';

const LAB_STATS = 'COVID-19 by testing lab';
const SOURCE_STATS = 'COVID-19 by source facility';
const POSITIVE_LIST = 'COVID-19 positive patients';
const query = (name) => queries().find((q) => q.name === name);

const ATTR = 'urn:openldr:cs:request-attribute';
const POS_TEXT = 'SARs-Cov-2 Genes Detected';
const POS = { obs: 'COV2', text: POS_TEXT };
const NEG = { obs: 'COV2', text: 'SARs-Cov-2 Genes Not Detected' };

// ---- The fixture ----
//
// What one request holds unless a case says otherwise: panel COVID, at the facility ZCHOM, tested at lab ZUA, registered, analysed and
// authorised (final) inside the window 2026-05-01 to 2026-05-31, with a report and no results. `ana` and `iss` can be null.
const DEFAULTS = {
  panel: 'COVID', auth: '2026-05-10T08:00:00Z', ana: '2026-05-11T08:00:00Z', eff: '2026-05-09T07:00:00Z', iss: '2026-05-12T08:00:00Z',
  req: 'ZCHOM', perf: 'ZUA', status: 'final', report: true, results: [], patient: null, attrs: [],
};
const num = (v) => (v === null || v === undefined ? 'null' : String(v));

function makeFixture(p) {
  const patients = [];
  const requests = [];
  const reports = [];
  const results = [];
  const attrs = [];
  let n = 0;
  return {
    // One request row. `o` overrides DEFAULTS; `labId` is the lab number (RequestID).
    add(labId, o = {}) {
      const r = { ...DEFAULTS, ...o };
      n += 1;
      const qid = `${p}-q${n}`;
      let patientId = null;
      if (r.patient) {
        patientId = `${p}-p${n}`;
        patients.push(`(${lit(patientId)}, ${lit(r.patient[0])}, ${lit(r.patient[1])})`);
      }
      requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.auth)}, ${lit(r.ana)}, ${lit(r.req)}, ${lit(patientId)})`);
      if (r.report) reports.push(`(${lit(`${p}-d${n}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.eff)}, ${lit(r.iss)}, ${lit(r.perf)})`);
      r.results.forEach((x, i) => {
        results.push(`(${lit(`${p}-r${n}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${num(x.num)}, ${lit(x.cmp ?? null)}, ${lit(x.coded ?? null)})`);
      });
      r.attrs.forEach((a, i) => {
        attrs.push(`(${lit(`${p}-a${n}-${i + 1}`)}, ${lit(qid)}, ${lit(a.system ?? ATTR)}, ${lit(a.code)}, ${lit(a.value)})`);
      });
    },
    setup() {
      return `${FACILITIES}
insert into patients (id, firstname, surname) values ${patients.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id) values ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer) values ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values ${results.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${attrs.join(',\n  ')};`;
    },
  };
}

// The register rows. ZUNMP is in the map but not in the register (no register id), and ZNOMAP is in no map at all: v1's facilities that
// the dictionary does not know (Facility NULL). ZCHO2 is a second code for the same facility name, spelled differently.
const FACILITIES = facilityRows('t22', [
  ['ZCHOM', 'Choma General Hospital', 'Southern', 'Choma'],
  ['ZCHO2', 'CHOMA GENERAL HOSPITAL', 'SOUTHERN', 'CHOMA'],
  ['ZLUSA', 'Chilenje Clinic', 'Lusaka', 'Lusaka'],
  ['ZKITW', 'Kitwe Clinic', 'Copperbelt', 'Kitwe'],
  ['ZNDOL', 'Ndola Clinic', 'Copperbelt', 'Ndola'],
  ['ZMANS', 'Mansa Clinic', 'Luapula', 'Mansa'],
  ['ZUNMP', null, null, null, false],
]);

const fx = makeFixture('t22');
const add = (labId, o) => fx.add(labId, o);

// ---- Lab ZUA (UTH) at ZCHOM: the rules, one request each. Comments give (Registered, Tested, Authorised, Positive) for the group
// (ZUA, ZCHOM), window 2026-05-01 to 2026-05-31. ----

// All four counts; a first name, a surname and an Epid. Decoys: a reference number from another system, and a unique id.
add('T22-M01', {
  results: [POS], patient: ['Mary', 'Banda'],
  attrs: [{ code: 'reference-numbers', value: 'EP-001' }, { code: 'unique-id', value: 'UQ-1' }, { system: 'urn:other', code: 'reference-numbers', value: 'WRONG' }],
}); // 1,1,1,1
// The positive text in another case with trailing spaces (SQL Server ignores both), on another observation code, and no patient row.
add('T22-M02', { results: [{ obs: 'CVGXN', text: 'sars-cov-2 genes detected  ' }] }); // 1,1,1,1
// A negative result on COV68: tested and authorised, not positive.
add('T22-M03', { results: [{ obs: 'COV68', text: 'SARs-Cov-2 Genes Not Detected' }] }); // 1,1,1,0
// A preliminary report: registered and tested, not authorised, so not positive (line 177 wants F).
add('T22-M04', { status: 'preliminary', results: [POS] }); // 1,1,0,0
// No results (the inner join to LabResults, lines 106 and 168): registered only.
add('T22-M05', {}); // 1,0,0,0
// A result with an observation code that is not on the list (line 114): registered only.
add('T22-M06', { results: [{ obs: 'ZZZ99', text: POS_TEXT }] }); // 1,0,0,0
// Registered before the window, analysed and authorised inside it. Tested, Authorised and Positive attach to the group, because the
// group has other registrations in the window; the request itself is not Registered. Observation CO752.
add('T22-M07', {
  auth: '2026-04-20T08:00:00Z', ana: '2026-05-06T08:00:00Z', iss: '2026-05-07T08:00:00Z', results: [{ obs: 'CO752', text: POS_TEXT }],
  patient: ['Peter', 'Lungu'], attrs: [{ code: 'reference-numbers', value: 'EP-007' }],
}); // 0,1,1,1
// Window edges on the registered stamp, local time with +02:00. v1 `between` with dates runs to the end date at 00:00:00.
add('T22-M08', { auth: '2026-05-31T00:00:00+02:00', ana: null, iss: null }); // 1,0,0,0 (midnight of the end date is in; as UTC it is 05-30)
add('T22-M09', { auth: '2026-05-31T00:00:01+02:00', ana: null, iss: null, results: [POS] }); // 0,0,0,0 (one second later is out)
add('T22-M10', { auth: '2026-05-01T00:00:00+02:00', ana: null, iss: null }); // 1,0,0,0 (start date at 00:00:00 is in; as UTC it is 04-30)
add('T22-M11', { auth: '2026-04-30T23:59:59+02:00', ana: null, iss: null }); // 0,0,0,0
// The same edges on the analysis stamp (line 115).
add('T22-M12', { ana: '2026-05-31T00:00:00+02:00', iss: null, results: [NEG] }); // 1,1,0,0
add('T22-M13', { ana: '2026-05-31T00:00:01+02:00', iss: null, results: [NEG] }); // 1,0,0,0
add('T22-M14', { ana: '2026-05-01T00:00:00+02:00', iss: null, results: [NEG] }); // 1,1,0,0
// The same edges on the authorised stamp (line 178).
add('T22-M15', { ana: null, iss: '2026-05-31T00:00:00+02:00', results: [POS] }); // 1,0,1,1
add('T22-M16', { ana: null, iss: '2026-05-31T00:00:01+02:00', results: [POS] }); // 1,0,0,0
add('T22-M17', { ana: null, iss: '2026-05-01T00:00:00+02:00', results: [POS] }); // 1,0,1,1
// One lab number on three request rows (OBR sets), spelled three ways: count(distinct RequestID) under SQL Server's collation is one.
add('T22-M18', { results: [POS], patient: ['Joy', 'Bwalya'] });
add('T22-m18', { results: [POS] });
add('T22-M18 ', { results: [POS] }); // 1,1,1,1 for the three rows together
// One lab number at two facilities: it counts in both groups (T22-M19 at ZLUSA below), and LabStats adds the groups.
add('T22-M19', {}); // 1,0,0,0
// Observation code in another case with a trailing space.
add('T22-M20', { results: [{ obs: 'co752 ', text: POS_TEXT }] }); // 1,1,1,1
// Two positive result rows on one request: counts once, lists twice.
add('T22-M21', { results: [POS, { obs: 'CVGXN', text: POS_TEXT }], patient: [null, 'Zulu'] }); // 1,1,1,1
// Authorised at the first instant of the day after the end date (PListing's window runs to there; the counts' window does not), one
// second after that, and one second before the start.
add('T22-M22', { ana: null, iss: '2026-06-01T00:00:00+02:00', results: [POS] }); // 1,0,0,0
add('T22-M23', { ana: null, iss: '2026-06-01T00:00:01+02:00', results: [POS] }); // 1,0,0,0
add('T22-M24', { ana: null, iss: '2026-04-30T23:59:59+02:00', results: [POS] }); // 1,0,0,0
// The other observation codes: CO751 positive, and a positive that is only a coded value (LIMSRptResult falls back to it).
add('T22-M25', { results: [{ obs: 'CO751', text: POS_TEXT }] }); // 1,1,1,1
add('T22-M26', { results: [{ obs: 'COV2', coded: POS_TEXT }] }); // 1,1,1,1
// Panels. COVII and COVIS count in LabStats (line 53) and not in SourceStats (panel COVID only). COVAB counts nowhere. A panel in another
// case with a trailing space is COVID.
add('T22-P01', { panel: 'COVII', results: [POS] }); // 1,1,1,1 (LabStats only)
add('T22-P02', { panel: 'COVIS', results: [NEG] }); // 1,1,1,0 (LabStats only)
add('T22-P03', { panel: 'COVAB', results: [POS] }); // nothing
add('T22-P04', { panel: 'covid ', results: [POS], patient: ['Ann', 'Moyo'] }); // 1,1,1,1
// Group (ZUA, ZCHOM): COVID 24,13,12,11; with COVII and COVIS 26,15,14,12.

// ---- Other facilities at UTH ----
// ZCHO2: the same facility name as ZCHOM, another code and spelling. A separate group in v1's CTEs; SourceStats' last GROUP BY merges it.
add('T22-F01', { req: 'ZCHO2', results: [POS], patient: ['Ruth', 'Mwale'], attrs: [{ code: 'reference-numbers', value: 'EP-F01' }] }); // 1,1,1,1
// ZCHOM at a third UTH code: registered only. Under 'positive' and 'tested' v1's inner joins drop this reg GROUP (ZUC,ZCHOM), not the
// whole facility, so Choma's Registered is 26 under 'all' and 25 under the other two.
add('T22-G01', { perf: 'ZUC' }); // 1,0,0,0
// ZLUSA: positive but not tested in the window (analysis missing); T22-M19 is registered here too.
add('T22-M19', { req: 'ZLUSA' }); // 1,0,0,0
add('T22-L01', { req: 'ZLUSA', ana: null, results: [POS] }); // 1,0,1,1
// ZKITW: tested and authorised, negative.
add('T22-K01', { req: 'ZKITW', results: [NEG] }); // 1,1,1,0
// ZNDOL: registered only.
add('T22-N01', { req: 'ZNDOL' }); // 1,0,0,0
// ZMANS at two UTH codes: UTH is ZU_ (ZUB) and also 'ZU ' with a blank (SQL Server's LIKE lets one blank fill the underscore).
add('T22-S01', { req: 'ZMANS', perf: 'ZUB', results: [POS] }); // 1,1,1,1
add('T22-S02', { req: 'ZMANS', perf: 'ZU ', results: [POS] }); // 1,1,1,1
// ZMANS at ZUA: registered before the window, tested and authorised inside it. No registration in the window means no group: dropped.
add('T22-S03', { req: 'ZMANS', auth: '2026-04-10T08:00:00Z', results: [POS] }); // 0,1,1,1 and dropped
// Facilities that the dictionary does not know. Registered counts; Tested, Authorised and Positive do not attach (Facility NULL).
add('T22-U01', { req: 'ZUNMP', results: [POS] }); // 1 (code in the map, no register id)
add('T22-U02', { req: 'ZNOMAP', results: [POS] }); // 1 (code in no map)
add('T22-U03', { req: null, results: [POS] }); // 1 (no code)

// ---- The other labs: one request each at ZLUSA unless stated (1,1,1,1) ----
add('T22-D01', { perf: 'ZTT', results: [] }); // ZTT at ZCHOM, registered only: 1,0,0,0
add('T22-D02', { perf: 'ZTV', req: 'ZLUSA', results: [POS] }); // 1,1,1,1
// ZTV at ZCHOM, registered before the window, positive inside it. The registration at ZCHOM is ZTT's, and the lab code is part of the
// join, so this never attaches: 0,1,1,1 and dropped.
add('T22-D03', { perf: 'ZTV', auth: '2026-04-20T08:00:00Z', results: [POS] });
const other = (labId, perf, o = {}) => add(labId, { req: 'ZLUSA', perf, results: [POS], ...o });
other('T22-O01', 'zsp'); // Solwezi General (code in lower case)
other('T22-O02', 'ZAP'); // Arthur Davison
other('T22-O03', 'ZLA'); // Livingstone TH (ZL_)
other('T22-O04', 'zlb '); // Livingstone TH (ZL_, lower case, trailing blank)
other('T22-O05', 'ZBP'); // Kabwe General
other('T22-O06', 'ZMP'); // Lewanika General
other('T22-O07', 'ZML'); // Mansa General
other('T22-O08', 'ZKS'); // Kasama General
other('T22-O09', 'ZCH'); // CHAZ Complex Lab
other('T22-O10', 'ZNP', { patient: ['Esther', 'Daka'] }); // a code that is no CASE branch: it is its own description
other('T22-O11', 'ZU'); // two characters: not ZU_, so its own description
other('T22-O14', 'aaa'); // a lower-case code that passes through: SQL Server's word sort puts it first, byte order last
add('T22-O12', { perf: 'ZNA', req: 'ZCHOM' }); // pass-through, registered only
add('T22-O13', { perf: 'zna ', req: 'ZLUSA' }); // the same lab in another case with a blank: one group
// A blank testing code, a code of blanks, no code and no report: dropped (line 273: len(Lab Description) > 0).
other('T22-X01', '');
other('T22-X02', '   ');
other('T22-X03', null);
other('T22-X04', null, { report: false });

// ---- Expected rows ----

const W = { from: '2026-05-01', to: '2026-05-31' };
const LAB_COLUMNS = ['Lab Description', 'Registered', 'Tested', 'Tested and Authorised', 'Positive'];
const lab = (...v) => Object.fromEntries(LAB_COLUMNS.map((c, i) => [c, v[i]]));
const SOURCE_COLUMNS = ['Province', 'District', 'Facility', 'Registered', 'Tested', 'Tested and Authorised', 'Positive'];
const src = (...v) => Object.fromEntries(SOURCE_COLUMNS.map((c, i) => [c, v[i]]));
const LIST_COLUMNS = ['Province', 'District', 'Facility', 'Epid', 'Lab Number', 'Disalab Number', 'FIRSTNAME', 'SURNAME', 'Sample Collection Date',
  'Tested Date', 'Results Review Date', 'Result', 'Lab Description'];

// COVID-19 by testing lab, window 2026-05-01 to 2026-05-31. One row per Lab Description (LabStats line 262). Sums over the groups
// (lab code, description, requesting code, facility) that have a registration in the window.
//   UTH: (ZUA,ZCHOM) 26,15,14,12 + (ZUA,ZCHO2) 1,1,1,1 + (ZUA,ZLUSA) 2,0,1,1 + (ZUA,ZKITW) 1,1,1,0 + (ZUA,ZNDOL) 1,0,0,0
//        + the three groups of unknown facilities 3,0,0,0 (Registered only) + (ZUB,ZMANS) 1,1,1,1 + ('ZU ',ZMANS) 1,1,1,1
//        = 37, 19, 19, 16. (ZUA,ZMANS) has no registration in the window and adds nothing.
//   TDRC: (ZTT,ZCHOM) 1,0,0,0 + (ZTV,ZLUSA) 1,1,1,1 = 2,1,1,1. (ZTV,ZCHOM) has no registration and ZTT's does not match its lab code.
//   Livingstone TH: ZLA and 'zlb ' = 2,2,2,2. ZNA: two registrations, no tests: Tested, Authorised and Positive are NULL (sum of nothing).
const LAB_ROWS = [
  lab('UTH', 37, 19, 19, 16),
  lab('TDRC', 2, 1, 1, 1),
  lab('Solwezi General', 1, 1, 1, 1),
  lab('Arthur Davison', 1, 1, 1, 1),
  lab('Livingstone TH', 2, 2, 2, 2),
  lab('Kabwe General', 1, 1, 1, 1),
  lab('Lewanika General', 1, 1, 1, 1),
  lab('Mansa General', 1, 1, 1, 1),
  lab('Kasama General', 1, 1, 1, 1),
  lab('CHAZ Complex Lab', 1, 1, 1, 1),
  lab('ZNP', 1, 1, 1, 1),
  lab('ZU', 1, 1, 1, 1),
  lab('ZNA', 2, null, null, null),
  lab('aaa', 1, 1, 1, 1),
];
// SQL Server's word order, case ignored: aaa, Arthur, CHAZ, Kabwe, Kasama, Lewanika, Livingstone, Mansa, Solwezi, TDRC, UTH, ZNA, ZNP, ZU.
const LAB_ROWS_ORDERED = [
  lab('aaa', 1, 1, 1, 1), lab('Arthur Davison', 1, 1, 1, 1), lab('CHAZ Complex Lab', 1, 1, 1, 1), lab('Kabwe General', 1, 1, 1, 1), lab('Kasama General', 1, 1, 1, 1),
  lab('Lewanika General', 1, 1, 1, 1), lab('Livingstone TH', 2, 2, 2, 2), lab('Mansa General', 1, 1, 1, 1), lab('Solwezi General', 1, 1, 1, 1),
  lab('TDRC', 2, 1, 1, 1), lab('UTH', 37, 19, 19, 16), lab('ZNA', 2, null, null, null), lab('ZNP', 1, 1, 1, 1), lab('ZU', 1, 1, 1, 1),
];

// COVID-19 by source facility for UTH, panel COVID only (COVII and COVIS out), window 2026-05-01 to 2026-05-31. The facility groups merge on
// the name: ZCHOM and ZCHO2 are one row, shown in the smaller spelling (upper case sorts first in byte order).
//   Choma: (ZUA,ZCHOM) 24,13,12,11 + (ZUA,ZCHO2) 1,1,1,1 = 25,14,13,12; plus the registered-only group (ZUC,ZCHOM) 1,0,0,0 under 'all' = 26,14,13,12.
//   Lusaka: (ZUA,ZLUSA) 2,0,1,1 (positive and not tested). Kitwe 1,1,1,0 (tested, not positive). Ndola 1,0,0,0.
//   Mansa: (ZUB,ZMANS) 1,1,1,1 + ('ZU ',ZMANS) 1,1,1,1 = 2,2,2,2.
//   Unknown facilities: 3 registered, Tested, Authorised and Positive 0 (line 258: coalesce).
const UNKNOWN = src(null, null, null, 3, 0, 0, 0);
const KITWE = src('Copperbelt', 'Kitwe', 'Kitwe Clinic', 1, 1, 1, 0);
const NDOLA = src('Copperbelt', 'Ndola', 'Ndola Clinic', 1, 0, 0, 0);
const MANSA = src('Luapula', 'Mansa', 'Mansa Clinic', 2, 2, 2, 2);
const LUSAKA = src('Lusaka', 'Lusaka', 'Chilenje Clinic', 2, 0, 1, 1);
const CHOMA = src('SOUTHERN', 'CHOMA', 'CHOMA GENERAL HOSPITAL', 25, 14, 13, 12);
const CHOMA_ALLGROUPS = src('SOUTHERN', 'CHOMA', 'CHOMA GENERAL HOSPITAL', 26, 14, 13, 12);
// Order: province in word order (a missing one first): Copperbelt, Luapula, Lusaka, SOUTHERN.
const UTH_ORDERED = [UNKNOWN, KITWE, NDOLA, MANSA, LUSAKA, CHOMA_ALLGROUPS];

// The positive list for UTH at Choma General Hospital, 2026-05-01 to 2026-05-31: the day after the end date at 00:00:00 is the end.
const D = { collected: '2026-05-09T07:00:00Z', tested: '2026-05-11T08:00:00Z', reviewed: '2026-05-12T08:00:00Z' };
const listRow = (o) => {
  const r = { province: 'Southern', district: 'Choma', facility: 'Choma General Hospital', epid: null, labId: null, first: null, last: null, ...D, lab: 'UTH', ...o };
  return Object.fromEntries(LIST_COLUMNS.map((c, i) => [c, [r.province, r.district, r.facility, r.epid, null, r.labId, r.first, r.last,
    r.collected, r.tested, r.reviewed, 'Positive', r.lab][i]]));
};
const CHOMA_LIST = {
  m01: listRow({ labId: 'T22-M01', first: 'Mary', last: 'Banda', epid: 'EP-001' }),
  m02: listRow({ labId: 'T22-M02' }),
  m07: listRow({ labId: 'T22-M07', first: 'Peter', last: 'Lungu', epid: 'EP-007', tested: '2026-05-06T08:00:00Z', reviewed: '2026-05-07T08:00:00Z' }),
  m15: listRow({ labId: 'T22-M15', tested: null, reviewed: '2026-05-31T00:00:00+02:00' }),
  m16: listRow({ labId: 'T22-M16', tested: null, reviewed: '2026-05-31T00:00:01+02:00' }),
  m17: listRow({ labId: 'T22-M17', tested: null, reviewed: '2026-05-01T00:00:00+02:00' }),
  m18a: listRow({ labId: 'T22-M18', first: 'Joy', last: 'Bwalya' }),
  m18b: listRow({ labId: 'T22-m18' }),
  m18c: listRow({ labId: 'T22-M18 ' }),
  m20: listRow({ labId: 'T22-M20' }),
  m21: listRow({ labId: 'T22-M21', last: 'Zulu' }),
  m22: listRow({ labId: 'T22-M22', tested: null, reviewed: '2026-06-01T00:00:00+02:00' }),
  m25: listRow({ labId: 'T22-M25' }),
  m26: listRow({ labId: 'T22-M26' }),
  p04: listRow({ labId: 'T22-P04', first: 'Ann', last: 'Moyo' }),
  f01: listRow({ labId: 'T22-F01', first: 'Ruth', last: 'Mwale', epid: 'EP-F01', province: 'SOUTHERN', district: 'CHOMA', facility: 'CHOMA GENERAL HOSPITAL' }),
};
const C = CHOMA_LIST;
// Not in the list: M03 (negative), M04 (preliminary), M05 and M06 (no result or a code off the list), M09, M12 to M14 (no authorised stamp),
// M23 (a second after the window), M24 (a second before it), P01, P02 (other panels), P03.
const CHOMA_ALL = [C.m01, C.m02, C.m07, C.m15, C.m16, C.m17, C.m18a, C.m18b, C.m18c, C.m20, C.m21, C.m21, C.m22, C.m25, C.m26, C.p04, C.f01];
// F01 comes first: 'SOUTHERN' and 'Southern' are one word-sort key and then byte order puts the capitals first. The rows with no Epid come
// next, by lab number (T22-M18 and 'T22-M18 ' and T22-m18 tie on the word sort; byte order puts the shorter, then the capital, first), then EP-001 and EP-007.
const CHOMA_ORDERED = [C.f01, C.m02, C.m15, C.m16, C.m17, C.m18a, C.m18c, C.m18b, C.m20, C.m21, C.m21, C.m22, C.m25, C.m26, C.p04, C.m01, C.m07];

// ---- Suites ----

// A suite over the exact rows (a row appearing twice must appear twice), the column order and the column count.
function setSuite(name, queryName, params, columns, wanted, setup = '') {
  const q = query(queryName);
  const key = (r) => JSON.stringify(columns.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `select ${lit(name)} || chr(9) || row_to_json(q)::text from (${q ? bind(q.sql, params) : 'select 1'}) q;`,
    count: wanted.length + 1,
    check(got) {
      if (!q) return [`query "${queryName}" is missing`];
      const failures = [];
      if (got.length !== wanted.length) failures.push(`expected ${wanted.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), columns));
        if (Object.keys(got[0]).length !== columns.length) failures.push(`expected ${columns.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const left = wanted.map(key);
      for (const h of got.map(key)) {
        const i = left.indexOf(h);
        if (i < 0) failures.push(`unexpected row ${h}`); else left.splice(i, 1);
      }
      for (const w of left) failures.push(`missing row ${w}`);
      return failures;
    },
  };
}
const ordered = (name, queryName, params, columns, wanted) => orderedSuite(name, query(queryName)?.sql ?? 'select 1', params, columns, wanted);

const BANNED = /--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i;
// The declared shape: parameter ids, types and required flags; a plain SELECT; and a total ORDER BY (CE pages with LIMIT and OFFSET). The
// needles are the column expressions in output order; each must appear after the last ORDER BY, in that order.
function shapeSuite(name, queryName, wantParams, needles) {
  return {
    name,
    count: 6,
    check() {
      const q = query(queryName);
      if (!q) return [`query "${queryName}" is missing`];
      const bad = [];
      const got = q.params.map((p) => `${p.id}:${p.type}:${p.required}`);
      const want = wantParams.map(([id, type, required]) => `${id}:${type}:${required}`);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`params: expected ${want}; got ${got}`);
      if (BANNED.test(q.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (!/^\s*with\b/i.test(q.sql)) bad.push('does not start with "with"');
      for (const [id] of wantParams) if (!q.sql.includes(`{{param.${id}}}`)) bad.push(`must use the parameter ${id}`);
      const at = q.sql.lastIndexOf('order by');
      if (at < 0) bad.push('must end with an ORDER BY');
      else {
        let pos = at;
        for (const n of needles) {
          const i = q.sql.indexOf(n, pos);
          if (i < 0) { bad.push(`ORDER BY must list ${n}, after the column before it`); break; }
          pos = i + n.length;
        }
      }
      return bad;
    },
  };
}

const optionsSuite = {
  name: 'show-options',
  count: 2,
  sql: `select 'show-options' || chr(9) || json_build_object('v', q.v)::text from (${query(SOURCE_STATS)?.params.find((p) => p.id === 'show')?.optionsSql ?? 'select 1'}) as q(v);`,
  check(rows) {
    const got = rows.map((r) => r.v);
    return JSON.stringify(got) === JSON.stringify(['all', 'tested', 'positive']) ? [] : [`expected ["all","tested","positive"], got ${JSON.stringify(got)}`];
  },
};

const DATE_PARAMS = [['from', 'text', true], ['to', 'text', true]];
const LIST_PARAMS = (extra) => ({ ...W, ...extra });
const listSuite = (name, params, wanted) => setSuite(name, POSITIVE_LIST, params, LIST_COLUMNS, wanted);

const suites = [
  // ---- COVID-19 by testing lab ----
  setSuite('lab-stats', LAB_STATS, W, LAB_COLUMNS, LAB_ROWS, fx.setup()),
  ordered('lab-stats-order', LAB_STATS, W, LAB_COLUMNS, LAB_ROWS_ORDERED),
  // One day: only what happened at exactly midnight (line 54: a date is midnight). The end date at 00:00:00 holds M08 (registered), M12
  // (analysed) and M15 (authorised and positive), all in the group (ZUA,ZCHOM), which has the registration. M09, M13 and M16 are a second later.
  setSuite('lab-stats-last-day', LAB_STATS, { from: '2026-05-31', to: '2026-05-31' }, LAB_COLUMNS, [lab('UTH', 1, 1, 1, 1)]),
  // The start date at 00:00:00: M10 (registered), M14 (analysed), M17 (authorised and positive). M11, the second before, is out.
  setSuite('lab-stats-first-day', LAB_STATS, { from: '2026-05-01', to: '2026-05-01' }, LAB_COLUMNS, [lab('UTH', 1, 1, 1, 1)]),
  setSuite('lab-stats-empty', LAB_STATS, { from: '2030-01-01', to: '2030-12-31' }, LAB_COLUMNS, []),
  shapeSuite('lab-stats-shape', LAB_STATS, DATE_PARAMS, ['res.lab_desc', 'res.registered', 'res.tested', 'res.authorised', 'res.positive']),

  // ---- COVID-19 by source facility ----
  // The lab is a Lab Description, compared as SQL Server compares text: 'uth ' finds UTH. Blank `show` is all (sp_COV2_SourceStats).
  setSuite('source-uth-blank', SOURCE_STATS, { ...W, laboratory: 'uth ', show: '' }, SOURCE_COLUMNS, [UNKNOWN, KITWE, NDOLA, MANSA, LUSAKA, CHOMA_ALLGROUPS]),
  setSuite('source-uth-all', SOURCE_STATS, { ...W, laboratory: 'UTH', show: 'all' }, SOURCE_COLUMNS, [UNKNOWN, KITWE, NDOLA, MANSA, LUSAKA, CHOMA_ALLGROUPS]),
  // sp_COV2_PSources: `inner join pos` (line 274): facilities with a Positive count. Lusaka is positive and not tested; Kitwe is tested and not positive.
  setSuite('source-uth-positive', SOURCE_STATS, { ...W, laboratory: 'UTH', show: 'positive' }, SOURCE_COLUMNS, [MANSA, LUSAKA, CHOMA]),
  // sp_COV2_TSources: `inner join tested` as well (line 268): a Tested and a Positive count. Lusaka (no tests) and Kitwe (no positives) are out.
  setSuite('source-uth-tested', SOURCE_STATS, { ...W, laboratory: 'UTH', show: 'tested' }, SOURCE_COLUMNS, [MANSA, CHOMA]),
  ordered('source-uth-order', SOURCE_STATS, { ...W, laboratory: 'UTH', show: '' }, SOURCE_COLUMNS, UTH_ORDERED),
  // TDRC: ZTT registered at Choma, ZTV positive at Lusaka; ZTV's test at Choma never attaches to ZTT's registration.
  setSuite('source-tdrc', SOURCE_STATS, { ...W, laboratory: 'tdrc', show: 'all' }, SOURCE_COLUMNS,
    [src('Southern', 'Choma', 'Choma General Hospital', 1, 0, 0, 0), src('Lusaka', 'Lusaka', 'Chilenje Clinic', 1, 1, 1, 1)]),
  setSuite('source-tdrc-positive', SOURCE_STATS, { ...W, laboratory: 'TDRC', show: 'positive' }, SOURCE_COLUMNS, [src('Lusaka', 'Lusaka', 'Chilenje Clinic', 1, 1, 1, 1)]),
  setSuite('source-tdrc-tested', SOURCE_STATS, { ...W, laboratory: 'TDRC', show: 'tested' }, SOURCE_COLUMNS, [src('Lusaka', 'Lusaka', 'Chilenje Clinic', 1, 1, 1, 1)]),
  // A description that is a lab code: ZNA and 'zna ' are one lab. Registered only, so the counts are 0, and 'positive' and 'tested' find nothing.
  setSuite('source-zna', SOURCE_STATS, { ...W, laboratory: 'zna', show: 'all' }, SOURCE_COLUMNS,
    [src('Southern', 'Choma', 'Choma General Hospital', 1, 0, 0, 0), src('Lusaka', 'Lusaka', 'Chilenje Clinic', 1, 0, 0, 0)]),
  setSuite('source-zna-positive', SOURCE_STATS, { ...W, laboratory: 'zna', show: 'positive' }, SOURCE_COLUMNS, []),
  setSuite('source-zna-tested', SOURCE_STATS, { ...W, laboratory: 'zna', show: 'tested' }, SOURCE_COLUMNS, []),
  // Two codes, one description: ZLA and 'zlb ' are Livingstone TH.
  setSuite('source-livingstone', SOURCE_STATS, { ...W, laboratory: 'Livingstone TH', show: 'positive' }, SOURCE_COLUMNS, [src('Lusaka', 'Lusaka', 'Chilenje Clinic', 2, 2, 2, 2)]),
  // 'ZU' (two characters) is its own lab.
  setSuite('source-zu', SOURCE_STATS, { ...W, laboratory: 'ZU', show: 'all' }, SOURCE_COLUMNS, [src('Lusaka', 'Lusaka', 'Chilenje Clinic', 1, 1, 1, 1)]),
  // The text of a code finds nothing when the description differs: ZUA is UTH.
  setSuite('source-code-not-description', SOURCE_STATS, { ...W, laboratory: 'ZUA', show: 'all' }, SOURCE_COLUMNS, []),
  setSuite('source-blank-lab', SOURCE_STATS, { ...W, laboratory: '', show: 'all' }, SOURCE_COLUMNS, []),
  setSuite('source-last-day', SOURCE_STATS, { from: '2026-05-31', to: '2026-05-31', laboratory: 'UTH', show: 'all' }, SOURCE_COLUMNS,
    [src('Southern', 'Choma', 'Choma General Hospital', 1, 1, 1, 1)]),
  setSuite('source-empty', SOURCE_STATS, { from: '2030-01-01', to: '2030-12-31', laboratory: 'UTH', show: 'all' }, SOURCE_COLUMNS, []),
  shapeSuite('source-shape', SOURCE_STATS, [['from', 'text', true], ['to', 'text', true], ['laboratory', 'text', true], ['show', 'select', false]],
    ['res.province', 'res.district', 'res.facility', 'res.registered', 'res.tested', 'res.authorised', 'res.positive']),
  optionsSuite,

  // ---- COVID-19 positive patients ----
  // Facility matched on the name ignoring case and trailing spaces: 'choma general hospital ' finds ZCHOM and ZCHO2 (one name in v1).
  listSuite('list-choma', LIST_PARAMS({ laboratory: 'uth', facility: 'choma general hospital ' }), CHOMA_ALL),
  ordered('list-choma-order', POSITIVE_LIST, LIST_PARAMS({ laboratory: 'UTH', facility: 'Choma General Hospital' }), LIST_COLUMNS, CHOMA_ORDERED),
  // The window runs to the day AFTER the end date at 00:00:00 (line 22): M15 (05-31 00:00:00), M16 (05-31 00:00:01) and M22 (06-01 00:00:00)
  // are in, M23 (06-01 00:00:01) is out.
  listSuite('list-last-day', { from: '2026-05-31', to: '2026-05-31', laboratory: 'UTH', facility: 'Choma General Hospital' }, [C.m15, C.m16, C.m22]),
  ordered('list-last-day-order', POSITIVE_LIST, { from: '2026-05-31', to: '2026-05-31', laboratory: 'UTH', facility: 'Choma General Hospital' }, LIST_COLUMNS, [C.m15, C.m16, C.m22]),
  // The start date at 00:00:00 is in (M17); the second before it is out (M24).
  listSuite('list-first-day', { from: '2026-05-01', to: '2026-05-01', laboratory: 'UTH', facility: 'Choma General Hospital' }, [C.m17]),
  // No registration condition: the request registered before the window (S03, ZUA at Mansa Clinic) is listed with the two others.
  listSuite('list-mansa', LIST_PARAMS({ laboratory: 'UTH', facility: 'Mansa Clinic' }), [
    listRow({ province: 'Luapula', district: 'Mansa', facility: 'Mansa Clinic', labId: 'T22-S01' }),
    listRow({ province: 'Luapula', district: 'Mansa', facility: 'Mansa Clinic', labId: 'T22-S02' }),
    listRow({ province: 'Luapula', district: 'Mansa', facility: 'Mansa Clinic', labId: 'T22-S03' }),
  ]),
  // Positive and not tested (no Tested Date).
  listSuite('list-lusaka', LIST_PARAMS({ laboratory: 'UTH', facility: 'Chilenje Clinic' }), [
    listRow({ province: 'Lusaka', district: 'Lusaka', facility: 'Chilenje Clinic', labId: 'T22-L01', tested: null }),
  ]),
  // A description that is a code is its own Lab Description.
  listSuite('list-znp', LIST_PARAMS({ laboratory: 'ZNP', facility: 'Chilenje Clinic' }), [
    listRow({ province: 'Lusaka', district: 'Lusaka', facility: 'Chilenje Clinic', labId: 'T22-O10', first: 'Esther', last: 'Daka', lab: 'ZNP' }),
  ]),
  // Two TDRC codes: ZTV at Lusaka, and ZTV at Choma (registered before the window; the list does not need a registration).
  listSuite('list-tdrc-lusaka', LIST_PARAMS({ laboratory: 'TDRC', facility: 'Chilenje Clinic' }), [
    listRow({ province: 'Lusaka', district: 'Lusaka', facility: 'Chilenje Clinic', labId: 'T22-D02', lab: 'TDRC' }),
  ]),
  listSuite('list-tdrc-choma', LIST_PARAMS({ laboratory: 'TDRC', facility: 'Choma General Hospital' }), [listRow({ labId: 'T22-D03', lab: 'TDRC' })]),
  // A facility the register does not map (Facility NULL) matches no facility text, not even a blank one. The lab description is not a code.
  listSuite('list-unknown-facility', LIST_PARAMS({ laboratory: 'UTH', facility: '' }), []),
  // A blank lab matches no lab (line 83: len(Lab Description) > 0), though the blank-code reports at Chilenje Clinic are positive and final.
  listSuite('list-blank-lab', LIST_PARAMS({ laboratory: '', facility: 'Chilenje Clinic' }), []),
  listSuite('list-wrong-lab-code', LIST_PARAMS({ laboratory: 'ZUA', facility: 'Choma General Hospital' }), []),
  listSuite('list-wrong-facility', LIST_PARAMS({ laboratory: 'UTH', facility: 'Nowhere Clinic' }), []),
  listSuite('list-empty-window', { from: '2030-01-01', to: '2030-12-31', laboratory: 'UTH', facility: 'Choma General Hospital' }, []),
  shapeSuite('list-shape', POSITIVE_LIST, [['from', 'text', true], ['to', 'text', true], ['laboratory', 'text', true], ['facility', 'text', true]],
    ['s.province', 's.district', 's.facility', 's.epid', 's.lab_id', 's.firstname', 's.surname', 's.collected', 's.tested_date', 's.reviewed', 's.lab_desc']),
];


// ============================================================================================================================
// Group t23: COVID-19 daily line list (sp_cov_getDayLineList, with sp_cov_getDayLineList_Levy merged in as the `version` parameter) and
// COVID-19 daily positivity (sp_dash_covid_7d_moving_avg). Fixture ids start with "t23-"; lab numbers start with "T23-".
// "v1 line N" means a line of StoredProcedure__dbo_sp_cov_getDayLineList.sql (the target) unless a case names the Levy file or the
// moving average file. v1 ran a fixed window, yesterday 04:00 to today 04:00; the port takes `from` and `to` as YYYY-MM-DDTHH:MM, local
// time. Each case family has its own day, so one suite reads one family and the expected rows stay short.
// ============================================================================================================================

const LINE_LIST = 'COVID-19 daily line list';
const POSITIVITY = 'COVID-19 daily positivity';
const LINE_COLUMNS = ['Epid', 'Lab Number', 'Disalab Number', 'Patient Name', 'Contact Number', 'Gender', 'AgeinYears', 'Collected Date', 'Registered Date',
  'Province', 'District', 'Location', 'Tested Date', 'Date Result Reported', 'Result', 'Instrument', 'Testing Laboratory', 'TestType', 'Authorization Status',
  'Sore Throat', 'Fever', 'Shortness of Breath', 'Body Pains', 'Other(Specified)', 'Hospitalised', 'Outcome'];
const SX_COLUMNS = ['Sore Throat', 'Fever', 'Shortness of Breath', 'Body Pains', 'Other(Specified)', 'Hospitalised', 'Outcome'];
const POS_COLUMNS = ['TestDate', 'Tests', 'Positive', 'Positivity Rate', 'Svn_d_moving_average'];

// The stamps of a request on `day`, all inside the window day 04:00 to day+1 04:00, local time with +02:00 as DISA writes it.
const stampsOf = (day) => ({ eff: `${day}T08:00:00+02:00`, auth: `${day}T09:00:00+02:00`, ana: `${day}T20:00:00+02:00`, iss: `${day}T22:00:00+02:00` });
const nextDay = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
const dayWindow = (day) => ({ from: `${day}T04:00`, to: `${nextDay(day)}T04:00` });

// What one request holds unless a case says otherwise: panel COVID at ZCHOM, tested at lab ZUA on a GeneXpert, a patient with a phone and a
// reference number, one positive COV2 result, a final report.
const DEF23 = {
  panel: 'COVID', req: 'ZCHOM', perf: 'ZUA', analyzer: 'GENEX', age: 30, status: 'final', report: true,
  patient: ['Mary', 'Banda', 'F', '0977000001'], patientId: null, attrs: [{ code: 'reference-numbers', value: 'EP-100' }],
  results: [{ obs: 'COV2', text: 'SARS-Cov-2 Genes Detected' }],
};

function makeFixture23() {
  const patients = [];
  const requests = [];
  const reports = [];
  const results = [];
  const attrs = [];
  let n = 0;
  return {
    // One lab_requests row. `o.day` sets the four stamps; `o` overrides anything. `patient` is [first, last, sex, phone] or null;
    // `patientId` points at a patient row that does not exist.
    add(labId, o = {}) {
      const r = { ...DEF23, ...(o.day ? stampsOf(o.day) : {}), ...o };
      n += 1;
      const qid = `t23-q${n}`;
      let patientId = r.patientId;
      if (r.patient) {
        patientId = `t23-p${n}`;
        patients.push(`(${lit(patientId)}, ${lit(r.patient[0])}, ${lit(r.patient[1])}, ${lit(r.patient[2])}, ${lit(r.patient[3])})`);
      }
      requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.auth)}, ${lit(r.ana)}, ${lit(r.req)}, ${lit(patientId)}, ${num(r.age)}, ${lit(r.analyzer)})`);
      if (r.report) reports.push(`(${lit(`t23-d${n}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.eff)}, ${lit(r.iss)}, ${lit(r.perf)})`);
      r.results.forEach((x, i) => {
        results.push(`(${lit(`t23-r${n}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${num(x.num)}, ${lit(x.cmp ?? null)}, ${lit(x.coded ?? null)})`);
      });
      r.attrs.forEach((a, i) => {
        attrs.push(`(${lit(`t23-a${n}-${i + 1}`)}, ${lit(qid)}, ${lit(a.system ?? ATTR)}, ${lit(a.code)}, ${lit(a.value)})`);
      });
    },
    setup() {
      return `${FACILITIES23}
insert into patients (id, firstname, surname, sex, phone) values ${patients.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years, analyzer_code) values ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer) values ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values ${results.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text) values ${attrs.join(',\n  ')};`;
    },
  };
}

// The register rows. 'lvcvd ' is the same facility spelled in lower case with a blank, mapped on its own so the facility filter is what is
// tested, not the join (the join compares the code as it is). ZUNMP is in the map without a register id; ZNOMAP and a missing code are in no map.
const FACILITIES23 = facilityRows('t23', [
  ['ZCHOM', 'Choma General Hospital', 'Southern', 'Choma'],
  ['LVCVD', 'Levy Mwanawasa Hospital', 'Lusaka', 'Lusaka'],
  ['LPMGH', 'Levy Mwanawasa Annex', 'Lusaka', 'Lusaka'],
  ['lvcvd ', 'Levy Mwanawasa Hospital', 'Lusaka', 'Lusaka'],
  ['ZLUSA', 'Chilenje Clinic', 'Lusaka', 'Lusaka'],
  ['ZUNMP', null, null, null, false],
]);
const FAC23 = {
  ZCHOM: ['Southern', 'Choma', 'Choma General Hospital'],
  LVCVD: ['Lusaka', 'Lusaka', 'Levy Mwanawasa Hospital'],
  LPMGH: ['Lusaka', 'Lusaka', 'Levy Mwanawasa Annex'],
  ZLUSA: ['Lusaka', 'Lusaka', 'Chilenje Clinic'],
  none: [null, null, null],
};

const L23 = makeFixture23();
const add23 = (labId, o) => L23.add(labId, o);
const pad2 = (i) => String(i + 1).padStart(2, '0');

// The expected row of a request on `day` that holds the defaults above; `o` changes the columns a case changes. Keys: epid, id (Disalab
// Number), name, contact, gender, age, collected, registered, fac (a key of FAC23), tested, reported, result, instrument, testLab, type, status,
// sx (the seven symptom answers in column order).
function line(labId, day, o = {}) {
  const s = stampsOf(day);
  const r = {
    epid: 'EP-100', id: labId, name: 'Mary Banda', contact: '0977000001', gender: 'Female', age: 30, collected: s.eff, registered: s.auth, fac: 'ZCHOM',
    tested: s.ana, reported: s.iss, result: 'Positive', instrument: 'GeneXpert', testLab: 'University Teaching Hospital', type: 'PCR Based',
    status: 'Reviewed', sx: [], ...o,
  };
  const [province, district, location] = FAC23[r.fac];
  const sx = SX_COLUMNS.map((_, i) => r.sx[i] ?? null);
  const values = [r.epid, null, r.id, r.name, r.contact, r.gender, r.age, r.collected, r.registered, province, district, location, r.tested, r.reported,
    r.result, r.instrument, r.testLab, r.type, r.status, ...sx];
  return Object.fromEntries(LINE_COLUMNS.map((c, i) => [c, values[i]]));
}

// ---- Family 1: the Result map (day 2026-05-11). One request each at LVCVD, so Levy lists them too. v1 lines 110-126 (target); the Levy file
// lacks 'IgM/IgG Negative', 'IgM Negative' (target lines 112-113) and 'INVAL', 'Invalid' (lines 122-123). [stored result, standard, Levy]. ----
const MAP_DAY = '2026-05-11';
const RESULT_MAP = [
  [{ text: 'SARS-Cov-2 Genes Not Detected' }, 'Negative', 'Negative'], // line 111
  [{ text: 'IgM/IgG Negative' }, 'Negative', null], // line 112, target only
  [{ text: 'IgM Negative' }, 'Negative', null], // line 113, target only
  [{ text: 'Negative' }, 'Negative', 'Negative'], // line 114
  [{ text: 'SARS-Cov-2 Genes Detected' }, 'Positive', 'Positive'], // line 115
  [{ text: 'IgG Positive' }, 'Positive', 'Positive'], // line 116
  [{ text: 'IgM Positive' }, 'Positive', 'Positive'], // line 117
  [{ text: 'IgM/IgG Positive' }, 'Positive', 'Positive'], // line 118
  [{ text: 'Positive' }, 'Positive', 'Positive'], // line 119
  // Line 120 reads 'Inconclusive' with an acute accent on the I (U+00CD, an escape here): a typo that is v1's text. The accent counts (Latin1_General_CI_AS is accent
  // sensitive), the case does not.
  [{ text: '\u00cdnconclusive' }, 'To be retested', 'To be retested'],
  [{ text: 'No AFB seen.' }, 'To be retested', 'To be retested'], // line 121
  [{ text: 'INVAL' }, 'To be retested', null], // line 122, target only
  [{ text: 'Invalid' }, 'To be retested', null], // line 123, target only
  // The CASE has no ELSE (lines 110-126): a text that is not listed gives NULL. The plain 'Inconclusive' is the typo's correct spelling and is
  // not listed; 'Not Detected' and 'Detected' are not listed either; an empty text and a missing text give NULL.
  [{ text: 'Inconclusive' }, null, null],
  [{ text: 'Not Detected' }, null, null],
  [{ text: 'Detected' }, null, null],
  [{ text: '' }, null, null],
  [{ text: null }, null, null],
  // SQL Server compares ignoring case and trailing spaces, on every listed text (target-only texts too).
  [{ text: 'POSITIVE' }, 'Positive', 'Positive'],
  [{ text: 'negative   ' }, 'Negative', 'Negative'],
  [{ text: 'sars-cov-2 genes detected' }, 'Positive', 'Positive'],
  [{ text: 'SARS-COV-2 GENES NOT DETECTED ' }, 'Negative', 'Negative'],
  [{ text: 'igm/igg positive ' }, 'Positive', 'Positive'],
  [{ text: '\u00cdNCONCLUSIVE ' }, 'To be retested', 'To be retested'],
  [{ text: '\u00edncOnclusive' }, 'To be retested', 'To be retested'],
  [{ text: 'no afb seen. ' }, 'To be retested', 'To be retested'],
  [{ text: 'igm/igg negative ' }, 'Negative', null],
  [{ text: 'IGM NEGATIVE' }, 'Negative', null],
  [{ text: 'inval ' }, 'To be retested', null],
  [{ text: 'INVALID' }, 'To be retested', null],
  // LIMSRptResult is the text, else the number, else the coded value (rpt): a coded-only result maps, a number never does.
  [{ coded: 'Positive' }, 'Positive', 'Positive'],
  [{ coded: 'Invalid' }, 'To be retested', null],
  [{ num: 20, cmp: '<' }, null, null],
];
const mapStd = [];
const mapLevy = [];
RESULT_MAP.forEach(([stored, std, levy], i) => {
  const id = `T23-R${pad2(i)}`;
  add23(id, { day: MAP_DAY, req: 'LVCVD', results: [{ obs: 'COV2', ...stored }] });
  mapStd.push(line(id, MAP_DAY, { fac: 'LVCVD', result: std }));
  mapLevy.push(line(id, MAP_DAY, { fac: 'LVCVD', result: levy }));
});

// ---- Family 2: the window edges (day 2026-06-01; window 2026-06-01T04:00 to 2026-06-02T04:00, both ends in). All at LVCVD. ----
// The target windows on AuthorisedDateTime (v1 line 221), Levy on AnalysisDateTime (Levy line 217). Both run `between`, so both ends are in.
// The stamp's local wall time counts, not UTC: '2026-06-02T05:00:00+02:00' is 03:00 in UTC and still out.
// [id, issued, analysed, in the standard run, in the Levy run]
const EDGE_DAY = '2026-06-01';
const EDGES = [
  ['E01', '2026-06-01T04:00:00+02:00', '2026-05-31T20:00:00+02:00', true, false], // the start edge on issued (in UTC it is 02:00 and out)
  ['E02', '2026-06-01T03:59:59+02:00', '2026-06-01T04:00:00+02:00', false, true], // a second before the start / the start edge on analysed
  ['E03', '2026-06-02T04:00:00+02:00', '2026-06-02T04:00:01+02:00', true, false], // the end edge on issued, a second after on analysed
  ['E04', '2026-06-02T04:00:01+02:00', '2026-06-02T04:00:00+02:00', false, true],
  ['E05', '2026-06-02T05:00:00+02:00', '2026-06-01T03:00:00+02:00', false, false], // in UTC the issued stamp is 03:00 and in
  ['E06', '2026-06-01T05:30:00+02:00', '2026-06-02T05:30:00+02:00', true, false], // in UTC the analysed stamp is 03:30 and in
  ['E07', '2026-06-02T03:59:00Z', '2026-06-01T06:00:00Z', true, true], // a Z stamp counts at its own wall time
  ['E08', '2026-06-02', '2026-06-01', true, false], // a date only is midnight: 06-02 00:00 is inside, 06-01 00:00 is before the start
  ['E09', '2026-06', '2026-06', false, false], // a partial stamp is outside
  ['E10', null, null, false, false],
  ['E13', '2026-06-01T04:00:00', '2026-06-02T04:00:00', true, true], // no offset at all: the same wall time
];
const edgeStd = [];
const edgeLevy = [];
for (const [id, iss, ana, inStd, inLevy] of EDGES) {
  const labId = `T23-${id}`;
  add23(labId, { day: EDGE_DAY, req: 'LVCVD', iss, ana });
  const row = line(labId, EDGE_DAY, { fac: 'LVCVD', reported: iss, tested: ana, status: iss === null ? 'Pending Review' : 'Reviewed' });
  if (inStd) edgeStd.push(row);
  if (inLevy) edgeLevy.push(row);
}
// A report with no issued stamp: not authorised. Standard drops it (the window needs the stamp); Levy lists it as 'Pending Review' (v1 lines 194-196).
add23('T23-E11', { day: EDGE_DAY, req: 'LVCVD', iss: null, ana: '2026-06-01T12:00:00+02:00' });
edgeLevy.push(line('T23-E11', EDGE_DAY, { fac: 'LVCVD', reported: null, tested: '2026-06-01T12:00:00+02:00', status: 'Pending Review' }));
// A request with no report at all. CE holds the collection stamp, the testing lab and the issued stamp on the report, so they are empty;
// the analyser is on the request and stays.
add23('T23-E12', { day: EDGE_DAY, req: 'LVCVD', report: false, ana: '2026-06-01T13:00:00+02:00' });
edgeLevy.push(line('T23-E12', EDGE_DAY, { fac: 'LVCVD', reported: null, collected: null, tested: '2026-06-01T13:00:00+02:00', testLab: null, status: 'Pending Review' }));
const E = (id, rows) => rows.find((r) => r['Disalab Number'] === `T23-${id}`);
// Standard order: Date Result Reported, newest first (line 222). E01 and E13 tie on the wall time 04:00:00; the next keys decide (the lab number).
const EDGE_STD_ORDER = ['E03', 'E07', 'E08', 'E06', 'E01', 'E13'].map((id) => E(id, edgeStd));
// Levy order: Tested Date, newest first (Levy line 217). E04 and E13 tie on 04:00:00.
const EDGE_LEVY_ORDER = ['E04', 'E13', 'E12', 'E11', 'E07', 'E02'].map((id) => E(id, edgeLevy));

// ---- Family 3: the columns (day 2026-07-01) ----
const COLS_DAY = '2026-07-01';
const colsRows = [];
const addCol = (id, o = {}, expected = {}) => { add23(id, { day: COLS_DAY, ...o }); colsRows.push(line(id, COLS_DAY, expected)); };
const skipCol = (id, o = {}) => add23(id, { day: COLS_DAY, ...o });
addCol('T23-C01'); // every default: Epid, Disalab Number, name, contact, gender, age, the four stamps, the mapped facility, result, instrument, lab, type
// Gender (v1 lines 96-101) is the request's HL7 sex code: F, M, U, I only; N, O and anything else give NULL. Case and trailing blanks are ignored.
[['F', 'Female'], ['M', 'Male'], ['U', 'Unknown'], ['I', 'Indeterminate'], ['f ', 'Female'], ['m', 'Male'], ['N', null], ['O', null], ['X', null], ['', null], [null, null]]
  .forEach(([sex, gender], i) => addCol(`T23-G${pad2(i)}`, { patient: ['Mary', 'Banda', sex, '0977000001'] }, { gender }));
// Instrument (lines 127-135): FRTP and FRTB are AB7500, C6800, GENEX and GENEB are GeneXpert, PNTHR and PNTHB are Hologic Panther; others NULL.
[['FRTP', 'AB7500'], ['FRTB', 'AB7500'], ['C6800', 'C6800'], ['GENEX', 'GeneXpert'], ['GENEB', 'GeneXpert'], ['PNTHR', 'Hologic Panther'],
  ['PNTHB', 'Hologic Panther'], ['frtp ', 'AB7500'], ['c6800 ', 'C6800'], ['pnthr', 'Hologic Panther'], ['Genex', 'GeneXpert'], ['QS3', null], ['GENXP', null], ['', null], [null, null]]
  .forEach(([analyzer, instrument], i) => addCol(`T23-I${pad2(i)}`, { analyzer }, { instrument }));
// Testing Laboratory (lines 136-189): the long name of the testing code. 'ZU_' and 'ZL_' are varchar LIKE (a blank can fill the underscore).
// 'ZCH' is not in this CASE (the counts have it). A blank code would use ReceivingFacilityCode, which CE does not hold, so it gives NULL.
[['ZUA', 'University Teaching Hospital'], ['zub', 'University Teaching Hospital'], ['ZU ', 'University Teaching Hospital'], ['ZUA ', 'University Teaching Hospital'], ['ZU', null], ['ZUAB', null],
  ['ZAP', "Arthur Davison Childrens' Hospital"], ['zsp ', 'Solwezi General Hospital'], ['ZBP', 'Kabwe General Hospital'], ['ZLA', 'Livingstone Teaching Hospital'],
  ['zlb', 'Livingstone Teaching Hospital'], ['ZLA ', 'Livingstone Teaching Hospital'], ['ZL', null], ['ZMP', 'Lewanika General Hospital'], ['ZKS', 'Kasama General Hospital'], ['ZML', 'Mansa General Hospital'],
  ['ZTV', 'TDRC'], ['ztv ', 'TDRC'], ['ZTT', 'TDRC'], ['ztt ', 'TDRC'], ['zap ', "Arthur Davison Childrens' Hospital"], ['zbp ', 'Kabwe General Hospital'],
  ['zmp', 'Lewanika General Hospital'], ['zks ', 'Kasama General Hospital'], ['zml', 'Mansa General Hospital'], ['ZCH', null], ['ZNP', null], ['', null], ['   ', null], [null, null]]
  .forEach(([perf, testLab], i) => addCol(`T23-L${pad2(i)}`, { perf }, { testLab }));
// Panels and observation codes (lines 191-193, 219-220): five panels, six observation codes; TestType is Rapid for COVAB, COVAG and COVRP.
// [panel, observation code, TestType or null when the request is not listed]
[['COVID', 'COV2', 'PCR Based'], ['COVII', 'CVGXN', 'PCR Based'], ['COVAB', 'COV68', 'Rapid'], ['COVAG', 'CO751', 'Rapid'], ['COVRP', 'COVRP', 'Rapid'],
  ['covab ', 'CO752', 'Rapid'], ['COVID', 'cov2 ', 'PCR Based'], ['COVID', 'COVRP', 'PCR Based'], ['covii', 'co751', 'PCR Based'],
  ['COVIS', 'COV2', null], ['HIVVL', 'COV2', null], ['COVID', 'CO753', null], ['COVID', 'HIVVL', null]]
  .forEach(([panel, obs, type], i) => {
    const o = { panel, results: [{ obs, text: 'SARS-Cov-2 Genes Detected' }] };
    if (type) addCol(`T23-K${pad2(i)}`, o, { type }); else skipCol(`T23-K${pad2(i)}`, o);
  });
// The patient (lines 87-95): Patient Name is concat(first, ' ', surname), so a missing part leaves a blank; Contact Number is empty when blank.
addCol('T23-N01', { patient: [null, 'Zulu', 'F', '0977000001'] }, { name: ' Zulu' });
addCol('T23-N02', { patient: ['Ann', null, 'F', '0977000001'] }, { name: 'Ann ' });
addCol('T23-N03', { patient: [null, null, 'F', '0977000001'] }, { name: ' ' });
addCol('T23-N04', { patient: ['Mary', 'Banda', 'F', ''] }, { contact: null });
addCol('T23-N05', { patient: ['Mary', 'Banda', 'F', '   '] }, { contact: null });
addCol('T23-N06', { patient: ['Mary', 'Banda', 'F', ' 0977'] }, { contact: ' 0977' }); // LEN ignores trailing blanks only
addCol('T23-N07', { patient: ['Mary', 'Banda', 'F', null] }, { contact: null });
// Epid is the reference-numbers attribute of the urn:openldr:cs:request-attribute system: not unique-id, not another system's code.
addCol('T23-N08', { attrs: [{ code: 'unique-id', value: 'UQ-1' }, { system: 'urn:other', code: 'reference-numbers', value: 'WRONG' }] }, { epid: null });
addCol('T23-N09', { age: null }, { age: null });
addCol('T23-N10', { eff: null, auth: null }, { collected: null, registered: null });
// The facility (lines 205-211): the mapped register row; a facility the register does not hold keeps the row with empty Province, District, Location.
[['ZLUSA', 'ZLUSA'], ['ZUNMP', 'none'], ['ZNOMAP', 'none'], [null, 'none']].forEach(([req, fac], i) => addCol(`T23-F${pad2(i)}`, { req }, { fac }));

// ---- Family 4: the symptoms (day 2026-08-01). ADCOE answers sit on their own request row with the same lab number (line 16); the join is on
// the lab number alone (lines 212-218), so a symptom CTE is a left join that multiplies rows when it has several different answers. ----
const SX_DAY = '2026-08-01';
const sxRows = [];
const addSx = (id, o = {}, expected = {}) => { add23(id, { day: SX_DAY, ...o }); sxRows.push(line(id, SX_DAY, expected)); };
const answers = (id, results, o = {}) => add23(id, { day: SX_DAY, panel: 'ADCOE', report: false, patient: null, attrs: [], results, ...o });
// Every symptom code at once, with a different answer each. CCOUG (cough, lines 9-18) is built in v1 and never joined or selected: no column.
addSx('T23-X01', {}, { sx: ['ST1', 'FV1', 'SB1', 'BP1', 'OT1', 'HO1', 'OC1'] });
answers('T23-X01', [
  { obs: 'CSORT', text: 'ST1' }, { obs: 'CFERV', text: 'FV1' }, { obs: 'CSHBR', text: 'SB1' }, { obs: 'CMYBO', text: 'BP1' },
  { obs: 'COTHE', text: 'OT1' }, { obs: 'CPTHO', text: 'HO1' }, { obs: 'COUT', text: 'OC1' }, { obs: 'CCOUG', text: 'CG1' },
]);
// One symptom alone, so each column is tied to its own code: CSORT (line 83), CFERV (line 27), CSHBR (line 73), CMYBO (line 35), COTHE (line 45),
// CPTHO (line 64), COUT (line 55).
['CSORT', 'CFERV', 'CSHBR', 'CMYBO', 'COTHE', 'CPTHO', 'COUT'].forEach((code, i) => {
  const id = `T23-X0${i + 2}`;
  const sx = [];
  sx[i] = `only ${code}`;
  addSx(id, {}, { sx });
  answers(id, [{ obs: code, text: `only ${code}` }]);
});
// Two answers of two symptoms: the left joins multiply, 2 x 2 = 4 rows.
addSx('T23-X09', {}, { sx: ['A', 'Yes'] });
for (const sx of [['A', 'No'], ['B', 'Yes'], ['B', 'No']]) sxRows.push(line('T23-X09', SX_DAY, { sx }));
answers('T23-X09', [{ obs: 'CSORT', text: 'A' }, { obs: 'CSORT', text: 'B' }, { obs: 'CFERV', text: 'Yes' }, { obs: 'CFERV', text: 'No' }]);
// Two equal answers: SELECT DISTINCT keeps one row.
addSx('T23-X10', {}, { sx: [null, 'Yes'] });
answers('T23-X10', [{ obs: 'CFERV', text: 'Yes' }, { obs: 'CFERV', text: 'Yes' }]);
// Answers that differ only in case and trailing blanks are one value for DISTINCT under SQL Server's collation: one row. Which spelling shows is
// not defined by v1; the port shows the smallest in byte order ('YES ' sorts before 'Yes').
addSx('T23-X11', {}, { sx: [null, 'YES '] });
answers('T23-X11', [{ obs: 'CFERV', text: 'Yes' }, { obs: 'CFERV', text: 'YES ' }]);
// An answer under another panel is not read (line 16).
addSx('T23-X12', {}, {});
answers('T23-X12', [{ obs: 'CFERV', text: 'wrong panel' }], { panel: 'OTHER' });
// Panel and observation code compare ignoring case and trailing blanks.
addSx('T23-X13', {}, { sx: [null, 'ci match'] });
answers('T23-X13', [{ obs: 'cferv ', text: 'ci match' }], { panel: 'adcoe ' });
// Cough answers: no column, and no extra rows even with two of them.
addSx('T23-X14', {}, {});
answers('T23-X14', [{ obs: 'CCOUG', text: 'Yes' }, { obs: 'CCOUG', text: 'No' }]);
// Answers under another lab number are not joined; the lab number matches ignoring case and trailing blanks.
addSx('T23-X15', {}, {});
answers('T23-X15-OTHER', [{ obs: 'CFERV', text: 'other request' }]);
addSx('T23-X16', {}, { sx: [null, 'joined'] });
answers('t23-x16 ', [{ obs: 'CFERV', text: 'joined' }]);
// LIMSRptResult is text, else the number as text, else the coded value (rpt).
addSx('T23-X17', {}, { sx: [null, '5', null, null, null, 'Y'] });
answers('T23-X17', [{ obs: 'CFERV', num: 5 }, { obs: 'CPTHO', coded: 'Y' }]);
// A missing answer is a value too: NULL and 'Yes' are two different rows.
addSx('T23-X18', {}, { sx: [null, null] });
sxRows.push(line('T23-X18', SX_DAY, { sx: [null, 'Yes'] }));
answers('T23-X18', [{ obs: 'CFERV' }, { obs: 'CFERV', text: 'Yes' }]);
// Two request rows (OBR sets) under one lab number, each with a fever answer: two rows.
addSx('T23-X19', {}, { sx: [null, 'F-a'] });
sxRows.push(line('T23-X19', SX_DAY, { sx: [null, 'F-b'] }));
answers('T23-X19', [{ obs: 'CFERV', text: 'F-a' }]);
answers('T23-X19', [{ obs: 'CFERV', text: 'F-b' }]);
// Two result rows on the request itself. 'Positive' and 'Negative' are two rows; 'Positive' and 'IgG Positive' both map to Positive: one row.
add23('T23-X20', { day: SX_DAY, results: [{ obs: 'COV2', text: 'Positive' }, { obs: 'COV68', text: 'Negative' }] });
sxRows.push(line('T23-X20', SX_DAY, { result: 'Positive' }), line('T23-X20', SX_DAY, { result: 'Negative' }));
add23('T23-X21', { day: SX_DAY, results: [{ obs: 'COV2', text: 'Positive' }, { obs: 'COV68', text: 'IgG Positive' }] });
sxRows.push(line('T23-X21', SX_DAY, { result: 'Positive' }));

// ---- Family 5: the version differences. Facility (day 2026-09-01) and the patient join (day 2026-09-15). ----
const VER_DAY = '2026-09-01';
const verRows = {};
const addVer = (id, req, fac) => { add23(`T23-${id}`, { day: VER_DAY, req }); verRows[id] = line(`T23-${id}`, VER_DAY, { fac }); };
addVer('V01', 'LVCVD', 'LVCVD');
addVer('V02', 'LPMGH', 'LPMGH');
addVer('V03', 'ZCHOM', 'ZCHOM');
addVer('V04', null, 'none');
addVer('V05', 'LVCVD2', 'none');
addVer('V06', 'lvcvd ', 'LVCVD');
const V = (...ids) => ids.map((id) => verRows[id]);

const PAT_DAY = '2026-09-15';
// Patients is an inner join in the target (line 205) and a left join in Levy (line 199). A request with no patient row, or a patient id that
// points nowhere, is dropped by the target. Levy keeps it, and v1 then has no p.refno, p.requestid and no names: Epid and Disalab Number are
// NULL, Patient Name is a single blank (concat of two NULLs and a blank), Contact Number is NULL. Gender is the request's own sex code in
// v1; CE holds the sex on the patient only, so it is NULL here (spec ruling 7).
add23('T23-P01', { day: PAT_DAY, req: 'LVCVD' });
add23('T23-P02', { day: PAT_DAY, req: 'LVCVD', patient: null, attrs: [{ code: 'reference-numbers', value: 'EP-X' }] });
add23('T23-P03', { day: PAT_DAY, req: 'LVCVD', patient: null, patientId: 'ghost', age: 31 });
// P04 is P02 again with another lab number. With no patient row the lab number is not shown (it is p.requestid), so P02 and P04 are the same row
// in every column and SELECT DISTINCT keeps one; P03 differs in age and stays.
add23('T23-P04', { day: PAT_DAY, req: 'LVCVD', patient: null });
const noPatient = (id, o = {}) => line(id, PAT_DAY, { fac: 'LVCVD', epid: null, id: null, name: ' ', contact: null, gender: null, ...o });

// ---- Expected rows of the positivity series ----
//
// Each day: [date, result rows, positive rows, rate, 7-row moving average]. The two numbers per day are what v1's own expression returns on
// SQL Server 16 for the same counts (measured: the rate is decimal(24,12) and is TRUNCATED to 12 places, 2/3 is 0.666666666666; the average
// is decimal(38,12), also truncated, the mean of the rates of the last 7 days that have data). The average of days 1 and 2 is
// (0.333333333333 + 0.666666666666) / 2 = 0.4999999999995, which v1 shows as 0.499999999999.
const POS_DAYS = [
  ['2026-03-01', 3, 1, 0.333333333333, 0.333333333333],
  ['2026-03-02', 3, 2, 0.666666666666, 0.499999999999],
  ['2026-03-04', 7, 1, 0.142857142857, 0.380952380952],
  ['2026-03-05', 6, 1, 0.166666666666, 0.32738095238],
  ['2026-03-09', 9, 4, 0.444444444444, 0.350793650793],
  ['2026-03-10', 3, 1, 0.333333333333, 0.347883597883],
  ['2026-03-11', 7, 3, 0.428571428571, 0.359410430838],
  ['2026-03-12', 11, 5, 0.454545454545, 0.376726448154],
  ['2026-03-20', 13, 1, 0.076923076923, 0.292477363905],
];
const posRow = (d) => ({ TestDate: d[0], Tests: d[1], Positive: d[2], 'Positivity Rate': d[3], Svn_d_moving_average: d[4] });
// The window 2026-03-05 to 2026-03-11 holds days 4 to 7 only (measured the same way): the first average has one rate, the second two, and so on.
const POS_NARROW = [
  ['2026-03-05', 6, 1, 0.166666666666, 0.166666666666],
  ['2026-03-09', 9, 4, 0.444444444444, 0.305555555555],
  ['2026-03-10', 3, 1, 0.333333333333, 0.314814814814],
  ['2026-03-11', 7, 3, 0.428571428571, 0.343253968253],
];

// The requests. Day k has `tests` result rows: the first request holds two (v1 counts result rows, not requests), the others one each; the first
// `positive` rows are positive (coded DET or POS, any case), the rest are not (NEG, no code, DETECTED, NOT DET; every fifth has the positive TEXT and
// no coded value, which is not positive: v1 reads LIMSCodedValue). `special[k]` changes request k, keeping it in the count.
const POS_OBS = ['CVGXN', 'CO751', 'CO752', 'cov2', 'COV68 '];
const POS_CODED = ['DET', 'POS', 'det ', 'pos'];
const NEG_CODED = ['NEG', null, 'DETECTED', 'NOT DET'];
const posStamp = (date) => `${date}T09:00:00+02:00`;
function addPositivityDay(date, tests, positive, special = {}) {
  const rows = [];
  for (let i = 0; i < tests; i += 1) {
    const obs = POS_OBS[i % POS_OBS.length];
    const j = i - positive;
    if (i < positive) rows.push({ obs, coded: POS_CODED[i % POS_CODED.length] });
    else if (j % 5 === 4) rows.push({ obs, text: 'SARS-Cov-2 Genes Detected', coded: null });
    else rows.push({ obs, coded: NEG_CODED[j % NEG_CODED.length] });
  }
  const requests = [rows.slice(0, 2), ...rows.slice(2).map((r) => [r])];
  requests.forEach((results, k) => {
    add23(`T23-Z${date.slice(5).replace('-', '')}-${k}`, { patient: null, attrs: [], iss: posStamp(date), results, ...(special[k] ?? {}) });
  });
}
// Window edges inside the counted days: 03-01 00:30 +02:00 is 02-28 in UTC; 03-02 00:30 +02:00 is 03-01 in UTC; 03-20 23:59:59 +02:00 is the last
// second of the end date.
addPositivityDay('2026-03-01', 3, 1, { 0: { iss: '2026-03-01T00:30:00+02:00' } });
addPositivityDay('2026-03-02', 3, 2, { 0: { iss: '2026-03-02T00:30:00+02:00' } });
addPositivityDay('2026-03-04', 7, 1, { 1: { panel: 'COVII' } }); // COVII is in the panel list
addPositivityDay('2026-03-05', 6, 1, { 2: { status: 'preliminary' } }); // v1 has no status filter
addPositivityDay('2026-03-09', 9, 4, { 1: { panel: 'covid ' }, 2: { perf: 'zub' } });
addPositivityDay('2026-03-10', 3, 1);
addPositivityDay('2026-03-11', 7, 3, { 1: { perf: '' }, 2: { perf: 'ZUB' } }); // a blank lab code is not in the exclusion list: counted
addPositivityDay('2026-03-12', 11, 5);
addPositivityDay('2026-03-20', 13, 1, { 11: { iss: '2026-03-20T23:59:59+02:00' } });
// Not counted. Each is positive, so including one moves a number. The exclusion list (line 37) is ZZZ, XXX, ZXZ, ZCX, ZLX; a missing lab code
// makes `not in` unknown and drops the row; other panels and codes are not listed (lines 33-34); a window is whole local dates.
const DET = [{ obs: 'COV2', coded: 'DET' }];
const away = (id, o) => add23(id, { patient: null, attrs: [], results: DET, ...o });
['ZZZ', 'XXX', 'ZXZ', 'ZCX', 'ZLX', 'zzz ', 'Zlx', null].forEach((perf, i) => away(`T23-Z0302-X${i}`, { iss: posStamp('2026-03-02'), perf }));
away('T23-Z0304-X0', { iss: posStamp('2026-03-04'), panel: 'COVAB' });
away('T23-Z0304-X1', { iss: posStamp('2026-03-04'), results: [{ obs: 'COVRP', coded: 'DET' }] }); // COVRP is not in the moving average's code list
away('T23-Z0304-X2', { iss: posStamp('2026-03-04'), results: [{ obs: 'CO753', coded: 'DET' }] });
away('T23-Z0305-X0', { iss: null }); // no issued stamp
away('T23-Z0305-X1', { iss: '2026-03' }); // a partial stamp
away('T23-Z0220-X0', { iss: '2026-02-28T23:59:59+02:00' }); // before the window
away('T23-Z0321-X0', { iss: '2026-03-21T00:30:00+02:00' }); // after it (in UTC it is 03-20, inside)

// ---- Suites ----
const LINE_PARAMS = (day, extra = {}) => ({ ...dayWindow(day), version: 'standard', facility: '', ...extra });
const lineSuite = (name, params, wanted, setup = '') => setSuite(name, LINE_LIST, params, LINE_COLUMNS, wanted, setup);
const lineOrdered = (name, params, wanted) => ordered(name, LINE_LIST, params, LINE_COLUMNS, wanted);
// A suite that expects the query to FAIL (or, with wanted null, to run): the shared errorSuite of epi-fixture.mjs, by query name.
const errorSuite = (name, queryName, params, wanted) => errorSuiteOf(name, query(queryName), params, wanted);
const badTime = (id, value) => `${id} must be YYYY-MM-DDTHH:MM, got ${value}`;
const NONE_FOUND = { from: '2030-01-01T04:00', to: '2030-01-02T04:00', version: 'standard', facility: '' };

const suites23 = [
  // The Result map, standard. A blank version is standard.
  lineSuite('line-map-standard', LINE_PARAMS(MAP_DAY), mapStd, L23.setup()),
  lineSuite('line-map-blank-version', LINE_PARAMS(MAP_DAY, { version: '' }), mapStd),
  // Levy: the same requests (all at LVCVD), the shorter map. The version compares ignoring case and trailing blanks.
  lineSuite('line-map-levy', LINE_PARAMS(MAP_DAY, { version: 'Levy' }), mapLevy),
  lineSuite('line-map-levy-lower', LINE_PARAMS(MAP_DAY, { version: 'levy ' }), mapLevy),
  // The window edges on both stamps.
  lineSuite('line-edge-standard', LINE_PARAMS(EDGE_DAY), edgeStd),
  lineOrdered('line-edge-standard-order', LINE_PARAMS(EDGE_DAY), EDGE_STD_ORDER),
  lineSuite('line-edge-levy', LINE_PARAMS(EDGE_DAY, { version: 'Levy' }), edgeLevy),
  lineOrdered('line-edge-levy-order', LINE_PARAMS(EDGE_DAY, { version: 'Levy' }), EDGE_LEVY_ORDER),
  // The columns.
  lineSuite('line-columns', LINE_PARAMS(COLS_DAY), colsRows),
  // The symptoms.
  lineSuite('line-symptoms', LINE_PARAMS(SX_DAY), sxRows),
  // The facility. Standard with a blank facility lists every facility, also an unmapped one and none (line 219: no facility filter).
  lineSuite('line-version-standard-all', LINE_PARAMS(VER_DAY), V('V01', 'V02', 'V03', 'V04', 'V05', 'V06')),
  lineOrdered('line-version-standard-order', LINE_PARAMS(VER_DAY), V('V01', 'V02', 'V03', 'V04', 'V05', 'V06')),
  // Levy with a blank facility lists the two constants, LVCVD and LPMGH (Levy line 214), ignoring case and trailing blanks.
  lineSuite('line-version-levy-blank', LINE_PARAMS(VER_DAY, { version: 'Levy' }), V('V01', 'V02', 'V06')),
  // A facility given replaces both: standard narrows to it, Levy leaves its constants.
  lineSuite('line-version-standard-given', LINE_PARAMS(VER_DAY, { facility: 'zchom ' }), V('V03')),
  lineSuite('line-version-standard-lvcvd', LINE_PARAMS(VER_DAY, { facility: 'LVCVD' }), V('V01', 'V06')),
  lineSuite('line-version-levy-given', LINE_PARAMS(VER_DAY, { version: 'Levy', facility: 'ZCHOM' }), V('V03')),
  lineSuite('line-version-levy-unlisted', LINE_PARAMS(VER_DAY, { version: 'Levy', facility: 'LVCVD2' }), V('V05')),
  lineSuite('line-version-levy-lower', LINE_PARAMS(VER_DAY, { version: 'Levy', facility: 'lvcvd' }), V('V01', 'V06')),
  lineSuite('line-version-levy-lpmgh', LINE_PARAMS(VER_DAY, { version: 'Levy', facility: 'LPMGH ' }), V('V02')),
  lineSuite('line-version-standard-none', LINE_PARAMS(VER_DAY, { facility: 'NOPE' }), []),
  // The patient join: inner in the target, left in Levy.
  lineSuite('line-patients-standard', LINE_PARAMS(PAT_DAY), [line('T23-P01', PAT_DAY, { fac: 'LVCVD' })]),
  lineSuite('line-patients-levy', LINE_PARAMS(PAT_DAY, { version: 'Levy' }), [line('T23-P01', PAT_DAY, { fac: 'LVCVD' }), noPatient('T23-P02'), noPatient('T23-P03', { age: 31 })]),
  // A facility of only blanks is blank (rtrim): every facility for standard, the two constants for Levy.
  lineSuite('line-version-standard-blank-facility', LINE_PARAMS(VER_DAY, { facility: '   ' }), V('V01', 'V02', 'V03', 'V04', 'V05', 'V06')),
  lineSuite('line-version-levy-blank-facility', LINE_PARAMS(VER_DAY, { version: 'Levy', facility: '   ' }), V('V01', 'V02', 'V06')),
  // The date-time forms that are accepted: a space for the T, seconds, a date alone (midnight: 06-01 00:00 to 06-02 00:00, so E02 is in and E03 is out).
  lineSuite('line-time-space-and-seconds', { ...LINE_PARAMS(EDGE_DAY), from: '2026-06-01 04:00', to: '2026-06-02 04:00:00' }, edgeStd),
  lineSuite('line-time-date-only', { ...LINE_PARAMS(EDGE_DAY), from: '2026-06-01', to: '2026-06-02' }, [...edgeStd.filter((r) => ['T23-E01', 'T23-E06', 'T23-E08', 'T23-E13'].includes(r['Disalab Number'])),
    line('T23-E02', EDGE_DAY, { fac: 'LVCVD', reported: '2026-06-01T03:59:59+02:00', tested: '2026-06-01T04:00:00+02:00' })]),
  // Bad values raise an error that names the parameter and shows the value. Postgres alone would read 09/10/2026 as 10 September (MDY), accept
  // 'yesterday' and drop the offset of '+05'.
  errorSuite('line-time-ok', LINE_LIST, LINE_PARAMS(EDGE_DAY), null),
  errorSuite('line-time-from-slashes', LINE_LIST, { ...LINE_PARAMS(EDGE_DAY), from: '09/10/2026 04:00' }, badTime('from', '09/10/2026 04:00')),
  errorSuite('line-time-to-slashes', LINE_LIST, { ...LINE_PARAMS(EDGE_DAY), to: '01/06/2026 04:00' }, badTime('to', '01/06/2026 04:00')),
  errorSuite('line-time-from-yesterday', LINE_LIST, { ...LINE_PARAMS(EDGE_DAY), from: 'yesterday' }, badTime('from', 'yesterday')),
  errorSuite('line-time-to-now', LINE_LIST, { ...LINE_PARAMS(EDGE_DAY), to: 'now' }, badTime('to', 'now')),
  errorSuite('line-time-offset', LINE_LIST, { ...LINE_PARAMS(EDGE_DAY), from: '2026-06-01T04:00+05' }, badTime('from', '2026-06-01T04:00+05')),
  errorSuite('line-time-blank', LINE_LIST, { ...LINE_PARAMS(EDGE_DAY), to: '' }, badTime('to', '')),
  errorSuite('line-time-hour-only', LINE_LIST, { ...LINE_PARAMS(EDGE_DAY), from: '2026-06-01T04' }, badTime('from', '2026-06-01T04')),
  errorSuite('line-time-trailing-blank', LINE_LIST, { ...LINE_PARAMS(EDGE_DAY), from: '2026-06-01T04:00 ' }, badTime('from', '2026-06-01T04:00 ')),
  lineSuite('line-empty', NONE_FOUND, []),
  lineSuite('line-empty-levy', { ...NONE_FOUND, version: 'Levy' }, []),
  shapeSuite('line-shape', LINE_LIST, [['from', 'text', true], ['to', 'text', true], ['version', 'select', false], ['facility', 'text', false]],
    ['r.epid', 'r.lab_number', 'r.disalab', 'r.patient_name', 'r.contact', 'r.gender', 'r.age', 'r.collected', 'r.registered', 'r.province', 'r.district',
      'r.location', 'r.tested', 'r.reported', 'r.result', 'r.instrument', 'r.test_lab', 'r.test_type', 'r.auth_status', 'r.sore_throat', 'r.fever', 'r.breath',
      'r.body_pains', 'r.other', 'r.hospitalised', 'r.outcome']),
  {
    name: 'line-version-options',
    count: 2,
    sql: `select 'line-version-options' || chr(9) || json_build_object('v', q.v)::text from (${query(LINE_LIST)?.params.find((p) => p.id === 'version')?.optionsSql ?? 'select 1'}) as q(v);`,
    check(rows) {
      const got = rows.map((r) => r.v);
      return JSON.stringify(got) === JSON.stringify(['standard', 'Levy']) ? [] : [`expected ["standard","Levy"], got ${JSON.stringify(got)}`];
    },
  },

  // ---- COVID-19 daily positivity ----
  setSuite('pos-all', POSITIVITY, { from: '2026-03-01', to: '2026-03-20' }, POS_COLUMNS, POS_DAYS.map(posRow)),
  ordered('pos-all-order', POSITIVITY, { from: '2026-03-01', to: '2026-03-20' }, POS_COLUMNS, POS_DAYS.map(posRow)),
  // The window cuts the series: the first average has one rate (not the earlier days' rates).
  ordered('pos-narrow', POSITIVITY, { from: '2026-03-05', to: '2026-03-11' }, POS_COLUMNS, POS_NARROW.map(posRow)),
  // One day: 03-02 holds three result rows from two requests, one at 00:30 +02:00 (03-01 in UTC); its average is its own rate.
  ordered('pos-one-day', POSITIVITY, { from: '2026-03-02', to: '2026-03-02' }, POS_COLUMNS, [posRow(['2026-03-02', 3, 2, 0.666666666666, 0.666666666666])]),
  setSuite('pos-empty', POSITIVITY, { from: '2030-01-01', to: '2030-12-31' }, POS_COLUMNS, []),
  shapeSuite('pos-shape', POSITIVITY, [['from', 'text', true], ['to', 'text', true]], ['a.test_date']),
];



// ============================================================================================================================
// Group t24: the COVID-19 result extracts, the VRDSS feeds and the wastewater results (Task 24). Fixture ids start with "t24-"; lab numbers
// start with "T24-" and the letter after it names the family of cases (A columns, B panels, C status, D age groups, E priority, W window,
// R result map, I instrument, P VRDSS panels, O observations, G gender, H facility and HMIS code, L lab names, X distinct, J patient join,
// K V2 reference numbers, S wastewater). Every suite reads one family through a filter on the lab number, so the expected rows stay short.
// "v1 line N": PD = View__dbo_vw_Covid19_PD.sql, Covid19 = View__dbo_vw_Covid19.sql, VRDSS = View__dbo_v_vrdss_Covid.sql, V2 =
// View__dbo_v_vrdss_Covid_V2.sql, WW = View__dbo_WasteWaterData.sql, CHAZ = View__dbo_WastewaterDataCHAZ.sql.
// ============================================================================================================================

const PD = 'COVID-19 results with location';
const FL = 'COVID-19 results with facility location';
const VR = 'COVID-19 results (VRDSS)';
const V2 = 'COVID-19 results (VRDSS V2)';
const WW = 'Wastewater results';

// The v1 column lists (zm-inv-all.json, the rows of the six views).
const PD_COLUMNS = ['Province', 'District', 'Facility', 'RequestID', 'OBRSetID', 'LOINCPanelCode', 'LIMSPanelCode', 'LIMSPanelDesc', 'HL7PriorityCode',
  'SpecimenDateTime', 'RegisteredDateTime', 'ReceivedDateTime', 'AnalysisDateTime', 'AuthorisedDateTime', 'AdmitAttendDateTime', 'RequestingFacilityCode',
  'ReceivingFacilityCode', 'LIMSPointOfCareDesc', 'HL7ResultStatusCode', 'RegisteredBy', 'TestedBy', 'AuthorisedBy', 'AgeGroup', 'AgeInYears', 'AgeInDays',
  'HL7SexCode', 'Deceased', 'Newborn', 'AttendingDoctor', 'TestingFacilityCode', 'ReferringRequestID', 'LIMSAnalyzerCode', 'TargetTimeDays', 'TargetTimeMins',
  'LIMSRejectionCode', 'LIMSRejectionDesc', 'LIMSFacilityCode', 'Repeated', 'LIMSSpecimenID', 'LIMSPreReg_RegistrationDateTime', 'LIMSPreReg_ReceivedDateTime',
  'LIMSPreReg_RegistrationFacilityCode', 'LIMSVendorCode', 'RequestingFacilityNationalCode', 'HL7ResultTypeCode', 'SIValue', 'SIUnits', 'SILoRange', 'SIHiRange',
  'HL7AbnormalFlagCodes', 'DateTimeValue', 'CodedValue', 'ResultSemiquantitive', 'Note', 'LIMSObservationCode', 'LIMSObservationDesc', 'LIMSRptResult',
  'LIMSRptUnits', 'LIMSRptFlag', 'LIMSRptRange', 'LIMSCodedValue'];
const FL_COLUMNS = ['FacilityLocation', ...PD_COLUMNS.slice(3)];
const VR_COLUMNS = ['Sample_ID', 'Gender', 'AgeinYears', 'DOB', 'DOBType', 'ClinicalInfo', 'LIMSDateTimeStamp', 'Collected Date', 'SpecimenCode',
  'SpecimenDescription', 'Received Date', 'Registered Date', 'Province', 'District', 'HMISCode', 'Facility', 'Tested Date', 'Date Result Reported', 'Result',
  'Instrument', 'Testing Laboratory', 'TestType', 'LOINC', 'Authorization Status'];
const V2_COLUMNS = ['ct_case_id', 'Other Ref Number', 'Sample_ID', 'requestingfacilitycode', 'LIMSSpecimenSourceDesc', 'Gender', 'dob', 'location1', 'AgeinYears',
  'LIMSDateTimeStamp', 'Collected Date', 'Received Date', 'Registered Date', 'Province', 'District', 'Location', 'Tested Date', 'Date Result Reported', 'Result',
  'Instrument', 'Testing Laboratory', 'TestType', 'LOINC', 'Authorization Status'];
const WW_COLUMNS = ['requestid', 'SpecimenDateTime', 'RegisteredDateTime', 'ReceivedDatetime', 'AnalysisDateTime', 'AuthorisedDatetime', 'Laboratory', 'Site',
  'NgeneCT', 'ORF1abCT', 'QSCT', 'MS2CT', 'Result'];

// ---- The fixture ----
//
// What one request holds unless a case says otherwise: panel COVID at ZCHOM, tested at lab ZUA, final, with a patient (a woman born
// 1990-02-03), a specimen, every plain column filled, no request attributes and one positive COV2 result.
const DEF24 = {
  panel: 'COVID', panelDesc: 'COVID-19 PCR', priority: 'routine', req: 'ZCHOM', perf: 'ZUA', display: null, status: 'final', report: true,
  auth: '2026-05-10T08:00:00+02:00', ana: '2026-05-11T08:00:00+02:00', eff: '2026-05-09T07:00:00+02:00', iss: '2026-05-12T08:00:00+02:00',
  poc: 'Ward 1', regBy: 'clerk', testBy: 'tech', doctor: 'Dr Phiri', clinical: 'cough', analyzer: 'GENEX', rejCode: null, rejDesc: null,
  obr: 1, age: 30, days: 10950, authBy: 'pathologist',
  specimen: { received: '2026-05-09T12:00:00+02:00', code: 'NP', text: 'Nasopharyngeal swab' },
  patient: { sex: 'F', dob: '1990-02-03' }, patientId: null,
  results: [{ obs: 'COV2', desc: 'SARS-CoV-2 gene', type: 'ST', text: 'SARS-Cov-2 Genes Detected' }],
  attrs: [], moreReports: [],
};
const boolLit = (v) => (v === null || v === undefined ? 'null' : String(v));

function makeFixture24() {
  const patients = [];
  const specimens = [];
  const requests = [];
  const reports = [];
  const results = [];
  const attrs = [];
  let n = 0;
  return {
    // One lab_requests row (and its patient, specimen, report, results and attributes). `o` overrides DEF24; `patientId` points at a patient
    // row that already exists (or does not). Returns the ids so that a second request can share the patient.
    add(labId, o = {}) {
      const r = { ...DEF24, ...o };
      n += 1;
      const qid = `t24-q${n}`;
      let patientId = r.patientId;
      if (r.patient) {
        patientId = `t24-p${n}`;
        patients.push(`(${lit(patientId)}, ${lit(r.patient.sex)}, ${lit(r.patient.dob)})`);
      }
      let specimenId = null;
      if (r.specimen) {
        specimenId = `t24-s${n}`;
        specimens.push(`(${lit(specimenId)}, ${lit(r.specimen.received)}, ${lit(r.specimen.code)}, ${lit(r.specimen.text)})`);
      }
      requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(patientId)}, ${lit(r.panel)}, ${lit(r.panelDesc)}, ${lit(r.priority)}, ${lit(r.auth)}, ${lit(r.req)}, ${lit(r.ana)}, ${lit(r.poc)}, ${lit(r.regBy)}, ${lit(r.testBy)}, ${lit(r.doctor)}, ${lit(r.clinical)}, ${lit(r.analyzer)}, ${lit(r.rejCode)}, ${lit(r.rejDesc)}, ${num(r.obr)}, ${num(r.age)}, ${num(r.days)})`);
      if (r.report) {
        reports.push(`(${lit(`t24-d${n}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.eff)}, ${lit(r.iss)}, ${lit(r.perf)}, ${lit(r.display)}, ${lit(specimenId)}, ${lit(r.authBy)})`);
        r.moreReports.forEach((m, i) => {
          reports.push(`(${lit(`t24-d${n}-${i + 2}`)}, ${lit(qid)}, ${lit(m.status ?? 'final')}, ${lit(m.eff ?? r.eff)}, ${lit(m.iss ?? r.iss)}, ${lit(m.perf)}, ${lit(m.display ?? null)}, ${lit(specimenId)}, ${lit(r.authBy)})`);
        });
      }
      r.results.forEach((x, i) => {
        results.push(`(${lit(`t24-r${n}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.desc ?? null)}, ${lit(x.type ?? null)}, ${num(x.num)}, ${lit(x.units ?? null)}, ${lit(x.cmp ?? null)}, ${lit(x.coded ?? null)}, ${lit(x.text ?? null)}, ${lit(x.flag ?? null)})`);
      });
      r.attrs.forEach((a, i) => {
        attrs.push(`(${lit(`t24-a${n}-${i + 1}`)}, ${lit(qid)}, ${lit(a.system ?? ATTR)}, ${lit(a.code)}, ${lit(a.text ?? null)}, ${num(a.num)}, ${lit(a.dt ?? null)}, ${boolLit(a.bool)})`);
      });
      return { qid, patientId };
    },
    setup() {
      return `${FACILITIES24}
${REGISTRY24}
${LAB_MAP24}
insert into patients (id, sex, date_of_birth) values ${patients.join(',\n  ')};
insert into specimens (id, received_time, type_code, type_text) values ${specimens.join(',\n  ')};
insert into lab_requests (id, request_id, patient_id, panel_code, panel_desc, priority, authored_at, requester_code, analysis_at, point_of_care, registered_by, tested_by, requester_practitioner, clinical_info, analyzer_code, rejection_code, rejection_reason, obr_set_id, age_years, age_days) values ${requests.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, performer_display, specimen_id, authorised_by) values ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, observation_desc, result_type, numeric_value, numeric_units, numeric_comparator, coded_value, text_value, abnormal_flag) values ${results.join(',\n  ')};
insert into lab_request_attributes (id, lab_request_id, system, code, value_text, value_number, value_datetime, value_boolean) values ${attrs.join(',\n  ')};`;
    },
  };
}

// The register rows. ZUNMP is in the map without a register id (the facility is not in the register). The HMIS codes sit in
// facility_registry.extras (JSON text): ZCHOM first in the text, ZLUSA after another key, ZSPAC with blanks around the colon, ZBLNK with a blank
// code, ZNOHM with no such key, ZNULL with no extras and ZGHOS with no registry row at all.
const FACILITIES24 = facilityRows('t24', [
  ['ZCHOM', 'Choma General Hospital', 'Southern', 'Choma'],
  ['ZLUSA', 'Chilenje Clinic', 'Lusaka', 'Lusaka'],
  ['ZNOHM', 'Kafue Clinic', 'Lusaka', 'Kafue'],
  ['ZBLNK', 'Mongu Clinic', 'Western', 'Mongu'],
  ['ZGHOS', 'Ghost Clinic', 'Eastern', 'Chipata'],
  ['ZNULL', 'Kitwe Clinic', 'Copperbelt', 'Kitwe'],
  ['ZSPAC', 'Mansa Clinic', 'Luapula', 'Mansa'],
  ['ZUNMP', null, null, null, false],
]);
const ZM_REGISTER = 'urn:openldr:zm:facilities';
const REGISTRY24 = `insert into facility_registry (id, facility_system, facility_code, name, register_state, extras) values
  ('reg-t24-1', '${ZM_REGISTER}', '1', 'Choma General Hospital', 'in_register', '{"hims_code":"30010001","dhis2_uid":"x1","type":"Hospital"}'),
  ('reg-t24-2', '${ZM_REGISTER}', '2', 'Chilenje Clinic', 'in_register', '{"type":"Clinic","hims_code":"30020002"}'),
  ('reg-t24-3', '${ZM_REGISTER}', '3', 'Kafue Clinic', 'in_register', '{"type":"Clinic","dhis2_uid":"x3"}'),
  ('reg-t24-4', '${ZM_REGISTER}', '4', 'Mongu Clinic', 'in_register', '{"hims_code":"","type":"Clinic"}'),
  ('reg-t24-6', '${ZM_REGISTER}', '6', 'Kitwe Clinic', 'in_register', null),
  ('reg-t24-7', '${ZM_REGISTER}', '7', 'Mansa Clinic', 'in_register', '{ "hims_code" : "30070007" , "type": "Clinic" }');`;
// Testing labs the report names through the register (labNameSql): ZLB and ZLE are mapped, ZLC and the rest are not.
const LAB_MAP24 = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t24-lm1', '', '', 'ZLB', 'reg-lab-1', 'Mapped Lab B', 'Lusaka', 'Lusaka'),
  ('t24-lm2', '', '', 'ZLE', 'reg-lab-2', 'Mapped Lab E', 'Lusaka', 'Lusaka');`;

const L24 = makeFixture24();
const add24 = (labId, o) => L24.add(labId, o);

// Where the facilities are: [province, district, name, hims code], and the FacilityLocation text.
const FAC24 = {
  ZCHOM: ['Southern', 'Choma', 'Choma General Hospital', '30010001'],
  ZLUSA: ['Lusaka', 'Lusaka', 'Chilenje Clinic', '30020002'],
  ZNOHM: ['Lusaka', 'Kafue', 'Kafue Clinic', null],
  ZBLNK: ['Western', 'Mongu', 'Mongu Clinic', ''],
  ZGHOS: ['Eastern', 'Chipata', 'Ghost Clinic', null],
  ZNULL: ['Copperbelt', 'Kitwe', 'Kitwe Clinic', null],
  ZSPAC: ['Luapula', 'Mansa', 'Mansa Clinic', '30070007'],
  none: [null, null, null, null],
};
const where = (fac) => {
  const [province, district, name, hims] = FAC24[fac];
  return { Province: province, District: district, Facility: name, HMISCode: hims, Location: name, FacilityLocation: name === null ? null : `${name}, ${district}, ${province}` };
};

// ---- The expected rows ----
//
// pd(): a row of COVID-19 results with location (and, by the same record, with facility location) for a request that holds the defaults and one
// positive COV2 result. `o` changes the columns a case changes, by v1 name.
const pd = (labId, o = {}) => ({
  ...where('ZCHOM'), RequestID: labId, OBRSetID: 1, LOINCPanelCode: null, LIMSPanelCode: 'COVID', LIMSPanelDesc: 'COVID-19 PCR', HL7PriorityCode: 'R',
  SpecimenDateTime: DEF24.eff, RegisteredDateTime: DEF24.auth, ReceivedDateTime: DEF24.specimen.received, AnalysisDateTime: DEF24.ana,
  AuthorisedDateTime: DEF24.iss, AdmitAttendDateTime: null, RequestingFacilityCode: 'ZCHOM', ReceivingFacilityCode: null, LIMSPointOfCareDesc: 'Ward 1',
  HL7ResultStatusCode: 'F', RegisteredBy: 'clerk', TestedBy: 'tech', AuthorisedBy: 'pathologist', AgeGroup: '30-34', AgeInYears: 30, AgeInDays: 10950,
  HL7SexCode: 'F', Deceased: null, Newborn: null, AttendingDoctor: 'Dr Phiri', TestingFacilityCode: 'ZUA', ReferringRequestID: null, LIMSAnalyzerCode: 'GENEX',
  TargetTimeDays: null, TargetTimeMins: null, LIMSRejectionCode: null, LIMSRejectionDesc: null, LIMSFacilityCode: 'ZCHOM', Repeated: null, LIMSSpecimenID: null,
  LIMSPreReg_RegistrationDateTime: null, LIMSPreReg_ReceivedDateTime: null, LIMSPreReg_RegistrationFacilityCode: null, LIMSVendorCode: null,
  RequestingFacilityNationalCode: null, HL7ResultTypeCode: 'ST', SIValue: null, SIUnits: null, SILoRange: null, SIHiRange: null, HL7AbnormalFlagCodes: null,
  DateTimeValue: null, CodedValue: null, ResultSemiquantitive: null, Note: null, LIMSObservationCode: 'COV2', LIMSObservationDesc: 'SARS-CoV-2 gene',
  LIMSRptResult: 'SARS-Cov-2 Genes Detected', LIMSRptUnits: null, LIMSRptFlag: null, LIMSRptRange: null, LIMSCodedValue: null, ...o,
});
// vr(): a row of the VRDSS feed for the same default request. v2(): the V2 feed, with V2's own columns; `o` is in V2 names there.
const vr = (labId, o = {}) => ({
  Sample_ID: labId, Gender: 'Female', AgeinYears: 30, DOB: '1990-02-03', DOBType: null, ClinicalInfo: 'cough', LIMSDateTimeStamp: null,
  'Collected Date': DEF24.eff, SpecimenCode: 'NP', SpecimenDescription: 'Nasopharyngeal swab', 'Received Date': DEF24.specimen.received,
  'Registered Date': DEF24.auth, Province: 'Southern', District: 'Choma', HMISCode: '30010001', Facility: 'Choma General Hospital', 'Tested Date': DEF24.ana,
  'Date Result Reported': DEF24.iss, Result: 'Positive', Instrument: 'GeneXpert', 'Testing Laboratory': 'ZUA', TestType: 'PCR Based', LOINC: '94500-6',
  'Authorization Status': 'Reviewed', ...o,
});
const v2 = (labId, o = {}) => ({
  ct_case_id: null, 'Other Ref Number': null, Sample_ID: labId, requestingfacilitycode: 'ZCHOM', LIMSSpecimenSourceDesc: 'Nasopharyngeal swab', Gender: 'Female',
  dob: '1990-02-03', location1: null, AgeinYears: 30, LIMSDateTimeStamp: null, 'Collected Date': DEF24.eff, 'Received Date': DEF24.specimen.received,
  'Registered Date': DEF24.auth, Province: 'Southern', District: 'Choma', Location: 'Choma General Hospital', 'Tested Date': DEF24.ana,
  'Date Result Reported': DEF24.iss, Result: 'Positive', Instrument: 'GeneXpert', 'Testing Laboratory': 'ZUA', TestType: 'PCR Based', LOINC: '94500-6',
  'Authorization Status': 'Reviewed', ...o,
});
// The columns of the two feeds that carry the same fact under another name. A V1 change is turned into the V2 change.
const V1_TO_V2 = { DOB: 'dob', Facility: 'Location', SpecimenDescription: 'LIMSSpecimenSourceDesc' };
const V1_ONLY = ['DOBType', 'ClinicalInfo', 'SpecimenCode', 'HMISCode'];
const v2of = (changes) => Object.fromEntries(Object.entries(changes).filter(([k]) => !V1_ONLY.includes(k)).map(([k, v]) => [V1_TO_V2[k] ?? k, v]));

// ---- Suites over a family ----
//
// A set suite over the rows of one family: the SQL is the query with `params`, filtered to the lab numbers that start with `prefix` (on the
// column `idCol`), and the rows are compared as a set with their column order and count.
const familyFilter = (idCol, prefix) => `z."${idCol}" ilike '${prefix}%'`;
function fam(name, queryName, params, columns, wanted, idCol, prefix, setup = '') {
  const q = query(queryName);
  const key = (r) => JSON.stringify(columns.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `select ${lit(name)} || chr(9) || row_to_json(q)::text from (select * from (${q ? bind(q.sql, params) : `select null::text as "${idCol}"`}) z where ${familyFilter(idCol, prefix)}) q;`,
    count: wanted.length + 1,
    check(got) {
      if (!q) return [`query "${queryName}" is missing`];
      const failures = [];
      if (got.length !== wanted.length) failures.push(`expected ${wanted.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), columns));
        if (Object.keys(got[0]).length !== columns.length) failures.push(`expected ${columns.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const left = wanted.map(key);
      for (const h of got.map(key)) {
        const i = left.indexOf(h);
        if (i < 0) failures.push(`unexpected row ${h}`); else left.splice(i, 1);
      }
      for (const w of left) failures.push(`missing row ${w}`);
      return failures;
    },
  };
}
// The same, with the rows IN ORDER (the query has a total ORDER BY).
const famOrdered = (name, queryName, params, columns, wanted, idCol, prefix) =>
  orderedSuite(name, `select * from (${query(queryName)?.sql ?? `select null::text as "${idCol}"`}) z where ${familyFilter(idCol, prefix)}`, params, columns, wanted);

const NO_WINDOW = { from: '', to: '' };
const MAIN_WINDOW = { from: '2026-05-01', to: '2026-05-31' };
// The five queries' suites for one family of the extracts: both extracts (the same rows, the location columns differ).
const pdFam = (name, rows, prefix, params = NO_WINDOW, setup = '') => [
  fam(`${name}-pd`, PD, params, PD_COLUMNS, rows, 'RequestID', prefix, setup),
  fam(`${name}-fl`, FL, params, FL_COLUMNS, rows, 'RequestID', prefix),
];

// ---- Family A: every column. One request with everything filled, two results ----
// v1: PD lines 14-19. The attributes come in the column of their type (text, number, boolean, date-time); the system decoy and the unused code
// are not read.
add24('T24-A01', {
  panel: 'COVID', panelDesc: 'COVID-19 PCR', priority: 'urgent', poc: 'ICU', regBy: 'clerk1', testBy: 'tech1', doctor: 'Dr Banda', clinical: 'fever',
  analyzer: 'C6800', rejCode: 'R01', rejDesc: 'Clotted', obr: 2, age: 52, days: 19000, authBy: 'pathologist1', patient: { sex: 'M', dob: '1974-01-01' },
  attrs: [
    { code: 'loinc-panel-code', text: '94500-6' }, { code: 'admit-attend-time', dt: '2026-05-08T09:00:00+02:00' }, { code: 'deceased', bool: true },
    { code: 'newborn', bool: false }, { code: 'repeated', num: 2 }, { code: 'referring-request-id', text: 'REF-9' }, { code: 'target-time-days', num: 3 },
    { code: 'target-time-mins', num: 45 }, { code: 'prereg-registration-time', dt: '2026-05-08T07:00:00+02:00' },
    { code: 'prereg-received-time', dt: '2026-05-08T08:00:00+02:00' }, { code: 'prereg-registration-facility', text: 'ZPRE' }, { code: 'vendor-code', text: 'DISA' },
    { system: 'urn:other', code: 'vendor-code', text: 'WRONG SYSTEM' }, { code: 'therapy', text: 'NOT A COLUMN' },
  ],
  results: [
    { obs: 'COV2', desc: 'SARS-CoV-2 N gene', type: 'ST', text: 'SARS-Cov-2 Genes Detected', flag: 'A', coded: 'POS' },
    { obs: 'COV68', desc: 'Ct value', type: 'NM', num: 24.5, units: 'Ct', cmp: '<', flag: 'H' },
  ],
});
const A01 = {
  RequestID: 'T24-A01', OBRSetID: 2, LOINCPanelCode: '94500-6', HL7PriorityCode: 'U', AdmitAttendDateTime: '2026-05-08T09:00:00+02:00',
  LIMSPointOfCareDesc: 'ICU', RegisteredBy: 'clerk1', TestedBy: 'tech1', AuthorisedBy: 'pathologist1', AgeGroup: '45-49', AgeInYears: 52, AgeInDays: 19000,
  HL7SexCode: 'M', Deceased: 'true', Newborn: 'false', AttendingDoctor: 'Dr Banda', ReferringRequestID: 'REF-9', LIMSAnalyzerCode: 'C6800', TargetTimeDays: '3',
  TargetTimeMins: '45', LIMSRejectionCode: 'R01', LIMSRejectionDesc: 'Clotted', Repeated: '2', LIMSPreReg_RegistrationDateTime: '2026-05-08T07:00:00+02:00',
  LIMSPreReg_ReceivedDateTime: '2026-05-08T08:00:00+02:00', LIMSPreReg_RegistrationFacilityCode: 'ZPRE', LIMSVendorCode: 'DISA',
};
const A01_ROWS = [
  pd('T24-A01', { ...A01, HL7ResultTypeCode: 'ST', LIMSObservationCode: 'COV2', LIMSObservationDesc: 'SARS-CoV-2 N gene', LIMSRptResult: 'SARS-Cov-2 Genes Detected',
    HL7AbnormalFlagCodes: 'A', LIMSCodedValue: 'POS' }),
  pd('T24-A01', { ...A01, HL7ResultTypeCode: 'NM', SIValue: 24.5, SIUnits: 'Ct', HL7AbnormalFlagCodes: 'H', LIMSObservationCode: 'COV68', LIMSObservationDesc: 'Ct value',
    LIMSRptResult: '< 24.5' }),
];
// No patient, no specimen, no age, no result rows: the left joins keep the request (PD lines 20-21), and the age group is 'Not Captured'.
add24('T24-A02', { req: 'ZLUSA', patient: null, specimen: null, age: null, days: null, results: [] });
const A02 = pd('T24-A02', {
  ...where('ZLUSA'), RequestingFacilityCode: 'ZLUSA', LIMSFacilityCode: 'ZLUSA', HL7SexCode: null, ReceivedDateTime: null, AgeGroup: 'Not Captured', AgeInYears: null,
  AgeInDays: null, HL7ResultTypeCode: null, LIMSObservationCode: null, LIMSObservationDesc: null, LIMSRptResult: null,
});
// A facility that is mapped without a register row (ZUNMP), one in no map (ZNOMAP) and a request with no facility code: v1's left joins give empty
// Province, District and Facility.
add24('T24-A03', { req: 'ZUNMP' });
add24('T24-A04', { req: 'ZNOMAP' });
add24('T24-A05', { req: null });
const A03 = pd('T24-A03', { ...where('none'), RequestingFacilityCode: 'ZUNMP', LIMSFacilityCode: 'ZUNMP' });
const A04 = pd('T24-A04', { ...where('none'), RequestingFacilityCode: 'ZNOMAP', LIMSFacilityCode: 'ZNOMAP' });
const A05 = pd('T24-A05', { ...where('none'), RequestingFacilityCode: null, LIMSFacilityCode: null });
// Three results, one of them on an observation code that is in no list: PD has no filter on the observation, so three rows. Result texts: the
// text, the number alone, the coded value alone.
add24('T24-A06', {
  results: [
    { obs: 'ZZZ99', desc: 'Not a COVID test', type: 'ST', text: 'Anything' },
    { obs: 'COV2', desc: 'SARS-CoV-2 gene', type: 'NM', num: 7, units: 'u' },
    { obs: 'CVGXN', desc: 'Gene xpert', type: 'CE', coded: 'NEG' },
  ],
});
const A06 = [
  pd('T24-A06', { LIMSObservationCode: 'ZZZ99', LIMSObservationDesc: 'Not a COVID test', LIMSRptResult: 'Anything' }),
  pd('T24-A06', { LIMSObservationCode: 'COV2', HL7ResultTypeCode: 'NM', SIValue: 7, SIUnits: 'u', LIMSRptResult: '7' }),
  pd('T24-A06', { LIMSObservationCode: 'CVGXN', LIMSObservationDesc: 'Gene xpert', HL7ResultTypeCode: 'CE', LIMSRptResult: 'NEG', LIMSCodedValue: 'NEG' }),
];
// The same attributes sent as text (a sender may use value_text for any code): the typed read takes the text first.
add24('T24-A07', {
  attrs: [
    { code: 'admit-attend-time', text: '2026-05-08T09:00:00+02:00' }, { code: 'deceased', text: 'Y' }, { code: 'newborn', text: 'N' }, { code: 'repeated', text: '1' },
    { code: 'target-time-days', text: '5' }, { code: 'target-time-mins', text: '90' }, { code: 'prereg-registration-time', text: 'T1' }, { code: 'prereg-received-time', text: 'T2' },
  ],
});
const A07 = pd('T24-A07', {
  AdmitAttendDateTime: '2026-05-08T09:00:00+02:00', Deceased: 'Y', Newborn: 'N', Repeated: '1', TargetTimeDays: '5', TargetTimeMins: '90',
  LIMSPreReg_RegistrationDateTime: 'T1', LIMSPreReg_ReceivedDateTime: 'T2',
});
const A_ROWS = [...A01_ROWS, A02, A03, A04, A05, ...A06, A07];

// ---- Family B: the panels (PD line 28). The five panels are in, case and trailing blanks do not matter, anything else is out. ----
const B_PANELS = ['COVID', 'COVII', 'COVRP', 'COVAG', 'COVAB'];
const B_ROWS = [];
B_PANELS.forEach((panel, i) => {
  const id = `T24-B0${i + 1}`;
  add24(id, { panel });
  B_ROWS.push(pd(id, { LIMSPanelCode: panel }));
});
add24('T24-B06', { panel: 'covid ' });
B_ROWS.push(pd('T24-B06', { LIMSPanelCode: 'covid ' }));
add24('T24-B07', { panel: 'CoVaB  ' });
B_ROWS.push(pd('T24-B07', { LIMSPanelCode: 'CoVaB  ' }));
// Out: COVIS (the VRDSS list has it, PD does not), a longer code, an empty code, no code.
['COVIS', 'COVID2', '', null, 'OTHER'].forEach((panel, i) => add24(`T24-B1${i}`, { panel }));

// ---- Family C: the report status (PD line 28 wants F). ----
add24('T24-C01', { status: 'final' });
add24('T24-C02', { status: 'FINAL ' }); // SQL Server compares ignoring case and trailing blanks
['preliminary', 'cancelled', 'unknown', null, ''].forEach((status, i) => add24(`T24-C1${i}`, { status }));
add24('T24-C20', { report: false }); // a request with no report is not final
// Two reports: a final one and a preliminary one: only the final one counts.
add24('T24-C21', { moreReports: [{ status: 'preliminary', perf: 'ZUB' }] });
// Two final reports at two labs: the request shows once per report (CE has one status per report; v1 has one per Requests row).
add24('T24-C22', { moreReports: [{ status: 'final', perf: 'ZUB' }] });
const C_ROWS = [pd('T24-C01'), pd('T24-C02'), pd('T24-C21'), pd('T24-C22'), pd('T24-C22', { TestingFacilityCode: 'ZUB' })];

// ---- Family D: the age groups (dbo.Agegroup, kept with its mislabel: 50 to 54 are '45-49'). ----
const D_AGES = [[-1, '<1'], [0, '<1'], [1, '1-4'], [4, '1-4'], [5, '5-9'], [9, '5-9'], [10, '10-14'], [14, '10-14'], [15, '15-19'], [19, '15-19'],
  [20, '20-24'], [24, '20-24'], [25, '25-29'], [29, '25-29'], [30, '30-34'], [34, '30-34'], [35, '35-39'], [39, '35-39'], [40, '40-44'], [44, '40-44'],
  [45, '45-49'], [49, '45-49'], [50, '45-49'], [54, '45-49'], [55, '50+'], [56, '50+'], [99, '50+'], [null, 'Not Captured']];
const D_ROWS = D_AGES.map(([age, group], i) => {
  const id = `T24-D${String(i + 1).padStart(2, '0')}`;
  add24(id, { age });
  return pd(id, { AgeInYears: age, AgeGroup: group });
});

// ---- Family E: the priority word back to R, U, S. ----
const E_PRIORITIES = [['routine', 'R'], ['urgent', 'U'], ['stat', 'S'], ['STAT ', 'S'], ['Routine', 'R'], ['URGENT', 'U'], ['asap', null], ['', null], [null, null]];
const E_ROWS = E_PRIORITIES.map(([priority, code], i) => {
  const id = `T24-E0${i + 1}`;
  add24(id, { priority });
  return pd(id, { HL7PriorityCode: code });
});

// ---- Family W: the window. The authorised date, on the local date of the stamp, both sides optional. Every row is a default request whose only
// change is the report's issued stamp. W01 and W02 sit at the edges of July with +02:00 (as UTC they are 06-30 and 07-31). ----
const W_ISSUED = [
  ['T24-W01', '2026-07-01T00:30:00+02:00'], // local 07-01 (UTC 06-30): in
  ['T24-W02', '2026-07-31T23:30:00+02:00'], // local 07-31: in
  ['T24-W03', '2026-08-01T00:30:00+02:00'], // local 08-01 (UTC 07-31): out of July
  ['T24-W04', '2026-06-30T23:30:00+02:00'], // local 06-30: out of July
  ['T24-W05', '2026-07-15'], // a date only
  ['T24-W06', '2026-07'], // a partial stamp: outside any window
  ['T24-W07', null], // no stamp: outside any window
  ['T24-W08', '2026-07-31T23:59:59Z'], // the last second of the end date
  ['T24-W09', '2026-07-01T00:00:00Z'], // the first second of the start date
  ['T24-W10', '2026-06-30T23:59:59Z'], // one second before
];
W_ISSUED.forEach(([id, iss]) => add24(id, { iss }));
const wPd = (ids) => ids.map((id) => pd(id, { AuthorisedDateTime: W_ISSUED.find(([i]) => i === id)[1] }));
const wVr = (ids) => ids.map((id) => {
  const iss = W_ISSUED.find(([i]) => i === id)[1];
  return vr(id, { 'Date Result Reported': iss, 'Authorization Status': iss === null ? 'Pending Review' : 'Reviewed' });
});
const wV2 = (ids) => ids.map((id) => {
  const iss = W_ISSUED.find(([i]) => i === id)[1];
  return v2(id, { 'Date Result Reported': iss, 'Authorization Status': iss === null ? 'Pending Review' : 'Reviewed' });
});
const W_ALL = W_ISSUED.map(([id]) => id);
const W_JULY = ['T24-W01', 'T24-W02', 'T24-W05', 'T24-W08', 'T24-W09'];
const W_FROM_31 = ['T24-W02', 'T24-W03', 'T24-W08']; // from 07-31, no end
const W_TO_01 = ['T24-W01', 'T24-W04', 'T24-W09', 'T24-W10']; // to 07-01, no start
const W_ONE_DAY = ['T24-W05'];

// ---- VRDSS families ----
const vrRows = {}; // family -> [VRDSS row, V2 row | null]; a null V2 row means the V2 feed does not list it
const vrAdd = (family, id, fixture, changes, { in1 = true, in2 = true, v2changes = null } = {}) => {
  add24(id, fixture);
  (vrRows[family] ??= []).push({
    v1: in1 ? vr(id, changes) : null,
    v2: in2 ? v2(id, v2changes ?? v2of(changes)) : null,
  });
};
const famRows = (family, which) => vrRows[family].map((r) => r[which]).filter((r) => r !== null);

// Family R: the Result map (VRDSS lines 51-67; V2 lines 32-47 are the same). [stored text or fields, mapped result].
const R_MAP = [
  [{ text: 'SARS-Cov-2 Genes Not Detected' }, 'Negative'], [{ text: 'IgM/IgG Negative' }, 'Negative'], [{ text: 'IgM Negative' }, 'Negative'],
  [{ text: 'Negative' }, 'Negative'], [{ text: 'SARS-Cov-2 Genes Detected' }, 'Positive'], [{ text: 'IgG Positive' }, 'Positive'],
  [{ text: 'IgM Positive' }, 'Positive'], [{ text: 'IgM/IgG Positive' }, 'Positive'], [{ text: 'Positive' }, 'Positive'],
  // Line 61 reads 'Inconclusive' with an acute accent on the I (U+00CD): v1's typo, kept. The accent counts, the case does not.
  [{ text: '\u00cdnconclusive' }, 'To be retested'], [{ text: 'No AFB seen.' }, 'To be retested'], [{ text: 'INVAL' }, 'To be retested'],
  [{ text: 'Invalid' }, 'To be retested'],
  // No ELSE: a text that is not listed gives NULL, and the row still shows.
  [{ text: 'Inconclusive' }, null], [{ text: 'Not Detected' }, null], [{ text: 'Detected' }, null], [{ text: '' }, null], [{ text: null }, null],
  // Case and trailing blanks do not matter, on every kind of entry.
  [{ text: 'POSITIVE' }, 'Positive'], [{ text: 'negative   ' }, 'Negative'], [{ text: 'sars-cov-2 genes detected' }, 'Positive'],
  [{ text: 'SARS-COV-2 GENES NOT DETECTED ' }, 'Negative'], [{ text: 'igm/igg positive ' }, 'Positive'], [{ text: '\u00cdNCONCLUSIVE ' }, 'To be retested'],
  [{ text: '\u00edncOnclusive' }, 'To be retested'], [{ text: 'no afb seen. ' }, 'To be retested'], [{ text: 'igm/igg negative ' }, 'Negative'],
  [{ text: 'IGM NEGATIVE' }, 'Negative'], [{ text: 'inval ' }, 'To be retested'], [{ text: 'INVALID' }, 'To be retested'],
  // LIMSRptResult is the text, else the number, else the coded value (rpt): a coded-only result maps, a number never does.
  [{ coded: 'Positive' }, 'Positive'], [{ coded: 'Invalid' }, 'To be retested'], [{ num: 20, cmp: '<' }, null], [{ num: 1 }, null],
];
R_MAP.forEach(([res, mapped], i) => {
  const id = `T24-R${String(i + 1).padStart(2, '0')}`;
  vrAdd('R', id, { results: [{ obs: 'COV2', ...res }] }, { Result: mapped });
});

// Family I: the Instrument map (VRDSS lines 68-78).
const I_MAP = [['FRTP', 'AB7500'], ['FRTB', 'AB7500'], ['C6800', 'C6800'], ['GENEX', 'GeneXpert'], ['GENEB', 'GeneXpert'], ['PNTHR', 'Hologic Panther'],
  ['PNTHB', 'Hologic Panther'], ['QS3', 'QuantStudio'], ['qs3 ', 'QuantStudio'], ['genex ', 'GeneXpert'], ['frtp', 'AB7500'], ['PnthB', 'Hologic Panther'],
  ['c6800 ', 'C6800'], ['XYZ', 'XYZ'], ['Abc ', 'Abc '], ['QS4', 'QS4'], [null, null], ['', '']];
I_MAP.forEach(([code, shown], i) => {
  vrAdd('I', `T24-I${String(i + 1).padStart(2, '0')}`, { analyzer: code }, { Instrument: shown });
});

// Family P: the panels of the VRDSS feed (line 105), with TestType and LOINC (lines 80-88). The V2 feed (line 85) has no COVII and no COVIS.
const P_PANELS = [
  ['COVID', 'PCR Based', '94500-6', true], ['COVII', 'PCR Based', '94500-6', false], ['COVIS', 'PCR Based', '94500-6', false],
  ['COVAB', 'Rapid', '94503-0', true], ['COVAG', 'Rapid', '94558-4', true], ['COVRP', 'Rapid', '94558-4', true],
  ['covab ', 'Rapid', '94503-0', true], ['CovAg', 'Rapid', '94558-4', true], ['covid ', 'PCR Based', '94500-6', true], ['covii ', 'PCR Based', '94500-6', false],
];
P_PANELS.forEach(([panel, type, loinc, inV2], i) => {
  vrAdd('P', `T24-P${String(i + 1).padStart(2, '0')}`, { panel }, { TestType: type, LOINC: loinc }, { in2: inV2 });
});
// Out of both feeds: a panel that is in no list, an empty panel, no panel.
['COVXX', '', null, 'COVIDX'].forEach((panel, i) => add24(`T24-P9${i}`, { panel }));

// Family O: the observation codes (line 106): six are in; a result on any other code is not a row. Each request holds one in-list result and one
// result on a code that is in no list; only the first is a row.
const O_CODES = ['COV2', 'COV68', 'CVGXN', 'CO751', 'CO752', 'COVRP', 'cov2 ', 'Co751', 'covrp  '];
O_CODES.forEach((code, i) => {
  vrAdd('O', `T24-O${String(i + 1).padStart(2, '0')}`, { results: [{ obs: code, text: 'Positive' }, { obs: 'COV99', text: 'Negative' }] }, {});
});
['COV99', 'CO753', 'COV', 'CVGX', 'COV2X', null, ''].forEach((code, i) => add24(`T24-O9${i}`, { results: [{ obs: code, text: 'Positive' }] }));

// Family G: Gender (lines 29-34): F, M, U, I; anything else is NULL (no ELSE).
const G_SEX = [['F', 'Female'], ['M', 'Male'], ['U', 'Unknown'], ['I', 'Indeterminate'], ['N', null], ['O', null], ['f', 'Female'], ['m ', 'Male'], ['', null],
  [null, null], ['X', null], ['u', 'Unknown'], ['i  ', 'Indeterminate']];
G_SEX.forEach(([sex, shown], i) => {
  vrAdd('G', `T24-G${String(i + 1).padStart(2, '0')}`, { patient: { sex, dob: '1990-02-03' } }, { Gender: shown });
});

// Family H: the facility and the HMIS code (VRDSS lines 45-48, 95-100).
['ZCHOM', 'ZLUSA', 'ZNOHM', 'ZBLNK', 'ZGHOS', 'ZNULL', 'ZSPAC'].forEach((fac, i) => {
  const w = where(fac);
  vrAdd('H', `T24-H0${i + 1}`, { req: fac }, { Province: w.Province, District: w.District, Facility: w.Facility, HMISCode: w.HMISCode });
});
// A facility mapped without a register row, one in no map, and no code: the left joins give empty location columns and no HMIS code.
['ZUNMP', 'ZNOMAP', null].forEach((fac, i) => {
  vrAdd('H', `T24-H1${i}`, { req: fac }, { Province: null, District: null, Facility: null, HMISCode: null }, { v2changes: { requestingfacilitycode: fac, Province: null, District: null, Location: null } });
});
// The V2 feed shows the requesting facility code; the first seven rows carry their own code.
['ZCHOM', 'ZLUSA', 'ZNOHM', 'ZBLNK', 'ZGHOS', 'ZNULL', 'ZSPAC'].forEach((fac, i) => {
  const w = where(fac);
  vrRows.H[i].v2 = v2(`T24-H0${i + 1}`, { requestingfacilitycode: fac, Province: w.Province, District: w.District, Location: w.Facility });
});

// Family L: the Testing Laboratory (lines 79, 101-103) as one name per testing code. The name is the report's display, else the register name of
// the mapped code, else the code, chosen among the rows of the run: a name that is not just the code first, then the smallest in byte order.
// The three ZLA rows have three displays (one code, case and blanks aside), so all three show the same name.
const L_ISS = '2026-06-20T08:00:00+02:00';
vrAdd('L', 'T24-L01', { perf: 'ZLA', display: 'Lab B display' }, { 'Testing Laboratory': 'Lab A display' });
vrAdd('L', 'T24-L02', { perf: 'ZLA', display: 'Lab A display', iss: L_ISS }, { 'Testing Laboratory': 'Lab A display', 'Date Result Reported': L_ISS });
vrAdd('L', 'T24-L03', { perf: 'zla ', display: 'Lab C display' }, { 'Testing Laboratory': 'Lab A display' });
vrAdd('L', 'T24-L04', { perf: 'ZLB', display: null }, { 'Testing Laboratory': 'Mapped Lab B' }); // no display: the register name of the mapped code
vrAdd('L', 'T24-L05', { perf: 'ZLC', display: null }, { 'Testing Laboratory': 'ZLC' }); // nothing else: the code
vrAdd('L', 'T24-L06', { perf: 'AAA', display: 'AAA' }, { 'Testing Laboratory': 'Zebra Lab' }); // a name that is just the code loses to another name
vrAdd('L', 'T24-L07', { perf: 'AAA', display: 'Zebra Lab' }, { 'Testing Laboratory': 'Zebra Lab' });
vrAdd('L', 'T24-L08', { perf: '', display: 'Ignored' }, { 'Testing Laboratory': null }); // a blank testing code is no lab (CE has no receiving code)
vrAdd('L', 'T24-L09', { perf: null, display: 'Ignored' }, { 'Testing Laboratory': null });
vrAdd('L', 'T24-L10', { perf: '   ', display: 'Ignored' }, { 'Testing Laboratory': null });
vrAdd('L', 'T24-L11', { perf: 'ZLD', display: '  ' }, { 'Testing Laboratory': 'ZLD' }); // a blank display is no display
vrAdd('L', 'T24-L12', { perf: 'ZLE', display: 'Display E' }, { 'Testing Laboratory': 'Display E' }); // the display beats the register name
vrAdd('L', 'T24-L13', { report: false }, {}, { in1: false, in2: false }); // no report: not final, not a row
// The window leaves L02 out, and then L02 does not name its lab: the name is the smallest of the two that are left.
const L_WINDOW_ROWS = ['T24-L01', 'T24-L03'];

// Family X: SELECT DISTINCT (line 16). Rows equal in every column are one row; SQL Server's DISTINCT ignores case and trailing blanks in text.
// Two results that map to the same text: one row. Two that map to different texts: two rows.
vrAdd('X', 'T24-X01', { results: [{ obs: 'COV2', text: 'Positive' }, { obs: 'COV68', text: 'IgG Positive' }] }, { Result: 'Positive' });
vrAdd('X', 'T24-X02', { results: [{ obs: 'COV2', text: 'Positive' }, { obs: 'COV68', text: 'Negative' }] }, { Result: 'Positive' });
vrRows.X.push({ v1: vr('T24-X02', { Result: 'Negative' }), v2: v2('T24-X02', { Result: 'Negative' }) });
// Two OBR sets of one lab number with the same patient and equal columns: one row.
const x3 = add24('T24-X03', {});
add24('T24-X03', { patient: null, patientId: x3.patientId, obr: 2 });
vrRows.X.push({ v1: vr('T24-X03'), v2: v2('T24-X03') });
// The lab number and the clinical info differ in case and trailing blanks only: one row, showing the smallest spelling of each column ('T24-X04'
// before 't24-x04 '; 'COUGH ' before 'Cough').
add24('T24-X04', { clinical: 'Cough' });
add24('t24-x04 ', { clinical: 'COUGH ' });
vrRows.X.push({ v1: vr('T24-X04', { ClinicalInfo: 'COUGH ' }), v2: v2('T24-X04') });
// Differences in a stamp or a number keep two rows (the stamps are not text to SQL Server).
add24('T24-X05', { age: 31 });
add24('T24-X05', { age: 32 });
vrRows.X.push({ v1: vr('T24-X05', { AgeinYears: 31 }), v2: v2('T24-X05', { AgeinYears: 31 }) });
vrRows.X.push({ v1: vr('T24-X05', { AgeinYears: 32 }), v2: v2('T24-X05', { AgeinYears: 32 }) });
// Stamps that differ only in the time of day are different values: two rows (a stamp is not a text that SQL Server folds, and not a date).
add24('T24-X07', { auth: '2026-05-10T08:00:00+02:00' });
add24('T24-X07', { auth: '2026-05-10T09:00:00+02:00', ana: '2026-05-11T09:00:00+02:00', eff: '2026-05-09T08:00:00+02:00' });
vrRows.X.push(
  { v1: vr('T24-X07', { 'Registered Date': '2026-05-10T08:00:00+02:00' }), v2: v2('T24-X07', { 'Registered Date': '2026-05-10T08:00:00+02:00' }) },
  { v1: vr('T24-X07', { 'Registered Date': '2026-05-10T09:00:00+02:00', 'Tested Date': '2026-05-11T09:00:00+02:00', 'Collected Date': '2026-05-09T08:00:00+02:00' }),
    v2: v2('T24-X07', { 'Registered Date': '2026-05-10T09:00:00+02:00', 'Tested Date': '2026-05-11T09:00:00+02:00', 'Collected Date': '2026-05-09T08:00:00+02:00' }) },
);
// Ages 9 and 10 sort as numbers (9 first), not as text.
add24('T24-X08', { age: 10 });
add24('T24-X08', { age: 9 });
vrRows.X.push(
  { v1: vr('T24-X08', { AgeinYears: 9 }), v2: v2('T24-X08', { AgeinYears: 9 }) },
  { v1: vr('T24-X08', { AgeinYears: 10 }), v2: v2('T24-X08', { AgeinYears: 10 }) },
);
// A missing value is a value of its own and sorts first (a number, and a text).
add24('T24-X09', { age: 5 });
add24('T24-X09', { age: null });
add24('T24-X10', { clinical: 'zebra' });
add24('T24-X10', { clinical: null });
vrRows.X.push(
  { v1: vr('T24-X09', { AgeinYears: null }), v2: v2('T24-X09', { AgeinYears: null }) },
  { v1: vr('T24-X09', { AgeinYears: 5 }), v2: v2('T24-X09', { AgeinYears: 5 }) },
  { v1: vr('T24-X10', { ClinicalInfo: null }), v2: v2('T24-X10') },
  { v1: vr('T24-X10', { ClinicalInfo: 'zebra' }), v2: null },
);
// Two final reports at two labs: two rows (the lab differs).
add24('T24-X06', { moreReports: [{ status: 'final', perf: 'ZUB' }] });
vrRows.X.push({ v1: vr('T24-X06'), v2: v2('T24-X06') });
vrRows.X.push({ v1: vr('T24-X06', { 'Testing Laboratory': 'ZUB' }), v2: v2('T24-X06', { 'Testing Laboratory': 'ZUB' }) });

// The order of the X family: by lab number, then every column in order; X02's Negative before its Positive.
const xOrdered = (which) => {
  const rows = famRows('X', which);
  const ids = [...new Set(rows.map((r) => r.Sample_ID))].sort();
  return ids.flatMap((id) => {
    const group = rows.filter((r) => r.Sample_ID === id);
    return id === 'T24-X02' ? [...group].sort((a, b) => String(a.Result).localeCompare(String(b.Result))) : group;
  });
};

// Family J: the inner joins (VRDSS lines 94, 96). No patient row, or a patient id that points nowhere: not a row. No result row: not a row. A
// report that is not final: not a row.
vrAdd('J', 'T24-J01', {}, {});
vrAdd('J', 'T24-J02', { patient: null }, {}, { in1: false, in2: false });
vrAdd('J', 'T24-J03', { patient: null, patientId: 'ghost' }, {}, { in1: false, in2: false });
vrAdd('J', 'T24-J04', { results: [] }, {}, { in1: false, in2: false });
vrAdd('J', 'T24-J05', { status: 'preliminary' }, {}, { in1: false, in2: false });
vrAdd('J', 'T24-J06', { status: 'cancelled' }, {}, { in1: false, in2: false });
vrAdd('J', 'T24-J07', { status: null }, {}, { in1: false, in2: false });
vrAdd('J', 'T24-J08', { status: 'Final  ' }, {}, {});

// Family K: V2's ct_case_id (lines 8-9): REFNO, else HOSPID when REFNO is blank. HOSPID is not sent, so a blank REFNO gives NULL. Other
// Ref Number is always NULL. The VRDSS feed has no such column.
const K_REFS = [['EP-1', 'EP-1'], [null, null], ['', null], ['   ', null], ['EP-2 ', 'EP-2 '], [' EP-3', ' EP-3']];
K_REFS.forEach(([ref, shown], i) => {
  const id = `T24-K0${i + 1}`;
  add24(id, { attrs: ref === null ? [] : [{ code: 'reference-numbers', text: ref }] });
  (vrRows.K ??= []).push({ v1: vr(id), v2: v2(id, { ct_case_id: shown }) });
});
// A reference number under another system or another code is not REFNO.
add24('T24-K07', { attrs: [{ system: 'urn:other', code: 'reference-numbers', text: 'WRONG' }, { code: 'unique-id', text: 'UQ' }] });
vrRows.K.push({ v1: vr('T24-K07'), v2: v2('T24-K07') });
// The V2 columns that come from the request: the requesting facility code, the specimen text, the date of birth.
add24('T24-K08', { req: 'ZLUSA', specimen: { received: '2026-05-09T12:00:00+02:00', code: 'SP', text: 'Sputum' }, patient: { sex: 'M', dob: '1980-12-31' } });
vrRows.K.push({
  v1: vr('T24-K08', { ...where('ZLUSA'), SpecimenCode: 'SP', SpecimenDescription: 'Sputum', Gender: 'Male', DOB: '1980-12-31' }),
  v2: v2('T24-K08', { requestingfacilitycode: 'ZLUSA', Province: 'Lusaka', District: 'Lusaka', Location: 'Chilenje Clinic', LIMSSpecimenSourceDesc: 'Sputum', Gender: 'Male', dob: '1980-12-31' }),
});
// A request with no specimen: no received stamp, no specimen columns.
add24('T24-K09', { specimen: null });
vrRows.K.push({
  v1: vr('T24-K09', { 'Received Date': null, SpecimenCode: null, SpecimenDescription: null }),
  v2: v2('T24-K09', { 'Received Date': null, LIMSSpecimenSourceDesc: null }),
});
// Registration and analysis stamps, age and clinical info come through as stored (and a missing analysis stamp is NULL).
add24('T24-K10', { ana: null, age: null, clinical: null, auth: '2026-05-10T23:30:00+02:00' });
vrRows.K.push({
  v1: vr('T24-K10', { 'Tested Date': null, AgeinYears: null, ClinicalInfo: null, 'Registered Date': '2026-05-10T23:30:00+02:00' }),
  v2: v2('T24-K10', { 'Tested Date': null, AgeinYears: null, 'Registered Date': '2026-05-10T23:30:00+02:00' }),
});

// ---- Wastewater (family S) ----
//
// A wastewater request: panel COVII, tested at ZCX (CHAZ), at the Matero Ponds site, final. The stamps are the defaults. `ww()` adds the request
// and records the rows v1 returns for it: `rows` (each a change to the default row), and whether the six-site run (`six`) and the CHAZ run (`chaz`)
// list it. A request with no rows is expected to be out of both runs.
const WW_DEF = { panel: 'COVII', perf: 'ZCX', poc: 'Lab~Matero Ponds', results: [] };
const wwRow = (id, o = {}) => ({
  requestid: id, SpecimenDateTime: DEF24.eff, RegisteredDateTime: DEF24.auth, ReceivedDatetime: DEF24.specimen.received, AnalysisDateTime: DEF24.ana,
  AuthorisedDatetime: DEF24.iss, Laboratory: 'CHAZ Laboratory', Site: 'Matero Ponds', NgeneCT: null, ORF1abCT: null, QSCT: null, MS2CT: null, Result: null, ...o,
});
// A row of `rows` may carry `_not: ['chaz']` (or 'six') when the other run does not list that row.
const wwCases = [];
const wwRows = (id, rows) => rows.map(({ _not, ...o }) => ({ ...wwRow(id, o), _not }));
const ww = (id, fixture, rows, { six = true, chaz = true } = {}) => {
  add24(id, { ...WW_DEF, ...fixture });
  wwCases.push({ id, rows: wwRows(id, rows), six, chaz });
};
// Five distinct values in the five slots (WW lines 22, 34, 46, 58, 70): a swapped code shows. The numbers read as text, the comparator with them.
ww('T24-S01', { results: [{ obs: 'QNGCT', text: '30.1' }, { obs: 'QORCT', num: 31.2 }, { obs: 'QSCT', num: 40, cmp: '>' }, { obs: 'QS2CT', coded: 'ND' }, { obs: 'CVGXN', text: 'Detected' }] },
  [{ NgeneCT: '30.1', ORF1abCT: '31.2', QSCT: '> 40', MS2CT: 'ND', Result: 'Detected' }]);
// The other lab, ZLX, is 'ZNPHRL'; only the result is there, the CTs stay NULL.
ww('T24-S02', { perf: 'ZLX', poc: 'Lab~Chelstone Ponds', results: [{ obs: 'CVGXN', text: 'Not Detected' }] }, [{ Laboratory: 'ZNPHRL', Site: 'Chelstone Ponds', Result: 'Not Detected' }], { chaz: false });
// A request with no results shows once with empty CTs (the left joins).
ww('T24-S03', { poc: 'Lab~Chunga Treatment Pl' }, [{ Site: 'Chunga Treatment Pl' }]);
// The six sites, as stored (WW line 92): truncated and padded. Each at lab ZLX.
const SITES = ['Chelstone Ponds', 'Chunga Treatment Pl', 'Kaunda Square Ponds', 'Manchinchi Treatmen', 'Mass Media Pumping ', 'Matero Ponds'];
SITES.forEach((site, i) => {
  ww(`T24-S1${i}`, { perf: 'ZLX', poc: `xx~${site}` }, [{ Laboratory: 'ZNPHRL', Site: site }], { chaz: false });
});
// Site matching ignores case and trailing blanks, and the Site column shows the text as stored.
ww('T24-S20', { perf: 'ZLX', poc: 'xx~MATERO PONDS' }, [{ Laboratory: 'ZNPHRL', Site: 'MATERO PONDS' }], { chaz: false });
ww('T24-S21', { perf: 'ZLX', poc: 'xx~Mass Media Pumping' }, [{ Laboratory: 'ZNPHRL', Site: 'Mass Media Pumping' }], { chaz: false });
ww('T24-S22', { perf: 'ZLX', poc: 'xx~Matero Ponds   ' }, [{ Laboratory: 'ZNPHRL', Site: 'Matero Ponds   ' }], { chaz: false });
// Site is the text after the FIRST '~'; with none it is the whole text, cut to LEN (trailing blanks go); leading '~' leaves the site.
ww('T24-S23', { perf: 'ZLX', poc: 'Matero Ponds' }, [{ Laboratory: 'ZNPHRL', Site: 'Matero Ponds' }], { chaz: false });
ww('T24-S24', { perf: 'ZLX', poc: 'Matero Ponds   ' }, [{ Laboratory: 'ZNPHRL', Site: 'Matero Ponds' }], { chaz: false });
ww('T24-S25', { perf: 'ZLX', poc: '~Matero Ponds' }, [{ Laboratory: 'ZNPHRL', Site: 'Matero Ponds' }], { chaz: false });
// Measured on SQL Server: substring(x, charindex + 1, len(x)) with more trailing blanks than the tilde's position cuts into the site.
ww('T24-S26', { perf: 'ZLX', poc: 'x~Matero Ponds    ' }, [{ Laboratory: 'ZNPHRL', Site: 'Matero Ponds  ' }], { chaz: false });
// Out of the six-site run: another site, a tilde inside the site, a prefix of a site, a missing or empty place. The CHAZ run keeps them (ZCX).
ww('T24-S30', { poc: 'xx~Lusaka East' }, [{ Site: 'Lusaka East' }], { six: false });
ww('T24-S31', { poc: 'a~b~Matero Ponds' }, [{ Site: 'b~Matero Ponds' }], { six: false });
ww('T24-S32', { poc: 'xx~Matero' }, [{ Site: 'Matero' }], { six: false });
ww('T24-S33', { poc: null }, [{ Site: null }], { six: false });
ww('T24-S34', { poc: '' }, [{ Site: '' }], { six: false });
// The lab (WW lines 13-16): ZCX is CHAZ, ZLX is ZNPHRL, case and blanks do not matter; any other lab, or none, is not in the view.
ww('T24-S40', { perf: 'zcx ' }, [{ Laboratory: 'CHAZ Laboratory' }]);
ww('T24-S41', { perf: 'Zlx' }, [{ Laboratory: 'ZNPHRL' }], { chaz: false });
['ZUA', 'ZCX1', null, '', 'ZCY'].forEach((perf, i) => ww(`T24-S4${i + 2}`, { perf }, []));
// The status (WW lines 22 and 82): X (cancelled) is out; final, preliminary and unknown are in; a report with no status is out.
ww('T24-S50', { status: 'final' }, [{}]);
ww('T24-S51', { status: 'preliminary' }, [{}]);
ww('T24-S52', { status: 'unknown' }, [{}]);
ww('T24-S53', { status: 'cancelled' }, []);
ww('T24-S54', { status: 'Cancelled  ' }, []);
ww('T24-S55', { status: null }, []);
ww('T24-S56', { report: false }, []);
// The panel (line 82): COVII only, case and blanks aside.
ww('T24-S57', { panel: 'covii ' }, [{}]);
ww('T24-S58', { panel: 'COVID' }, []);
ww('T24-S59', { panel: 'COVIII' }, []);
// The observation codes: one that is in no slot is not read; the codes compare ignoring case and blanks.
ww('T24-S60', { results: [{ obs: 'QS3CT', text: '99' }, { obs: 'qngct ', text: '12' }, { obs: 'QORCT1', text: '98' }] }, [{ NgeneCT: '12' }]);
// A CT row with no value (nothing in text, number or code): the slot is NULL, but the row is there.
ww('T24-S61', { results: [{ obs: 'QSCT' }] }, [{}]);
// The joins on RequestID alone (lines 87-91). Two OBR sets of one lab number (both COVII, not cancelled, at the two labs): two reg rows, and each
// joins every value of every CTE. 2 reg rows x 2 NgeneCT x 2 Result = 8 rows. The OBR sets have their own stamps.
add24('T24-S70', { ...WW_DEF, obr: 1, ana: '2026-05-11T08:00:00+02:00', results: [{ obs: 'QNGCT', text: '30' }, { obs: 'CVGXN', text: 'Detected' }] });
add24('T24-S70', { ...WW_DEF, obr: 2, ana: '2026-05-11T09:00:00+02:00', results: [{ obs: 'QNGCT', text: '31' }, { obs: 'CVGXN', text: 'Not Detected' }] });
const s70 = [];
for (const ana of ['2026-05-11T08:00:00+02:00', '2026-05-11T09:00:00+02:00']) {
  for (const ct of ['30', '31']) {
    for (const result of ['Detected', 'Not Detected']) s70.push({ AnalysisDateTime: ana, NgeneCT: ct, Result: result });
  }
}
wwCases.push({ id: 'T24-S70', six: true, chaz: true, rows: wwRows('T24-S70', s70) });
// An OBR set that is cancelled is in neither reg nor a CTE: its result is not read.
ww('T24-S71', { obr: 1, results: [{ obs: 'QNGCT', text: '40' }] }, [{ NgeneCT: '40' }]);
add24('T24-S71', { ...WW_DEF, obr: 2, status: 'cancelled', results: [{ obs: 'QNGCT', text: '99' }] });
// The lab number joins ignoring case and trailing blanks: two reg rows, and both get both values.
add24('T24-S72', { ...WW_DEF, obr: 1, results: [{ obs: 'QNGCT', text: '50' }] });
add24('t24-s72 ', { ...WW_DEF, obr: 2, results: [{ obs: 'CVGXN', text: 'D' }] });
wwCases.push({ id: 'T24-S72', six: true, chaz: true, rows: [...wwRows('T24-S72', [{ NgeneCT: '50', Result: 'D' }]), ...wwRows('t24-s72 ', [{ NgeneCT: '50', Result: 'D' }])] });
// A result on another panel (COVID) or another lab (ZUA) under the same lab number is not read.
ww('T24-S73', { obr: 1, results: [{ obs: 'QNGCT', text: '60' }] }, [{ NgeneCT: '60' }]);
add24('T24-S73', { ...WW_DEF, obr: 2, panel: 'COVID', results: [{ obs: 'QORCT', text: '61' }] });
add24('T24-S73', { ...WW_DEF, obr: 3, perf: 'ZUA', results: [{ obs: 'QSCT', text: '62' }] });
// Two values of one observation under one OBR set: two rows.
ww('T24-S74', { results: [{ obs: 'QNGCT', text: '70' }, { obs: 'QNGCT', text: '71' }] }, [{ NgeneCT: '70' }, { NgeneCT: '71' }]);
// Two reports at the two labs: one row per report, each with its own lab; the results are the request's, read once.
ww('T24-S75', { moreReports: [{ status: 'final', perf: 'ZLX' }], results: [{ obs: 'QNGCT', text: '80' }] },
  [{ NgeneCT: '80' }, { NgeneCT: '80', Laboratory: 'ZNPHRL', _not: ['chaz'] }]);
// Dates: the five stamps come through; the received stamp is the report's specimen (none here).
ww('T24-S76', { specimen: null, eff: null, iss: null, ana: null, auth: '2026-05-10T23:30:00+02:00' },
  [{ SpecimenDateTime: null, ReceivedDatetime: null, AnalysisDateTime: null, AuthorisedDatetime: null, RegisteredDateTime: '2026-05-10T23:30:00+02:00' }]);

// The window of the wastewater results: the collection date (SpecimenDateTime), both sides optional.
const WS_EFF = [
  ['T24-T01', '2026-07-01T00:30:00+02:00'], // local 07-01 (UTC 06-30): in
  ['T24-T02', '2026-07-31T23:30:00+02:00'], // local 07-31: in
  ['T24-T03', '2026-08-01T00:30:00+02:00'], // local 08-01 (UTC 07-31): out of July
  ['T24-T04', '2026-06-30T23:30:00+02:00'], // local 06-30: out of July
  ['T24-T05', null], // no collection stamp
  ['T24-T06', '2026-07'], // partial
  ['T24-T07', '2026-07-10'], // a date only
];
const wsRows = [];
WS_EFF.forEach(([id, eff]) => {
  add24(id, { ...WW_DEF, eff });
  wsRows.push([id, wwRow(id, { SpecimenDateTime: eff })]);
});
// The window is on the collection date: T08 was collected in July and authorised, analysed and registered in May; T09 the other way round.
add24('T24-T08', { ...WW_DEF, eff: '2026-07-05T10:00:00+02:00' });
wsRows.push(['T24-T08', wwRow('T24-T08', { SpecimenDateTime: '2026-07-05T10:00:00+02:00' })]);
const T09 = { eff: '2026-05-05T10:00:00+02:00', auth: '2026-07-05T10:00:00+02:00', ana: '2026-07-06T10:00:00+02:00', iss: '2026-07-07T10:00:00+02:00' };
add24('T24-T09', { ...WW_DEF, ...T09 });
wsRows.push(['T24-T09', wwRow('T24-T09', { SpecimenDateTime: T09.eff, RegisteredDateTime: T09.auth, AnalysisDateTime: T09.ana, AuthorisedDatetime: T09.iss })]);
// T10: one lab number with two OBR sets. The first was collected in July and has no results; the second in August and has NgeneCT 77. A window
// limits the rows that are listed, not the results they read (the CTEs of v1 have no window): the July run lists the first set with the 77.
const T10A = '2026-07-10T08:00:00+02:00';
const T10B = '2026-08-05T08:00:00+02:00';
add24('T24-T10', { ...WW_DEF, obr: 1, eff: T10A });
add24('T24-T10', { ...WW_DEF, obr: 2, eff: T10B, results: [{ obs: 'QNGCT', text: '77' }] });
wsRows.push(['T24-T10', wwRow('T24-T10', { SpecimenDateTime: T10A, NgeneCT: '77' })], ['T24-T10', wwRow('T24-T10', { SpecimenDateTime: T10B, NgeneCT: '77' })]);
const wsPick = (ids, only = null) => wsRows.filter(([id, row]) => ids.includes(id) && (only === null || only.includes(row.SpecimenDateTime))).map(([, row]) => row);

const strip = ({ _not, ...row }) => row;
const wwRowsFor = (flag) => wwCases.filter((c) => c[flag]).flatMap((c) => c.rows.filter((r) => !(r._not ?? []).includes(flag)).map(strip));
// The order of the S7 family: by lab number, then the stamps, the lab, the site and the five values (every output column).
const wwOrder = () => wwCases.filter((c) => c.id.startsWith('T24-S7')).flatMap((c) => c.rows.map(strip));
const SIX_ROWS = wwRowsFor('six');
const CHAZ_ROWS = wwRowsFor('chaz');

// ---- Suites ----
const BASE24 = { from: '', to: '' };
const pdShape = [['from', 'text', false], ['to', 'text', false]];
const feedShape = [['from', 'text', false], ['to', 'text', false]];
const WW_PARAMS = (extra = {}) => ({ from: '', to: '', laboratory: '', ...extra });

const suites24 = [
  // The columns, every one of them (family A). The first suite carries the fixture rows.
  ...pdFam('t24-a', [...A_ROWS], 'T24-A', NO_WINDOW, L24.setup()),
  famOrdered('t24-a-order', PD, NO_WINDOW, PD_COLUMNS, [A01_ROWS[0], A01_ROWS[1], A02, A03, A04, A05, A06[1], A06[2], A06[0], A07], 'RequestID', 'T24-A0'),
  // The panels, the status, the age groups, the priority.
  ...pdFam('t24-b', B_ROWS, 'T24-B'),
  ...pdFam('t24-c', C_ROWS, 'T24-C'),
  ...pdFam('t24-d', D_ROWS, 'T24-D'),
  ...pdFam('t24-e', E_ROWS, 'T24-E'),
  // The window on the authorised date: both sides, one side, a single day, none.
  ...pdFam('t24-w-july', wPd(W_JULY), 'T24-W', { from: '2026-07-01', to: '2026-07-31' }),
  ...pdFam('t24-w-from', wPd(W_FROM_31), 'T24-W', { from: '2026-07-31', to: '' }),
  ...pdFam('t24-w-to', wPd(W_TO_01), 'T24-W', { from: '', to: '2026-07-01' }),
  ...pdFam('t24-w-day', wPd(W_ONE_DAY), 'T24-W', { from: '2026-07-15', to: '2026-07-15' }),
  ...pdFam('t24-w-none', wPd(W_ALL), 'T24-W', NO_WINDOW),
  ...pdFam('t24-w-empty', [], 'T24-W', { from: '2030-01-01', to: '2030-12-31' }),

  // VRDSS and V2: the families.
  ...['R', 'I', 'P', 'O', 'G', 'H', 'X', 'J', 'K'].flatMap((f) => [
    fam(`t24-vr-${f.toLowerCase()}`, VR, BASE24, VR_COLUMNS, famRows(f, 'v1'), 'Sample_ID', `T24-${f}`),
    fam(`t24-v2-${f.toLowerCase()}`, V2, BASE24, V2_COLUMNS, famRows(f, 'v2'), 'Sample_ID', `T24-${f}`),
  ]),
  famOrdered('t24-vr-x-order', VR, BASE24, VR_COLUMNS, xOrdered('v1'), 'Sample_ID', 'T24-X'),
  famOrdered('t24-v2-x-order', V2, BASE24, V2_COLUMNS, xOrdered('v2'), 'Sample_ID', 'T24-X'),
  // The lab names: one per code over the rows of the run; the window can change which rows name the lab.
  fam('t24-vr-l', VR, BASE24, VR_COLUMNS, famRows('L', 'v1'), 'Sample_ID', 'T24-L'),
  fam('t24-v2-l', V2, BASE24, V2_COLUMNS, famRows('L', 'v2'), 'Sample_ID', 'T24-L'),
  fam('t24-vr-l-window', VR, MAIN_WINDOW, VR_COLUMNS,
    [vr('T24-L01', { 'Testing Laboratory': 'Lab B display' }), vr('T24-L03', { 'Testing Laboratory': 'Lab B display' }),
      vr('T24-L04', { 'Testing Laboratory': 'Mapped Lab B' }), vr('T24-L05', { 'Testing Laboratory': 'ZLC' }),
      vr('T24-L06', { 'Testing Laboratory': 'Zebra Lab' }), vr('T24-L07', { 'Testing Laboratory': 'Zebra Lab' }),
      vr('T24-L08', { 'Testing Laboratory': null }), vr('T24-L09', { 'Testing Laboratory': null }), vr('T24-L10', { 'Testing Laboratory': null }),
      vr('T24-L11', { 'Testing Laboratory': 'ZLD' }), vr('T24-L12', { 'Testing Laboratory': 'Display E' })],
    'Sample_ID', 'T24-L'),
  // The window on the authorised date: the same ten rows as the extracts.
  fam('t24-vr-w-july', VR, { from: '2026-07-01', to: '2026-07-31' }, VR_COLUMNS, wVr(W_JULY), 'Sample_ID', 'T24-W'),
  fam('t24-vr-w-from', VR, { from: '2026-07-31', to: '' }, VR_COLUMNS, wVr(W_FROM_31), 'Sample_ID', 'T24-W'),
  fam('t24-vr-w-to', VR, { from: '', to: '2026-07-01' }, VR_COLUMNS, wVr(W_TO_01), 'Sample_ID', 'T24-W'),
  fam('t24-vr-w-none', VR, NO_WINDOW, VR_COLUMNS, wVr(W_ALL), 'Sample_ID', 'T24-W'),
  fam('t24-v2-w-july', V2, { from: '2026-07-01', to: '2026-07-31' }, V2_COLUMNS, wV2(W_JULY), 'Sample_ID', 'T24-W'),
  fam('t24-v2-w-from', V2, { from: '2026-07-31', to: '' }, V2_COLUMNS, wV2(W_FROM_31), 'Sample_ID', 'T24-W'),
  fam('t24-v2-w-to', V2, { from: '', to: '2026-07-01' }, V2_COLUMNS, wV2(W_TO_01), 'Sample_ID', 'T24-W'),
  fam('t24-v2-w-none', V2, NO_WINDOW, V2_COLUMNS, wV2(W_ALL), 'Sample_ID', 'T24-W'),

  // Wastewater. The six-site run (blank, or 'Six Lusaka sites'), the CHAZ run (case and blanks aside), any other value is the six-site run.
  fam('t24-ww-six', WW, WW_PARAMS(), WW_COLUMNS, SIX_ROWS, 'requestid', 'T24-S'),
  fam('t24-ww-six-named', WW, WW_PARAMS({ laboratory: 'Six Lusaka sites' }), WW_COLUMNS, SIX_ROWS, 'requestid', 'T24-S'),
  fam('t24-ww-six-other', WW, WW_PARAMS({ laboratory: 'ZNPHRL' }), WW_COLUMNS, SIX_ROWS, 'requestid', 'T24-S'),
  fam('t24-ww-chaz', WW, WW_PARAMS({ laboratory: 'CHAZ Laboratory' }), WW_COLUMNS, CHAZ_ROWS, 'requestid', 'T24-S'),
  fam('t24-ww-chaz-fold', WW, WW_PARAMS({ laboratory: 'chaz laboratory  ' }), WW_COLUMNS, CHAZ_ROWS, 'requestid', 'T24-S'),
  famOrdered('t24-ww-order', WW, WW_PARAMS(), WW_COLUMNS, wwOrder(), 'requestid', 'T24-S7'),
  // The window on the collection date.
  fam('t24-ww-w-july', WW, WW_PARAMS({ from: '2026-07-01', to: '2026-07-31' }), WW_COLUMNS, [...wsPick(['T24-T01', 'T24-T02', 'T24-T07', 'T24-T08']), ...wsPick(['T24-T10'], [T10A])], 'requestid', 'T24-T'),
  fam('t24-ww-w-from', WW, WW_PARAMS({ from: '2026-07-31' }), WW_COLUMNS, [...wsPick(['T24-T02', 'T24-T03']), ...wsPick(['T24-T10'], [T10B])], 'requestid', 'T24-T'),
  fam('t24-ww-w-to', WW, WW_PARAMS({ to: '2026-07-01' }), WW_COLUMNS, wsPick(['T24-T01', 'T24-T04', 'T24-T09']), 'requestid', 'T24-T'),
  fam('t24-ww-w-none', WW, WW_PARAMS(), WW_COLUMNS, wsRows.map(([, row]) => row), 'requestid', 'T24-T'),
  fam('t24-ww-w-chaz', WW, WW_PARAMS({ from: '2026-07-01', to: '2026-07-31', laboratory: 'CHAZ Laboratory' }), WW_COLUMNS, [...wsPick(['T24-T01', 'T24-T02', 'T24-T07', 'T24-T08']), ...wsPick(['T24-T10'], [T10A])], 'requestid', 'T24-T'),
  fam('t24-ww-w-empty', WW, WW_PARAMS({ from: '2030-01-01', to: '2030-12-31' }), WW_COLUMNS, [], 'requestid', 'T24-'),

  // The shapes: parameters, a plain read-only SELECT and a total ORDER BY.
  shapeSuite('t24-shape-pd', PD, pdShape, ['s.request_id', 's.obr_set_id', 's.lr_id', 's.dr_id', 's.observation', 's.l_id']),
  shapeSuite('t24-shape-fl', FL, pdShape, ['s.request_id', 's.obr_set_id', 's.lr_id', 's.dr_id', 's.observation', 's.l_id']),
  shapeSuite('t24-shape-vr', VR, feedShape, ['r.sample_id', 'r.gender', 'r.age', 'r.dob', 'r.dob_type', 'r.clinical', 'r.lims_stamp', 'r.collected', 'r.spec_code', 'r.spec_desc',
    'r.received', 'r.registered', 'r.province', 'r.district', 'r.hmis', 'r.facility', 'r.tested', 'r.reported', 'r.result', 'r.instrument', 'r.lab_name', 'r.test_type',
    'r.loinc', 'r.auth_status']),
  shapeSuite('t24-shape-v2', V2, feedShape, ['r.case_id', 'r.other_ref', 'r.sample_id', 'r.requester', 'r.spec_desc', 'r.gender', 'r.dob', 'r.location1', 'r.age', 'r.lims_stamp',
    'r.collected', 'r.received', 'r.registered', 'r.province', 'r.district', 'r.facility', 'r.tested', 'r.reported', 'r.result', 'r.instrument', 'r.lab_name', 'r.test_type',
    'r.loinc', 'r.auth_status']),
  shapeSuite('t24-shape-ww', WW, [['from', 'text', false], ['to', 'text', false], ['laboratory', 'select', false]],
    ['q.request_id', 'q.specimen', 'q.registered', 'q.received', 'q.analysis', 'q.authorised', 'q.laboratory', 'q.site', 'o1.val', 'o2.val', 'o3.val', 'o4.val', 'o5.val']),
  {
    name: 't24-ww-options',
    count: 2,
    sql: `select 't24-ww-options' || chr(9) || json_build_object('v', q.v)::text from (${query(WW)?.params.find((p) => p.id === 'laboratory')?.optionsSql ?? 'select 1'}) as q(v);`,
    check(rows) {
      const got = rows.map((r) => r.v);
      return JSON.stringify(got) === JSON.stringify(['Six Lusaka sites', 'CHAZ Laboratory']) ? [] : [`expected ["Six Lusaka sites","CHAZ Laboratory"], got ${JSON.stringify(got)}`];
    },
  },
];

// ---- Group t30c (Task 30c): the shared fixes that reviewers deferred. Fixture ids start with "t30c-". ----
// Item A: every query of this area that takes dates raises an error naming the parameter for a bad date (see dateErrorSuites).
const suites30c = [];
suites30c.push(...dateErrorSuites('t30c-covid', queries(), { skip: ['COVID-19 daily line list'] }));

// ============================================================================================
// Group fx (final review, minor 2): names that differ only in case or trailing spaces. Four register rows, two places:
//   ZFXA 'Choma Clinic' / Southern / Choma        ZFXB 'CHOMA CLINIC ' / 'SOUTHERN ' / CHOMA
//   ZFXC 'ALPHA CLINIC' / Southern / Choma        ZFXD 'Alpha Clinic ' / southern / CHOMA
// "COVID-19 by source facility" merges the places on the names (line 270). A merged row shows the names of ONE of its rows, the first in
// byte order of province, district, facility: Choma Clinic shows ZFXB's names and Alpha Clinic ZFXC's. Per-column min() showed 'Southern',
// 'CHOMA', 'ALPHA CLINIC', which no row holds. One positive COVID request per register row, tested at UTH (ZUA), all in May: 1, 1, 1, 1.
// Fixture ids start with "fx-"; lab ids with "FX-".
// ============================================================================================

const FX_FACILITIES = [['ZFXA', 'Choma Clinic', 'Southern', 'Choma'], ['ZFXB', 'CHOMA CLINIC ', 'SOUTHERN ', 'CHOMA'],
  ['ZFXC', 'ALPHA CLINIC', 'Southern', 'Choma'], ['ZFXD', 'Alpha Clinic ', 'southern', 'CHOMA']];
const SETUP_FX = `${facilityRows('fx', FX_FACILITIES)}
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code) values
  ${FX_FACILITIES.map(([code], i) => `('fx-q${i + 1}', 'FX-${i + 1}', 'COVID', ${lit(DEFAULTS.auth)}, ${lit(DEFAULTS.ana)}, ${lit(code)})`).join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer) values
  ${FX_FACILITIES.map((_, i) => `('fx-d${i + 1}', 'fx-q${i + 1}', 'final', ${lit(DEFAULTS.eff)}, ${lit(DEFAULTS.iss)}, 'ZUA')`).join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value, numeric_comparator, coded_value) values
  ${FX_FACILITIES.map((_, i) => `('fx-r${i + 1}', 'fx-q${i + 1}', 'COV2', ${lit(POS_TEXT)}, null, null, null)`).join(',\n  ')};`;
const suitesFx = [
  setSuite('fx-source-names', SOURCE_STATS, { ...W, laboratory: 'UTH', show: '' }, SOURCE_COLUMNS, [
    src('Southern', 'Choma', 'ALPHA CLINIC', 2, 2, 2, 2),
    src('SOUTHERN ', 'CHOMA', 'CHOMA CLINIC ', 2, 2, 2, 2),
  ], SETUP_FX),
];

// ============================================================================================
// Group fx5 (final review, minor 5): the line list's date-time check raises while Postgres PLANS the query, so a bad value is an error even
// when no row reaches it. The bad message is cast to integer (as dateParamSql does), which Postgres folds at plan time. A cast to timestamp
// is not folded: on the empty dev warehouse a bad value gave 0 rows and no error. These suites run EXPLAIN, which plans and never runs the
// query, so only a plan-time error shows. The group has no fixture rows.
// ============================================================================================

const planOnly = (name) => (query(name) ? { ...query(name), sql: `explain ${query(name).sql}` } : undefined);
const suitesFx5 = [
  errorSuiteOf('fx5-plan-from-bad', planOnly(LINE_LIST), { ...LINE_PARAMS(EDGE_DAY), from: 'yesterday' }, badTime('from', 'yesterday')),
  errorSuiteOf('fx5-plan-to-bad', planOnly(LINE_LIST), { ...LINE_PARAMS(EDGE_DAY), to: '01/06/2026 04:00' }, badTime('to', '01/06/2026 04:00')),
  errorSuiteOf('fx5-plan-ok', planOnly(LINE_LIST), LINE_PARAMS(EDGE_DAY), null),
  // A well-formed but impossible date or time is a bad value too, refused at plan time (before, Postgres' own timestamp error came only
  // when a row reached the cast).
  errorSuiteOf('fx5-plan-feb-30', planOnly(LINE_LIST), { ...LINE_PARAMS(EDGE_DAY), from: '2026-02-30T04:00' }, badTime('from', '2026-02-30T04:00')),
  errorSuiteOf('fx5-plan-hour-25', planOnly(LINE_LIST), { ...LINE_PARAMS(EDGE_DAY), to: '2026-06-01T25:00' }, badTime('to', '2026-06-01T25:00')),
  errorSuiteOf('fx5-plan-leap-day', planOnly(LINE_LIST), { ...LINE_PARAMS(EDGE_DAY), from: '2028-02-29 04:00:30' }, null),
];

export const groups = [{ name: 't22', suites }, { name: 't23', suites: suites23 }, { name: 't24', suites: suites24 },
  { name: 't30c', suites: suites30c },
  { name: 'fx', suites: suitesFx },
  { name: 'fx5', suites: suitesFx5 },
];

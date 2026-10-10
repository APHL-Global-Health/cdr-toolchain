// Check groups for the covid reports. Each task adds { name, suites } entries to this list (t22 below, t23 at the end of the file).
//
// Group t22: COVID-19 by testing lab (sp_COV2_LabStats), COVID-19 by source facility (sp_COV2_SourceStats, with sp_COV2_PSources and
// sp_COV2_TSources) and COVID-19 positive patients (sp_COV2_PListing). Fixture ids start with "t22-"; lab numbers start with "T22-".
// "v1 line N" means a line of StoredProcedure__dbo_sp_COV2_<name>.sql: LabStats unless a case names another. The counts in LabStats and
// SourceStats are the same text (LabStats lines 21-275, SourceStats lines 21-270); PSources and TSources differ from SourceStats at line
// 274 and 268 only.

import { lit, inOrder } from '../../shared/pg-check.mjs';
import { queries } from '../queries/covid.mjs';
import { bind, facilityRows, orderedSuite } from './epi-fixture.mjs';

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

export const groups = [{ name: 't22', suites }, { name: 't23', suites: suites23 }];

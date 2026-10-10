// Check groups for the covid reports. Each task adds { name, suites } entries to this list.
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
//        = 36, 19, 19, 16. (ZUA,ZMANS) has no registration in the window and adds nothing.
//   TDRC: (ZTT,ZCHOM) 1,0,0,0 + (ZTV,ZLUSA) 1,1,1,1 = 2,1,1,1. (ZTV,ZCHOM) has no registration and ZTT's does not match its lab code.
//   Livingstone TH: ZLA and 'zlb ' = 2,2,2,2. ZNA: two registrations, no tests: Tested, Authorised and Positive are NULL (sum of nothing).
const LAB_ROWS = [
  lab('UTH', 36, 19, 19, 16),
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
  lab('TDRC', 2, 1, 1, 1), lab('UTH', 36, 19, 19, 16), lab('ZNA', 2, null, null, null), lab('ZNP', 1, 1, 1, 1), lab('ZU', 1, 1, 1, 1),
];

// COVID-19 by source facility for UTH, panel COVID only (COVII and COVIS out), window 2026-05-01 to 2026-05-31. The facility groups merge on
// the name: ZCHOM and ZCHO2 are one row, shown in the smaller spelling (upper case sorts first in byte order).
//   Choma: (ZUA,ZCHOM) 24,13,12,11 + (ZUA,ZCHO2) 1,1,1,1 = 25,14,13,12.
//   Lusaka: (ZUA,ZLUSA) 2,0,1,1 (positive and not tested). Kitwe 1,1,1,0 (tested, not positive). Ndola 1,0,0,0.
//   Mansa: (ZUB,ZMANS) 1,1,1,1 + ('ZU ',ZMANS) 1,1,1,1 = 2,2,2,2.
//   Unknown facilities: 3 registered, Tested, Authorised and Positive 0 (line 258: coalesce).
const UNKNOWN = src(null, null, null, 3, 0, 0, 0);
const KITWE = src('Copperbelt', 'Kitwe', 'Kitwe Clinic', 1, 1, 1, 0);
const NDOLA = src('Copperbelt', 'Ndola', 'Ndola Clinic', 1, 0, 0, 0);
const MANSA = src('Luapula', 'Mansa', 'Mansa Clinic', 2, 2, 2, 2);
const LUSAKA = src('Lusaka', 'Lusaka', 'Chilenje Clinic', 2, 0, 1, 1);
const CHOMA = src('SOUTHERN', 'CHOMA', 'CHOMA GENERAL HOSPITAL', 25, 14, 13, 12);
// Order: province in word order (a missing one first): Copperbelt, Luapula, Lusaka, SOUTHERN.
const UTH_ORDERED = [UNKNOWN, KITWE, NDOLA, MANSA, LUSAKA, CHOMA];

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
  setSuite('source-uth-blank', SOURCE_STATS, { ...W, laboratory: 'uth ', show: '' }, SOURCE_COLUMNS, [UNKNOWN, KITWE, NDOLA, MANSA, LUSAKA, CHOMA]),
  setSuite('source-uth-all', SOURCE_STATS, { ...W, laboratory: 'UTH', show: 'all' }, SOURCE_COLUMNS, [UNKNOWN, KITWE, NDOLA, MANSA, LUSAKA, CHOMA]),
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

export const groups = [{ name: 't22', suites }];

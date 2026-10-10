// Check groups for the tb reports. Each task adds { name, suites } entries to this list.
//
// Group t4: the tbgnx builders (v1 view v_GeneXpert, sp_getTBsLastHour, Table__dbo_TBGNX.sql).
// Fixture ids start with "t4-". Lab ids (lr.request_id) start with "T4-".
// "view line N" is a line of View__dbo_v_GeneXpert.sql. "proc line N" is a line of
// StoredProcedure__dbo_sp_getTBsLastHour.sql.

import { lit, inOrder } from '../../shared/pg-check.mjs';
import { geneXpertCte, tbgnxCte } from '../zm-sql.mjs';
import { queries } from '../queries/tb.mjs';
import { orderedSuite } from './epi-fixture.mjs';

// ---- Columns ----

// The view's output columns in snake_case, in the view's order (view lines 106 and 20-39).
const GX_COLUMNS = ['dist_tb_number', 'requestid', 'lims_facility_code', 'description', 'tested_at',
  'specimen_date_time', 'registered_date_time', 'received_date_time', 'analysis_date_time',
  'authorised_date_time', 'hl7_sex_code', 'age_in_years', 'agein_days', 'mtb', 'lims_panel_code',
  'rif', 'tbhiv', 'tbage'];
// Table__dbo_TBGNX.sql in snake_case, in the table's order.
const TB_COLUMNS = ['province', 'district', 'requestid', 'lims_facility_code', 'description', 'tested_at',
  'lab_name', 'specimen_date_time', 'registered_date_time', 'received_date_time', 'analysis_date_time',
  'authorised_date_time', 'hl7_sex_code', 'age_in_years', 'gender', 'age_group', 'agein_days', 'mtb', 'rif',
  'tbhiv', 'tbage', 'dist_tb_number', 'poc', 'tat', 'w24h', 'w48h', 'w72h'];

// ---- Fixture builder ----

const res = (mtb, rif) => [
  ...(mtb === undefined ? [] : [{ obs: 'GXMTB', text: mtb }]),
  ...(rif === undefined ? [] : [{ obs: 'GXRIF', text: rif }]),
];

const REQ_DEFAULTS = {
  panel: 'TBGNX', req: 'ZSOUT', sex: 'F', years: 30, days: 10950, status: 'final',
  authored: '2026-05-02T08:00:00Z', analysis: '2026-05-02T09:00:00Z',
  effective: '2026-05-01T07:00:00Z', issued: '2026-05-03T10:00:00Z', received: '2026-05-01T12:00:00Z',
  performer: 'LUS', display: null, report: true, patient: true, results: res('Detected', 'Not Detected'),
};
// What a default request gives in the view. Written out by hand from the v1 text.
const GX_D = {
  dist_tb_number: null, requestid: null,
  lims_facility_code: 'ZSOUT',                 // view line 23
  lab_name: 'Lusaka Provincial Lab',           // only with the labName option (ruling 8: the mapped register name)
  description: 'Choma General Hospital',       // view line 25: the dictionary description
  tested_at: 'LUS',                            // view lines 26-29: TestingFacilityCode
  specimen_date_time: '2026-05-01T07:00:00Z', registered_date_time: '2026-05-02T08:00:00Z',
  received_date_time: '2026-05-01T12:00:00Z', analysis_date_time: '2026-05-02T09:00:00Z',
  authorised_date_time: '2026-05-03T10:00:00Z',
  hl7_sex_code: 'F', age_in_years: 30, agein_days: 10950,
  mtb: 'Detected',                             // view line 38: the GXMTB result as reported
  lims_panel_code: 'TBGNX',
  rif: 'Not Detected',                         // view line 106: the GXRIF result as reported
  tbhiv: null, tbage: null,
};
// What it gives in the TBGNX table.
const TB_D = {
  province: 'Southern', district: 'Choma', requestid: null,
  lims_facility_code: 'ZSOUT', description: 'Choma General Hospital', tested_at: 'LUS',
  lab_name: 'Lusaka Provincial Lab',           // ruling 8: no display, so the mapped register name
  specimen_date_time: '2026-05-01T07:00:00Z', registered_date_time: '2026-05-02T08:00:00Z',
  received_date_time: '2026-05-01T12:00:00Z', analysis_date_time: '2026-05-02T09:00:00Z',
  authorised_date_time: '2026-05-03T10:00:00Z',
  hl7_sex_code: 'F', age_in_years: 30,
  gender: 'Female',                            // proc line 29
  age_group: '30-34',                          // proc line 43
  agein_days: 10950,
  mtb: 'MTB Detected',                         // proc line 54
  rif: 'Not Detected',                         // proc line 64
  tbhiv: null, tbage: null, dist_tb_number: null,
  poc: 0,                                      // proc line 76: panel TBGNX and 'LUS' is not a number
  tat: 51,                                     // proc line 77: datediff(HH, 05-01 07:00, 05-03 10:00)
  w24h: 0, w48h: 0, w72h: 1,                   // proc lines 78-80: 51 is under 72 only
};
// A null TAT gives 0 in all three flags (proc lines 78-80, the else branch).
const TAT_NULL = { tat: null, w24h: 0, w48h: 0, w72h: 0 };

const num = (v) => (v === null || v === undefined ? 'null' : String(v));
const pad = (n) => String(n).padStart(3, '0');
const patients = [];
const requests = [];
const reports = [];
const specimens = [];
const results = [];
const gxExpected = [];
const tbExpected = [];
let seq = 0;

// One lab id with one or more request rows (v1 Requests rows sharing a RequestID).
//   shared  overrides for the columns the view and the table have in common
//   gx      one override object per view row v1 returns (default: one row from the defaults)
//   tb      one override object per TBGNX row v1 returns (default: one row from the defaults)
function lab(labId, reqs, shared = {}, gx = [{}], tb = [{}]) {
  for (const o of reqs) {
    const r = { ...REQ_DEFAULTS, ...o };
    const n = ++seq;
    const qid = `t4-q${pad(n)}`;
    let patientId = null;
    if (r.patient) {
      patientId = `t4-p${pad(n)}`;
      patients.push(`(${lit(patientId)}, ${lit('P' + n)}, ${lit(r.sex)})`);
    }
    requests.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.authored)}, ${lit(r.analysis)}, ${lit(r.req)}, ${lit(patientId)}, ${num(r.years)}, ${num(r.days)})`);
    if (r.report) {
      const sid = r.received ? `t4-s${pad(n)}` : null;
      if (sid) specimens.push(`(${lit(sid)}, ${lit(r.received)})`);
      reports.push(`(${lit(`t4-d${pad(n)}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.effective)}, ${lit(r.issued)}, ${lit(r.performer)}, ${lit(r.display)}, ${lit(sid)})`);
    }
    r.results.forEach((x, i) => {
      results.push(`(${lit(`t4-r${pad(n)}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)}, ${num(x.num)})`);
    });
  }
  for (const g of gx) gxExpected.push({ ...GX_D, requestid: labId, ...shared, ...g });
  for (const t of tb) tbExpected.push({ ...TB_D, requestid: labId, ...shared, ...t });
}

// ---- The cases ----

// A default request: every column from the defaults.
lab('T4-BASIC', [{}]);

// The filter (view line 46): panel TBGNX or POCGT, observation GXMTB. IN compares ignoring case and
// trailing spaces. The panel code comes through as stored.
lab('T4-PANEL-POCGT', [{ panel: 'POCGT' }], {}, [{ lims_panel_code: 'POCGT' }], [{ poc: 1 }]);   // proc line 76
lab('T4-PANEL-LOWER', [{ panel: 'pocgt ' }], {}, [{ lims_panel_code: 'pocgt ' }], [{ poc: 1 }]);
lab('T4-PANEL-OTHER', [{ panel: 'HIVVL' }], {}, [], []);
lab('T4-PANEL-TBCOL-ONLY', [{ panel: 'TBCOL', results: [{ obs: 'TBHIV', text: 'Reactive' }] }], {}, [], []);
lab('T4-OBS-LOWER', [{ results: [{ obs: 'gxmtb ', text: 'Detected' }, { obs: 'gxrif ', text: 'Not Detected' }] }]);
// A GXRIF result alone makes no row: the view starts from the GXMTB rows (view line 107).
lab('T4-OBS-RIFONLY', [{ results: res(undefined, 'Detected') }], {}, [], []);
lab('T4-OBS-MTBONLY', [{ results: res('Detected') }], {}, [{ rif: null }], [{ rif: null }]);
lab('T4-OBS-OTHER', [{ results: [...res('Detected', 'Not Detected'), { obs: 'GXOTH', text: 'x' }] }]);
// The view has no status test (it reads Requests and LabResults only), so a cancelled report still shows.
lab('T4-STATUS-CANC', [{ status: 'cancelled' }]);
// No report at all: the request still shows, with no testing code, no specimen date and no authorised date.
// RIF is lost (null facts break the join) and, with no TestedAt, the TBGNX table drops the row (proc line 102).
lab('T4-NOREPORT', [{ report: false }],
  { tested_at: null, specimen_date_time: null, received_date_time: null, authorised_date_time: null, lab_name: null },
  [{ rif: null }], []);

// The MTB map (proc lines 51-62): a case on the reported text. Anything else stays as reported.
// The view keeps the raw text (view line 38).
const MTB_MAP = [
  ['Not Detected', 'MTB Not Detected'], ['Negative', 'MTB Not Detected'],
  ['Detected', 'MTB Detected'], ['Positive', 'MTB Detected'], ['Detected _ Medium', 'MTB Detected'],
  ['Detected _ Very Low', 'MTB Detected'], ['Detected _ High', 'MTB Detected'], ['Detected _ Low', 'MTB Detected'],
  ['NORES', 'No Results'],
  ['detected _ very low ', 'MTB Detected'], ['nores', 'No Results'], ['NOT detected  ', 'MTB Not Detected'],  // case, trailing spaces
  ['Error', 'Error'], ['ERR', 'ERR'], ['Invalid', 'Invalid'], ['MTB Detected', 'MTB Detected'], ['Trace', 'Trace'],
];
MTB_MAP.forEach(([text, mapped], i) => lab(`T4-MTB-${i}`, [{ results: res(text, 'Not Detected') }], {}, [{ mtb: text }], [{ mtb: mapped }]));
lab('T4-MTB-NULL', [{ results: [{ obs: 'GXMTB' }, { obs: 'GXRIF', text: 'Not Detected' }] }], {}, [{ mtb: null }], [{ mtb: null }]);
lab('T4-MTB-NUMBER', [{ results: [{ obs: 'GXMTB', num: 5 }, { obs: 'GXRIF', text: 'Not Detected' }] }], {}, [{ mtb: '5' }], [{ mtb: '5' }]);

// The RIF map (proc lines 63-70): six lists, then the text as reported. The view keeps the raw text (view line 106).
const RIF_MAP = [
  ...['DETEC', 'Detected', 'Detected _ Medium', 'Detected _ High', 'Positive', 'Resistant', 'MTB Detected', 'R'].map((t) => [t, 'Detected']),
  ...['MTB Not Detected', 'NDET', 'Negative', 'S', 'Sensitive', 'Susceptible', 'Not Detected'].map((t) => [t, 'Not Detected']),
  ...['Error', 'ERR'].map((t) => [t, 'Error']),
  ...['IND', 'Indeterminate', 'RIF Resistance INDETERMINATE', 'Intermediate'].map((t) => [t, 'Indeterminate']),
  ...['INV', 'Invalid'].map((t) => [t, 'Invalid']),
  ['NORES', 'No Results'],
  ['detected', 'Detected'], ['r ', 'Detected'], ['sensitive  ', 'Not Detected'], ['nores', 'No Results'],   // case, trailing spaces
  // Not on any list: kept as reported. 'Detected _ Low' is on the MTB list but not on the RIF list; 'DET' is on neither.
  ['Detected _ Low', 'Detected _ Low'], ['DET', 'DET'], ['Trace', 'Trace'], ['Not Reported', 'Not Reported'],
];
RIF_MAP.forEach(([text, mapped], i) => lab(`T4-RIF-${i}`, [{ results: res('Detected', text) }], {}, [{ rif: text }], [{ rif: mapped }]));

// The join of MTB to RIF (view lines 107-120) matches a GXRIF row to a GXMTB row when the request number and
// eleven request facts are equal. A NULL fact never equals anything, so the RIF is lost; the MTB row stays.
// A RIF on another request row (another panel) with the same facts joins.
lab('T4-JOIN-OTHERPANEL', [{ results: res('Detected') }, { panel: 'POCGT', results: res(undefined, 'Detected') }],
  {}, [{ rif: 'Detected' }], [{ rif: 'Detected' }]);
// A different authorised date on the RIF row (view line 117) breaks the join.
lab('T4-JOIN-DIFFISSUED', [{ results: res('Detected') }, { panel: 'POCGT', issued: '2026-05-04T10:00:00Z', results: res(undefined, 'Detected') }],
  {}, [{ rif: null }], [{ rif: null }]);
// Equality ignores case and trailing spaces (view lines 112 and 118).
lab('T4-JOIN-CASE', [{ results: res('Detected') }, { panel: 'POCGT', performer: 'lus ', sex: 'f', results: res(undefined, 'Detected') }],
  {}, [{ rif: 'Detected' }], [{ rif: 'Detected' }]);
// Each null fact loses the RIF (view lines 110-120).
lab('T4-NULL-RECEIVED', [{ received: null }], { received_date_time: null }, [{ rif: null }], [{ rif: null }]);              // view line 115
lab('T4-NULL-EFFECTIVE', [{ effective: null }], { specimen_date_time: null }, [{ rif: null }], [{ rif: null, ...TAT_NULL }]); // view line 113
lab('T4-NULL-ANALYSIS', [{ analysis: null }], { analysis_date_time: null }, [{ rif: null }], [{ rif: null }]);              // view line 116
lab('T4-NULL-AUTHORED', [{ authored: null }], { registered_date_time: null }, [{ rif: null }], [{ rif: null }]);            // view line 114
lab('T4-NULL-ISSUED', [{ issued: null }], { authorised_date_time: null }, [{ rif: null }], [{ rif: null, ...TAT_NULL }]);  // view line 117
lab('T4-NULL-SEX', [{ sex: null }], { hl7_sex_code: null }, [{ rif: null }], [{ rif: null, gender: null }]);               // view line 118
lab('T4-NULL-NOPATIENT', [{ patient: false }], { hl7_sex_code: null }, [{ rif: null }], [{ rif: null, gender: null }]);
lab('T4-NULL-YEARS', [{ years: null }], { age_in_years: null }, [{ rif: null }], [{ rif: null, age_group: null }]);         // view line 119
lab('T4-NULL-DAYS', [{ days: null }], { agein_days: null }, [{ rif: null }], [{ rif: null }]);                              // view line 120
// A facility the dictionary does not know has no Description (view line 25), so the join fails (view line 111).
// The TBGNX table keeps the row with no province or district (proc lines 96-101 are left joins).
const NOFAC = { description: null };
lab('T4-NULL-UNMAPPED', [{ req: 'ZUNMP' }], { lims_facility_code: 'ZUNMP', ...NOFAC }, [{ rif: null }], [{ rif: null, province: null, district: null }]);
lab('T4-NULL-NOFACILITY', [{ req: 'ZNONE' }], { lims_facility_code: 'ZNONE', ...NOFAC }, [{ rif: null }], [{ rif: null, province: null, district: null }]);
lab('T4-NULL-REQ', [{ req: null }], { lims_facility_code: null, ...NOFAC }, [{ rif: null }], [{ rif: null, province: null, district: null }]);
lab('T4-LUSAKA', [{ req: 'ZLUSA' }], { lims_facility_code: 'ZLUSA', description: 'Chilenje Clinic' }, [{}], [{ province: 'Lusaka', district: 'Lusaka' }]);

// Several rows are kept as v1 keeps them: no dedupe. Two GXMTB results on one request give two rows, each with the RIF.
lab('T4-TWO-MTB', [{ results: [...res('Detected'), ...res('Not Detected', 'Not Detected')] }], {},
  [{ mtb: 'Detected' }, { mtb: 'Not Detected' }], [{ mtb: 'MTB Detected' }, { mtb: 'MTB Not Detected' }]);
// Two GXRIF results make two rows for the one GXMTB row.
lab('T4-TWO-RIF', [{ results: [...res('Detected', 'Not Detected'), ...res(undefined, 'Detected')] }], {},
  [{ rif: 'Not Detected' }, { rif: 'Detected' }], [{ rif: 'Not Detected' }, { rif: 'Detected' }]);
// Two identical results stay two identical rows.
lab('T4-TWO-SAME', [{ results: [...res('Detected', 'Not Detected'), ...res('Detected')] }], {}, [{}, {}], [{}, {}]);
// Two request rows with equal facts: each GXMTB row meets both GXRIF rows (2 x 2 = 4 rows).
lab('T4-FANOUT', [
  { results: res('Detected', 'Not Detected') },
  { panel: 'POCGT', results: res('Not Detected', 'Detected') },
], {}, [
  { mtb: 'Detected', lims_panel_code: 'TBGNX', rif: 'Not Detected' },
  { mtb: 'Detected', lims_panel_code: 'TBGNX', rif: 'Detected' },
  { mtb: 'Not Detected', lims_panel_code: 'POCGT', rif: 'Not Detected' },
  { mtb: 'Not Detected', lims_panel_code: 'POCGT', rif: 'Detected' },
], [
  { mtb: 'MTB Detected', rif: 'Not Detected', poc: 0 },
  { mtb: 'MTB Detected', rif: 'Detected', poc: 0 },
  { mtb: 'MTB Not Detected', rif: 'Not Detected', poc: 1 },
  { mtb: 'MTB Not Detected', rif: 'Detected', poc: 1 },
]);
// Two request rows with different facts: each keeps its own RIF (no cross match). The second is 75 hours.
lab('T4-TWO-REQ', [
  { results: res('Detected', 'Not Detected') },
  { panel: 'POCGT', issued: '2026-05-04T10:00:00Z', results: res('Not Detected', 'Detected') },
], {}, [
  { mtb: 'Detected', rif: 'Not Detected' },
  { mtb: 'Not Detected', rif: 'Detected', lims_panel_code: 'POCGT', authorised_date_time: '2026-05-04T10:00:00Z' },
], [
  { mtb: 'MTB Detected', rif: 'Not Detected' },
  { mtb: 'MTB Not Detected', rif: 'Detected', poc: 1, authorised_date_time: '2026-05-04T10:00:00Z', tat: 75, w72h: 0 },
]);

// The TB collection answers (view lines 75-105, 121-126): TBHIV, TBAGE and PADIS of panel TBCOL, joined on the
// request number alone. TBCOL is not a documentation panel in Zambia's config (config/zambia.yaml lists only
// VIRAL), so its answers are lab results.
const TBCOL = [{ obs: 'TBHIV', text: 'Reactive' }, { obs: 'TBAGE', text: 'Adult' }, { obs: 'PADIS', text: 'DR-0042' }];
const TBCOL_ALL = { tbhiv: 'Reactive', tbage: 'Adult', dist_tb_number: 'DR-0042' };
// The TBCOL request has other facts (another testing code, another date): only the request number matters.
lab('T4-TBCOL', [{}, { panel: 'TBCOL', performer: 'XXX', issued: '2026-06-10T10:00:00Z', results: TBCOL }], TBCOL_ALL);
lab('T4-TBCOL-LOWER', [{}, { panel: 'tbcol ', results: [{ obs: 'tbhiv ', text: 'Reactive' }] }], { tbhiv: 'Reactive' });
lab('T4-TBCOL-PADIS', [{}, { panel: 'TBCOL', results: [{ obs: 'PADIS', text: 'DR-7' }] }], { dist_tb_number: 'DR-7' });
// A number is shown as text, as LIMSRptResult does.
lab('T4-TBCOL-NUM', [{}, { panel: 'TBCOL', results: [{ obs: 'PADIS', num: 1234 }] }], { dist_tb_number: '1234' });
lab('T4-TBCOL-NOVALUE', [{}, { panel: 'TBCOL', results: [{ obs: 'TBAGE' }] }], { tbage: null });
// A lab with only TBCOL results has no GXMTB row, so it shows nothing; its answers join no other lab.
lab('T4-TBCOL-ALONE', [{ panel: 'TBCOL', results: TBCOL }], {}, [], []);
// The same observation codes on a TB test request (not panel TBCOL) are not read (view lines 84, 94, 104).
lab('T4-TBCOL-WRONGPANEL', [{ results: [...res('Detected', 'Not Detected'), ...TBCOL] }]);
lab('T4-TBCOL-WRONGPANEL2', [{}, { panel: 'HIVVL', results: TBCOL }]);
// Two TBHIV answers give two rows (a left join keeps every match).
lab('T4-TBCOL-TWO', [{}, { panel: 'TBCOL', results: [{ obs: 'TBHIV', text: 'Reactive' }, { obs: 'TBHIV', text: 'Non-Reactive' }] }], {},
  [{ tbhiv: 'Reactive' }, { tbhiv: 'Non-Reactive' }], [{ tbhiv: 'Reactive' }, { tbhiv: 'Non-Reactive' }]);

// Gender (proc lines 28-34): F, M, I, U only; anything else is NULL. The compare ignores case and trailing spaces.
// The sex code comes through as stored.
const SEXES = [['F', 'Female'], ['M', 'Male'], ['I', 'Indeterminate'], ['U', 'Unknown'], ['X', null], ['O', null],
  ['N', null], ['m ', 'Male'], ['i', 'Indeterminate'], ['', null]];
SEXES.forEach(([sex, gender], i) => lab(`T4-SEX-${i}`, [{ sex }], { hl7_sex_code: sex }, [{}], [{ gender }]));

// Age groups (proc lines 35-49), by AgeInYears. A negative age is NULL (a missing age is under T4-NULL-YEARS).
const AGES = [[0, '<01'], [1, '01-04'], [4, '01-04'], [5, '05-09'], [9, '05-09'], [10, '10-14'], [14, '10-14'],
  [15, '15-19'], [19, '15-19'], [20, '20-24'], [24, '20-24'], [25, '25-29'], [29, '25-29'], [30, '30-34'],
  [34, '30-34'], [35, '35-39'], [39, '35-39'], [40, '40-44'], [44, '40-44'], [45, '45-49'], [49, '45-49'],
  [50, '50+'], [54, '50+'], [99, '50+'], [-1, null]];
AGES.forEach(([years, group]) => lab(`T4-AGE-${years}`, [{ years }], { age_in_years: years }, [{}], [{ age_group: group }]));

// TestedAt (view lines 26-29): the testing code. A blank code takes the receiving code in v1; CE does not carry it
// (ruling 7), so the port gives NULL. The TBGNX table drops TestedAt '000' (the compare ignores trailing spaces)
// and NULL (proc line 102). POC (proc line 76) is panel POCGT or a numeric TestedAt (ISNUMERIC: '1E5' counts).
// LabName: ruling 8, the report's display, else the mapped register name, else the code.
lab('T4-TA-000', [{ performer: '000' }], { tested_at: '000', lab_name: '000' }, [{}], []);
lab('T4-TA-000-SPACE', [{ performer: '000 ' }], { tested_at: '000 ', lab_name: '000 ' }, [{}], []);
lab('T4-TA-0000', [{ performer: '0000' }], { tested_at: '0000', lab_name: '0000' }, [{}], [{ poc: 1 }]);
lab('T4-TA-4567', [{ performer: '4567' }], { tested_at: '4567', lab_name: '4567' }, [{}], [{ poc: 1 }]);
lab('T4-TA-12', [{ performer: '12' }], { tested_at: '12', lab_name: '12' }, [{}], [{ poc: 1 }]);
lab('T4-TA-1E5', [{ performer: '1E5' }], { tested_at: '1E5', lab_name: '1E5' }, [{}], [{ poc: 1 }]);
lab('T4-TA-12A', [{ performer: '12A' }], { tested_at: '12A', lab_name: '12A' }, [{}], [{ poc: 0 }]);
lab('T4-TA-KIT', [{ performer: 'KIT' }], { tested_at: 'KIT', lab_name: 'KIT' }, [{}], [{}]);
lab('T4-TA-DISPLAY', [{ performer: 'KIT', display: 'Kitwe Central Lab' }], { tested_at: 'KIT', lab_name: 'Kitwe Central Lab' }, [{}], [{}]);
lab('T4-TA-DISPLAY-BLANK', [{ display: '  ' }], {}, [{}], [{}]);
lab('T4-TA-NULL', [{ performer: null }], { tested_at: null, rif: null, lab_name: null }, [{}], []);
lab('T4-TA-BLANK', [{ performer: '' }], { tested_at: null, rif: null, lab_name: '' }, [{}], []);
lab('T4-TA-SPACES', [{ performer: '  ' }], { tested_at: null, rif: null, lab_name: '  ' }, [{}], []);
// POCGT with a text code, TBGNX with a numeric code: both POC.
lab('T4-POC-PANEL', [{ panel: 'POCGT', performer: 'KIT' }], { tested_at: 'KIT', lims_panel_code: 'POCGT', lab_name: 'KIT' }, [{}], [{ poc: 1 }]);

// TAT and the 24, 48 and 72 hour flags (proc lines 77-80): datediff(HH) counts hour boundaries, not elapsed
// hours (09:59 to 10:01 is 1). The flags are "under" the limit. Local stamps keep their offset; the offsets
// cancel in the difference.
const HOURS = [
  // [label, collected, tested, tat, w24h, w48h, w72h]
  ['0', '2026-05-01T07:00:00Z', '2026-05-01T07:00:00Z', 0, 1, 1, 1],
  ['BOUNDARY', '2026-05-01T09:59:00Z', '2026-05-01T10:01:00Z', 1, 1, 1, 1],
  ['23', '2026-05-01T07:30:00Z', '2026-05-02T06:10:00Z', 23, 1, 1, 1],
  ['24', '2026-05-01T07:59:00Z', '2026-05-02T07:00:00Z', 24, 0, 1, 1],
  ['47', '2026-05-01T07:00:00Z', '2026-05-03T06:59:00Z', 47, 0, 1, 1],
  ['48', '2026-05-01T07:59:00Z', '2026-05-03T07:00:00Z', 48, 0, 0, 1],
  ['71', '2026-05-01T07:00:00Z', '2026-05-04T06:30:00Z', 71, 0, 0, 1],
  ['72', '2026-05-01T07:59:00Z', '2026-05-04T07:00:00Z', 72, 0, 0, 0],
  ['NEGATIVE', '2026-05-01T10:00:00Z', '2026-04-30T22:00:00Z', -12, 1, 1, 1],
  ['OFFSET-47', '2026-05-03T00:30:00+02:00', '2026-05-04T23:45:00+02:00', 47, 0, 1, 1],
  ['OFFSET-MIDNIGHT', '2026-05-01T23:30:00+02:00', '2026-05-02T00:10:00+02:00', 1, 1, 1, 1],
];
HOURS.forEach(([label, effective, issued, tat, w24h, w48h, w72h]) => lab(`T4-TAT-${label}`, [{ effective, issued }],
  { specimen_date_time: effective, authorised_date_time: issued }, [{}], [{ tat, w24h, w48h, w72h }]));
// A partial stamp ('2026-07') is not a date-time: TAT is NULL and the query does not fail. v1 cannot hold one.
lab('T4-TAT-PARTIAL', [{ effective: '2026-07' }], { specimen_date_time: '2026-07' }, [{}], [{ ...TAT_NULL }]);

// The window is on the authorised date (the tested date), as the TB reports filter it (cast(AuthorisedDateTime as date)).
// Window 2026-05-01 to 2026-05-31, collected 2026-04-28 10:00. TAT in hours from there.
const EDGE = { effective: '2026-04-28T10:00:00Z' };
const EDGE_SHARED = { specimen_date_time: '2026-04-28T10:00:00Z' };
const edge = (label, issued, tat, w72h) => lab(`T4-EDGE-${label}`,
  [{ ...EDGE, issued }], { ...EDGE_SHARED, authorised_date_time: issued }, [{}], [{ tat, w72h }]);
edge('IN1', '2026-05-01T00:00:00Z', 62, 1);
// A stamp with no fraction on the last day is in (fix round 1; the old text compare put it out).
edge('IN2', '2026-05-31T23:59:59Z', 805, 0);
edge('OUT1', '2026-04-30T23:59:59Z', 61, 1);
edge('OUT2', '2026-06-01T00:00:00Z', 806, 0);
// Local stamps: the window is on the local date. 00:30+02:00 on 05-01 is in (UTC would be 04-30); 23:30+02:00 on
// 05-31 is in; 00:30+02:00 on 06-01 is out (UTC would be 05-31); 23:30+02:00 on 04-30 is out.
const LOCAL = { effective: '2026-04-28T10:00:00+02:00' };
const localEdge = (label, issued, tat, w72h) => lab(`T4-EDGE-${label}`, [{ ...LOCAL, issued }],
  { specimen_date_time: '2026-04-28T10:00:00+02:00', authorised_date_time: issued }, [{}], [{ tat, w72h }]);
localEdge('TZ-IN1', '2026-05-01T00:30:00+02:00', 62, 1);
localEdge('TZ-IN2', '2026-05-31T23:30:00+02:00', 805, 0);
localEdge('TZ-OUT1', '2026-06-01T00:30:00+02:00', 806, 0);
localEdge('TZ-OUT2', '2026-04-30T23:30:00+02:00', 61, 1);
// The analysis-date window (fn_GeneXpertReport filters AnalysisDateTime, line 67). AN-IN was analysed in May and
// authorised in June; AN-OUT was analysed in June and authorised in May. TAT from 05-01 07:00: 843 and 459 hours.
lab('T4-AN-IN', [{ analysis: '2026-05-20T09:00:00Z', issued: '2026-06-05T10:00:00Z' }],
  { analysis_date_time: '2026-05-20T09:00:00Z', authorised_date_time: '2026-06-05T10:00:00Z' }, [{}], [{ tat: 843, w72h: 0 }]);
lab('T4-AN-OUT', [{ analysis: '2026-06-02T09:00:00Z', issued: '2026-05-20T10:00:00Z' }],
  { analysis_date_time: '2026-06-02T09:00:00Z', authorised_date_time: '2026-05-20T10:00:00Z' }, [{}], [{ tat: 459, w72h: 0 }]);
// A +02:00 analysis stamp near midnight: 2026-05-31T23:30:00+02:00 is on 05-31 (in); 2026-06-01T00:30:00+02:00 is out.
lab('T4-AN-TZ-IN', [{ analysis: '2026-05-31T23:30:00+02:00' }], { analysis_date_time: '2026-05-31T23:30:00+02:00' });
lab('T4-AN-TZ-OUT', [{ analysis: '2026-06-01T00:30:00+02:00' }], { analysis_date_time: '2026-06-01T00:30:00+02:00' });

const EDGE_IN = ['T4-EDGE-IN1', 'T4-EDGE-IN2', 'T4-EDGE-TZ-IN1', 'T4-EDGE-TZ-IN2'];
const EDGE_OUT = ['T4-EDGE-OUT1', 'T4-EDGE-OUT2', 'T4-EDGE-TZ-OUT1', 'T4-EDGE-TZ-OUT2'];

const SETUP = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t4-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t4-fm2', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('t4-fm3', '', '', 'ZUNMP', null, null, null, null),
  ('t4-fm4', '', '', 'LUS', 'reg-lus', 'Lusaka Provincial Lab', 'Lusaka', 'Lusaka');
insert into patients (id, surname, sex) values ${patients.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years, age_days) values ${requests.join(',\n  ')};
insert into specimens (id, received_time) values ${specimens.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, performer_display, specimen_id) values ${reports.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value, numeric_value) values ${results.join(',\n  ')};`;

// ---- Suites ----

const bind = (sqlText, params) => Object.entries(params)
  .reduce((s, [k, v]) => s.replaceAll(`{{param.${k}}}`, `'${v.replace(/'/g, "''")}'`), sqlText);

// A suite over `select * from <cte>`: column order, then the exact multiset of rows. Rows may repeat, as v1's do.
function builderSuite(name, columns, setup, cteSql, rows) {
  const key = (r) => JSON.stringify(columns.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `with ${cteSql} select ${lit(name)} || chr(9) || row_to_json(q)::text from (select * from tb) q;`,
    count: rows.length + 1,
    check(got) {
      const failures = [];
      if (got.length !== rows.length) failures.push(`expected ${rows.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), columns));
        if (Object.keys(got[0]).length !== columns.length) failures.push(`expected ${columns.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const left = new Map();
      for (const w of rows.map(key)) left.set(w, (left.get(w) ?? 0) + 1);
      for (const g of got.map(key)) {
        if (left.get(g) > 0) left.set(g, left.get(g) - 1);
        else failures.push(`unexpected row ${g}`);
      }
      for (const [w, n] of left) if (n > 0) failures.push(`missing row ${w}${n > 1 ? ` (x${n})` : ''}`);
      return failures;
    },
  };
}

// inRange compares the first ten characters of the stamp (its local date).
const inDayOf = (col) => (r, from, to) => r[col] !== null && r[col].slice(0, 10) >= from && r[col].slice(0, 10) <= to;
const inDay = inDayOf('authorised_date_time');
const inAnalysisDay = inDayOf('analysis_date_time');
const MAY = { from: '2026-05-01', to: '2026-05-31' };
const gxRows = gxExpected;
const tbRows = tbExpected;

// A builderSuite that also names lab ids that must (not) be in the result, so the JS filter is not the only judge.
function mustSuite(name, columns, setup, cteSql, rows, mustHave, mustNot) {
  const base = builderSuite(name, columns, setup, cteSql, rows);
  return {
    ...base,
    count: base.count + mustHave.length + mustNot.length,
    check(got) {
      const ids = new Set(got.map((r) => r.requestid));
      return [
        ...base.check(got),
        ...mustHave.filter((id) => !ids.has(id)).map((id) => `${id} must be in the result`),
        ...mustNot.filter((id) => ids.has(id)).map((id) => `${id} must not be in the result`),
      ];
    },
  };
}

function shapeSuite(name, build, bannedName) {
  return {
    name,
    count: 5,
    check() {
      const text = build('anyname');
      const bad = [];
      if (!text.startsWith('anyname as (')) bad.push(`must start with "anyname as (": ${text.slice(0, 30)}`);
      if (build('x').includes('{{param.')) bad.push('no window: must not mention a parameter');
      for (const half of [{ from: 'a' }, { to: 'b' }]) {
        try { build('x', half); bad.push(`half a window ${JSON.stringify(half)} must throw`); } catch { /* expected */ }
      }
      const windowed = build('x', { from: 'a', to: 'b' });
      if (!windowed.includes('{{param.a}}') || !windowed.includes('{{param.b}}')) bad.push('window: must use the given parameter names');
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(text.replace(/'(?:[^']|'')*'/g, "''"))) bad.push(`${bannedName}: banned word or comment marker`);
      return bad;
    },
  };
}

const suites = [
  builderSuite('gx-all', GX_COLUMNS, SETUP, geneXpertCte('tb'), gxRows),
  builderSuite('gx-window', GX_COLUMNS, '', bind(geneXpertCte('tb', { from: 'from', to: 'to' }), MAY),
    gxRows.filter((r) => inDay(r, MAY.from, MAY.to))),
  builderSuite('tbgnx-all', TB_COLUMNS, '', tbgnxCte('tb'), tbRows),
  builderSuite('tbgnx-window', TB_COLUMNS, '', bind(tbgnxCte('tb', { from: 'from', to: 'to' }), MAY),
    tbRows.filter((r) => inDay(r, MAY.from, MAY.to))),
  // Other parameter names, and a one-day window.
  builderSuite('tbgnx-window-names', TB_COLUMNS, '', bind(tbgnxCte('tb', { from: 'start', to: 'end' }), { start: '2026-05-03', end: '2026-05-03' }),
    tbRows.filter((r) => inDay(r, '2026-05-03', '2026-05-03'))),
  builderSuite('gx-window-names', GX_COLUMNS, '', bind(geneXpertCte('tb', { from: 'start', to: 'end' }), { start: '2026-05-03', end: '2026-05-03' }),
    gxRows.filter((r) => inDay(r, '2026-05-03', '2026-05-03'))),
  // The window on the analysis date (fn_GeneXpertReport). AN-IN and AN-OUT tell the two window columns apart;
  // the two TZ rows pin the local date.
  mustSuite('gx-window-analysis', GX_COLUMNS, '', bind(geneXpertCte('tb', { from: 'from', to: 'to', on: 'analysis_at' }), MAY),
    gxRows.filter((r) => inAnalysisDay(r, MAY.from, MAY.to)), ['T4-AN-IN', 'T4-AN-TZ-IN'], ['T4-AN-OUT', 'T4-AN-TZ-OUT']),
  mustSuite('gx-window-issued-explicit', GX_COLUMNS, '', bind(geneXpertCte('tb', { from: 'from', to: 'to', on: 'issued' }), MAY),
    gxRows.filter((r) => inDay(r, MAY.from, MAY.to)), ['T4-AN-OUT'], ['T4-AN-IN']),
  // The labName option adds lab_name as a last column (fn_GeneXpertReport outputs LabName).
  builderSuite('gx-lab-name', [...GX_COLUMNS, 'lab_name'], '', geneXpertCte('tb', { labName: true }), gxRows),
  builderSuite('gx-lab-name-window', [...GX_COLUMNS, 'lab_name'], '', bind(geneXpertCte('tb', { from: 'from', to: 'to', on: 'analysis_at', labName: true }), MAY),
    gxRows.filter((r) => inAnalysisDay(r, MAY.from, MAY.to))),
  {
    name: 'gx-options',
    count: 3,
    check() {
      const bad = [];
      try { geneXpertCte('x', { from: 'a', to: 'b', on: 'authorised' }); bad.push('an unknown window column must throw'); } catch { /* expected */ }
      if (geneXpertCte('x').includes('r.lab_name')) bad.push('lab_name must be off by default');
      if (!geneXpertCte('x', { labName: true }).includes('r.tbage, r.lab_name')) bad.push('labName must add the last column');
      return bad;
    },
  },
  {
    // The window filter above is plain JS: pin it to the edge cases written by hand.
    name: 'window-edges',
    count: EDGE_IN.length + EDGE_OUT.length,
    check() {
      const inWin = new Set(tbRows.filter((r) => inDay(r, MAY.from, MAY.to)).map((r) => r.requestid));
      return [
        ...EDGE_IN.filter((id) => !inWin.has(id)).map((id) => `${id} must be in the window`),
        ...EDGE_OUT.filter((id) => inWin.has(id)).map((id) => `${id} must be outside the window`),
      ];
    },
  },
  shapeSuite('gx-shape', geneXpertCte, 'geneXpertCte'),
  shapeSuite('tbgnx-shape', tbgnxCte, 'tbgnxCte'),
];

// ============================================================================================
// Group t15: "TB GeneXpert dashboard summary" (v1 sp_dash_getTBGNX), "TB GeneXpert by facility, sex and age"
// (v1 sp_dash_getTBGNX_List) and "TB GeneXpert monthly trend" (v1 sp_dash_getMonthlyTBTrend). Fixture ids start with
// "t15-"; lab ids (lr.request_id) start with "T15-". "TBGNX line N" is a line of StoredProcedure__dbo_sp_dash_getTBGNX.sql,
// "List line N" of ...getTBGNX_List.sql, "Trend line N" of ...getMonthlyTBTrend.sql, "proc line N" of sp_getTBsLastHour.
//
// Windows. TBGNX (line 21) and List (line 21) move the end date one day forward and compare cast(AuthorisedDateTime as date),
// so the whole day after `to` counts, on the LOCAL date of the stamp. Trend (lines 20-22) is cast to date with no extra day.
//
// Where the expected rows come from. FACTS15 holds, for every row the TBGNX table would hold, the facts written out by hand from
// sp_getTBsLastHour (gender, age group, cleaned MTB and RIF, hours, POC, the three flags, the local authorised date). The
// aggregate formulas of v1 are then written once in JS (metrics15) and applied to the facts of each window. Two hand-worked
// suites pin that JS: they compare it with totals worked out by hand on paper for the biggest groups (hand-totals, hand-groups).
// The trend rows are all written by hand.
// ============================================================================================

const P15 = [];
const R15 = [];
const S15 = [];
const D15 = [];
const L15 = [];
const FACTS15 = [];
let n15 = 0;
const nz15 = (v) => (v === null || v === undefined ? 'null' : String(v));

// The areas: [province, district, facility] as the register rows spell them. UNM is a facility that is not in the register
// (no province, no district, no description). MRG is a second register row for Choma General Hospital that differs in case and in
// a trailing space: SQL Server groups it with the first.
const AREA15 = {
  CGH: ['Southern', 'Choma', 'Choma General Hospital'],
  CCL: ['Southern', 'Choma', 'Choma Clinic'],
  MAZ: ['Southern', 'Mazabuka', 'Mazabuka Hospital'],
  CHI: ['Lusaka', 'Lusaka', 'Chilenje Clinic'],
  KAF: ['Lusaka', 'Kafue', 'Kafue District Hospital'],
  UNM: [null, null, null],
  MRG: ['SOUTHERN', 'choma', 'CHOMA GENERAL HOSPITAL '],
};
// The facts of one TBGNX row: gender and age are the table's (null when missing), mtb and rif the cleaned texts, tat the hours
// (null when a stamp is partial), poc 0 or 1, w the three flags, auth the LOCAL date of the authorised stamp.
const fact15 = (area, gender, age, mtb, rif, tat, poc, w, auth) => {
  const [province, district, facility] = AREA15[area];
  return { province, district, facility, gender, age, mtb, rif, tat, poc, w24: w[0], w48: w[1], w72: w[2], auth };
};

// One request: `o` holds req (facility code), panel, sex (none: no patient), age (years), mtb (one GXMTB text per result), rif
// (the GXRIF text), eff (specimen date), iss (authorised date), perf (testing code). Every request has a specimen with a received
// time and a registered and an analysis time, so the RIF joins its MTB (a missing fact would lose the RIF, view lines 107-120).
// `facts` is the list of TBGNX rows it gives (a request with two GXMTB results gives two).
function tb15(labId, o, facts) {
  const k = String(++n15).padStart(2, '0');
  const qid = `t15-q${k}`;
  let pid = null;
  if (o.sex) {
    pid = `t15-p${k}`;
    P15.push(`(${lit(pid)}, ${lit('P' + k)}, ${lit(o.sex)})`);
  }
  R15.push(`(${lit(qid)}, ${lit(labId)}, ${lit(o.panel ?? 'TBGNX')}, '2026-04-01T08:00:00Z', '2026-04-01T09:00:00Z', ${lit(o.req)}, ${lit(pid)}, ${nz15(o.age)}, 10000)`);
  const sid = `t15-s${k}`;
  S15.push(`(${lit(sid)}, '2026-04-01T12:00:00Z')`);
  D15.push(`(${lit(`t15-d${k}`)}, ${lit(qid)}, 'final', ${lit(o.eff)}, ${lit(o.iss)}, ${lit(o.perf ?? 'LUS')}, ${lit(sid)})`);
  o.mtb.forEach((t, i) => L15.push(`(${lit(`t15-r${k}-m${i + 1}`)}, ${lit(qid)}, 'GXMTB', ${lit(t)})`));
  if (o.rif !== undefined && o.rif !== null) L15.push(`(${lit(`t15-r${k}-r`)}, ${lit(qid)}, 'GXRIF', ${lit(o.rif)})`);
  for (const f of facts) FACTS15.push({ id: labId, ...f });
}

// ---- The cases ----
// Each comment gives what sp_getTBsLastHour makes of the row. tat is datediff(hh) on the specimen and authorised times (proc
// line 77), the flags are "under 24, 48, 72" (lines 78-80), POC is the panel POCGT or a numeric testing code (line 76).

// Choma General Hospital (ZSOUT): the 10 rows of the first ten in the hand totals below.
tb15('T15-A1', { req: 'ZSOUT', sex: 'F', age: 0, mtb: ['Detected'], rif: 'Detected', eff: '2026-05-01T08:00:00Z', iss: '2026-05-02T08:00:00Z' },
  [fact15('CGH', 'Female', '<01', 'MTB Detected', 'Detected', 24, 0, [0, 1, 1], '2026-05-02')]);                // 24 hours is not under 24
tb15('T15-A2', { req: 'ZSOUT', sex: 'M', age: 3, mtb: ['Positive'], rif: 'IND', eff: '2026-05-03T00:00:00Z', iss: '2026-05-03T10:00:00Z' },
  [fact15('CGH', 'Male', '01-04', 'MTB Detected', 'Indeterminate', 10, 0, [1, 1, 1], '2026-05-03')]);
tb15('T15-A3', { req: 'ZSOUT', sex: 'F', age: 25, mtb: ['Negative'], rif: 'Not Detected', eff: '2026-05-05T08:00:00Z', iss: '2026-05-08T09:00:00Z', perf: '4567' },
  [fact15('CGH', 'Female', '25-29', 'MTB Not Detected', 'Not Detected', 73, 1, [0, 0, 0], '2026-05-08')]);      // POC: numeric code
tb15('T15-A4', { req: 'ZSOUT', panel: 'POCGT', sex: 'M', age: 60, mtb: ['Error'], rif: 'ERR', eff: '2026-05-10T12:00:00Z', iss: '2026-05-11T11:00:00Z' },
  [fact15('CGH', 'Male', '50+', 'Error', 'Error', 23, 1, [1, 1, 1], '2026-05-11')]);                              // POC: panel POCGT
tb15('T15-A5', { req: 'ZSOUT', sex: 'I', age: 12, mtb: ['Invalid'], rif: 'INV', eff: '2026-05-12T00:00:00Z', iss: '2026-05-12T05:00:00Z' },
  [fact15('CGH', 'Indeterminate', '10-14', 'Invalid', 'Invalid', 5, 0, [1, 1, 1], '2026-05-12')]);
tb15('T15-A6', { req: 'ZSOUT', sex: 'U', age: 33, mtb: ['NORES'], rif: 'NORES', eff: '2026-05-15T00:00:00Z', iss: '2026-05-17T00:00:00Z' },
  [fact15('CGH', 'Unknown', '30-34', 'No Results', 'No Results', 48, 0, [0, 0, 1], '2026-05-17')]);
// No patient and no age: gender and age group are NULL. The missing sex and age break the RIF join, so the RIF is NULL.
tb15('T15-A7', { req: 'ZSOUT', mtb: ['Detected'], rif: 'Detected', eff: '2026-05-20T00:00:00Z', iss: '2026-05-20T06:00:00Z' },
  [fact15('CGH', null, null, 'MTB Detected', null, 6, 0, [1, 1, 1], '2026-05-20')]);
// 'Detected_Low' is on no list of the clean-up, so it stays as reported, and v1's RIF_Positive list has exactly that spelling.
tb15('T15-A8', { req: 'ZSOUT', sex: 'F', age: 50, mtb: ['Detected'], rif: 'Detected_Low', eff: '2026-05-21T00:00:00Z', iss: '2026-05-21T01:00:00Z' },
  [fact15('CGH', 'Female', '50+', 'MTB Detected', 'Detected_Low', 1, 0, [1, 1, 1], '2026-05-21')]);
// Two GXMTB results on one request make two rows (no dedupe in v1): one MTB Detected, one MTB Not Detected, each with the RIF.
tb15('T15-A9', { req: 'ZSOUT', sex: 'F', age: 5, mtb: ['Detected', 'Negative'], rif: 'Detected', eff: '2026-05-22T00:00:00Z', iss: '2026-05-23T00:00:00Z' }, [
  fact15('CGH', 'Female', '05-09', 'MTB Detected', 'Detected', 24, 0, [0, 1, 1], '2026-05-23'),
  fact15('CGH', 'Female', '05-09', 'MTB Not Detected', 'Detected', 24, 0, [0, 1, 1], '2026-05-23'),
]);
// Choma Clinic (ZCHO2).
tb15('T15-B1', { req: 'ZCHO2', sex: 'M', age: 8, mtb: ['Detected _ High'], rif: 'Resistant', eff: '2026-05-02T00:00:00Z', iss: '2026-05-04T12:00:00Z' },
  [fact15('CCL', 'Male', '05-09', 'MTB Detected', 'Detected', 60, 0, [0, 0, 1], '2026-05-04')]);
// 'Detected _ Low' (with spaces) is not on the RIF list of the clean-up and not 'Detected_Low' either: it stays and is not positive.
tb15('T15-B2', { req: 'ZCHO2', sex: 'F', age: 17, mtb: ['Detected'], rif: 'Detected _ Low', eff: '2026-05-06T00:00:00Z', iss: '2026-05-06T03:00:00Z', perf: '12' },
  [fact15('CCL', 'Female', '15-19', 'MTB Detected', 'Detected _ Low', 3, 1, [1, 1, 1], '2026-05-06')]);
tb15('T15-B3', { req: 'ZCHO2', panel: 'POCGT', sex: 'F', age: 44, mtb: ['Negative'], rif: 'S', eff: '2026-05-09T00:00:00Z', iss: '2026-05-10T00:00:00Z' },
  [fact15('CCL', 'Female', '40-44', 'MTB Not Detected', 'Not Detected', 24, 1, [0, 1, 1], '2026-05-10')]);
// Mazabuka Hospital (ZMAZA): no POC test.
tb15('T15-C1', { req: 'ZMAZA', sex: 'M', age: 22, mtb: ['Detected'], rif: 'DETEC', eff: '2026-05-04T00:00:00Z', iss: '2026-05-05T00:00:00Z' },
  [fact15('MAZ', 'Male', '20-24', 'MTB Detected', 'Detected', 24, 0, [0, 1, 1], '2026-05-05')]);
tb15('T15-C2', { req: 'ZMAZA', sex: 'M', age: 22, mtb: ['Detected'], rif: 'Intermediate', eff: '2026-05-04T00:00:00Z', iss: '2026-05-04T20:00:00Z' },
  [fact15('MAZ', 'Male', '20-24', 'MTB Detected', 'Indeterminate', 20, 0, [1, 1, 1], '2026-05-04')]);
// Chilenje Clinic (ZLUSA): stamps with +02:00 near midnight. The local date decides the window, the UTC instant decides the hours.
// D1: 05-31T23:30+02:00 is 21:30Z, 45 hours from 05-30T00:00Z. Local date 05-31.
tb15('T15-D1', { req: 'ZLUSA', sex: 'F', age: 29, mtb: ['Detected'], rif: 'Detected', eff: '2026-05-30T00:00:00Z', iss: '2026-05-31T23:30:00+02:00' },
  [fact15('CHI', 'Female', '25-29', 'MTB Detected', 'Detected', 45, 0, [0, 1, 1], '2026-05-31')]);
// D2: 06-01T00:30+02:00 is 05-31T22:30Z (46 hours). Local date 06-01, the extra day of the dashboards; the UTC date would say 05-31.
tb15('T15-D2', { req: 'ZLUSA', sex: 'M', age: 29, mtb: ['Negative'], rif: 'Not Detected', eff: '2026-05-30T00:00:00Z', iss: '2026-06-01T00:30:00+02:00' },
  [fact15('CHI', 'Male', '25-29', 'MTB Not Detected', 'Not Detected', 46, 0, [0, 1, 1], '2026-06-01')]);
// D3: 06-02T00:30+02:00 is 06-01T22:30Z (70 hours). Local date 06-02: past the extra day of a window that ends 05-31.
tb15('T15-D3', { req: 'ZLUSA', sex: 'F', age: 29, mtb: ['Detected'], rif: 'Detected', eff: '2026-05-30T00:00:00Z', iss: '2026-06-02T00:30:00+02:00' },
  [fact15('CHI', 'Female', '25-29', 'MTB Detected', 'Detected', 70, 0, [0, 0, 1], '2026-06-02')]);
// D4: 05-01T00:30+02:00 is 04-30T22:30Z (46 hours from 04-29T00:00Z). Local date 05-01; the UTC date would say 04-30.
tb15('T15-D4', { req: 'ZLUSA', sex: 'M', age: 40, mtb: ['Detected'], rif: 'Detected', eff: '2026-04-29T00:00:00Z', iss: '2026-05-01T00:30:00+02:00' },
  [fact15('CHI', 'Male', '40-44', 'MTB Detected', 'Detected', 46, 0, [0, 1, 1], '2026-05-01')]);
// D5: 04-30T23:30Z, local 04-30 (71 hours from 04-28T00:00Z).
tb15('T15-D5', { req: 'ZLUSA', sex: 'F', age: 41, mtb: ['Negative'], rif: 'Negative', eff: '2026-04-28T00:00:00Z', iss: '2026-04-30T23:30:00Z' },
  [fact15('CHI', 'Female', '40-44', 'MTB Not Detected', 'Not Detected', 71, 0, [0, 0, 1], '2026-04-30')]);
// Kafue District Hospital (ZKAFU): a POC test (numeric code).
tb15('T15-E1', { req: 'ZKAFU', sex: 'F', age: 36, mtb: ['Detected'], rif: 'Detected', eff: '2026-05-12T00:00:00Z', iss: '2026-05-14T00:00:00Z', perf: '5551' },
  [fact15('KAF', 'Female', '35-39', 'MTB Detected', 'Detected', 48, 1, [0, 0, 1], '2026-05-14')]);
// A facility that is not in the register: no province, district or description. The row stays (left join), the RIF is lost.
tb15('T15-U1', { req: 'ZUNMP', sex: 'F', age: 30, mtb: ['Detected'], rif: 'Detected', eff: '2026-05-10T00:00:00Z', iss: '2026-05-10T12:00:00Z' },
  [fact15('UNM', 'Female', '30-34', 'MTB Detected', null, 12, 0, [1, 1, 1], '2026-05-10')]);
// Other months, for the trend. Y1: December. Y2: local 2026-01-01 (UTC 2025-12-31) is January.
tb15('T15-Y1', { req: 'ZSOUT', sex: 'M', age: 70, mtb: ['Negative'], rif: 'Negative', eff: '2025-12-14T10:00:00Z', iss: '2025-12-15T10:00:00Z' },
  [fact15('CGH', 'Male', '50+', 'MTB Not Detected', 'Not Detected', 24, 0, [0, 1, 1], '2025-12-15')]);
tb15('T15-Y2', { req: 'ZSOUT', sex: 'F', age: 70, mtb: ['Detected'], rif: 'Detected', eff: '2025-12-31T00:00:00Z', iss: '2026-01-01T00:30:00+02:00' },
  [fact15('CGH', 'Female', '50+', 'MTB Detected', 'Detected', 22, 0, [1, 1, 1], '2026-01-01')]);
// Negative hours (authorised before the specimen): inside every "under" flag, and the average cuts toward zero. N1 -2, N2 -1.
tb15('T15-N1', { req: 'ZKAFU', sex: 'F', age: 36, mtb: ['Detected'], rif: 'Detected', eff: '2026-06-10T10:00:00Z', iss: '2026-06-10T08:00:00Z' },
  [fact15('KAF', 'Female', '35-39', 'MTB Detected', 'Detected', -2, 0, [1, 1, 1], '2026-06-10')]);
tb15('T15-N2', { req: 'ZKAFU', sex: 'M', age: 36, mtb: ['Negative'], rif: 'Negative', eff: '2026-06-11T10:00:00Z', iss: '2026-06-11T09:00:00Z' },
  [fact15('KAF', 'Male', '35-39', 'MTB Not Detected', 'Not Detected', -1, 0, [1, 1, 1], '2026-06-11')]);
// Partial stamps (July). P1: the authorised date is '2026-07', which is not a date, so the row is in no window (as text it would
// sit inside a window of 07-01 to 07-31). P2: a partial specimen date, so the hours are NULL and the three flags are 0. P3 is whole.
tb15('T15-P1', { req: 'ZSOUT', sex: 'F', age: 30, mtb: ['Detected'], rif: 'Detected', eff: '2026-07-09T00:00:00Z', iss: '2026-07' }, []);
tb15('T15-P2', { req: 'ZSOUT', sex: 'M', age: 30, mtb: ['Detected'], rif: 'Not Detected', eff: '2026-07', iss: '2026-07-10T10:00:00Z' },
  [fact15('CGH', 'Male', '30-34', 'MTB Detected', 'Not Detected', null, 0, [0, 0, 0], '2026-07-10')]);
tb15('T15-P3', { req: 'ZSOUT', sex: 'F', age: 30, mtb: ['Negative'], rif: 'Negative', eff: '2026-07-09T00:00:00Z', iss: '2026-07-10T00:00:00Z' },
  [fact15('CGH', 'Female', '30-34', 'MTB Not Detected', 'Not Detected', 24, 0, [0, 1, 1], '2026-07-10')]);
// August: one facility under two register rows that differ in case and a trailing space (ZSOUT and ZSOU2). SQL Server groups
// them as one. Z1 and Z2 are both Female 30-34.
tb15('T15-Z1', { req: 'ZSOUT', sex: 'F', age: 30, mtb: ['Detected'], rif: 'Detected', eff: '2026-08-09T10:00:00Z', iss: '2026-08-10T10:00:00Z' },
  [fact15('CGH', 'Female', '30-34', 'MTB Detected', 'Detected', 24, 0, [0, 1, 1], '2026-08-10')]);
tb15('T15-Z2', { req: 'ZSOU2', sex: 'F', age: 30, mtb: ['Negative'], rif: 'Negative', eff: '2026-08-11T10:00:00Z', iss: '2026-08-12T10:00:00Z' },
  [fact15('MRG', 'Female', '30-34', 'MTB Not Detected', 'Not Detected', 24, 0, [0, 1, 1], '2026-08-12')]);

// September: one-sided measure rules (fix round 1). Every row is Choma General Hospital, Female, 30-34, 24 hours (flags 0, 1, 1),
// not POC. Each row has ONE bad side and a clean other side, so that `or` (TBGNX lines 28-30) and not `and` is what counts.
// Cleaned texts are written out from sp_getTBsLastHour lines 51-70: 'Error', 'Invalid' and '' on the MTB side are on no list and stay;
// 'ERR' gives 'Error', 'INV' gives 'Invalid', 'NORES' gives 'No Results' on the RIF side (and 'NORES' on the MTB side too);
// 'DET' is on no RIF list, so it stays 'DET' and is on v1's RIF_Positive list (line 26); 'detected_low ' (lower case, a trailing
// space) is on no clean-up list and equals 'Detected_Low' under the collation; '' stays ''.
const SEPT15 = [
  // [lab id, GXMTB text, GXRIF text, cleaned mtb, cleaned rif]
  ['S1', 'Error', 'Not Detected', 'Error', 'Not Detected'],                   // Errors by the MTB side alone
  ['S2', 'Negative', 'ERR', 'MTB Not Detected', 'Error'],                     // Errors by the RIF side alone
  ['S3', 'Invalid', 'Not Detected', 'Invalid', 'Not Detected'],               // Invalids by the MTB side alone
  ['S4', 'Negative', 'INV', 'MTB Not Detected', 'Invalid'],                   // Invalids by the RIF side alone
  ['S5', 'NORES', 'Not Detected', 'No Results', 'Not Detected'],              // NoResults by the MTB side alone
  ['S6', 'Negative', 'NORES', 'MTB Not Detected', 'No Results'],              // NoResults by the RIF side alone
  ['S7', 'Negative', 'DET', 'MTB Not Detected', 'DET'],                       // RIF positive by 'DET'; not MTB positive, so not in RIF_RES_Rate
  ['S8', 'Detected', 'DET', 'MTB Detected', 'DET'],                           // MTB positive and RIF 'DET': counts in RIF_RES_Rate
  ['S9', 'Negative', 'detected_low ', 'MTB Not Detected', 'detected_low '],   // RIF positive by case and trailing space
  ['S10', 'Negative', '', 'MTB Not Detected', ''],                            // NoResults by a blank RIF
  ['S11', '', 'Not Detected', '', 'Not Detected'],                            // NoResults by a blank MTB
  ['S12', 'Negative', 'Not Detected', 'MTB Not Detected', 'Not Detected'],    // clean: counts in Tests only
];
SEPT15.forEach(([id, mtbText, rifText, mtb, rif], i) => {
  const day = String(i + 2).padStart(2, '0');
  const before = String(i + 1).padStart(2, '0');
  tb15(`T15-${id}`, { req: 'ZSOUT', sex: 'F', age: 30, mtb: [mtbText], rif: rifText, eff: `2026-09-${before}T00:00:00Z`, iss: `2026-09-${day}T00:00:00Z` },
    [fact15('CGH', 'Female', '30-34', mtb, rif, 24, 0, [0, 1, 1], `2026-09-${day}`)]);
});

const SETUP15 = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t15-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t15-fm2', '', '', 'ZCHO2', 'reg-c', 'Choma Clinic', 'Southern', 'Choma'),
  ('t15-fm3', '', '', 'ZMAZA', 'reg-m', 'Mazabuka Hospital', 'Southern', 'Mazabuka'),
  ('t15-fm4', '', '', 'ZLUSA', 'reg-l', 'Chilenje Clinic', 'Lusaka', 'Lusaka'),
  ('t15-fm5', '', '', 'ZKAFU', 'reg-k', 'Kafue District Hospital', 'Lusaka', 'Kafue'),
  ('t15-fm6', '', '', 'ZUNMP', null, null, null, null),
  ('t15-fm7', '', '', 'ZSOU2', 'reg-s2', 'CHOMA GENERAL HOSPITAL ', 'SOUTHERN', 'choma');
insert into patients (id, surname, sex) values ${P15.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years, age_days) values ${R15.join(',\n  ')};
insert into specimens (id, received_time) values ${S15.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, specimen_id) values ${D15.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value) values ${L15.join(',\n  ')};`;

// ---- v1's formulas, once, in JS ----

// SQL Server compares text ignoring case and trailing spaces.
const down15 = (s) => (s === null || s === undefined ? null : String(s).replace(/ +$/, '').toLowerCase());
const same15 = (value, param) => param === '' || (down15(value) !== null && down15(value) === down15(param));
const inList15 = (value, words) => down15(value) !== null && words.some((w) => down15(value) === down15(w));
const plusDay15 = (day, n) => {
  const t = new Date(`${day}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
// The facts in a window of local authorised dates, and in an area. `extra` is the days added to the end (1 for the dashboards).
const pick15 = (from, to, extra, province = '', district = '', facility = '') => FACTS15.filter((r) =>
  r.auth >= from && r.auth <= plusDay15(to, extra)
  && same15(r.province, province) && same15(r.district, district) && same15(r.facility, facility));

const isMtb15 = (r) => inList15(r.mtb, ['MTB Detected']);
const isRif15 = (r) => inList15(r.rif, ['Detected', 'DET', 'Detected_Low']);                      // TBGNX line 26
const isInd15 = (r) => inList15(r.rif, ['Indeterminate']);
const isErr15 = (r) => inList15(r.mtb, ['Error']) || inList15(r.rif, ['Error']);
const isInv15 = (r) => inList15(r.mtb, ['Invalid']) || inList15(r.rif, ['Invalid']);
const isNoRes15 = (r) => inList15(r.mtb, ['No Results', '']) || inList15(r.rif, ['No Results', '']);

const METRICS15 = ['Tests', 'MTB_Positive', 'RIF_Positive', 'RIF_Indeterminate', 'Errors', 'Invalids', 'NoResults', 'MTB_Positivity',
  'RIF_RES_Rate', 'RIF_IND_Rate', 'Error_Rate', 'Invalid_Rate', 'No_Result_Rate', 'AverageTAT', 'AverageTAT_POC', 'TATW24H', 'TATW48H',
  'TATW72H', 'TATW24H_POC', 'TATW48H_POC', 'TATW72H_POC'];

// TBGNX lines 24-48: the 21 measures of a set of rows. A sum over no rows is NULL; a rate over zero is NULL; AVG of an int
// cuts toward zero.
function metrics15(rows) {
  const n = rows.length;
  const sum = (f) => (n === 0 ? null : rows.reduce((a, r) => a + f(r), 0));
  const one = (c) => (c ? 1 : 0);
  const rate = (a, b) => (a === null || b === null || b === 0 ? null : a / b);
  const avg = (xs) => (xs.length === 0 ? null : Math.trunc(xs.reduce((a, b) => a + b, 0) / xs.length));
  const mtb = sum((r) => one(isMtb15(r)));
  const poc = sum((r) => r.poc);
  const pocSum = (f) => sum((r) => (r.poc === 1 ? f(r) : 0));
  return {
    Tests: n,
    MTB_Positive: mtb,
    RIF_Positive: sum((r) => one(isRif15(r))),
    RIF_Indeterminate: sum((r) => one(isInd15(r))),
    Errors: sum((r) => one(isErr15(r))),
    Invalids: sum((r) => one(isInv15(r))),
    NoResults: sum((r) => one(isNoRes15(r))),
    MTB_Positivity: rate(mtb, n),
    RIF_RES_Rate: rate(sum((r) => one(isMtb15(r) && isRif15(r))), mtb),
    RIF_IND_Rate: rate(sum((r) => one(isMtb15(r) && isInd15(r))), mtb),
    Error_Rate: rate(sum((r) => one(isErr15(r))), n),
    Invalid_Rate: rate(sum((r) => one(isInv15(r))), n),
    No_Result_Rate: rate(sum((r) => one(isNoRes15(r))), n),
    AverageTAT: avg(rows.filter((r) => r.tat !== null).map((r) => r.tat)),
    AverageTAT_POC: avg(rows.filter((r) => r.poc === 1 && r.tat !== null).map((r) => r.tat)),
    TATW24H: rate(sum((r) => r.w24), n),
    TATW48H: rate(sum((r) => r.w48), n),
    TATW72H: rate(sum((r) => r.w72), n),
    TATW24H_POC: rate(pocSum((r) => r.w24), poc),
    TATW48H_POC: rate(pocSum((r) => r.w48), poc),
    TATW72H_POC: rate(pocSum((r) => r.w72), poc),
  };
}

// ---- The dashboard summary: columns and rows ----

const AGES15 = [['lt01', '<01'], ['1to4', '01-04'], ['5to9', '05-09'], ['10to14', '10-14'], ['15to19', '15-19'], ['20to24', '20-24'],
  ['25to29', '25-29'], ['30to34', '30-34'], ['35to39', '35-39'], ['40to44', '40-44'], ['45to49', '45-49'], ['50plus', '50+']];
// The gender groups of the age columns (TBGNX lines 63-127): suffix and the gender (null: a missing gender).
const SEXES15 = [['m', 'Male'], ['f', 'Female'], ['i', 'Indeterminate'], ['u', 'Unknown'], ['x', null]];
const ageColumns15 = (suffix) => [...AGES15.map(([name]) => `${name}${suffix}`), `AgeMissing${suffix}`];
const DASH15 = ['Province', 'District', 'Facility', ...METRICS15, 'Male', 'Female', 'IndeterminateGender', 'UnknownGender', 'MissingGender',
  ...ageColumns15(''), ...SEXES15.flatMap(([suffix]) => ageColumns15(suffix))];

// TBGNX lines 45-127: counts by gender and age group. Sums over no rows are NULL.
function counts15(rows) {
  const count = (c) => (rows.length === 0 ? null : rows.filter(c).length);
  const out = {
    Male: count((r) => r.gender === 'Male'),
    Female: count((r) => r.gender === 'Female'),
    IndeterminateGender: count((r) => r.gender === 'Indeterminate'),
    UnknownGender: count((r) => r.gender === 'Unknown'),
    MissingGender: count((r) => r.gender === null),
  };
  const ages = (suffix, sexTest) => {
    for (const [name, label] of AGES15) out[`${name}${suffix}`] = count((r) => r.age === label && sexTest(r));
    out[`AgeMissing${suffix}`] = count((r) => r.age === null && sexTest(r));
  };
  ages('', () => true);
  for (const [suffix, gender] of SEXES15) ages(suffix, (r) => r.gender === gender);
  return out;
}
const dashRow15 = (names, rows) => ({ Province: names[0], District: names[1], Facility: names[2], ...metrics15(rows), ...counts15(rows) });
// The row of blanks and zeros of the facility branch (TBGNX line 579): every measure is 0. v1's row has a duplicate AgeMissing
// column; a result keyed by name cannot, so the port has the one.
const ZERO_DASH15 = Object.fromEntries(DASH15.map((c) => [c, ['Province', 'District', 'Facility'].includes(c) ? '' : 0]));

const MAY15 = { from: '2026-05-01', to: '2026-05-31' };
const win15 = (from, to) => ({ from, to });
const area15 = (province, district, facility) => ({ province, district, facility });
const none15 = area15('', '', '');

const dashQuery15 = queries().find((q) => q.name === 'TB GeneXpert dashboard summary');
const listQuery15 = queries().find((q) => q.name === 'TB GeneXpert by facility, sex and age');
const trendQuery15 = queries().find((q) => q.name === 'TB GeneXpert monthly trend');
const dashSuite15 = (name, params, rows, setup = '') => orderedSuite(name, dashQuery15?.sql ?? 'select 1', params, DASH15, rows, setup);

// Names compare as SQL Server compares them, and a group shows one of its spellings. A suite built with `loose` compares the
// name columns in lower case without trailing spaces.
const NAME_COLUMNS15 = ['Province', 'District', 'Facility'];
function loose15(suite) {
  return {
    ...suite,
    check: (got) => suite.check(got.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) =>
      [k, NAME_COLUMNS15.includes(k) && typeof v === 'string' ? v.trim().toLowerCase() : v])))),
  };
}

const dayAll15 = (province, district, facility, from, to) => pick15(from, to, 1, province, district, facility);

const suites15dash = [
  // The four branches (TBGNX lines 22, 132, 244, 356). Names read 'All' above the level asked for. All of Zambia has the
  // unmapped facility too (no filter on province); the other levels do not.
  dashSuite15('dash-national', { ...none15, ...MAY15 }, [dashRow15(['All', 'All', 'All'], dayAll15('', '', '', MAY15.from, MAY15.to))], SETUP15),
  dashSuite15('dash-province', { ...area15('Southern', '', ''), ...MAY15 }, [dashRow15(['Southern', 'All', 'All'], dayAll15('Southern', '', '', MAY15.from, MAY15.to))]),
  dashSuite15('dash-district', { ...area15('Southern', 'Choma', ''), ...MAY15 }, [dashRow15(['Southern', 'Choma', 'All'], dayAll15('Southern', 'Choma', '', MAY15.from, MAY15.to))]),
  dashSuite15('dash-facility', { ...area15('Southern', 'Choma', 'Choma General Hospital'), ...MAY15 },
    [dashRow15(['Southern', 'Choma', 'Choma General Hospital'], dayAll15('Southern', 'Choma', 'Choma General Hospital', MAY15.from, MAY15.to))]),
  // Names compare as SQL Server does (case and trailing spaces ignored); the row shows the stored names.
  dashSuite15('dash-names-fold', { ...area15('SOUTHERN', 'choma', 'choma general hospital  '), ...MAY15 },
    [dashRow15(['Southern', 'Choma', 'Choma General Hospital'], dayAll15('Southern', 'Choma', 'Choma General Hospital', MAY15.from, MAY15.to))]),
  dashSuite15('dash-choma-clinic', { ...area15('Southern', 'Choma', 'Choma Clinic'), ...MAY15 },
    [dashRow15(['Southern', 'Choma', 'Choma Clinic'], dayAll15('Southern', 'Choma', 'Choma Clinic', MAY15.from, MAY15.to))]),
  // No POC test: the POC average and the three POC rates are NULL (nullif(sum(POC), 0)).
  dashSuite15('dash-no-poc', { ...area15('Southern', 'Mazabuka', ''), ...MAY15 },
    [dashRow15(['Southern', 'Mazabuka', 'All'], dayAll15('Southern', 'Mazabuka', '', MAY15.from, MAY15.to))]),
  dashSuite15('dash-lusaka', { ...area15('Lusaka', '', ''), ...MAY15 }, [dashRow15(['Lusaka', 'All', 'All'], dayAll15('Lusaka', '', '', MAY15.from, MAY15.to))]),
  dashSuite15('dash-lusaka-district', { ...area15('Lusaka', 'Lusaka', ''), ...MAY15 }, [dashRow15(['Lusaka', 'Lusaka', 'All'], dayAll15('Lusaka', 'Lusaka', '', MAY15.from, MAY15.to))]),
  dashSuite15('dash-lusaka-facility', { ...area15('Lusaka', 'Lusaka', 'Chilenje Clinic'), ...MAY15 },
    [dashRow15(['Lusaka', 'Lusaka', 'Chilenje Clinic'], dayAll15('Lusaka', 'Lusaka', 'Chilenje Clinic', MAY15.from, MAY15.to))]),
  dashSuite15('dash-kafue-facility', { ...area15('Lusaka', 'Kafue', 'Kafue District Hospital'), ...MAY15 },
    [dashRow15(['Lusaka', 'Kafue', 'Kafue District Hospital'], dayAll15('Lusaka', 'Kafue', 'Kafue District Hospital', MAY15.from, MAY15.to))]),
  // Nothing found. All of Zambia still returns its row (line 24: an aggregate over nothing): Tests is 0 and every other measure
  // is NULL (sums and rates). A province or a district with nothing returns NO row (lines 132-242 and 244-354 have no fallback).
  // A facility with nothing returns the row of blanks and zeros (line 579).
  dashSuite15('dash-empty-national', { ...none15, ...win15('2026-10-01', '2026-10-31') }, [dashRow15(['All', 'All', 'All'], [])]),
  dashSuite15('dash-empty-province', { ...area15('Western', '', ''), ...MAY15 }, []),
  dashSuite15('dash-empty-province-window', { ...area15('Southern', '', ''), ...win15('2026-10-01', '2026-10-31') }, []),
  dashSuite15('dash-empty-district', { ...area15('Southern', 'Kafue', ''), ...MAY15 }, []),
  dashSuite15('dash-empty-district-other-province', { ...area15('Lusaka', 'Choma', ''), ...MAY15 }, []),
  dashSuite15('dash-empty-facility', { ...area15('Southern', 'Choma', 'Nowhere'), ...MAY15 }, [ZERO_DASH15]),
  dashSuite15('dash-empty-facility-window', { ...area15('Southern', 'Choma', 'Choma General Hospital'), ...win15('2026-10-01', '2026-10-31') }, [ZERO_DASH15]),
  // The facility must be in that district (line 465 tests all three).
  dashSuite15('dash-facility-wrong-district', { ...area15('Southern', 'Mazabuka', 'Choma General Hospital'), ...MAY15 }, [ZERO_DASH15]),
  // A facility that is not in the register has no description, so no facility name matches it.
  dashSuite15('dash-unmapped-facility', { ...area15('Southern', 'Choma', 'Unmapped Clinic'), ...MAY15 }, [ZERO_DASH15]),
  // v1 has no branch for these (lines 22, 132, 244, 356): no result set at all, not even the zero row.
  dashSuite15('dash-district-only', { ...area15('', 'Choma', ''), ...MAY15 }, []),
  dashSuite15('dash-facility-only', { ...area15('', '', 'Choma General Hospital'), ...MAY15 }, []),
  dashSuite15('dash-province-facility', { ...area15('Southern', '', 'Choma General Hospital'), ...MAY15 }, []),
  dashSuite15('dash-district-facility', { ...area15('', 'Choma', 'Choma General Hospital'), ...MAY15 }, []),
  // The window: the whole day after the end date is included (line 21), on the LOCAL date of the stamp.
  // 05-31: window 05-31 to 06-01. D1 (local 05-31) and D2 (local 06-01) are in; D3 (local 06-02) is out.
  dashSuite15('dash-window-0531', { ...none15, ...win15('2026-05-31', '2026-05-31') }, [dashRow15(['All', 'All', 'All'], dayAll15('', '', '', '2026-05-31', '2026-05-31'))]),
  // 06-01: window 06-01 to 06-02. D2 and D3 are in; D1 (05-31) is out.
  dashSuite15('dash-window-0601', { ...none15, ...win15('2026-06-01', '2026-06-01') }, [dashRow15(['All', 'All', 'All'], dayAll15('', '', '', '2026-06-01', '2026-06-01'))]),
  // 04-30: window 04-30 to 05-01. D5 (local 04-30) and D4 (local 05-01; its UTC date is 04-30) are in.
  dashSuite15('dash-window-0430', { ...none15, ...win15('2026-04-30', '2026-04-30') }, [dashRow15(['All', 'All', 'All'], dayAll15('', '', '', '2026-04-30', '2026-04-30'))]),
  // 05-01: window 05-01 to 05-02. D4 (local 05-01) and A1 (local 05-02). A date taken in UTC would drop D4.
  dashSuite15('dash-window-0501', { ...none15, ...win15('2026-05-01', '2026-05-01') }, [dashRow15(['All', 'All', 'All'], dayAll15('', '', '', '2026-05-01', '2026-05-01'))]),
  // Negative hours: N1 -2 and N2 -1 average -1.5, and an int average cuts toward zero: -1 (not -2).
  dashSuite15('dash-negative-tat', { ...area15('Lusaka', 'Kafue', 'Kafue District Hospital'), ...win15('2026-06-10', '2026-06-10') },
    [dashRow15(['Lusaka', 'Kafue', 'Kafue District Hospital'], dayAll15('Lusaka', 'Kafue', 'Kafue District Hospital', '2026-06-10', '2026-06-10'))]),
  // Partial stamps (July): P1 is in no window; P2 has NULL hours, so AverageTAT averages P3 alone (24) and its flags are 0.
  // The window starts 06-15 and ends 07-31 so that '2026-07' sits inside it as text.
  dashSuite15('dash-partial-stamps', { ...none15, ...win15('2026-06-15', '2026-07-31') }, [dashRow15(['All', 'All', 'All'], dayAll15('', '', '', '2026-06-15', '2026-07-31'))]),
  // Two register rows for one facility (case and a trailing space): one group, one row, whichever spelling it shows.
  // September: the one-sided rows (see SEPT15). The expected row is also pinned by hand in hand-totals.
  dashSuite15('dash-measure-rules', { ...area15('Southern', 'Choma', 'Choma General Hospital'), ...win15('2026-09-01', '2026-09-30') },
    [dashRow15(['Southern', 'Choma', 'Choma General Hospital'], dayAll15('Southern', 'Choma', 'Choma General Hospital', '2026-09-01', '2026-09-30'))]),
  loose15(dashSuite15('dash-fold-facility', { ...area15('Southern', 'Choma', 'Choma General Hospital'), ...win15('2026-08-01', '2026-08-31') },
    [dashRow15(['southern', 'choma', 'choma general hospital'], dayAll15('Southern', 'Choma', 'Choma General Hospital', '2026-08-01', '2026-08-31'))])),
  loose15(dashSuite15('dash-fold-province', { ...area15('southern', '', ''), ...win15('2026-08-01', '2026-08-31') },
    [dashRow15(['southern', 'all', 'all'], dayAll15('Southern', '', '', '2026-08-01', '2026-08-31'))])),
];

// ---- Hand totals: the JS above against numbers worked out on paper ----

// The 20 rows of the May window (A1-A9 give 10 rows, B1-B3, C1-C2, D1, D2, D4, E1, U1) and the sums worked out by hand.
// Hours: 24 10 73 23 5 48 6 1 24 24 | 60 3 24 | 24 20 | 45 46 46 | 48 | 12 = 566 over 20. POC rows (A3 A4 B2 B3 E1): 73 23 3 24 48 = 171 over 5.
const HAND15 = [
  ['national', ['', '', ''], {
    Tests: 20, MTB_Positive: 13, RIF_Positive: 9, RIF_Indeterminate: 2, Errors: 1, Invalids: 1, NoResults: 1,
    MTB_Positivity: 13 / 20, RIF_RES_Rate: 8 / 13, RIF_IND_Rate: 2 / 13, Error_Rate: 1 / 20, Invalid_Rate: 1 / 20, No_Result_Rate: 1 / 20,
    AverageTAT: 28, AverageTAT_POC: 34, TATW24H: 8 / 20, TATW48H: 16 / 20, TATW72H: 19 / 20,
    TATW24H_POC: 2 / 5, TATW48H_POC: 3 / 5, TATW72H_POC: 4 / 5,
    Male: 7, Female: 10, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 1,
    lt01: 1, '1to4': 1, '5to9': 3, '10to14': 1, '15to19': 1, '20to24': 2, '25to29': 3, '30to34': 2, '35to39': 1, '40to44': 2, '45to49': 0, '50plus': 2, AgeMissing: 1,
    '1to4m': 1, '5to9m': 1, '20to24m': 2, '25to29m': 1, '40to44m': 1, '50plusm': 1,
    lt01f: 1, '5to9f': 2, '15to19f': 1, '25to29f': 2, '30to34f': 1, '35to39f': 1, '40to44f': 1, '50plusf': 1,
    '10to14i': 1, '30to34u': 1, AgeMissingx: 1,
  }],
  // Southern: rows 1-15 (hours 369 over 15 = 24.6; POC A3 A4 B2 B3 = 123 over 4 = 30.75).
  ['Southern', ['Southern', '', ''], {
    Tests: 15, MTB_Positive: 9, RIF_Positive: 6, RIF_Indeterminate: 2, Errors: 1, Invalids: 1, NoResults: 1,
    MTB_Positivity: 9 / 15, RIF_RES_Rate: 5 / 9, RIF_IND_Rate: 2 / 9, Error_Rate: 1 / 15, Invalid_Rate: 1 / 15, No_Result_Rate: 1 / 15,
    AverageTAT: 24, AverageTAT_POC: 30, TATW24H: 7 / 15, TATW48H: 12 / 15, TATW72H: 14 / 15,
    TATW24H_POC: 2 / 4, TATW48H_POC: 3 / 4, TATW72H_POC: 3 / 4,
    Male: 5, Female: 7, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 1,
  }],
  // Choma: rows 1-13 (hours 325 over 13 = 25).
  ['Choma', ['Southern', 'Choma', ''], {
    Tests: 13, MTB_Positive: 7, RIF_Positive: 5, RIF_Indeterminate: 1, Errors: 1, Invalids: 1, NoResults: 1,
    MTB_Positivity: 7 / 13, RIF_RES_Rate: 4 / 7, RIF_IND_Rate: 1 / 7, Error_Rate: 1 / 13, Invalid_Rate: 1 / 13, No_Result_Rate: 1 / 13,
    AverageTAT: 25, AverageTAT_POC: 30, TATW24H: 6 / 13, TATW48H: 10 / 13, TATW72H: 12 / 13,
    TATW24H_POC: 2 / 4, TATW48H_POC: 3 / 4, TATW72H_POC: 3 / 4,
    Male: 3, Female: 7, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 1,
  }],
  // Choma General Hospital: rows 1-10 (hours 238 over 10 = 23.8; POC A3 A4 = 96 over 2 = 48).
  ['Choma General Hospital', ['Southern', 'Choma', 'Choma General Hospital'], {
    Tests: 10, MTB_Positive: 5, RIF_Positive: 4, RIF_Indeterminate: 1, Errors: 1, Invalids: 1, NoResults: 1,
    MTB_Positivity: 5 / 10, RIF_RES_Rate: 3 / 5, RIF_IND_Rate: 1 / 5, Error_Rate: 1 / 10, Invalid_Rate: 1 / 10, No_Result_Rate: 1 / 10,
    AverageTAT: 23, AverageTAT_POC: 48, TATW24H: 5 / 10, TATW48H: 8 / 10, TATW72H: 9 / 10,
    TATW24H_POC: 1 / 2, TATW48H_POC: 1 / 2, TATW72H_POC: 1 / 2,
    Male: 2, Female: 5, IndeterminateGender: 1, UnknownGender: 1, MissingGender: 1,
  }],
  // Lusaka: D1 D2 D4 E1 (hours 185 over 4 = 46.25; one POC test, E1, 48 hours).
  ['Lusaka', ['Lusaka', '', ''], {
    Tests: 4, MTB_Positive: 3, RIF_Positive: 3, RIF_Indeterminate: 0, Errors: 0, Invalids: 0, NoResults: 0,
    MTB_Positivity: 3 / 4, RIF_RES_Rate: 3 / 3, RIF_IND_Rate: 0 / 3, Error_Rate: 0, Invalid_Rate: 0, No_Result_Rate: 0,
    AverageTAT: 46, AverageTAT_POC: 48, TATW24H: 0, TATW48H: 3 / 4, TATW72H: 1,
    TATW24H_POC: 0, TATW48H_POC: 0, TATW72H_POC: 1,
    Male: 2, Female: 2, IndeterminateGender: 0, UnknownGender: 0, MissingGender: 0,
  }],
];
// September (fix round 1): the 12 one-sided rows S1-S12, all Choma General Hospital, Female, 30-34, 24 hours (flags 0, 1, 1), no POC.
// Tests 12. MTB positive: S8 = 1. RIF positive ('DET' S7 S8, 'detected_low ' S9) = 3. Errors: S1 (MTB) and S2 (RIF) = 2. Invalids: S3
// (MTB) and S4 (RIF) = 2. NoResults: S5 (MTB 'No Results'), S6 (RIF 'No Results'), S10 (blank RIF), S11 (blank MTB) = 4.
// Rates: 1/12, RIF_RES 1/1 (only S8 is MTB positive and RIF positive), RIF_IND 0/1, 2/12, 2/12, 4/12. Hours 24 each: AverageTAT 24.
HAND15.push(['September', ['Southern', 'Choma', 'Choma General Hospital'], {
  Tests: 12, MTB_Positive: 1, RIF_Positive: 3, RIF_Indeterminate: 0, Errors: 2, Invalids: 2, NoResults: 4,
  MTB_Positivity: 1 / 12, RIF_RES_Rate: 1 / 1, RIF_IND_Rate: 0 / 1, Error_Rate: 2 / 12, Invalid_Rate: 2 / 12, No_Result_Rate: 4 / 12,
  AverageTAT: 24, AverageTAT_POC: null, TATW24H: 0, TATW48H: 1, TATW72H: 1, TATW24H_POC: null, TATW48H_POC: null, TATW72H_POC: null,
  Male: 0, Female: 12, IndeterminateGender: 0, UnknownGender: 0, MissingGender: 0, '30to34': 12, '30to34f': 12, AgeMissing: 0,
}, win15('2026-09-01', '2026-09-30')]);
const handTotals15 = {
  name: 'hand-totals',
  count: HAND15.length,
  check() {
    return HAND15.flatMap(([label, [province, district, facility], want, window = MAY15]) => {
      const rows = dayAll15(province, district, facility, window.from, window.to);
      const got = { ...metrics15(rows), ...counts15(rows) };
      const bad = Object.entries(want).filter(([k, v]) => got[k] !== v).map(([k, v]) => `${k}: expected ${v}, got ${got[k]}`);
      return bad.length ? [`${label}: ${bad.join('; ')}`] : [];
    });
  },
};

// ---- The list by facility, sex and age ----

const LIST15 = ['Province', 'District', 'Facility', 'Gender', 'AgeGroup', ...METRICS15];
const AGE_ORDER15 = ['<01', '01-04', '05-09', '10-14', '15-19', '20-24', '25-29', '30-34', '35-39', '40-44', '45-49', '50+', 'Missing'];
const GENDER_ORDER15 = ['Female', 'Indeterminate', 'Male', 'Missing', 'Unknown'];

// One row per province, district, facility, gender and age group; a missing gender or age is 'Missing' (List lines 25, 54, 91, 120).
// Names group ignoring case and trailing spaces. Order: province, district, facility, gender, age group; NULL first.
function listRows15(rows) {
  const groups = new Map();
  for (const r of rows) {
    const gender = r.gender ?? 'Missing';
    const age = r.age ?? 'Missing';
    const key = JSON.stringify([down15(r.province), down15(r.district), down15(r.facility), gender, age]);
    if (!groups.has(key)) groups.set(key, { first: r, gender, age, rows: [] });
    groups.get(key).rows.push(r);
  }
  const text = (v) => (v === null ? '' : down15(v));
  const byName = (a, b) => {
    if ((a === null) !== (b === null)) return a === null ? -1 : 1;
    return text(a) < text(b) ? -1 : text(a) > text(b) ? 1 : 0;
  };
  return [...groups.values()]
    .sort((a, b) => byName(a.first.province, b.first.province) || byName(a.first.district, b.first.district)
      || byName(a.first.facility, b.first.facility) || GENDER_ORDER15.indexOf(a.gender) - GENDER_ORDER15.indexOf(b.gender)
      || AGE_ORDER15.indexOf(a.age) - AGE_ORDER15.indexOf(b.age))
    .map((g) => ({ Province: g.first.province, District: g.first.district, Facility: g.first.facility, Gender: g.gender, AgeGroup: g.age, ...metrics15(g.rows) }));
}
// The "nothing found" row (List lines 85, 151, 220): blanks and zeros. v1's row has no AverageTAT and AverageTAT_POC; the port gives
// the main column names and 0 for those two.
const ZERO_LIST15 = Object.fromEntries(LIST15.map((c) => [c, ['Province', 'District', 'Facility', 'Gender', 'AgeGroup'].includes(c) ? '' : 0]));
const listSuite15 = (name, params, rows, setup = '') => orderedSuite(name, listQuery15?.sql ?? 'select 1', params, LIST15, rows, setup);
const list2x15 = (province, district) => ({ province, district });
const listDay15 = (province, district, from, to) => listRows15(pick15(from, to, 1, province, district));

// The hand-worked order of the whole list (List lines 81-83): NULL names first, Lusaka before Southern, Kafue before Lusaka, Choma
// Clinic before Choma General Hospital, genders Female, Indeterminate, Male, Missing, Unknown, age groups in band order.
const NATIONAL_KEYS15 = [
  'null|null|null|Female|30-34',
  'Lusaka|Kafue|Kafue District Hospital|Female|35-39',
  'Lusaka|Lusaka|Chilenje Clinic|Female|25-29',
  'Lusaka|Lusaka|Chilenje Clinic|Male|25-29',
  'Lusaka|Lusaka|Chilenje Clinic|Male|40-44',
  'Southern|Choma|Choma Clinic|Female|15-19',
  'Southern|Choma|Choma Clinic|Female|40-44',
  'Southern|Choma|Choma Clinic|Male|05-09',
  'Southern|Choma|Choma General Hospital|Female|<01',
  'Southern|Choma|Choma General Hospital|Female|05-09',
  'Southern|Choma|Choma General Hospital|Female|25-29',
  'Southern|Choma|Choma General Hospital|Female|50+',
  'Southern|Choma|Choma General Hospital|Indeterminate|10-14',
  'Southern|Choma|Choma General Hospital|Male|01-04',
  'Southern|Choma|Choma General Hospital|Male|50+',
  'Southern|Choma|Choma General Hospital|Missing|Missing',
  'Southern|Choma|Choma General Hospital|Unknown|30-34',
  'Southern|Mazabuka|Mazabuka Hospital|Male|20-24',
];
// Two groups worked out by hand. CGH Female 05-09 is A9's two rows (24 hours each; one MTB Detected, one MTB Not Detected, both RIF
// Detected). Mazabuka Male 20-24 is C1 (24 hours, RIF Detected) and C2 (20 hours, RIF Indeterminate).
const HAND_GROUPS15 = [
  ['Southern|Choma|Choma General Hospital|Female|05-09', {
    Tests: 2, MTB_Positive: 1, RIF_Positive: 2, RIF_Indeterminate: 0, Errors: 0, Invalids: 0, NoResults: 0, MTB_Positivity: 0.5,
    RIF_RES_Rate: 1, RIF_IND_Rate: 0, Error_Rate: 0, Invalid_Rate: 0, No_Result_Rate: 0, AverageTAT: 24, AverageTAT_POC: null,
    TATW24H: 0, TATW48H: 1, TATW72H: 1, TATW24H_POC: null, TATW48H_POC: null, TATW72H_POC: null,
  }],
  ['Southern|Mazabuka|Mazabuka Hospital|Male|20-24', {
    Tests: 2, MTB_Positive: 2, RIF_Positive: 1, RIF_Indeterminate: 1, Errors: 0, Invalids: 0, NoResults: 0, MTB_Positivity: 1,
    RIF_RES_Rate: 1 / 2, RIF_IND_Rate: 1 / 2, Error_Rate: 0, Invalid_Rate: 0, No_Result_Rate: 0, AverageTAT: 22, AverageTAT_POC: null,
    TATW24H: 1 / 2, TATW48H: 1, TATW72H: 1, TATW24H_POC: null, TATW48H_POC: null, TATW72H_POC: null,
  }],
];
const keyOf15 = (r) => [r.Province, r.District, r.Facility, r.Gender, r.AgeGroup].map(String).join('|');
const handGroups15 = {
  name: 'hand-groups',
  count: 1 + HAND_GROUPS15.length,
  check() {
    const rows = listDay15('', '', MAY15.from, MAY15.to);
    const keys = rows.map(keyOf15);
    const bad = JSON.stringify(keys) === JSON.stringify(NATIONAL_KEYS15) ? [] : [`order: expected ${NATIONAL_KEYS15.join(' / ')}, got ${keys.join(' / ')}`];
    for (const [key, want] of HAND_GROUPS15) {
      const got = rows.find((r) => keyOf15(r) === key);
      if (!got) { bad.push(`${key}: missing`); continue; }
      for (const [k, v] of Object.entries(want)) if (got[k] !== v) bad.push(`${key} ${k}: expected ${v}, got ${got[k]}`);
    }
    return bad;
  },
};

const suites15list = [
  listSuite15('list-national', { ...list2x15('', ''), ...MAY15 }, listDay15('', '', MAY15.from, MAY15.to)),
  listSuite15('list-province', { ...list2x15('Southern', ''), ...MAY15 }, listDay15('Southern', '', MAY15.from, MAY15.to)),
  listSuite15('list-district', { ...list2x15('Southern', 'Choma'), ...MAY15 }, listDay15('Southern', 'Choma', MAY15.from, MAY15.to)),
  listSuite15('list-lusaka', { ...list2x15('Lusaka', ''), ...MAY15 }, listDay15('Lusaka', '', MAY15.from, MAY15.to)),
  listSuite15('list-lusaka-district', { ...list2x15('Lusaka', 'Lusaka'), ...MAY15 }, listDay15('Lusaka', 'Lusaka', MAY15.from, MAY15.to)),
  // Names compare as SQL Server does (case and trailing spaces ignored); the rows show the stored names.
  listSuite15('list-names-fold', { ...list2x15('SOUTHERN ', 'choma  '), ...MAY15 }, listDay15('Southern', 'Choma', MAY15.from, MAY15.to)),
  // Nothing found: only the blanks-and-zeros row, in every branch (lines 85, 151, 220).
  listSuite15('list-empty-national', { ...list2x15('', ''), ...win15('2026-10-01', '2026-10-31') }, [ZERO_LIST15]),
  listSuite15('list-empty-province', { ...list2x15('Western', ''), ...MAY15 }, [ZERO_LIST15]),
  listSuite15('list-empty-district', { ...list2x15('Southern', 'Kafue'), ...MAY15 }, [ZERO_LIST15]),
  listSuite15('list-wrong-district', { ...list2x15('Lusaka', 'Choma'), ...MAY15 }, [ZERO_LIST15]),
  // A district without a province matches no branch (lines 22, 87, 154): no result set at all, not even the blanks row.
  listSuite15('list-district-only', { ...list2x15('', 'Choma'), ...MAY15 }, []),
  listSuite15('list-district-only-empty', { ...list2x15('', 'Kafue'), ...MAY15 }, []),
  // The window is the whole local day after `to` (line 21 and the cast on lines 48, 76).
  listSuite15('list-window-0531', { ...list2x15('', ''), ...win15('2026-05-31', '2026-05-31') }, listDay15('', '', '2026-05-31', '2026-05-31')),
  listSuite15('list-window-0601', { ...list2x15('', ''), ...win15('2026-06-01', '2026-06-01') }, listDay15('', '', '2026-06-01', '2026-06-01')),
  listSuite15('list-window-0430', { ...list2x15('', ''), ...win15('2026-04-30', '2026-04-30') }, listDay15('', '', '2026-04-30', '2026-04-30')),
  listSuite15('list-window-0501', { ...list2x15('', ''), ...win15('2026-05-01', '2026-05-01') }, listDay15('', '', '2026-05-01', '2026-05-01')),
  // Negative hours: the average cuts toward zero. N1 (-2) and N2 (-1) are two groups here (Female and Male).
  listSuite15('list-negative-tat', { ...list2x15('', ''), ...win15('2026-06-10', '2026-06-10') }, listDay15('', '', '2026-06-10', '2026-06-10')),
  // Partial stamps (July): P2's hours are NULL (AverageTAT NULL, flags 0), P1 is in no window.
  listSuite15('list-partial-stamps', { ...list2x15('', ''), ...win15('2026-06-15', '2026-07-31') }, listDay15('', '', '2026-06-15', '2026-07-31')),
  // Two register rows for one facility: one group per gender and age group, whichever spelling it shows.
  loose15(listSuite15('list-fold-facility', { ...list2x15('', ''), ...win15('2026-08-01', '2026-08-31') },
    listDay15('', '', '2026-08-01', '2026-08-31').map((r) => ({ ...r, Province: r.Province.toLowerCase(), District: r.District.toLowerCase(), Facility: r.Facility.trim().toLowerCase() })))),
  listSuite15('list-measure-rules', { ...list2x15('Southern', 'Choma'), ...win15('2026-09-01', '2026-09-30') }, listDay15('Southern', 'Choma', '2026-09-01', '2026-09-30')),
  handGroups15,
];

// ---- The monthly trend ----

const TREND15 = ['MonthID', 'Tests', 'MTB_Positive', 'RIF_Positive', 'W24H', 'TATW48', 'W72H'];
const tr15 = (month, tests, mtb, rif, w24, w48, w72) => Object.fromEntries(TREND15.map((c, i) => [c, [month, tests, mtb, rif, w24, w48, w72][i]]));
const trendSuite15 = (name, params, rows) => orderedSuite(name, trendQuery15?.sql ?? 'select 1', params, TREND15, rows);
const area3x15 = (province, district, facility) => ({ province, district, facility });
// Tests is the number of distinct request numbers (A9 has two rows and counts once); the others are counts of rows and sums of the
// 0/1 flags (W24H, TATW48 and W72H are counts, not rates). The month is the LOCAL month of the authorised stamp.
const DEC15 = tr15('2025 - 12', 1, 0, 0, 0, 1, 1);        // Y1
const JAN15 = tr15('2026 - 01', 1, 1, 1, 1, 1, 1);        // Y2: local 2026-01-01 (UTC 2025-12-31)
const APR15 = tr15('2026 - 04', 1, 0, 0, 0, 0, 1);        // D5: 71 hours
// May, all of Zambia without the dashboards' extra day: the 20 rows of the May window minus D2 (local 06-01) = 19 rows, 18 requests.
// MTB Detected 13, RIF positive 9, W24H 8, W48 15 (16 minus D2), W72H 18 (19 minus D2).
const MAY_ALL15 = tr15('2026 - 05', 18, 13, 9, 8, 15, 18);
// June: D2 (06-01, MTB negative, 46 h), D3 (06-02, positive, 70 h), N1 (06-10, positive, -2 h), N2 (06-11, negative, -1 h).
const JUN15 = tr15('2026 - 06', 4, 2, 2, 2, 3, 4);
const JUL15 = tr15('2026 - 07', 2, 1, 0, 0, 1, 1);        // P2 and P3; P1 is in no month
const ALL15 = win15('2025-12-01', '2026-07-31');

const suites15trend = [
  trendSuite15('trend-national', { ...area3x15('', '', ''), ...ALL15 }, [DEC15, JAN15, APR15, MAY_ALL15, JUN15, JUL15]),
  // Southern (line 13): December, January, May rows 1-15 (14 requests; MTB 9, RIF 6, W24H 7, W48 12, W72H 14), July.
  trendSuite15('trend-province', { ...area3x15('Southern', '', ''), ...ALL15 }, [DEC15, JAN15, tr15('2026 - 05', 14, 9, 6, 7, 12, 14), JUL15]),
  // Southern / Choma (line 29): without Mazabuka. May rows 1-13: 12 requests; MTB 7, RIF 5, W24H 6, W48 10, W72H 12.
  trendSuite15('trend-district', { ...area3x15('Southern', 'Choma', ''), ...ALL15 }, [DEC15, JAN15, tr15('2026 - 05', 12, 7, 5, 6, 10, 12), JUL15]),
  // Choma Clinic (line 45): B1 B2 B3 in May.
  trendSuite15('trend-facility', { ...area3x15('Southern', 'Choma', 'Choma Clinic'), ...ALL15 }, [tr15('2026 - 05', 3, 2, 1, 1, 2, 3)]),
  trendSuite15('trend-names-fold', { ...area3x15('southern', 'CHOMA ', 'choma clinic  '), ...ALL15 }, [tr15('2026 - 05', 3, 2, 1, 1, 2, 3)]),
  // Lusaka: D5 in April, D1 D4 E1 in May, D2 D3 N1 N2 in June.
  trendSuite15('trend-lusaka', { ...area3x15('Lusaka', '', ''), ...ALL15 }, [APR15, tr15('2026 - 05', 3, 3, 3, 0, 2, 3), JUN15]),
  trendSuite15('trend-lusaka-district', { ...area3x15('Lusaka', 'Lusaka', ''), ...ALL15 },
    [APR15, tr15('2026 - 05', 2, 2, 2, 0, 2, 2), tr15('2026 - 06', 2, 1, 1, 0, 1, 2)]),
  trendSuite15('trend-kafue', { ...area3x15('Lusaka', 'Kafue', ''), ...ALL15 }, [tr15('2026 - 05', 1, 1, 1, 0, 0, 1), tr15('2026 - 06', 2, 1, 1, 2, 2, 2)]),
  // Any other combination falls to v1's last branch (line 63): nothing is filtered. In April the only test is D5 (Lusaka), so a
  // wrongly applied filter on Choma or Southern would leave nothing.
  trendSuite15('trend-district-only', { ...area3x15('', 'Choma', ''), ...win15('2026-04-01', '2026-04-30') }, [APR15]),
  trendSuite15('trend-facility-only', { ...area3x15('', '', 'Choma Clinic'), ...win15('2026-04-01', '2026-04-30') }, [APR15]),
  trendSuite15('trend-province-facility', { ...area3x15('Southern', '', 'Choma Clinic'), ...win15('2026-04-01', '2026-04-30') }, [APR15]),
  trendSuite15('trend-district-facility', { ...area3x15('', 'Choma', 'Choma Clinic'), ...win15('2026-04-01', '2026-04-30') }, [APR15]),
  // The month is the local month, and there is no extra day (lines 20-22). D1 (local 05-31) is May; D2 (local 06-01, UTC 05-31) is
  // June; D4 (local 05-01, UTC 04-30) is May; D5 (local 04-30) is April.
  trendSuite15('trend-edge-0531', { ...area3x15('', '', ''), ...win15('2026-05-31', '2026-05-31') }, [tr15('2026 - 05', 1, 1, 1, 0, 1, 1)]),
  trendSuite15('trend-edge-0601', { ...area3x15('', '', ''), ...win15('2026-06-01', '2026-06-01') }, [tr15('2026 - 06', 1, 0, 0, 0, 1, 1)]),
  trendSuite15('trend-edge-0501', { ...area3x15('', '', ''), ...win15('2026-05-01', '2026-05-01') }, [tr15('2026 - 05', 1, 1, 1, 0, 1, 1)]),
  trendSuite15('trend-edge-0430', { ...area3x15('', '', ''), ...win15('2026-04-30', '2026-04-30') }, [APR15]),
  // The year turns: MonthID sorts 2025 - 12 before 2026 - 01. Y2 is local 2026-01-01 (UTC 2025-12-31).
  trendSuite15('trend-year-turn', { ...area3x15('', '', ''), ...win15('2025-12-01', '2026-01-31') }, [DEC15, JAN15]),
  trendSuite15('trend-year-edge', { ...area3x15('', '', ''), ...win15('2026-01-01', '2026-01-01') }, [JAN15]),
  // Partial stamps: P2 and P3 are July; P1's authorised date is not a date, so it is in no month (Tests is 2, not 3).
  trendSuite15('trend-partial-stamps', { ...area3x15('', '', ''), ...win15('2026-07-01', '2026-07-31') }, [JUL15]),
  // No test in the window: no row (a group by over no rows).
  // September (fix round 1): 12 requests; MTB positive S8 = 1, RIF positive S7 S8 S9 = 3, 24 hours each: W24H 0, TATW48 12, W72H 12.
  trendSuite15('trend-measure-rules', { ...area3x15('', '', ''), ...win15('2026-09-01', '2026-09-30') }, [tr15('2026 - 09', 12, 1, 3, 0, 12, 12)]),
  trendSuite15('trend-empty', { ...area3x15('', '', ''), ...win15('2026-10-01', '2026-10-31') }, []),
  trendSuite15('trend-empty-province', { ...area3x15('Western', '', ''), ...ALL15 }, []),
];

// ---- Shape, and the builder option ----

const shape15 = (query, label, wantIds, wantTypes, wantRequired) => ({
  name: `${label}-shape`,
  count: 4 + wantIds.length,
  check() {
    if (!query) return [`query for ${label} is missing`];
    const bad = [];
    const ids = query.params.map((p) => p.id);
    if (JSON.stringify(ids) !== JSON.stringify(wantIds)) bad.push(`params: expected ${wantIds}, got ${ids}`);
    query.params.forEach((p, i) => {
      if (p.type !== wantTypes[i]) bad.push(`${p.id}: expected type ${wantTypes[i]}, got ${p.type}`);
      if (p.required !== wantRequired[i]) bad.push(`${p.id}: expected required ${wantRequired[i]}, got ${p.required}`);
    });
    if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(query.sql.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
    if (!/^\s*with\b/i.test(query.sql)) bad.push('does not start with "with"');
    return bad;
  },
});

// tbgnxCte takes extraDays for the dashboards that add a day to the end date; without it the output is unchanged.
const extraDaysSuite15 = {
  name: 'tbgnx-extra-days',
  count: 4,
  check() {
    const bad = [];
    const plain = tbgnxCte('x', { from: 'a', to: 'b' });
    if (plain !== tbgnxCte('x', { from: 'a', to: 'b', extraDays: 0 })) bad.push('extraDays 0 must give the same text as no option');
    const moved = tbgnxCte('x', { from: 'a', to: 'b', extraDays: 1 });
    if (!moved.includes("::date + 1, 'YYYY-MM-DD')")) bad.push('extraDays 1 must move the end of the window by one day');
    if (plain.includes('::date + 1')) bad.push('the default window must not move');
    try { tbgnxCte('x', { from: 'a', to: 'b', extraDays: -1 }); bad.push('a negative extraDays must throw'); } catch { /* expected */ }
    return bad;
  },
};

const suites15 = [
  ...suites15dash,
  handTotals15,
  ...suites15list,
  ...suites15trend,
  shape15(dashQuery15, 'dash', ['province', 'district', 'facility', 'from', 'to'], ['select', 'select', 'text', 'text', 'text'], [false, false, false, true, true]),
  shape15(listQuery15, 'list', ['province', 'district', 'from', 'to'], ['select', 'select', 'text', 'text'], [false, false, true, true]),
  shape15(trendQuery15, 'trend', ['province', 'district', 'facility', 'from', 'to'], ['select', 'select', 'text', 'text', 'text'], [false, false, false, true, true]),
  {
    name: 'dash-columns',
    count: 1,
    check: () => (DASH15.length === 107 && new Set(DASH15).size === 107 ? [] : [`expected 107 distinct columns, got ${DASH15.length} (${new Set(DASH15).size} distinct)`]),
  },
  extraDaysSuite15,
];

// ============================================================================================
// Group t16: "TB GeneXpert report" (v1 fn_GeneXpertReport). Fixture ids start with "t16-"; lab ids (lr.request_id) start with
// "T16-". "F line N" is a line of UserDefinedFunction__dbo_fn_GeneXpertReport.sql. The view v_GeneXpert is pinned by group t4.
//
// Each case has its own testing code (the TestedAt column), so its row stands alone: the code is the case name (M01 ...). A lab name
// that no display and no register row gives is the code itself (ruling 8). Counts are written as
// [MTB_neg, MTBRIF_neg, MTBRIF_pos, MTBRIF_IND, Error_Results, Invalid_Results, No_Results].
//
// The window is on the analysis stamp (F line 67): AnalysisDateTime >= @From and <= @To with dates, so from 00:00:00 of `from` up to and
// including 00:00:00 of `to` (local wall time of the stamp's own text). The main window is 2026-05-04 to 2026-05-06, and the one-day
// window 2026-05-05 to 2026-05-05 holds only what is stamped exactly at midnight.
// ============================================================================================

const P16 = [];
const R16 = [];
const S16 = [];
const D16 = [];
const L16 = [];
let n16 = 0;
const nz16 = (v) => (v === null || v === undefined ? 'null' : String(v));
const N0 = [0, 0, 0, 0, 0, 0, 0];

// One v1 Requests row of a lab number with its patient, specimen, report and results. `mtb` and `rif` are the GXMTB and GXRIF texts
// (undefined: no such result; null: a result without a value). `tbhiv` and `tbage` are TBCOL answers on a second request of the
// same lab number (undefined: none; an array: several answers). `extra` are more results of the request.
function req16(labId, o = {}) {
  const r = {
    panel: 'TBGNX', req: 'ZSOUT', sex: 'F', years: 30, days: 10950, status: 'final',
    authored: '2026-05-04T08:00:00Z', analysis: '2026-05-05T09:00:00Z', effective: '2026-05-03T07:00:00Z',
    issued: '2026-05-06T10:00:00Z', received: '2026-05-03T12:00:00Z', perf: 'ZZZ', disp: null, report: true, patient: true,
    mtb: 'Not Detected', rif: 'Not Detected', extra: [], tbhiv: undefined, tbage: undefined, tbcolPanel: 'TBCOL', ...o,
  };
  const k = String(++n16).padStart(3, '0');
  const qid = `t16-q${k}`;
  let pid = null;
  if (r.patient) {
    pid = `t16-p${k}`;
    P16.push(`(${lit(pid)}, ${lit(`P${k}`)}, ${lit(r.sex)})`);
  }
  R16.push(`(${lit(qid)}, ${lit(labId)}, ${lit(r.panel)}, ${lit(r.authored)}, ${lit(r.analysis)}, ${lit(r.req)}, ${lit(pid)}, ${nz16(r.years)}, ${nz16(r.days)})`);
  const sid = r.received ? `t16-s${k}` : null;
  if (sid) S16.push(`(${lit(sid)}, ${lit(r.received)})`);
  if (r.report) D16.push(`(${lit(`t16-d${k}`)}, ${lit(qid)}, ${lit(r.status)}, ${lit(r.effective)}, ${lit(r.issued)}, ${lit(r.perf)}, ${lit(r.disp)}, ${lit(sid)})`);
  const results = [
    ...(r.mtb === undefined ? [] : [{ obs: 'GXMTB', text: r.mtb }]),
    ...(r.rif === undefined ? [] : [{ obs: 'GXRIF', text: r.rif }]),
    ...r.extra,
  ];
  results.forEach((x, i) => L16.push(`(${lit(`t16-r${k}-${i + 1}`)}, ${lit(qid)}, ${lit(x.obs)}, ${lit(x.text ?? null)})`));
  const answers = [
    ...(r.tbhiv === undefined ? [] : [r.tbhiv].flat().map((text) => ({ obs: 'TBHIV', text }))),
    ...(r.tbage === undefined ? [] : [r.tbage].flat().map((text) => ({ obs: 'TBAGE', text }))),
  ];
  if (answers.length > 0) {
    const cid = `t16-c${k}`;
    R16.push(`(${lit(cid)}, ${lit(labId)}, ${lit(r.tbcolPanel)}, null::text, null::text, null::text, null::text, null, null)`);
    answers.forEach((x, i) => L16.push(`(${lit(`t16-a${k}-${i + 1}`)}, ${lit(cid)}, ${lit(x.obs)}, ${lit(x.text)})`));
  }
}

const OUT16 = ['TestedAt', 'LabName', 'AgeGroup', 'TBHIV', 'MTB_neg', 'MTBRIF_neg', 'MTBRIF_pos', 'MTBRIF_IND', 'Error_Results', 'Invalid_Results', 'No_Results'];
const exp16 = [];   // { wins, row }: the windows ('main', 'day') the row shows in
const ex16 = (testedAt, labName, age, tbhiv, counts, wins = ['main']) =>
  exp16.push({ wins, row: Object.fromEntries(OUT16.map((c, i) => [c, [testedAt, labName, age, tbhiv, ...counts][i]])) });
// One case: a lab number whose testing code is `code`; the row it gives is alone in its group.
function cs16(code, o, counts, e = {}) {
  req16(`T16-${code}`, { perf: code, ...o });
  ex16(code, e.lab ?? code, e.age ?? '15+', e.tbhiv ?? 'Unknown', counts, e.wins);
}

// -- The measures (F lines 37-64). The compare ignores case and trailing spaces. Only the MTB 'Detected%' is a prefix match (line 46); the RIF
// side of every measure is an equality, so 'Detected _ Low' as the RIF, 'DETEC', 'Indeterminate', 'ERR', 'INV' and 'No Results' count nowhere.
cs16('M01', {}, [1, 1, 0, 0, 0, 0, 0]);                                                  // lines 38, 42
cs16('M02', { mtb: 'not detected  ', rif: 'NOT DETECTED ' }, [1, 1, 0, 0, 0, 0, 0]);     // case, trailing spaces
cs16('M03', { mtb: 'Negative', rif: 'Negative' }, N0);
cs16('M04', { mtb: 'MTB Not Detected', rif: 'MTB Not Detected' }, N0);
cs16('M05', { mtb: 'Detected', rif: 'Detected' }, [0, 0, 1, 0, 0, 0, 0]);                // line 46
cs16('M06', { mtb: 'Detected _ Low', rif: 'Detected' }, [0, 0, 1, 0, 0, 0, 0]);          // 'Detected%'
cs16('M07', { mtb: 'DETECTED _ HIGH ', rif: 'detected  ' }, [0, 0, 1, 0, 0, 0, 0]);
cs16('M08', { mtb: 'Detected', rif: 'Detected _ Low' }, N0);                              // the RIF must equal 'Detected'
cs16('M09', { mtb: 'Detected', rif: 'DETEC' }, N0);
cs16('M10', { mtb: 'Not Detected', rif: 'Detected' }, [1, 0, 0, 0, 0, 0, 0]);             // 'Not Detected' is not 'Detected%'
cs16('M11', { mtb: 'Detected', rif: 'Not Detected' }, [0, 1, 0, 0, 0, 0, 0]);             // line 42: the RIF counts whatever the MTB says
cs16('M12', { mtb: 'Positive', rif: 'Detected' }, N0);
cs16('M13', { mtb: 'Detectedfoo', rif: 'Detected' }, [0, 0, 1, 0, 0, 0, 0]);
cs16('M14', { mtb: ' Detected', rif: 'Detected' }, N0);                                 // a prefix, not a contains
cs16('M15', { mtb: 'Detected', rif: 'IND' }, [0, 0, 0, 1, 0, 0, 0]);                      // line 50
cs16('M16', { mtb: 'Detected', rif: 'ind ' }, [0, 0, 0, 1, 0, 0, 0]);
cs16('M17', { mtb: 'Detected', rif: 'Indeterminate' }, N0);
cs16('M18', { mtb: 'IND', rif: 'Detected' }, N0);                                         // IND counts on the RIF side only
cs16('M19', { mtb: 'Error', rif: 'Not Detected' }, [0, 1, 0, 0, 1, 0, 0]);                // line 54: the MTB side alone
cs16('M20', { mtb: 'Detected', rif: 'Error' }, [0, 0, 0, 0, 1, 0, 0]);                    // the RIF side alone
cs16('M21', { mtb: 'Error', rif: 'Error' }, [0, 0, 0, 0, 1, 0, 0]);                       // both sides: one result, not two
cs16('M22', { mtb: 'ERROR  ', rif: 'Not Detected' }, [0, 1, 0, 0, 1, 0, 0]);
cs16('M23', { mtb: 'ERR', rif: 'ERR' }, N0);
cs16('M24', { mtb: 'Invalid', rif: 'Not Detected' }, [0, 1, 0, 0, 0, 1, 0]);              // line 58: the MTB side alone
cs16('M25', { mtb: 'Detected', rif: 'invalid' }, [0, 0, 0, 0, 0, 1, 0]);                  // the RIF side alone
cs16('M26', { mtb: 'Invalid', rif: 'Invalid' }, [0, 0, 0, 0, 0, 1, 0]);
cs16('M27', { mtb: 'INV', rif: 'INV' }, N0);
cs16('M28', { mtb: 'NORES', rif: 'Not Detected' }, [0, 1, 0, 0, 0, 0, 1]);                // line 62: the MTB side alone
cs16('M29', { mtb: 'Detected', rif: 'nores ' }, [0, 0, 0, 0, 0, 0, 1]);                   // the RIF side alone
cs16('M30', { mtb: 'NORES', rif: 'NORES' }, [0, 0, 0, 0, 0, 0, 1]);
cs16('M31', { mtb: 'No Results', rif: 'No Results' }, N0);
cs16('M32', { mtb: 'Error', rif: 'Invalid' }, [0, 0, 0, 0, 1, 1, 0]);                     // two measures on one row
cs16('M33', { mtb: 'Error', rif: 'NORES' }, [0, 0, 0, 0, 1, 0, 1]);
cs16('M34', { mtb: null, rif: 'Not Detected' }, [0, 1, 0, 0, 0, 0, 0]);                   // a result without a value tests false
cs16('M35', { mtb: 'Detected', rif: undefined }, N0);                                     // no GXRIF result: the row stays, RIF is NULL
cs16('M36', { mtb: 'Detected', rif: null }, N0);
// Several rows in one group add up (a count of distinct rows or a flag would not).
for (const [i, [mtb, rif]] of [['Not Detected', 'Not Detected'], ['Not Detected', 'Not Detected'], ['Detected', 'Detected'], ['Error', 'Not Detected'],
  ['NORES', 'IND'], ['Invalid', 'Detected']].entries()) req16(`T16-AGG${i + 1}`, { perf: 'AGG', mtb, rif });
ex16('AGG', 'AGG', '15+', 'Unknown', [2, 3, 1, 1, 1, 1, 1]);

// -- The age group (F lines 23-29). A known age wins over TBAGE. A NULL age loses the RIF (view line 119), so those rows count the MTB only.
cs16('A01', { years: 0 }, [1, 1, 0, 0, 0, 0, 0], { age: '0-14' });
cs16('A02', { years: 14 }, [1, 1, 0, 0, 0, 0, 0], { age: '0-14' });
cs16('A03', { years: 15 }, [1, 1, 0, 0, 0, 0, 0], { age: '15+' });
cs16('A04', { years: 99 }, [1, 1, 0, 0, 0, 0, 0], { age: '15+' });
cs16('A05', { years: -1, tbage: 'Adult' }, [1, 1, 0, 0, 0, 0, 0], { age: 'Unknown' });   // a negative age is not NULL: TBAGE is not read
cs16('A06', { years: null, tbage: 'Adult' }, [1, 0, 0, 0, 0, 0, 0], { age: '15+' });     // line 26
cs16('A07', { years: null, tbage: 'Child' }, [1, 0, 0, 0, 0, 0, 0], { age: '0-14' });    // line 27
cs16('A08', { years: null }, [1, 0, 0, 0, 0, 0, 0], { age: 'Unknown' });
cs16('A09', { years: null, tbage: 'adult ' }, [1, 0, 0, 0, 0, 0, 0], { age: '15+' });
cs16('A10', { years: null, tbage: 'CHILD' }, [1, 0, 0, 0, 0, 0, 0], { age: '0-14' });
cs16('A11', { years: null, tbage: 'Infant' }, [1, 0, 0, 0, 0, 0, 0], { age: 'Unknown' });
cs16('A12', { years: 40, tbage: 'Child' }, [1, 1, 0, 0, 0, 0, 0], { age: '15+' });
cs16('A13', { years: 5, tbage: 'Adult' }, [1, 1, 0, 0, 0, 0, 0], { age: '0-14' });
cs16('A14', { years: null, tbage: null }, [1, 0, 0, 0, 0, 0, 0], { age: 'Unknown' });
// Two ages in one band are one group.
req16('T16-AMRG1', { perf: 'AMRG', years: 3 });
req16('T16-AMRG2', { perf: 'AMRG', years: 12 });
ex16('AMRG', 'AMRG', '0-14', 'Unknown', [2, 2, 0, 0, 0, 0, 0]);

// -- TBHIV (F lines 30-36). The compare ignores case and trailing spaces; any other text comes through as stored.
cs16('H01', { tbhiv: 'Non-Reactive' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Negative' });   // line 31
cs16('H02', { tbhiv: 'Reactive' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Positive' });       // line 32
cs16('H03', { tbhiv: 'Pulmonary' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Positive' });      // line 33
cs16('H04', {}, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Unknown' });                            // line 34: no answer
cs16('H05', { tbhiv: 'Negative' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Negative' });
cs16('H06', { tbhiv: 'Positive' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Positive' });
cs16('H07', { tbhiv: 'non-reactive ' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Negative' });
cs16('H08', { tbhiv: 'REACTIVE' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Positive' });
cs16('H09', { tbhiv: 'pulmonary  ' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Positive' });
cs16('H10', { tbhiv: 'Indeterminate' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Indeterminate' });   // line 35
cs16('H11', { tbhiv: '' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: '' });                              // a blank answer is not NULL
cs16('H12', { tbhiv: 'Unknown' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Unknown' });
cs16('H13', { tbhiv: 'Non Reactive' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Non Reactive' });
cs16('H14', { tbhiv: null }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Unknown' });                      // an answer without a value
cs16('H15', { tbhiv: 'Reactive', tbcolPanel: 'HIVVL' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Unknown' });   // only panel TBCOL (view line 83)
cs16('H16', { tbhiv: 'Reactive', tbcolPanel: 'tbcol ' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'Positive' });
cs16('H17', { tbhiv: 'positive ' }, [1, 1, 0, 0, 0, 0, 0], { tbhiv: 'positive ' });             // as stored, trailing space and all
// Groups merge on the compare: 'NEGATIVE', 'Negative' (from Non-Reactive) and 'negative ' are one TBHIV, shown with the smallest spelling.
for (const [i, tbhiv] of ['NEGATIVE', 'Non-Reactive', 'negative ', 'Negative'].entries()) req16(`T16-HMRG${i + 1}`, { perf: 'HMRG', tbhiv });
ex16('HMRG', 'HMRG', '15+', 'NEGATIVE', [4, 4, 0, 0, 0, 0, 0]);
for (const [i, tbhiv] of ['Reactive', 'positive', 'Pulmonary'].entries()) req16(`T16-HPOS${i + 1}`, { perf: 'HPOS', tbhiv });
ex16('HPOS', 'HPOS', '15+', 'Positive', [3, 3, 0, 0, 0, 0, 0]);
// A stored 'Unknown' and a missing answer are one group.
req16('T16-HUNK1', { perf: 'HUNK', tbhiv: 'Unknown' });
req16('T16-HUNK2', { perf: 'HUNK', tbhiv: 'unknown ' });
req16('T16-HUNK3', { perf: 'HUNK' });
ex16('HUNK', 'HUNK', '15+', 'Unknown', [3, 3, 0, 0, 0, 0, 0]);

// -- The testing lab (F lines 14-15, 66, 71-72). Rows group on TestedAt and LabName, each compared ignoring case and trailing spaces, and show
// the smallest spelling in byte order.
req16('T16-LAB1', { perf: 'LUS', disp: 'Lusaka Lab' });
req16('T16-LAB2', { perf: 'lus', disp: 'LUSAKA LAB' });
req16('T16-LAB3', { perf: 'LUS ', disp: 'lusaka lab ' });
ex16('LUS', 'LUSAKA LAB', '15+', 'Unknown', [3, 3, 0, 0, 0, 0, 0]);
// Two codes with one name are two rows (the code is in the group).
req16('T16-LAB4', { perf: 'KIT', disp: 'Shared Lab' });
req16('T16-LAB5', { perf: 'NDO', disp: 'Shared Lab' });
ex16('KIT', 'Shared Lab', '15+', 'Unknown', [1, 1, 0, 0, 0, 0, 0]);
ex16('NDO', 'Shared Lab', '15+', 'Unknown', [1, 1, 0, 0, 0, 0, 0]);
// One code with two names is two rows: the name is in the group. v1's dictionary gives one name to a code; CE names a lab from each report.
req16('T16-LAB6', { perf: 'SPL', disp: 'Name A' });
req16('T16-LAB7', { perf: 'SPL', disp: 'Name B' });
ex16('SPL', 'Name A', '15+', 'Unknown', [1, 1, 0, 0, 0, 0, 0]);
ex16('SPL', 'Name B', '15+', 'Unknown', [1, 1, 0, 0, 0, 0, 0]);
// The name is the report's display, else the register name of the mapped code (a blank display counts as none), else the code.
req16('T16-LAB8', { perf: 'LUSX' });
req16('T16-LAB9', { perf: 'LUSX', disp: '  ' });
ex16('LUSX', 'Lusaka Provincial Lab', '15+', 'Unknown', [2, 2, 0, 0, 0, 0, 0]);
req16('T16-LAB10', { perf: 'LUSX', disp: 'Override Name' });
ex16('LUSX', 'Override Name', '15+', 'Unknown', [1, 1, 0, 0, 0, 0, 0]);
// No testing code: TestedAt is NULL and so is LabName (v1's join finds no lab for a NULL code), even where the report has a display. The RIF is lost
// (a NULL fact), so these count the MTB only. A blank, a NULL, spaces only and no report at all are one group.
req16('T16-NUL1', { perf: '', disp: 'Ghost Lab' });
req16('T16-NUL2', { perf: null, disp: 'Ghost Lab' });
req16('T16-NUL3', { perf: 'ZZZ', report: false });
req16('T16-NUL4', { perf: '  ', disp: 'Ghost Lab' });
ex16(null, null, '15+', 'Unknown', [4, 0, 0, 0, 0, 0, 0]);

// -- Which rows count (view lines 46 and 73): panel TBGNX or POCGT, GXMTB results. No test on the report status.
cs16('S01', { panel: 'POCGT' }, [1, 1, 0, 0, 0, 0, 0]);
cs16('S02', { panel: 'pocgt ' }, [1, 1, 0, 0, 0, 0, 0]);
req16('T16-S03', { perf: 'S03', panel: 'HIVVL' });                                         // not a GeneXpert panel: no row
req16('T16-S04', { perf: 'S04', mtb: undefined, rif: 'Detected' });                        // a GXRIF alone makes no row
cs16('S05', { status: 'cancelled' }, [1, 1, 0, 0, 0, 0, 0]);
// A RIF on another request row of the lab number (the other panel) with equal facts joins.
req16('T16-S07', { perf: 'S07', rif: undefined });
req16('T16-S07', { perf: 'S07', panel: 'POCGT', mtb: undefined, rif: 'Detected' });
ex16('S07', 'S07', '15+', 'Unknown', [1, 0, 0, 0, 0, 0, 0]);
// No dedupe: two GXRIF results make two rows, two GXMTB results make two rows, two TBHIV answers make two rows.
req16('T16-S08', { perf: 'S08', mtb: 'Detected', rif: 'Not Detected', extra: [{ obs: 'GXRIF', text: 'Detected' }] });
ex16('S08', 'S08', '15+', 'Unknown', [0, 1, 1, 0, 0, 0, 0]);
req16('T16-S09', { perf: 'S09', mtb: 'Not Detected', rif: 'Not Detected', extra: [{ obs: 'GXMTB', text: 'Detected' }] });
ex16('S09', 'S09', '15+', 'Unknown', [1, 2, 0, 0, 0, 0, 0]);
req16('T16-S10', { perf: 'S10', tbhiv: ['Reactive', 'Non-Reactive'] });
ex16('S10', 'S10', '15+', 'Positive', [1, 1, 0, 0, 0, 0, 0]);
ex16('S10', 'S10', '15+', 'Negative', [1, 1, 0, 0, 0, 0, 0]);

// -- A NULL fact loses the RIF (view lines 110-120); the MTB row stays and counts.
cs16('N01', { received: null }, [1, 0, 0, 0, 0, 0, 0]);
cs16('N02', { req: 'ZUNMP' }, [1, 0, 0, 0, 0, 0, 0]);    // a facility the register does not know has no description
cs16('N03', { patient: false }, [1, 0, 0, 0, 0, 0, 0]);  // no patient: no sex

// -- The window (F line 67), on the analysis stamp: main 2026-05-04 .. 2026-05-06, day 2026-05-05 .. 2026-05-05.
const MAIN = ['main'];
const BOTH = ['main', 'day'];
const w16 = (code, analysis, wins) => {
  req16(`T16-${code}`, { perf: code, analysis });
  if (wins) ex16(code, code, '15+', 'Unknown', [1, 1, 0, 0, 0, 0, 0], wins);
};
w16('W01', '2026-05-04T00:00:00Z', MAIN);                // the first instant of `from`
w16('W02', '2026-05-03T23:59:59Z');                      // a second before
w16('W03', '2026-05-06T00:00:00Z', MAIN);                // the first instant of `to`: in
w16('W04', '2026-05-06T00:00:01Z');                      // a second later: out
w16('W05', '2026-05-05T12:00:00Z', MAIN);
w16('W06', '2026-05-04T00:30:00+02:00', MAIN);           // local 05-04 (UTC says 05-03)
w16('W07', '2026-05-03T23:30:00+02:00');                 // local 05-03
w16('W08', '2026-05-05T23:30:00+02:00', MAIN);
w16('W09', '2026-05-06T01:00:00+02:00');                 // local 05-06 01:00 is after midnight (UTC says 05-05 23:00)
w16('W10', '2026-05');                                   // a partial stamp is no date
w16('W11', null);                                        // no analysis stamp
w16('W12', '2026-05-05', BOTH);                          // a date alone is its midnight
w16('W13', '2026-05-06', MAIN);
w16('W14', '2026-05-06T00:00:00+02:00', MAIN);           // local midnight of `to`
w16('W15', '2026-05-05T00:00:00Z', BOTH);
w16('W16', '2026-05-05T00:00:00+02:00', BOTH);
w16('W17', '2026-05-05T00:00:01Z', MAIN);                // one second after midnight: not in a one-day window
w16('W18', '2026-05-04', MAIN);
// The window is on the analysis stamp, not the authorised one.
req16('T16-X01', { perf: 'X01', issued: '2026-07-01T10:00:00Z' });
ex16('X01', 'X01', '15+', 'Unknown', [1, 1, 0, 0, 0, 0, 0]);
req16('T16-X02', { perf: 'X02', analysis: '2026-06-20T09:00:00Z', issued: '2026-05-05T10:00:00Z' });

// The rows of a window, as the tests expect them.
const rowsIn16 = (win) => exp16.filter((e) => e.wins.includes(win)).map((e) => e.row);
const W16 = { from: '2026-05-04', to: '2026-05-06' };
const DAY16 = { from: '2026-05-05', to: '2026-05-05' };

const SETUP16 = `insert into facility_map (id, source_system, performer_system, source_code, registry_id, name, region, district) values
  ('t16-fm1', '', '', 'ZSOUT', 'reg-s', 'Choma General Hospital', 'Southern', 'Choma'),
  ('t16-fm2', '', '', 'ZUNMP', null, null, null, null),
  ('t16-fm3', '', '', 'LUSX', 'reg-lab', 'Lusaka Provincial Lab', 'Lusaka', 'Lusaka');
insert into patients (id, surname, sex) values ${P16.join(',\n  ')};
insert into lab_requests (id, request_id, panel_code, authored_at, analysis_at, requester_code, patient_id, age_years, age_days) values ${R16.join(',\n  ')};
insert into specimens (id, received_time) values ${S16.join(',\n  ')};
insert into diagnostic_reports (id, based_on_id, status, effective, issued, performer, performer_display, specimen_id) values ${D16.join(',\n  ')};
insert into lab_results (id, request_id, observation_code, text_value) values ${L16.join(',\n  ')};`;

const tbReportQuery = queries().find((q) => q.name === 'TB GeneXpert report');

// A multiset of rows (v1 has no ORDER BY; the query orders by every column): column order, the count, then every row.
function reportSuite16(name, params, expectedRows, setup = '') {
  const key = (r) => JSON.stringify(OUT16.map((c) => r[c] ?? null));
  return {
    name,
    setup,
    sql: `select ${lit(name)} || chr(9) || row_to_json(q)::text from (${tbReportQuery ? bind(tbReportQuery.sql, params) : 'select 1'}) q;`,
    count: expectedRows.length + 1,
    check(got) {
      if (!tbReportQuery) return ['query "TB GeneXpert report" is missing'];
      const failures = [];
      if (got.length !== expectedRows.length) failures.push(`expected ${expectedRows.length} rows, got ${got.length}`);
      if (got[0]) {
        failures.push(...inOrder(Object.keys(got[0]), OUT16));
        if (Object.keys(got[0]).length !== OUT16.length) failures.push(`expected ${OUT16.length} columns, got ${Object.keys(got[0]).length}`);
      }
      const left = expectedRows.map(key);
      for (const h of got.map(key)) {
        const i = left.indexOf(h);
        if (i < 0) failures.push(`unexpected row ${h}`); else left.splice(i, 1);
      }
      for (const w of left) failures.push(`missing row ${w}`);
      return failures;
    },
  };
}

const suites16 = [
  reportSuite16('tbreport-main', W16, rowsIn16('main'), SETUP16),
  // A window of one day holds only what is stamped exactly at midnight.
  reportSuite16('tbreport-day', DAY16, rowsIn16('day')),
  reportSuite16('tbreport-empty', { from: '2026-11-01', to: '2026-11-30' }, []),
  // The window can sit on the other side of the data: June holds only X02.
  reportSuite16('tbreport-june', { from: '2026-06-01', to: '2026-06-30' }, [
    Object.fromEntries(OUT16.map((c, i) => [c, ['X02', 'X02', '15+', 'Unknown', 1, 1, 0, 0, 0, 0, 0][i]]))]),
  {
    name: 'tbreport-shape',
    count: 8,
    check() {
      if (!tbReportQuery) return ['query "TB GeneXpert report" is missing'];
      const bad = [];
      const ids = tbReportQuery.params.map((p) => p.id);
      if (JSON.stringify(ids) !== JSON.stringify(['from', 'to'])) bad.push(`params: expected from, to; got ${ids}`);
      for (const p of tbReportQuery.params) {
        if (p.type !== 'text') bad.push(`${p.id}: expected type text, got ${p.type}`);
        if (p.required !== true) bad.push(`${p.id}: must be required (v1 has the window)`);
      }
      const text = tbReportQuery.sql;
      if (/--|\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge|call|copy|into)\b/i.test(text.replace(/'(?:[^']|'')*'/g, "''"))) bad.push('banned word or comment marker');
      if (!/^\s*with\b/i.test(text)) bad.push('does not start with "with"');
      if (!/order by 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11\s*$/.test(text)) bad.push('must end with a total ORDER BY over all 11 columns');
      return bad;
    },
  },
];

export const groups = [{ name: 't4', suites }, { name: 't15', suites: suites15 }, { name: 't16', suites: suites16 }];

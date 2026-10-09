// Check groups for the tb reports. Each task adds { name, suites } entries to this list.
//
// Group t4: the tbgnx builders (v1 view v_GeneXpert, sp_getTBsLastHour, Table__dbo_TBGNX.sql).
// Fixture ids start with "t4-". Lab ids (lr.request_id) start with "T4-".
// "view line N" is a line of View__dbo_v_GeneXpert.sql. "proc line N" is a line of
// StoredProcedure__dbo_sp_getTBsLastHour.sql.

import { lit, inOrder } from '../../shared/pg-check.mjs';
import { geneXpertCte, tbgnxCte } from '../zm-sql.mjs';

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
  { tested_at: null, specimen_date_time: null, received_date_time: null, authorised_date_time: null },
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
lab('T4-TA-000', [{ performer: '000' }], { tested_at: '000' }, [{}], []);
lab('T4-TA-000-SPACE', [{ performer: '000 ' }], { tested_at: '000 ' }, [{}], []);
lab('T4-TA-0000', [{ performer: '0000' }], { tested_at: '0000' }, [{}], [{ poc: 1, lab_name: '0000' }]);
lab('T4-TA-4567', [{ performer: '4567' }], { tested_at: '4567' }, [{}], [{ poc: 1, lab_name: '4567' }]);
lab('T4-TA-12', [{ performer: '12' }], { tested_at: '12' }, [{}], [{ poc: 1, lab_name: '12' }]);
lab('T4-TA-1E5', [{ performer: '1E5' }], { tested_at: '1E5' }, [{}], [{ poc: 1, lab_name: '1E5' }]);
lab('T4-TA-12A', [{ performer: '12A' }], { tested_at: '12A' }, [{}], [{ poc: 0, lab_name: '12A' }]);
lab('T4-TA-KIT', [{ performer: 'KIT' }], { tested_at: 'KIT' }, [{}], [{ lab_name: 'KIT' }]);
lab('T4-TA-DISPLAY', [{ performer: 'KIT', display: 'Kitwe Central Lab' }], { tested_at: 'KIT' }, [{}], [{ lab_name: 'Kitwe Central Lab' }]);
lab('T4-TA-DISPLAY-BLANK', [{ display: '  ' }], {}, [{}], [{}]);
lab('T4-TA-NULL', [{ performer: null }], { tested_at: null, rif: null }, [{}], []);
lab('T4-TA-BLANK', [{ performer: '' }], { tested_at: null, rif: null }, [{}], []);
lab('T4-TA-SPACES', [{ performer: '  ' }], { tested_at: null, rif: null }, [{}], []);
// POCGT with a text code, TBGNX with a numeric code: both POC.
lab('T4-POC-PANEL', [{ panel: 'POCGT', performer: 'KIT' }], { tested_at: 'KIT', lims_panel_code: 'POCGT' }, [{}], [{ poc: 1, lab_name: 'KIT' }]);

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
// inRange compares text, so '2026-05-31T23:59:59Z' (no fraction) sorts after '2026-05-31T23:59:59.999Z' and is
// out of the window. DISA stamps carry '+02:00', which sorts before '.', so they are not affected. Noted in the report.
edge('IN2', '2026-05-31T23:59:00Z', 805, 0);
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

const inDay = (r, from, to) => r.authorised_date_time !== null && r.authorised_date_time >= from && r.authorised_date_time <= `${to}T23:59:59.999Z`;
const MAY = { from: '2026-05-01', to: '2026-05-31' };
const gxRows = gxExpected;
const tbRows = tbExpected;

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

export const groups = [{ name: 't4', suites }];

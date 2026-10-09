// Builds the reports-zm content pack.
//
//   node packs/reports-zm/build.mjs
//
// Reads Zambia's master facility list (ZM_MFL_CSV, else the corlix fixture path below) and writes
// dist/ (git-ignored), next to this script:
//   pack.json            the pack payload, in install order
//   manifest.json        the unsigned artifact manifest; `openldr artifact pack` signs it
//   build-summary.json   row counts and every row or value left out, with the reason

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv, summarizeStep } from '../shared/pack-build.mjs';
import { zmQueryFile, ZM_REGISTER_URL } from './zm-queries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, 'dist');
const MFL_CSV = process.env.ZM_MFL_CSV
  ?? 'D:/Projects/Repositories/corlix/fixtures/Zambia_master_facility_list/mfl_facilities_export20260810155748.csv';

// MFL "Operational status" as CE location-status codes (active, suspended, inactive).
const STATUS = { 'Functional': 'active', 'Closed': 'inactive', 'Permanent closure': 'inactive', 'Temporarily closure': 'suspended' };
// CE's own ownership and ward columns take the MFL Ownership and Ward values; six others go to extras.
// MFL columns kept raw in extras, as [MFL header, extras key]. CE stores extras keys in lowercase.
const EXTRAS = [
  ['Hims code', 'hims_code'], ['DHIS2 UID', 'dhis2_uid'], ['Type', 'type'],
  ['Ownership type', 'ownership_type'], ['Constituency', 'constituency'], ['Location', 'location'],
];
const EXTRA_COLUMNS = EXTRAS.map(([, key]) => key);
const COLUMNS = ['national_code', 'name', 'region', 'district', 'status', 'latitude', 'longitude', 'ownership', 'ward', ...EXTRA_COLUMNS];

const clean = (v) => (v == null ? '' : String(v).trim());

// RFC 4180: quoted cells, doubled quotes, commas and line breaks inside quotes.
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

// Zambia's extent with a small margin. The list has pairs that are valid numbers but not in Zambia
// (a Paris position, a swapped latitude and longitude, a lost minus sign).
const ZAMBIA_LAT = [-18.5, -8.0];
const ZAMBIA_LON = [21.5, 34.0];

// CE drops a row's coordinates unless both are valid, so the build keeps both or neither. A pair is
// valid only inside Zambia's box.
function coordinates(latRaw, lonRaw) {
  const lat = clean(latRaw), lon = clean(lonRaw);
  if (!lat && !lon) return { latitude: '', longitude: '', problem: null };
  const la = Number(lat), lo = Number(lon);
  const numeric = lat !== '' && lon !== '' && Number.isFinite(la) && Number.isFinite(lo) && la >= -90 && la <= 90 && lo >= -180 && lo <= 180;
  if (!numeric) return { latitude: '', longitude: '', problem: `coordinates "${lat}", "${lon}" are not a valid pair; both left out` };
  const inside = la >= ZAMBIA_LAT[0] && la <= ZAMBIA_LAT[1] && lo >= ZAMBIA_LON[0] && lo <= ZAMBIA_LON[1];
  return inside ? { latitude: lat, longitude: lon, problem: null }
    : { latitude: '', longitude: '', problem: `coordinates "${lat}", "${lon}" are outside Zambia (lat ${ZAMBIA_LAT[0]} to ${ZAMBIA_LAT[1]}, lon ${ZAMBIA_LON[0]} to ${ZAMBIA_LON[1]}); both left out` };
}

function writeJson(name, value) {
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function main() {
  const [header, ...rows] = parseCsv(readFileSync(MFL_CSV, 'utf8').replace(/^\uFEFF/, ''));
  const col = (name) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`the MFL CSV has no "${name}" column`);
    return i;
  };
  const at = (row, name) => clean(row[col(name)]);

  const summary = {
    source: MFL_CSV,
    builtAt: new Date().toISOString(),
    read: rows.length,
    register: { rows: 0, byStatus: {}, left_out: [], coordinates_left_out: [] },
  };

  const byCode = new Map();
  for (const row of rows) {
    const code = at(row, 'MFL Code');
    const name = at(row, 'Name');
    if (!code) { summary.register.left_out.push({ key: name, reason: 'blank MFL Code' }); continue; }
    if (!name) { summary.register.left_out.push({ key: code, reason: 'blank Name' }); continue; }
    if (byCode.has(code)) { summary.register.left_out.push({ key: code, reason: 'duplicate MFL Code' }); continue; }
    const operational = at(row, 'Operational status');
    const status = STATUS[operational];
    if (status === undefined) throw new Error(`MFL Code ${code}: unknown Operational status "${operational}"`);
    const coords = coordinates(row[col('Latitude')], row[col('Longitude')]);
    if (coords.problem) summary.register.coordinates_left_out.push({ key: code, reason: coords.problem });
    const rec = {
      national_code: code, name, region: at(row, 'Province'), district: at(row, 'District'), status,
      latitude: coords.latitude, longitude: coords.longitude, ownership: at(row, 'Ownership'), ward: at(row, 'Ward'),
    };
    for (const [source, key] of EXTRAS) rec[key] = at(row, source);
    byCode.set(code, rec);
  }
  const regRows = [...byCode.values()].sort((a, b) => a.national_code.localeCompare(b.national_code, 'en', { numeric: true }));
  summary.register.rows = regRows.length;
  for (const r of regRows) summary.register.byStatus[r.status] = (summary.register.byStatus[r.status] ?? 0) + 1;

  const steps = [
    // No link-matching step: DISA facility codes are letters, MFL codes are numbers, so equal codes
    // never meet. An admin maps DISA codes to these rows in CE's Facilities screen (spec section 1).
    { kind: 'facility-register', url: ZM_REGISTER_URL, name: 'Zambia health facilities', code: 'ZMFAC', csv: toCsv(regRows, COLUMNS), extraColumns: EXTRA_COLUMNS },
    { kind: 'custom-queries', file: zmQueryFile() },
  ];
  writeJson('pack.json', { formatVersion: 1, steps });

  const leftOut = [
    ...summary.register.left_out.map((r) => `facility register, MFL ${r.key}: ${r.reason}`),
    ...summary.register.coordinates_left_out.map((r) => `facility register, MFL ${r.key}: ${r.reason}`),
  ];
  const readme = readFileSync(join(here, 'PACK.md'), 'utf8').trimEnd()
    + `\n\n## Rows and values left out of this build\n\nBuilt from the Zambia master facility list. ${leftOut.length} left out.\n\n`
    + leftOut.map((l) => `- ${l}`).join('\n') + '\n';
  writeJson('manifest.json', {
    schemaVersion: 1,
    type: 'content-pack',
    id: 'reports-zm',
    version: '0.1.0',
    description: "Zambia's v1 reports in OpenLDR CE, for data exported from DISA*Lab.",
    readme,
    license: 'UNLICENSED',
    publisher: { id: 'openldr-content', name: 'OpenLDR Content Publisher', keyFingerprint: '0'.repeat(64) },
    compatibility: { ceVersion: '*' },
    capabilities: [],
    payload: { kind: 'content-pack', steps: steps.map(summarizeStep) },
  });
  writeJson('build-summary.json', summary);

  console.log(JSON.stringify({
    read: summary.read,
    steps: steps.map(summarizeStep),
    register: { rows: summary.register.rows, byStatus: summary.register.byStatus, leftOut: summary.register.left_out.length, coordinatesLeftOut: summary.register.coordinates_left_out.length },
  }, null, 2));
}

try { main(); } catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }

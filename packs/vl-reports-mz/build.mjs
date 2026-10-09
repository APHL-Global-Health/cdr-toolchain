// Builds the vl-reports-mz content pack from the Mozambique v1 dictionary (OpenLDRDict_MZ).
//
//   node packs/vl-reports-mz/build.mjs
//
// Reads SQL Server with SELECT only. The connection string comes from the DISA_CONNECTION_STRING
// environment variable, or else from the DISA_CONNECTION_STRING line of cdr-toolchain's
// apps/cli/.env. The password is never written to any output file.
//
// Writes to dist/ (git-ignored), next to this script:
//   pack.json            the pack payload: eleven steps, in install order
//   manifest.json        the unsigned artifact manifest. `openldr artifact pack` fills in the
//                        key fingerprint and the payload hash, then signs it.
//   build-summary.json   row counts and every row left out, with the reason

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vlQueryFile, MOZ_CODES, VL_CODED_SYSTEM, VL_CODED_VALUE_SET } from './vl-queries.mjs';
import { pickCodedResultDisplays } from './vl-coded-results.mjs';
import { facilitiesQuery } from './facility-queries.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, 'dist');
const require = createRequire(import.meta.url);
const MSSQL = process.env.MSSQL_MODULE ?? 'D:/Projects/Repositories/cdr-toolchain/packages/disalab/node_modules/mssql';
const ENV_FILE = process.env.DISA_ENV_FILE ?? 'D:/Projects/Repositories/cdr-toolchain/apps/cli/.env';
const DICT_DB = process.env.DISA_DICT_DB ?? 'OpenLDRDict_MZ';

function connectionString() {
  let cs = process.env.DISA_CONNECTION_STRING;
  if (!cs) {
    const line = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).find((l) => l.startsWith('DISA_CONNECTION_STRING='));
    if (!line) throw new Error(`no DISA_CONNECTION_STRING in the environment or in ${ENV_FILE}`);
    cs = line.slice('DISA_CONNECTION_STRING='.length);
  }
  return cs.replace(/;?\s*$/, '') + `;Database=${DICT_DB}`;
}

// HFStatus as CE location-status codes. Confirmed by the Mozambique team on 2026-10-09.
const HF_STATUS = { 1: 'active', 0: 'inactive' };

const clean = (v) => (v == null ? '' : String(v).trim());
// The facility dictionary writes some empty values as the text NULL.
const cleanNull = (v) => (clean(v).toUpperCase() === 'NULL' ? '' : clean(v));

function csvCell(v) {
  const s = clean(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function codeSystem(url, name, title, description, rows) {
  return {
    resourceType: 'CodeSystem',
    url,
    name,
    title,
    description,
    status: 'active',
    content: 'complete',
    concept: rows.map((r) => ({ code: r.code, display: r.display })),
  };
}

function valueSet(url, name, title, description, systemUrl, rows) {
  const concept = rows.map((r) => ({ code: r.code, display: r.display }));
  return {
    resourceType: 'ValueSet',
    url,
    name,
    title,
    description,
    status: 'active',
    compose: { include: [{ system: systemUrl, concept }] },
    // The warehouse table terminology_codes is filled from expansion.contains only.
    expansion: {
      timestamp: new Date().toISOString(),
      total: concept.length,
      contains: rows.map((r) => ({ system: systemUrl, code: r.code, display: r.display })),
    },
  };
}

function writeJson(name, value) {
  mkdirSync(DIST, { recursive: true });
  writeFileSync(join(DIST, name), JSON.stringify(value, null, 2) + '\n', 'utf8');
}

// Step summaries for manifest.payload.steps. These rules are copied from summarizeContentPack in
// CE's packages/marketplace/src/content-pack.ts. If one changes, change the other.
function summarizeStep(step) {
  switch (step.kind) {
    case 'code-system':
    case 'value-set':
      return { kind: step.kind, label: step.resource.name ?? step.resource.url, count: 1 };
    case 'facility-register':
      // The same expression as CE's summarizeContentPack, so the signed step list matches pack.json.
      return { kind: step.kind, label: step.name, count: step.csv.split(/\r?\n/).slice(1).filter((l) => l.trim() !== '').length };
    case 'link-matching':
      return { kind: step.kind, label: step.registerUrl, count: 1 };
    case 'custom-queries':
      return { kind: step.kind, label: step.file.queries.map((q) => q.name).join(', '), count: step.file.queries.length };
    default:
      throw new Error(`unknown step kind ${step.kind}`);
  }
}

async function main() {
  const sql = require(MSSQL);
  const pool = await sql.connect(connectionString());
  let labs, pocs, links, facilities, codedValues;
  try {
    labs = (await pool.request().query('SELECT LabCode, LabName, LabType FROM dbo.Laboratories')).recordset;
    pocs = (await pool.request().query(
      'SELECT DisaPocCode, DisaPocName, DisaPocLabNo, DisaPocProvinceName, DisapocDistrictName, DisapocState FROM dbo.DisaPoc',
    )).recordset;
    links = (await pool.request().query('SELECT DlinkCode, DlinkName, DlinkState FROM dbo.Disalink')).recordset;
    facilities = (await pool.request().query(
      'SELECT FacilityCode, Description, ProvinceName, DistrictName, ProvinceCode, DistrictCode, FacilityType, HFStatus, FacilityNationalCode FROM dbo.viewFacilities',
    )).recordset;
    // The panels v1's ViralLoadResultMerge reads.
    codedValues = (await pool.request().query(
      "SELECT LIMSPanelCode, LIMSCodedValue, Description FROM dbo.LIMSCodedValues WHERE LIMSPanelCode IN ('HIVVL', 'VIRAL')",
    )).recordset;
  } finally {
    await pool.close();
  }

  const summary = {
    source: DICT_DB,
    builtAt: new Date().toISOString(),
    read: { laboratories: labs.length, disaPoc: pocs.length, disalink: links.length, viewFacilities: facilities.length, limsCodedValues: codedValues.length },
    register: { rows: 0, fromLaboratories: 0, fromDisaPoc: 0, left_out: [] },
    facilityRegister: { rows: 0, sharedWithLabs: 0, left_out: [] },
    pocValueSet: { concepts: 0, left_out: [] },
    linkValueSet: { concepts: 0, left_out: [] },
    vlCodedResults: { concepts: 0, choices: [], left_out: [] },
  };

  // ---- Register: one row per code. ----
  // v1's views pick the POC's name, province and district when the testing code matches the
  // first 3 characters of DisaPocLabNo, and only otherwise fall back. So a POC row wins over a
  // Laboratories row with the same code.
  // Several POCs can share a prefix. The active one (DisapocState = 1) wins. If more than one
  // active POC remains, the lowest DisaPocCode wins and the others are reported.
  const byPrefix = new Map();
  for (const p of pocs) {
    const labNo = clean(p.DisaPocLabNo);
    if (!labNo) {
      summary.register.left_out.push({ table: 'DisaPoc', key: clean(p.DisaPocCode), reason: 'blank DisaPocLabNo, so no lab code' });
      continue;
    }
    const prefix = labNo.slice(0, 3);
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(p);
  }
  const register = new Map();
  for (const [prefix, group] of byPrefix) {
    const sorted = [...group].sort((a, b) =>
      (Number(b.DisapocState === 1 || b.DisapocState === true) - Number(a.DisapocState === 1 || a.DisapocState === true))
      || clean(a.DisaPocCode).localeCompare(clean(b.DisaPocCode)));
    const [winner, ...losers] = sorted;
    for (const l of losers) {
      summary.register.left_out.push({
        table: 'DisaPoc', key: clean(l.DisaPocCode), code: prefix,
        reason: `prefix ${prefix} also used by ${clean(winner.DisaPocCode)} (${clean(winner.DisaPocName)}, state ${winner.DisapocState}); kept that one (state ${l.DisapocState} here)`,
      });
    }
    register.set(prefix, {
      national_code: prefix,
      name: clean(winner.DisaPocName),
      region: clean(winner.DisaPocProvinceName),
      district: clean(winner.DisapocDistrictName),
      from: 'DisaPoc',
    });
  }
  for (const l of labs) {
    const code = clean(l.LabCode);
    if (!code) {
      summary.register.left_out.push({ table: 'Laboratories', key: clean(l.LabName), reason: 'blank LabCode' });
      continue;
    }
    if (!clean(l.LabName)) {
      // The facility import needs a name and would skip the row anyway. Say so here instead.
      summary.register.left_out.push({ table: 'Laboratories', key: code, code, reason: `blank LabName (LabType ${clean(l.LabType)})` });
      continue;
    }
    if (register.has(code)) {
      const kept = register.get(code);
      summary.register.left_out.push({
        table: 'Laboratories', key: code, code,
        reason: `code ${code} is also a POC prefix; kept the POC row "${kept.name}" (v1 prefers the POC), dropped "${clean(l.LabName)}"`,
      });
      continue;
    }
    register.set(code, { national_code: code, name: clean(l.LabName), region: '', district: '', from: 'Laboratories' });
  }
  const regRows = [...register.values()].sort((a, b) => a.national_code.localeCompare(b.national_code));
  const header = ['national_code', 'name', 'region', 'district'];
  const toCsv = (rows, cols = header) => [cols.join(','), ...rows.map((r) => cols.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n';
  const csv = toCsv(regRows);
  summary.register.rows = regRows.length;
  summary.register.fromLaboratories = regRows.filter((r) => r.from === 'Laboratories').length;
  summary.register.fromDisaPoc = regRows.filter((r) => r.from === 'DisaPoc').length;

  // ---- Facility register: one row per viewFacilities row, keyed on FacilityCode, the DISA code.
  // Not the MISAU national code (slice A decision). Facility type and HFStatus are left out: they
  // need value mapping first.
  const facilityByCode = new Map();
  for (const f of facilities) {
    const code = cleanNull(f.FacilityCode);
    if (!code) { summary.facilityRegister.left_out.push({ key: cleanNull(f.Description), reason: 'blank FacilityCode' }); continue; }
    if (!cleanNull(f.Description)) { summary.facilityRegister.left_out.push({ key: code, reason: 'blank Description' }); continue; }
    if (facilityByCode.has(code)) { summary.facilityRegister.left_out.push({ key: code, reason: 'duplicate FacilityCode' }); continue; }
    facilityByCode.set(code, {
      national_code: code,
      name: cleanNull(f.Description),
      region: cleanNull(f.ProvinceName),
      district: cleanNull(f.DistrictName),
      province_code: cleanNull(f.ProvinceCode),
      district_code: cleanNull(f.DistrictCode),
      facility_type: cleanNull(f.FacilityType),
      hf_status: cleanNull(f.HFStatus),
      // CE's own status, from HFStatus. The Mozambique team confirmed 1 = active, 0 = closed
      // (2026-10-09). FHIR location-status has no "closed"; "inactive" is its "no longer used".
      status: HF_STATUS[cleanNull(f.HFStatus)] ?? '',
      facility_national_code: cleanNull(f.FacilityNationalCode),
    });
  }
  const facilityRows = [...facilityByCode.values()].sort((a, b) => a.national_code.localeCompare(b.national_code));
  // These v1 values go in extras exactly as v1 has them. CE has no column for the area codes or the
  // MISAU national code (the register is keyed on the DISA code), and level needs the FacilityType
  // letters defined first. hf_status stays raw beside the mapped status. The headers are lowercase
  // because CE stores extras keys in lowercase.
  const FACILITY_EXTRA_COLUMNS = ['province_code', 'district_code', 'facility_type', 'hf_status', 'facility_national_code'];
  const facilityCsv = toCsv(facilityRows, [...header, 'status', ...FACILITY_EXTRA_COLUMNS]);
  summary.facilityRegister.rows = facilityRows.length;
  // Codes in both registers. Link-matching gives each one to the register linked first.
  summary.facilityRegister.sharedWithLabs = facilityRows.filter((r) => register.has(r.national_code)).length;

  // ---- Value sets. Every row, active or not: v1's IsDisaPoc and IsDisaLink do not filter on state. ----
  const pocRows = [];
  const seenPoc = new Set();
  for (const p of pocs) {
    const code = clean(p.DisaPocCode);
    if (!code) { summary.pocValueSet.left_out.push({ key: clean(p.DisaPocName), reason: 'blank DisaPocCode' }); continue; }
    if (seenPoc.has(code)) { summary.pocValueSet.left_out.push({ key: code, reason: 'duplicate DisaPocCode' }); continue; }
    seenPoc.add(code);
    pocRows.push({ code, display: clean(p.DisaPocName) || code });
  }
  const linkRows = [];
  const seenLink = new Set();
  for (const l of links) {
    const code = clean(l.DlinkCode);
    if (!code) { summary.linkValueSet.left_out.push({ key: clean(l.DlinkName), reason: 'blank DlinkCode' }); continue; }
    if (seenLink.has(code)) { summary.linkValueSet.left_out.push({ key: code, reason: 'duplicate DlinkCode' }); continue; }
    seenLink.add(code);
    linkRows.push({ code, display: clean(l.DlinkName) || code });
  }
  pocRows.sort((a, b) => a.code.localeCompare(b.code));
  linkRows.sort((a, b) => a.code.localeCompare(b.code));
  summary.pocValueSet.concepts = pocRows.length;
  summary.linkValueSet.concepts = linkRows.length;

  // ---- Coded VL results: one description per code. See vl-coded-results.mjs for the rule. ----
  const coded = pickCodedResultDisplays(codedValues.map((r) => ({
    panel: r.LIMSPanelCode, code: r.LIMSCodedValue, description: r.Description,
  })));
  summary.vlCodedResults.concepts = coded.concepts.length;
  summary.vlCodedResults.choices = coded.choices;
  summary.vlCodedResults.left_out = coded.leftOut;

  // ---- Pack steps, in install order. ----
  const POC_CS = 'urn:openldr:mz:cs:poc-sites';
  const LINK_CS = 'urn:openldr:mz:cs:link-sites';
  const REGISTER_URL = 'urn:openldr:mz:laboratories';
  const FACILITY_REGISTER_URL = 'urn:openldr:mz:facilities';
  const POC_TITLE = 'Mozambique POC sites';
  const LINK_TITLE = 'Mozambique link sites';
  // Shown under the name on the CE Terminology page.
  const POC_DESCRIPTION = 'Point-of-care sites, from the v1 dictionary list DisaPoc. The VL queries use it for the IsDisaPoc column.';
  const LINK_DESCRIPTION = 'Link sites, from the v1 dictionary list Disalink. The VL queries use it for the IsDisaLink column.';
  const VL_CODED_TITLE = 'Mozambique viral load coded results';
  const VL_CODED_DESCRIPTION = 'Viral load result codes and their descriptions, from the v1 dictionary list LIMSCodedValues (panels HIVVL and VIRAL). "VL results" uses it to show a coded result as text, as v1 did.';
  const queryFile = vlQueryFile(MOZ_CODES);
  const steps = [
    { kind: 'code-system', resource: codeSystem(POC_CS, 'MozPocSites', POC_TITLE, POC_DESCRIPTION, pocRows) },
    { kind: 'value-set', resource: valueSet('urn:openldr:mz:poc-sites', 'MozPocSites', POC_TITLE, POC_DESCRIPTION, POC_CS, pocRows) },
    { kind: 'code-system', resource: codeSystem(LINK_CS, 'MozLinkSites', LINK_TITLE, LINK_DESCRIPTION, linkRows) },
    { kind: 'value-set', resource: valueSet('urn:openldr:mz:link-sites', 'MozLinkSites', LINK_TITLE, LINK_DESCRIPTION, LINK_CS, linkRows) },
    { kind: 'code-system', resource: codeSystem(VL_CODED_SYSTEM, 'MozVlCodedResults', VL_CODED_TITLE, VL_CODED_DESCRIPTION, coded.concepts) },
    { kind: 'value-set', resource: valueSet(VL_CODED_VALUE_SET, 'MozVlCodedResults', VL_CODED_TITLE, VL_CODED_DESCRIPTION, VL_CODED_SYSTEM, coded.concepts) },
    { kind: 'facility-register', url: REGISTER_URL, name: 'Mozambique laboratories and POC sites', code: 'MZLABS', csv },
    { kind: 'facility-register', url: FACILITY_REGISTER_URL, name: 'Mozambique health facilities', code: 'MZFAC', csv: facilityCsv, extraColumns: FACILITY_EXTRA_COLUMNS },
    // The facility register links first. The two registers share some codes (45 on 2026-10-07),
    // and each pair names the same place. Link-matching does not filter by observed system, so the
    // register linked first takes a shared code for testing labs and requesting facilities alike.
    // The facility rows carry province and district. The lab rows for these codes do not.
    { kind: 'link-matching', registerUrl: FACILITY_REGISTER_URL },
    { kind: 'link-matching', registerUrl: REGISTER_URL },
    // The VL queries, then the facility list in v1's viewFacilities layout.
    { kind: 'custom-queries', file: { ...queryFile, queries: [...queryFile.queries, facilitiesQuery(FACILITY_REGISTER_URL)] } },
  ];
  writeJson('pack.json', { formatVersion: 1, steps });

  // ---- Manifest. `openldr artifact pack` overwrites publisher.keyFingerprint and fills the
  // payload hash. The zeros only satisfy the 64-hex check until then. ----
  const leftOut = [
    ...summary.register.left_out.map((r) => `register, ${r.table} ${r.key}: ${r.reason}`),
    ...summary.facilityRegister.left_out.map((r) => `facility register, viewFacilities ${r.key}: ${r.reason}`),
    ...summary.pocValueSet.left_out.map((r) => `POC value set, ${r.key}: ${r.reason}`),
    ...summary.linkValueSet.left_out.map((r) => `link value set, ${r.key}: ${r.reason}`),
    ...summary.vlCodedResults.left_out.map((r) => `VL coded results, ${r.key}: ${r.reason}`),
  ];
  // The admin-facing text shown in the marketplace. README.md is for pack authors.
  const readme = readFileSync(join(here, 'PACK.md'), 'utf8').trimEnd()
    + `\n\n## Rows left out of this build\n\nBuilt from ${summary.source}. ${leftOut.length} rows left out.\n\n`
    + leftOut.map((l) => `- ${l}`).join('\n') + '\n';
  writeJson('manifest.json', {
    schemaVersion: 1,
    type: 'content-pack',
    id: 'vl-reports-mz',
    version: '0.5.3',
    description: 'Viral load reports in the v1 layout, for data exported from DISA*Lab.',
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
    register: { rows: summary.register.rows, fromLaboratories: summary.register.fromLaboratories, fromDisaPoc: summary.register.fromDisaPoc, leftOut: summary.register.left_out.length },
    facilityRegister: { rows: summary.facilityRegister.rows, sharedWithLabs: summary.facilityRegister.sharedWithLabs, leftOut: summary.facilityRegister.left_out.length },
    pocValueSet: { concepts: summary.pocValueSet.concepts, leftOut: summary.pocValueSet.left_out.length },
    linkValueSet: { concepts: summary.linkValueSet.concepts, leftOut: summary.linkValueSet.left_out.length },
    vlCodedResults: { concepts: summary.vlCodedResults.concepts, choices: summary.vlCodedResults.choices.map((c) => `${c.code}: ${c.chosen}`), leftOut: summary.vlCodedResults.left_out.length },
  }, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });

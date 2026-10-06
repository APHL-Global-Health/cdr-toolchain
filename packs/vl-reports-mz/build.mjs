// Builds the vl-reports-mz content pack from the Mozambique v1 dictionary (OpenLDRDict_MZ).
//
//   node packs/vl-reports-mz/build.mjs
//
// Reads SQL Server with SELECT only. The connection string comes from the DISA_CONNECTION_STRING
// environment variable, or else from the DISA_CONNECTION_STRING line of cdr-toolchain's
// apps/cli/.env. The password is never written to any output file.
//
// Writes to dist/ (git-ignored), next to this script:
//   pack.json            the pack payload: seven steps, in install order
//   manifest.json        the unsigned artifact manifest. `openldr artifact pack` fills in the
//                        key fingerprint and the payload hash, then signs it.
//   build-summary.json   row counts and every row left out, with the reason

import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vlQueryFile, MOZ_CODES } from './vl-queries.mjs';

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

const clean = (v) => (v == null ? '' : String(v).trim());

function csvCell(v) {
  const s = clean(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function codeSystem(url, name, title, rows) {
  return {
    resourceType: 'CodeSystem',
    url,
    name,
    title,
    status: 'active',
    content: 'complete',
    concept: rows.map((r) => ({ code: r.code, display: r.display })),
  };
}

function valueSet(url, name, title, systemUrl, rows) {
  const concept = rows.map((r) => ({ code: r.code, display: r.display }));
  return {
    resourceType: 'ValueSet',
    url,
    name,
    title,
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
  let labs, pocs, links;
  try {
    labs = (await pool.request().query('SELECT LabCode, LabName, LabType FROM dbo.Laboratories')).recordset;
    pocs = (await pool.request().query(
      'SELECT DisaPocCode, DisaPocName, DisaPocLabNo, DisaPocProvinceName, DisapocDistrictName, DisapocState FROM dbo.DisaPoc',
    )).recordset;
    links = (await pool.request().query('SELECT DlinkCode, DlinkName, DlinkState FROM dbo.Disalink')).recordset;
  } finally {
    await pool.close();
  }

  const summary = {
    source: DICT_DB,
    builtAt: new Date().toISOString(),
    read: { laboratories: labs.length, disaPoc: pocs.length, disalink: links.length },
    register: { rows: 0, fromLaboratories: 0, fromDisaPoc: 0, left_out: [] },
    pocValueSet: { concepts: 0, left_out: [] },
    linkValueSet: { concepts: 0, left_out: [] },
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
  const csv = [header.join(','), ...regRows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n';
  summary.register.rows = regRows.length;
  summary.register.fromLaboratories = regRows.filter((r) => r.from === 'Laboratories').length;
  summary.register.fromDisaPoc = regRows.filter((r) => r.from === 'DisaPoc').length;

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

  // ---- Pack steps, in install order. ----
  const POC_CS = 'urn:openldr:mz:cs:poc-sites';
  const LINK_CS = 'urn:openldr:mz:cs:link-sites';
  const REGISTER_URL = 'urn:openldr:mz:laboratories';
  const POC_TITLE = 'Mozambique POC sites';
  const LINK_TITLE = 'Mozambique link sites';
  const steps = [
    { kind: 'code-system', resource: codeSystem(POC_CS, 'MozPocSites', POC_TITLE, pocRows) },
    { kind: 'value-set', resource: valueSet('urn:openldr:mz:poc-sites', 'MozPocSites', POC_TITLE, POC_CS, pocRows) },
    { kind: 'code-system', resource: codeSystem(LINK_CS, 'MozLinkSites', LINK_TITLE, linkRows) },
    { kind: 'value-set', resource: valueSet('urn:openldr:mz:link-sites', 'MozLinkSites', LINK_TITLE, LINK_CS, linkRows) },
    { kind: 'facility-register', url: REGISTER_URL, name: 'Mozambique laboratories and POC sites', code: 'MZLABS', csv },
    { kind: 'link-matching', registerUrl: REGISTER_URL },
    { kind: 'custom-queries', file: vlQueryFile(MOZ_CODES) },
  ];
  writeJson('pack.json', { formatVersion: 1, steps });

  // ---- Manifest. `openldr artifact pack` overwrites publisher.keyFingerprint and fills the
  // payload hash. The zeros only satisfy the 64-hex check until then. ----
  const leftOut = [
    ...summary.register.left_out.map((r) => `register, ${r.table} ${r.key}: ${r.reason}`),
    ...summary.pocValueSet.left_out.map((r) => `POC value set, ${r.key}: ${r.reason}`),
    ...summary.linkValueSet.left_out.map((r) => `link value set, ${r.key}: ${r.reason}`),
  ];
  const readme = readFileSync(join(here, 'README.md'), 'utf8').trimEnd()
    + `\n\n## Rows left out of this build\n\nBuilt from ${summary.source}. ${leftOut.length} rows left out.\n\n`
    + leftOut.map((l) => `- ${l}`).join('\n') + '\n';
  writeJson('manifest.json', {
    schemaVersion: 1,
    type: 'content-pack',
    id: 'vl-reports-mz',
    version: '0.1.0',
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
    pocValueSet: { concepts: summary.pocValueSet.concepts, leftOut: summary.pocValueSet.left_out.length },
    linkValueSet: { concepts: summary.linkValueSet.concepts, leftOut: summary.linkValueSet.left_out.length },
  }, null, 2));
}

main().catch((e) => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); });

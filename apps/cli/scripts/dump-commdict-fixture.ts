// One-shot generator for the organism-classifier fixture. Run manually against a
// live DISA when the dictionary changes; the test path never touches a database.
//
//   cd apps/cli && node --import tsx scripts/dump-commdict-fixture.ts
//
// CONTEXT=50 is DISA's pathogen-id context (codebook.ts:10-16). The dictionaries
// live in DisaGlobal, NOT DisalabData.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getPool, closeAllPools } from "disalab";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig({});
if (!cfg.connectionString) throw new Error("DISA_CONNECTION_STRING not configured");

const pool = await getPool(cfg.connectionString);
const r = await pool.request().query(`
  SELECT LTRIM(RTRIM(CODE)) AS code, LTRIM(RTRIM(DESCRIPTION)) AS description
  FROM [DisaGlobal].[dbo].[COMMDICT] WHERE CONTEXT = 50 ORDER BY CODE`);
await closeAllPools();

const rows = (r.recordset as { code: string; description: string }[]).map((x) => ({
  code: String(x.code ?? ""),
  description: String(x.description ?? ""),
}));

const out = resolve(import.meta.dirname, "../src/export/__fixtures__/commdict-context50.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.log(`wrote ${rows.length} rows -> ${out}`);
process.exit(0);

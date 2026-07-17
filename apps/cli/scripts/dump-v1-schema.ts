// Regenerate with:
//   cd apps/cli && node --import tsx scripts/dump-v1-schema.ts
// Requires a live OpenLDR v1 connection (OPENLDR_V1_CONNECTION_STRING).
//
// The output is COMMITTED so the coverage guard runs without a database: the
// Zambia/Moz teams have no Tanzania v1, and CI has none at all. The snapshot's
// one failure mode is going stale, which v1-coverage.test.ts pins via the column
// COUNT — a truncated regeneration must fail loudly rather than quietly shrink
// what the coverage guard checks.
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getPool } from "disalab";
import { closePool } from "../src/db.js";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig({});
const cs = cfg.openldrConnectionString;
if (cs === undefined || cs.length === 0) {
  throw new Error("Set OPENLDR_V1_CONNECTION_STRING to regenerate the schema snapshot.");
}
const db = cfg.openldrDataDatabase;

const out: Record<string, string[]> = {};
try {
  const pool = await getPool(cs);
  for (const table of ["Requests", "LabResults"]) {
    const r = await pool.request().query(
      `select COLUMN_NAME from [${db}].INFORMATION_SCHEMA.COLUMNS
       where TABLE_NAME='${table}' order by ORDINAL_POSITION`,
    );
    out[table] = (r.recordset as { COLUMN_NAME: string }[]).map((x) => x.COLUMN_NAME);
  }
} finally {
  await closePool();
}

const target = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "compare",
  "v1-schema.json",
);
writeFileSync(
  target,
  JSON.stringify(
    {
      _comment:
        "GENERATED — do not hand-edit. Regenerate: cd apps/cli && node --import tsx scripts/dump-v1-schema.ts",
      _source: `${db} INFORMATION_SCHEMA.COLUMNS`,
      _generated_from_site: "TDS (Tanzania)",
      tables: out,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `wrote ${target}: Requests=${out.Requests?.length}, LabResults=${out.LabResults?.length}`,
);

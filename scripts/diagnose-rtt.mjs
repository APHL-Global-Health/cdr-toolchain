#!/usr/bin/env node
// Measure per-query round-trip latency from THIS host to a SQL Server, using
// the same driver and TDS path the exporter uses.
//
//   node scripts/diagnose-rtt.mjs "$DISA_CONNECTION_STRING"        DISA
//   node scripts/diagnose-rtt.mjs "$OPENLDR_V1_CONNECTION_STRING"  V1
//
// `cdr ping` is not a substitute: it opens and closes a connection, so it
// measures connection setup, not the per-query round trip that export-batch
// pays roughly 110 times per lab.
//
// Read-only. The only statement issued is SELECT 1.
//
// .mjs, not .js: the root package.json has no "type" field, so a .js file
// using `import` is parsed as CommonJS and fails on Node 18/20. Node 22+
// would auto-detect ESM, but the repo supports >=18.19, so the extension has
// to carry it.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// pnpm does not hoist dependencies to the workspace root: `mssql` resolves
// from apps/cli and packages/disalab, but NOT from scripts/ or the repo root.
// Resolve it against a workspace package that really depends on it rather
// than asking operators to install anything extra. Same reach-into-the-
// workspace trick push-to-ce.sh uses for tsx.
const here = dirname(fileURLToPath(import.meta.url));
const owners = [
  join(here, "..", "apps", "cli", "package.json"),
  join(here, "..", "packages", "disalab", "package.json"),
];

let mssql;
const failures = [];
for (const owner of owners) {
  try {
    mssql = createRequire(owner)("mssql");
    break;
  } catch (err) {
    failures.push(`${owner}: ${err.code ?? err.message}`);
  }
}
if (mssql === undefined) {
  console.error(
    "Cannot resolve the 'mssql' package. Run `pnpm install` from the repo root first.\n" +
      failures.map((f) => "  tried " + f).join("\n"),
  );
  process.exit(3);
}

const [, , connectionString, label = "server"] = process.argv;
if (connectionString === undefined || connectionString.length === 0) {
  console.error('usage: node scripts/diagnose-rtt.mjs "<connection-string>" [label]');
  process.exit(2);
}

const N = 100;

let pool;
try {
  pool = await new mssql.ConnectionPool(connectionString).connect();
} catch (err) {
  console.error(`Could not connect (${label}): ${err.message}`);
  process.exit(4);
}

try {
  // Warm-up. The first requests on a fresh pool pay connection setup and TDS
  // prelogin, which is not the steady-state round trip being measured.
  for (let i = 0; i < 5; i++) await pool.request().query("SELECT 1 AS ok");

  const samples = [];
  for (let i = 0; i < N; i++) {
    const t0 = process.hrtime.bigint();
    await pool.request().query("SELECT 1 AS ok");
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  samples.sort((a, b) => a - b);
  const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))];
  const round = (n) => Number(n.toFixed(3));

  console.log(
    JSON.stringify({
      _meta: "rtt",
      label,
      n: N,
      min_ms: round(samples[0]),
      p50_ms: round(at(0.5)),
      p90_ms: round(at(0.9)),
      p99_ms: round(at(0.99)),
      max_ms: round(samples[samples.length - 1]),
      mean_ms: round(samples.reduce((a, b) => a + b, 0) / samples.length),
    }),
  );
} finally {
  await pool.close();
}

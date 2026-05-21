import type { Command } from "commander";
import { REGDAT4, SpecimenRecpt } from "disalab";
import type { DisaServer } from "disalab";
import { CliError } from "../errors.js";
import { closePool } from "../db.js";
import { fetchRequestByRequestId, buildRequestSql } from "../openldr.js";
import { normalizeLabNumber } from "../compare/lab-number.js";
import { REQUEST_FIELD_NAMES, resolvePocFormat } from "../compare/mapping.js";
import { diffRecord, isPerfectMatch, type DiffSummary, type FieldRow } from "../compare/diff.js";
import { loadRuntime } from "./context.js";

interface CompareOpts {
  openldrCs?: string;
  prefix?: string;
  onlyDifferences?: boolean;
  explain?: boolean;
  pocFormat?: string;
}

interface CompareReport {
  lab_number: string;
  openldr_request_id: string;
  found_in: { disa: boolean; openldr_v1: boolean };
  fields: FieldRow[];
  summary: DiffSummary;
}

function buildServer(connectionString: string): DisaServer {
  return {
    config: { database: { driver: "mssql", connection_string: connectionString } },
  };
}

async function fetchDisaSpecimen(
  disaLabNo: string,
  connectionString: string,
): Promise<SpecimenRecpt | null> {
  try {
    const server = buildServer(connectionString);
    const escaped = disaLabNo.replace(/'/g, "''");
    const regs = await REGDAT4.All(`WHERE [LabNo] = '${escaped}'`, server);
    if (regs.length === 0) return null;
    const recpt = await SpecimenRecpt.Fetch(regs[0]!, server);
    return recpt;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_QUERY_FAILED", `DISA query failed: ${message}`);
  } finally {
    // Critical: close before the OpenLDR fetch reuses the global mssql pool.
    await closePool();
  }
}

function buildEmptyReport(
  labNo: string,
  requestId: string,
  foundDisa: boolean,
  foundV1: boolean,
): CompareReport {
  return {
    lab_number: labNo,
    openldr_request_id: requestId,
    found_in: { disa: foundDisa, openldr_v1: foundV1 },
    fields: [],
    summary: { total: 0, match: 0, mismatch: 0, only_disa: 0, only_v1: 0 },
  };
}

export function registerCompareCommand(program: Command): void {
  program
    .command("compare <labNumber>")
    .description(
      "Compare a single record between DISA and OpenLDR v1. Accepts the labno with or without the configured OPENLDR_LABNO_PREFIX (empty for deployments like Zambia that don't prefix).",
    )
    .option("--openldr-cs <url>", "OpenLDR v1 connection string (overrides env / .env)")
    .option("--prefix <str>", "Override the OpenLDR labno prefix for this invocation")
    .option(
      "--only-differences",
      "Hide fields whose status is `match` (mismatch / only_disa / only_v1 are kept)",
    )
    .option(
      "--poc-format <fmt>",
      "How v1 stores LIMSPointOfCareDesc: facility_ward (Tanzania default; facility~ward) or district_facility_ward (Mozambique; district~facility~ward, frequently truncated at 50 chars). Overrides OPENLDR_V1_POC_FORMAT.",
    )
    .option("--explain", "Show the queries that would run, exit without hitting either DB")
    .action(async (labNumberArg: string, opts: CompareOpts, cmd: Command) => {
      const { config, output } = loadRuntime(cmd, { requireConnection: false });
      const prefix = opts.prefix ?? config.openldrLabnoPrefix;
      const norm = normalizeLabNumber(labNumberArg, prefix);
      const pocFormat = resolvePocFormat(opts.pocFormat, config.openldrV1PocFormat);

      if (opts.explain === true) {
        const plan = {
          operation: "compare",
          input: labNumberArg,
          lab_number: norm.disaLabNo,
          openldr_request_id: norm.openldrRequestId,
          prefix: norm.prefix,
          poc_format: pocFormat,
          disa: {
            steps: [
              `REGDAT4.All("WHERE [LabNo] = '${norm.disaLabNo.replace(/'/g, "''")}'", server)`,
              "SpecimenRecpt.Fetch(regdat4[0], server)",
            ],
          },
          openldr_v1: {
            database: config.openldrDataDatabase,
            sql: buildRequestSql(config.openldrDataDatabase).replace(/\s+/g, " ").trim(),
            params: { requestId: norm.openldrRequestId },
          },
          fields: [...REQUEST_FIELD_NAMES],
        };
        process.stdout.write(JSON.stringify(plan) + "\n");
        return;
      }

      if (config.connectionString.length === 0) {
        throw new CliError(
          "CONFIG_MISSING",
          "DISA_CONNECTION_STRING not configured. Set it in env, .env, or pass --connection-string.",
        );
      }
      const openldrCs = opts.openldrCs ?? config.openldrConnectionString;
      if (openldrCs === undefined || openldrCs.length === 0) {
        throw new CliError(
          "OPENLDR_CONFIG_MISSING",
          "Set OPENLDR_V1_CONNECTION_STRING in env / .env, or pass --openldr-cs.",
        );
      }

      const disa = await fetchDisaSpecimen(norm.disaLabNo, config.connectionString);
      const v1 = await fetchRequestByRequestId(
        norm.openldrRequestId,
        openldrCs,
        config.openldrDataDatabase,
      );

      const foundDisa = disa !== null;
      const foundV1 = v1 !== null;

      if (!foundDisa || !foundV1) {
        const report = buildEmptyReport(norm.disaLabNo, norm.openldrRequestId, foundDisa, foundV1);
        process.stdout.write(JSON.stringify(report) + "\n");
        const missing = `${!foundDisa ? "DISA" : ""}${!foundDisa && !foundV1 ? " and " : ""}${!foundV1 ? "OpenLDR v1" : ""}`;
        // Common footgun: DISA hit but v1 missed → wrong (or missing) prefix.
        // Surface the prefix that was used so operators can verify it.
        const prefixHint =
          foundDisa && !foundV1
            ? norm.prefix.length > 0
              ? ` (v1 lookup used prefix '${norm.prefix}' — verify OPENLDR_LABNO_PREFIX matches your deployment, or pass --prefix '' if v1 RequestIDs aren't prefixed)`
              : ` (no prefix configured — if your deployment prefixes v1 RequestIDs, set OPENLDR_LABNO_PREFIX or pass --prefix)`
            : "";
        throw new CliError(
          "GET_NO_ROWS",
          `Record missing: ${missing}${prefixHint}`,
          {
            lab_number: norm.disaLabNo,
            openldr_request_id: norm.openldrRequestId,
            found_in: report.found_in,
            ...(foundDisa && !foundV1 ? { prefix_used: norm.prefix } : {}),
          },
        );
      }

      const diff = diffRecord(disa, v1, { pocFormat });

      const filteredFields =
        opts.onlyDifferences === true
          ? diff.fields.filter((f) => f.status !== "match")
          : diff.fields;

      const report: CompareReport = {
        lab_number: norm.disaLabNo,
        openldr_request_id: norm.openldrRequestId,
        found_in: { disa: true, openldr_v1: true },
        fields: filteredFields,
        summary: diff.summary,
      };

      if (output.format === "pretty") {
        const { inspect } = await import("node:util");
        process.stdout.write(inspect(report, { colors: output.color, depth: 6 }) + "\n");
      } else {
        process.stdout.write(JSON.stringify(report) + "\n");
      }

      if (!isPerfectMatch(diff.summary)) {
        const nonMatches =
          diff.summary.mismatch + diff.summary.only_disa + diff.summary.only_v1;
        throw new CliError(
          "MISMATCH",
          `${nonMatches} of ${diff.summary.total} fields did not match`,
          {
            lab_number: norm.disaLabNo,
            openldr_request_id: norm.openldrRequestId,
            summary: diff.summary,
          },
        );
      }
    });
}

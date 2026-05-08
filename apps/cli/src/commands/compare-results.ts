import type { Command } from "commander";
import { REGDAT4, SpecimenRecpt } from "disalab";
import type { DisaServer } from "disalab";
import { CliError } from "../errors.js";
import { closePool } from "../db.js";
import { buildLabResultsSql, fetchLabResultsByRequestId } from "../openldr.js";
import { normalizeLabNumber } from "../compare/lab-number.js";
import {
  diffResults,
  isResultPerfectMatch,
  type ObservationRow,
  type ResultSummary,
} from "../compare/result-diff.js";
import { RESULT_FIELDS } from "../compare/result-mapping.js";
import { loadRuntime } from "./context.js";

interface CompareResultsOpts {
  openldrCs?: string;
  prefix?: string;
  onlyDifferences?: boolean;
  includeEmpty?: boolean;
  explain?: boolean;
}

interface CompareResultsReport {
  lab_number: string;
  openldr_request_id: string;
  found_in: { disa: boolean; openldr_v1: boolean };
  observations: ObservationRow[];
  summary: ResultSummary;
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
    return await SpecimenRecpt.Fetch(regs[0]!, server);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_QUERY_FAILED", `DISA query failed: ${message}`);
  } finally {
    await closePool();
  }
}

function emptySummary(): ResultSummary {
  return {
    observations_total: 0,
    observations_match: 0,
    observations_mismatch: 0,
    observations_only_disa: 0,
    observations_only_v1: 0,
    fields_total: 0,
    fields_match: 0,
    fields_mismatch: 0,
    fields_only_disa: 0,
    fields_only_v1: 0,
  };
}

export function registerCompareResultsCommand(program: Command): void {
  program
    .command("compare-results <labNumber>")
    .description(
      "Compare per-observation test results for one lab between DISA (TESTDATA → OrderItem) and OpenLDR v1 (LabResults joined with Requests).",
    )
    .option("--openldr-cs <url>", "OpenLDR v1 connection string (overrides env / .env)")
    .option("--prefix <str>", "Override the OpenLDR labno prefix for this invocation")
    .option(
      "--only-differences",
      "Hide observations whose status is `match` (mismatch / only_disa / only_v1 are kept)",
    )
    .option(
      "--include-empty",
      "Keep DISA OrderItems that are unresulted or contain only whitespace/control bytes. Off by default because v1 drops these.",
    )
    .option("--explain", "Show the queries that would run, exit without hitting either DB")
    .action(async (labNumberArg: string, opts: CompareResultsOpts, cmd: Command) => {
      const { config, output } = loadRuntime(cmd, { requireConnection: false });
      const prefix = opts.prefix ?? config.openldrLabnoPrefix;
      const norm = normalizeLabNumber(labNumberArg, prefix);

      if (opts.explain === true) {
        const plan = {
          operation: "compare-results",
          input: labNumberArg,
          lab_number: norm.disaLabNo,
          openldr_request_id: norm.openldrRequestId,
          prefix: norm.prefix,
          disa: {
            steps: [
              `REGDAT4.All("WHERE [LabNo] = '${norm.disaLabNo.replace(/'/g, "''")}'", server)`,
              "SpecimenRecpt.Fetch(regdat4[0], server) // hydrates TestResults: TESTDATA[]",
            ],
          },
          openldr_v1: {
            database: config.openldrDataDatabase,
            sql: buildLabResultsSql(config.openldrDataDatabase).replace(/\s+/g, " ").trim(),
            params: { requestId: norm.openldrRequestId },
          },
          fields: RESULT_FIELDS.map((f) => f.field),
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
      const v1Rows = await fetchLabResultsByRequestId(
        norm.openldrRequestId,
        openldrCs,
        config.openldrDataDatabase,
      );

      const foundDisa = disa !== null;
      const foundV1 = v1Rows.length > 0;

      if (!foundDisa || !foundV1) {
        const report: CompareResultsReport = {
          lab_number: norm.disaLabNo,
          openldr_request_id: norm.openldrRequestId,
          found_in: { disa: foundDisa, openldr_v1: foundV1 },
          observations: [],
          summary: emptySummary(),
        };
        process.stdout.write(JSON.stringify(report) + "\n");
        throw new CliError(
          "GET_NO_ROWS",
          `Record missing: ${!foundDisa ? "DISA" : ""}${!foundDisa && !foundV1 ? " and " : ""}${!foundV1 ? "OpenLDR v1" : ""}`,
          {
            lab_number: norm.disaLabNo,
            openldr_request_id: norm.openldrRequestId,
            found_in: report.found_in,
          },
        );
      }

      const diff = diffResults(disa, v1Rows, { includeEmpty: opts.includeEmpty === true });

      const filtered =
        opts.onlyDifferences === true
          ? diff.observations.filter((o) => o.status !== "match")
          : diff.observations;

      const report: CompareResultsReport = {
        lab_number: norm.disaLabNo,
        openldr_request_id: norm.openldrRequestId,
        found_in: { disa: true, openldr_v1: true },
        observations: filtered,
        summary: diff.summary,
      };

      if (output.format === "pretty") {
        const { inspect } = await import("node:util");
        process.stdout.write(inspect(report, { colors: output.color, depth: 6 }) + "\n");
      } else {
        process.stdout.write(JSON.stringify(report) + "\n");
      }

      if (!isResultPerfectMatch(diff.summary)) {
        const nonMatches =
          diff.summary.observations_mismatch +
          diff.summary.observations_only_disa +
          diff.summary.observations_only_v1;
        throw new CliError(
          "MISMATCH",
          `${nonMatches} of ${diff.summary.observations_total} observations did not match`,
          {
            lab_number: norm.disaLabNo,
            openldr_request_id: norm.openldrRequestId,
            summary: diff.summary,
          },
        );
      }
    });
}

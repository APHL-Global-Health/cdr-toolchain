import type { Command } from "commander";
import { REGDAT4, SpecimenRecpt } from "disalab";
import type { DisaServer } from "disalab";
import { CliError } from "../errors.js";
import { closePool } from "../db.js";
import { fetchLabResultsByRequestId, fetchRequestByRequestId } from "../openldr.js";
import { normalizeLabNumber } from "../compare/lab-number.js";
import { REQUEST_FIELD_NAMES, resolvePocFormat } from "../compare/mapping.js";
import { diffRecord, isPerfectMatch, type DiffSummary } from "../compare/diff.js";
import {
  diffResults,
  isResultPerfectMatch,
  type ResultSummary,
} from "../compare/result-diff.js";
import { emitMeta } from "../output.js";
import { loadRuntime } from "./context.js";

interface BatchOpts {
  where?: string;
  limit?: string;
  offset?: string;
  openldrCs?: string;
  prefix?: string;
  summaryOnly?: boolean;
  onlyDifferences?: boolean;
  results?: boolean;
  includeEmpty?: boolean;
  explain?: boolean;
  pocFormat?: string;
}

interface FieldStats {
  match: number;
  mismatch: number;
  only_disa: number;
  only_v1: number;
}

interface BatchSummary {
  _meta: "batch-summary";
  labs_scanned: number;
  labs_matched_perfectly: number;
  labs_with_differences: number;
  labs_missing_in_disa: number;
  labs_missing_in_v1: number;
  labs_errored: number;
  elapsed_ms: number;
  per_field: Record<string, FieldStats>;
  observations?: {
    total: number;
    match: number;
    mismatch: number;
    only_disa: number;
    only_v1: number;
  };
  /** Labs where v1.Requests has a row but v1.LabResults has zero rows. Includes the pending subset below. */
  labs_without_v1_results?: number;
  /**
   * Subset of labs_without_v1_results where v1.Requests.HL7ResultStatusCode = 'I' (interim /
   * not-yet-authorised). v1's migration legitimately skips LabResults for these — DISA has
   * the request but the result was never finalized. Excluded from per-observation rollup
   * so they don't drown out real diffs.
   */
  labs_pending_in_v1?: number;
}

interface LabResult {
  lab_number: string;
  openldr_request_id: string;
  found_in: { disa: boolean; openldr_v1: boolean };
  perfect_match: boolean;
  summary: DiffSummary;
  results_summary?: ResultSummary;
  /** Set to "pending_in_v1" when the lab is interim-status and its results were intentionally skipped. */
  results_status?: "pending_in_v1";
  error?: string;
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
  } finally {
    await closePool();
  }
}

async function fetchLabNumbers(
  where: string,
  limit: number,
  offset: number,
  connectionString: string,
): Promise<string[]> {
  // Use REGDAT4.LabNumbers which does a distinct SELECT and bypasses
  // per-row blob hydration. Compose pagination + user WHERE in a single
  // clause that we can feed to .LabNumbers().
  const trimmed = where.trim().replace(/^WHERE\s+/i, "");
  const userClause = trimmed.length > 0 ? `WHERE ${trimmed}` : "";
  const composedWhere = `${userClause} ORDER BY [LabNo] OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`;
  try {
    const server = buildServer(connectionString);
    return await REGDAT4.LabNumbers(composedWhere, server);
  } finally {
    await closePool();
  }
}

export function registerCompareBatchCommand(program: Command): void {
  program
    .command("compare-batch")
    .description(
      "Scan many records end-to-end (DISA ↔ OpenLDR v1). Emits one NDJSON line per lab on stdout (summary stats), plus a batch-summary to stderr at EOF.",
    )
    .option("--where <sql>", "WHERE clause applied to REGDAT4 when selecting labs", "")
    .option("--limit <n>", "max labs to scan", "100")
    .option("--offset <n>", "labs to skip before starting", "0")
    .option("--openldr-cs <url>", "OpenLDR v1 connection string (overrides env / .env)")
    .option("--prefix <str>", "Override the OpenLDR labno prefix for this invocation")
    .option("--summary-only", "Suppress per-lab output; emit only the final summary")
    .option("--only-differences", "Only emit labs that did not match perfectly")
    .option(
      "--results",
      "Also run per-observation comparison (DISA TESTDATA ↔ v1 LabResults). Adds results_summary per lab and an observations rollup to the batch summary.",
    )
    .option(
      "--include-empty",
      "With --results: keep DISA OrderItems that are unresulted / empty / stray HL7 status flags. Off by default.",
    )
    .option(
      "--poc-format <fmt>",
      "How v1 stores LIMSPointOfCareDesc: facility_ward (Tanzania default) or district_facility (Mozambique). Overrides OPENLDR_V1_POC_FORMAT.",
    )
    .option("--explain", "Show the lab-selection query and field list, exit without running")
    .action(async (opts: BatchOpts, cmd: Command) => {
      const { config } = loadRuntime(cmd, { requireConnection: false });
      const prefix = opts.prefix ?? config.openldrLabnoPrefix;
      const pocFormat = resolvePocFormat(opts.pocFormat, config.openldrV1PocFormat);
      const limit = Number(opts.limit ?? "100");
      const offset = Number(opts.offset ?? "0");
      const where = opts.where ?? "";

      if (opts.explain === true) {
        const trimmed = where.trim().replace(/^WHERE\s+/i, "");
        const userClause = trimmed.length > 0 ? `WHERE ${trimmed}` : "";
        process.stdout.write(
          JSON.stringify({
            operation: "compare-batch",
            lab_selection: {
              method: "REGDAT4.LabNumbers",
              where: `${userClause} ORDER BY [LabNo] OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
            },
            openldr_database: config.openldrDataDatabase,
            prefix,
            poc_format: pocFormat,
            fields: [...REQUEST_FIELD_NAMES],
          }) + "\n",
        );
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

      const start = Date.now();
      const labNos = await fetchLabNumbers(where, limit, offset, config.connectionString);

      const perField: Record<string, FieldStats> = {};
      for (const fieldName of REQUEST_FIELD_NAMES) {
        perField[fieldName] = { match: 0, mismatch: 0, only_disa: 0, only_v1: 0 };
      }

      let scanned = 0;
      let perfect = 0;
      let withDiffs = 0;
      let missingDisa = 0;
      let missingV1 = 0;
      let errored = 0;

      const obsAgg = { total: 0, match: 0, mismatch: 0, only_disa: 0, only_v1: 0 };
      let labsWithoutV1Results = 0;
      let labsPendingInV1 = 0;
      const runResults = opts.results === true;
      const includeEmpty = opts.includeEmpty === true;

      for (const rawLabNo of labNos) {
        const disaLabNo = rawLabNo.trim();
        const norm = normalizeLabNumber(disaLabNo, prefix);

        let labResult: LabResult = {
          lab_number: norm.disaLabNo,
          openldr_request_id: norm.openldrRequestId,
          found_in: { disa: false, openldr_v1: false },
          perfect_match: false,
          summary: { total: 0, match: 0, mismatch: 0, only_disa: 0, only_v1: 0 },
        };

        try {
          const disa = await fetchDisaSpecimen(disaLabNo, config.connectionString);
          const v1 = await fetchRequestByRequestId(
            norm.openldrRequestId,
            openldrCs,
            config.openldrDataDatabase,
          );

          const foundDisa = disa !== null;
          const foundV1 = v1 !== null;
          labResult.found_in = { disa: foundDisa, openldr_v1: foundV1 };

          if (!foundDisa) missingDisa++;
          if (!foundV1) missingV1++;

          if (foundDisa && foundV1) {
            const diff = diffRecord(disa, v1, { pocFormat });
            labResult.summary = diff.summary;
            let labPerfect = isPerfectMatch(diff.summary);

            for (const row of diff.fields) {
              perField[row.field]![row.status]++;
            }

            if (runResults) {
              const v1Rows = await fetchLabResultsByRequestId(
                norm.openldrRequestId,
                openldrCs,
                config.openldrDataDatabase,
              );
              const v1HasResults = v1Rows.length > 0;
              if (!v1HasResults) labsWithoutV1Results++;
              // v1's migration correctly skips LabResults for interim-status requests.
              // Treat these as "pending", not a fidelity miss: skip diff + don't aggregate.
              const isPending =
                !v1HasResults &&
                typeof v1.HL7ResultStatusCode === "string" &&
                v1.HL7ResultStatusCode.trim().toUpperCase() === "I";
              if (isPending) {
                labsPendingInV1++;
                labResult.results_status = "pending_in_v1";
              } else {
                const rdiff = diffResults(disa, v1Rows, { includeEmpty });
                labResult.results_summary = rdiff.summary;
                obsAgg.total += rdiff.summary.observations_total;
                obsAgg.match += rdiff.summary.observations_match;
                obsAgg.mismatch += rdiff.summary.observations_mismatch;
                obsAgg.only_disa += rdiff.summary.observations_only_disa;
                obsAgg.only_v1 += rdiff.summary.observations_only_v1;
                if (!isResultPerfectMatch(rdiff.summary)) labPerfect = false;
              }
            }

            labResult.perfect_match = labPerfect;
            if (labPerfect) perfect++;
            else withDiffs++;
          }
        } catch (err) {
          errored++;
          labResult = { ...labResult, error: err instanceof Error ? err.message : String(err) };
        }

        scanned++;

        if (opts.summaryOnly !== true) {
          if (opts.onlyDifferences === true && labResult.perfect_match) continue;
          process.stdout.write(JSON.stringify(labResult) + "\n");
        }
      }

      const summary: BatchSummary = {
        _meta: "batch-summary",
        labs_scanned: scanned,
        labs_matched_perfectly: perfect,
        labs_with_differences: withDiffs,
        labs_missing_in_disa: missingDisa,
        labs_missing_in_v1: missingV1,
        labs_errored: errored,
        elapsed_ms: Date.now() - start,
        per_field: perField,
        ...(runResults
          ? {
              observations: obsAgg,
              labs_without_v1_results: labsWithoutV1Results,
              labs_pending_in_v1: labsPendingInV1,
            }
          : {}),
      };

      emitMeta(summary as unknown as Record<string, unknown>);

      if (withDiffs > 0 || errored > 0 || missingDisa > 0 || missingV1 > 0) {
        throw new CliError(
          "MISMATCH",
          `${scanned - perfect} of ${scanned} labs did not match perfectly`,
          summary as unknown as Record<string, unknown>,
        );
      }
    });
}

import type { Command } from "commander";
import { REGDAT4, SpecimenRecpt } from "disalab";
import type { DisaServer } from "disalab";
import { CliError } from "../errors.js";
import { closePool } from "../db.js";
import {
  fetchAllRequestsByRequestId,
  fetchLabResultsByRequestId,
  fetchRequestByRequestId,
} from "../openldr.js";
import { normalizeLabNumber } from "../compare/lab-number.js";
import { REQUEST_FIELD_NAMES, resolvePocFormat } from "../compare/mapping.js";
import { diffRecord, isPerfectMatch, type DiffSummary } from "../compare/diff.js";
import { WardDictResolver } from "../compare/warddict-resolver.js";
import {
  diffResults,
  isResultPerfectMatch,
  type ResultSummary,
} from "../compare/result-diff.js";
import { emitMeta } from "../output.js";
import { loadRuntime } from "./context.js";
import { toV2 } from "../export/v2-transform.js";
import type { V2Payload } from "../export/types.js";
import {
  diffV2Request,
  diffV2Results,
  type V2FieldStats,
  type V2ResultDiffSummary,
} from "../compare/v2-diff.js";
import { V2_REQUEST_FIELDS, V2_RESULT_FIELDS } from "../compare/v2-mapping.js";
import { loadCodebook, type Codebook } from "../export/codebook.js";
import { DEFAULT_SITE } from "../export/site-config.js";
import { isDocumentationObs, type DocConfig } from "../export/non-test.js";
import { loadCountryDocConfig } from "../config/country-config.js";
import { auditFromSpecimen } from "../audit/detector.js";

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
  v2?: boolean;
  country?: string;
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
  /**
   * With --v2: labs for which the V2 export payload was built. Nothing grades
   * it yet (the V2<->v1 field defs are the next task) — this is the wiring
   * proof, and it pins the sample size the V2 report will be drawn from.
   */
  v2?: {
    payloads_built: number;
    /**
     * OBR-level pairing: payload lab_requests <-> v1 OBR rows, joined on
     * obr_set_id == OBRSetID.
     *
     * ⚠ `only_v2` / `only_v1` are the CARDINALITY disagreement and must stay
     * visible. This is where v1's staleness surfaces (~0.05%: v1 is a
     * point-in-time migration, and DISA kept re-running panels after it — e.g.
     * v1 recorded RPR at 18:26 while DISA re-ran it at 18:30 and 18:34). It is
     * an EXPECTED residual, not a defect to fix, and not a pass to hide.
     */
    obr_pairing: { paired: number; only_v2: number; only_v1: number };
    /** Which config/<country>.yaml drove excludeObs. `null` = none, which means
     *  an EMPTY documentation-panel set — a materially different payload. */
    country: string | null;
    /** Request-level V2<->v1 grading, per field. */
    per_field: Record<string, V2FieldStats>;
    /** Observation-level grading. Only present with --results. */
    results?: {
      observations_v2: number;
      observations_v1: number;
      paired: number;
      only_v2: number;
      only_v1: number;
      v1_results_documentation_excluded: number;
      per_field: Record<string, V2FieldStats>;
    };
  };
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
  wardResolver: WardDictResolver,
): Promise<SpecimenRecpt | null> {
  try {
    const server = buildServer(connectionString);
    const escaped = disaLabNo.replace(/'/g, "''");
    const regs = await REGDAT4.All(`WHERE [LabNo] = '${escaped}'`, server);
    if (regs.length === 0) return null;
    const recpt = await SpecimenRecpt.Fetch(regs[0]!, server);
    // Resolve WardClinic against WARDDICT before the pool closes. The
    // resolver caches across the batch, so each unique (LOCATION, WARD)
    // pair only hits the DB once. Non-destructive: the resolved
    // description goes on a side-field so v2-transform downstream still
    // has the raw code for source_payload.
    if (recpt !== null) {
      const resolved = await wardResolver.resolve(
        recpt.Facility?.Code,
        recpt.WardClinic,
        server,
      );
      if (resolved !== null) recpt.WardClinicResolved = resolved;
    }
    return recpt;
  } finally {
    await closePool();
  }
}

/**
 * Build the V2 export payload for a specimen — the thing that actually ships.
 *
 * ⚠ The opts MUST mirror export-batch's real call sites (`export-batch.ts:559`
 * and `:530`) or the gate would grade a payload that never leaves the building.
 * Both of those pass prefix/site/codebook/auditReport/excludeObs, so this does
 * too. Two of them are load-bearing, not decoration:
 *
 *  - `auditReport` is NOT audit-only: `hasCorroboratedSpecimenMismatch` feeds
 *    `buildLabRequest`, which swaps `specimen.system_id` to the site's
 *    anomaly namespace (`v2-transform.ts:309`). Omitting it would silently
 *    change a mapped field. Export builds it whenever quarantine is on, and
 *    quarantine is ON by default (`--no-quarantine` opts out), so the gate
 *    mirrors the default and always builds it.
 *  - `excludeObs` drops documentation observations, which changes primary-panel
 *    selection and therefore request-level fields — not just lab_results.
 *    It depends on `config/<country>.yaml`, so the gate takes `--country` for
 *    the same reason export-batch does: with no country the doc-panel set is
 *    EMPTY and the payload is a different payload.
 */
function buildV2Payload(
  specimen: SpecimenRecpt,
  prefix: string,
  codebook: Codebook,
  docConfig: DocConfig,
): V2Payload {
  const auditReport = auditFromSpecimen(specimen, prefix, codebook, docConfig.panels);
  return toV2(specimen, {
    prefix,
    site: DEFAULT_SITE,
    codebook,
    auditReport,
    excludeObs: (o) => isDocumentationObs(o, codebook, docConfig),
  });
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
      "--v2",
      "Also build the V2 export payload per lab (the payload that actually ships) so it can be graded against v1. Off by default: the DISA<->v1 gate's behaviour is unchanged without it.",
    )
    .option(
      "--country <name>",
      "Country key selecting config/<country>.yaml documentation classifiers (overrides OPENLDR_COUNTRY). With --v2 this changes which observations the export drops, so it changes the payload being graded.",
    )
    .option(
      "--poc-format <fmt>",
      "How v1 stores LIMSPointOfCareDesc: facility_ward (Tanzania default; facility~ward) or district_facility_ward (Mozambique; district~facility~ward, frequently truncated at 50 chars). Overrides OPENLDR_V1_POC_FORMAT.",
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
      const runV2 = opts.v2 === true;

      // Load the codebook ONCE for the whole batch — it hits the DB, and the
      // payload build needs it per lab. Only when --v2: without it the codebook
      // is unused and the extra query would be pure cost.
      let codebook: Codebook | null = null;
      let docConfig: DocConfig | null = null;
      let v2PayloadsBuilt = 0;
      const v2PerField: Record<string, V2FieldStats> = {};
      const v2ResultPerField: Record<string, V2FieldStats> = {};
      // OBR-level pairing between the payload's lab_requests and v1's OBR rows.
      // `only_v2` / `only_v1` here are the cardinality disagreement — reported
      // so the v1-staleness residual is a NUMBER, not a silent pass.
      const v2ObrPairing = { paired: 0, only_v2: 0, only_v1: 0 };
      const v2ResultAgg = {
        observations_v2: 0,
        observations_v1: 0,
        paired: 0,
        only_v2: 0,
        only_v1: 0,
        v1_results_documentation_excluded: 0,
      };
      if (runV2) {
        codebook = await loadCodebook(buildServer(config.connectionString));
        await closePool();
        docConfig = loadCountryDocConfig(opts.country ?? config.country);
        for (const def of V2_REQUEST_FIELDS) {
          v2PerField[def.field] = { match: 0, mismatch: 0, only_v2: 0, only_v1: 0 };
        }
        for (const def of V2_RESULT_FIELDS) {
          v2ResultPerField[def.field] = { match: 0, mismatch: 0, only_v2: 0, only_v1: 0 };
        }
      }

      function rollUpV2Results(s: V2ResultDiffSummary): void {
        v2ResultAgg.observations_v2 += s.observations_v2;
        v2ResultAgg.observations_v1 += s.observations_v1;
        v2ResultAgg.paired += s.paired;
        v2ResultAgg.only_v2 += s.only_v2;
        v2ResultAgg.only_v1 += s.only_v1;
        v2ResultAgg.v1_results_documentation_excluded += s.v1_results_documentation_excluded;
        for (const [field, stats] of Object.entries(s.per_field)) {
          const agg = v2ResultPerField[field];
          if (agg === undefined) continue;
          agg.match += stats.match;
          agg.mismatch += stats.mismatch;
          agg.only_v2 += stats.only_v2;
          agg.only_v1 += stats.only_v1;
        }
      }

      // One resolver instance for the whole batch — the (CODE1, CODE2)
      // cache amortises across every lab so we don't re-query WARDDICT
      // for the same facility+ward pair more than once per run.
      const wardResolver = new WardDictResolver();

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
          const disa = await fetchDisaSpecimen(
            disaLabNo,
            config.connectionString,
            wardResolver,
          );
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

            // Build the shipping payload and grade it against v1 — the leg the
            // gate has never looked at.
            let v2Payload: V2Payload | null = null;
            if (runV2 && codebook !== null && docConfig !== null) {
              v2Payload = buildV2Payload(disa, prefix, codebook, docConfig);
              v2PayloadsBuilt++;
              // v1's grain is (RequestID, OBRSetID) and v2 now matches it, so
              // pair on the NATURAL key. `v1` above is only the LOWEST OBRSetID
              // (fetchRequestByRequestId, openldr.ts:110) — grading every panel
              // against it is exactly the defect this slice fixes. The DISA<->v1
              // leg keeps using it, so its output stays byte-identical.
              const v1Rows = await fetchAllRequestsByRequestId(
                norm.openldrRequestId,
                openldrCs,
                config.openldrDataDatabase,
              );
              const v1ByObr = new Map(v1Rows.map((r) => [Number(r.OBRSetID ?? 0), r]));
              for (const req of v2Payload.lab_requests) {
                const v1Row = v1ByObr.get(req.obr_set_id);
                if (v1Row === undefined) {
                  // An OBR v1 has no row for. ⚠ COUNTED, never skipped silently:
                  // this is where the 0.05% v1-staleness residual lands (v1 is a
                  // point-in-time migration; DISA kept changing), and it must be
                  // visible as a number rather than pass as green.
                  v2ObrPairing.only_v2++;
                  continue;
                }
                v2ObrPairing.paired++;
                const v2Diff = diffV2Request(req, v1Row);
                for (const row of v2Diff.fields) v2PerField[row.field]![row.status]++;
              }
              const emitted = new Set(v2Payload.lab_requests.map((r) => r.obr_set_id));
              for (const r of v1Rows) {
                if (!emitted.has(Number(r.OBRSetID ?? 0))) v2ObrPairing.only_v1++;
              }
            }

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
                // Same skip as the DISA<->v1 gate above: a pending lab has no v1
                // results at all, so grading the V2 stream against nothing would
                // report every observation as only_v2 — false red, not a finding.
                if (v2Payload !== null && docConfig !== null) {
                  rollUpV2Results(
                    diffV2Results(v2Payload, v1Rows, { documentationPanels: docConfig.panels })
                      .summary,
                  );
                }
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
        ...(runV2
          ? {
              v2: {
                payloads_built: v2PayloadsBuilt,
                country: opts.country ?? config.country ?? null,
                // One payload is now N lab_requests (one per ordered panel), so
                // payloads_built no longer counts graded records — this does.
                obr_pairing: v2ObrPairing,
                per_field: v2PerField,
                ...(runResults ? { results: { ...v2ResultAgg, per_field: v2ResultPerField } } : {}),
              },
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

import type { Command } from "commander";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { REGDAT4, SpecimenRecpt } from "disalab";
import type { DisaServer } from "disalab";
import { CliError } from "../errors.js";
import { closePool } from "../db.js";
import { loadCodebook, type Codebook } from "../export/codebook.js";
import { auditFromSpecimen } from "../audit/detector.js";
import { auditFromV1 } from "../audit/v1-adapter.js";
import { AuditAggregator } from "../audit/aggregator.js";
import { detectFormat, isValidFormat, renderReport } from "../audit/renderers/index.js";
import type { ReportFormat } from "../audit/report-types.js";
import { fetchOpenldrRequestIds } from "../openldr.js";
import type { AnomalyClass, AuditReport } from "../audit/types.js";
import { emitMeta } from "../output.js";
import { loadRuntime } from "./context.js";

type AuditSource = "disa" | "openldr";

interface SingleAuditOpts {
  prefix?: string;
  source?: string;
  openldrCs?: string;
}

interface BatchAuditOpts {
  where?: string;
  limit?: string;
  offset?: string;
  prefix?: string;
  concurrency?: string;
  summaryOnly?: boolean;
  onlyAnomalies?: boolean;
  explain?: boolean;
  source?: string;
  openldrCs?: string;
  reportOut?: string;
  reportFormat?: string;
  reportTitle?: string;
  reportMaxSamples?: string;
  totalLabs?: string;
}

interface BatchSummary {
  _meta: "audit-batch-summary";
  source: AuditSource;
  labs_scanned: number;
  labs_with_anomalies: number;
  labs_errored: number;
  total_anomalies: number;
  per_class: Record<AnomalyClass, number>;
  top_panels: Array<{ panel_code: string; anomaly_count: number }>;
  elapsed_ms: number;
  concurrency: number;
}

const ALL_CLASSES: AnomalyClass[] = [
  "panel_specimen_mismatch",
  "specimen_description_vague",
  "specimen_missing",
  "observation_wrong_panel",
  "cross_panel_duplicate_observation",
  "orphan_ordered_panel",
  "record_has_no_observations",
  "panel_iterations_superseded",
  "result_format_invalid_decoded",
  "result_format_units_inline",
  "result_format_microscopy_count",
  "result_unrealistic_numeric",
  "result_contains_control_chars",
  "dob_after_specimen_date",
  "dob_future_dated",
  "sex_code_invalid",
];

function buildServer(connectionString: string): DisaServer {
  return {
    config: { database: { driver: "mssql", connection_string: connectionString } },
  };
}

function parseSource(raw: string | undefined): AuditSource {
  if (raw === undefined || raw.length === 0) return "disa";
  const v = raw.toLowerCase();
  if (v === "disa" || v === "openldr") return v;
  throw new CliError("USAGE", `--source must be "disa" or "openldr" (got "${raw}").`);
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

async function fetchDisaLabNumbers(
  where: string,
  limit: number,
  offset: number,
  connectionString: string,
): Promise<string[]> {
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

async function loadCodebookOnce(connectionString: string): Promise<Codebook> {
  const server = buildServer(connectionString);
  try {
    return await loadCodebook(server);
  } finally {
    await closePool();
  }
}

function requireOpenldrCs(opts: { openldrCs?: string }, configCs: string | undefined): string {
  const cs = opts.openldrCs ?? configCs;
  if (cs === undefined || cs.length === 0) {
    throw new CliError(
      "OPENLDR_CONFIG_MISSING",
      "OpenLDR v1 connection string not configured. Set OPENLDR_V1_CONNECTION_STRING in env / .env, or pass --openldr-cs.",
    );
  }
  return cs;
}

export function registerAuditCommand(program: Command): void {
  program
    .command("audit <labNumber>")
    .description(
      "Run microbiology data-quality checks on a single lab. Default source is DISA; use --source openldr to audit the OpenLDR v1 mirror retrospectively. Emits an AuditReport JSON on stdout.",
    )
    .option("--prefix <str>", "Override the OpenLDR labno prefix for the request_id (default from env)")
    .option("--source <src>", "Data source: \"disa\" (default) or \"openldr\"")
    .option("--openldr-cs <url>", "OpenLDR v1 connection string (only for --source openldr; overrides env)")
    .action(async (labNumber: string, opts: SingleAuditOpts, cmd: Command) => {
      const source = parseSource(opts.source);
      const { config } = loadRuntime(cmd);
      const prefix = opts.prefix ?? config.openldrLabnoPrefix;

      // Codebook always loads from DISA — even for v1 audits, since v1
      // mirrors DISA's codes and we need PARMDICT/COMMDICT/TESTDICT for
      // panel/specimen/observation lookups.
      const codebook = await loadCodebookOnce(config.connectionString);

      if (source === "disa") {
        const specimen = await fetchDisaSpecimen(labNumber.trim(), config.connectionString);
        if (specimen === null) {
          throw new CliError(
            "GET_NO_ROWS",
            `No DISA registration found for lab number ${labNumber}`,
            { lab_number: labNumber },
          );
        }
        const report = auditFromSpecimen(specimen, prefix, codebook);
        process.stdout.write(JSON.stringify(report) + "\n");
        return;
      }

      // openldr source
      const openldrCs = requireOpenldrCs(opts, config.openldrConnectionString);
      const requestId = labNumber.startsWith(prefix) ? labNumber.trim() : prefix + labNumber.trim();
      const { report, reason } = await auditFromV1(
        requestId,
        openldrCs,
        config.openldrDataDatabase,
        codebook,
      );
      if (report === null || reason !== "ok") {
        throw new CliError(
          "GET_NO_ROWS",
          `No OpenLDR v1 Requests row found for ${requestId}.`,
          { request_id: requestId },
        );
      }
      process.stdout.write(JSON.stringify(report) + "\n");
    });
}

export function registerAuditBatchCommand(program: Command): void {
  program
    .command("audit-batch")
    .description(
      "Scan many labs for data-quality anomalies. Default source is DISA; use --source openldr to audit the OpenLDR v1 mirror. Emits NDJSON per lab on stdout, summary on stderr.",
    )
    .option("--where <sql>", "WHERE clause applied to the lab-selection query", "")
    .option("--limit <n>", "max labs to scan", "100")
    .option("--offset <n>", "labs to skip before starting", "0")
    .option("--prefix <str>", "Override the OpenLDR labno prefix for the request_id")
    .option("--concurrency <n>", "Number of labs in flight at once. Defaults to 1 — raise to parallelise the per-lab SQL round-trip, especially against a remote OpenLDR v1 server.", "1")
    .option("--summary-only", "Suppress per-lab output; emit only the final summary")
    .option("--only-anomalies", "Only emit labs whose audit found at least one anomaly")
    .option("--explain", "Show the lab-selection query and exit without running")
    .option("--source <src>", "Data source: \"disa\" (default — REGDAT4) or \"openldr\" (Requests)")
    .option("--openldr-cs <url>", "OpenLDR v1 connection string (only for --source openldr; overrides env)")
    .option("--report-out <path>", "Also render an audit report (PDF / DOCX / Markdown / HTML) to this path. Format inferred from extension or set with --report-format.")
    .option("--report-format <fmt>", "Report format: pdf | docx | md | html. Overrides extension detection.")
    .option("--report-title <str>", "Title shown on the report (default: \"DISA Migration Audit Report\").")
    .option("--report-max-samples <n>", "Max sample anomalies kept per class in the report (default: 10).")
    .option("--total-labs <n>", "Total labs in deployment for the report's forecast section. Omit to skip the forecast.")
    .action(async (opts: BatchAuditOpts, cmd: Command) => {
      const source = parseSource(opts.source);
      const { config } = loadRuntime(cmd, { requireConnection: false });
      const prefix = opts.prefix ?? config.openldrLabnoPrefix;
      const concurrency = Math.max(1, Number(opts.concurrency ?? "1"));
      if (!Number.isFinite(concurrency) || concurrency < 1) {
        throw new CliError(
          "USAGE",
          `--concurrency must be a positive integer (got "${opts.concurrency}").`,
        );
      }
      const limit = Number(opts.limit ?? "100");
      const offset = Number(opts.offset ?? "0");
      const where = opts.where ?? "";

      if (opts.explain === true) {
        const trimmed = where.trim().replace(/^WHERE\s+/i, "");
        const userClause = trimmed.length > 0 ? `WHERE ${trimmed}` : "";
        const lab_selection =
          source === "disa"
            ? {
                method: "REGDAT4.LabNumbers",
                where: `${userClause} ORDER BY [LabNo] OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
              }
            : {
                method: "Requests.RequestID",
                where: `SELECT DISTINCT [RequestID] FROM Requests ${userClause} ORDER BY [RequestID] OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
              };
        process.stdout.write(
          JSON.stringify({
            operation: "audit-batch",
            source,
            lab_selection,
            prefix,
            concurrency,
            anomaly_classes: ALL_CLASSES,
          }) + "\n",
        );
        return;
      }

      // Codebook always from DISA, even when source=openldr.
      if (config.connectionString.length === 0) {
        throw new CliError(
          "CONFIG_MISSING",
          "DISA_CONNECTION_STRING not configured (audit needs DISA dictionaries even for --source openldr).",
        );
      }
      const openldrCs = source === "openldr"
        ? requireOpenldrCs(opts, config.openldrConnectionString)
        : null;

      // Validate the report flags up-front so a 90-min batch doesn't fail
      // at the last step on a typo'd extension.
      let reportFormat: ReportFormat | null = null;
      let reportOutPath: string | null = null;
      const reportMaxSamples = opts.reportMaxSamples !== undefined ? Number(opts.reportMaxSamples) : 10;
      const estimatedTotal = opts.totalLabs !== undefined ? Number(opts.totalLabs) : undefined;
      if (opts.reportOut !== undefined) {
        reportOutPath = resolve(opts.reportOut);
        if (opts.reportFormat !== undefined && opts.reportFormat.length > 0) {
          if (!isValidFormat(opts.reportFormat)) {
            throw new CliError("USAGE", `--report-format must be pdf | docx | md | html.`);
          }
          reportFormat = opts.reportFormat;
        } else {
          reportFormat = detectFormat(reportOutPath);
          if (reportFormat === null) {
            throw new CliError("USAGE", `Cannot infer report format from --report-out path; pass --report-format.`);
          }
        }
        if (!Number.isFinite(reportMaxSamples) || reportMaxSamples < 1) {
          throw new CliError("USAGE", `--report-max-samples must be a positive integer.`);
        }
        if (estimatedTotal !== undefined && (!Number.isFinite(estimatedTotal) || estimatedTotal <= 0)) {
          throw new CliError("USAGE", `--total-labs must be a positive integer.`);
        }
      }

      const start = Date.now();

      // Counters declared up front so the global error handlers below can
      // close over them and emit a best-effort summary on a hard crash.
      let scanned = 0;
      let withAnomalies = 0;
      let errored = 0;
      let totalAnomalies = 0;
      let currentLab: string | null = null;
      const perClass: Record<AnomalyClass, number> = ALL_CLASSES.reduce(
        (acc, k) => {
          acc[k] = 0;
          return acc;
        },
        {} as Record<AnomalyClass, number>,
      );
      const panelHits = new Map<string, number>();
      const reportAggregator = reportOutPath !== null
        ? new AuditAggregator({ maxSamplesPerClass: reportMaxSamples })
        : null;

      const makeSummary = (): BatchSummary => {
        const topPanels = [...panelHits.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 10)
          .map(([panel_code, anomaly_count]) => ({ panel_code, anomaly_count }));
        return {
          _meta: "audit-batch-summary",
          source,
          labs_scanned: scanned,
          labs_with_anomalies: withAnomalies,
          labs_errored: errored,
          total_anomalies: totalAnomalies,
          per_class: perClass,
          top_panels: topPanels,
          elapsed_ms: Date.now() - start,
          concurrency,
        };
      };

      // Long batch runs amplify any unguarded path into a hard crash that
      // truncates the user's NDJSON output mid-line. Install handlers so
      // unexpected exceptions / rejections / closed-stdout produce a
      // visible diagnostic and a best-effort summary instead.
      let stdoutOpen = true;
      const onFatal = (kind: string) => (err: unknown): void => {
        const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
        try {
          process.stderr.write(
            JSON.stringify({
              _meta: "audit-batch-fatal",
              kind,
              message: msg,
              scanned_so_far: scanned,
              current_lab: currentLab,
            }) + "\n",
          );
          emitMeta(makeSummary() as unknown as Record<string, unknown>);
        } catch {
          // stderr also dead — nothing we can do beyond exit.
        }
        process.exit(13);
      };
      process.on("uncaughtException", onFatal("uncaughtException"));
      process.on("unhandledRejection", onFatal("unhandledRejection"));
      process.stdout.on("error", (err: NodeJS.ErrnoException) => {
        // EPIPE means the downstream consumer (terminal, pipe, file
        // handle) closed. Stop trying to write per-lab lines but keep
        // the loop going so the --report-out file still finishes.
        if (err.code === "EPIPE") stdoutOpen = false;
        else onFatal("stdout-error")(err);
      });

      const writeOut = (payload: string): void => {
        if (!stdoutOpen) return;
        try {
          process.stdout.write(payload);
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "EPIPE") {
            stdoutOpen = false;
          } else {
            // Any other write failure is fatal to the batch's stdout path.
            stdoutOpen = false;
            process.stderr.write(
              JSON.stringify({
                _meta: "audit-batch-stdout-write-failed",
                message: err instanceof Error ? err.message : String(err),
              }) + "\n",
            );
          }
        }
      };

      // Heartbeat every N labs so operators know a long run is alive and
      // see roughly where it is. Goes to stderr so it doesn't pollute the
      // NDJSON stream on stdout.
      const HEARTBEAT_EVERY = 5000;
      const writeHeartbeat = (): void => {
        const elapsed = Date.now() - start;
        process.stderr.write(
          JSON.stringify({
            _meta: "audit-batch-progress",
            scanned,
            with_anomalies: withAnomalies,
            errored,
            current_lab: currentLab,
            elapsed_ms: elapsed,
            avg_ms_per_lab: scanned > 0 ? Math.round(elapsed / scanned) : null,
          }) + "\n",
        );
      };

      const codebook = await loadCodebookOnce(config.connectionString);

      const labIds: string[] = source === "disa"
        ? await fetchDisaLabNumbers(where, limit, offset, config.connectionString)
        : await fetchOpenldrRequestIds(where, offset, limit, openldrCs!, config.openldrDataDatabase);

      // -------- worker pool --------
      // Drive `concurrency` workers in parallel by handing each one the
      // next lab from a shared cursor (mirrors export-batch's pattern).
      // The per-lab fetch is async; everything between fetch and the
      // next iteration is synchronous (counter updates, aggregator
      // ingest, stdout write) so JS's cooperative scheduling keeps
      // those sections atomic without locks. closePool() is a workspace
      // no-op so concurrent fetches don't fight over a global pool.
      let cursor = 0;
      const nextLabId = (): string | null => {
        if (cursor >= labIds.length) return null;
        const candidate = labIds[cursor]!.trim();
        cursor++;
        return candidate;
      };

      const worker = async (): Promise<void> => {
        for (;;) {
          const labId = nextLabId();
          if (labId === null) return;
          currentLab = labId;
          let report: AuditReport | null = null;
          let errMsg: string | null = null;

          try {
            if (source === "disa") {
              const specimen = await fetchDisaSpecimen(labId, config.connectionString);
              if (specimen === null) {
                errMsg = "no DISA registration found";
              } else {
                report = auditFromSpecimen(specimen, prefix, codebook);
              }
            } else {
              const result = await auditFromV1(
                labId,
                openldrCs!,
                config.openldrDataDatabase,
                codebook,
              );
              if (result.report === null) {
                errMsg = "no OpenLDR v1 Requests row";
              } else {
                report = result.report;
              }
            }
          } catch (err) {
            errMsg = err instanceof Error ? err.message : String(err);
          }

          await processLabResult(labId, report, errMsg);
        }
      };

      // Per-lab post-processing: counter updates, aggregator ingest,
      // NDJSON write. Pulled out of the worker so both the worker loop
      // and the closure-captured counter set stay readable. No awaits
      // inside the synchronous sections (between the fetches above and
      // the next iteration) so the cooperative model preserves
      // correctness across workers.
      const processLabResult = async (
        labId: string,
        report: AuditReport | null,
        errMsg: string | null,
      ): Promise<void> => {
        scanned++;

        if (report !== null) {
          if (report.anomalies.length > 0) {
            withAnomalies++;
            totalAnomalies += report.anomalies.length;
            for (const a of report.anomalies) {
              perClass[a.class]++;
              if (a.panel_code !== undefined && a.panel_code.length > 0) {
                panelHits.set(a.panel_code, (panelHits.get(a.panel_code) ?? 0) + 1);
              }
            }
          }
          // Wrap aggregator ingest so a bug in one lab's data doesn't
          // tear down the whole batch — the loop's value is in the
          // aggregate, not any single record.
          try {
            reportAggregator?.ingestObject(report);
          } catch (err) {
            process.stderr.write(
              JSON.stringify({
                _meta: "audit-batch-ingest-failed",
                lab_number: labId,
                message: err instanceof Error ? err.message : String(err),
              }) + "\n",
            );
          }

          if (opts.summaryOnly !== true) {
            if (opts.onlyAnomalies !== true || report.anomalies.length > 0) {
              writeOut(JSON.stringify(report) + "\n");
            }
          }
        } else {
          errored++;
          const errEnvelope = {
            lab_number: labId,
            request_id: source === "disa" ? prefix + labId : labId,
            source,
            error: errMsg ?? "unknown error",
          };
          try {
            reportAggregator?.ingestObject(errEnvelope);
          } catch {
            // ignore — error envelopes are simple, this should never fail
          }
          if (opts.summaryOnly !== true) {
            writeOut(JSON.stringify(errEnvelope) + "\n");
          }
        }

        if (scanned % HEARTBEAT_EVERY === 0) writeHeartbeat();
      };

      const workers: Promise<void>[] = [];
      for (let i = 0; i < concurrency; i++) workers.push(worker());
      await Promise.all(workers);

      emitMeta(makeSummary() as unknown as Record<string, unknown>);

      if (reportAggregator !== null && reportOutPath !== null && reportFormat !== null) {
        const aggregation = reportAggregator.finalize(estimatedTotal);
        const rendered = await renderReport(reportFormat, aggregation, {
          title: opts.reportTitle ?? "DISA Migration Audit Report",
          generatedAt: new Date(),
          maxSamplesPerClass: reportMaxSamples,
        });
        mkdirSync(dirname(reportOutPath), { recursive: true });
        writeFileSync(reportOutPath, rendered);
        emitMeta({
          _meta: "audit-report",
          out: reportOutPath,
          format: reportFormat,
          bytes: typeof rendered === "string" ? Buffer.byteLength(rendered) : rendered.length,
        });
      }
    });
}

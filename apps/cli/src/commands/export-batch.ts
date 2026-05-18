import type { Command } from "commander";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { AUDTDATA, REGDAT4, SpecimenRecpt } from "disalab";
import type { DisaServer } from "disalab";
import { CliError } from "../errors.js";
import { closePool } from "../db.js";
import { fetchLabResultsByRequestId, fetchRequestByRequestId } from "../openldr.js";
import { normalizeLabNumber } from "../compare/lab-number.js";
import { diffRecord, isPerfectMatch } from "../compare/diff.js";
import { diffResults, isResultPerfectMatch } from "../compare/result-diff.js";
import { loadCodebook, type Codebook } from "../export/codebook.js";
import { DEFAULT_SITE } from "../export/site-config.js";
import { toV2 } from "../export/v2-transform.js";
import { auditFromSpecimen } from "../audit/detector.js";
import { severityAtLeast, type Severity, type AuditReport } from "../audit/types.js";
import { postLabRequest } from "../api/client.js";
import { fetchKeycloakToken } from "../api/keycloak.js";
import { resolveDataFeedId } from "../api/feed-discovery.js";
import { trackRun } from "../api/run-tracker.js";
import { emitMeta } from "../output.js";
import { loadRuntime } from "./context.js";

interface ExportBatchOpts {
  where?: string;
  limit?: string;
  offset?: string;
  prefix?: string;
  concurrency?: string;
  /** `--no-check` arrives here as `false` (commander default-on, --no- inverts). */
  check?: boolean;
  /** `--no-quarantine` arrives here as `false`. */
  quarantine?: boolean;
  quarantineDir?: string;
  quarantineSeverity?: string;
  openldrCs?: string;
  targetApi?: string;
  token?: string;
  apiPath?: string;
  dataFeedId?: string;
  projectName?: string;
  useCaseName?: string;
  dataFeedName?: string;
  insecureTls?: boolean;
  force?: boolean;
  track?: boolean;
  trackTimeout?: string;
  trackInterval?: string;
  resumeFrom?: string;
  dryRun?: boolean;
  summaryOnly?: boolean;
  explain?: boolean;
  emitPayloads?: boolean;
}

type LabStatus =
  | "posted"
  | "deduplicated"
  | "quarantined"
  | "check_failed"
  | "not_found"
  | "errored"
  | "emitted";

interface LabResult {
  lab_number: string;
  request_id: string;
  status: LabStatus;
  http_status?: number;
  message_id?: string;
  duration_ms: number;
  audit_max_severity?: Severity | null;
  anomaly_count?: number;
  quarantine_path?: string;
  reason?: string;
  error_code?: string;
  error_message?: string;
  tracking_status?: string;
  /** Detail of which v1-fidelity fields disagreed when status is
   *  check_failed. `request_fields` lists the non-matching top-level
   *  fields (their status: mismatch / only_disa / only_v1) so the
   *  operator can see what's drifting without re-running compare per
   *  lab. `results_summary` counts per-observation diffs in the same
   *  shape result-diff.ts emits. */
  check_mismatches?: {
    request_fields?: Array<{ field: string; status: string; reason?: string }>;
    results_summary?: {
      observations_total: number;
      observations_match: number;
      observations_mismatch: number;
      observations_only_disa: number;
      observations_only_v1: number;
    };
  };
  /** Stage of the v2 pipeline that the run was at when it became
   *  terminal. For successful runs this is the last completed stage; for
   *  failures, the stage where it broke (validation/mapping/storage/outpost). */
  pipeline_stage?: string | null;
  /** Error stage / code / message reported by the v2 run record when
   *  currentStatus is non-"completed". The values come straight from
   *  the pipeline so they tell you exactly which plugin rejected the
   *  payload — much more actionable than "pipeline run did not complete". */
  pipeline_error_stage?: string | null;
  pipeline_error_code?: string | null;
  pipeline_error_message?: string | null;
}

interface BatchSummary {
  _meta: "export-batch-summary";
  labs_attempted: number;
  posted: number;
  deduplicated: number;
  quarantined: number;
  check_failed: number;
  not_found: number;
  errored: number;
  elapsed_ms: number;
  avg_ms_per_lab: number | null;
  concurrency: number;
}

function buildServer(connectionString: string): DisaServer {
  return {
    config: { database: { driver: "mssql", connection_string: connectionString } },
  };
}

async function fetchDisaSpecimen(disaLabNo: string, connectionString: string): Promise<SpecimenRecpt | null> {
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

async function fetchAuditRows(disaLabNo: string, connectionString: string): Promise<AUDTDATA[]> {
  try {
    const server = buildServer(connectionString);
    const escaped = disaLabNo.replace(/'/g, "''");
    return await AUDTDATA.All(`WHERE [LABNO]='${escaped}'`, server);
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

async function loadResumeSet(path: string): Promise<Set<string>> {
  const out = new Set<string>();
  const stream = createReadStream(path, { encoding: "utf8" });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed) as { lab_number?: string };
      if (typeof parsed.lab_number === "string" && parsed.lab_number.length > 0) {
        out.add(parsed.lab_number);
      }
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

interface PostConfig {
  baseUrl: string;
  path: string;
  /** Per-POST token resolver. For Keycloak, this calls fetchKeycloakToken
   *  which caches in-process and refreshes ~30s before expiry — so the
   *  call is essentially free when the token is still valid. For the
   *  static --token flag and env-var paths, the resolver returns a
   *  cached value immediately. Solves multi-hour-batch token expiry
   *  (Keycloak default lifetime is 5 minutes). */
  getToken: () => Promise<string>;
  tokenSource: "flag" | "keycloak" | "env";
  dataFeedId: string | undefined;
  dataFeedSource: "explicit" | "discovered" | "none";
  force: boolean;
  track: boolean;
  trackTimeoutMs: number | undefined;
  trackIntervalMs: number | undefined;
}

async function resolvePostConfig(opts: ExportBatchOpts, config: import("../config.js").LoadedConfig): Promise<PostConfig> {
  if (opts.insecureTls === true || config.openldrV2InsecureTls) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  const baseUrl = opts.targetApi ?? config.openldrV2Url;
  if (baseUrl === undefined || baseUrl.length === 0) {
    throw new CliError(
      "API_CONFIG_MISSING",
      "OpenLDR v2 URL not configured. Set OPENLDR_V2_URL in env / .env, or pass --target-api.",
    );
  }
  let path = opts.apiPath ?? config.openldrV2Path;

  let getToken: (() => Promise<string>) | undefined;
  let tokenSource: PostConfig["tokenSource"] = "flag";
  if (opts.token !== undefined && opts.token.length > 0) {
    const tok = opts.token;
    getToken = async (): Promise<string> => tok;
    tokenSource = "flag";
  } else if (
    config.keycloakUrl !== undefined && config.keycloakUrl.length > 0 &&
    config.keycloakRealm !== undefined && config.keycloakRealm.length > 0 &&
    config.keycloakClientId !== undefined && config.keycloakClientId.length > 0 &&
    config.keycloakClientSecret !== undefined && config.keycloakClientSecret.length > 0
  ) {
    const kcOpts = {
      baseUrl: config.keycloakUrl,
      realm: config.keycloakRealm,
      clientId: config.keycloakClientId,
      clientSecret: config.keycloakClientSecret,
    };
    getToken = async (): Promise<string> => fetchKeycloakToken(kcOpts);
    tokenSource = "keycloak";
  } else if (config.openldrV2Token !== undefined && config.openldrV2Token.length > 0) {
    const tok = config.openldrV2Token;
    getToken = async (): Promise<string> => tok;
    tokenSource = "env";
  }
  if (getToken === undefined) {
    throw new CliError(
      "API_CONFIG_MISSING",
      "OpenLDR v2 token not configured. Set OPENLDR_V2_TOKEN, configure KEYCLOAK_* vars for dynamic minting, or pass --token.",
    );
  }

  // Mint a token once up front to validate Keycloak config + warm the
  // cache. Subsequent per-POST calls hit the cache (or refresh on the
  // 30s-before-expiry boundary).
  const initialToken = await getToken();

  let dataFeedId: string | undefined = opts.dataFeedId ?? config.openldrDataFeedId;
  let dataFeedSource: PostConfig["dataFeedSource"] = dataFeedId !== undefined ? "explicit" : "none";
  if (dataFeedId === undefined) {
    const projectName = opts.projectName ?? config.openldrProjectName;
    const useCaseName = opts.useCaseName ?? config.openldrUseCaseName;
    const dataFeedName = opts.dataFeedName ?? config.openldrDataFeedName;
    if (
      projectName !== undefined && projectName.length > 0 &&
      useCaseName !== undefined && useCaseName.length > 0 &&
      dataFeedName !== undefined && dataFeedName.length > 0
    ) {
      dataFeedId = await resolveDataFeedId({
        baseUrl,
        token: initialToken,
        projectName,
        useCaseName,
        dataFeedName,
      });
      dataFeedSource = "discovered";
    }
  }

  if (opts.force === true) {
    path = path + (path.includes("?") ? "&" : "?") + "force=true";
  }

  return {
    baseUrl,
    path,
    getToken,
    tokenSource,
    dataFeedId,
    dataFeedSource,
    force: opts.force === true,
    track: opts.track === true,
    trackTimeoutMs: opts.trackTimeout !== undefined && opts.trackTimeout.length > 0 ? Number(opts.trackTimeout) : undefined,
    trackIntervalMs: opts.trackInterval !== undefined && opts.trackInterval.length > 0 ? Number(opts.trackInterval) : undefined,
  };
}

interface ProcessLabContext {
  config: import("../config.js").LoadedConfig;
  codebook: Codebook;
  prefix: string;
  postConfig: PostConfig;
  doCheck: boolean;
  doQuarantine: boolean;
  quarantineDir: string | null;
  quarantineThreshold: Severity;
  openldrCs: string | undefined;
  dryRun: boolean;
  /** When set, write the v2 payload to stdout (via writePayload) and skip the POST. */
  emitPayloads: boolean;
  /** Sink for the NDJSON payload line. Provided by the action handler so the
   *  EPIPE-safe writeOut helper can be reused. */
  writePayload?: (line: string) => void;
}

/** Process one lab end-to-end: fetch -> (--check) -> build -> audit ->
 *  (quarantine) -> POST -> (track). Returns a structured LabResult.
 *  Catches all errors internally to keep the batch loop alive. */
async function processOneLab(disaLabNo: string, ctx: ProcessLabContext): Promise<LabResult> {
  const start = Date.now();
  const norm = normalizeLabNumber(disaLabNo, ctx.prefix);
  const result: LabResult = {
    lab_number: norm.disaLabNo,
    request_id: norm.openldrRequestId,
    status: "errored",
    duration_ms: 0,
  };

  try {
    // Fetch DISA + (optional) v1 rows. Workers run in parallel — the
    // disalab pool registry (getPool) keeps a separate ConnectionPool per
    // connection string, so DISA and v1 reads don't race a shared global.
    const fetched = await (async () => {
      const specimen = await fetchDisaSpecimen(norm.disaLabNo, ctx.config.connectionString);
      if (specimen === null) {
        return { specimen: null as SpecimenRecpt | null, v1Request: null, v1Rows: [] as Awaited<ReturnType<typeof fetchLabResultsByRequestId>> };
      }
      if (ctx.doCheck && ctx.openldrCs !== undefined) {
        const v1Request = await fetchRequestByRequestId(
          norm.openldrRequestId,
          ctx.openldrCs,
          ctx.config.openldrDataDatabase,
        );
        if (v1Request === null) {
          return { specimen, v1Request: null, v1Rows: [] };
        }
        const v1Rows = await fetchLabResultsByRequestId(
          norm.openldrRequestId,
          ctx.openldrCs,
          ctx.config.openldrDataDatabase,
        );
        return { specimen, v1Request, v1Rows };
      }
      return { specimen, v1Request: null, v1Rows: [] };
    })();

    const specimen = fetched.specimen;
    if (specimen === null) {
      result.status = "not_found";
      result.duration_ms = Date.now() - start;
      return result;
    }

    // -------- v1 fidelity check --------
    if (ctx.doCheck) {
      if (ctx.openldrCs === undefined) {
        result.status = "errored";
        result.error_code = "OPENLDR_CONFIG_MISSING";
        result.error_message = "OpenLDR v1 connection string required for --check";
        result.duration_ms = Date.now() - start;
        return result;
      }
      if (fetched.v1Request === null) {
        result.status = "check_failed";
        result.reason = "OpenLDR v1 has no Requests row for this lab";
        result.duration_ms = Date.now() - start;
        return result;
      }
      const requestDiff = diffRecord(specimen, fetched.v1Request);
      if (!isPerfectMatch(requestDiff.summary)) {
        result.status = "check_failed";
        result.reason = "request-level v1 fidelity mismatch";
        result.check_mismatches = {
          // Compact: just the field names + status + comparator reason —
          // not the full disa/v1 values (could be huge per lab). For
          // detailed inspection, run `disa compare <lab>` directly.
          request_fields: requestDiff.fields
            .filter((f) => f.status !== "match")
            .map((f) => ({
              field: f.field,
              status: f.status,
              ...(f.reason !== undefined ? { reason: f.reason } : {}),
            })),
        };
        result.duration_ms = Date.now() - start;
        return result;
      }
      const resultDiff = diffResults(specimen, fetched.v1Rows, {});
      if (!isResultPerfectMatch(resultDiff.summary)) {
        result.status = "check_failed";
        result.reason = "per-observation v1 fidelity mismatch";
        result.check_mismatches = {
          results_summary: {
            observations_total: resultDiff.summary.observations_total,
            observations_match: resultDiff.summary.observations_match,
            observations_mismatch: resultDiff.summary.observations_mismatch,
            observations_only_disa: resultDiff.summary.observations_only_disa,
            observations_only_v1: resultDiff.summary.observations_only_v1,
          },
        };
        result.duration_ms = Date.now() - start;
        return result;
      }
    }

    // -------- audit + quarantine --------
    const auditReport: AuditReport | null = ctx.doQuarantine
      ? auditFromSpecimen(specimen, ctx.prefix, ctx.codebook)
      : null;
    if (auditReport !== null) {
      result.audit_max_severity = auditReport.max_severity;
      result.anomaly_count = auditReport.anomalies.length;
      if (
        ctx.quarantineDir !== null &&
        auditReport.max_severity !== null &&
        severityAtLeast(auditReport.max_severity, ctx.quarantineThreshold)
      ) {
        const target = resolve(ctx.quarantineDir, `${norm.disaLabNo}.json`);
        const payload = toV2(specimen, {
          prefix: ctx.prefix,
          site: DEFAULT_SITE,
          codebook: ctx.codebook,
          auditReport,
        });
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(
          target,
          JSON.stringify(
            {
              lab_number: norm.disaLabNo,
              request_id: norm.openldrRequestId,
              quarantined_at: new Date().toISOString(),
              threshold: ctx.quarantineThreshold,
              audit_report: auditReport,
              payload,
            },
            null,
            2,
          ) + "\n",
        );
        result.status = "quarantined";
        result.quarantine_path = target;
        result.duration_ms = Date.now() - start;
        return result;
      }
    }

    // -------- build payload --------
    const payload = toV2(specimen, {
      prefix: ctx.prefix,
      site: DEFAULT_SITE,
      codebook: ctx.codebook,
      auditReport,
    });

    // -------- emit payloads (stdin to `openldr ingest stream`) --------
    if (ctx.emitPayloads) {
      ctx.writePayload?.(JSON.stringify(payload) + "\n");
      result.status = "emitted";
      result.reason = "emit-payloads (skipped POST)";
      result.duration_ms = Date.now() - start;
      return result;
    }

    // -------- dry run --------
    if (ctx.dryRun) {
      result.status = "posted";
      result.reason = "dry-run (skipped POST)";
      result.duration_ms = Date.now() - start;
      return result;
    }

    // -------- POST --------
    // Resolve token per-lab so long-running batches don't post with a
    // stale Keycloak token (default lifetime 5 min). Resolver is cached
    // — this is essentially free until the 30s-before-expiry boundary.
    const token = await ctx.postConfig.getToken();
    const extraHeaders: Record<string, string> = {};
    if (ctx.postConfig.dataFeedId !== undefined) {
      extraHeaders["X-DataFeed-Id"] = ctx.postConfig.dataFeedId;
    }
    const post = await postLabRequest(payload, {
      baseUrl: ctx.postConfig.baseUrl,
      token,
      path: ctx.postConfig.path,
      extraHeaders,
    });
    result.http_status = post.status;
    const body = post.body as { messageId?: string; deduplicated?: boolean } | undefined;
    if (body?.messageId !== undefined) result.message_id = body.messageId;
    if (body?.deduplicated === true) {
      result.status = "deduplicated";
    } else {
      result.status = "posted";
    }

    // -------- track (optional) --------
    if (ctx.postConfig.track && body?.messageId !== undefined) {
      // Refetch the token in case the POST ate the rest of the lifetime
      // window — track polling can run for tens of seconds.
      const trackToken = await ctx.postConfig.getToken();
      const tr = await trackRun({
        baseUrl: ctx.postConfig.baseUrl,
        token: trackToken,
        messageId: body.messageId,
        ...(ctx.postConfig.trackTimeoutMs !== undefined && Number.isFinite(ctx.postConfig.trackTimeoutMs)
          ? { timeoutMs: ctx.postConfig.trackTimeoutMs } : {}),
        ...(ctx.postConfig.trackIntervalMs !== undefined && Number.isFinite(ctx.postConfig.trackIntervalMs)
          ? { intervalMs: ctx.postConfig.trackIntervalMs } : {}),
      });
      const run = tr.run;
      result.tracking_status = run.currentStatus;
      result.pipeline_stage = run.currentStage;
      if (run.currentStatus.toLowerCase() !== "completed") {
        result.status = "errored";
        // Surface the pipeline's own error stage / code / message so the
        // user knows WHICH plugin rejected the payload — generic
        // "pipeline run did not complete" wastes their time.
        result.pipeline_error_stage = run.errorStage;
        result.pipeline_error_code = run.errorCode;
        result.pipeline_error_message = run.errorMessage;
        result.error_code = "API_REJECTED";
        const stage = run.errorStage ?? run.currentStage ?? "unknown";
        const why = run.errorMessage ?? run.errorCode ?? `currentStatus=${run.currentStatus}`;
        result.error_message = `pipeline failed at stage "${stage}": ${why}`;
      }
    }

    result.duration_ms = Date.now() - start;
    return result;
  } catch (err) {
    result.status = "errored";
    if (err instanceof CliError) {
      result.error_code = err.code;
      result.error_message = err.message;
    } else {
      result.error_code = "UNKNOWN";
      result.error_message = err instanceof Error ? err.message : String(err);
    }
    result.duration_ms = Date.now() - start;
    return result;
  }
}

export function registerExportBatchCommand(program: Command): void {
  program
    .command("export-batch")
    .description(
      "Build + POST v2 payloads for many labs end-to-end. Default behaviour: --check (v1 fidelity gate) AND audit-driven quarantine for every lab. Per-lab status to stdout (NDJSON), summary on stderr. Resume-friendly via --resume-from.",
    )
    .option("--where <sql>", "WHERE clause applied to REGDAT4 when selecting labs", "")
    .option("--limit <n>", "max labs to process", "100")
    .option("--offset <n>", "labs to skip before starting", "0")
    .option("--prefix <str>", "Override the OpenLDR labno prefix")
    .option("--concurrency <n>", "Number of labs in flight at once. Defaults to 1 — raise to test the API's rate limit.", "1")
    .option("--no-check", "Skip the v1 fidelity check (faster, less safe)")
    .option("--no-quarantine", "Skip the audit-driven quarantine (faster, less safe)")
    .option("--quarantine-dir <path>", "Directory to write quarantined payloads to (default: ./temp/quarantine).")
    .option("--quarantine-severity <level>", "Severity threshold for quarantine: error (default), warn, or info.")
    .option("--openldr-cs <url>", "OpenLDR v1 connection string (required when --check is on; overrides env)")
    .option("--target-api <url>", "OpenLDR v2 base URL (overrides OPENLDR_V2_URL env)")
    .option("--token <bearer>", "Bearer token for the v2 API (overrides OPENLDR_V2_TOKEN env)")
    .option("--api-path <path>", "Endpoint path appended to the base URL")
    .option("--data-feed-id <uuid>", "Pre-resolved X-DataFeed-Id (skips discovery)")
    .option("--project-name <name>", "OpenLDR project for X-DataFeed-Id discovery")
    .option("--use-case-name <name>", "OpenLDR use case for X-DataFeed-Id discovery")
    .option("--data-feed-name <name>", "OpenLDR data feed for X-DataFeed-Id discovery")
    .option("--insecure-tls", "Skip TLS cert verification (self-signed local dev only)")
    .option("--force", "Append `?force=true` so v2 re-processes already-ingested payloads")
    .option("--track", "Per lab, poll /api/v1/runs/{messageId} until terminal")
    .option("--track-timeout <ms>", "Per-lab track timeout (default 60000)")
    .option("--track-interval <ms>", "Per-lab track poll interval (default 1000)")
    .option("--resume-from <path>", "Skip lab numbers that already appear in this prior NDJSON output (use the previous --out / redirected stdout file).")
    .option("--dry-run", "Run the entire pipeline EXCEPT the POST. Useful for confirming the gates against many labs without sending anything.")
    .option("--summary-only", "Suppress per-lab stdout output; emit only the final summary.")
    .option("--explain", "Show the lab-selection query and effective config; exit without running.")
    .option("--emit-payloads", "Build each v2 payload and write it to stdout as NDJSON (one per line) instead of POSTing. Per-lab journal goes to stderr in this mode. Designed to pipe into `openldr ingest stream`.")
    .action(async (opts: ExportBatchOpts, cmd: Command) => {
      const { config } = loadRuntime(cmd, { requireConnection: false });
      const prefix = opts.prefix ?? config.openldrLabnoPrefix;
      const limit = Number(opts.limit ?? "100");
      const offset = Number(opts.offset ?? "0");
      const where = opts.where ?? "";
      const concurrency = Math.max(1, Number(opts.concurrency ?? "1"));
      if (!Number.isFinite(concurrency) || concurrency < 1) {
        throw new CliError("USAGE", `--concurrency must be a positive integer (got "${opts.concurrency}").`);
      }

      const doCheck = opts.check !== false;
      const doQuarantine = opts.quarantine !== false;
      const quarantineDir = doQuarantine ? resolve(opts.quarantineDir ?? "./temp/quarantine") : null;
      const quarantineThresholdRaw = (opts.quarantineSeverity ?? "error").toLowerCase();
      if (quarantineThresholdRaw !== "error" && quarantineThresholdRaw !== "warn" && quarantineThresholdRaw !== "info") {
        throw new CliError("USAGE", `--quarantine-severity must be error, warn, or info.`);
      }
      const quarantineThreshold = quarantineThresholdRaw as Severity;

      if (opts.explain === true) {
        const trimmed = where.trim().replace(/^WHERE\s+/i, "");
        const userClause = trimmed.length > 0 ? `WHERE ${trimmed}` : "";
        process.stdout.write(JSON.stringify({
          operation: "export-batch",
          lab_selection: {
            method: "REGDAT4.LabNumbers",
            where: `${userClause} ORDER BY [LabNo] OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY`,
          },
          prefix,
          concurrency,
          gates: {
            check: doCheck,
            quarantine: doQuarantine,
            quarantine_dir: quarantineDir,
            quarantine_severity: quarantineThreshold,
          },
          dry_run: opts.dryRun === true,
        }) + "\n");
        return;
      }

      if (config.connectionString.length === 0) {
        throw new CliError(
          "CONFIG_MISSING",
          "DISA_CONNECTION_STRING not configured.",
        );
      }
      const openldrCs = doCheck ? (opts.openldrCs ?? config.openldrConnectionString) : undefined;
      if (doCheck && (openldrCs === undefined || openldrCs.length === 0)) {
        throw new CliError(
          "OPENLDR_CONFIG_MISSING",
          "OpenLDR v1 connection string required when --check is on (the default). Set OPENLDR_V1_CONNECTION_STRING, pass --openldr-cs, or disable with --no-check.",
        );
      }

      const start = Date.now();

      // Counters declared up front so global error handlers can emit a
      // best-effort summary on a hard crash mid-run.
      let attempted = 0;
      let posted = 0;
      let deduplicated = 0;
      let quarantined = 0;
      let checkFailed = 0;
      let notFound = 0;
      let errored = 0;
      let currentLab: string | null = null;

      const makeSummary = (): BatchSummary => {
        const elapsed = Date.now() - start;
        return {
          _meta: "export-batch-summary",
          labs_attempted: attempted,
          posted, deduplicated, quarantined, check_failed: checkFailed,
          not_found: notFound, errored,
          elapsed_ms: elapsed,
          avg_ms_per_lab: attempted > 0 ? Math.round(elapsed / attempted) : null,
          concurrency,
        };
      };

      let stdoutOpen = true;
      const onFatal = (kind: string) => (err: unknown): void => {
        const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
        try {
          process.stderr.write(JSON.stringify({
            _meta: "export-batch-fatal",
            kind, message: msg, attempted_so_far: attempted, current_lab: currentLab,
          }) + "\n");
          emitMeta(makeSummary() as unknown as Record<string, unknown>);
        } catch { /* ignore */ }
        process.exit(13);
      };
      process.on("uncaughtException", onFatal("uncaughtException"));
      process.on("unhandledRejection", onFatal("unhandledRejection"));
      process.stdout.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EPIPE") stdoutOpen = false;
        else onFatal("stdout-error")(err);
      });

      const writeOut = (payload: string): void => {
        if (!stdoutOpen) return;
        try { process.stdout.write(payload); }
        catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "EPIPE") stdoutOpen = false;
          else stdoutOpen = false;
        }
      };

      const HEARTBEAT_EVERY = Math.max(1, Math.min(500, concurrency * 25));
      const writeHeartbeat = (): void => {
        const elapsed = Date.now() - start;
        process.stderr.write(JSON.stringify({
          _meta: "export-batch-progress",
          attempted, posted, deduplicated, quarantined,
          check_failed: checkFailed, errored,
          current_lab: currentLab,
          elapsed_ms: elapsed,
          avg_ms_per_lab: attempted > 0 ? Math.round(elapsed / attempted) : null,
        }) + "\n");
      };

      // -------- one-time setup --------
      const codebook = await loadCodebook(buildServer(config.connectionString));
      await closePool();

      // Skip POST config resolution entirely when dry-running so users
      // can validate the gates without API credentials.
      const postConfig: PostConfig = opts.dryRun === true
        ? {
            baseUrl: "",
            path: "",
            getToken: async (): Promise<string> => "",
            tokenSource: "env",
            dataFeedId: undefined,
            dataFeedSource: "none",
            force: false,
            track: false,
            trackTimeoutMs: undefined,
            trackIntervalMs: undefined,
          }
        : await resolvePostConfig(opts, config);

      // Resume set: lab numbers we should skip because a prior run
      // already processed them (success or failure).
      let resumeSet: Set<string> | null = null;
      if (opts.resumeFrom !== undefined && opts.resumeFrom.length > 0) {
        resumeSet = await loadResumeSet(resolve(opts.resumeFrom));
        process.stderr.write(JSON.stringify({
          _meta: "export-batch-resume",
          resume_from: resolve(opts.resumeFrom),
          skipped_labs: resumeSet.size,
        }) + "\n");
      }

      const labIds = await fetchLabNumbers(where, limit, offset, config.connectionString);

      const ctx: ProcessLabContext = {
        config,
        codebook,
        prefix,
        postConfig,
        doCheck,
        doQuarantine,
        quarantineDir,
        quarantineThreshold,
        openldrCs,
        dryRun: opts.dryRun === true,
        emitPayloads: opts.emitPayloads === true,
        writePayload: opts.emitPayloads === true ? writeOut : undefined,
      };

      const tally = (r: LabResult): void => {
        switch (r.status) {
          case "posted": posted++; break;
          case "deduplicated": deduplicated++; break;
          case "quarantined": quarantined++; break;
          case "check_failed": checkFailed++; break;
          case "not_found": notFound++; break;
          case "errored": errored++; break;
          case "emitted": posted++; break;
        }
        if (opts.summaryOnly !== true) {
          // In --emit-payloads mode the payload itself goes to stdout (via
          // ctx.writePayload). Route the per-lab journal to stderr so the
          // consuming `openldr ingest stream` sees pure payloads.
          const line = JSON.stringify(r) + "\n";
          if (opts.emitPayloads === true) process.stderr.write(line);
          else writeOut(line);
        }
        if (attempted % HEARTBEAT_EVERY === 0) writeHeartbeat();
      };

      // -------- worker pool --------
      // Drive `concurrency` workers in parallel by handing each one the
      // next lab from a shared cursor. Simpler than promise pools and
      // gives natural back-pressure: a slow lab doesn't block faster
      // labs from completing.
      let cursor = 0;
      const nextLabId = (): string | null => {
        while (cursor < labIds.length) {
          const candidate = labIds[cursor]!.trim();
          cursor++;
          if (resumeSet !== null && resumeSet.has(candidate)) continue;
          return candidate;
        }
        return null;
      };

      const worker = async (): Promise<void> => {
        for (;;) {
          const labId = nextLabId();
          if (labId === null) return;
          currentLab = labId;
          const r = await processOneLab(labId, ctx);
          attempted++;
          tally(r);
        }
      };

      const workers: Promise<void>[] = [];
      for (let i = 0; i < concurrency; i++) workers.push(worker());
      await Promise.all(workers);

      emitMeta(makeSummary() as unknown as Record<string, unknown>);

      // Non-zero exit when ANY lab didn't end in a clean state — same
      // conservative stance audit-batch and compare-batch take.
      const skippedOrFailed = quarantined + checkFailed + errored;
      if (skippedOrFailed > 0) {
        throw new CliError(
          "API_REJECTED",
          `${skippedOrFailed} of ${attempted} labs were not posted (quarantined=${quarantined}, check_failed=${checkFailed}, errored=${errored}).`,
          { posted, deduplicated, quarantined, check_failed: checkFailed, errored, attempted },
        );
      }
    });
}

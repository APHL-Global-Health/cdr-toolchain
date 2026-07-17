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
import { resolvePocFormat } from "../compare/mapping.js";
import { WardDictResolver } from "../compare/warddict-resolver.js";
import type { PocFormat } from "../openldr.js";
import { diffResults, isResultPerfectMatch } from "../compare/result-diff.js";
import { loadCodebook, type Codebook } from "../export/codebook.js";
import { DEFAULT_SITE } from "../export/site-config.js";
import { toV2 } from "../export/v2-transform.js";
import { toFhir } from "../export/fhir-transform.js";
import { toFormSubmission } from "../export/forms-transform.js";
import { isDocumentationObs, type DocConfig } from "../export/non-test.js";
import { loadCountryDocConfig } from "../config/country-config.js";
import { auditFromSpecimen } from "../audit/detector.js";
import { severityAtLeast, type Severity, type AuditReport } from "../audit/types.js";
import { postLabRequest } from "../api/client.js";
import { postFhirResources } from "../api/ce-client.js";
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
  country?: string;
  formsDataFeedName?: string;
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
  pocFormat?: string;
  ceUrl?: string;
  ceHookPath?: string;
  ceToken?: string;
  ceTz?: string;
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
  /** Which feed(s) this record was routed to: "lab" (test only — no
   *  documentation obs), "form" (documentation-only — no lab leg posted), or
   *  "split" (both legs posted). Undefined for non-POST paths
   *  (dry-run / emit-payloads / quarantine / not_found). */
  routing?: "lab" | "form" | "split";
  /** HTTP status of the forms-leg POST, when a forms submission was sent. */
  forms_http_status?: number;
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
  /** Labs whose forms (non-test) leg POSTed with a 2xx status. */
  forms_posted: number;
  /** Labs routed to BOTH feeds (lab leg + forms leg). */
  split: number;
  elapsed_ms: number;
  avg_ms_per_lab: number | null;
  concurrency: number;
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
    // WARDDICT resolution before pool close. Resolver cache is shared
    // across the batch via ctx, so each unique (LOCATION, WARD) pair
    // only hits the DB once over the whole run. Non-destructive: raw
    // WardClinic stays put so v2's source_payload.ward_clinic_raw is
    // preserved alongside the resolved description.
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
  /** X-DataFeed-Id for the forms (non-test) feed. Undefined when no forms feed
   *  is configured/discoverable — guarded at POST time (a run with no
   *  documentation records needs no forms feed). */
  formsDataFeedId: string | undefined;
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

  // Fail fast: every v2 POST requires an X-DataFeed-Id. If none was resolved
  // (no --data-feed-id / OPENLDR_DATA_FEED_ID, and the discovery names are
  // blank so discovery was skipped), the entire batch would be rejected
  // lab-by-lab with HTTP 400. Surface it once, up front. This path only runs
  // for real POSTs — --dry-run / --emit-payloads skip resolvePostConfig.
  if (dataFeedSource === "none") {
    throw new CliError(
      "API_CONFIG_MISSING",
      'OpenLDR v2 requires an X-DataFeed-Id, but none is configured. Set OPENLDR_PROJECT_NAME, OPENLDR_USE_CASE_NAME and OPENLDR_DATA_FEED_NAME in .env (all "Built-in" on the default deployment) to enable feed discovery, or pass --data-feed-id / set OPENLDR_DATA_FEED_ID.',
    );
  }

  // Resolve the forms (non-test) feed id the same way as the lab feed. Unlike
  // the lab feed we do NOT fail fast: a run whose labs carry no documentation
  // observations never POSTs a forms leg, so a missing forms feed is fine.
  // Guarded at POST time in processOneLab instead.
  let formsDataFeedId: string | undefined = config.openldrFormsDataFeedId;
  if (formsDataFeedId === undefined) {
    const projectName = opts.projectName ?? config.openldrProjectName;
    const useCaseName = opts.useCaseName ?? config.openldrUseCaseName;
    const formsDataFeedName = opts.formsDataFeedName ?? config.openldrFormsDataFeedName;
    if (
      projectName !== undefined && projectName.length > 0 &&
      useCaseName !== undefined && useCaseName.length > 0 &&
      formsDataFeedName !== undefined && formsDataFeedName.length > 0
    ) {
      formsDataFeedId = await resolveDataFeedId({
        baseUrl,
        token: initialToken,
        projectName,
        useCaseName,
        dataFeedName: formsDataFeedName,
      });
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
    formsDataFeedId,
    force: opts.force === true,
    track: opts.track === true,
    trackTimeoutMs: opts.trackTimeout !== undefined && opts.trackTimeout.length > 0 ? Number(opts.trackTimeout) : undefined,
    trackIntervalMs: opts.trackInterval !== undefined && opts.trackInterval.length > 0 ? Number(opts.trackInterval) : undefined,
  };
}

interface ProcessLabContext {
  config: import("../config.js").LoadedConfig;
  codebook: Codebook;
  /** Country documentation classifiers (panels/params/forms). Drives the
   *  documentation-vs-test split: which observations are excluded from the lab
   *  payload and routed to the forms feed. */
  docConfig: DocConfig;
  prefix: string;
  postConfig: PostConfig;
  /** Present when the CE target is selected (--ce-url / OPENLDR_CE_URL). When
   *  set, processOneLab sends resources to CE's workflow webhook instead of
   *  the v2 lab+forms POST — see the CE branch near the top of the "POST"
   *  section below. */
  ceConfig?: { baseUrl: string; path: string; token: string; tzOffset: string };
  doCheck: boolean;
  doQuarantine: boolean;
  quarantineDir: string | null;
  quarantineThreshold: Severity;
  openldrCs: string | undefined;
  pocFormat: PocFormat;
  dryRun: boolean;
  /** When set, write the v2 payload to stdout (via writePayload) and skip the POST. */
  emitPayloads: boolean;
  /** Sink for the NDJSON payload line. Provided by the action handler so the
   *  EPIPE-safe writeOut helper can be reused. */
  writePayload?: (line: string) => void;
  /** Shared WARDDICT resolver — one instance per batch run so the
   *  (LOCATION, WARD) cache amortises across thousands of labs. */
  wardResolver: WardDictResolver;
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
      const specimen = await fetchDisaSpecimen(
        norm.disaLabNo,
        ctx.config.connectionString,
        ctx.wardResolver,
      );
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
      const requestDiff = diffRecord(specimen, fetched.v1Request, { pocFormat: ctx.pocFormat });
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
      ? auditFromSpecimen(specimen, ctx.prefix, ctx.codebook, ctx.docConfig.panels)
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
          excludeObs: (o) => isDocumentationObs(o, ctx.codebook, ctx.docConfig),
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
      excludeObs: (o) => isDocumentationObs(o, ctx.codebook, ctx.docConfig),
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

    // -------- CE target: FHIR POST to the workflow webhook --------
    // Takes over from here entirely when a CE target is configured — the v2
    // lab-leg/forms-leg split below does not apply to CE (toFhir builds one
    // resource bundle from the same v2 payload). Placed after emit-payloads/
    // dry-run (both still operate on the V2 payload/contract unchanged) and
    // before the v2 POST so a CE target never touches the v2 API.
    if (ctx.ceConfig !== undefined) {
      const resources = toFhir(payload, { tzOffset: ctx.ceConfig.tzOffset });
      const post = await postFhirResources(resources, {
        baseUrl: ctx.ceConfig.baseUrl,
        path: ctx.ceConfig.path,
        token: ctx.ceConfig.token,
      });
      result.http_status = post.status;
      result.status = "posted";
      result.duration_ms = Date.now() - start;
      return result;
    }

    // -------- POST --------
    // Resolve token per-lab so long-running batches don't post with a
    // stale Keycloak token (default lifetime 5 min). Resolver is cached
    // — this is essentially free until the 30s-before-expiry boundary.
    const token = await ctx.postConfig.getToken();

    // ---- lab leg ----
    // Only POST the lab leg when the lab payload actually carries something.
    // After documentation observations are excluded, a documentation-only
    // record has empty lab_results AND a null panel_code — v2 storage would
    // reject it, and it belongs on the forms feed, not the lab feed.
    let post: Awaited<ReturnType<typeof postLabRequest>> | null = null;
    // Each lab_request is an ORDERED panel and names itself, so a lab with any
    // ordered panel now has a panel_code — the "documentation-only" case is a
    // lab whose every request lacks one.
    if (
      payload.lab_results.length > 0 ||
      payload.lab_requests.some((r) => r.panel_code !== null)
    ) {
      const extraHeaders: Record<string, string> = {};
      if (ctx.postConfig.dataFeedId !== undefined) {
        extraHeaders["X-DataFeed-Id"] = ctx.postConfig.dataFeedId;
      }
      post = await postLabRequest(payload, {
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
    }

    // ---- forms leg ----
    // Build a forms submission from the documentation observations. Null when
    // the record carries none. When the lab leg also posted this is a "split"
    // record; the form references the lab request id via related_request_id.
    const formPayload = toFormSubmission(specimen, {
      prefix: ctx.prefix,
      site: DEFAULT_SITE,
      codebook: ctx.codebook,
      docConfig: ctx.docConfig,
      relatedRequestId: post !== null ? norm.openldrRequestId : null,
    });
    if (formPayload !== null) {
      if (ctx.postConfig.formsDataFeedId === undefined) {
        result.status = "errored";
        result.error_code = "API_CONFIG_MISSING";
        result.error_message = 'Record has documentation observations but no forms feed is configured. Set OPENLDR_FORMS_DATA_FEED_NAME (and OPENLDR_COUNTRY / config) or --forms-data-feed-name.';
        result.duration_ms = Date.now() - start;
        return result;
      }
      try {
        const formsPost = await postLabRequest(formPayload, {
          baseUrl: ctx.postConfig.baseUrl,
          token,
          path: ctx.postConfig.path,
          extraHeaders: { "X-DataFeed-Id": ctx.postConfig.formsDataFeedId },
        });
        result.forms_http_status = formsPost.status;
        result.routing = post !== null ? "split" : "form";
        // Fix 1: for documentation-only records the lab leg was skipped
        // (post === null), so the "posted"/"deduplicated" assignment above
        // never ran. Set the success status here so the tally counts this
        // record as posted rather than leaving it at the initial "errored".
        // For split records the lab leg already set the status — leave it.
        if (post === null) {
          result.status = "posted";
        }
      } catch (err) {
        result.status = "errored";
        result.error_code = err instanceof CliError ? err.code : "UNKNOWN";
        result.error_message = `forms leg: ${err instanceof Error ? err.message : String(err)}`;
        result.routing = post !== null ? "split" : "form";
        result.duration_ms = Date.now() - start;
        return result;
      }
    } else {
      result.routing = "lab";
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

/** CE has no storage-level backstop: its Specimen schema requires only
 *  resourceType, so a specimen-less record persists silently. v2's storage
 *  rejected those. On the CE path the audit gate is the ONLY protection, so
 *  disabling it must fail before the first query. A rule that depends on an
 *  operator reading a doc is not a rule. */
export function assertCeGatesEnabled(o: {
  ceUrl: string | undefined; doCheck: boolean; doQuarantine: boolean;
}): void {
  if (o.ceUrl === undefined || o.ceUrl.length === 0) return;
  if (!o.doCheck) {
    throw new CliError(
      "USAGE",
      "--no-check is refused when the target is OpenLDR CE. CE's FHIR validation is structural only and accepts records the v1 fidelity check exists to catch; the gate is the only thing between bad source data and the store. Drop --no-check, or target v2 instead.",
    );
  }
  if (!o.doQuarantine) {
    throw new CliError(
      "USAGE",
      "--no-quarantine is refused when the target is OpenLDR CE. The audit gate is the only protection on this path — CE will not reject records the audit would quarantine.",
    );
  }
}

/** DISA stores unzoned local wall-clock (v2-transform.ts:38-50). FHIR needs a
 *  zone. Moz/Zambia are UTC+2, so a silent UTC default would shift every
 *  timestamp 2h earlier with no error — the worst failure mode for data
 *  feeding a migration-fidelity comparison. Require it explicitly. */
export function requireCeTimezone(ceUrl: string | undefined, tz: string | undefined): string | undefined {
  if (ceUrl === undefined || ceUrl.length === 0) return undefined;
  const t = (tz ?? "").trim();
  if (!/^(Z|[+-]\d{2}:\d{2})$/.test(t)) {
    throw new CliError(
      "CONFIG_MISSING",
      `A timezone offset is required when the target is OpenLDR CE (got ${JSON.stringify(tz ?? null)}). DISA stores unzoned local time; assuming UTC would shift Moz/Zambia timestamps 2h with no error. Set OPENLDR_CE_TIMEZONE or pass --ce-tz, e.g. +02:00.`,
    );
  }
  return t;
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
    .option("--ce-url <url>", "OpenLDR CE base URL (overrides OPENLDR_CE_URL env). Selects the CE target instead of v2.")
    .option("--ce-hook-path <path>", "CE workflow webhook path (overrides OPENLDR_CE_HOOK_PATH env)")
    .option("--ce-token <secret>", "CE webhook token for the x-webhook-token header (overrides OPENLDR_CE_WEBHOOK_TOKEN env)")
    .option("--ce-tz <offset>", "UTC offset for DISA's unzoned local timestamps, e.g. +02:00. REQUIRED with --ce-url (overrides OPENLDR_CE_TIMEZONE env)")
    .option("--data-feed-id <uuid>", "Pre-resolved X-DataFeed-Id (skips discovery)")
    .option("--project-name <name>", "OpenLDR project for X-DataFeed-Id discovery")
    .option("--use-case-name <name>", "OpenLDR use case for X-DataFeed-Id discovery")
    .option("--data-feed-name <name>", "OpenLDR data feed for X-DataFeed-Id discovery")
    .option("--country <name>", "Country key selecting config/<country>.yaml documentation classifiers (overrides OPENLDR_COUNTRY)")
    .option("--forms-data-feed-name <name>", "OpenLDR data feed name for the forms (non-test) feed")
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
    .option(
      "--poc-format <fmt>",
      "How v1 stores LIMSPointOfCareDesc: facility_ward (Tanzania default; facility~ward) or district_facility_ward (Mozambique; district~facility~ward, frequently truncated at 50 chars). Overrides OPENLDR_V1_POC_FORMAT.",
    )
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
      const pocFormat = resolvePocFormat(opts.pocFormat, config.openldrV1PocFormat);
      const doQuarantine = opts.quarantine !== false;
      const quarantineDir = doQuarantine ? resolve(opts.quarantineDir ?? "./temp/quarantine") : null;
      const quarantineThresholdRaw = (opts.quarantineSeverity ?? "error").toLowerCase();
      if (quarantineThresholdRaw !== "error" && quarantineThresholdRaw !== "warn" && quarantineThresholdRaw !== "info") {
        throw new CliError("USAGE", `--quarantine-severity must be error, warn, or info.`);
      }
      const quarantineThreshold = quarantineThresholdRaw as Severity;

      const ceUrl = opts.ceUrl ?? config.openldrCeUrl;
      assertCeGatesEnabled({ ceUrl, doCheck, doQuarantine });
      const ceTz = requireCeTimezone(ceUrl, opts.ceTz ?? config.openldrCeTimezone);

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
          target: ceUrl !== undefined && ceUrl.length > 0
            ? { kind: "ce", hook_path: opts.ceHookPath ?? config.openldrCeHookPath, tz: ceTz }
            : { kind: "v2" },
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
      let formsPosted = 0;
      let split = 0;
      let currentLab: string | null = null;

      const makeSummary = (): BatchSummary => {
        const elapsed = Date.now() - start;
        return {
          _meta: "export-batch-summary",
          labs_attempted: attempted,
          posted, deduplicated, quarantined, check_failed: checkFailed,
          not_found: notFound, errored,
          forms_posted: formsPosted, split,
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

      // Country documentation classifiers, loaded once. Drives the
      // documentation-vs-test split for every lab: which observations are
      // excluded from the lab payload and routed to the forms feed instead.
      const docConfig = loadCountryDocConfig(opts.country ?? config.country);

      // Skip v2 POST config resolution entirely when we won't POST via v2
      // anyway: --dry-run runs the gates without sending, --emit-payloads
      // writes payloads to stdout (intended to pipe into `openldr ingest
      // stream`), and a CE target replaces the v2 lab+forms POST outright
      // (see the CE branch in processOneLab) — none of these need the v2
      // URL + token, so resolvePostConfig's v2-specific requirements
      // (OPENLDR_V2_URL, a token source, X-DataFeed-Id) must not gate a
      // CE-only deployment that has no v2 config at all.
      const targetsCe = ceUrl !== undefined && ceUrl.length > 0;
      const skipPostConfig = opts.dryRun === true || opts.emitPayloads === true || targetsCe;
      const postConfig: PostConfig = skipPostConfig
        ? {
            baseUrl: "",
            path: "",
            getToken: async (): Promise<string> => "",
            tokenSource: "env",
            dataFeedId: undefined,
            dataFeedSource: "none",
            formsDataFeedId: undefined,
            force: false,
            track: false,
            trackTimeoutMs: undefined,
            trackIntervalMs: undefined,
          }
        : await resolvePostConfig(opts, config);

      // -------- CE target config --------
      // Presence of ceUrl selects the CE target; assertCeGatesEnabled /
      // requireCeTimezone already validated this above, before any DISA
      // query ran.
      const ceConfig = targetsCe
        ? {
            baseUrl: ceUrl!,
            path: opts.ceHookPath ?? config.openldrCeHookPath,
            token: opts.ceToken ?? config.openldrCeWebhookToken ?? "",
            tzOffset: ceTz!,
          }
        : undefined;
      if (ceConfig !== undefined && ceConfig.token.length === 0) {
        throw new CliError(
          "CONFIG_MISSING",
          "A CE webhook token is required. Set OPENLDR_CE_WEBHOOK_TOKEN or pass --ce-token.",
        );
      }

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

      // One WARDDICT resolver per run: caches (LOCATION, WARD) → description
      // across the entire batch, so the dictionary is queried at most once
      // per unique pair regardless of concurrency or lab count.
      const wardResolver = new WardDictResolver();

      const ctx: ProcessLabContext = {
        config,
        codebook,
        docConfig,
        prefix,
        postConfig,
        ceConfig,
        doCheck,
        doQuarantine,
        quarantineDir,
        quarantineThreshold,
        openldrCs,
        pocFormat,
        dryRun: opts.dryRun === true,
        emitPayloads: opts.emitPayloads === true,
        writePayload: opts.emitPayloads === true ? writeOut : undefined,
        wardResolver,
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
        if (r.forms_http_status !== undefined && r.forms_http_status >= 200 && r.forms_http_status < 300) {
          formsPosted++;
        }
        if (r.routing === "split") split++;
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

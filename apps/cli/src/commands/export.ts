import type { Command } from "commander";
import { Option } from "commander";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AUDTDATA, REGDAT4, SpecimenRecpt } from "disalab";
import type { DisaServer } from "disalab";
import { CliError } from "../errors.js";
import { closePool } from "../db.js";
import { fetchLabResultsByRequestId, fetchRequestByRequestId } from "../openldr.js";
import { normalizeLabNumber } from "../compare/lab-number.js";
import { diffRecord, isPerfectMatch } from "../compare/diff.js";
import { resolvePocFormat } from "../compare/mapping.js";
import { diffResults, isResultPerfectMatch } from "../compare/result-diff.js";
import { loadRuntime } from "./context.js";
import { loadCodebook } from "../export/codebook.js";
import { DEFAULT_SITE } from "../export/site-config.js";
import { toV2 } from "../export/v2-transform.js";
import { toV1 } from "../export/v1-transform.js";
import { auditFromSpecimen } from "../audit/detector.js";
import { severityAtLeast, type Severity } from "../audit/types.js";
import { postLabRequest } from "../api/client.js";
import { fetchKeycloakToken } from "../api/keycloak.js";
import { resolveDataFeedId } from "../api/feed-discovery.js";
import { trackRun } from "../api/run-tracker.js";

interface ExportOpts {
  type?: "v1" | "v2";
  check?: boolean;
  openldrCs?: string;
  prefix?: string;
  out?: string;
  post?: boolean;
  targetApi?: string;
  token?: string;
  apiPath?: string;
  dryRunPost?: boolean;
  dataFeedId?: string;
  projectName?: string;
  useCaseName?: string;
  dataFeedName?: string;
  track?: boolean;
  trackTimeout?: string;
  trackInterval?: string;
  insecureTls?: boolean;
  force?: boolean;
  /** `--no-data-quality` arrives here as `false`. Default behaviour (no
   *  flag set) is to include the audit annotation when anomalies exist. */
  dataQuality?: boolean;
  quarantineOnAnomaly?: string;
  quarantineSeverity?: string;
  pocFormat?: string;
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_QUERY_FAILED", `DISA query failed: ${message}`);
  } finally {
    await closePool();
  }
}

export function registerExportCommand(program: Command): void {
  program
    .command("export <labNumber>")
    .description(
      "Transform a single DISA specimen into an OpenLDR JSON payload. v2 by default; --type v1 reserved (not yet implemented).",
    )
    .addOption(
      new Option("--type <fmt>", "target schema").choices(["v1", "v2"]).default("v2"),
    )
    .option(
      "--check",
      "before emitting, run `compare` + `compare-results` against OpenLDR v1 and refuse to emit if any field/observation does not perfectly match",
    )
    .option("--openldr-cs <url>", "OpenLDR v1 connection string (only used by --check)")
    .option("--prefix <str>", "Override the OpenLDR labno prefix for this invocation")
    .option(
      "--out <path>",
      "Write the payload to this file instead of stdout (creates parent dirs). Format still controlled by global --output flag (ndjson|json|pretty).",
    )
    .option("--post", "POST the payload to the OpenLDR v2 API after building it (v2 only). Reports the API response on stdout. Use --out to also save the payload locally.")
    .option("--target-api <url>", "OpenLDR v2 base URL (overrides OPENLDR_V2_URL env)")
    .option("--token <bearer>", "Bearer token for the v2 API (overrides OPENLDR_V2_TOKEN env)")
    .option("--api-path <path>", "Endpoint path appended to the base URL (default /api/v2/lab-requests)")
    .option("--dry-run-post", "With --post: print the prepared HTTP request (URL, headers redacted, payload size) and exit without sending. Use to verify wiring before pointing at a live API.")
    .option("--data-feed-id <uuid>", "Pre-resolved X-DataFeed-Id (skips discovery). Overrides OPENLDR_DATA_FEED_ID env.")
    .option("--project-name <name>", "OpenLDR project for X-DataFeed-Id discovery (overrides OPENLDR_PROJECT_NAME).")
    .option("--use-case-name <name>", "OpenLDR use case for X-DataFeed-Id discovery (overrides OPENLDR_USE_CASE_NAME).")
    .option("--data-feed-name <name>", "OpenLDR data feed for X-DataFeed-Id discovery (overrides OPENLDR_DATA_FEED_NAME).")
    .option("--track", "After --post succeeds, poll /api/v1/runs/{messageId} until the pipeline reaches a terminal state (completed/failed). Surfaces downstream stage failures that the ingest endpoint's 200 hides.")
    .option("--track-timeout <ms>", "Total budget for --track polling. Default 60000.")
    .option("--track-interval <ms>", "Delay between polls. Default 1000.")
    .option("--insecure-tls", "Skip TLS cert verification for v2 + Keycloak fetches. Self-signed local dev only — process-wide for the run. Equivalent to OPENLDR_V2_INSECURE_TLS=true.")
    .option("--force", "Append `?force=true` to the POST URL so the v2 API re-processes even if the payload was already ingested. Without this, identical re-POSTs return HTTP 200 with `deduplicated: true` and the original messageId.")
    .option("--no-data-quality", "Suppress the data_quality audit-annotation block from v2 payloads. Default: include it when anomalies are detected.")
    .option("--quarantine-on-anomaly <path>", "When the audit finds anomalies at or above --quarantine-severity, write the payload + audit report to <path>/<labNumber>.json instead of POSTing. v2 + --post only.")
    .option("--quarantine-severity <level>", "Severity threshold for --quarantine-on-anomaly: error (default), warn, or info.")
    .option(
      "--poc-format <fmt>",
      "How v1 stores LIMSPointOfCareDesc: facility_ward (Tanzania default; facility~ward) or district_facility_ward (Mozambique; district~facility~ward, frequently truncated at 50 chars). Overrides OPENLDR_V1_POC_FORMAT. Only used with --check.",
    )
    .action(async (labNumberArg: string, opts: ExportOpts, cmd: Command) => {
      const { config, output } = loadRuntime(cmd, { requireConnection: false });
      const prefix = opts.prefix ?? config.openldrLabnoPrefix;
      const norm = normalizeLabNumber(labNumberArg, prefix);
      const targetType = opts.type ?? "v2";

      if (config.connectionString.length === 0) {
        throw new CliError(
          "CONFIG_MISSING",
          "DISA_CONNECTION_STRING not configured. Set it in env, .env, or pass --connection-string.",
        );
      }

      const disa = await fetchDisaSpecimen(norm.disaLabNo, config.connectionString);
      if (disa === null) {
        throw new CliError("GET_NO_ROWS", `DISA specimen not found: ${norm.disaLabNo}`, {
          lab_number: norm.disaLabNo,
        });
      }

      // --check: run the existing Phase 1+2 fidelity comparators against v1 and
      // refuse to emit anything if either side disagrees. Per locked decision #3.
      if (opts.check === true) {
        const openldrCs = opts.openldrCs ?? config.openldrConnectionString;
        if (openldrCs === undefined || openldrCs.length === 0) {
          throw new CliError(
            "OPENLDR_CONFIG_MISSING",
            "Set OPENLDR_V1_CONNECTION_STRING in env / .env, or pass --openldr-cs (required by --check).",
          );
        }

        const v1Request = await fetchRequestByRequestId(
          norm.openldrRequestId,
          openldrCs,
          config.openldrDataDatabase,
        );
        if (v1Request === null) {
          throw new CliError(
            "GET_NO_ROWS",
            `--check requested but OpenLDR v1 has no Requests row for ${norm.openldrRequestId}`,
            { lab_number: norm.disaLabNo, openldr_request_id: norm.openldrRequestId },
          );
        }

        const v1Rows = await fetchLabResultsByRequestId(
          norm.openldrRequestId,
          openldrCs,
          config.openldrDataDatabase,
        );

        const pocFormat = resolvePocFormat(opts.pocFormat, config.openldrV1PocFormat);
        const requestDiff = diffRecord(disa, v1Request, { pocFormat });
        if (!isPerfectMatch(requestDiff.summary)) {
          throw new CliError(
            "MISMATCH",
            "request-level fidelity check failed; refusing to emit",
            {
              lab_number: norm.disaLabNo,
              openldr_request_id: norm.openldrRequestId,
              stage: "request",
              summary: requestDiff.summary,
              non_matching_fields: requestDiff.fields
                .filter((f) => f.status !== "match")
                .map((f) => ({ field: f.field, status: f.status })),
            },
          );
        }

        const resultDiff = diffResults(disa, v1Rows, {});
        if (!isResultPerfectMatch(resultDiff.summary)) {
          throw new CliError(
            "MISMATCH",
            "per-observation fidelity check failed; refusing to emit",
            {
              lab_number: norm.disaLabNo,
              openldr_request_id: norm.openldrRequestId,
              stage: "results",
              summary: resultDiff.summary,
            },
          );
        }
      }

      // Codebook query reuses the global mssql pool — make sure prior fetches
      // closed it (fetchDisaSpecimen / fetch* helpers all close in finally).
      const server = buildServer(config.connectionString);
      const codebook = await loadCodebook(server);
      await closePool();

      // v1 needs the audit trail (RegisteredBy/TestedBy/AuthorisedBy +
      // Registered/Analysis/Authorised dates all live in AUDTDATA, not on
      // SpecimenRecpt). Fetch it only when emitting v1.
      let auditRows: AUDTDATA[] = [];
      if (targetType === "v1") {
        try {
          const escaped = norm.disaLabNo.replace(/'/g, "''");
          auditRows = await AUDTDATA.All(`WHERE [LABNO]='${escaped}'`, server);
        } finally {
          await closePool();
        }
      }

      // Quarantine + data_quality apply only to v2 payloads. Reject the
      // flag combo early so users learn about the constraint before we
      // start building anything heavy.
      if (opts.quarantineOnAnomaly !== undefined && targetType !== "v2") {
        throw new CliError(
          "NOT_SUPPORTED",
          "--quarantine-on-anomaly only works with --type v2.",
          { type: targetType },
        );
      }

      // Audit when we either need to emit a data_quality block (default
      // ON for v2 unless --no-data-quality) or we need to evaluate the
      // quarantine threshold. Skip entirely for v1 — phasing-out target.
      const dataQualityEnabled = opts.dataQuality !== false; // commander sets to false on --no-*
      const wantAudit =
        targetType === "v2" &&
        (dataQualityEnabled || opts.quarantineOnAnomaly !== undefined);
      const auditReport = wantAudit ? auditFromSpecimen(disa, prefix, codebook) : null;

      const payload = targetType === "v1"
        ? toV1(disa, { prefix, codebook, auditRows })
        : toV2(disa, {
            prefix,
            site: DEFAULT_SITE,
            codebook,
            // Respect --no-data-quality independently of quarantine: we
            // may still need the audit for quarantine but not annotate
            // the outgoing payload.
            auditReport: dataQualityEnabled ? auditReport : null,
          });

      // Quarantine: if the audit report's max severity meets the threshold,
      // write the payload + report to disk and exit non-zero. Sits before
      // --out / --post so quarantined labs don't accidentally get sent.
      if (
        opts.quarantineOnAnomaly !== undefined &&
        auditReport !== null &&
        auditReport.max_severity !== null
      ) {
        const thresholdRaw = (opts.quarantineSeverity ?? "error").toLowerCase();
        if (thresholdRaw !== "error" && thresholdRaw !== "warn" && thresholdRaw !== "info") {
          throw new CliError(
            "USAGE",
            `--quarantine-severity must be "error", "warn", or "info" (got "${opts.quarantineSeverity}").`,
          );
        }
        const threshold = thresholdRaw as Severity;
        if (severityAtLeast(auditReport.max_severity, threshold)) {
          const target = resolve(opts.quarantineOnAnomaly, `${norm.disaLabNo}.json`);
          mkdirSync(dirname(target), { recursive: true });
          writeFileSync(
            target,
            JSON.stringify(
              {
                lab_number: norm.disaLabNo,
                request_id: norm.openldrRequestId,
                quarantined_at: new Date().toISOString(),
                threshold,
                audit_report: auditReport,
                payload,
              },
              null,
              2,
            ) + "\n",
          );
          throw new CliError(
            "QUARANTINED",
            `Lab ${norm.disaLabNo} has ${auditReport.anomalies.length} anomalies (max severity: ${auditReport.max_severity}); skipped POST and wrote ${target}.`,
            {
              lab_number: norm.disaLabNo,
              quarantine_path: target,
              max_severity: auditReport.max_severity,
              anomaly_count: auditReport.anomalies.length,
              threshold,
            },
          );
        }
      }

      let serialised: string;
      if (output.format === "pretty") {
        const { inspect } = await import("node:util");
        // No ANSI colors when writing to a file, regardless of TTY state.
        const useColor = opts.out === undefined && output.color && opts.post !== true;
        serialised = inspect(payload, { colors: useColor, depth: 8 });
      } else if (output.format === "json") {
        serialised = JSON.stringify(payload, null, 2);
      } else {
        serialised = JSON.stringify(payload);
      }

      // File side: write whenever --out is given, regardless of --post.
      if (opts.out !== undefined) {
        const target = resolve(opts.out);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, serialised + "\n");
      }

      // POST side: only when --post is set. v1 doesn't have a target API.
      if (opts.post === true) {
        if (targetType !== "v2") {
          throw new CliError(
            "NOT_SUPPORTED",
            "--post only works with --type v2 (v1 has no target API).",
            { type: targetType },
          );
        }

        // Self-signed local-dev escape hatch. Process-wide for the rest of
        // the invocation, but the only outbound HTTPS calls in --post are
        // to the v2 API + Keycloak (same instance), so the blast radius is
        // exactly what the operator intended.
        if (opts.insecureTls === true || config.openldrV2InsecureTls) {
          process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
        }

        const baseUrl = opts.targetApi ?? config.openldrV2Url;
        let path = opts.apiPath ?? config.openldrV2Path;

        if (baseUrl === undefined || baseUrl.length === 0) {
          throw new CliError(
            "API_CONFIG_MISSING",
            "OpenLDR v2 URL not configured. Set OPENLDR_V2_URL in env / .env, or pass --target-api.",
          );
        }

        // Token precedence: --token flag > Keycloak (if all four KC vars set)
        // > static OPENLDR_V2_TOKEN. Keycloak beats the static token because
        // operators who configured Keycloak likely want short-lived dynamic
        // creds; --token always wins for ad-hoc overrides.
        let token: string | undefined = opts.token;
        let tokenSource = "flag";
        if (token === undefined || token.length === 0) {
          if (
            config.keycloakUrl !== undefined && config.keycloakUrl.length > 0 &&
            config.keycloakRealm !== undefined && config.keycloakRealm.length > 0 &&
            config.keycloakClientId !== undefined && config.keycloakClientId.length > 0 &&
            config.keycloakClientSecret !== undefined && config.keycloakClientSecret.length > 0
          ) {
            token = await fetchKeycloakToken({
              baseUrl: config.keycloakUrl,
              realm: config.keycloakRealm,
              clientId: config.keycloakClientId,
              clientSecret: config.keycloakClientSecret,
            });
            tokenSource = "keycloak";
          } else if (config.openldrV2Token !== undefined && config.openldrV2Token.length > 0) {
            token = config.openldrV2Token;
            tokenSource = "env";
          }
        }
        if (token === undefined || token.length === 0) {
          throw new CliError(
            "API_CONFIG_MISSING",
            "OpenLDR v2 token not configured. Set OPENLDR_V2_TOKEN, configure KEYCLOAK_* vars for dynamic minting, or pass --token.",
          );
        }

        // X-DataFeed-Id resolution: explicit ID wins, else discover from
        // (project, useCase, dataFeed) names. Skipped silently if no
        // discovery config is present — some deployments may not require it.
        let dataFeedId: string | undefined = opts.dataFeedId ?? config.openldrDataFeedId;
        let dataFeedSource = dataFeedId !== undefined ? "explicit" : "none";
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
              token,
              projectName,
              useCaseName,
              dataFeedName,
            });
            dataFeedSource = "discovered";
          }
        }

        const extraHeaders: Record<string, string> = {};
        if (dataFeedId !== undefined) extraHeaders["X-DataFeed-Id"] = dataFeedId;

        let fullUrl = baseUrl.replace(/\/+$/, "") + (path.startsWith("/") ? path : `/${path}`);
        if (opts.force === true) {
          fullUrl += (fullUrl.includes("?") ? "&" : "?") + "force=true";
          path = path + (path.includes("?") ? "&" : "?") + "force=true";
        }

        if (opts.dryRunPost === true) {
          // Preview: show what would be sent without hitting the wire.
          process.stdout.write(JSON.stringify({
            dry_run: true,
            method: "POST",
            url: fullUrl,
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${"*".repeat(Math.min(token.length, 8))}…`,
              "Accept": "application/json",
              ...extraHeaders,
            },
            token_source: tokenSource,
            data_feed_id: dataFeedId ?? null,
            data_feed_source: dataFeedSource,
            payload_bytes: Buffer.byteLength(JSON.stringify(payload), "utf8"),
            request_id: targetType === "v2" ? (payload as { lab_request: { request_id: string } }).lab_request.request_id : null,
          }, null, 2) + "\n");
          return;
        }

        const result = await postLabRequest(payload, { baseUrl, token, path, extraHeaders });

        // The ingest endpoint returns 200 as soon as the message lands on
        // Kafka — downstream stages (validation/mapping/storage/outpost)
        // run async and can still fail. --track polls /runs/{messageId}
        // until terminal so the operator sees the real outcome.
        let tracking: { run: unknown; events: unknown[]; attempts: number; duration_ms: number; timed_out: boolean } | null = null;
        if (opts.track === true) {
          const messageId = (result.body as { messageId?: string })?.messageId;
          if (typeof messageId === "string" && messageId.length > 0) {
            const trackTimeout = opts.trackTimeout !== undefined ? Number(opts.trackTimeout) : undefined;
            const trackInterval = opts.trackInterval !== undefined ? Number(opts.trackInterval) : undefined;
            const tr = await trackRun({
              baseUrl,
              token,
              messageId,
              ...(trackTimeout !== undefined && Number.isFinite(trackTimeout) ? { timeoutMs: trackTimeout } : {}),
              ...(trackInterval !== undefined && Number.isFinite(trackInterval) ? { intervalMs: trackInterval } : {}),
            });
            tracking = {
              run: tr.run,
              events: tr.events,
              attempts: tr.attempts,
              duration_ms: tr.durationMs,
              timed_out: tr.timedOut,
            };
          }
        }

        const ingestRequestId = (payload as { lab_request: { request_id: string } }).lab_request.request_id;
        process.stdout.write(JSON.stringify({
          posted: true,
          request_id: ingestRequestId,
          status: result.status,
          attempts: result.attempts,
          duration_ms: result.durationMs,
          token_source: tokenSource,
          data_feed_id: dataFeedId ?? null,
          data_feed_source: dataFeedSource,
          response: result.body,
          ...(tracking !== null ? { tracking } : {}),
        }, null, 2) + "\n");

        // Non-zero exit when downstream pipeline failed, even though POST succeeded.
        if (tracking !== null) {
          const status = (tracking.run as { currentStatus?: string })?.currentStatus;
          if (typeof status === "string" && status.toLowerCase() !== "completed") {
            throw new CliError(
              "API_REJECTED",
              `Pipeline run did not complete: currentStatus=${status}`,
              {
                messageId: (result.body as { messageId?: string })?.messageId ?? null,
                run: tracking.run,
                timed_out: tracking.timed_out,
              },
            );
          }
        }
        return;
      }

      // No --post: emit payload to stdout (unless --out already wrote it).
      if (opts.out === undefined) {
        process.stdout.write(serialised + "\n");
      }
    });
}

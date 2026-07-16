import { CliError } from "../errors.js";

// Built on Node 20+'s built-in fetch, mirroring client.ts's retry policy
// (4xx except 429 -> API_REJECTED; 429 -> honour Retry-After; 5xx + network
// -> exponential backoff up to N attempts -> API_UNAVAILABLE). POSTs FHIR
// resources into an OpenLDR CE workflow webhook rather than the v2 API.
//
// Three CE-specific gotchas baked into this client, each verified against
// openldr_ce (reference only — that repo is not modified here):
//
//   1. Auth is the `x-webhook-token` header ONLY. No Bearer, no query
//      token; the route constant-time-compares it and fails closed if no
//      secret is configured server-side.
//      (openldr_ce apps/server/src/workflows-routes.ts:411-413)
//
//   2. Content-Type MUST be exactly "application/json". If it isn't, and
//      the body looks like a Buffer/stream, the route diverts the body to
//      blob storage and sets webhookBody = undefined — the payload
//      vanishes silently, no error surfaced to the caller.
//      (openldr_ce apps/server/src/workflows-routes.ts:417-424)
//
//   3. The body must be a BARE JSON ARRAY of FHIR resources, not an
//      object wrapping the array. The workflow is
//      webhook -> split-out(field: "body") -> persist-store, and
//      splitOutHandler does a flat key lookup `item.json[field]`
//      (not a path expression), so `{ resources: [...] }` would pass
//      through unexploded and fail validation downstream.
//      (openldr_ce packages/workflows/src/engine/node-handlers/split-out.ts:9)

export interface CePostOptions {
  /** Base URL — e.g. "https://ce.openldr.example.com". Trailing slash trimmed. */
  baseUrl: string;
  /** Path appended to baseUrl — e.g. "/api/workflows/hooks/cdr-ingest". */
  path: string;
  /** Secret sent as the `x-webhook-token` header. */
  token: string;
  /** Max attempts for transient (5xx + network) failures. Default 5. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** fetch implementation override for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export interface CePostResult {
  status: number;
  body: unknown;
  attempts: number;
  durationMs: number;
}

const DEFAULT_RETRIES = 5;
const DEFAULT_TIMEOUT_MS = 30_000;

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Sleep without a `sleep` lib — keeps the dep tree clean. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/** Pull a human-readable reason out of a CE 4xx response body. CE's webhook
 *  route returns plain-text errors (e.g. "invalid webhook token") as often
 *  as JSON, so fall back to the raw text rather than assuming a shape. */
function extractRejectionReason(body: unknown): string {
  if (typeof body === "string") return body.trim().replace(/\s+/g, " ").slice(0, 300);
  if (body === null || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  const scalar = [b.error, b.message, b.detail]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(": ");
  return scalar.length > 0 ? scalar.replace(/\s+/g, " ").slice(0, 300) : "";
}

function rejectionMessage(status: number, body: unknown): string {
  const base = `OpenLDR CE rejected the payload (HTTP ${status})`;
  const reason = extractRejectionReason(body);
  return reason.length > 0 ? `${base}: ${reason}` : base;
}

/** Backoff schedule: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped) — same policy as client.ts. */
function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** (attempt - 1);
  return Math.min(base, 60_000);
}

/**
 * POST FHIR resources to an OpenLDR CE workflow webhook as a bare JSON
 * array. Returns the parsed response on 2xx. Throws `CliError("API_REJECTED")`
 * on 4xx (excluding 429), and `CliError("API_UNAVAILABLE")` on 5xx / network
 * errors after retries. 429 is honoured transparently via Retry-After.
 */
export async function postFhirResources(
  resources: unknown[],
  opts: CePostOptions,
): Promise<CePostResult> {
  const url = joinUrl(opts.baseUrl, opts.path);
  const maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchImpl ?? fetch;
  const startedAt = Date.now();

  let attempt = 0;
  let lastTransientError: unknown = null;

  while (attempt < maxRetries) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "x-webhook-token": opts.token,
        },
        body: JSON.stringify(resources),
        signal: controller.signal,
      });
      clearTimeout(timer);

      // 2xx — done.
      if (res.status >= 200 && res.status < 300) {
        const body = await readJsonBody(res);
        return { status: res.status, body, attempts: attempt, durationMs: Date.now() - startedAt };
      }

      // 429 — honour Retry-After then loop without consuming an attempt.
      if (res.status === 429) {
        const ra = res.headers.get("retry-after");
        const waitMs = ra !== null && /^\d+$/.test(ra) ? Number(ra) * 1000 : backoffMs(attempt);
        attempt -= 1; // rate-limiting is not a transient error budget hit
        await sleep(waitMs);
        continue;
      }

      // 4xx (other) — payload/auth rejection. Don't retry; surface to caller.
      if (res.status >= 400 && res.status < 500) {
        const body = await readJsonBody(res);
        throw new CliError("API_REJECTED", rejectionMessage(res.status, body), {
          url,
          status: res.status,
          body,
          attempts: attempt,
        });
      }

      // 5xx — transient. Retry with backoff.
      lastTransientError = { status: res.status, body: await readJsonBody(res) };
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof CliError) throw err; // 4xx CliError bubbles up immediately
      lastTransientError = { error: err instanceof Error ? err.message : String(err) };
    }

    if (attempt >= maxRetries) break;
    await sleep(backoffMs(attempt));
  }

  throw new CliError(
    "API_UNAVAILABLE",
    `OpenLDR CE unreachable or 5xx after ${attempt} attempts`,
    { url, attempts: attempt, last: lastTransientError, durationMs: Date.now() - startedAt },
  );
}

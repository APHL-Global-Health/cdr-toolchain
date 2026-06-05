import { CliError } from "../errors.js";

// Built on Node 20+'s built-in fetch — no extra HTTP dependency. The retry
// policy follows PRD §9: 4xx (except 429) → API_REJECTED (caller decides
// whether to quarantine in batch flows or just report); 429 → honour
// Retry-After; 5xx + network errors → exponential backoff up to N attempts
// then API_UNAVAILABLE (caller decides whether to pause the migration).

export interface PostOptions {
  /** Base URL — e.g. "https://v2.openldr.example.com". Trailing slash trimmed. */
  baseUrl: string;
  /** Path appended to baseUrl — e.g. "/api/v2/lab-requests". */
  path: string;
  /** Bearer token for Authorization header. */
  token: string;
  /** Max attempts for transient (5xx + network) failures. Default 5. */
  maxRetries?: number;
  /** Per-request timeout in ms. Default 30s. */
  timeoutMs?: number;
  /** Extra headers merged onto the request (e.g. X-DataFeed-Id). */
  extraHeaders?: Record<string, string>;
}

export interface PostResult {
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

/** Sleep without `sleep` lib — keeps the dep tree clean. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Pull a human-readable reason out of a v2 4xx response body so the
 * API_REJECTED message says WHY, not just "HTTP 400". v2 bodies are usually
 * `{ error, message? }`; validation failures may use `{ errors: [...] }`; a
 * proxy may hand back a plain string. Returns "" when nothing useful is found.
 */
function extractRejectionReason(body: unknown): string {
  if (typeof body === "string") return body.trim().replace(/\s+/g, " ").slice(0, 300);
  if (body === null || typeof body !== "object") return "";
  const b = body as Record<string, unknown>;
  const scalar = [b.error, b.message, b.detail]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .join(": ");
  if (scalar.length > 0) return scalar.replace(/\s+/g, " ").slice(0, 300);
  if (Array.isArray(b.errors)) {
    const joined = b.errors
      .map((e) => (typeof e === "string" ? e : (e !== null && typeof e === "object" ? (e as Record<string, unknown>).message : undefined)))
      .filter((s): s is string => typeof s === "string" && s.length > 0)
      .join("; ");
    if (joined.length > 0) return joined.replace(/\s+/g, " ").slice(0, 300);
  }
  return "";
}

/**
 * Build the API_REJECTED message: base + server reason + an actionable hint
 * for the common-but-opaque "missing X-DataFeed-Id" case (caused by blank
 * OPENLDR_*_NAME env vars, which silently skip feed discovery upstream).
 */
function rejectionMessage(status: number, body: unknown): string {
  const base = `OpenLDR v2 rejected the payload (HTTP ${status})`;
  const reason = extractRejectionReason(body);
  const haystack = `${reason} ${typeof body === "string" ? body : JSON.stringify(body ?? "")}`;
  const hint = /datafeed-?id/i.test(haystack)
    ? ' — no X-DataFeed-Id was sent; set OPENLDR_PROJECT_NAME, OPENLDR_USE_CASE_NAME and OPENLDR_DATA_FEED_NAME in .env (all "Built-in" on the default deployment), or pass --data-feed-id'
    : "";
  return reason.length > 0 ? `${base}: ${reason}${hint}` : `${base}${hint}`;
}

/** Backoff schedule per PRD §9: 1s, 2s, 4s, 8s, 16s, 32s, 60s (capped). */
function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** (attempt - 1);
  return Math.min(base, 60_000);
}

/**
 * POST a payload to the v2 API. Returns the parsed response on 2xx.
 * Throws `CliError("API_REJECTED")` on 4xx (excluding 429), and
 * `CliError("API_UNAVAILABLE")` on 5xx / network errors after retries.
 * 429 is honoured transparently via Retry-After.
 */
export async function postLabRequest(payload: unknown, opts: PostOptions): Promise<PostResult> {
  const url = joinUrl(opts.baseUrl, opts.path);
  const maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const startedAt = Date.now();

  let attempt = 0;
  let lastTransientError: unknown = null;

  while (attempt < maxRetries) {
    attempt += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${opts.token}`,
          "Accept": "application/json",
          ...(opts.extraHeaders ?? {}),
        },
        body: JSON.stringify(payload),
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

      // 4xx (other) — payload rejection. Don't retry; surface to caller.
      // The message carries the server's own reason (+ a config hint for the
      // opaque missing-X-DataFeed-Id case) so the caller isn't left guessing.
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
    `OpenLDR v2 unreachable or 5xx after ${attempt} attempts`,
    { url, attempts: attempt, last: lastTransientError, durationMs: Date.now() - startedAt },
  );
}

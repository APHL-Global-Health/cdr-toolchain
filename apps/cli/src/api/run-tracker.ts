import { CliError } from "../errors.js";

// Polls /api/v1/runs/{messageId} until the run reaches a terminal state.
// The pipeline is async (Kafka-driven): the POST returns 200 once the
// message is accepted, but downstream stages (validation → mapping →
// storage → outpost) run after that. `--track` lets a caller wait and
// surface the actual outcome.

export type RunStatus = "queued" | "processing" | "completed" | "failed" | string;

export interface RunSnapshot {
  id: string;
  messageId: string;
  currentStage: string | null;
  currentStatus: RunStatus;
  errorStage: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorDetails: unknown;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

export interface RunEvent {
  stage: string;
  status: string;
  eventType: string;
  pluginName: string | null;
  pluginVersion: string | null;
  firstAt: string;
  lastAt: string;
}

export interface TrackResult {
  run: RunSnapshot;
  events: RunEvent[];
  attempts: number;
  durationMs: number;
  /** True when the poll loop hit timeoutMs before the run reached a terminal state. */
  timedOut: boolean;
}

export interface TrackOptions {
  baseUrl: string;
  token: string;
  messageId: string;
  /** Total wall-clock budget. Default 60s. */
  timeoutMs?: number;
  /** Delay between polls. Default 1s. */
  intervalMs?: number;
  /** Per-request timeout. Default 10s. */
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_INTERVAL_MS = 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

const FAILURE_STATUSES = new Set(["failed", "error", "rejected", "dlq"]);
// v2's final pipeline stage. The run record's currentStatus flips to
// "completed" after EVERY stage finishes (validation, mapping, storage,
// outpost), not just at end-of-pipeline. Polling that exits on the first
// "completed" misses downstream failures: a run that completed validation
// but later fails at storage would be mis-reported as a successful POST.
// Only treat "completed" as truly terminal when currentStage is the
// final one.
const FINAL_STAGE = "outpost";

function isTerminal(run: RunSnapshot): boolean {
  const status = run.currentStatus.toLowerCase();
  if (FAILURE_STATUSES.has(status)) return true;
  if (status === "completed") {
    return (run.currentStage ?? "").toLowerCase() === FINAL_STAGE;
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

async function fetchRun(opts: TrackOptions): Promise<{ run: RunSnapshot; events: RunEvent[] } | null> {
  const url = `${opts.baseUrl.replace(/\/+$/, "")}/api/v1/runs/${encodeURIComponent(opts.messageId)}`;
  const controller = new AbortController();
  const requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const timer = setTimeout(() => { controller.abort(); }, requestTimeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${opts.token}`,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new CliError(
      "API_UNAVAILABLE",
      `Run-tracking endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      { url },
    );
  }
  clearTimeout(timer);

  // Brief window after POST where the run row may not yet exist — caller treats null as "keep polling".
  if (res.status === 404) return null;

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CliError(
      "API_REJECTED",
      `Run-tracking endpoint returned HTTP ${res.status}`,
      { url, status: res.status, body: parsed },
    );
  }

  if (parsed === null || typeof parsed !== "object") {
    throw new CliError("API_REJECTED", "Run-tracking response was not an object", { url, body: parsed });
  }
  const obj = parsed as { run?: RunSnapshot; events?: RunEvent[] };
  if (obj.run === undefined) {
    throw new CliError("API_REJECTED", "Run-tracking response missing `run` field", { url, body: parsed });
  }
  return { run: obj.run, events: obj.events ?? [] };
}

export async function trackRun(opts: TrackOptions): Promise<TrackResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const startedAt = Date.now();
  let attempts = 0;
  let last: { run: RunSnapshot; events: RunEvent[] } | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    attempts += 1;
    const snapshot = await fetchRun(opts);
    if (snapshot !== null) {
      last = snapshot;
      if (isTerminal(snapshot.run)) {
        return {
          run: snapshot.run,
          events: snapshot.events,
          attempts,
          durationMs: Date.now() - startedAt,
          timedOut: false,
        };
      }
    }
    if (Date.now() - startedAt + intervalMs >= timeoutMs) break;
    await sleep(intervalMs);
  }

  if (last === null) {
    throw new CliError(
      "API_UNAVAILABLE",
      `Run ${opts.messageId} never appeared after ${attempts} polls (${timeoutMs}ms budget)`,
      { messageId: opts.messageId, attempts, timeoutMs },
    );
  }

  return {
    run: last.run,
    events: last.events,
    attempts,
    durationMs: Date.now() - startedAt,
    timedOut: true,
  };
}

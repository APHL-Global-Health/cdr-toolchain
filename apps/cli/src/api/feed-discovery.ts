import { CliError } from "../errors.js";

// Resolves a human-readable (project, useCase, dataFeed) triple into the
// dataFeedId UUID required by the OpenLDR v2 API as the `X-DataFeed-Id`
// header. The header tells the data-processing service which schema /
// mapper / storage / outpost plugins to apply to the payload.
//
// Lookup chain (all GET, bearer-authed):
//   /api/v1/projects                                  → projectId by projectName
//   /api/v1/projects/{projectId}/use-cases            → useCaseId by useCaseName
//   /api/v1/projects/use-cases/{useCaseId}/feeds      → dataFeedId by dataFeedName
//
// Cached in-process for the full run — the triple is stable per deployment.

export interface FeedDiscoveryOptions {
  baseUrl: string;
  token: string;
  projectName: string;
  useCaseName: string;
  dataFeedName: string;
  timeoutMs?: number;
}

interface ProjectsResponse { projects: Array<{ projectId: string; projectName: string }>; }
interface UseCasesResponse { useCases: Array<{ useCaseId: string; useCaseName: string }>; }
interface FeedsResponse { feeds: Array<{ dataFeedId: string; dataFeedName: string }>; }

const DEFAULT_TIMEOUT_MS = 15_000;
const cache = new Map<string, string>();

function cacheKey(opts: FeedDiscoveryOptions): string {
  return `${opts.baseUrl}|${opts.projectName}|${opts.useCaseName}|${opts.dataFeedName}`;
}

async function getJson(url: string, token: string, timeoutMs: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new CliError(
      "API_UNAVAILABLE",
      `OpenLDR v2 discovery endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
      { url },
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try { parsed = JSON.parse(text); } catch { parsed = text; }
  }
  if (res.status < 200 || res.status >= 300) {
    throw new CliError(
      "API_REJECTED",
      `OpenLDR v2 discovery returned HTTP ${res.status}`,
      { url, status: res.status, body: parsed },
    );
  }
  return parsed;
}

export async function resolveDataFeedId(opts: FeedDiscoveryOptions): Promise<string> {
  const key = cacheKey(opts);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const base = opts.baseUrl.replace(/\/+$/, "");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const projects = await getJson(`${base}/api/v1/projects`, opts.token, timeoutMs) as ProjectsResponse;
  const project = projects.projects?.find((p) => p.projectName === opts.projectName);
  if (project === undefined) {
    throw new CliError(
      "API_REJECTED",
      `OpenLDR project not found: ${opts.projectName}`,
      { available: projects.projects?.map((p) => p.projectName) ?? [] },
    );
  }

  const useCases = await getJson(
    `${base}/api/v1/projects/${project.projectId}/use-cases`,
    opts.token,
    timeoutMs,
  ) as UseCasesResponse;
  const useCase = useCases.useCases?.find((u) => u.useCaseName === opts.useCaseName);
  if (useCase === undefined) {
    throw new CliError(
      "API_REJECTED",
      `OpenLDR use case not found: ${opts.useCaseName}`,
      { project: opts.projectName, available: useCases.useCases?.map((u) => u.useCaseName) ?? [] },
    );
  }

  const feeds = await getJson(
    `${base}/api/v1/projects/use-cases/${useCase.useCaseId}/feeds`,
    opts.token,
    timeoutMs,
  ) as FeedsResponse;
  const feed = feeds.feeds?.find((f) => f.dataFeedName === opts.dataFeedName);
  if (feed === undefined) {
    throw new CliError(
      "API_REJECTED",
      `OpenLDR data feed not found: ${opts.dataFeedName}`,
      { project: opts.projectName, useCase: opts.useCaseName, available: feeds.feeds?.map((f) => f.dataFeedName) ?? [] },
    );
  }

  cache.set(key, feed.dataFeedId);
  return feed.dataFeedId;
}

import { CliError } from "../errors.js";

// Mints OAuth2 access tokens from Keycloak via the client_credentials grant
// (machine-to-machine: no user, no password). The realm's token endpoint is
// {baseUrl}/realms/{realm}/protocol/openid-connect/token. Tokens are short-
// lived (Keycloak default 5 min) — we cache by client_id+realm and refresh
// 30 s before expiry so a future batch caller doesn't pay the round trip
// per-lab.

export interface KeycloakOptions {
  /** Base URL of the Keycloak instance, e.g. https://kc.example.com or .../keycloak. No trailing slash. */
  baseUrl: string;
  /** Realm the client lives in. */
  realm: string;
  /** Client ID configured for service accounts. */
  clientId: string;
  /** Client secret. */
  clientSecret: string;
  /** Per-request timeout in ms. Default 15s. */
  timeoutMs?: number;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const REFRESH_LEEWAY_MS = 30_000;

const cache = new Map<string, CachedToken>();

function cacheKey(opts: KeycloakOptions): string {
  return `${opts.baseUrl}|${opts.realm}|${opts.clientId}`;
}

function tokenEndpoint(opts: KeycloakOptions): string {
  const base = opts.baseUrl.replace(/\/+$/, "");
  return `${base}/realms/${encodeURIComponent(opts.realm)}/protocol/openid-connect/token`;
}

/**
 * Fetch an access token for the configured Keycloak client. Cached
 * in-process and reused until ~30s before its `expires_in` deadline.
 */
export async function fetchKeycloakToken(opts: KeycloakOptions): Promise<string> {
  const key = cacheKey(opts);
  const cached = cache.get(key);
  const now = Date.now();
  if (cached !== undefined && cached.expiresAt - REFRESH_LEEWAY_MS > now) {
    return cached.accessToken;
  }

  const url = tokenEndpoint(opts);
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });

  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    throw new CliError(
      "API_UNAVAILABLE",
      `Keycloak token endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`,
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
      `Keycloak rejected the token request (HTTP ${res.status})`,
      { url, status: res.status, body: parsed },
    );
  }

  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as Record<string, unknown>).access_token !== "string" ||
    typeof (parsed as Record<string, unknown>).expires_in !== "number"
  ) {
    throw new CliError(
      "API_REJECTED",
      "Keycloak returned an unexpected token response shape",
      { url, body: parsed },
    );
  }

  const tok = parsed as TokenResponse;
  const expiresAt = now + tok.expires_in * 1000;
  cache.set(key, { accessToken: tok.access_token, expiresAt });
  return tok.access_token;
}

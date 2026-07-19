import { Agent, getGlobalDispatcher, setGlobalDispatcher } from "undici";

let applied = false;

/**
 * Loosen TLS verification for self-signed local-dev targets (the `--insecure-tls`
 * flag / `OPENLDR_V2_INSECURE_TLS`).
 *
 * Why this exists: Node's built-in `fetch` (undici) captures its TLS settings when
 * its global dispatcher first initializes. Mutating `process.env.NODE_TLS_REJECT_UNAUTHORIZED`
 * at runtime — as the CLI used to — is therefore too late: undici has already built
 * its connector and keeps verifying, so the flag was a silent no-op on the CE path
 * (POSTs failed with "unreachable or 5xx" against a self-signed cert).
 *
 * The fix installs an insecure global dispatcher, which Node's built-in `fetch` reads
 * via the shared global-dispatcher symbol — so it takes effect for every subsequent
 * fetch (v2 API, OpenLDR CE webhook, Keycloak). `NODE_TLS_REJECT_UNAUTHORIZED` is also
 * still set, for any non-fetch client that uses the `node:https`/`node:tls` modules.
 *
 * Idempotent: safe to call from more than one command entry point.
 */
export function enableInsecureTls(): void {
  if (applied) return;
  applied = true;
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  setGlobalDispatcher(new Agent({ connect: { rejectUnauthorized: false } }));
}

/** Test-only: reset the one-shot guard so a test can re-exercise the install. */
export function __resetInsecureTlsForTest(): void {
  applied = false;
}

export { getGlobalDispatcher };

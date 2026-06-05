import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { EMPTY_DOC_CONFIG, type DocConfig } from "../export/non-test.js";

/**
 * Resolve the repo-root `config/` directory. Mirrors config.ts's implicit-env
 * resolution: prefer cwd/config (pnpm -C apps/cli and per-deployment layouts),
 * else module-relative (apps/cli/{src,dist}/config -> repo-root/config).
 */
export function configDir(): string {
  const cwdDir = resolve(process.cwd(), "config");
  if (existsSync(cwdDir)) return cwdDir;
  // src/config/country-config.ts OR dist/config/country-config.js -> up 4 to repo root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "config");
}

interface RawDoc {
  documentation?: {
    panels?: string[];
    params?: string[];
    forms?: Record<string, string>;
  };
}

function cleanList(xs: string[] | undefined): string[] {
  return (xs ?? []).map((s) => String(s).trim()).filter((s) => s.length > 0);
}

/**
 * Load `config/<country>.yaml` into a DocConfig. Unknown/undefined country or
 * a missing file returns EMPTY_DOC_CONFIG (heuristic-only, back-compatible).
 */
export function loadCountryDocConfig(country: string | undefined, dir: string = configDir()): DocConfig {
  if (country === undefined || country.trim().length === 0) return EMPTY_DOC_CONFIG;
  const path = resolve(dir, `${country.trim().toLowerCase()}.yaml`);
  if (!existsSync(path)) return EMPTY_DOC_CONFIG;
  const raw = parse(readFileSync(path, "utf8")) as RawDoc | null;
  const doc = raw?.documentation ?? {};
  return {
    panels: new Set(cleanList(doc.panels)),
    params: new Set(cleanList(doc.params)),
    forms: new Map(Object.entries(doc.forms ?? {})),
  };
}

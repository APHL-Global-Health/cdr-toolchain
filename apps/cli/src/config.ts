import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { z } from "zod";
import { CliError } from "./errors.js";
import { isValidFormat } from "./output.js";

export interface LoadedConfig {
  connectionString: string;
  driver: "mssql";
  outputFormat: "ndjson" | "json" | "pretty";
  openldrConnectionString?: string;
  openldrLabnoPrefix: string;
  openldrDataDatabase: string;
  openldrDictDatabase: string;
  /** OpenLDR v2 API base URL, e.g. https://v2.openldr.example.com (no trailing slash). */
  openldrV2Url?: string;
  /** Bearer token for v2 API auth. */
  openldrV2Token?: string;
  /** Path appended to openldrV2Url for the lab-request POST endpoint.
   *  Default `/api/v2/lab-requests` per PRD §9. */
  openldrV2Path: string;
  /** Keycloak base URL (no trailing slash), e.g. https://kc.example.com/keycloak. */
  keycloakUrl?: string;
  /** Keycloak realm hosting the OpenLDR client. */
  keycloakRealm?: string;
  /** Keycloak client ID for the v2 service account (client_credentials grant). */
  keycloakClientId?: string;
  /** Keycloak client secret. */
  keycloakClientSecret?: string;
  /** OpenLDR project name for X-DataFeed-Id discovery. */
  openldrProjectName?: string;
  /** OpenLDR use case name for X-DataFeed-Id discovery. */
  openldrUseCaseName?: string;
  /** OpenLDR data feed name for X-DataFeed-Id discovery. */
  openldrDataFeedName?: string;
  /** Pre-resolved X-DataFeed-Id (skips discovery if set). */
  openldrDataFeedId?: string;
  /** When true, disables TLS cert verification for v2 + Keycloak fetches.
   *  Only for self-signed local dev. Implemented by setting
   *  NODE_TLS_REJECT_UNAUTHORIZED=0 — process-wide for the CLI invocation. */
  openldrV2InsecureTls: boolean;
}

export interface ConfigOverrides {
  connectionString?: string;
  envFile?: string;
  outputFormat?: string;
  openldrConnectionString?: string;
  openldrLabnoPrefix?: string;
  openldrDataDatabase?: string;
  openldrDictDatabase?: string;
  openldrV2Url?: string;
  openldrV2Token?: string;
  openldrV2Path?: string;
  keycloakUrl?: string;
  keycloakRealm?: string;
  keycloakClientId?: string;
  keycloakClientSecret?: string;
  openldrProjectName?: string;
  openldrUseCaseName?: string;
  openldrDataFeedName?: string;
  openldrDataFeedId?: string;
  openldrV2InsecureTls?: boolean;
}

const EnvSchema = z.object({
  DISA_CONNECTION_STRING: z.string().min(1).optional(),
  DISA_OUTPUT: z.string().optional(),
  OPENLDR_V1_CONNECTION_STRING: z.string().min(1).optional(),
  OPENLDR_LABNO_PREFIX: z.string().optional(),
  OPENLDR_V1_DATABASE_DATA: z.string().optional(),
  OPENLDR_V1_DATABASE_DICT: z.string().optional(),
  OPENLDR_V2_URL: z.string().url().optional(),
  OPENLDR_V2_TOKEN: z.string().min(1).optional(),
  OPENLDR_V2_PATH: z.string().optional(),
  KEYCLOAK_PUBLIC_URL: z.string().url().optional(),
  KEYCLOAK_REALM: z.string().min(1).optional(),
  KEYCLOAK_CLIENT_ID: z.string().min(1).optional(),
  KEYCLOAK_CLIENT_SECRET: z.string().min(1).optional(),
  OPENLDR_PROJECT_NAME: z.string().min(1).optional(),
  OPENLDR_USE_CASE_NAME: z.string().min(1).optional(),
  OPENLDR_DATA_FEED_NAME: z.string().min(1).optional(),
  OPENLDR_DATA_FEED_ID: z.string().min(1).optional(),
  OPENLDR_V2_INSECURE_TLS: z.string().optional(),
});

function parseBool(v: string | undefined): boolean {
  if (v === undefined) return false;
  const lower = v.trim().toLowerCase();
  return lower === "1" || lower === "true" || lower === "yes" || lower === "on";
}

export function loadConfig(overrides: ConfigOverrides = {}): LoadedConfig {
  const envFilePath = overrides.envFile ?? resolve(process.cwd(), ".env");

  if (overrides.envFile !== undefined) {
    let contents: string;
    try {
      contents = readFileSync(envFilePath, "utf8");
    } catch (err) {
      throw new CliError(
        "ENV_FILE_UNREADABLE",
        `Could not read env file: ${envFilePath}`,
        { cause: err instanceof Error ? err.message : String(err) },
      );
    }
    const parsed = dotenv.parse(contents);
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } else {
    dotenv.config({ path: envFilePath, quiet: true });
  }

  // Treat empty-string env values the same as missing: the operator-
  // friendly convention in .env.example is "leave OPENLDR_V2_TOKEN empty
  // if using Keycloak", but Zod's .min(1).optional() rejects "" because
  // it counts as present. Strip empties before validation so optional
  // means optional.
  const sanitisedEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string" && v.length > 0) sanitisedEnv[k] = v;
  }
  const env = EnvSchema.safeParse(sanitisedEnv);
  if (!env.success) {
    throw new CliError("CONFIG_INVALID", "Invalid environment configuration", {
      issues: env.error.flatten().fieldErrors,
    });
  }

  const connectionString = overrides.connectionString ?? env.data.DISA_CONNECTION_STRING;
  if (connectionString === undefined || connectionString.length === 0) {
    throw new CliError(
      "CONFIG_MISSING",
      "No connection string configured. Set DISA_CONNECTION_STRING, use --connection-string, or add it to .env",
    );
  }

  const requestedFormat = overrides.outputFormat ?? env.data.DISA_OUTPUT ?? "ndjson";
  if (!isValidFormat(requestedFormat)) {
    throw new CliError(
      "CONFIG_INVALID",
      `Invalid output format: ${requestedFormat}. Expected one of ndjson, json, pretty`,
    );
  }

  return {
    connectionString,
    driver: "mssql",
    outputFormat: requestedFormat,
    openldrConnectionString: overrides.openldrConnectionString ?? env.data.OPENLDR_V1_CONNECTION_STRING,
    openldrLabnoPrefix: overrides.openldrLabnoPrefix ?? env.data.OPENLDR_LABNO_PREFIX ?? "TZDISA",
    openldrDataDatabase: overrides.openldrDataDatabase ?? env.data.OPENLDR_V1_DATABASE_DATA ?? "OpenLDRData",
    openldrDictDatabase: overrides.openldrDictDatabase ?? env.data.OPENLDR_V1_DATABASE_DICT ?? "OpenLDRDict",
    openldrV2Url: overrides.openldrV2Url ?? env.data.OPENLDR_V2_URL,
    openldrV2Token: overrides.openldrV2Token ?? env.data.OPENLDR_V2_TOKEN,
    openldrV2Path: overrides.openldrV2Path ?? env.data.OPENLDR_V2_PATH ?? "/api/v2/lab-requests",
    keycloakUrl: overrides.keycloakUrl ?? env.data.KEYCLOAK_PUBLIC_URL,
    keycloakRealm: overrides.keycloakRealm ?? env.data.KEYCLOAK_REALM,
    keycloakClientId: overrides.keycloakClientId ?? env.data.KEYCLOAK_CLIENT_ID,
    keycloakClientSecret: overrides.keycloakClientSecret ?? env.data.KEYCLOAK_CLIENT_SECRET,
    openldrProjectName: overrides.openldrProjectName ?? env.data.OPENLDR_PROJECT_NAME,
    openldrUseCaseName: overrides.openldrUseCaseName ?? env.data.OPENLDR_USE_CASE_NAME,
    openldrDataFeedName: overrides.openldrDataFeedName ?? env.data.OPENLDR_DATA_FEED_NAME,
    openldrDataFeedId: overrides.openldrDataFeedId ?? env.data.OPENLDR_DATA_FEED_ID,
    openldrV2InsecureTls: overrides.openldrV2InsecureTls ?? parseBool(env.data.OPENLDR_V2_INSECURE_TLS),
  };
}

export function redactConnectionString(cs: string): string {
  return cs
    .replace(/(password|pwd)=([^;]+)/gi, "$1=***")
    .replace(/:\/\/([^:]+):([^@]+)@/g, "://$1:***@");
}

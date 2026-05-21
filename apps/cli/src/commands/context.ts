import type { Command } from "commander";
import { loadConfig, type LoadedConfig } from "../config.js";
import { isValidFormat, type OutputFormat, type OutputOptions } from "../output.js";
import { CliError } from "../errors.js";

export interface GlobalOpts {
  connectionString?: string;
  envFile?: string;
  output?: string;
  color: boolean;
  quiet: boolean;
  logLevel: string;
  openldrCs?: string;
}

export function resolveGlobalOpts(cmd: Command): GlobalOpts {
  const g = cmd.optsWithGlobals<{
    connectionString?: string;
    envFile?: string;
    output?: string;
    color?: boolean;
    quiet?: boolean;
    logLevel?: string;
    openldrCs?: string;
  }>();

  const colorOpt = g.color ?? (process.env.NO_COLOR === undefined ? true : false);

  return {
    connectionString: g.connectionString,
    envFile: g.envFile,
    output: g.output,
    color: colorOpt && process.stdout.isTTY === true,
    quiet: g.quiet ?? false,
    logLevel: g.logLevel ?? "info",
    openldrCs: g.openldrCs,
  };
}

export function loadRuntime(
  cmd: Command,
  options?: { requireConnection?: boolean },
): { config: LoadedConfig; globals: GlobalOpts; output: OutputOptions } {
  const globals = resolveGlobalOpts(cmd);

  let config: LoadedConfig;
  try {
    config = loadConfig({
      connectionString: globals.connectionString,
      envFile: globals.envFile,
      outputFormat: globals.output,
      openldrConnectionString: globals.openldrCs,
    });
  } catch (err) {
    if (options?.requireConnection === false && err instanceof CliError && err.code === "CONFIG_MISSING") {
      const fallbackFormat: OutputFormat = isValidFormat(globals.output ?? "")
        ? (globals.output as OutputFormat)
        : "ndjson";
      return {
        config: {
          connectionString: "",
          driver: "mssql",
          outputFormat: fallbackFormat,
          openldrLabnoPrefix: process.env.OPENLDR_LABNO_PREFIX ?? "TZDISA",
          openldrConnectionString: globals.openldrCs ?? process.env.OPENLDR_V1_CONNECTION_STRING,
          openldrDataDatabase: process.env.OPENLDR_V1_DATABASE_DATA ?? "OpenLDRData",
          openldrDictDatabase: process.env.OPENLDR_V1_DATABASE_DICT ?? "OpenLDRDict",
          openldrV1PocFormat: process.env.OPENLDR_V1_POC_FORMAT === "district_facility" ? "district_facility" : "facility_ward",
          openldrV2Url: process.env.OPENLDR_V2_URL,
          openldrV2Token: process.env.OPENLDR_V2_TOKEN,
          openldrV2Path: process.env.OPENLDR_V2_PATH ?? "/api/v2/lab-requests",
          keycloakUrl: process.env.KEYCLOAK_PUBLIC_URL,
          keycloakRealm: process.env.KEYCLOAK_REALM,
          keycloakClientId: process.env.KEYCLOAK_CLIENT_ID,
          keycloakClientSecret: process.env.KEYCLOAK_CLIENT_SECRET,
          openldrProjectName: process.env.OPENLDR_PROJECT_NAME,
          openldrUseCaseName: process.env.OPENLDR_USE_CASE_NAME,
          openldrDataFeedName: process.env.OPENLDR_DATA_FEED_NAME,
          openldrDataFeedId: process.env.OPENLDR_DATA_FEED_ID,
          openldrV2InsecureTls: ["1", "true", "yes", "on"].includes((process.env.OPENLDR_V2_INSECURE_TLS ?? "").trim().toLowerCase()),
        },
        globals,
        output: {
          format: fallbackFormat,
          color: globals.color,
        },
      };
    }
    throw err;
  }

  return {
    config,
    globals,
    output: {
      format: config.outputFormat,
      color: globals.color,
    },
  };
}

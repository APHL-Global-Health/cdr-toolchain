import type { Command } from "commander";
import { redactConnectionString } from "../config.js";
import { emitArray } from "../output.js";
import { loadRuntime } from "./context.js";

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command("config").description("Config inspection");

  configCmd
    .command("show")
    .description("Show effective config with the connection string redacted")
    .action((_args, cmd: Command) => {
      const { config, output, globals } = loadRuntime(cmd, { requireConnection: false });
      emitArray(
        [
          {
            driver: config.driver,
            connection_string: config.connectionString === ""
              ? null
              : redactConnectionString(config.connectionString),
            openldr_v1_connection_string:
              config.openldrConnectionString === undefined ||
              config.openldrConnectionString.length === 0
                ? null
                : redactConnectionString(config.openldrConnectionString),
            openldr_labno_prefix: config.openldrLabnoPrefix,
            openldr_v1_database_data: config.openldrDataDatabase,
            openldr_v1_database_dict: config.openldrDictDatabase,
            output_format: config.outputFormat,
            env_file: globals.envFile ?? "./.env (if present)",
          },
        ],
        output,
      );
    });
}

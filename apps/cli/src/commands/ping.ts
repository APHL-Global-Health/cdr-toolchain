import type { Command } from "commander";
import { assertConnection } from "../db.js";
import { emitArray } from "../output.js";
import { loadRuntime } from "./context.js";

export function registerPingCommand(program: Command): void {
  program
    .command("ping")
    .description("Test database connectivity")
    .action(async (_args, cmd: Command) => {
      const { config, output } = loadRuntime(cmd);
      const start = Date.now();
      await assertConnection(config);
      const elapsed_ms = Date.now() - start;
      emitArray([{ ok: true, driver: config.driver, elapsed_ms }], output);
    });
}

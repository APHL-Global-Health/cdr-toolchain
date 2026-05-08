import type { Command } from "commander";
import { ERROR_CODES } from "../errors.js";
import { emitArray } from "../output.js";
import { loadRuntime } from "./context.js";

export function registerErrorsCommand(program: Command): void {
  program
    .command("errors")
    .description("List error codes and their exit codes")
    .action((_args, cmd: Command) => {
      const { output } = loadRuntime(cmd, { requireConnection: false });
      const rows = Object.values(ERROR_CODES).map((e) => ({
        code: e.code,
        exit: e.exit,
        description: e.description,
      }));
      emitArray(rows, output);
    });
}

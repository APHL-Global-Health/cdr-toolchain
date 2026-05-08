import type { Command } from "commander";
import { listEntities } from "../entities.js";
import { emitArray } from "../output.js";
import { loadRuntime } from "./context.js";

export function registerTablesCommand(program: Command): void {
  program
    .command("tables")
    .description("List queryable entities and their DB tables")
    .action((_args, cmd: Command) => {
      const { output } = loadRuntime(cmd, { requireConnection: false });
      const rows = listEntities().map((e) => ({
        alias: e.alias,
        class: (e.class as unknown as { name: string }).name,
        table: e.tableName,
        cursorColumn: e.cursorColumn ?? null,
        notes: e.notes ?? null,
      }));
      emitArray(rows, output);
    });
}

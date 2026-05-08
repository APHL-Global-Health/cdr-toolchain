import type { Command } from "commander";
import { resolveEntity } from "../entities.js";
import { CliError } from "../errors.js";
import { emitArray } from "../output.js";
import { loadRuntime } from "./context.js";

export function registerSchemaCommand(program: Command): void {
  program
    .command("schema <entity>")
    .description(
      "Show fields for an entity. sqlColumns are safe to use in --where/--order-by; fields shows every property exposed on the hydrated object (includes byte-decoded fields that cannot be filtered at the SQL level).",
    )
    .action((entityName: string, _args, cmd: Command) => {
      const { output } = loadRuntime(cmd, { requireConnection: false });
      let entity;
      try {
        entity = resolveEntity(entityName);
      } catch (err) {
        throw new CliError(
          "UNKNOWN_ENTITY",
          err instanceof Error ? err.message : String(err),
        );
      }
      const sqlSet = new Set(entity.sqlColumns);
      const decodedOnly = entity.fields.filter((f) => !sqlSet.has(f));
      emitArray(
        [
          {
            alias: entity.alias,
            class: (entity.class as unknown as { name: string }).name,
            table: entity.tableName,
            cursorColumn: entity.cursorColumn ?? null,
            sqlColumns: entity.sqlColumns,
            decodedOnly,
            fields: entity.fields,
            notes: entity.notes ?? null,
          },
        ],
        output,
      );
    });
}

import type { Command } from "commander";
import { resolveEntity } from "../entities.js";
import { CliError } from "../errors.js";
import { emitArray, emitRow } from "../output.js";
import { withServer } from "../db.js";
import { composeWhereWithPagination } from "../where.js";
import { loadRuntime } from "./context.js";

interface ListOpts {
  where?: string;
  limit?: string;
  offset?: string;
  fields?: string;
  explain?: boolean;
}

export function registerListCommand(program: Command): void {
  program
    .command("list <entity>")
    .description("Query rows from an entity (buffered)")
    .option("--where <sql>", "raw WHERE clause passed to disalab (injectable by design)")
    .option(
      "--limit <n>",
      "max rows returned; pushed into SQL if the entity has a cursor column, else post-hydration",
    )
    .option(
      "--offset <n>",
      "rows to skip; pushed into SQL if the entity has a cursor column, else post-hydration",
    )
    .option("--fields <csv>", "comma-separated fields to include in output (post-hydration)")
    .option("--explain", "print the query plan and exit without hitting the DB")
    .action(async (entityName: string, opts: ListOpts, cmd: Command) => {
      let entity;
      try {
        entity = resolveEntity(entityName);
      } catch (err) {
        throw new CliError(
          "UNKNOWN_ENTITY",
          err instanceof Error ? err.message : String(err),
        );
      }

      const fields = opts.fields?.split(",").map((s) => s.trim()).filter(Boolean);
      const limit = opts.limit !== undefined ? Number(opts.limit) : undefined;
      const offset = opts.offset !== undefined ? Number(opts.offset) : 0;
      const composed = composeWhereWithPagination(opts.where, limit, offset, entity.cursorColumn);

      if (opts.explain === true) {
        const { output } = loadRuntime(cmd, { requireConnection: false });
        emitArray(
          [
            {
              operation: "list",
              entity: entity.alias,
              class: (entity.class as unknown as { name: string }).name,
              table: entity.tableName,
              where: composed.where,
              limit: limit ?? null,
              offset: opts.offset !== undefined ? offset : null,
              pushed_to_sql: composed.pushedToSql,
              fields: fields ?? null,
            },
          ],
          { ...output, fields: undefined },
        );
        return;
      }

      const { config, output } = loadRuntime(cmd);
      const runtimeOutput = { ...output, fields };

      await withServer(config, async (server) => {
        const rows = await entity.class.All(composed.where, server);
        const toEmit = composed.pushedToSql
          ? rows
          : rows.slice(offset, limit !== undefined ? offset + limit : undefined);

        if (runtimeOutput.format === "json") {
          emitArray(toEmit as Record<string, unknown>[], runtimeOutput);
          return;
        }
        for (const row of toEmit) emitRow(row as Record<string, unknown>, runtimeOutput);
      });
    });
}

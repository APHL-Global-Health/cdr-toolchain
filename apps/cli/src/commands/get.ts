import type { Command } from "commander";
import { resolveEntity } from "../entities.js";
import { CliError } from "../errors.js";
import { emitRow, emitArray } from "../output.js";
import { withServer } from "../db.js";
import { normalizeWhere } from "../where.js";
import { loadRuntime } from "./context.js";

interface GetOpts {
  where?: string;
  fields?: string;
  explain?: boolean;
}

export function registerGetCommand(program: Command): void {
  program
    .command("get <entity>")
    .description("Fetch exactly one row (errors if zero or multiple match)")
    .option("--where <sql>", "raw WHERE clause (required)")
    .option("--fields <csv>", "comma-separated fields to include in output")
    .option("--explain", "print the query plan and exit without hitting the DB")
    .action(async (entityName: string, opts: GetOpts, cmd: Command) => {
      let entity;
      try {
        entity = resolveEntity(entityName);
      } catch (err) {
        throw new CliError(
          "UNKNOWN_ENTITY",
          err instanceof Error ? err.message : String(err),
        );
      }

      if (opts.where === undefined || opts.where.trim().length === 0) {
        throw new CliError("MISSING_FLAG", "`get` requires --where");
      }

      const fields = opts.fields?.split(",").map((s) => s.trim()).filter(Boolean);
      const where = normalizeWhere(opts.where);

      if (opts.explain === true) {
        const { output } = loadRuntime(cmd, { requireConnection: false });
        emitArray(
          [
            {
              operation: "get",
              entity: entity.alias,
              class: (entity.class as unknown as { name: string }).name,
              table: entity.tableName,
              where,
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
        const rows = await entity.class.All(where, server);
        if (rows.length === 0) {
          throw new CliError("GET_NO_ROWS", `No rows matched ${where}`, {
            entity: entity.alias,
          });
        }
        if (rows.length > 1) {
          throw new CliError(
            "GET_MULTIPLE_ROWS",
            `Expected 1 row, matched ${rows.length}`,
            { entity: entity.alias, count: rows.length },
          );
        }
        emitRow(rows[0] as Record<string, unknown>, runtimeOutput);
      });
    });
}

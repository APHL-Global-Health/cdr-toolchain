import type { Command } from "commander";
import { resolveEntity } from "../entities.js";
import { CliError } from "../errors.js";
import { emitArray, emitMeta, emitRow } from "../output.js";
import { buildServer, closePool } from "../db.js";
import { REGDAT4 } from "disalab";
import { composeWhereWithCursor } from "../where.js";
import { loadRuntime } from "./context.js";

interface StreamOpts {
  where?: string;
  after?: string;
  fields?: string;
  explain?: boolean;
  batchSize?: string;
}

export function registerStreamCommand(program: Command): void {
  program
    .command("stream <entity>")
    .description("Stream rows as NDJSON (one per line); emits {\"_meta\":\"done\"} on stderr at EOF")
    .option("--where <sql>", "raw WHERE clause (combined with --after via AND)")
    .option("--after <value>", "cursor resume: fetch rows where cursor column > value")
    .option("--fields <csv>", "comma-separated fields to include in output (post-hydration)")
    .option("--batch-size <n>", "hint for true streaming backends (registration only)", "100")
    .option("--explain", "print the query plan and exit without hitting the DB")
    .action(async (entityName: string, opts: StreamOpts, cmd: Command) => {
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
      let where: string;
      try {
        where = composeWhereWithCursor(opts.where, opts.after, entity.cursorColumn);
      } catch (err) {
        throw new CliError(
          "NOT_SUPPORTED",
          err instanceof Error ? err.message : String(err),
        );
      }

      if (opts.explain === true) {
        const { output } = loadRuntime(cmd, { requireConnection: false });
        emitArray(
          [
            {
              operation: "stream",
              entity: entity.alias,
              class: (entity.class as unknown as { name: string }).name,
              table: entity.tableName,
              where,
              cursorColumn: entity.cursorColumn ?? null,
              backend: entity.class === REGDAT4 ? "REGDAT4.Stream" : "buffered-All",
              fields: fields ?? null,
            },
          ],
          output,
        );
        return;
      }

      const { config, output: baseOutput } = loadRuntime(cmd);
      const runtimeOutput = { ...baseOutput, fields, format: "ndjson" as const };
      const server = buildServer(config);

      let count = 0;

      try {
        if (entity.class === REGDAT4) {
          await new Promise<void>((resolve, reject) => {
            REGDAT4.Stream(where, server, {
              on_row: (_pool, row) => {
                emitRow(row as unknown as Record<string, unknown>, runtimeOutput);
                count++;
              },
              on_recordset: () => {},
              on_rowsaffected: () => {},
              on_error: (_pool, err) => reject(err),
              on_done: () => resolve(),
            }).catch(reject);
          });
        } else {
          const rows = await entity.class.All(where, server);
          for (const row of rows) {
            emitRow(row as Record<string, unknown>, runtimeOutput);
            count++;
          }
        }
        emitMeta({ _meta: "done", count });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new CliError("DB_QUERY_FAILED", message, { entity: entity.alias, count });
      } finally {
        await closePool();
      }
    });
}

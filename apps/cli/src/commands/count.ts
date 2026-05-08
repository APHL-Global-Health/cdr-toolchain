import type { Command } from "commander";
import mssql from "mssql";
import { resolveEntity } from "../entities.js";
import { CliError } from "../errors.js";
import { emitArray } from "../output.js";
import { closePool } from "../db.js";
import { normalizeWhere } from "../where.js";
import { loadRuntime } from "./context.js";

interface CountOpts {
  where?: string;
  explain?: boolean;
}

interface EntityClassWithCount {
  Count?: (where: string, server: unknown) => Promise<number>;
}

async function rawCount(
  tableName: string,
  where: string,
  connectionString: string,
): Promise<number> {
  try {
    const pool = await mssql.connect(connectionString);
    const sql = `SELECT COUNT(*) AS Total FROM ${tableName} ${where}`;
    const result = await pool.request().query(sql);
    const row = result.recordset[0] as { Total: number } | undefined;
    return row?.Total ?? 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_QUERY_FAILED", message);
  } finally {
    await closePool();
  }
}

export function registerCountCommand(program: Command): void {
  program
    .command("count <entity>")
    .description("Count rows matching a WHERE clause (uses raw SELECT COUNT(*) — no hydration)")
    .option("--where <sql>", "raw WHERE clause")
    .option("--explain", "print the query plan and exit without hitting the DB")
    .action(async (entityName: string, opts: CountOpts, cmd: Command) => {
      let entity;
      try {
        entity = resolveEntity(entityName);
      } catch (err) {
        throw new CliError(
          "UNKNOWN_ENTITY",
          err instanceof Error ? err.message : String(err),
        );
      }

      const where = normalizeWhere(opts.where);

      if (opts.explain === true) {
        const { output } = loadRuntime(cmd, { requireConnection: false });
        emitArray(
          [
            {
              operation: "count",
              entity: entity.alias,
              class: (entity.class as unknown as { name: string }).name,
              table: entity.tableName,
              where,
              backend: (entity.class as unknown as EntityClassWithCount).Count !== undefined
                ? "class.Count"
                : "raw-select-count",
            },
          ],
          output,
        );
        return;
      }

      const { config, output } = loadRuntime(cmd);
      const cls = entity.class as unknown as EntityClassWithCount;

      let count: number;
      if (typeof cls.Count === "function") {
        try {
          count = await cls.Count(where, { config: { database: { driver: config.driver, connection_string: config.connectionString } } });
        } finally {
          await closePool();
        }
      } else {
        count = await rawCount(entity.tableName, where, config.connectionString);
      }

      emitArray(
        [
          {
            entity: entity.alias,
            where: where === "" ? null : where,
            count,
          },
        ],
        output,
      );
    });
}

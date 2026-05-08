import mssql from "mssql";
import type { DisaServer } from "disalab";
import { CliError } from "./errors.js";
import type { LoadedConfig } from "./config.js";

interface MssqlWithClose {
  close?: () => Promise<void>;
}

export function buildServer(config: LoadedConfig): DisaServer {
  return {
    config: {
      database: {
        driver: config.driver,
        connection_string: config.connectionString,
      },
    },
  };
}

export async function closePool(): Promise<void> {
  const m = mssql as unknown as MssqlWithClose;
  if (typeof m.close !== "function") return;
  try {
    await m.close();
  } catch {
    // ignore — pool may never have been opened
  }
}

export async function withServer<T>(
  config: LoadedConfig,
  fn: (server: DisaServer) => Promise<T>,
): Promise<T> {
  const server = buildServer(config);
  try {
    return await fn(server);
  } catch (err) {
    if (err instanceof CliError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_QUERY_FAILED", message);
  } finally {
    await closePool();
  }
}

export async function assertConnection(config: LoadedConfig): Promise<void> {
  try {
    const pool = await mssql.connect(config.connectionString);
    await pool.request().query("SELECT 1 AS ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_CONNECT_FAILED", message);
  } finally {
    await closePool();
  }
}

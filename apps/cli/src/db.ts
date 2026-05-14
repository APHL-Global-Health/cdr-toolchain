import type { DisaServer } from "disalab";
import { getPool, closeAllPools } from "disalab";
import { CliError } from "./errors.js";
import type { LoadedConfig } from "./config.js";

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

/**
 * No-op kept for source-compat with existing per-operation `finally`
 * blocks. Pools are now held by the disalab pool registry keyed by
 * connection string and live for the whole process. Use
 * `closeAllConnectionPools` at process exit (wired in src/index.ts).
 */
export async function closePool(): Promise<void> {
  return;
}

/** Drain every open ConnectionPool. Called once at process exit. */
export async function closeAllConnectionPools(): Promise<void> {
  await closeAllPools();
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
  }
}

export async function assertConnection(config: LoadedConfig): Promise<void> {
  try {
    const pool = await getPool(config.connectionString);
    await pool.request().query("SELECT 1 AS ok");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_CONNECT_FAILED", message);
  }
}

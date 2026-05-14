import mssql from "mssql";

// Pool registry: one ConnectionPool per connection_string, held open
// until closeAllPools(). Replaces the previous `mssql.connect(uri)`
// call pattern — that helper uses a single static pool keyed implicitly
// by the most recently passed connection string, so concurrent callers
// hopping between DISA and OpenLDR v1 URIs race the open/close
// lifecycle and produce "Connection not yet open" errors mid-batch.
//
// Each cached entry is the Promise<ConnectionPool> from .connect() so
// concurrent getPool() calls for the same URI await the same
// in-flight connection rather than racing each other.
const pools = new Map<string, Promise<mssql.ConnectionPool>>();

export async function getPool(connectionString: string): Promise<mssql.ConnectionPool> {
  let entry = pools.get(connectionString);
  if (entry === undefined) {
    const pool = new mssql.ConnectionPool(connectionString);
    entry = pool.connect();
    pools.set(connectionString, entry);
    // Evict failed connect() promises so a later getPool() call can
    // retry instead of resolving against a broken pool forever.
    entry.catch(() => {
      if (pools.get(connectionString) === entry) pools.delete(connectionString);
    });
  }
  return entry;
}

export async function closeAllPools(): Promise<void> {
  const entries = Array.from(pools.values());
  pools.clear();
  await Promise.allSettled(
    entries.map(async (entry) => {
      try {
        const pool = await entry;
        await pool.close();
      } catch {
        // already broken — nothing to clean up
      }
    }),
  );
}

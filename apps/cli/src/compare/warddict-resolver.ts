import { Core, WARDDICT } from "disalab";
import type { DisaServer } from "disalab";

/**
 * Resolves DISA `(LOCATION, WardClinic)` to the human-readable description
 * stored in WARDDICT. In Mozambique the description is only in the
 * WARDDICT_STATUS blob (column is NULL on disk) — the `WARDDICT` wrapper's
 * `decodedDescription()` handles either source.
 *
 * Lookup strategy:
 *   1. Direct: (LOCATION, ward) → DESCRIPTION
 *   2. Fallback: ("@@@@@", ward) — the facility-agnostic sentinel
 *   3. Miss: returns null (caller leaves WardClinic as the raw code)
 *
 * Cache: every probed (CODE1, CODE2) is memoised including misses, so a
 * batch run across thousands of labs only pays one query per unique combo.
 * Pass the same instance into each `compare` call in a batch to amortise
 * the cache across the run.
 */
export class WardDictResolver {
  readonly #cache = new Map<string, string | null>();

  async resolve(
    location: string | null | undefined,
    ward: string | null | undefined,
    server: DisaServer,
  ): Promise<string | null> {
    if (ward === null || ward === undefined) return null;
    const wardKey = ward.trim();
    if (wardKey.length === 0) return null;

    const locKey =
      location === null || location === undefined ? "" : location.trim();

    if (locKey.length > 0) {
      const direct = await this.#lookup(locKey, wardKey, server);
      if (direct !== null) return direct;
    }
    return this.#lookup("@@@@@", wardKey, server);
  }

  async #lookup(
    code1: string,
    code2: string,
    server: DisaServer,
  ): Promise<string | null> {
    const key = `${code1}|${code2}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;

    // char(5) columns implicit-pad with spaces, so equality against an
    // untrimmed RHS works in SQL Server. SqlEscape strips NUL padding and
    // doubles apostrophes per T-SQL.
    const where = `WHERE [CODE1] = '${Core.SqlEscape(code1)}' AND [CODE2] = '${Core.SqlEscape(code2)}'`;
    const rows = await WARDDICT.All(where, server);
    const description = rows.length > 0 ? rows[0]!.decodedDescription() : null;
    this.#cache.set(key, description);
    return description;
  }
}

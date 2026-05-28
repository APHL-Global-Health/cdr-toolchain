import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

/**
 * Ward dictionary — composite key (CODE1, CODE2) mapping a facility code +
 * ward/program code to a human description. Unlike LOCNDIC4 (single CODE),
 * WARDDICT is two-axis: CODE1 is typically a facility abbreviation (5 chars,
 * space-padded) and CODE2 is the ward or clinical-service code under that
 * facility. CODE1 = "@@@@@" (5 '@' characters) is a sentinel for facility-
 * agnostic entries.
 *
 * In Mozambique's data, DESCRIPTION and ABBREV columns are NULL on disk —
 * the readable values are packed into WARDDICT_STATUS as length-prefixed
 * strings (0x1B + description, 0x0A + abbrev). Callers that need the
 * description must decode the blob; this wrapper just exposes the raw
 * columns and the blob bytes.
 */
export class WARDDICT {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  CODE1: string | null;
  CODE2: string | null;
  DESCRIPTION: string | null;
  ABBREV: string | null;

  constructor(
    datestamp: unknown,
    code1: string | null,
    code2: string | null,
    description: string | null,
    abbrev: string | null,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.CODE1 = code1;
    this.CODE2 = code2;
    this.DESCRIPTION = description;
    this.ABBREV = abbrev;

    Core.FixBytes(bytes);
  }

  static fromBytes(bytes: DisaInput): WARDDICT {
    return new WARDDICT(null, null, null, null, null, bytes);
  }

  static async All(where: string, server: DisaServer): Promise<WARDDICT[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: WARDDICT[] = [];

    if (DB_DRIVER === "mssql") {
      const sql = `SELECT [DATESTAMP] ,[CODE1] ,[CODE2] ,[DESCRIPTION] ,[ABBREV] ,[WARDDICT_STATUS] FROM [DisaGlobal].[dbo].[WARDDICT] ${!Core.IsEmpty(where) ? where : ""}`;
      const pool = await getPool(DB_URI);
      const list = (await pool.request().query(sql)).recordset;

      list.forEach((row: Record<string, unknown>) => {
        const item = new WARDDICT(
          row.DATESTAMP,
          row.CODE1 as string | null,
          row.CODE2 as string | null,
          row.DESCRIPTION as string | null,
          row.ABBREV as string | null,
          row.WARDDICT_STATUS as DisaInput,
          server,
        );
        results.push(item);
      });
    }

    return results;
  }
}

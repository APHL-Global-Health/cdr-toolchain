import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class PARMDICT {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  ACTIVE: unknown;
  CODE: string;
  DESCRIPTION: string;
  ABBREVIATION: string;
  CONTEXT: number;
  INDEX: number;
  UNITS: string;
  REFERENCE: string;

  constructor(
    datestamp: unknown,
    code: string,
    description: string,
    abbrev: string,
    active: unknown,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.ACTIVE = active;
    this.CODE = code;
    this.DESCRIPTION = description;
    this.ABBREVIATION = abbrev;

    const data = Core.FixBytes(bytes);

    const context = Core.FixString(data, 121, 122);
    this.CONTEXT = context.trim().length > 0 ? context.charCodeAt(0) : -1;
    this.INDEX = Core.FixString(data, 0, 1).charCodeAt(0);
    this.UNITS = Core.FixText(data, 126, 136);
    this.REFERENCE = Core.FixText(data, 214, 260);
  }

  static fromBytes(datestamp: unknown, active: unknown, bytes: DisaInput, server?: DisaServer): PARMDICT {
    const data = Core.FixBytes(bytes);
    const CODE = Core.FixText(data, 4, 11);
    const DESCRIPTION = Core.FixText(data, 12, 42);
    const ABBREVIATION = Core.FixText(data, 43, 53);
    return new PARMDICT(datestamp, CODE, DESCRIPTION, ABBREVIATION, active, bytes, server);
  }

  static async All(where: string, server: DisaServer): Promise<PARMDICT[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: PARMDICT[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        // Note: the [DESCRIPTION] and [ABBREV] columns are corrupted for some
        // rows — they were written starting 3 bytes into the blob's string
        // slot, so values get truncated (e.g. "Remarks" → "arks"). The blob
        // itself carries the correct value, so we parse it via fromBytes
        // rather than trusting the columns.
        const sql = `SELECT [DATESTAMP] ,[ACTIVE] ,[PARMDICT_STATUS] FROM [DisaGlobal].[dbo].[PARMDICT] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            PARMDICT.fromBytes(
              row.DATESTAMP,
              row.ACTIVE,
              row.PARMDICT_STATUS as DisaInput,
              server,
            ),
          );
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class BREGDICT {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  CODE: string;
  DESCRIPTION: string;
  ABBREV: string;
  _CODE: string;
  _DESCRIPTION: string;

  constructor(
    datestamp: unknown,
    code: string,
    description: string,
    abbrev: string,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.CODE = code;
    this.DESCRIPTION = description;
    this.ABBREV = abbrev;

    const data = Core.FixBytes(bytes);
    this._CODE = Core.FixText(data, 4, 9);
    this._DESCRIPTION = Core.FixText(data, 9, 94);
  }

  static async All(where: string, server: DisaServer): Promise<BREGDICT[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: BREGDICT[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[CODE] ,[DESCRIPTION] ,[ABBREV] ,[BREGDICT_STATUS] FROM [DisalabDict].[dbo].[BREGDICT] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          const item = new BREGDICT(
            row.DATESTAMP,
            row.CODE as string,
            row.DESCRIPTION as string,
            row.ABBREV as string,
            row.BREGDICT_STATUS as DisaInput,
            server,
          );
          results.push(item);
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

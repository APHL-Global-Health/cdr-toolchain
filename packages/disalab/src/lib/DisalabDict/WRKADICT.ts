import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class WRKADICT {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  CODE: string;
  DESCRIPTION: string;
  ABBREV: string;
  _CODE: string;
  _DESCRIPTION: string;
  _ABBREVIATION: string;
  Location: string[] = [];

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
    this._DESCRIPTION = Core.FixText(data, 10, 40);
    this._ABBREVIATION = Core.FixText(data, 41, 94);

    let startIndex = 94;
    const alpha = Array.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    for (let x = 0; x < 26; x++) {
      const test = data.substring(startIndex, startIndex + 67).trim();
      if (!Core.IsEmpty(test)) this.Location.push(alpha[x] + "-" + test);
      startIndex += 70;
    }
  }

  static async All(where: string, server: DisaServer): Promise<WRKADICT[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: WRKADICT[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[CODE] ,[DESCRIPTION] ,[ABBREV] ,[WRKADICT_STATUS] FROM [DisalabDict].[dbo].[WRKADICT] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          const item = new WRKADICT(
            row.DATESTAMP,
            row.CODE as string,
            row.DESCRIPTION as string,
            row.ABBREV as string,
            row.WRKADICT_STATUS as DisaInput,
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

import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class TESTDICT {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  CODE: string;
  DESCRIPTION: string;
  ABBREV: string;
  SECTION: string | null | undefined;
  PARAMETERS: string[] = [];
  _CODE: string;
  _DESCRIPTION: string;
  _ABBREVIATION: string;
  _WORKAREA_GROUP: string;

  constructor(
    datestamp: unknown,
    code: string,
    description: string,
    abbrev: string,
    section: string | null | undefined,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.CODE = code;
    this.DESCRIPTION = description;
    this.ABBREV = abbrev;
    this.SECTION = !Core.IsEmpty(section) ? section!.trim() : section;

    const data = Core.FixBytes(bytes);

    let startIndex = 205;
    let tests = Core.FixString(data, startIndex, data.length);
    let test = tests.substring(0, 30);

    while (test.trim().length > 0) {
      this.PARAMETERS.push(test.trim());
      startIndex += 30;
      tests = Core.FixString(data, startIndex, data.length);
      test = tests.substring(0, 30);
    }

    this._CODE = Core.FixText(data, 4, 9);
    this._DESCRIPTION = Core.FixText(data, 10, 40);
    this._ABBREVIATION = Core.FixText(data, 41, 98);
    this._WORKAREA_GROUP = Core.FixString(data, 104, 105);
  }

  static async All(where: string, server: DisaServer): Promise<TESTDICT[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: TESTDICT[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[CODE] ,[DESCRIPTION] ,[ABBREV] ,[SECTION] ,[TESTDICT_STATUS] FROM [DisaGlobal].[dbo].[TESTDICT] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          const item = new TESTDICT(
            row.DATESTAMP,
            row.CODE as string,
            row.DESCRIPTION as string,
            row.ABBREV as string,
            row.SECTION as string | null | undefined,
            row.TESTDICT_STATUS as DisaInput,
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

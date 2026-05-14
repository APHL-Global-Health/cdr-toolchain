import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class DESLDIC5 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  LANGUAGE: unknown;
  CONTEXT: string | null | undefined;
  CODE1: string | null | undefined;
  CODE2: string | null | undefined;
  CODE3: string | null | undefined;
  DESCRIPTION: string | null | undefined;
  ABBREV: string | null | undefined;
  _CONTEXT: string;
  _CODE1: string;
  _CODE2: string;
  _CODE3: string;
  _DESCRIPTION: string;
  _ABBREVIATION: string;
  _Sectors: string[] = [];

  constructor(
    datestamp: unknown,
    language: unknown,
    context: string | null | undefined,
    code1: string | null | undefined,
    code2: string | null | undefined,
    code3: string | null | undefined,
    description: string | null | undefined,
    abbrev: string | null | undefined,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.LANGUAGE = language;
    this.CONTEXT = !Core.IsUndefinedOrNull(context) ? context.trim() : context;
    this.CODE1 = !Core.IsUndefinedOrNull(code1) ? code1.trim() : code1;
    this.CODE2 = !Core.IsUndefinedOrNull(code2) ? code2.trim() : code2;
    this.CODE3 = !Core.IsUndefinedOrNull(code3) ? code3.trim() : code3;
    this.DESCRIPTION = !Core.IsUndefinedOrNull(description) ? description.trim() : description;
    this.ABBREV = !Core.IsUndefinedOrNull(abbrev) ? abbrev.trim() : abbrev;

    const data = Core.FixBytes(bytes);

    this._CONTEXT = Core.FixText(data, 16, 21);
    this._CODE1 = Core.FixText(data, 21, 26);
    this._CODE2 = Core.FixText(data, 26, 31);
    this._CODE3 = Core.FixText(data, 31, 36);
    this._DESCRIPTION = Core.FixText(data, 37, 68);

    let start = 68;
    let end = 138;
    if (!Core.IsEmpty(this.CONTEXT) && this.CONTEXT === "STORE") {
      start = 84;
      end = 138;
    }

    this._ABBREVIATION = Core.FixString(data, start, end);

    if (!Core.IsUndefinedOrNull(this.CONTEXT) && this.CONTEXT === "STORE") {
      if (!Core.IsUndefinedOrNull(this._ABBREVIATION)) {
        let startIndex = 0;
        for (let x = 0; x < 5; x++) {
          const store = this._ABBREVIATION.substring(startIndex, startIndex + 10);
          if (store.trim().length > 0) this._Sectors.push(store.substring(0, 5).trim());
          startIndex += 10;
        }
      }
    }
  }

  static async All(where: string, server: DisaServer): Promise<DESLDIC5[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: DESLDIC5[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[LANGUAGE] ,[CONTEXT] ,[CODE1] ,[CODE2] ,[CODE3] ,[DESCRIPTION] ,[ABBREV] ,[DESLDIC5_STATUS] FROM [DisalabDict].[dbo].[DESLDIC5] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          const item = new DESLDIC5(
            row.DATESTAMP,
            row.LANGUAGE,
            row.CONTEXT as string | null | undefined,
            row.CODE1 as string | null | undefined,
            row.CODE2 as string | null | undefined,
            row.CODE3 as string | null | undefined,
            row.DESCRIPTION as string | null | undefined,
            row.ABBREV as string | null | undefined,
            row.DESLDIC5_STATUS as DisaInput,
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

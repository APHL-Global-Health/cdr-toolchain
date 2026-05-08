import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class DOCCDAT5 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  CONTEXT: string;
  CODE1: string;
  CODE2: string;
  CODE3: string;
  CODE4: string;
  _CONTEXT: string;
  _CODE1: string;
  _CODE2: string;
  _CODE3: string;
  _CODE4: string;

  constructor(
    datestamp: unknown,
    context: string,
    code1: string,
    code2: string,
    code3: string,
    code4: string,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.CONTEXT = context;
    this.CODE1 = code1;
    this.CODE2 = code2;
    this.CODE3 = code3;
    this.CODE4 = code4;

    const data = Core.FixBytes(bytes);

    this._CONTEXT = Core.FixText(data, 15, 20);
    this._CODE1 = Core.FixText(data, 20, 25);
    this._CODE2 = Core.FixText(data, 25, 30);
    this._CODE3 = Core.FixText(data, 30, 35);
    this._CODE4 = Core.FixText(data, 35, 40);
  }

  static async All(where: string, server: DisaServer): Promise<DOCCDAT5[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: DOCCDAT5[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[CONTEXT] ,[CODE1] ,[CODE2] ,[CODE3] ,[CODE4] ,[DOCCDAT5_STATUS] FROM [DisalabDict].[dbo].[DOCCDAT5] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          const item = new DOCCDAT5(
            row.DATESTAMP,
            row.CONTEXT as string,
            row.CODE1 as string,
            row.CODE2 as string,
            row.CODE3 as string,
            row.CODE4 as string,
            row.DOCCDAT5_STATUS as DisaInput,
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

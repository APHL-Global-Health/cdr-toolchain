import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RNAMIDX4 {
  readonly #server: DisaServer | undefined;
  SURNAME: string;
  REGDATE: unknown;
  LABNO: string;

  constructor(surname: string, regdate: unknown, labno: string, server?: DisaServer) {
    this.#server = server;
    this.SURNAME = surname;
    this.REGDATE = regdate;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<RNAMIDX4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RNAMIDX4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [SURNAME] ,[REGDATE] ,[LABNO] FROM [DisalabData].[dbo].[RNAMIDX4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(new RNAMIDX4(row.SURNAME as string, row.REGDATE, row.LABNO as string, server));
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

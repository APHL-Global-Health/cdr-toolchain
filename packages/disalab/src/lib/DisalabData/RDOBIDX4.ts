import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RDOBIDX4 {
  readonly #server: DisaServer | undefined;
  DOBDATE: unknown;
  LABNO: string;

  constructor(dobdate: unknown, labno: string, server?: DisaServer) {
    this.#server = server;
    this.DOBDATE = dobdate;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<RDOBIDX4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RDOBIDX4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DOBDATE] ,[LABNO] FROM [DisalabData].[dbo].[RDOBIDX4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(new RDOBIDX4(row.DOBDATE, row.LABNO as string, server));
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

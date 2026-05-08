import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RREFIDX4 {
  readonly #server: DisaServer | undefined;
  REFNO: string;
  LABNO: string;

  constructor(refno: string, labno: string, server?: DisaServer) {
    this.#server = server;
    this.REFNO = refno;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<RREFIDX4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RREFIDX4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [REFNO] ,[LABNO] FROM [DisalabData].[dbo].[RREFIDX4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(new RREFIDX4(row.REFNO as string, row.LABNO as string, server));
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RIDNIDX4 {
  readonly #server: DisaServer | undefined;
  IDNUMBER: string;
  LABNO: string;

  constructor(idnumber: string, labno: string, server?: DisaServer) {
    this.#server = server;
    this.IDNUMBER = idnumber;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<RIDNIDX4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RIDNIDX4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [IDNUMBER] ,[LABNO] FROM [DisalabData].[dbo].[RIDNIDX4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(new RIDNIDX4(row.IDNUMBER as string, row.LABNO as string, server));
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RTKNIDX5 {
  readonly #server: DisaServer | undefined;
  TAKENDATE: unknown;
  INVOICENO: string;

  constructor(takendate: unknown, invoiceno: string, server?: DisaServer) {
    this.#server = server;
    this.TAKENDATE = takendate;
    this.INVOICENO = invoiceno;
  }

  static async All(where: string, server: DisaServer): Promise<RTKNIDX5[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RTKNIDX5[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [TAKENDATE] ,[INVOICENO] FROM [DisalabData].[dbo].[RTKNIDX5] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(new RTKNIDX5(row.TAKENDATE, row.INVOICENO as string, server));
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RLNKIDX4 {
  readonly #server: DisaServer | undefined;
  UNIQUEID: string;
  REGDATE: unknown;
  LABNO: string;

  constructor(uniqueid: string, regdate: unknown, labno: string, server?: DisaServer) {
    this.#server = server;
    this.UNIQUEID = uniqueid;
    this.REGDATE = regdate;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<RLNKIDX4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RLNKIDX4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [UNIQUEID] ,[REGDATE] ,[LABNO] FROM [DisalabData].[dbo].[RLNKIDX4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(new RLNKIDX4(row.UNIQUEID as string, row.REGDATE, row.LABNO as string, server));
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RDOCIDX4 {
  readonly #server: DisaServer | undefined;
  DOCTOR: string;
  REGDATE: unknown;
  LABNO: string;

  constructor(doctor: string, regdate: unknown, labno: string, server?: DisaServer) {
    this.#server = server;
    this.DOCTOR = doctor;
    this.REGDATE = regdate;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<RDOCIDX4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RDOCIDX4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DOCTOR] ,[REGDATE] ,[LABNO] FROM [DisalabData].[dbo].[RDOCIDX4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(new RDOCIDX4(row.DOCTOR as string, row.REGDATE, row.LABNO as string, server));
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

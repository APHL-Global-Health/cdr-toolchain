import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RSNXIDX4 {
  readonly #server: DisaServer | undefined;
  SOUNDX: string;
  REGDATE: unknown;
  LABNO: string;

  constructor(soundx: string, regdate: unknown, labno: string, server?: DisaServer) {
    this.#server = server;
    this.SOUNDX = soundx;
    this.REGDATE = regdate;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<RSNXIDX4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RSNXIDX4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [SOUNDX] ,[REGDATE] ,[LABNO] FROM [DisalabData].[dbo].[RSNXIDX4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(new RSNXIDX4(row.SOUNDX as string, row.REGDATE, row.LABNO as string, server));
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

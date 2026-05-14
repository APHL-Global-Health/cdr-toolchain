import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RLSXIDX4 {
  readonly #server: DisaServer | undefined;
  LOCATION: string;
  SOUNDX: string;
  REGDATE: unknown;
  LABNO: string;

  constructor(location: string, soundx: string, regdate: unknown, labno: string, server?: DisaServer) {
    this.#server = server;
    this.LOCATION = location;
    this.SOUNDX = soundx;
    this.REGDATE = regdate;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<RLSXIDX4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RLSXIDX4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [LOCATION] ,[SOUNDX] ,[REGDATE] ,[LABNO] FROM [DisalabData].[dbo].[RLSXIDX4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new RLSXIDX4(
              row.LOCATION as string,
              row.SOUNDX as string,
              row.REGDATE,
              row.LABNO as string,
              server,
            ),
          );
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

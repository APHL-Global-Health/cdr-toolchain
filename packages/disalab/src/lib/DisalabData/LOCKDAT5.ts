import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class LOCKDAT5 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  LOCKKEY: string;
  WorkstationID: string;

  constructor(datestamp: unknown, lockkey: string, workstationid: string, server?: DisaServer) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.LOCKKEY = lockkey;
    this.WorkstationID = workstationid;
  }

  static async All(where: string, server: DisaServer): Promise<LOCKDAT5[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: LOCKDAT5[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[LOCKKEY] ,[WorkstationID] FROM [DisalabData].[dbo].[LOCKDAT5] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new LOCKDAT5(
              row.DATESTAMP,
              row.LOCKKEY as string,
              row.WorkstationID as string,
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

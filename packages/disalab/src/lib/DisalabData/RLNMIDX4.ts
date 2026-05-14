import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RLNMIDX4 {
  readonly #server: DisaServer | undefined;
  LOCATION: string;
  SURNAME: string;
  REGDATE: unknown;
  LABNO: string;

  constructor(location: string, surname: string, regdate: unknown, labno: string, server?: DisaServer) {
    this.#server = server;
    this.LOCATION = location;
    this.SURNAME = surname;
    this.REGDATE = regdate;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<RLNMIDX4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RLNMIDX4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [LOCATION] ,[SURNAME] ,[REGDATE] ,[LABNO] FROM [DisalabData].[dbo].[RLNMIDX4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new RLNMIDX4(
              row.LOCATION as string,
              row.SURNAME as string,
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

import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class RLOCIDX4 {
  readonly #server: DisaServer | undefined;
  LOCATION: string;
  WARD: string;
  REGDATE: unknown;
  LABNO: string;

  constructor(location: string, ward: string, regdate: unknown, labno: string, server?: DisaServer) {
    this.#server = server;
    this.LOCATION = location;
    this.WARD = ward;
    this.REGDATE = regdate;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<RLOCIDX4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RLOCIDX4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [LOCATION] ,[WARD] ,[REGDATE] ,[LABNO] FROM [DisalabData].[dbo].[RLOCIDX4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new RLOCIDX4(
              row.LOCATION as string,
              row.WARD as string,
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

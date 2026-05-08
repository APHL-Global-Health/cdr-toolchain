import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaServer } from "../types.js";

export class LABNDAT4 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  ID: string;
  LABDATE: unknown;
  LABNO: string;

  constructor(datestamp: unknown, id: string, labdate: unknown, labno: string, server?: DisaServer) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.ID = id;
    this.LABDATE = labdate;
    this.LABNO = labno;
  }

  static async All(where: string, server: DisaServer): Promise<LABNDAT4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: LABNDAT4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[ID] ,[LABDATE] ,[LABNO] FROM [DisalabData].[dbo].[LABNDAT4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new LABNDAT4(row.DATESTAMP, row.ID as string, row.LABDATE, row.LABNO as string, server),
          );
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

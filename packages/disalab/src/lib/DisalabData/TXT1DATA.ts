import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class TXT1DATA {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  LABNO: string;
  TESTCODE: string;
  TESTINDEX: unknown;
  FRAMEREF: unknown;
  PRE?: string;
  REF?: string;
  VALUE: string = "";

  constructor(
    datestamp: unknown,
    labno: string,
    testcode: string,
    testindex: unknown,
    frameref: unknown,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.LABNO = labno;
    this.TESTCODE = testcode;
    this.TESTINDEX = testindex;
    this.FRAMEREF = frameref;

    const data = Core.FixBytes(bytes);

    if (!Core.IsUndefinedOrNull(data) && data.length > 15) {
      this.PRE = data.substring(0, 15);
      this.REF = data.substring(15, 16);
      this.VALUE = data.substring(16, data.length);
    }
  }

  static async All(where: string, server: DisaServer): Promise<TXT1DATA[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: TXT1DATA[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[LABNO] ,[TESTCODE] ,[TESTINDEX] ,[FRAMEREF] ,[TXT1DATA_STATUS] FROM [DisalabData].[dbo].[TXT1DATA] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new TXT1DATA(
              row.DATESTAMP,
              row.LABNO as string,
              row.TESTCODE as string,
              row.TESTINDEX,
              row.FRAMEREF,
              row.TXT1DATA_STATUS as DisaInput,
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

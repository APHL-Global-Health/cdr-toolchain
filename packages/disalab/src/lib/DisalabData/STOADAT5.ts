import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class STOADAT5 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  CODE: string;
  UPDATEDDATE: unknown;
  SEQNO: unknown;
  SPECTYPE: unknown;
  LABNO: string;
  REGION: string;
  _CODE: string;

  constructor(
    datestamp: unknown,
    code: string,
    updateddate: unknown,
    seqno: unknown,
    spectype: unknown,
    labno: string,
    region: string,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.CODE = code;
    this.UPDATEDDATE = updateddate;
    this.SEQNO = seqno;
    this.SPECTYPE = spectype;
    this.LABNO = labno;
    this.REGION = region;

    const data = Core.FixBytes(bytes);
    this._CODE = Core.FixText(data, 15, 20);
  }

  static async All(where: string, server: DisaServer): Promise<STOADAT5[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: STOADAT5[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[CODE] ,[UPDATEDDATE] ,[SEQNO] ,[SPECTYPE] ,[LABNO] ,[REGION] ,[STOADAT5_STATUS] FROM [DisalabData].[dbo].[STOADAT5] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new STOADAT5(
              row.DATESTAMP,
              row.CODE as string,
              row.UPDATEDDATE,
              row.SEQNO,
              row.SPECTYPE,
              row.LABNO as string,
              row.REGION as string,
              row.STOADAT5_STATUS as DisaInput,
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

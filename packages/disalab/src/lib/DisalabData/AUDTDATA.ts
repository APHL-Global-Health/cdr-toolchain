import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class AUDTDATA {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  LABNO: string | null | undefined;
  AUDDateTime: unknown;
  OCCURS: unknown;
  WS: unknown;
  _AuditCode: string;
  _AuditUser: string;
  _Auditdata: string;

  constructor(
    datestamp: unknown,
    labno: string | null | undefined,
    auddatetime: unknown,
    occurs: unknown,
    ws: unknown,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.LABNO = !Core.IsUndefinedOrNull(labno) ? labno.trim() : labno;
    this.AUDDateTime = auddatetime;
    this.OCCURS = occurs;
    this.WS = ws;

    const data = Core.FixBytes(bytes);

    this._AuditCode = Core.FixText(data, 19, 24);
    this._AuditUser = Core.FixText(data, 24, 29);
    this._Auditdata = Core.FixText(data, 36, 66);
  }

  static async All(where: string, server: DisaServer): Promise<AUDTDATA[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: AUDTDATA[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[LABNO] ,[AUDDateTime] ,[OCCURS] ,[WS] ,[AUDTDATA_STATUS] FROM [DisalabData].[dbo].[AUDTDATA] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new AUDTDATA(
              row.DATESTAMP,
              row.LABNO as string | null | undefined,
              row.AUDDateTime,
              row.OCCURS,
              row.WS,
              row.AUDTDATA_STATUS as DisaInput,
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

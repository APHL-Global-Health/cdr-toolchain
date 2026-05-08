import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class PRINTQ4 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  QUEUE: unknown;
  ROUTE: string;
  LOCATION: string;
  WARD: string;
  DRCODE: string;
  LABNO: string;
  XPRINTSET: unknown;
  LANGUAGE: unknown;
  REPTYPE: unknown;
  COPY_NO: unknown;
  _ROUTE: string;
  _LOCATION: string;
  _WARD: string;
  _LANGUAGE: string;
  _REPTYPE: string;

  constructor(
    datestamp: unknown,
    queue: unknown,
    route: string,
    location: string,
    ward: string,
    drcode: string,
    labno: string,
    xprintset: unknown,
    language: unknown,
    reptype: unknown,
    copy_no: unknown,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.QUEUE = queue;
    this.ROUTE = route;
    this.LOCATION = location;
    this.WARD = ward;
    this.DRCODE = drcode;
    this.LABNO = labno;
    this.XPRINTSET = xprintset;
    this.LANGUAGE = language;
    this.REPTYPE = reptype;
    this.COPY_NO = copy_no;

    const data = Core.FixBytes(bytes);

    this._ROUTE = Core.FixText(data, 5, 6);
    this._LOCATION = Core.FixText(data, 6, 11);
    this._WARD = Core.FixText(data, 11, 16);
    this._LANGUAGE = Core.FixText(data, 27, 28);
    this._REPTYPE = Core.FixText(data, 28, 29);
  }

  static async All(where: string, server: DisaServer): Promise<PRINTQ4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: PRINTQ4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT  [DATESTAMP] ,[QUEUE] ,[ROUTE] ,[LOCATION] ,[WARD] ,[DRCODE] ,[LABNO] ,[XPRINTSET] ,[LANGUAGE] ,[REPTYPE] ,[COPY_NO] ,[PRINTQ4_STATUS] FROM [DisalabData].[dbo].[PRINTQ4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new PRINTQ4(
              row.DATESTAMP,
              row.QUEUE,
              row.ROUTE as string,
              row.LOCATION as string,
              row.WARD as string,
              row.DRCODE as string,
              row.LABNO as string,
              row.XPRINTSET,
              row.LANGUAGE,
              row.REPTYPE,
              row.COPY_NO,
              row.PRINTQ4_STATUS as DisaInput,
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

  static async Count(where: string, server: DisaServer): Promise<number> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    let total = 0;

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT  COUNT([QUEUE]) "Total" FROM [DisalabData].[dbo].[PRINTQ4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        if (list.length > 0) {
          total = (list[0] as { Total: number }).Total;
        }
      } catch (err) {
        throw err;
      }
    }

    return total;
  }
}

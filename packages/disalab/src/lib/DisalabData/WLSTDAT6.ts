import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class WLSTDAT6 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  AREA: string;
  WLSTGROUP: string;
  WLSTATUS: string;
  REQUESTED_DATE: unknown;
  PRIORITY: unknown;
  LABNO: string;
  REGION: string;
  REQUESTED_Time: unknown;
  TESTINDEX: unknown;
  TESTCODE: string;
  REVIEWER: string;
  _AREA: string;
  _WLSTGROUP: string;
  _TESTCODE: string;
  _REVIEWER: string;
  _REVIEWER_AGAIN: string;
  _STORAGE: string;
  _ROUTE: string;

  constructor(
    datestamp: unknown,
    area: string,
    wlstgroup: string,
    wlstatus: string,
    requested_date: unknown,
    priority: unknown,
    labno: string,
    region: string,
    requested_time: unknown,
    testindex: unknown,
    testcode: string,
    reviewer: string,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.AREA = area;
    this.WLSTGROUP = wlstgroup;
    this.WLSTATUS = wlstatus;
    this.REQUESTED_DATE = requested_date;
    this.PRIORITY = priority;
    this.LABNO = labno;
    this.REGION = region;
    this.REQUESTED_Time = requested_time;
    this.TESTINDEX = testindex;
    this.TESTCODE = testcode;
    this.REVIEWER = reviewer;

    const data = Core.FixBytes(bytes);

    this._AREA = Core.FixText(data, 4, 9);
    this._WLSTGROUP = Core.FixText(data, 9, 10);
    this._TESTCODE = Core.FixText(data, 20, 25);
    this._REVIEWER = Core.FixText(data, 31, 36);
    this._REVIEWER_AGAIN = Core.FixText(data, 36, 41);
    this._STORAGE = Core.FixText(data, 122, 127);
    this._ROUTE = Core.FixText(data, 131, 132);
  }

  static async All(where: string, server: DisaServer): Promise<WLSTDAT6[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: WLSTDAT6[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[AREA] ,[WLSTGROUP] ,[WLSTATUS] ,[REQUESTED_DATE] ,[PRIORITY] ,[LABNO] ,[REGION] ,[REQUESTED_Time] ,[TESTINDEX] ,[TESTCODE] ,[REVIEWER] ,[WLSTDAT6_STATUS] FROM [DisalabData].[dbo].[WLSTDAT6] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new WLSTDAT6(
              row.DATESTAMP,
              row.AREA as string,
              row.WLSTGROUP as string,
              row.WLSTATUS as string,
              row.REQUESTED_DATE,
              row.PRIORITY,
              row.LABNO as string,
              row.REGION as string,
              row.REQUESTED_Time,
              row.TESTINDEX,
              row.TESTCODE as string,
              row.REVIEWER as string,
              row.WLSTDAT6_STATUS as DisaInput,
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

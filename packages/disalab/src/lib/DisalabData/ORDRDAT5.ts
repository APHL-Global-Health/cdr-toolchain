import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class ORDRDAT5 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  PlacerOrderNo: string;
  RefNo: string;
  OrderStatus: string;
  CollectedDateTime: unknown;
  Labno: string;
  Region: string;
  HospitalNo: string;
  _PlacerOrderNo: string;

  constructor(
    datestamp: unknown,
    placerorderno: string,
    refno: string,
    orderstatus: string,
    collecteddatetime: unknown,
    labno: string,
    region: string,
    hospitalno: string,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.PlacerOrderNo = placerorderno;
    this.RefNo = refno;
    this.OrderStatus = orderstatus;
    this.CollectedDateTime = collecteddatetime;
    this.Labno = labno;
    this.Region = region;
    this.HospitalNo = hospitalno;

    const data = Core.FixBytes(bytes);
    this._PlacerOrderNo = Core.FixText(data, 5, 26);
  }

  static async All(where: string, server: DisaServer): Promise<ORDRDAT5[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: ORDRDAT5[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[PlacerOrderNo] ,[RefNo] ,[OrderStatus] ,[CollectedDateTime] ,[Labno] ,[Region] ,[HospitalNo] ,[ORDRDat5_STATUS] FROM [DisalabData].[dbo].[ORDRDAT5] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new ORDRDAT5(
              row.DATESTAMP,
              row.PlacerOrderNo as string,
              row.RefNo as string,
              row.OrderStatus as string,
              row.CollectedDateTime,
              row.Labno as string,
              row.Region as string,
              row.HospitalNo as string,
              row.ORDRDat5_STATUS as DisaInput,
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

import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class HISDAT5 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  Location: string;
  HospitalNo: string;
  IDNo: string;
  _PatientID: string;
  _Name: string;
  _FamilyLastName: string;
  _MiddleName: string;
  _GivenName: string;
  Sex: string;
  Address: string;
  PhoneNumberBusiness: string;
  PhoneNumberHome: string;

  constructor(
    datestamp: unknown,
    location: string,
    hospitalno: string,
    idno: string,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.Location = location;
    this.HospitalNo = hospitalno;
    this.IDNo = idno;

    const data = Core.FixBytes(bytes);

    this._PatientID = Core.FixText(data, 5, 20);
    this._Name = Core.FixText(data, 21, 53);

    this._FamilyLastName = !Core.IsUndefinedOrNull(this._Name) ? this._Name.split(",")[0] ?? "" : "";
    this._MiddleName = !Core.IsUndefinedOrNull(this._Name) ? this._Name.split(",")[1] ?? "" : "";
    this._GivenName = !Core.IsUndefinedOrNull(this._Name) ? this._Name.split(",")[2] ?? "" : "";

    this.Sex = Core.FixText(data, 89, 90);
    this.Address = Core.FixText(data, 122, 723);
    this.PhoneNumberBusiness = Core.FixText(data, 814, 854);
    this.PhoneNumberHome = Core.FixText(data, 854, 894);
  }

  static async All(where: string, server: DisaServer): Promise<HISDAT5[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: HISDAT5[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[Location] ,[HospitalNo] ,[IDNo] ,[HISDat5_STATUS] FROM [DisalabData].[dbo].[HISDAT5] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          results.push(
            new HISDAT5(
              row.DATESTAMP,
              row.Location as string,
              row.HospitalNo as string,
              row.IDNo as string,
              row.HISDat5_STATUS as DisaInput,
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

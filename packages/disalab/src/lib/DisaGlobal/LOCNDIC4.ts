import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class LOCNDIC4 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  CODE: string | null;
  DESCRIPTION: string | null;
  ABBREV: string | null;
  TELEPHONE: string | null;
  NAME: string | null;
  POSTAL_ADDRESS1: string | null;
  POSTAL_ADDRESS2: string | null;
  POSTAL_ADDRESS3: string | null;
  POSTAL_ADDRESS4: string | null;
  POST_CODE: string | null;
  ORGANISATION: string | null;
  ACTIVE: unknown;
  District: string | null;
  FacilityType: string | null;
  FacilityArrangement: string | null;

  constructor(
    datestamp: unknown,
    code: string | null,
    description: string | null,
    abbrev: string | null,
    telephone: string | null,
    name: string | null,
    postal_address1: string | null,
    postal_address2: string | null,
    postal_address3: string | null,
    postal_address4: string | null,
    post_code: string | null,
    organisation: string | null,
    active: unknown,
    district: string | null,
    facilitytype: string | null,
    facilityarrangement: string | null,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.CODE = code;
    this.DESCRIPTION = description;
    this.ABBREV = abbrev;
    this.TELEPHONE = telephone;
    this.NAME = name;
    this.POSTAL_ADDRESS1 = postal_address1;
    this.POSTAL_ADDRESS2 = postal_address2;
    this.POSTAL_ADDRESS3 = postal_address3;
    this.POSTAL_ADDRESS4 = postal_address4;
    this.POST_CODE = post_code;
    this.ORGANISATION = organisation;
    this.ACTIVE = active;
    this.District = district;
    this.FacilityType = facilitytype;
    this.FacilityArrangement = facilityarrangement;

    Core.FixBytes(bytes);
  }

  static fromBytes(bytes: DisaInput): LOCNDIC4 {
    return new LOCNDIC4(
      null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null,
      bytes,
    );
  }

  static async All(where: string, server: DisaServer): Promise<LOCNDIC4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: LOCNDIC4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[CODE] ,[DESCRIPTION] ,[ABBREV] ,[TELEPHONE] ,[NAME] ,[POSTAL_ADDRESS1] ,[POSTAL_ADDRESS2] ,[POSTAL_ADDRESS3] ,[POSTAL_ADDRESS4] ,[POST_CODE] ,[ORGANISATION] ,[ACTIVE] ,[District] ,[FacilityType] ,[FacilityArrangement] ,[LOCNDIC4_STATUS] FROM [DisaGlobal].[dbo].[LOCNDIC4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          const item = new LOCNDIC4(
            row.DATESTAMP,
            row.CODE as string | null,
            row.DESCRIPTION as string | null,
            row.ABBREV as string | null,
            row.TELEPHONE as string | null,
            row.NAME as string | null,
            row.POSTAL_ADDRESS1 as string | null,
            row.POSTAL_ADDRESS2 as string | null,
            row.POSTAL_ADDRESS3 as string | null,
            row.POSTAL_ADDRESS4 as string | null,
            row.POST_CODE as string | null,
            row.ORGANISATION as string | null,
            row.ACTIVE,
            row.District as string | null,
            row.FacilityType as string | null,
            row.FacilityArrangement as string | null,
            row.LOCNDIC4_STATUS as DisaInput,
            server,
          );
          results.push(item);
        });
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

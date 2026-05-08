import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import { BaseValue } from "../basevalue.js";
import type { DisaServer } from "../types.js";

export class SYSTDIC5 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  ID: number | null | undefined;
  LABORATORY_NAME: string | null | undefined;
  Prefixes: BaseValue[] = [];

  constructor(
    datestamp: unknown,
    id: number | null | undefined,
    laboratory_name: string | null | undefined,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.ID = id;
    this.LABORATORY_NAME = laboratory_name;

    const data = Core.FixBytes(bytes);

    if (this.ID !== undefined && this.ID !== null && this.ID === 64) {
      let startAt = 5;
      for (let x = 0; x < 50; x++) {
        const prefix = data.substring(startAt, startAt + 4);
        this.Prefixes.push(new BaseValue(x + 1, prefix.substring(1, 4), String.fromCharCode(65 + x)));
        startAt += 4;
      }
    }
  }

  static fromBytes(bytes: DisaInput): SYSTDIC5 {
    return new SYSTDIC5(null, null, null, bytes);
  }

  static async All(where: string, server: DisaServer): Promise<SYSTDIC5[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: SYSTDIC5[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[ID] ,[LABORATORY_NAME] ,[SYSTDIC5_STATUS] FROM [DisaGlobal].[dbo].[SYSTDIC5] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          const item = new SYSTDIC5(
            row.DATESTAMP,
            row.ID as number | null | undefined,
            row.LABORATORY_NAME as string | null | undefined,
            row.SYSTDIC5_STATUS as DisaInput,
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

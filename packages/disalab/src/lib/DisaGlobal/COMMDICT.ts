import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class COMMDICT {
  readonly #server: DisaServer | undefined;
  Data: string;
  CONTEXT: unknown;
  CODE: unknown;
  DESCRIPTION: unknown;
  ACTIVE: unknown;

  constructor(
    context: unknown,
    code: unknown,
    description: unknown,
    active: unknown,
    data: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.Data = Core.FixBytes(data);
    this.CONTEXT = context;
    this.CODE = code;
    this.DESCRIPTION = description;
    this.ACTIVE = active;
  }

  static fromBytes(bytes: DisaInput): COMMDICT {
    return new COMMDICT(null, null, null, null, bytes);
  }

  static async All(where: string, server: DisaServer): Promise<COMMDICT[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: COMMDICT[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [CONTEXT] ,[CODE] ,[DESCRIPTION] ,[ACTIVE], [COMMDICT_STATUS]  FROM [DisaGlobal].[dbo].[COMMDICT] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          const item = new COMMDICT(
            row.CONTEXT,
            row.CODE,
            row.DESCRIPTION,
            row.ACTIVE,
            row.COMMDICT_STATUS as DisaInput,
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

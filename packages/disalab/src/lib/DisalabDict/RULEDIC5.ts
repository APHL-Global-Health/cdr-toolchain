import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import { RuleItem } from "../ruleitem.js";
import type { DisaServer } from "../types.js";

export class RULEDIC5 {
  readonly #server: DisaServer | undefined;
  Rules: RuleItem[] = [];
  DATESTAMP: unknown;
  CODE: string | null | undefined;

  constructor(
    datestamp: unknown,
    code: string | null | undefined,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.CODE = !Core.IsUndefinedOrNull(code) ? code.trim() : code;

    const data = Core.FixBytes(bytes);

    let startIndex = 20;
    for (let x = 0; x < 61; x++) {
      const command = data.substring(startIndex + 0, startIndex + 0 + 1);
      const unknown = data.substring(startIndex + 1, startIndex + 1 + 1);
      const rule = data.substring(startIndex + 2, startIndex + 2 + 30).trim();
      if (!Core.IsEmpty(command)) this.Rules.push(new RuleItem(command, unknown, rule));

      if (command === "X") break;
      startIndex += 32;
    }
  }

  static async All(where: string, server: DisaServer): Promise<RULEDIC5[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: RULEDIC5[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[CODE] ,[RULEDIC5_STATUS] FROM [DisalabDict].[dbo].[RULEDIC5] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          const item = new RULEDIC5(
            row.DATESTAMP,
            row.CODE as string | null | undefined,
            row.RULEDIC5_STATUS as DisaInput,
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

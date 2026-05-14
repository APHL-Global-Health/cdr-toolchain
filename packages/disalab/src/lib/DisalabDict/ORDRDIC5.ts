import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

export class ORDRDIC5 {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  CODE: string;
  LOCNCODE: string;
  USAGE: string;
  _CREATEDBY: string;
  ADDITIONAL_INFO: boolean;
  _CODE: string;
  _USAGE: string;
  _SECTION: string;
  _AREA: string;
  _GROUP: string;
  _STORAGE: string;
  _ROUTE: string;
  _LABS_ALLOWED: string;
  _RULES_ON_ORDER: string;
  _RULES_ON_RESULT: string;
  _RULES_ON_REVIEW: string;
  _Orders: string[] = [];

  constructor(
    datestamp: unknown,
    code: string,
    locncode: string,
    usage: string,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.CODE = code;
    this.LOCNCODE = locncode;
    this.USAGE = usage;

    const data = Core.FixBytes(bytes);

    this._CREATEDBY = Core.FixText(data, 4, 9);

    this.ADDITIONAL_INFO = false;
    const inf = Core.FixText(data, 14, 15);
    if (Core.IsEmpty(inf)) this.ADDITIONAL_INFO = true;
    else if (inf[0] === "") this.ADDITIONAL_INFO = false;

    this._CODE = Core.FixText(data, 15, 20);
    this._USAGE = Core.FixText(data, 25, 26);
    this._SECTION = Core.FixText(data, 38, 43);
    this._AREA = Core.FixText(data, 43, 48);
    this._GROUP = Core.FixText(data, 48, 49);
    this._STORAGE = Core.FixText(data, 58, 63);
    this._ROUTE = Core.FixText(data, 63, 64);
    const _ORDERS = Core.FixString(data, 64, 860);
    this._LABS_ALLOWED = Core.FixText(data, 907, 967);
    this._RULES_ON_ORDER = Core.FixText(data, 967, 972);
    this._RULES_ON_RESULT = Core.FixText(data, 977, 982);
    this._RULES_ON_REVIEW = Core.FixText(data, 982, 988);

    if (!Core.IsEmpty(_ORDERS)) {
      let startIndex = 0;
      const len = (860 - 64) / 5;
      for (let x = 0; x < len; x++) {
        const para = _ORDERS.substring(startIndex, startIndex + 5);
        if (!Core.IsEmpty(para.trim())) this._Orders.push(para.trim());
        startIndex += 5;
      }
    }
  }

  static async All(where: string, server: DisaServer): Promise<ORDRDIC5[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: ORDRDIC5[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[CODE] ,[LOCNCODE] ,[USAGE] ,[ORDRDIC5_STATUS] FROM [DisalabDict].[dbo].[ORDRDIC5] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        list.forEach((row: Record<string, unknown>) => {
          const item = new ORDRDIC5(
            row.DATESTAMP,
            row.CODE as string,
            row.LOCNCODE as string,
            row.USAGE as string,
            row.ORDRDIC5_STATUS as DisaInput,
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

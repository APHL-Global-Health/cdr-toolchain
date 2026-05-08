import mssql from "mssql";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import { Order } from "../order.js";
import { OrderItem } from "../orderitem.js";
import type { DisaServer } from "../types.js";

export class TESTDATA {
  readonly #server: DisaServer | undefined;
  DATESTAMP: unknown;
  LABNO: string;
  TESTCODE: string;
  TESTINDEX: unknown;
  ORDER: Order<OrderItem> | OrderItem[] = [];

  constructor(
    datestamp: unknown,
    labno: string,
    testcode: string,
    testindex: unknown,
    _bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.LABNO = labno;
    this.TESTCODE = testcode;
    this.TESTINDEX = testindex;
  }

  async initialize(bytes: DisaInput): Promise<void> {
    if (this.#server === undefined) return;
    const _data = Core.ConvertToBytes(bytes);
    this.ORDER = await OrderItem.Parse(
      this.LABNO,
      this.TESTCODE,
      this.TESTINDEX,
      Core.FixString(_data, 80, _data.length).trim(),
      this.#server,
    );
  }

  static async create(
    datestamp: unknown,
    labno: string,
    testcode: string,
    testindex: unknown,
    bytes: DisaInput,
    server: DisaServer,
  ): Promise<TESTDATA> {
    const test = new TESTDATA(datestamp, labno, testcode, testindex, bytes, server);
    await test.initialize(bytes);
    return test;
  }

  static async All(where: string, server: DisaServer): Promise<TESTDATA[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: TESTDATA[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [DATESTAMP] ,[LABNO] ,[TESTCODE] ,[TESTINDEX], [TESTDATA_STATUS] FROM [DisalabData].[dbo].[TESTDATA] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await mssql.connect(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        for (const row of list as Record<string, unknown>[]) {
          const item = await TESTDATA.create(
            row.DATESTAMP,
            row.LABNO as string,
            row.TESTCODE as string,
            row.TESTINDEX,
            row.TESTDATA_STATUS as DisaInput,
            server,
          );
          results.push(item);
        }
      } catch (err) {
        throw err;
      }
    }

    return results;
  }
}

import mssql from "mssql";
import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import { Order } from "../order.js";
import { TXT1DATA } from "./TXT1DATA.js";
import type { DisaServer } from "../types.js";

export interface StreamCallbacks {
  on_row: (pool: mssql.ConnectionPool, row: REGDAT4) => void | Promise<void>;
  on_error: (pool: mssql.ConnectionPool, err: Error) => void;
  on_done: (pool: mssql.ConnectionPool, result: unknown) => void;
  on_recordset: (pool: mssql.ConnectionPool, columns: unknown) => void;
  on_rowsaffected: (pool: mssql.ConnectionPool, rowCount: number) => void;
}

export class REGDAT4 {
  readonly #server: DisaServer | undefined;
  LabNumber: string;

  Index!: number;
  UniqueID!: string;
  RegisteredDatetime!: string | null;
  ReferenceNumber!: string;
  ReceivedInLabDateTime!: string | null;
  CollectedDatetime!: string | null;
  TakenDateTime!: string | null;
  ReceivedBy!: string;
  ModifiedBy!: string;
  InnerLabNumber!: string;
  RefNos!: string;
  NID!: string;
  Location!: string;
  WardClinic!: string;
  FolderNumber!: string;
  Name!: string;
  DobAge!: string | null;
  Sex!: string;
  Surname!: string;
  Middlename!: string;
  Firstname!: string;
  Specimen!: string;
  Condition!: string;
  Priority!: string;
  Therapy!: string;
  Notes!: string;
  DiagCln!: string;
  Ref_Dr_ID!: string;
  Ref_Dr!: string;
  Receipt!: string;
  Amount!: number | string;
  PaidBy!: string;

  Tests: Order<unknown>[] = [];
  TestOrders: unknown[] = [];

  CollectedBy?: string;
  TakenBy?: string;
  ReceivedInLabBy?: string;
  Phone?: string;
  Work?: string;
  Mobile?: string;
  Email?: string;
  Ref_Dr_Mobile?: string;
  Ref_Dr_Email?: string;
  Ref_Dr_Phone?: string;
  Ref_Dr_Fax?: string;
  PostalAddress1?: string;
  PostalAddress2?: string;
  PostalAddress3?: string;
  NotesText?: string;
  TherapyText?: string;
  DiagClnText?: string;
  ICD10?: string;
  SpecimenText?: string;

  constructor(labNumber: string, bytes: DisaInput, server?: DisaServer) {
    this.#server = server;
    this.LabNumber = labNumber;
    this.Populate(bytes);
  }

  static async create(labNumber: string, bytes: DisaInput, server: DisaServer): Promise<REGDAT4> {
    const instance = new REGDAT4(labNumber, bytes, server);
    await instance.Init(bytes);
    return instance;
  }

  Populate(bytes: DisaInput): void {
    const data = Core.FixBytes(bytes);

    this.Index = Core.DisaUIntValue(bytes, 5, 8);
    this.UniqueID = Core.FixText(data, 32, 41);
    this.RegisteredDatetime = Core.Trim(Core.DisaDatetimeValue(bytes, 126, 130, 132, 134));
    this.ReferenceNumber = Core.FixText(data, 66, 121);
    this.ReceivedInLabDateTime = Core.Trim(Core.DisaDatetimeValue(bytes, 666, 670, 154, 156));
    this.CollectedDatetime = Core.Trim(Core.DisaDatetimeValue(bytes, 159, 163, 163, 165));
    this.TakenDateTime = Core.Trim(Core.DisaDatetimeShortValue(bytes, 615, 619));
    this.ReceivedBy = Core.FixText(data, 135, 138);
    this.ModifiedBy = Core.FixText(data, 139, 142);

    this.InnerLabNumber = Core.FixText(data, 12, 22);
    this.RefNos = Core.FixText(data, 66, 121);
    this.NID = Core.FixText(data, 393, 408);
    this.Location = Core.FixText(data, 421, 426);
    this.WardClinic = Core.FixText(data, 442, 448);
    this.FolderNumber = Core.FixText(data, 427, 442);
    this.Name = Core.FixText(data, 348, 392);
    this.DobAge = Core.Trim(Core.DisaDateOfBirthOrAgeValue(bytes, 159, 163, 163, 165));
    this.Sex = Core.FixText(data, 420, 421);

    this.Surname = "";
    this.Middlename = "";
    this.Firstname = "";
    if (!Core.IsNullOrEmpty(this.Name)) {
      const names = this.Name.split(",");
      if (names.length > 0) this.Surname = names[0] ?? "";
      if (names.length > 1) this.Middlename = names[1] ?? "";
      if (names.length > 2) this.Firstname = names[2] ?? "";
    }

    this.Specimen = Core.FixText(data, 148, 153);
    this.Condition = Core.FixText(data, 548, 553);
    this.Priority = Core.FixText(data, 186, 187);

    this.Therapy = Core.FixText(data, 340, 344);
    this.Notes = Core.FixText(data, 174, 179);
    this.DiagCln = Core.FixText(data, 334, 339);

    this.Ref_Dr_ID = Core.FixText(data, 507, 511);
    this.Ref_Dr = Core.FixText(data, 513, 548);

    this.Receipt = Core.FixText(data, 653, 665);
    this.Amount = Core.DisaBitValue(bytes, 61, 65);
    this.PaidBy = Core.FixText(data, 482, 507);
  }

  async Init(bytes: DisaInput): Promise<void> {
    Core.FixBytes(bytes);

    this.Tests = [];
    this.TestOrders = [];

    const data = Core.FixBytes(bytes);
    let startIndex = 187;
    for (let x = 0; x < 20; x++) {
      const test = data.substring(startIndex, startIndex + 7);
      if (test.substring(0, 5).trim().length > 0)
        this.Tests.push(new Order(test.substring(0, 5).trim(), []));
      startIndex += 7;
    }

    if (this.#server === undefined) return;

    const all_with_id = await TXT1DATA.All(`WHERE [LABNO] = '${this.LabNumber}'`, this.#server);
    for (const txt of all_with_id) {
      if (txt.FRAMEREF === 63) {
        const items = txt.VALUE.split("|");
        if (items.length > 0) this.CollectedBy = items[0]!.trim();
        if (items.length > 1) this.TakenBy = items[1]!.trim();
        if (items.length > 2) this.ReceivedInLabBy = items[2]!.trim();
      } else if (txt.FRAMEREF === 61) {
        const items = txt.VALUE.split("|");
        if (items.length > 0) this.Phone = items[0]!.trim();
        if (items.length > 1) this.Work = items[1]!.trim();
        if (items.length > 2) this.Mobile = items[2]!.trim();
        if (items.length > 3) this.Email = items[3]!.trim();
      } else if (txt.FRAMEREF === 53) {
        const items = txt.VALUE.split("|");
        if (items.length > 2) this.Ref_Dr_Mobile = items[2]!.trim();
        if (items.length > 3) this.Ref_Dr_Email = items[3]!.trim();
      } else if (txt.FRAMEREF === 52) {
        const items = txt.VALUE.split("|");
        if (items.length > 2) this.Ref_Dr_Phone = items[2]!.trim();
        if (items.length > 4) this.Ref_Dr_Fax = items[4]!.trim();
      } else if (txt.FRAMEREF === 48 || txt.FRAMEREF === 49) {
        if (txt.TESTCODE === ".....") this.PostalAddress3 = txt.VALUE.trim();
      } else if (txt.FRAMEREF === 47) {
        if (txt.TESTCODE === ".....") this.PostalAddress2 = txt.VALUE.trim();
      } else if (txt.FRAMEREF === 46) {
        if (txt.TESTCODE === ".....") this.PostalAddress1 = txt.VALUE.trim();
      } else if (txt.FRAMEREF === 31) {
        if (txt.TESTCODE === ".....") this.NotesText = txt.VALUE.trim();
      } else if (txt.FRAMEREF === 21) {
        if (txt.TESTCODE === ".....") this.TherapyText = txt.VALUE.trim();
      } else if (txt.FRAMEREF === 12) {
        if (txt.TESTCODE === ".....") this.DiagClnText = txt.VALUE.trim();
      } else if (txt.FRAMEREF === 11) {
        if (txt.TESTCODE === ".....") this.ICD10 = txt.VALUE.trim();
      } else if (txt.FRAMEREF === 1) {
        if (txt.TESTCODE === ".....") this.SpecimenText = txt.VALUE.trim();
      }
    }
  }

  static async All(where: string, server: DisaServer): Promise<REGDAT4[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: REGDAT4[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT [LabNo], [REGDAT4_STATUS] FROM [DisalabData].[dbo].[REGDAT4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;

        for (const row of list as Record<string, unknown>[]) {
          const item = await REGDAT4.create(
            row.LabNo as string,
            row.REGDAT4_STATUS as DisaInput,
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

  static async LabNumbers(where: string, server: DisaServer): Promise<string[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    let results: string[] = [];

    if (DB_DRIVER === "mssql") {
      try {
        const sql = `SELECT distinct [LabNo] FROM [DisalabData].[dbo].[REGDAT4] ${!Core.IsEmpty(where) ? where : ""}`;
        const pool = await getPool(DB_URI);
        const list = (await pool.request().query(sql)).recordset;
        results = list.map((l: Record<string, unknown>) => l.LabNo as string);
      } catch (error) {
        throw error;
      }
    }

    return results;
  }

  static async Stream(where: string, server: DisaServer, callback: StreamCallbacks): Promise<void> {
    const DB_URI = server.config.database.connection_string;

    const sql = `SELECT [LabNo], [REGDAT4_STATUS] FROM [DisalabData].[dbo].[REGDAT4] ${!Core.IsEmpty(where) ? where : ""}`;

    let rows: REGDAT4[] = [];

    const pool = await getPool(DB_URI);
    const request = pool.request();
    request.stream = true;
    request.query(sql);

    const process_rows = (): void => {
      for (const r of rows) {
        void callback.on_row(pool, r);
      }
      rows = [];
      request.resume();
    };

    request.on("row", async (row: Record<string, unknown>) => {
      request.pause();
      const item = await REGDAT4.create(
        row.LabNo as string,
        row.REGDAT4_STATUS as DisaInput,
        server,
      );
      rows.push(item);
      process_rows();
    });

    request.on("error", (err: Error) => {
      callback.on_error(pool, err);
    });

    request.on("done", (result: unknown) => {
      process_rows();
      callback.on_done(pool, result);
    });

    request.on("recordset", (columns: unknown) => {
      callback.on_recordset(pool, columns);
    });

    request.on("rowsaffected", (rowCount: number) => {
      callback.on_rowsaffected(pool, rowCount);
    });
  }
}

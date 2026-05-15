import * as Core from "../core.js";
import { Facility } from "../facility.js";

import { AUDTDATA } from "../DisalabData/AUDTDATA.js";
import { LOCNDIC4 } from "../DisaGlobal/LOCNDIC4.js";
import { RDOBIDX4 } from "../DisalabData/RDOBIDX4.js";
import { REGDAT4 } from "../DisalabData/REGDAT4.js";
import { RTKNIDX5 } from "../DisalabData/RTKNIDX5.js";
import { TESTDATA } from "../DisalabData/TESTDATA.js";
import type { DisaServer } from "../types.js";

export class SpecimenRecpt {
  readonly #server: DisaServer | undefined;
  LabNumber: string;

  InnerLabNumber: string | null = null;
  ReferenceNumber: string | null = null;
  NID: string | null = null;
  Facility: Facility | null = null;
  WardClinic: string | null = null;
  FolderNo: string | null = null;
  LastName: string | null = null;
  MiddleName: string | null = null;
  FirstName: string | null = null;
  Sex: string | null = null;
  Phone: string | null = null;
  Work: string | null = null;
  Mobile: string | null = null;
  Email: string | null = null;
  Address: string | null = "";

  ICD10: string | null = null;
  Therapy: string | null = null;
  TherapyText: string | null = null;
  Notes: string | null = null;
  NotesText: string | null = null;
  ClinicalDiagnosis: string | null = null;
  ClinicalDiagnosisText: string | null = null;

  Specimen: string | null = null;
  SpecimenInfo: string | null = null;
  Condition: string | null = null;
  TakenDateTime: string | null = null;
  TakenBy: string | null = null;
  CollectedDateTime: string | null = null;
  CollectedBy: string | null = null;
  ReceivedInLabDateTime: string | null = null;
  ReceivedInLabBy: string | null = null;
  RegisteredDateTime: string | null = null;
  Priority: string | null = null;

  DoctorCode: string | null = null;
  Doctor: string | null = null;
  DoctorPhone: string | null = null;
  DoctorFax: string | null = null;
  DoctorMobile: string | null = null;
  DoctorEmail: string | null = null;

  Receipt: string | null = null;
  Amount: number | string | null = null;
  PaidBy: string | null = null;

  DobAge: string | null = null;

  TestOrders: unknown[] = [];
  TestResults: TESTDATA[] = [];

  constructor(labno: string, server?: DisaServer) {
    this.#server = server;
    this.LabNumber = labno;
  }

  static async Fetch(regdat4: REGDAT4, server: DisaServer): Promise<SpecimenRecpt | null> {
    const DB_DRIVER = server.config.database.driver;

    if (DB_DRIVER !== "mssql") return null;

    try {
      const labno = regdat4.LabNumber;
      const labnoEsc = Core.SqlEscape(labno);
      const audtdata = await AUDTDATA.All(
        `WHERE [LabNo] = '${labnoEsc}' ORDER BY  [DATESTAMP] desc`,
        server,
      );
      const rdobidx4 = await RDOBIDX4.All(`WHERE [LabNo] = '${labnoEsc}'`, server);
      const rtknidx5 = await RTKNIDX5.All(`WHERE [INVOICENO] = '${labnoEsc}'`, server);

      const r = new SpecimenRecpt(labno, server);

      r.InnerLabNumber = regdat4.InnerLabNumber;
      r.ReferenceNumber = regdat4.ReferenceNumber;
      r.NID = regdat4.NID;

      if (Core.IsNullOrEmpty(r.InnerLabNumber)) r.InnerLabNumber = null;
      if (Core.IsNullOrEmpty(r.ReferenceNumber)) r.ReferenceNumber = null;
      if (Core.IsNullOrEmpty(r.NID)) r.NID = null;

      if (!Core.IsEmpty(regdat4.Location)) {
        const locndic4List = await LOCNDIC4.All(`WHERE [CODE] = '${Core.SqlEscape(regdat4.Location)}'`, server);
        if (locndic4List !== null && locndic4List.length > 0) {
          const location = locndic4List[0]!;
          r.Facility = new Facility(
            location.CODE ?? "",
            location.DESCRIPTION ?? "",
            location.POSTAL_ADDRESS1 ?? "",
            location.POSTAL_ADDRESS2 ?? "",
            location.POSTAL_ADDRESS3 ?? "",
            location.POSTAL_ADDRESS4 ?? "",
            server,
          );
        } else {
          r.Facility = new Facility(regdat4.Location, "", "", "", "", "", server);
        }
      } else {
        r.Facility = new Facility(regdat4.Location, "", "", "", "", "", server);
      }

      r.WardClinic = regdat4.WardClinic;
      r.FolderNo = regdat4.FolderNumber;

      if (Core.IsNullOrEmpty(r.WardClinic)) r.WardClinic = null;
      if (Core.IsNullOrEmpty(r.FolderNo)) r.FolderNo = null;

      if (audtdata !== null) {
        for (const au of audtdata) {
          if (au._AuditCode === "WS203") {
            if (!Core.IsEmpty(au._Auditdata)) {
              const names = au._Auditdata.split(",");
              if (names.length > 0) r.LastName = names[0]!;
              if (names.length > 2) r.FirstName = names[2]!;
              break;
            }
          }
        }
        if (Core.IsNullOrEmpty(r.LastName)) r.LastName = regdat4.Surname;
        if (Core.IsNullOrEmpty(r.FirstName)) r.FirstName = regdat4.Firstname;

        if (Core.IsNullOrEmpty(r.LastName)) r.LastName = null;
        if (Core.IsNullOrEmpty(r.FirstName)) r.FirstName = null;
      } else {
        r.LastName = regdat4.Surname;
        r.FirstName = regdat4.Firstname;
      }

      r.Sex = regdat4.Sex;
      r.Phone = regdat4.Phone ?? null;
      r.Work = regdat4.Work ?? null;
      r.Mobile = regdat4.Mobile ?? null;
      r.Email = regdat4.Email ?? null;
      r.Address = Core.IsNullOrEmpty(regdat4.PostalAddress1)
        ? "\r\n"
        : Core.Trim(regdat4.PostalAddress1!) + "\r\n";
      r.Address += Core.IsNullOrEmpty(regdat4.PostalAddress2)
        ? "\r\n"
        : Core.Trim(regdat4.PostalAddress2!) + "\r\n";
      r.Address += Core.IsNullOrEmpty(regdat4.PostalAddress3)
        ? "\r\n"
        : Core.Trim(regdat4.PostalAddress3!) + "\r\n";

      if (Core.IsNullOrEmpty(r.Sex)) r.Sex = null;

      if (
        Core.IsNullOrEmpty(regdat4.PostalAddress1) &&
        Core.IsNullOrEmpty(regdat4.PostalAddress2) &&
        Core.IsNullOrEmpty(regdat4.PostalAddress3)
      ) {
        r.Address = null;
      }

      r.ICD10 = regdat4.ICD10 ?? null;
      r.Therapy = regdat4.Therapy;
      r.TherapyText = regdat4.TherapyText ?? null;
      r.Notes = regdat4.Notes;
      r.NotesText = regdat4.NotesText ?? null;
      r.ClinicalDiagnosis = regdat4.DiagCln;
      r.ClinicalDiagnosisText = regdat4.DiagClnText ?? null;

      if (Core.IsNullOrEmpty(r.Therapy)) r.Therapy = null;
      if (Core.IsNullOrEmpty(r.Notes)) r.Notes = null;
      if (Core.IsNullOrEmpty(r.ClinicalDiagnosis)) r.ClinicalDiagnosis = null;

      r.Specimen = regdat4.Specimen;
      r.SpecimenInfo = regdat4.SpecimenText ?? null;
      r.Condition = regdat4.Condition;
      r.TakenDateTime = regdat4.TakenDateTime;
      r.TakenBy = regdat4.TakenBy ?? null;
      r.CollectedDateTime = regdat4.CollectedDatetime;
      r.CollectedBy = regdat4.CollectedBy ?? null;
      r.ReceivedInLabDateTime = regdat4.ReceivedInLabDateTime;
      r.ReceivedInLabBy = regdat4.ReceivedInLabBy ?? null;
      r.RegisteredDateTime = regdat4.RegisteredDatetime;
      r.Priority = regdat4.Priority;

      if (Core.IsNullOrEmpty(r.Specimen)) r.Specimen = null;
      if (Core.IsNullOrEmpty(r.FolderNo)) r.FolderNo = null;
      if (Core.IsNullOrEmpty(r.Condition)) r.Condition = null;
      if (Core.IsNullOrEmpty(r.TakenDateTime)) r.TakenDateTime = null;
      if (Core.IsNullOrEmpty(r.TakenBy)) r.TakenBy = null;
      if (Core.IsNullOrEmpty(r.CollectedDateTime)) r.CollectedDateTime = null;
      if (Core.IsNullOrEmpty(r.CollectedBy)) r.CollectedBy = null;
      if (Core.IsNullOrEmpty(r.ReceivedInLabDateTime)) r.ReceivedInLabDateTime = null;
      if (Core.IsNullOrEmpty(r.ReceivedInLabBy)) r.ReceivedInLabBy = null;
      if (Core.IsNullOrEmpty(r.RegisteredDateTime)) r.RegisteredDateTime = null;
      if (Core.IsNullOrEmpty(r.Priority)) r.Priority = null;

      r.DoctorCode = regdat4.Ref_Dr_ID;
      r.Doctor = regdat4.Ref_Dr;
      r.DoctorPhone = regdat4.Ref_Dr_Phone ?? null;
      r.DoctorFax = regdat4.Ref_Dr_Fax ?? null;
      r.DoctorMobile = regdat4.Ref_Dr_Mobile ?? null;
      r.DoctorEmail = regdat4.Ref_Dr_Email ?? null;

      if (Core.IsNullOrEmpty(r.Doctor)) r.Doctor = null;
      if (Core.IsNullOrEmpty(r.DoctorCode)) r.DoctorCode = null;

      r.Receipt = regdat4.Receipt;
      r.Amount = null;
      r.PaidBy = regdat4.PaidBy;

      if (Core.IsNullOrEmpty(r.Receipt)) r.Receipt = null;
      if (Core.IsNullOrEmpty(r.PaidBy)) r.PaidBy = null;

      if (rdobidx4 !== null && rdobidx4.length > 0) r.DobAge = rdobidx4[0]!.DOBDATE as string | null;
      if (Core.IsNullOrEmpty(r.DobAge)) r.DobAge = regdat4.DobAge;
      if (Core.IsNullOrEmpty(r.DobAge)) r.DobAge = null;

      // RTKNIDX5.TAKENDATE is a date-only column (midnight), so prefer
      // REGDAT4.TakenDateTime (which carries the time too) when it parses;
      // only fall back to the index if REGDAT4 didn't decode anything.
      if (
        Core.IsNullOrEmpty(r.TakenDateTime) &&
        rtknidx5 !== null &&
        rtknidx5.length > 0
      ) {
        r.TakenDateTime = rtknidx5[0]!.TAKENDATE as string | null;
      }

      regdat4.Tests.forEach((test) => {
        if (!Core.IsNullOrEmpty(test.CODE)) r.TestOrders.push(test.CODE);
      });

      r.TestResults = await TESTDATA.All(`WHERE [LabNo] = '${labnoEsc}'`, server);
      return r;
    } catch (error) {
      throw error;
    }

    return null;
  }

  static async All(where: string, server: DisaServer): Promise<SpecimenRecpt[]> {
    const list: SpecimenRecpt[] = [];

    const regs = await REGDAT4.All(where, server);
    for (const item of regs) {
      const r = await this.Fetch(item, server);
      if (r !== null) list.push(r);
    }

    return list;
  }

  static async Stream(
    where: string,
    server: DisaServer,
    callback: {
      on_recordset: (pool: unknown, columns: unknown) => void;
      on_rowsaffected: (pool: unknown, rowCount: number) => void;
      on_error: (pool: unknown, err: Error) => void;
      on_done: (pool: unknown, result: unknown) => void;
    },
  ): Promise<void> {
    return REGDAT4.Stream(where, server, {
      on_row: async (_pool, row) => {
        const item = await SpecimenRecpt.Fetch(row, server);
        console.log(item);
      },
      on_recordset: (pool, columns) => callback.on_recordset(pool, columns),
      on_rowsaffected: (pool, rowCount) => callback.on_rowsaffected(pool, rowCount),
      on_error: (pool, err) => callback.on_error(pool, err),
      on_done: (pool, result) => callback.on_done(pool, result),
    });
  }
}

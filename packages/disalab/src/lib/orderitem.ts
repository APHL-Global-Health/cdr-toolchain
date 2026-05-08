import * as Core from "./core.js";
import { Order } from "./order.js";
import { BitConverter } from "./bitconverter.js";
import { COMMDICT } from "./DisaGlobal/COMMDICT.js";
import { PARMDICT } from "./DisaGlobal/PARMDICT.js";
import { TXT1DATA } from "./DisalabData/TXT1DATA.js";
import type { DisaServer } from "./types.js";

export class OrderItem {
  readonly #server: DisaServer | undefined;
  Type: string;
  Code: string;
  Value: string | number;
  /**
   * The raw result value before any PARMDICT/COMMDICT/TXT1DATA rewriting.
   * For Coded Comment types (3), this holds the original code (e.g. "NONE")
   * while `Value` holds the decoded description ("No ART given to child").
   * v1's LabResults sometimes stores the code, sometimes the description,
   * so downstream comparators benefit from having both.
   */
  RawValue: string;
  ResultType: unknown;
  Description: string | null | undefined;
  IsResulted: boolean;

  constructor(
    type: unknown,
    code: string,
    value: string,
    resulttype: unknown,
    description: string | null | undefined,
    rawValue?: string,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.Type = this.CovertToChar(type);
    this.Code = Core.Trim(code.replace(/\0/g, ""));
    this.Value = Core.Trim(value.replace(/\0/g, ""));
    // Do NOT JS-trim RawValue: for binary-typed slots (Date, Time), certain
    // byte values like 0x0C (form feed, used for day=12) are JS-whitespace
    // and would get stripped, corrupting the decode. Just drop NULs.
    this.RawValue = (rawValue ?? value).replace(/\0/g, "");
    this.ResultType = resulttype;
    this.Description = description;

    this.IsResulted = value !== null && !Core.IsEmpty(Core.Trim(value.replace(/\0/g, "")));

    const isNumericType =
      type === 1 ||
      type === 2 ||
      type === "Real" ||
      type === "Integer" ||
      type === "Accounting";
    if (isNumericType && this.IsResulted) {
      const converter = new BitConverter();
      this.Value = converter.ToSingle(value);
    }

    // Date type (7): 4-byte slot decoded via Core.FromDisaDate. Use raw
    // non-trimmed bytes — JS .trim() strips 0x0C (form feed / day=12),
    // 0x0A (newline / day=10), etc., leaving the date undecodable.
    const isDateType = type === 7 || type === "Date";
    if (isDateType && this.IsResulted) {
      const raw = (rawValue ?? value).replace(/\0/g, "");
      if (raw.length >= 4) {
        const d = Core.FromDisaDate(raw.substring(0, 4));
        if (d !== null && !Number.isNaN(d.getTime())) {
          const dd = String(d.getDate()).padStart(2, "0");
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          this.Value = `${dd}/${mm}/${d.getFullYear()}`;
        }
      }
    }
  }

  CovertToChar(type: unknown): string {
    if (type === "Extended (flexible type)") return String.fromCharCode(0);
    if (type === "Real" || type === "Integer") return String.fromCharCode(1);
    if (type === "Accounting") return String.fromCharCode(2);
    if (type === "Coded Comment" || type === "Qualified Comment") return String.fromCharCode(3);
    if (type === "Short Text") return String.fromCharCode(4);
    if (type === "Text") return String.fromCharCode(5);
    if (type === "Graphic") return String.fromCharCode(6);
    if (type === "Date") return String.fromCharCode(7);
    if (type === "Time") return String.fromCharCode(8);
    if (type === "Header") return String.fromCharCode(9);
    if (type === "Letter") return String.fromCharCode(0);
    if (type === "Snomed") return String.fromCharCode(11);
    if (type === "ICD10") return String.fromCharCode(12);
    if (typeof type === "number") return String.fromCharCode(type);
    return String(type);
  }

  static async Parse(
    labnumber: string,
    code: string,
    testIndex: unknown,
    data: string,
    server: DisaServer,
  ): Promise<Order<OrderItem>> {
    const list: OrderItem[] = [];

    let index = 0;
    let frameRef = 1;
    let startIndex = 0;
    while (startIndex + 12 < data.length && index < 50) {
      index++;
      frameRef++;
      const par = data.substring(startIndex, startIndex + 5);
      if (!Core.IsNullOrEmpty(par.replace(/\0/g, " ").trim())) {
        const type = data.substring(startIndex + 5, startIndex + 5 + 1).charCodeAt(0);
        const resulted = data.substring(startIndex + 5, startIndex + 5 + 1).charCodeAt(0);
        let result = data.substring(startIndex + 7, startIndex + 7 + 5);
        const rawResult = result;

        let description: string | null = null;
        if (!Core.IsEmpty(code) && !Core.IsUndefinedOrNull(server)) {
          const parmdictList = await PARMDICT.All(
            `WHERE [CODE] = '${par.replace(/\0/g, " ").trim()}'`,
            server,
          );
          if (parmdictList.length > 0) {
            const parmdict = parmdictList[0]!;
            description = parmdict.DESCRIPTION;

            const textDataList = await TXT1DATA.All(
              `WHERE [LABNO] = '${labnumber}' AND [TESTCODE] = '${code}' AND [TESTINDEX] = '${testIndex}' AND [FRAMEREF] = '${frameRef}' `,
              server,
            );
            const textData = textDataList[0];
            if (textData !== undefined && !Core.IsEmpty(textData.VALUE)) {
              const vals = textData.VALUE.split("º");
              if (vals.length > 0) result = vals[0]!;
            } else if (
              parmdict.CONTEXT !== -1 &&
              !Core.IsEmpty(result) &&
              !Core.IsEmpty(result.replace(/\0/g, " "))
            ) {
              const comdictList = await COMMDICT.All(
                `WHERE [CONTEXT] = '${parmdict.CONTEXT}' AND LTRIM(RTRIM([CODE])) = '${result.trim()}'`,
                server,
              );
              if (comdictList.length > 0) {
                const comdict = comdictList[0]!;
                if (!Core.IsEmpty(comdict.DESCRIPTION)) result = String(comdict.DESCRIPTION);
              }
            }
          }
        }

        list.push(new OrderItem(type, par.trim(), result, resulted, description, rawResult));
      }

      startIndex += 12;
    }

    return new Order<OrderItem>(code, list);
  }
}

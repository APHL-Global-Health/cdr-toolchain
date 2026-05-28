import { getPool } from "../pool.js";
import * as Core from "../core.js";
import type { DisaInput } from "../core.js";
import type { DisaServer } from "../types.js";

/**
 * Ward dictionary — composite key (CODE1, CODE2) mapping a facility code +
 * ward/program code to a human description. Unlike LOCNDIC4 (single CODE),
 * WARDDICT is two-axis: CODE1 is typically a facility abbreviation (5 chars,
 * space-padded) and CODE2 is the ward or clinical-service code under that
 * facility. CODE1 = "@@@@@" (5 '@' characters) is a sentinel for facility-
 * agnostic entries.
 *
 * In Mozambique's data, DESCRIPTION and ABBREV columns are NULL on disk —
 * the readable values are packed into WARDDICT_STATUS as length-prefixed
 * strings (0x1B + description, 0x0A + abbrev). Callers that need the
 * description must decode the blob; this wrapper just exposes the raw
 * columns and the blob bytes.
 */
// Byte offsets inside WARDDICT_STATUS. Layout:
//   [0..3]   datestamp / hash header
//   [4..8]   CODE1 (5 bytes, space-padded for short codes)
//   [9..13]  CODE2 (5 bytes, null-padded for short codes)
//   [14]     description length L (u8)
//   [15..]   description (L bytes, latin1)
//   [15+L]   abbrev length M (u8)
//   [16+L..] abbrev (M bytes, latin1)
//   then a duplicate (previous-value) copy, padding, and active flags.
// Verified against an ALBAZ+SAAJS row that decodes to
// "Serviço Amigo de Adolescentes" / "ALBAZ/SAAJ".
const STATUS_DESC_LEN_OFFSET = 14;

export class WARDDICT {
  readonly #server: DisaServer | undefined;
  readonly #bytes: string;
  DATESTAMP: unknown;
  CODE1: string | null;
  CODE2: string | null;
  DESCRIPTION: string | null;
  ABBREV: string | null;

  constructor(
    datestamp: unknown,
    code1: string | null,
    code2: string | null,
    description: string | null,
    abbrev: string | null,
    bytes: DisaInput,
    server?: DisaServer,
  ) {
    this.#server = server;
    this.DATESTAMP = datestamp;
    this.CODE1 = code1;
    this.CODE2 = code2;
    this.DESCRIPTION = description;
    this.ABBREV = abbrev;
    // Hold the raw blob as a latin1 byte-string for later decode. Empty
    // string when the blob is null/empty so decoded* return null cleanly.
    this.#bytes =
      bytes === null || bytes === undefined ? "" : Core.ConvertToBytes(bytes);

    Core.FixBytes(bytes);
  }

  /**
   * Effective DESCRIPTION: returns the column when populated, otherwise
   * decodes the length-prefixed string at byte 14 of WARDDICT_STATUS.
   * Mozambique stores DESCRIPTION only in the blob (0/25,897 rows have the
   * column populated), so this is the primary access path for Moz compare.
   */
  decodedDescription(): string | null {
    if (this.DESCRIPTION !== null && this.DESCRIPTION.trim().length > 0) {
      return this.DESCRIPTION;
    }
    if (this.#bytes.length <= STATUS_DESC_LEN_OFFSET) return null;
    const len = this.#bytes.charCodeAt(STATUS_DESC_LEN_OFFSET);
    if (len === 0 || this.#bytes.length < STATUS_DESC_LEN_OFFSET + 1 + len) {
      return null;
    }
    const desc = this.#bytes
      .slice(STATUS_DESC_LEN_OFFSET + 1, STATUS_DESC_LEN_OFFSET + 1 + len)
      .trim();
    return desc.length > 0 ? desc : null;
  }

  /**
   * Effective ABBREV: column wins, otherwise the second length-prefixed
   * string immediately after the description. In Moz the abbrev is the
   * fixed format `CODE1/CODE2_first4` (e.g. "ALBAZ/SAAJ").
   */
  decodedAbbrev(): string | null {
    if (this.ABBREV !== null && this.ABBREV.trim().length > 0) {
      return this.ABBREV;
    }
    if (this.#bytes.length <= STATUS_DESC_LEN_OFFSET) return null;
    const descLen = this.#bytes.charCodeAt(STATUS_DESC_LEN_OFFSET);
    const abbrevLenOffset = STATUS_DESC_LEN_OFFSET + 1 + descLen;
    if (this.#bytes.length <= abbrevLenOffset) return null;
    const abbrevLen = this.#bytes.charCodeAt(abbrevLenOffset);
    if (abbrevLen === 0 || this.#bytes.length < abbrevLenOffset + 1 + abbrevLen) {
      return null;
    }
    const abbrev = this.#bytes
      .slice(abbrevLenOffset + 1, abbrevLenOffset + 1 + abbrevLen)
      .trim();
    return abbrev.length > 0 ? abbrev : null;
  }

  static fromBytes(bytes: DisaInput): WARDDICT {
    return new WARDDICT(null, null, null, null, null, bytes);
  }

  static async All(where: string, server: DisaServer): Promise<WARDDICT[]> {
    const DB_DRIVER = server.config.database.driver;
    const DB_URI = server.config.database.connection_string;
    const results: WARDDICT[] = [];

    if (DB_DRIVER === "mssql") {
      const sql = `SELECT [DATESTAMP] ,[CODE1] ,[CODE2] ,[DESCRIPTION] ,[ABBREV] ,[WARDDICT_STATUS] FROM [DisaGlobal].[dbo].[WARDDICT] ${!Core.IsEmpty(where) ? where : ""}`;
      const pool = await getPool(DB_URI);
      const list = (await pool.request().query(sql)).recordset;

      list.forEach((row: Record<string, unknown>) => {
        const item = new WARDDICT(
          row.DATESTAMP,
          row.CODE1 as string | null,
          row.CODE2 as string | null,
          row.DESCRIPTION as string | null,
          row.ABBREV as string | null,
          row.WARDDICT_STATUS as DisaInput,
          server,
        );
        results.push(item);
      });
    }

    return results;
  }
}

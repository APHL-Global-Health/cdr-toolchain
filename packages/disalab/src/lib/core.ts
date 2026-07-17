import iconv from "iconv-lite";
import { BitConverter } from "./bitconverter.js";

export type DisaInput = Buffer | string | Uint8Array;

export function ConvertToBytes(bytes: DisaInput): string {
  // Use latin1, NOT windows-1252: latin1 is a lossless 1:1 mapping of every
  // byte 0x00-0xFF to U+0000-U+00FF, so `charCodeAt(i) & 0xFF` round-trips.
  // windows-1252 has 5 undefined positions (0x81, 0x8D, 0x8F, 0x90, 0x9D)
  // that iconv-lite decodes to U+FFFD — any BitConverter/binary decoder
  // reading a float/int whose bytes include one of those positions would
  // get 0xFD instead of the original byte (e.g. HIVTL log10 values being
  // misread as 7.93 instead of 4.53 because byte 0x90 corrupted the float).
  return iconv.decode(Buffer.from(bytes as Buffer), "latin1");
}

export function FixBytes(bytes: DisaInput): string {
  return ConvertToBytes(bytes).replace(/\0/g, " ");
}

export function FixString(data: string, start: number, end: number): string {
  return data.substring(start, end);
}

/**
 * Extract a text field: substring then strip C0 control chars (SOH, STX, ...)
 * and DEL, then trim. Use this for human-readable string fields decoded from
 * the Disa binary blob. Do NOT use for date/time/bit fields — those need the
 * raw byte values via charCodeAt and should use FixString directly.
 */
export function FixText(data: string, start: number, end: number): string {
  return data.substring(start, end).replace(/[\x00-\x1F\x7F]/g, " ").trim();
}

export function IsUndefinedOrNull(data: unknown): data is null | undefined {
  return data === undefined || data === null;
}

/**
 * Escape a value for safe interpolation into a raw SQL string literal
 * (`'${SqlEscape(x)}'`). DISA blob slices regularly carry stray NUL padding
 * and apostrophes inside free-text comments; SQL Server rejects both —
 * "Unclosed quotation mark" for unescaped `'`, "invalid name … NULL character"
 * for raw `\0`. We strip NULs (they're padding artefacts, never legitimate
 * lookup keys) and double apostrophes per T-SQL string-literal rules.
 *
 * The helper does not rewrite the surrounding `'...'` quotes — callers wrap
 * the result themselves so the existing SQL stays grep-able for audit.
 */
export function SqlEscape(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "string" ? value : String(value);
  return s.replace(/\0/g, "").replace(/'/g, "''");
}

export function IsEmpty(data: unknown): boolean {
  if (IsUndefinedOrNull(data)) return true;
  return String(data).trim().length === 0;
}

export const IsNullOrEmpty = IsEmpty;

/**
 * Detect a slot that's effectively unset: bytes are all NUL (or all NUL after
 * NUL→space normalization). Used as a "no value here" check by the FromDisa*
 * decoders. Crucially does NOT trim valid binary bytes — JS .trim() removes
 * 0x09/0x0A/0x0B/0x0C/0x0D, all of which are legitimate values for day-of-month
 * and minutes (e.g. day 13 is 0x0D = CR; 12:10 = bytes 0x0A 0x0C).
 */
function IsAllNul(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code !== 0 && code !== 0x20) return false;
  }
  return true;
}

export function FromDisaDate(dt: string | null | undefined): Date | null {
  if (IsUndefinedOrNull(dt) || dt.length !== 4) return null;
  if (IsAllNul(dt)) return null;

  const date = dt.charCodeAt(0);
  const month = dt.charCodeAt(1);
  const base_year_remainder = dt.charCodeAt(2);
  const base_year = dt.charCodeAt(3);
  const year = base_year_remainder + base_year * 256;

  return new Date(year, month - 1, date);
}

export function FromDisaTime(dt: string | null | undefined): Date | null {
  if (IsUndefinedOrNull(dt) || dt.length !== 2) return null;
  if (IsAllNul(dt)) return null;

  const _dt = new Date();
  _dt.setMinutes(dt.charCodeAt(0));
  _dt.setHours(dt.charCodeAt(1));
  return _dt;
}

export function FromDisaDatetime(dt: string | null | undefined): Date | null {
  if (IsUndefinedOrNull(dt) || dt.length !== 6) return null;
  if (IsAllNul(dt)) return null;

  const date = FromDisaDate(dt.substring(0, 4));
  const time = FromDisaTime(dt.substring(4, 6));
  if (date === null || time === null) return null;

  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    time.getHours(),
    time.getMinutes(),
    time.getSeconds(),
  );
}

export function FromDisaTimeShort(dt: string | null | undefined): Date | null {
  if (IsUndefinedOrNull(dt) || dt.length !== 2) return null;
  if (IsAllNul(dt)) return null;

  // MS-DOS packed time format (16-bit LE):
  //   bits  0-4: seconds / 2  (0-29)
  //   bits  5-10: minutes     (0-59)
  //   bits 11-15: hours       (0-23)
  const lo = dt.charCodeAt(0);
  const hi = dt.charCodeAt(1);
  const hours = hi >> 3;
  const mins = ((hi & 0x07) << 3) | (lo >> 5);
  const secs = (lo & 0x1f) * 2;

  const _dt = new Date();
  _dt.setHours(hours, mins, secs, 0);
  return _dt;
}

export function FromDisaDateShort(dt: string | null | undefined): Date | null {
  if (IsUndefinedOrNull(dt) || dt.length !== 2) return null;
  if (IsAllNul(dt)) return null;

  // MS-DOS packed date format (16-bit LE):
  //   bits  0-4: day                  (1-31)
  //   bits  5-8: month                (1-12)
  //   bits 9-15: year offset from 1980
  const lo = dt.charCodeAt(0);
  const hi = dt.charCodeAt(1);
  const day = lo & 0x1f;
  const month = ((hi & 0x01) << 3) | (lo >> 5);
  const year = (hi >> 1) + 1980;
  return new Date(year, month - 1, day, 0, 0, 0);
}

export function FromDisaDatetimeShort(dt: string | null | undefined): Date | null {
  if (IsEmpty(dt) || (!IsEmpty(dt) && dt!.length !== 4)) return null;
  if (IsEmpty(dt!.replace(/\0/g, " ").trim())) return null;

  const time = FromDisaTimeShort(dt!.substring(0, 2));
  const date = FromDisaDateShort(dt!.substring(2, 4));
  if (date === null || time === null) return null;

  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    time.getHours(),
    time.getMinutes(),
    time.getSeconds(),
  );
}

export function DisaDatetimeValue(
  bytes: DisaInput,
  dateStart: number,
  dateEnd: number,
  timeStart: number,
  timeEnd: number,
): string | null {
  // Don't .trim() the slices: time bytes can be 0x09 (TAB) or 0x0D (CR)
  // which JS treats as whitespace. Trimming destroyed valid binary data and
  // produced spurious nulls (the FromDisa* helpers handle the empty-slot
  // detection themselves via NUL replacement).
  const data = ConvertToBytes(bytes);
  const d = FixString(data, dateStart, dateEnd);
  const t = FixString(data, timeStart, timeEnd);
  const date_ob = FromDisaDatetime(d + t);
  return toMMDDYYYY_HHMM(date_ob);
}

export function DisaDateOfBirthOrAgeValue(
  bytes: DisaInput,
  dateStart: number,
  dateEnd: number,
  timeStart: number,
  timeEnd: number,
): string | null {
  const data = ConvertToBytes(bytes);

  const years = data.substring(414, 415).charCodeAt(0);
  const days = data.substring(416, 417).charCodeAt(0);
  const hours = data.substring(418, 419).charCodeAt(0);

  // See note on DisaDatetimeValue — same trim-destroys-time-bytes bug.
  const d = FixString(data, dateStart, dateEnd);
  const t = FixString(data, timeStart, timeEnd);
  const date_ob = FromDisaDatetime(d + t);

  if (date_ob !== null) {
    if (years > 0) date_ob.setFullYear(date_ob.getFullYear() - years);
    if (days > 0) date_ob.setDate(date_ob.getDate() - days);
    if (hours > 0) date_ob.setHours(date_ob.getHours() - hours);
    return toMMDDYYYY(date_ob);
  }

  return "";
}

export function DisaDatetimeShortValue(
  bytes: DisaInput,
  start: number,
  end: number,
): string | null {
  // See note on DisaDatetimeValue — same trim-destroys-time-bytes bug.
  const data = ConvertToBytes(bytes);
  const d = FixString(data, start, end);
  const date_ob = FromDisaDatetimeShort(d);
  return toMMDDYYYY_HHMM(date_ob);
}

export function DisaBitValue(bytes: DisaInput, start: number, end: number): number {
  // Important: use raw ConvertToBytes (not FixBytes). FixBytes replaces NUL
  // with space (0x20), which would turn empty/unset 4-byte fields into a
  // garbage int of 0x20202020 = 538976288 instead of 0.
  const data = ConvertToBytes(bytes);
  const value = FixString(data, start, end);
  const converter = new BitConverter();
  return converter.ToInt(value);
}

/**
 * Read a variable-width little-endian unsigned integer (1–4 bytes) from the
 * raw blob. For fields like REGDAT4.Index which are 3 raw bytes — exposing
 * them as text produces garbage Windows-1252 characters.
 */
export function DisaUIntValue(bytes: DisaInput, start: number, end: number): number {
  const data = ConvertToBytes(bytes);
  const slice = data.substring(start, end);
  let result = 0;
  for (let i = 0; i < slice.length && i < 4; i++) {
    result |= (slice.charCodeAt(i) & 0xff) << (i * 8);
  }
  return result >>> 0;
}

export function toMMDDYYYY_HHMM(date_ob: Date | null): string | null {
  if (date_ob === null) return null;
  const date = ("0" + date_ob.getDate()).slice(-2);
  const month = ("0" + (date_ob.getMonth() + 1)).slice(-2);
  const year = date_ob.getFullYear();
  const hours = ("0" + date_ob.getHours()).slice(-2);
  const minutes = ("0" + date_ob.getMinutes()).slice(-2);
  return `${month}/${date}/${year} ${hours}:${minutes}`;
}

export function toMMDDYYYY(date_ob: Date | null): string | null {
  if (date_ob === null) return null;
  const date = ("0" + date_ob.getDate()).slice(-2);
  const month = ("0" + (date_ob.getMonth() + 1)).slice(-2);
  const year = date_ob.getFullYear();
  return `${month}/${date}/${year}`;
}

export function toDDMMYYYY_HHMM(date_ob: Date | null): string | null {
  if (date_ob === null) return null;
  const date = ("0" + date_ob.getDate()).slice(-2);
  const month = ("0" + (date_ob.getMonth() + 1)).slice(-2);
  const year = date_ob.getFullYear();
  const hours = ("0" + date_ob.getHours()).slice(-2);
  const minutes = ("0" + date_ob.getMinutes()).slice(-2);
  return `${date}/${month}/${year} ${hours}:${minutes}`;
}

export function toDDMMYYYY(date_ob: Date | null): string | null {
  if (date_ob === null) return null;
  const date = ("0" + date_ob.getDate()).slice(-2);
  const month = ("0" + (date_ob.getMonth() + 1)).slice(-2);
  const year = date_ob.getFullYear();
  return `${date}/${month}/${year}`;
}

export function Trim<T extends string | null | undefined>(value: T): T {
  if (!IsUndefinedOrNull(value)) return value.trim() as T;
  return value;
}

/**
 * Render a DATE-ONLY SQL column as `YYYY-MM-DD`.
 *
 * The mssql driver returns `datetime` columns as **JS Date objects**, not
 * strings. Where the column is date-only (stored at midnight), the honest
 * rendering is the calendar date and nothing more.
 *
 * ⚠ Reads the **UTC** components deliberately. The driver builds the Date at
 * midnight UTC, so `getDate()` on any host west of UTC rolls the date BACK a
 * day — a silent off-by-one that only shows up in another timezone.
 *
 * ⚠ Returns the DATE ONLY — never `T00:00:00`, and never an offset. Midnight
 * here is an artifact of a date-only column, not a known time; emitting it
 * would assert a precision the source does not have.
 *
 * Anything that is not a valid Date (a string the driver already rendered, an
 * empty cell) returns null rather than a guess — a caller must not receive a
 * value it cannot distinguish from a real one.
 */
export function DateOnlyIso(value: unknown): string | null {
  if (IsUndefinedOrNull(value)) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

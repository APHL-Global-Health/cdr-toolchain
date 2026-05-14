import type { Command } from "commander";
import mssql from "mssql";
import { getPool } from "disalab";
import { Core } from "disalab";
import { CliError } from "../errors.js";
import { closePool } from "../db.js";
import { loadRuntime } from "./context.js";

interface ProbeOpts {
  target?: string;
  minYear?: string;
  maxYear?: string;
  kinds?: string;
  toleranceSec?: string;
}

type ProbeKind =
  | "long-datetime"   // 6 bytes: 4-byte date + 2-byte time
  | "short-datetime"  // 4 bytes: 2-byte time + 2-byte date (DISA short order)
  | "long-date"       // 4 bytes: date only
  | "short-date"      // 2 bytes: short date only
  | "long-time"       // 2 bytes: byte0=mins, byte1=hours — emits ONLY when --target is set
  | "short-time";     // 2 bytes: MS-DOS packed time — emits ONLY when --target is set

const ALL_KINDS: ProbeKind[] = [
  "long-datetime",
  "short-datetime",
  "long-date",
  "short-date",
  "long-time",
  "short-time",
];

interface Candidate {
  offset: number;
  size: number;
  kind: ProbeKind;
  decoded: string;
  raw_hex: string;
}

async function fetchBlob(labNo: string, connectionString: string): Promise<Buffer> {
  try {
    const pool = await getPool(connectionString);
    const escaped = labNo.replace(/'/g, "''");
    const sql = `SELECT TOP 1 [REGDAT4_STATUS] FROM [DisalabData].[dbo].[REGDAT4] WHERE [LabNo] = '${escaped}'`;
    const result = await pool.request().query(sql);
    const row = result.recordset[0] as { REGDAT4_STATUS?: Buffer | null } | undefined;
    if (row === undefined || row.REGDAT4_STATUS === null || row.REGDAT4_STATUS === undefined) {
      throw new CliError("GET_NO_ROWS", `No REGDAT4 row for LabNo='${labNo}'`);
    }
    return row.REGDAT4_STATUS;
  } catch (err) {
    if (err instanceof CliError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_QUERY_FAILED", `probe fetch failed: ${message}`);
  } finally {
    await closePool();
  }
}

function plausibleYear(d: Date, min: number, max: number): boolean {
  const y = d.getFullYear();
  return y >= min && y <= max;
}

function bufHex(buf: Buffer, offset: number, size: number): string {
  return buf.subarray(offset, offset + size).toString("hex");
}

function decodeLongDate(data: string, offset: number, minY: number, maxY: number): Date | null {
  if (offset + 4 > data.length) return null;
  const slice = data.substring(offset, offset + 4);
  const d = Core.FromDisaDate(slice);
  if (d === null || Number.isNaN(d.getTime())) return null;
  return plausibleYear(d, minY, maxY) ? d : null;
}

function decodeLongTime(data: string, offset: number): Date | null {
  if (offset + 2 > data.length) return null;
  const slice = data.substring(offset, offset + 2);
  const mins = slice.charCodeAt(0);
  const hours = slice.charCodeAt(1);
  if (hours > 23 || mins > 59) return null;
  if (hours === 0 && mins === 0) return null; // skip noise — too common
  const d = new Date();
  d.setHours(hours, mins, 0, 0);
  return d;
}

function decodeLongDatetime(data: string, offset: number, minY: number, maxY: number): Date | null {
  const date = decodeLongDate(data, offset, minY, maxY);
  if (date === null) return null;
  if (offset + 6 > data.length) return null;
  const time = decodeLongTime(data, offset + 4);
  if (time === null) return null;
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    time.getHours(),
    time.getMinutes(),
    0,
  );
}

function decodeShortDate(data: string, offset: number, minY: number, maxY: number): Date | null {
  if (offset + 2 > data.length) return null;
  const slice = data.substring(offset, offset + 2);
  const d = Core.FromDisaDateShort(slice);
  if (d === null || Number.isNaN(d.getTime())) return null;
  return plausibleYear(d, minY, maxY) ? d : null;
}

function decodeShortDatetime(data: string, offset: number, minY: number, maxY: number): Date | null {
  if (offset + 4 > data.length) return null;
  const slice = data.substring(offset, offset + 4);
  // FromDisaDatetimeShort: first 2 bytes = time, next 2 bytes = date
  const d = Core.FromDisaDatetimeShort(slice);
  if (d === null || Number.isNaN(d.getTime())) return null;
  return plausibleYear(d, minY, maxY) ? d : null;
}

function decodeShortTimeOnly(data: string, offset: number): { hours: number; mins: number } | null {
  if (offset + 2 > data.length) return null;
  const slice = data.substring(offset, offset + 2);
  const dt = Core.FromDisaTimeShort(slice);
  if (dt === null) return null;
  return { hours: dt.getHours(), mins: dt.getMinutes() };
}

function decodeLongTimeOnly(data: string, offset: number): { hours: number; mins: number } | null {
  if (offset + 2 > data.length) return null;
  const mins = data.charCodeAt(offset);
  const hours = data.charCodeAt(offset + 1);
  if (hours > 23 || mins > 59) return null;
  return { hours, mins };
}

function targetMatches(decoded: Date, target: Date | null, toleranceSec: number): boolean {
  if (target === null) return true;
  return Math.abs(decoded.getTime() - target.getTime()) <= toleranceSec * 1000;
}

export function registerProbeBytesCommand(program: Command): void {
  program
    .command("probe-bytes <labNumber>")
    .description(
      "Brute-force scan REGDAT4_STATUS for date/time/datetime patterns at every offset. Use to find where unmapped fields actually live in the blob.",
    )
    .option(
      "--target <iso>",
      "only emit candidates whose decoded value matches this ISO datetime (within --tolerance-sec)",
    )
    .option("--tolerance-sec <n>", "match tolerance in seconds for --target", "60")
    .option(
      "--kinds <csv>",
      "decoders to try: long-datetime,short-datetime,long-date,short-date",
      ALL_KINDS.join(","),
    )
    .option("--min-year <n>", "plausibility lower bound", "2000")
    .option("--max-year <n>", "plausibility upper bound", "2035")
    .action(async (labNo: string, opts: ProbeOpts, cmd: Command) => {
      const { config, output } = loadRuntime(cmd);

      const minY = Number(opts.minYear ?? "2000");
      const maxY = Number(opts.maxYear ?? "2035");
      const toleranceSec = Number(opts.toleranceSec ?? "60");
      const kinds = (opts.kinds ?? ALL_KINDS.join(","))
        .split(",")
        .map((s) => s.trim())
        .filter((s): s is ProbeKind => ALL_KINDS.includes(s as ProbeKind));

      let target: Date | null = null;
      let targetTime: { hours: number; mins: number } | null = null;
      if (opts.target !== undefined) {
        // Pull H:M for time-only kinds whether or not the target is a full datetime.
        const timeOnlyMatch = opts.target.match(/(?:T|^|\s)(\d{1,2}):(\d{2})/);
        if (timeOnlyMatch !== null) {
          targetTime = { hours: Number(timeOnlyMatch[1]), mins: Number(timeOnlyMatch[2]) };
        }
        // Try to parse as a full Date for date-bearing kinds. OK if it fails when
        // the user gave a time-only target like "13:25".
        const t = new Date(opts.target);
        if (!Number.isNaN(t.getTime())) target = t;
        if (target === null && targetTime === null) {
          throw new CliError(
            "USAGE",
            `--target "${opts.target}" is not a parseable ISO datetime, date, or HH:MM`,
          );
        }
      }

      const blob = await fetchBlob(labNo, config.connectionString);
      const data = Core.ConvertToBytes(blob);
      const candidates: Candidate[] = [];

      for (let offset = 0; offset < data.length; offset++) {
        if (kinds.includes("long-datetime")) {
          const d = decodeLongDatetime(data, offset, minY, maxY);
          if (d !== null && targetMatches(d, target, toleranceSec)) {
            candidates.push({
              offset,
              size: 6,
              kind: "long-datetime",
              decoded: d.toISOString(),
              raw_hex: bufHex(blob, offset, 6),
            });
          }
        }
        if (kinds.includes("short-datetime")) {
          const d = decodeShortDatetime(data, offset, minY, maxY);
          if (d !== null && targetMatches(d, target, toleranceSec)) {
            candidates.push({
              offset,
              size: 4,
              kind: "short-datetime",
              decoded: d.toISOString(),
              raw_hex: bufHex(blob, offset, 4),
            });
          }
        }
        if (kinds.includes("long-date")) {
          const d = decodeLongDate(data, offset, minY, maxY);
          if (d !== null && targetMatches(d, target, toleranceSec)) {
            candidates.push({
              offset,
              size: 4,
              kind: "long-date",
              decoded: d.toISOString().slice(0, 10),
              raw_hex: bufHex(blob, offset, 4),
            });
          }
        }
        if (kinds.includes("short-date")) {
          const d = decodeShortDate(data, offset, minY, maxY);
          if (d !== null && targetMatches(d, target, toleranceSec)) {
            candidates.push({
              offset,
              size: 2,
              kind: "short-date",
              decoded: d.toISOString().slice(0, 10),
              raw_hex: bufHex(blob, offset, 2),
            });
          }
        }
        // Time-only kinds emit only when --target was provided (otherwise too noisy).
        if (kinds.includes("long-time") && targetTime !== null) {
          const t = decodeLongTimeOnly(data, offset);
          if (t !== null && t.hours === targetTime.hours && t.mins === targetTime.mins) {
            candidates.push({
              offset,
              size: 2,
              kind: "long-time",
              decoded: `${String(t.hours).padStart(2, "0")}:${String(t.mins).padStart(2, "0")}`,
              raw_hex: bufHex(blob, offset, 2),
            });
          }
        }
        if (kinds.includes("short-time") && targetTime !== null) {
          const t = decodeShortTimeOnly(data, offset);
          if (t !== null && t.hours === targetTime.hours && t.mins === targetTime.mins) {
            candidates.push({
              offset,
              size: 2,
              kind: "short-time",
              decoded: `${String(t.hours).padStart(2, "0")}:${String(t.mins).padStart(2, "0")}`,
              raw_hex: bufHex(blob, offset, 2),
            });
          }
        }
      }

      const result = {
        lab_number: labNo,
        blob_size: blob.length,
        target: target?.toISOString() ?? null,
        kinds,
        plausibility_window: { min_year: minY, max_year: maxY },
        candidate_count: candidates.length,
        candidates,
      };

      if (output.format === "ndjson") {
        // emit summary on stderr, candidates on stdout one-per-line
        process.stderr.write(
          JSON.stringify({
            _meta: "summary",
            lab_number: labNo,
            blob_size: blob.length,
            target: target?.toISOString() ?? null,
            candidate_count: candidates.length,
          }) + "\n",
        );
        for (const c of candidates) process.stdout.write(JSON.stringify(c) + "\n");
      } else {
        process.stdout.write(JSON.stringify(result) + "\n");
      }
    });
}

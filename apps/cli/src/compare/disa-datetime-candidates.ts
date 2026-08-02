import { Core } from "disalab";

/**
 * DISA packed date/time candidate decoders, shared by `probe-bytes` (manual
 * reverse-engineering) and `probe-review` (scored search against v1).
 * Extracted from probe-bytes.ts unchanged — do not "improve" them here without
 * re-running both commands; probe-bytes' output is calibrated against these.
 */

function plausibleYear(d: Date, min: number, max: number): boolean {
  const y = d.getFullYear();
  return y >= min && y <= max;
}

export function decodeLongDate(data: string, offset: number, minY: number, maxY: number): Date | null {
  if (offset + 4 > data.length) return null;
  const slice = data.substring(offset, offset + 4);
  const d = Core.FromDisaDate(slice);
  if (d === null || Number.isNaN(d.getTime())) return null;
  return plausibleYear(d, minY, maxY) ? d : null;
}

export function decodeLongTime(data: string, offset: number): Date | null {
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

export function decodeLongDatetime(data: string, offset: number, minY: number, maxY: number): Date | null {
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

export function decodeShortDate(data: string, offset: number, minY: number, maxY: number): Date | null {
  if (offset + 2 > data.length) return null;
  const slice = data.substring(offset, offset + 2);
  const d = Core.FromDisaDateShort(slice);
  if (d === null || Number.isNaN(d.getTime())) return null;
  return plausibleYear(d, minY, maxY) ? d : null;
}

export function decodeShortDatetime(data: string, offset: number, minY: number, maxY: number): Date | null {
  if (offset + 4 > data.length) return null;
  const slice = data.substring(offset, offset + 4);
  // FromDisaDatetimeShort: first 2 bytes = time, next 2 bytes = date
  const d = Core.FromDisaDatetimeShort(slice);
  if (d === null || Number.isNaN(d.getTime())) return null;
  return plausibleYear(d, minY, maxY) ? d : null;
}

export function decodeShortTimeOnly(data: string, offset: number): { hours: number; mins: number } | null {
  if (offset + 2 > data.length) return null;
  const slice = data.substring(offset, offset + 2);
  const dt = Core.FromDisaTimeShort(slice);
  if (dt === null) return null;
  return { hours: dt.getHours(), mins: dt.getMinutes() };
}

export function decodeLongTimeOnly(data: string, offset: number): { hours: number; mins: number } | null {
  if (offset + 2 > data.length) return null;
  const mins = data.charCodeAt(offset);
  const hours = data.charCodeAt(offset + 1);
  if (hours > 23 || mins > 59) return null;
  return { hours, mins };
}

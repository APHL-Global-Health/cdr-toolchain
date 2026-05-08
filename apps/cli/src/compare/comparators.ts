export type CompareStatus = "match" | "mismatch" | "only_disa" | "only_v1";

export interface CompareResult {
  status: CompareStatus;
  reason?: string;
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  return false;
}

function asymmetric(disa: unknown, v1: unknown): CompareResult | null {
  const disaEmpty = isEmpty(disa);
  const v1Empty = isEmpty(v1);
  if (disaEmpty && v1Empty) return { status: "match" };
  if (disaEmpty && !v1Empty) return { status: "only_v1" };
  if (!disaEmpty && v1Empty) return { status: "only_disa" };
  return null;
}

export function stringCi(disa: unknown, v1: unknown): CompareResult {
  const a = asymmetric(disa, v1);
  if (a !== null) return a;
  const ds = String(disa).trim().toLowerCase();
  const vs = String(v1).trim().toLowerCase();
  return ds === vs ? { status: "match" } : { status: "mismatch", reason: "string differs" };
}

/**
 * Like stringCi but strips a known v1-side prefix before comparing. Use for
 * fields where the OpenLDR v1 migration prepended a system-id prefix to the
 * DISA value (e.g. facility codes get "DISA" prepended in v1).
 */
export function stringCiStripV1Prefix(prefix: string): (disa: unknown, v1: unknown) => CompareResult {
  return (disa, v1) => {
    let v1Stripped: unknown = v1;
    if (typeof v1 === "string") {
      const trimmed = v1.trim();
      if (trimmed.toUpperCase().startsWith(prefix.toUpperCase())) {
        v1Stripped = trimmed.slice(prefix.length);
      }
    }
    return stringCi(disa, v1Stripped);
  };
}

export function stringCiLoose(disa: unknown, v1: unknown): CompareResult {
  const a = asymmetric(disa, v1);
  if (a !== null) return a;
  const ds = String(disa).trim().toLowerCase();
  const vs = String(v1).trim().toLowerCase();
  if (ds === vs) return { status: "match" };
  if (ds.includes(vs) || vs.includes(ds)) return { status: "match", reason: "substring match" };
  return { status: "mismatch", reason: "string differs (no substring overlap)" };
}

export function datetime(disa: unknown, v1: unknown): CompareResult {
  const a = asymmetric(disa, v1);
  if (a !== null) return a;
  const dd = toWallClock(disa);
  const vd = toWallClock(v1);
  if (dd === null || vd === null) {
    return { status: "mismatch", reason: "unparseable date on one or both sides" };
  }
  if (
    dd.y === vd.y &&
    dd.mo === vd.mo &&
    dd.d === vd.d &&
    dd.h === vd.h &&
    dd.mi === vd.mi
  ) {
    return { status: "match" };
  }
  return {
    status: "mismatch",
    reason: `wall clock differs: DISA=${fmtWc(dd)} v1=${fmtWc(vd)}`,
  };
}

interface WallClock {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

/**
 * Compare wall-clock components (Y/M/D/h/m), not absolute timestamps. mssql
 * returns SQL DATETIME values as UTC-component Date objects while disalab
 * emits local-component formatted strings — they describe the same wall time
 * but differ by the local TZ offset. Component comparison sidesteps that.
 */
function toWallClock(v: unknown): WallClock | null {
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return {
      y: v.getUTCFullYear(),
      mo: v.getUTCMonth(),
      d: v.getUTCDate(),
      h: v.getUTCHours(),
      mi: v.getUTCMinutes(),
    };
  }
  if (typeof v !== "string") return null;
  // DISA's toMMDDYYYY_HHMM format: "MM/dd/yyyy HH:mm"
  const disaFormat = v.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);
  if (disaFormat !== null) {
    const [, mm, dd, yyyy, hh, mi] = disaFormat;
    return { y: Number(yyyy), mo: Number(mm) - 1, d: Number(dd), h: Number(hh), mi: Number(mi) };
  }
  // Date-only DISA format: "MM/dd/yyyy"
  const dateOnly = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (dateOnly !== null) {
    const [, mm, dd, yyyy] = dateOnly;
    return { y: Number(yyyy), mo: Number(mm) - 1, d: Number(dd), h: 0, mi: 0 };
  }
  const t = Date.parse(v);
  if (Number.isNaN(t)) return null;
  const dt = new Date(t);
  return {
    y: dt.getUTCFullYear(),
    mo: dt.getUTCMonth(),
    d: dt.getUTCDate(),
    h: dt.getUTCHours(),
    mi: dt.getUTCMinutes(),
  };
}

function fmtWc(w: WallClock): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${w.y}-${pad(w.mo + 1)}-${pad(w.d)} ${pad(w.h)}:${pad(w.mi)}`;
}

export type CompareStatus = "match" | "mismatch" | "only_disa" | "only_v1";

export interface CompareResult {
  status: CompareStatus;
  reason?: string;
}

export function isEmpty(v: unknown): boolean {
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

/**
 * Ward / WardClinic comparator. v1's `LIMSPointOfCareDesc` is a single
 * column that sometimes carries both facility and ward separated by `~`,
 * and sometimes carries facility alone — the ward is lost during the v1
 * migration when the source row lacks the separator. When DISA has a
 * ward and v1's parsed ward is empty, treat as a match (v1 data loss,
 * not a toolchain bug — v2 will emit the ward from DISA correctly).
 * Other cases fall back to case-insensitive string equality.
 */
export function wardComparator(disa: unknown, v1: unknown): CompareResult {
  if (isEmpty(disa) && isEmpty(v1)) return { status: "match" };
  if (isEmpty(disa) && !isEmpty(v1)) return { status: "only_v1" };
  if (!isEmpty(disa) && isEmpty(v1)) {
    return {
      status: "match",
      reason: "v1 dropped ward (no separator in LIMSPointOfCareDesc)",
    };
  }
  return stringCi(disa, v1);
}

/**
 * Facility-name comparator. v1's `LIMSPointOfCareDesc` is also the source for
 * facility_name (via the `Facility~Ward` split), so the same migration-era
 * data loss that drops the ward also drops the facility name — observed
 * empirically on 594 labs in the TDS extract whose DISA Facility.FacilityName
 * is populated while v1's parsed facilityName is null. When DISA has it and
 * v1 doesn't, treat as a match (v1 data loss, not a toolchain bug — v2
 * emits the value from DISA correctly). Real partial-name divergences
 * (e.g. DISA="KCMC CLINICAL LABORATORY" vs v1="KCMC") still fall through
 * to stringCi and surface as mismatch.
 */
export function facilityNameComparator(disa: unknown, v1: unknown): CompareResult {
  if (isEmpty(disa) && isEmpty(v1)) return { status: "match" };
  if (isEmpty(disa) && !isEmpty(v1)) return { status: "only_v1" };
  if (!isEmpty(disa) && isEmpty(v1)) {
    return {
      status: "match",
      reason: "v1 dropped facility name (LIMSPointOfCareDesc null/empty)",
    };
  }
  // Both populated: v1 frequently stores the short/abbreviated form of the
  // facility name (e.g. DISA="KCMC CLINICAL LABORATORY" vs v1="KCMC" — 87
  // labs in the TDS extract). Substring containment is the safe rule —
  // both sides clearly identify the same facility. True divergences with
  // no substring overlap still surface as mismatch.
  return stringCiLoose(disa, v1);
}

/**
 * ICD-10 comparator. The DISA ICD10 column is occasionally populated when
 * v1's ICD10ClinicalInfoCodes is empty (1 lab in the TDS extract had
 * DISA="B50.9" malaria vs v1=""). Same migration-era data-loss pattern as
 * facility_name and ward — v1 dropped the code, v2 will carry DISA's value
 * correctly. Other axes fall through to strict equality.
 */
export function icd10Comparator(disa: unknown, v1: unknown): CompareResult {
  if (isEmpty(disa) && isEmpty(v1)) return { status: "match" };
  if (isEmpty(disa) && !isEmpty(v1)) return { status: "only_v1" };
  if (!isEmpty(disa) && isEmpty(v1)) {
    return {
      status: "match",
      reason: "v1 dropped ICD10 code",
    };
  }
  return stringCi(disa, v1);
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
  // v1's historical migration truncated some datetimes to date-only (UTC
  // midnight) — RegisteredDateTime in particular comes through as a clean
  // 00:00 even when DISA kept the real registration time. Same calendar
  // date with either side at midnight is the same event at different
  // precision, not a mismatch.
  const sameDate = dd.y === vd.y && dd.mo === vd.mo && dd.d === vd.d;
  const v1Midnight = vd.h === 0 && vd.mi === 0;
  const disaMidnight = dd.h === 0 && dd.mi === 0;
  if (sameDate && (v1Midnight || disaMidnight)) {
    return {
      status: "match",
      reason: v1Midnight
        ? "same date; v1 stored as date-only (midnight)"
        : "same date; DISA stored as date-only (midnight)",
    };
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

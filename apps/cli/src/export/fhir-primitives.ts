// Guards enforcing OpenLDR CE's FHIR primitive regexes. CE safeParses every
// resource against these; a value that violates one is rejected at persist.
// Mirrors openldr_ce/packages/fhir/src/datatypes/primitives.ts:3-17.

/** CE ID_RE: /^[A-Za-z0-9.\-]{1,64}$/ — note underscore is NOT permitted. */
export function fhirId(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9.\-]/g, "-")  // forbidden char -> hyphen
    .replace(/-{2,}/g, "-")            // collapse runs
    .slice(0, 64)                      // truncate BEFORE stripping separators...
    .replace(/^-+|-+$/g, "");          // ...so a cut mid-string can't leave one
  return cleaned.length > 0 ? cleaned : undefined;
}

/** A FHIR timezone offset: "Z", or "+HH:MM" / "-HH:MM". */
const TZ_RE = /^(Z|[+-]\d{2}:\d{2})$/;

/**
 * True if y-m-d (and optional h:m:s) is a real calendar instant.
 *
 * Uses a Date.UTC component round-trip so no local-zone interpretation can
 * shift the value — the whole point of this module is that we never silently
 * reinterpret time. `new Date(Date.UTC(...))` takes NUMERIC UTC components:
 * there is no string parsing and no local-zone guessing, which makes it
 * categorically different from the `new Date(string)` this module refuses to
 * use. Do not "simplify" it to `new Date(someString)`.
 */
function isRealDate(y: number, mo: number, d: number, h = 0, mi = 0, s = 0): boolean {
  // Date.UTC maps years 0-99 to 1900-1999; our regexes require 4 digits, but
  // guard anyway so "0024-01-01" can never silently become 1924.
  if (y < 1000) return false;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  if (h > 23 || mi > 59 || s > 59) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  // Round-trip catches Feb 30, Apr 31, non-leap Feb 29, etc.
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

/**
 * CE DATETIME_RE requires a zone when a time is present, but upstream
 * `disaToIso` (v2-transform.ts:36-50) deliberately emits unzoned local time:
 * DISA stores local wall-clock and the destination owns tz interpretation
 * (PRD §5.1). So the offset is a REQUIRED argument — assuming UTC would shift
 * Moz/Zambia (UTC+2) timestamps 2h earlier with no error.
 *
 * Unrecognised input yields undefined rather than a guess: `disaToIso` passes
 * unrecognised values through raw, and `new Date("07/20/2024")` would silently
 * apply US month/day ordering. A wrong clinical timestamp is worse than none.
 *
 * @param tzOffset e.g. "+02:00", "-05:00", "Z". Throws if malformed.
 */
export function fhirDateTime(
  raw: string | null | undefined,
  tzOffset: string,
): string | undefined {
  if (!TZ_RE.test(tzOffset)) {
    throw new Error(
      `fhirDateTime: malformed timezone offset ${JSON.stringify(tzOffset)} — expected "Z" or "+HH:MM"/"-HH:MM"`,
    );
  }
  if (raw === null || raw === undefined) return undefined;
  const s = raw.trim();
  if (s.length === 0) return undefined;

  // Date-only is valid FHIR as-is; no zone applies. Validate what's present:
  // a year-only or year-month value has no day to check.
  const dateOnly = s.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/);
  if (dateOnly !== null) {
    const [, yy, mm, dd] = dateOnly;
    const y = Number(yy);
    const mo = mm === undefined ? 1 : Number(mm);
    const d = dd === undefined ? 1 : Number(dd);
    return isRealDate(y, mo, d) ? s : undefined;
  }

  // Already zoned — leave it alone. v1-transform.ts:20 emits fractional seconds.
  // Calendar values here came from disaToIso's own normaliser and pass through
  // by contract, so they are deliberately NOT re-validated.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return s;

  // Unzoned local wall-clock -> stamp it with the deployment's offset, but only
  // if it is a real instant. CE's DATETIME_RE is purely structural and would
  // happily accept "2024-13-45T99:99:99+02:00", so this is the only guard.
  const local = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/);
  if (local !== null) {
    const [, yy, mm, dd, hh, mi, ss] = local;
    if (!isRealDate(Number(yy), Number(mm), Number(dd), Number(hh), Number(mi), Number(ss))) {
      return undefined;
    }
    return `${s.replace(" ", "T")}${tzOffset}`;
  }

  return undefined;
}

/** CE fhirString is z.string().min(1) — omit rather than emit "". */
export function fhirText(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

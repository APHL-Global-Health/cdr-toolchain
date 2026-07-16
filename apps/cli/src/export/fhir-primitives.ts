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
  // Date-only is valid FHIR as-is; no zone applies.
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return s;
  // Already zoned — leave it alone. v1-transform.ts:20 emits fractional seconds.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return s;
  // Unzoned local wall-clock -> stamp it with the deployment's offset.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
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

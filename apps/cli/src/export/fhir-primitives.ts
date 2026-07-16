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
    .replace(/^-+|-+$/g, "")           // no leading/trailing separator
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

/** CE DATETIME_RE requires a zone when a time is present. Returns undefined
 *  for anything unparseable rather than emitting an invalid value. */
export function fhirDateTime(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const s = raw.trim();
  if (s.length === 0) return undefined;
  // Date-only is valid FHIR as-is.
  if (/^\d{4}(-\d{2}(-\d{2})?)?$/.test(s)) return s;
  // Already zoned.
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)) return s;
  // Unzoned local datetime -> assume UTC. DISA stores wall-clock with no zone.
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(s)) {
    return `${s.replace(" ", "T").replace(/\.\d+$/, "")}Z`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** CE fhirString is z.string().min(1) — omit rather than emit "". */
export function fhirText(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  const t = raw.trim();
  return t.length > 0 ? t : undefined;
}

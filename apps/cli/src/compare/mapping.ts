import type { SpecimenRecpt } from "disalab";
import type { OpenLdrV1Request, PocFormat } from "../openldr.js";
import { splitPointOfCare } from "../openldr.js";
import { CliError } from "../errors.js";
import {
  datetime,
  stringCi,
  stringCiLoose,
  stringCiStripV1Prefix,
  wardComparator,
  facilityNameComparator,
  icd10Comparator,
  type CompareResult,
} from "./comparators.js";

export interface FieldDef {
  field: string;
  comparator: (disa: unknown, v1: unknown) => CompareResult;
  /**
   * Pull the DISA-side value(s) for this field. Returning an array marks the
   * values as candidates — the comparator is tried against each, and a match
   * on ANY of them counts as a match. Use when v1 collapsed several DISA
   * fields into one (e.g. v1.SpecimenDateTime came from *either* DISA's
   * TakenDateTime or CollectedDateTime).
   */
  getDisa: (s: SpecimenRecpt) => unknown | unknown[];
  /**
   * Pull the v1-side value(s) for this field. Mirrors getDisa: returning an
   * array marks the values as candidates and the comparator is tried against
   * each. Use when v1 split a single DISA field across multiple rows (e.g.
   * v1 emits one OBR per sub-test, so the authoritative panel code may be
   * on any OBRSetID, not just the first).
   */
  getV1: (r: OpenLdrV1Request) => unknown | unknown[];
  /**
   * If true, when EVERY DISA candidate is empty the field counts as a match
   * regardless of what v1 has. Use for fields where v1 stores data DISA's
   * schema has no source for — v2 can't reproduce it from DISA either, so
   * the asymmetry isn't a toolchain bug.
   */
  allowDisaEmpty?: boolean;
}

/**
 * Display-ordered list of every comparator field. Stable across PocFormat —
 * the convention only changes how `facility_name` and `ward` are extracted
 * from v1's LIMSPointOfCareDesc, not the schema of the diff. Use this when
 * you need just the names (e.g. `--explain` output) without instantiating
 * the full FieldDef array.
 */
export const REQUEST_FIELD_NAMES: readonly string[] = [
  "facility_code",
  "facility_name",
  "ward",
  "panel_code",
  "specimen_code",
  "taken_at",
  "collected_at",
  "received_at",
  "priority",
  "sex",
  "icd10",
  "therapy",
  "clinical_info",
];

/** Resolve the effective PocFormat: a non-empty CLI override wins; otherwise
 *  the env-derived config fallback is used. Throws CliError("USAGE") if the
 *  override is a malformed string so the user gets a clear error rather than
 *  silent fallback to facility_ward. */
export function resolvePocFormat(override: string | undefined, fallback: PocFormat): PocFormat {
  if (override === undefined || override.length === 0) return fallback;
  if (override === "facility_ward" || override === "district_facility_ward") return override;
  throw new CliError(
    "USAGE",
    `--poc-format must be "facility_ward" or "district_facility_ward" (got "${override}")`,
  );
}

export interface RequestFieldsOptions {
  /** How v1 stores LIMSPointOfCareDesc in this deployment. `facility_ward`
   *  (Tanzania default) means left=facility, right=ward. `district_facility_ward`
   *  (Mozambique) flips it: left=district, right=facility — `ward` then
   *  carries the district value. See `splitPointOfCare` in openldr.ts. */
  pocFormat: PocFormat;
}

export function getRequestFields(opts: RequestFieldsOptions): FieldDef[] {
  const { pocFormat } = opts;
  return [
  {
    // OpenLDR v1 prepends a literal "DISA" system prefix to DISA facility
    // codes (e.g. DISA "BAKAA" → v1 "DISABAKAA"). Strip it before comparing.
    field: "facility_code",
    comparator: stringCiStripV1Prefix("DISA"),
    getDisa: (s) => s.Facility?.Code ?? null,
    getV1: (r) => r.RequestingFacilityCode,
  },
  {
    // Mirror wardComparator: v1's LIMSPointOfCareDesc was empty for 594 TDS
    // labs whose DISA side had a facility name, so a non-empty DISA against
    // an empty v1 is v1 data loss, not a toolchain bug. Real divergences
    // (both sides populated but different) still surface as mismatch.
    field: "facility_name",
    comparator: facilityNameComparator,
    getDisa: (s) => s.Facility?.FacilityName ?? null,
    getV1: (r) => splitPointOfCare(r.LIMSPointOfCareDesc, pocFormat).facilityName,
  },
  {
    // v1's LIMSPointOfCareDesc is sometimes "facility~ward", sometimes just
    // "facility" — when the source row lacks the tilde, v1 stores no ward.
    // DISA always carries the ward in REGDAT4.WardClinic. wardComparator
    // treats the v1-dropped-ward case as match (v1 data loss, not a
    // toolchain bug — v2 will emit the ward from DISA).
    //
    // Under the `district_facility_ward` convention (Mozambique) the v1 left-hand
    // segment is the district, surfaced here under the `ward` field — the
    // diff schema stays uniform across deployments while the semantics shift.
    field: "ward",
    comparator: wardComparator,
    // Prefer the WARDDICT-resolved description (Mozambique etc.) over the
    // raw 5-char ward code. The resolver populates WardClinicResolved
    // upstream in compare* / export* commands; when the lookup misses
    // the field is undefined and we fall back to the raw code, matching
    // today's behavior for deployments without a populated WARDDICT.
    getDisa: (s) => s.WardClinicResolved ?? s.WardClinic,
    getV1: (r) => splitPointOfCare(r.LIMSPointOfCareDesc, pocFormat).ward,
  },
  {
    // DISA's order may bundle a panel (e.g. COAGF "Coagulation Indices");
    // v1 splits the panel into one OBR row per sub-test, so v1's
    // LIMSPanelCode varies by OBRSetID — the parent panel code may sit on
    // OBR=2 while OBR=1 carries a child like "INR". Treat allPanelCodes
    // as candidates so a match on any OBR row counts.
    field: "panel_code",
    comparator: stringCi,
    getDisa: (s) => (s.TestOrders.length > 0 ? String(s.TestOrders[0]) : null),
    getV1: (r) => r.allPanelCodes,
  },
  {
    field: "specimen_code",
    comparator: stringCi,
    getDisa: (s) => s.Specimen,
    getV1: (r) => r.LIMSSpecimenSourceCode,
  },
  {
    // v1 collapses TakenDateTime and CollectedDateTime into a single
    // SpecimenDateTime column (confirmed in temp/script.sql). Compare v1
    // against either DISA field — a match on either wins.
    field: "taken_at",
    comparator: datetime,
    getDisa: (s) => [s.TakenDateTime, s.CollectedDateTime],
    getV1: (r) => r.SpecimenDateTime,
  },
  {
    field: "collected_at",
    comparator: datetime,
    getDisa: (s) => [s.CollectedDateTime, s.TakenDateTime],
    getV1: (r) => r.SpecimenDateTime,
  },
  {
    field: "received_at",
    comparator: datetime,
    // Older deployments left ReceivedInLabDateTime blank but populated
    // RegisteredDateTime (REGDAT4 bytes 126-134, "logged into LIS" stamp).
    // v1's migration appears to have used the LIS-registration time as its
    // ReceivedDateTime — match either candidate. When BOTH are empty, v1
    // sometimes still has a date (an unrecoverable source we haven't
    // mapped — a few rows even share an obvious literal default like
    // 2013-02-06); allowDisaEmpty stops the gate from failing on those.
    getDisa: (s) => [s.ReceivedInLabDateTime, s.RegisteredDateTime],
    getV1: (r) => r.ReceivedDateTime,
    allowDisaEmpty: true,
  },
  {
    field: "priority",
    comparator: stringCi,
    getDisa: (s) => s.Priority,
    getV1: (r) => r.HL7PriorityCode,
  },
  {
    field: "sex",
    comparator: stringCi,
    getDisa: (s) => s.Sex,
    getV1: (r) => r.HL7SexCode,
  },
  {
    field: "icd10",
    comparator: icd10Comparator,
    getDisa: (s) => s.ICD10,
    getV1: (r) => r.ICD10ClinicalInfoCodes,
  },
  {
    field: "therapy",
    comparator: stringCi,
    getDisa: (s) => [s.Therapy, s.TherapyText],
    getV1: (r) => r.Therapy,
  },
  {
    // v1.ClinicalInfo can come from any of DISA's narrative slots —
    // short (DiagCln) or long (DiagClnText), patient notes (short or long),
    // sometimes wrapped in brackets like "[SARI]". stringCiLoose handles the
    // wrapper via substring containment.
    field: "clinical_info",
    comparator: stringCiLoose,
    getDisa: (s) => [
      s.Notes,
      s.NotesText,
      s.ClinicalDiagnosis,
      s.ClinicalDiagnosisText,
    ],
    getV1: (r) => r.ClinicalInfo,
  },
  ];
}

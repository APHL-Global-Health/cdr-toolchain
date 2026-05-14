import type { SpecimenRecpt } from "disalab";
import type { OpenLdrV1Request } from "../openldr.js";
import { splitPointOfCare } from "../openldr.js";
import {
  datetime,
  stringCi,
  stringCiLoose,
  stringCiStripV1Prefix,
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
  getV1: (r: OpenLdrV1Request) => unknown;
}

export const REQUEST_FIELDS: FieldDef[] = [
  {
    // OpenLDR v1 prepends a literal "DISA" system prefix to DISA facility
    // codes (e.g. DISA "BAKAA" → v1 "DISABAKAA"). Strip it before comparing.
    field: "facility_code",
    comparator: stringCiStripV1Prefix("DISA"),
    getDisa: (s) => s.Facility?.Code ?? null,
    getV1: (r) => r.RequestingFacilityCode,
  },
  {
    field: "facility_name",
    comparator: stringCi,
    getDisa: (s) => s.Facility?.FacilityName ?? null,
    getV1: (r) => splitPointOfCare(r.LIMSPointOfCareDesc).facilityName,
  },
  {
    field: "ward",
    comparator: stringCi,
    getDisa: (s) => s.WardClinic,
    getV1: (r) => splitPointOfCare(r.LIMSPointOfCareDesc).ward,
  },
  {
    field: "panel_code",
    comparator: stringCi,
    getDisa: (s) => (s.TestOrders.length > 0 ? String(s.TestOrders[0]) : null),
    getV1: (r) => r.LIMSPanelCode,
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
    // ReceivedDateTime — match either candidate.
    getDisa: (s) => [s.ReceivedInLabDateTime, s.RegisteredDateTime],
    getV1: (r) => r.ReceivedDateTime,
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
    comparator: stringCi,
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

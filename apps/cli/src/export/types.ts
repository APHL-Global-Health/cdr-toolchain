// V2 payload TypeScript shape — mirrors temp/default.schema.example.json.
// Keep this file the single source of truth for the v2 contract; if v2's
// OpenAPI later ships generated types, swap this for the import.

export interface V2ConceptCode {
  /** Omitted from JSON when undefined (matches the v2 example schema where
   *  organism / antibiotic concept blocks carry no system_id). */
  system_id?: string;
  concept_code: string;
  display_name: string | null;
  concept_class: string;
  datatype: string;
  properties?: Record<string, unknown>;
}

export interface V2Patient {
  patient_guid: string | null;
  firstname: string | null;
  middlename: string | null;
  surname: string | null;
  sex: string | null;
  folder_no: string | null;
  date_of_birth: string | null;
  phone: string | null;
  email: string | null;
  national_id: string | null;
  patient_data: Record<string, unknown>;
}

export interface V2LabRequest {
  request_id: string;
  facility_code: V2ConceptCode | null;
  panel_code: V2ConceptCode | null;
  specimen_code: V2ConceptCode | null;
  taken_datetime: string | null;
  collected_datetime: string | null;
  received_at: string | null;
  registered_at: string | null;
  analysis_at: string | null;
  authorised_at: string | null;
  clinical_info: string | null;
  icd10_codes: string | null;
  therapy: string | null;
  priority: string | null;
  age_years: number | null;
  age_days: number | null;
  sex: string | null;
  patient_class: string | null;
  section_code: string | null;
  result_status: string | null;
  requesting_facility_code: V2ConceptCode | null;
  testing_facility_code: V2ConceptCode | null;
  requesting_doctor: string | null;
  tested_by: string | null;
  authorised_by: string | null;
  source_payload: Record<string, unknown>;
}

export interface V2LabResult {
  source_test_code: string;
  /** HL7 OBX-1: 1-based position of this observation within its panel
   *  (resets per (panelCode, panelIndex)). */
  obx_set_id: number;
  /** HL7 OBX-4: sub-ID for repeated sub-components of one observation.
   *  Always 0 for DISA — DISA OrderItems are flat (no sub-fields). */
  obx_sub_id: number;
  observation_code: V2ConceptCode;
  result_value: string | null;
  result_type: string | null;
  numeric_value: number | null;
  coded_value: string | null;
  text_value: string | null;
  numeric_units: string | null;
  abnormal_flag: string | null;
  rpt_units: string | null;
  rpt_flag: string | null;
  rpt_range: string | null;
  result_timestamp: string | null;
  isolate_index: number | null;
  is_resulted: boolean;
  raw_result: Record<string, unknown>;
}

export interface V2Isolate {
  isolate_index: number;
  source_test_code: string;
  organism_code: V2ConceptCode;
  organism_type: "bacteria" | "fungus" | "parasite" | "none";
  isolate_number: string;
  serotype: string | null;
  patient_age_days: number | null;
  patient_sex: string | null;
  ward: string | null;
  ward_type: string | null;
  origin: string | null;
  beta_lactamase: string | null;
  esbl: string | null;
  carbapenemase: string | null;
  mrsa_screen: string | null;
  inducible_clinda: string | null;
  custom_fields: Record<string, unknown> | null;
  raw_result: Record<string, unknown>;
}

export interface V2SusceptibilityTest {
  isolate_index: number | null;
  source_test_code: string;
  antibiotic_code: V2ConceptCode;
  test_method: "DISK" | "MIC" | null;
  disk_potency: string | null;
  result_raw: string | null;
  result_numeric: number | null;
  susceptibility_value: "S" | "I" | "R" | null;
  quantitative_value: string | null;
  guideline: string | null;
  guideline_version: string | null;
  raw_result: Record<string, unknown>;
}

export interface V2DataQuality {
  /** Severity ladder: info < warn < error. Highest seen across anomalies. */
  max_severity: "info" | "warn" | "error";
  /** When the audit ran. ISO-8601 with milliseconds + Z. */
  audited_at: string;
  /** One entry per detected anomaly. Shape mirrors the `Anomaly` type
   *  from apps/cli/src/audit/types.ts but kept structurally compatible
   *  here so v2 consumers don't need to import from the audit module. */
  anomalies: Array<{
    class: string;
    severity: "info" | "warn" | "error";
    message: string;
    panel_code?: string;
    panel_index?: number;
    observation_code?: string;
    details: Record<string, unknown>;
  }>;
}

export interface V2Payload {
  patient: V2Patient;
  lab_request: V2LabRequest;
  lab_results: V2LabResult[];
  isolates: V2Isolate[];
  susceptibility_tests: V2SusceptibilityTest[];
  /** Present only when the audit found at least one anomaly. Clean labs
   *  produce payloads without this field, keeping output byte-identical
   *  to pre-audit behaviour. Suppressible via `--no-data-quality`. */
  data_quality?: V2DataQuality;
}

// ---------- OpenLDR v1 row shapes -----------------------------------------
//
// Mirror the [OpenLDRData].[dbo].[Requests] (60 cols) and
// [OpenLDRData].[dbo].[LabResults] (28 cols) tables as closely as DISA can
// supply. Four LIS-generated metadata columns are intentionally null:
//   DateTimeStamp, Versionstamp, LIMSDateTimeStamp, LIMSVersionStamp
// — those are stamped by OpenLDR itself when ingesting an HL7 message.
//
// Strings default to "" (not null) to match v1's convention; numerics
// default to 0; bits/tinyints default to false/0. The canonical empty
// representation should be exactly what would land in the SQL row.

export interface V1Request {
  DateTimeStamp: string | null;
  Versionstamp: string | null;
  LIMSDateTimeStamp: string | null;
  LIMSVersionstamp: string | null;
  RequestID: string;
  OBRSetID: number;
  LOINCPanelCode: string;
  LIMSPanelCode: string;
  LIMSPanelDesc: string;
  HL7PriorityCode: string;
  SpecimenDateTime: string | null;
  RegisteredDateTime: string | null;
  ReceivedDateTime: string | null;
  AnalysisDateTime: string | null;
  AuthorisedDateTime: string | null;
  AdmitAttendDateTime: string | null;
  CollectionVolume: number;
  RequestingFacilityCode: string;
  ReceivingFacilityCode: string;
  LIMSPointOfCareDesc: string;
  RequestTypeCode: string;
  ICD10ClinicalInfoCodes: string;
  ClinicalInfo: string;
  HL7SpecimenSourceCode: string;
  LIMSSpecimenSourceCode: string;
  LIMSSpecimenSourceDesc: string;
  HL7SpecimenSiteCode: string;
  LIMSSpecimenSiteCode: string;
  LIMSSpecimenSiteDesc: string;
  WorkUnits: number;
  CostUnits: number;
  HL7SectionCode: string;
  HL7ResultStatusCode: string;
  RegisteredBy: string;
  TestedBy: string;
  AuthorisedBy: string;
  OrderingNotes: string;
  EncryptedPatientID: string;
  AgeInYears: number;
  AgeInDays: number;
  HL7SexCode: string;
  HL7EthnicGroupCode: string;
  Deceased: boolean;
  Newborn: boolean;
  HL7PatientClassCode: string;
  AttendingDoctor: string;
  TestingFacilityCode: string;
  ReferringRequestID: string;
  Therapy: string;
  LIMSAnalyzerCode: string;
  TargetTimeDays: number;
  TargetTimeMins: number;
  LIMSRejectionCode: string;
  LIMSRejectionDesc: string;
  LIMSFacilityCode: string;
  Repeated: number;
  LIMSPreReg_RegistrationDateTime: string | null;
  LIMSPreReg_ReceivedDateTime: string | null;
  LIMSPreReg_RegistrationFacilityCode: string;
  LIMSVendorCode: string;
}

export interface V1LabResult {
  DateTimeStamp: string | null;
  Versionstamp: string | null;
  LIMSDateTimeStamp: string | null;
  LIMSVersionStamp: string | null;
  RequestID: string;
  OBRSetID: number;
  OBXSetID: number;
  OBXSubID: number;
  LOINCCode: string;
  HL7ResultTypeCode: string;
  SIValue: number;
  SIUnits: string;
  SILoRange: number;
  SIHiRange: number;
  HL7AbnormalFlagCodes: string;
  DateTimeValue: string | null;
  CodedValue: string;
  ResultSemiquantitive: number;
  Note: boolean;
  LIMSObservationCode: string;
  LIMSObservationDesc: string;
  LIMSRptResult: string;
  LIMSRptUnits: string;
  LIMSRptFlag: string;
  LIMSRptRange: string;
  LIMSCodedValue: string;
  WorkUnits: number;
  CostUnits: number;
}

export interface V1Payload {
  requests: V1Request[];
  lab_results: V1LabResult[];
}

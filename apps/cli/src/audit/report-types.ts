import type { Anomaly, AnomalyClass, Severity } from "./types.js";

/** One sample anomaly preserved per class for the detailed-findings section.
 *  We keep the full Anomaly plus the lab number it came from. */
export interface AuditSample {
  lab_number: string;
  request_id: string;
  source: "disa" | "openldr";
  anomaly: Anomaly;
}

/** Aggregated results suitable for a report. Computed by streaming the
 *  audit NDJSON output once — never holds all per-lab reports in memory. */
export interface AuditAggregation {
  /** "disa", "openldr", or "mixed" if the input contained both. */
  source: "disa" | "openldr" | "mixed";
  total_labs_scanned: number;
  total_labs_with_anomalies: number;
  total_labs_errored: number;
  total_anomalies: number;
  total_panels_scanned: number;
  total_observations_scanned: number;
  /** Per-class breakdown ordered by severity then count, descending. */
  per_class: Array<{
    class: AnomalyClass;
    severity: Severity;
    count: number;
    affected_labs: number;
    samples: AuditSample[];
  }>;
  per_severity: Record<Severity, number>;
  /** Top-N panel codes by anomaly count, descending. */
  top_panels: Array<{ panel_code: string; anomaly_count: number; affected_labs: number }>;
  /** Aggregated unique error messages from labs that couldn't be scanned. */
  errors: Array<{ message: string; count: number; sample_labs: string[] }>;
  /** Wall-clock duration of the input scan (sum of per-lab elapsed_ms when
   *  reading NDJSON; not the report's own runtime). */
  scan_duration_ms: number;
  /** Optional user-supplied total-labs hint for the forecast section. */
  estimated_total_labs?: number;
}

export type ReportFormat = "pdf" | "docx" | "md" | "html";

export interface ReportOpts {
  title: string;
  generatedAt: Date;
  /** Max samples kept per anomaly class. Caps the renderer footprint
   *  even when input has thousands of hits in a single class. */
  maxSamplesPerClass: number;
}

/** Per-class human-readable description used in the methodology section.
 *  Keeps the renderer code free of long strings and lets the audit
 *  team update wording without touching the visual layout logic. */
export const CLASS_DESCRIPTIONS: Record<AnomalyClass, { title: string; rule: string; severity: Severity }> = {
  panel_specimen_mismatch: {
    title: "Panel / specimen mismatch",
    rule: "Panel description implies one specimen kind (e.g. urine, blood, CSF) but the request's specimen description implies a different kind. Caused by registration data-entry errors at lab intake.",
    severity: "error",
  },
  dob_after_specimen_date: {
    title: "DOB after specimen date",
    rule: "Patient DOB is later than the earliest specimen-event date (taken / collected / received). Means the patient was \"born\" after their sample was collected — impossible.",
    severity: "error",
  },
  dob_future_dated: {
    title: "DOB in the future",
    rule: "Patient DOB is later than today.",
    severity: "error",
  },
  observation_wrong_panel: {
    title: "Observation under wrong panel",
    rule: "Antibiotic-susceptibility observations (PARMDICT context 60/79) appearing inside a microscopy-described panel — observation was filed against the wrong TESTDATA block.",
    severity: "error",
  },
  specimen_missing: {
    title: "Specimen missing",
    rule: "Panel description implies a specimen kind, but the request has no specimen code recorded at all. v2's storage stage requires specimen_concept_id — a null specimen_code never maps and storage rejects. Common on chemistry / serology orders where registrars assume blood. Fix the upstream data before re-attempting; do not inject a placeholder.",
    severity: "error",
  },
  cross_panel_duplicate_observation: {
    title: "Cross-panel duplicate observation",
    rule: "Same observation code appears under multiple panels with disjoint specimen kinds — suggests a mis-attribution at TESTDATA-write time.",
    severity: "warn",
  },
  result_unrealistic_numeric: {
    title: "Unrealistic numeric value",
    rule: "Numeric value > 1e12 or < 1e-6 (excluding 0). Almost always uninitialised-float garbage from a misdecoded DISA blob slot — not a real lab measurement.",
    severity: "warn",
  },
  result_contains_control_chars: {
    title: "Stray control bytes in result",
    rule: "Result string contains control bytes (0x01-0x1F excluding tab/LF/CR). Decode-layer bug leaking adjacent blob bytes into a value field.",
    severity: "warn",
  },
  result_format_microscopy_count: {
    title: "Microscopy count format",
    rule: "Microscopy parameter (WBC, RBC, leucocytes, epithelial cells) value doesn't match a recognised count, range, or semi-quantitative pattern.",
    severity: "warn",
  },
  result_format_invalid_decoded: {
    title: "\"Invalid\" decoded outside AST",
    rule: "Coded result decoded to literal \"Invalid\" outside an antibiotic-susceptibility context — known Tanzania COMMDICT typo at CONTEXT=79 (should be \"Intermediate\").",
    severity: "warn",
  },
  sex_code_invalid: {
    title: "Sex code invalid",
    rule: "Sex code outside the accepted set: M, F, U, I, blank.",
    severity: "warn",
  },
  orphan_ordered_panel: {
    title: "Orphan ordered panel",
    rule: "Panel was ordered (appears in TestOrders) but has no observations recorded against it. Often legitimate (e.g. MSENS ordered prophylactically) but worth tracking volume.",
    severity: "info",
  },
  panel_iterations_superseded: {
    title: "Panel iterations superseded",
    rule: "DISA stored multiple TESTINDEX iterations of the same panel (preliminary + final, or repeat-tech verification). v1's historical migration kept only the final iteration; the v2 export mirrors that choice, so observations from earlier iterations were dropped. Anomaly records what was dropped so reviewers can see panel reruns explicitly.",
    severity: "info",
  },
  specimen_description_vague: {
    title: "Specimen description vague",
    rule: "Specimen has a code but its description doesn't tokenise to any known specimen kind — vocabulary gap in the audit detector.",
    severity: "info",
  },
  result_format_units_inline: {
    title: "Units typed inline",
    rule: "Numeric value contains units inline (e.g. \"5 mg/dL\") even though PARMDICT supplies them separately.",
    severity: "info",
  },
};

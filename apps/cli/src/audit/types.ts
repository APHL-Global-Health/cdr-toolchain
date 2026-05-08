export type AnomalyClass =
  | "panel_specimen_mismatch"
  | "specimen_description_vague"
  | "specimen_missing"
  | "observation_wrong_panel"
  | "cross_panel_duplicate_observation"
  | "orphan_ordered_panel"
  | "result_format_invalid_decoded"
  | "result_format_units_inline"
  | "result_format_microscopy_count"
  | "result_unrealistic_numeric"
  | "result_contains_control_chars"
  | "dob_after_specimen_date"
  | "dob_future_dated"
  | "sex_code_invalid";

export type Severity = "info" | "warn" | "error";

export interface Anomaly {
  class: AnomalyClass;
  severity: Severity;
  message: string;
  panel_code?: string;
  panel_index?: number;
  observation_code?: string;
  details: Record<string, unknown>;
}

export interface AuditReport {
  lab_number: string;
  request_id: string;
  source: "disa" | "openldr";
  scanned_panels: number;
  scanned_observations: number;
  anomalies: Anomaly[];
  max_severity: Severity | null;
  elapsed_ms: number;
}

const SEVERITY_RANK: Record<Severity, number> = { info: 1, warn: 2, error: 3 };

export function severityRank(s: Severity): number {
  return SEVERITY_RANK[s];
}

export function maxSeverity(anomalies: Anomaly[]): Severity | null {
  let best: Severity | null = null;
  for (const a of anomalies) {
    if (best === null || severityRank(a.severity) > severityRank(best)) {
      best = a.severity;
    }
  }
  return best;
}

export function severityAtLeast(actual: Severity | null, threshold: Severity): boolean {
  if (actual === null) return false;
  return severityRank(actual) >= severityRank(threshold);
}

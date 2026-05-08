import type { AuditAggregation } from "../report-types.js";

export interface ForecastRow {
  metric: string;
  scanned: number;
  per_lab_rate: string;
  forecast: string;
}

/** Compute estimated full-deployment numbers when the user supplied
 *  --total-labs. Returns null when no estimate is available. */
export function computeForecast(agg: AuditAggregation): ForecastRow[] | null {
  const total = agg.estimated_total_labs;
  if (total === undefined || total <= 0 || agg.total_labs_scanned === 0) return null;

  const rate = (n: number): string => (n / agg.total_labs_scanned).toFixed(4);
  const project = (n: number): string => Math.round((n / agg.total_labs_scanned) * total).toLocaleString();

  return [
    {
      metric: "Labs with anomalies",
      scanned: agg.total_labs_with_anomalies,
      per_lab_rate: rate(agg.total_labs_with_anomalies),
      forecast: project(agg.total_labs_with_anomalies),
    },
    {
      metric: "Labs errored (unfetchable)",
      scanned: agg.total_labs_errored,
      per_lab_rate: rate(agg.total_labs_errored),
      forecast: project(agg.total_labs_errored),
    },
    {
      metric: "Total anomalies",
      scanned: agg.total_anomalies,
      per_lab_rate: rate(agg.total_anomalies),
      forecast: project(agg.total_anomalies),
    },
    {
      metric: "Error-severity anomalies",
      scanned: agg.per_severity.error,
      per_lab_rate: rate(agg.per_severity.error),
      forecast: project(agg.per_severity.error),
    },
    {
      metric: "Warn-severity anomalies",
      scanned: agg.per_severity.warn,
      per_lab_rate: rate(agg.per_severity.warn),
      forecast: project(agg.per_severity.warn),
    },
  ];
}

export function pct(part: number, whole: number): string {
  if (whole === 0) return "0.00%";
  return `${((part / whole) * 100).toFixed(2)}%`;
}

export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const sr = Math.round(s % 60);
  if (m < 60) return `${m}m ${sr}s`;
  const h = Math.floor(m / 60);
  const mr = m % 60;
  return `${h}h ${mr}m`;
}

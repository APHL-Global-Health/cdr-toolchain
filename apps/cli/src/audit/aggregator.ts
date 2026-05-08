import type { Anomaly, AnomalyClass, AuditReport, Severity } from "./types.js";
import { CLASS_DESCRIPTIONS, type AuditAggregation, type AuditSample } from "./report-types.js";

const TOP_PANELS_LIMIT = 25;
const ERROR_SAMPLES_PER_BUCKET = 5;
const SEVERITY_RANK: Record<Severity, number> = { info: 1, warn: 2, error: 3 };

/** A single row from the audit-batch NDJSON stream. The shape is either
 *  a successful AuditReport or a `{lab_number, source, error}` envelope
 *  for labs the batch couldn't fetch. */
type AuditNdjsonLine =
  | AuditReport
  | { lab_number: string; request_id?: string; source: "disa" | "openldr"; error: string };

interface ClassBucket {
  class: AnomalyClass;
  severity: Severity;
  count: number;
  affected_labs: Set<string>;
  samples: AuditSample[];
}

interface PanelBucket {
  panel_code: string;
  anomaly_count: number;
  affected_labs: Set<string>;
}

interface ErrorBucket {
  message: string;
  count: number;
  sample_labs: string[];
}

export interface AggregatorOpts {
  /** Cap samples per anomaly class. Default 10. */
  maxSamplesPerClass?: number;
}

export class AuditAggregator {
  private readonly maxSamples: number;
  private sources = new Set<"disa" | "openldr">();
  private classBuckets = new Map<AnomalyClass, ClassBucket>();
  private panelBuckets = new Map<string, PanelBucket>();
  private errorBuckets = new Map<string, ErrorBucket>();
  private severityCounts: Record<Severity, number> = { info: 0, warn: 0, error: 0 };

  private totalLabsScanned = 0;
  private totalLabsWithAnomalies = 0;
  private totalLabsErrored = 0;
  private totalAnomalies = 0;
  private totalPanelsScanned = 0;
  private totalObservationsScanned = 0;
  private scanDurationMs = 0;
  /** When the NDJSON contains an `audit-batch-summary` line, we use its
   *  totals as authoritative — they reflect the full batch even when
   *  --only-anomalies suppressed the clean-lab lines. */
  private summaryFromBatch: { labs_scanned: number; labs_errored: number } | null = null;

  constructor(opts: AggregatorOpts = {}) {
    this.maxSamples = opts.maxSamplesPerClass ?? 10;
  }

  /** Process one NDJSON line. Silently ignores blank lines and
   *  the audit-batch summary row (it has _meta="audit-batch-summary"). */
  ingest(rawLine: string): void {
    const line = rawLine.trim();
    if (line.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // skip malformed lines silently — caller emits warnings
    }
    if (parsed === null || typeof parsed !== "object") return;
    const obj = parsed as Record<string, unknown>;
    if (obj["_meta"] === "audit-batch-summary") {
      const ls = obj["labs_scanned"];
      const le = obj["labs_errored"];
      if (typeof ls === "number" && typeof le === "number") {
        this.summaryFromBatch = { labs_scanned: ls, labs_errored: le };
      }
      return;
    }
    this.ingestObject(obj as AuditNdjsonLine);
  }

  ingestObject(line: AuditNdjsonLine): void {
    if ("error" in line && typeof line.error === "string") {
      this.totalLabsScanned++;
      this.totalLabsErrored++;
      this.bumpError(line.error, line.lab_number);
      this.sources.add(line.source);
      return;
    }
    const report = line as AuditReport;
    this.totalLabsScanned++;
    this.totalPanelsScanned += report.scanned_panels;
    this.totalObservationsScanned += report.scanned_observations;
    this.scanDurationMs += report.elapsed_ms;
    this.sources.add(report.source);
    if (report.anomalies.length > 0) this.totalLabsWithAnomalies++;
    for (const a of report.anomalies) {
      this.bumpClass(a, report);
      if (a.panel_code !== undefined && a.panel_code.length > 0) {
        this.bumpPanel(a.panel_code, report.lab_number);
      }
    }
    this.totalAnomalies += report.anomalies.length;
  }

  private bumpClass(a: Anomaly, report: AuditReport): void {
    const bucket = this.classBuckets.get(a.class) ?? {
      class: a.class,
      severity: a.severity,
      count: 0,
      affected_labs: new Set<string>(),
      samples: [],
    };
    bucket.count++;
    bucket.affected_labs.add(report.lab_number);
    if (bucket.samples.length < this.maxSamples) {
      bucket.samples.push({
        lab_number: report.lab_number,
        request_id: report.request_id,
        source: report.source,
        anomaly: a,
      });
    }
    // Take the highest severity ever seen for this class — defends against
    // future detector changes that emit a class at varying severities.
    if (SEVERITY_RANK[a.severity] > SEVERITY_RANK[bucket.severity]) {
      bucket.severity = a.severity;
    }
    this.classBuckets.set(a.class, bucket);
    this.severityCounts[a.severity]++;
  }

  private bumpPanel(panelCode: string, labNumber: string): void {
    const bucket = this.panelBuckets.get(panelCode) ?? {
      panel_code: panelCode,
      anomaly_count: 0,
      affected_labs: new Set<string>(),
    };
    bucket.anomaly_count++;
    bucket.affected_labs.add(labNumber);
    this.panelBuckets.set(panelCode, bucket);
  }

  private bumpError(message: string, labNumber: string): void {
    const bucket = this.errorBuckets.get(message) ?? {
      message,
      count: 0,
      sample_labs: [],
    };
    bucket.count++;
    if (bucket.sample_labs.length < ERROR_SAMPLES_PER_BUCKET) {
      bucket.sample_labs.push(labNumber);
    }
    this.errorBuckets.set(message, bucket);
  }

  /** True if the input NDJSON contained an `audit-batch-summary` line.
   *  When false, totals reflect only the lines actually in the stream —
   *  an --only-anomalies run will undercount unless the summary was
   *  captured (it normally goes to stderr). */
  hasAuthoritativeTotals(): boolean {
    return this.summaryFromBatch !== null;
  }

  finalize(estimatedTotalLabs?: number): AuditAggregation {
    const perClass: AuditAggregation["per_class"] = [];
    // Ensure every known class appears in the output (with zeros) so the
    // report's methodology section can claim "we checked X classes" honestly.
    for (const klass of Object.keys(CLASS_DESCRIPTIONS) as AnomalyClass[]) {
      const meta = CLASS_DESCRIPTIONS[klass];
      const bucket = this.classBuckets.get(klass);
      if (bucket === undefined) {
        perClass.push({
          class: klass,
          severity: meta.severity,
          count: 0,
          affected_labs: 0,
          samples: [],
        });
      } else {
        perClass.push({
          class: bucket.class,
          severity: bucket.severity,
          count: bucket.count,
          affected_labs: bucket.affected_labs.size,
          samples: bucket.samples,
        });
      }
    }
    perClass.sort((a, b) => {
      const sev = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (sev !== 0) return sev;
      return b.count - a.count;
    });

    const topPanels = [...this.panelBuckets.values()]
      .sort((a, b) => b.anomaly_count - a.anomaly_count)
      .slice(0, TOP_PANELS_LIMIT)
      .map((b) => ({
        panel_code: b.panel_code,
        anomaly_count: b.anomaly_count,
        affected_labs: b.affected_labs.size,
      }));

    const errors = [...this.errorBuckets.values()]
      .sort((a, b) => b.count - a.count)
      .map((b) => ({ message: b.message, count: b.count, sample_labs: b.sample_labs }));

    const source: "disa" | "openldr" | "mixed" =
      this.sources.size === 0 ? "disa"
      : this.sources.size === 1 ? [...this.sources][0]!
      : "mixed";

    // Prefer the summary's totals when present — they reflect the full
    // batch even if the NDJSON was filtered with --only-anomalies.
    const totalScanned = this.summaryFromBatch?.labs_scanned ?? this.totalLabsScanned;
    const totalErrored = this.summaryFromBatch?.labs_errored ?? this.totalLabsErrored;

    return {
      source,
      total_labs_scanned: totalScanned,
      total_labs_with_anomalies: this.totalLabsWithAnomalies,
      total_labs_errored: totalErrored,
      total_anomalies: this.totalAnomalies,
      total_panels_scanned: this.totalPanelsScanned,
      total_observations_scanned: this.totalObservationsScanned,
      per_class: perClass,
      per_severity: this.severityCounts,
      top_panels: topPanels,
      errors,
      scan_duration_ms: this.scanDurationMs,
      ...(estimatedTotalLabs !== undefined ? { estimated_total_labs: estimatedTotalLabs } : {}),
    };
  }
}

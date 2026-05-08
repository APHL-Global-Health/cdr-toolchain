import type { Severity } from "../types.js";
import type { AuditAggregation, ReportOpts } from "../report-types.js";
import { CLASS_DESCRIPTIONS } from "../report-types.js";
import { computeForecast, formatDurationMs, pct } from "./forecast.js";

const SEV_TAG: Record<Severity, string> = {
  info: "[INFO]",
  warn: "[WARN]",
  error: "[ERROR]",
};

function safeInline(s: string): string {
  // GFM table cells: pipes break the row — escape them. Backslashes too.
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderMarkdown(agg: AuditAggregation, opts: ReportOpts): string {
  const lines: string[] = [];
  lines.push(`# ${opts.title}`);
  lines.push("");
  lines.push(`*Generated: ${opts.generatedAt.toISOString()}*  `);
  lines.push(`*Source: \`${agg.source}\`*  `);
  lines.push(`*Scan window duration (sum of per-lab elapsed): ${formatDurationMs(agg.scan_duration_ms)}*`);
  lines.push("");
  lines.push("---");
  lines.push("");

  // ---- Executive summary ----
  lines.push("## Executive summary");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("|---|---:|");
  lines.push(`| Labs scanned | ${agg.total_labs_scanned.toLocaleString()} |`);
  lines.push(`| Labs with anomalies | ${agg.total_labs_with_anomalies.toLocaleString()} (${pct(agg.total_labs_with_anomalies, agg.total_labs_scanned)}) |`);
  lines.push(`| Labs errored (unfetchable) | ${agg.total_labs_errored.toLocaleString()} (${pct(agg.total_labs_errored, agg.total_labs_scanned)}) |`);
  lines.push(`| Total anomalies | ${agg.total_anomalies.toLocaleString()} |`);
  lines.push(`| Panels scanned | ${agg.total_panels_scanned.toLocaleString()} |`);
  lines.push(`| Observations scanned | ${agg.total_observations_scanned.toLocaleString()} |`);
  lines.push("");
  lines.push("**By severity:**");
  lines.push("");
  lines.push("| Severity | Count |");
  lines.push("|---|---:|");
  lines.push(`| Error | ${agg.per_severity.error.toLocaleString()} |`);
  lines.push(`| Warn | ${agg.per_severity.warn.toLocaleString()} |`);
  lines.push(`| Info | ${agg.per_severity.info.toLocaleString()} |`);
  lines.push("");

  // ---- Forecast ----
  const forecast = computeForecast(agg);
  if (forecast !== null) {
    lines.push("## Forecast for full deployment");
    lines.push("");
    lines.push(`Estimated total labs in deployment: **${agg.estimated_total_labs!.toLocaleString()}**.`);
    lines.push("Forecasts are linear scans × estimated total. Actual ratios may differ when sampling missed certain dataset eras (e.g. older labs with different schemas).");
    lines.push("");
    lines.push("| Metric | Scanned | Per lab | Forecast |");
    lines.push("|---|---:|---:|---:|");
    for (const r of forecast) {
      lines.push(`| ${r.metric} | ${r.scanned.toLocaleString()} | ${r.per_lab_rate} | ${r.forecast} |`);
    }
    lines.push("");
  }

  // ---- Per-class breakdown ----
  lines.push("## Anomalies by class");
  lines.push("");
  lines.push("Sorted by severity (highest first), then by hit count.");
  lines.push("");
  lines.push("| Severity | Class | Hits | Affected labs | % of scanned |");
  lines.push("|---|---|---:|---:|---:|");
  for (const c of agg.per_class) {
    const meta = CLASS_DESCRIPTIONS[c.class];
    lines.push(`| ${SEV_TAG[c.severity]} | ${meta.title} (\`${c.class}\`) | ${c.count.toLocaleString()} | ${c.affected_labs.toLocaleString()} | ${pct(c.affected_labs, agg.total_labs_scanned)} |`);
  }
  lines.push("");

  // ---- Detailed findings ----
  lines.push("## Detailed findings");
  lines.push("");
  for (const c of agg.per_class) {
    if (c.count === 0) continue;
    const meta = CLASS_DESCRIPTIONS[c.class];
    lines.push(`### ${SEV_TAG[c.severity]} ${meta.title}`);
    lines.push("");
    lines.push(meta.rule);
    lines.push("");
    lines.push(`**Hits: ${c.count.toLocaleString()} across ${c.affected_labs.toLocaleString()} labs.**`);
    lines.push("");
    lines.push(`Up to ${opts.maxSamplesPerClass} sample labs:`);
    lines.push("");
    lines.push("| Lab | Panel / Observation | Message |");
    lines.push("|---|---|---|");
    for (const sample of c.samples) {
      const where = sample.anomaly.observation_code !== undefined
        ? `obs \`${sample.anomaly.observation_code}\``
        : sample.anomaly.panel_code !== undefined
          ? `panel \`${sample.anomaly.panel_code}\``
          : "";
      lines.push(`| ${sample.lab_number} | ${where} | ${safeInline(sample.anomaly.message)} |`);
    }
    lines.push("");
  }

  // ---- Top affected panels ----
  if (agg.top_panels.length > 0) {
    lines.push("## Top affected panels");
    lines.push("");
    lines.push("| Panel code | Anomalies | Affected labs |");
    lines.push("|---|---:|---:|");
    for (const p of agg.top_panels) {
      lines.push(`| \`${p.panel_code}\` | ${p.anomaly_count.toLocaleString()} | ${p.affected_labs.toLocaleString()} |`);
    }
    lines.push("");
  }

  // ---- Errors ----
  if (agg.errors.length > 0) {
    lines.push("## Unfetchable labs");
    lines.push("");
    lines.push("Labs the audit pipeline couldn't fetch (typically SQL escape bugs in DISA-side lab numbers, or labs with NULL-byte chars). Excluded from anomaly counts.");
    lines.push("");
    lines.push("| Error | Count | Sample labs |");
    lines.push("|---|---:|---|");
    for (const e of agg.errors) {
      lines.push(`| ${safeInline(e.message)} | ${e.count.toLocaleString()} | ${e.sample_labs.join(", ")} |`);
    }
    lines.push("");
  }

  // ---- Methodology ----
  lines.push("## Methodology");
  lines.push("");
  lines.push("Each lab is examined for the following anomaly classes. The detector is a pure function over either a DISA `SpecimenRecpt` or a projected OpenLDR v1 row set (see `apps/cli/src/audit/detector.ts`).");
  lines.push("");
  for (const klass of Object.keys(CLASS_DESCRIPTIONS) as Array<keyof typeof CLASS_DESCRIPTIONS>) {
    const meta = CLASS_DESCRIPTIONS[klass];
    lines.push(`- **${SEV_TAG[meta.severity]} ${meta.title}** — ${meta.rule}`);
  }
  lines.push("");

  // ---- Limitations ----
  lines.push("## Limitations");
  lines.push("");
  lines.push("- DOB checks (`dob_after_specimen_date`, `dob_future_dated`) skip cleanly when the source is OpenLDR v1, because v1 doesn't preserve raw DOB strings (only `AgeInYears`/`AgeInDays`).");
  lines.push("- The panel-vs-specimen mismatch detector relies on a hand-curated keyword vocabulary. New deployments may need the vocabulary widened (see `apps/cli/src/audit/specimen-vocab.ts`) before this class catches all real mismatches.");
  lines.push("- Result-format heuristics intentionally err toward false negatives over false positives.");
  lines.push("- Forecast section assumes the scan sample is representative of the full deployment. Older eras of the database may have different schemas or data-entry conventions.");
  lines.push("");

  return lines.join("\n");
}

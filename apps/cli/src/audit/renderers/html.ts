import type { Severity } from "../types.js";
import type { AuditAggregation, ReportOpts } from "../report-types.js";
import { CLASS_DESCRIPTIONS } from "../report-types.js";
import { computeForecast, formatDurationMs, pct } from "./forecast.js";

const SEV_COLOR: Record<Severity, string> = {
  info: "#5b6b7a",
  warn: "#a3700e",
  error: "#a72020",
};
const SEV_BG: Record<Severity, string> = {
  info: "#eef1f5",
  warn: "#fdf3da",
  error: "#fbe6e6",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function badge(sev: Severity): string {
  return `<span class="badge" style="background:${SEV_BG[sev]};color:${SEV_COLOR[sev]};border:1px solid ${SEV_COLOR[sev]}">${sev.toUpperCase()}</span>`;
}

function num(n: number): string {
  return n.toLocaleString();
}

export function renderHtml(agg: AuditAggregation, opts: ReportOpts): string {
  const out: string[] = [];
  out.push(`<!DOCTYPE html>`);
  out.push(`<html lang="en"><head><meta charset="utf-8">`);
  out.push(`<title>${esc(opts.title)}</title>`);
  out.push(`<style>
    :root { color-scheme: light; }
    body { font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 1100px; margin: 32px auto; padding: 0 24px; color: #1a1a1a; }
    h1 { font-size: 26px; margin: 0 0 4px; }
    h2 { font-size: 19px; margin: 36px 0 12px; padding-bottom: 6px; border-bottom: 1px solid #ddd; }
    h3 { font-size: 16px; margin: 24px 0 8px; }
    .meta { color: #666; font-size: 12px; margin-bottom: 32px; }
    table { border-collapse: collapse; width: 100%; margin: 8px 0 20px; font-size: 13px; }
    th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #e3e6ea; vertical-align: top; }
    th { background: #f5f7fa; font-weight: 600; }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; letter-spacing: 0.04em; }
    code { background: #f0f2f5; padding: 1px 5px; border-radius: 3px; font-size: 12px; }
    .muted { color: #666; font-size: 12px; }
    .summary-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .card { border: 1px solid #e3e6ea; border-radius: 6px; padding: 14px 18px; background: #fafbfc; }
    .card h3 { margin: 0 0 8px; font-size: 13px; text-transform: uppercase; letter-spacing: 0.05em; color: #666; }
    .card .v { font-size: 24px; font-weight: 600; }
    .card .sub { color: #666; font-size: 12px; margin-top: 2px; }
    ul.methodology { padding-left: 18px; }
    ul.methodology li { margin-bottom: 4px; }
  </style></head><body>`);

  out.push(`<h1>${esc(opts.title)}</h1>`);
  out.push(`<div class="meta">Generated ${esc(opts.generatedAt.toISOString())} &middot; Source <code>${esc(agg.source)}</code> &middot; Scan duration ${esc(formatDurationMs(agg.scan_duration_ms))}</div>`);

  // ---- Executive summary ----
  out.push(`<h2>Executive summary</h2>`);
  out.push(`<div class="summary-grid">`);
  out.push(`<div class="card"><h3>Labs scanned</h3><div class="v">${num(agg.total_labs_scanned)}</div></div>`);
  out.push(`<div class="card"><h3>Labs with anomalies</h3><div class="v">${num(agg.total_labs_with_anomalies)}</div><div class="sub">${pct(agg.total_labs_with_anomalies, agg.total_labs_scanned)} of scanned</div></div>`);
  out.push(`<div class="card"><h3>Total anomalies</h3><div class="v">${num(agg.total_anomalies)}</div></div>`);
  out.push(`<div class="card"><h3>Labs errored</h3><div class="v">${num(agg.total_labs_errored)}</div><div class="sub">${pct(agg.total_labs_errored, agg.total_labs_scanned)} unfetchable</div></div>`);
  out.push(`</div>`);

  out.push(`<table><thead><tr><th>Severity</th><th class="num">Count</th></tr></thead><tbody>`);
  out.push(`<tr><td>${badge("error")}</td><td class="num">${num(agg.per_severity.error)}</td></tr>`);
  out.push(`<tr><td>${badge("warn")}</td><td class="num">${num(agg.per_severity.warn)}</td></tr>`);
  out.push(`<tr><td>${badge("info")}</td><td class="num">${num(agg.per_severity.info)}</td></tr>`);
  out.push(`</tbody></table>`);

  // ---- Forecast ----
  const forecast = computeForecast(agg);
  if (forecast !== null) {
    out.push(`<h2>Forecast for full deployment</h2>`);
    out.push(`<p>Estimated total labs in deployment: <strong>${num(agg.estimated_total_labs!)}</strong>. Linear projection assumes the scan sample is representative.</p>`);
    out.push(`<table><thead><tr><th>Metric</th><th class="num">Scanned</th><th class="num">Per lab</th><th class="num">Forecast</th></tr></thead><tbody>`);
    for (const r of forecast) {
      out.push(`<tr><td>${esc(r.metric)}</td><td class="num">${num(r.scanned)}</td><td class="num">${esc(r.per_lab_rate)}</td><td class="num">${esc(r.forecast)}</td></tr>`);
    }
    out.push(`</tbody></table>`);
  }

  // ---- Per-class breakdown ----
  out.push(`<h2>Anomalies by class</h2>`);
  out.push(`<table><thead><tr><th>Severity</th><th>Class</th><th class="num">Hits</th><th class="num">Affected labs</th><th class="num">% scanned</th></tr></thead><tbody>`);
  for (const c of agg.per_class) {
    const meta = CLASS_DESCRIPTIONS[c.class];
    out.push(`<tr><td>${badge(c.severity)}</td><td>${esc(meta.title)} <code>${esc(c.class)}</code></td><td class="num">${num(c.count)}</td><td class="num">${num(c.affected_labs)}</td><td class="num">${pct(c.affected_labs, agg.total_labs_scanned)}</td></tr>`);
  }
  out.push(`</tbody></table>`);

  // ---- Detailed findings ----
  out.push(`<h2>Detailed findings</h2>`);
  for (const c of agg.per_class) {
    if (c.count === 0) continue;
    const meta = CLASS_DESCRIPTIONS[c.class];
    out.push(`<h3>${badge(c.severity)} ${esc(meta.title)}</h3>`);
    out.push(`<p class="muted">${esc(meta.rule)}</p>`);
    out.push(`<p><strong>${num(c.count)} hits</strong> across ${num(c.affected_labs)} labs. Up to ${opts.maxSamplesPerClass} samples below.</p>`);
    out.push(`<table><thead><tr><th>Lab</th><th>Where</th><th>Message</th></tr></thead><tbody>`);
    for (const sample of c.samples) {
      const where = sample.anomaly.observation_code !== undefined
        ? `obs <code>${esc(sample.anomaly.observation_code)}</code>`
        : sample.anomaly.panel_code !== undefined
          ? `panel <code>${esc(sample.anomaly.panel_code)}</code>`
          : "";
      out.push(`<tr><td>${esc(sample.lab_number)}</td><td>${where}</td><td>${esc(sample.anomaly.message)}</td></tr>`);
    }
    out.push(`</tbody></table>`);
  }

  // ---- Top affected panels ----
  if (agg.top_panels.length > 0) {
    out.push(`<h2>Top affected panels</h2>`);
    out.push(`<table><thead><tr><th>Panel</th><th class="num">Anomalies</th><th class="num">Affected labs</th></tr></thead><tbody>`);
    for (const p of agg.top_panels) {
      out.push(`<tr><td><code>${esc(p.panel_code)}</code></td><td class="num">${num(p.anomaly_count)}</td><td class="num">${num(p.affected_labs)}</td></tr>`);
    }
    out.push(`</tbody></table>`);
  }

  // ---- Errors ----
  if (agg.errors.length > 0) {
    out.push(`<h2>Unfetchable labs</h2>`);
    out.push(`<p class="muted">Labs the audit couldn't fetch (typically SQL escape bugs in DISA-side lab numbers). Excluded from anomaly counts.</p>`);
    out.push(`<table><thead><tr><th>Error</th><th class="num">Count</th><th>Sample labs</th></tr></thead><tbody>`);
    for (const e of agg.errors) {
      out.push(`<tr><td>${esc(e.message)}</td><td class="num">${num(e.count)}</td><td>${esc(e.sample_labs.join(", "))}</td></tr>`);
    }
    out.push(`</tbody></table>`);
  }

  // ---- Methodology ----
  out.push(`<h2>Methodology</h2>`);
  out.push(`<p>Each lab is examined for the following anomaly classes.</p>`);
  out.push(`<ul class="methodology">`);
  for (const klass of Object.keys(CLASS_DESCRIPTIONS) as Array<keyof typeof CLASS_DESCRIPTIONS>) {
    const meta = CLASS_DESCRIPTIONS[klass];
    out.push(`<li>${badge(meta.severity)} <strong>${esc(meta.title)}</strong> — ${esc(meta.rule)}</li>`);
  }
  out.push(`</ul>`);

  // ---- Limitations ----
  out.push(`<h2>Limitations</h2>`);
  out.push(`<ul>`);
  out.push(`<li>DOB checks skip when source is OpenLDR v1 — v1 doesn't preserve raw DOB strings.</li>`);
  out.push(`<li>Panel/specimen mismatch relies on a curated keyword vocabulary; new deployments may need it widened.</li>`);
  out.push(`<li>Result-format heuristics err toward false negatives over false positives.</li>`);
  out.push(`<li>Forecast assumes the scan sample is representative; older dataset eras may differ.</li>`);
  out.push(`</ul>`);

  out.push(`</body></html>`);
  return out.join("\n");
}

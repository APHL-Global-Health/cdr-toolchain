import { extname } from "node:path";
import type { AuditAggregation, ReportFormat, ReportOpts } from "../report-types.js";
import { renderMarkdown } from "./markdown.js";
import { renderHtml } from "./html.js";
import { renderPdf } from "./pdf.js";
import { renderDocx } from "./docx.js";

export function detectFormat(path: string): ReportFormat | null {
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx") return "docx";
  if (ext === ".md" || ext === ".markdown") return "md";
  if (ext === ".html" || ext === ".htm") return "html";
  return null;
}

export function isValidFormat(s: string): s is ReportFormat {
  return s === "pdf" || s === "docx" || s === "md" || s === "html";
}

/** Renders the aggregation in the requested format. Returns a Buffer
 *  (binary formats) or string (text formats); the caller writes to disk. */
export async function renderReport(
  format: ReportFormat,
  agg: AuditAggregation,
  opts: ReportOpts,
): Promise<Buffer | string> {
  switch (format) {
    case "md":   return renderMarkdown(agg, opts);
    case "html": return renderHtml(agg, opts);
    case "pdf":  return await renderPdf(agg, opts);
    case "docx": return await renderDocx(agg, opts);
  }
}

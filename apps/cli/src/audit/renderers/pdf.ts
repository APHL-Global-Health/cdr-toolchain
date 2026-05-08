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

function num(n: number): string {
  return n.toLocaleString();
}

interface ColumnSpec {
  label: string;
  width: number;
  align?: "left" | "right";
}

/** Render the report into a PDF Buffer. Lazy-imports pdfkit so the
 *  audit subsystem doesn't pull it into the cold-start path of users
 *  who never run the report command. */
export async function renderPdf(agg: AuditAggregation, opts: ReportOpts): Promise<Buffer> {
  const { default: PDFDocument } = await import("pdfkit");
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    info: {
      Title: opts.title,
      Author: "DISA Toolchain audit",
      CreationDate: opts.generatedAt,
    },
  });

  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve) => doc.on("end", resolve));

  // ---------- helpers ----------
  const FONTS = { regular: "Helvetica", bold: "Helvetica-Bold", mono: "Courier" } as const;

  const heading1 = (text: string) => {
    doc.moveDown(0.2);
    doc.font(FONTS.bold).fontSize(20).fillColor("#111").text(text);
    doc.moveDown(0.4);
  };

  const heading2 = (text: string) => {
    doc.moveDown(0.6);
    doc.font(FONTS.bold).fontSize(14).fillColor("#111").text(text);
    doc.font(FONTS.regular).fontSize(0.6).fillColor("#cccccc");
    const y = doc.y + 4;
    doc.moveTo(50, y).lineTo(545, y).strokeColor("#dddddd").stroke();
    doc.y = y + 6;
    doc.fillColor("#111");
  };

  const heading3 = (text: string, sev?: Severity) => {
    doc.moveDown(0.4);
    if (sev !== undefined) {
      drawBadge(sev);
      doc.font(FONTS.bold).fontSize(11).fillColor("#111").text(" " + text, { continued: false });
    } else {
      doc.font(FONTS.bold).fontSize(11).fillColor("#111").text(text);
    }
    doc.moveDown(0.2);
  };

  const para = (text: string, color = "#333") => {
    doc.font(FONTS.regular).fontSize(9.5).fillColor(color).text(text);
    doc.moveDown(0.4);
  };

  const muted = (text: string) => para(text, "#666");

  const drawBadge = (sev: Severity, x?: number, y?: number, label?: string) => {
    const text = label ?? sev.toUpperCase();
    const ax = x ?? doc.x;
    const ay = y ?? doc.y;
    doc.font(FONTS.bold).fontSize(8);
    const w = doc.widthOfString(text) + 12;
    const h = 13;
    doc
      .roundedRect(ax, ay - 1, w, h, 4)
      .fillColor(SEV_BG[sev])
      .strokeColor(SEV_COLOR[sev])
      .fillAndStroke();
    doc.fillColor(SEV_COLOR[sev]).text(text, ax + 6, ay + 1, { width: w - 12, align: "center" });
    // Reset cursor x to right of badge so subsequent text continues inline.
    doc.x = ax + w + 4;
    doc.y = ay;
  };

  /** Simple table renderer: row-by-row, no automatic pagination of cells.
   *  Long cells wrap within their column; row height = max cell height. */
  const table = (cols: ColumnSpec[], rows: string[][]): void => {
    const startX = 50;
    const fontSize = 9;
    const cellPadX = 6;
    const cellPadY = 4;
    doc.font(FONTS.bold).fontSize(fontSize);

    const drawRow = (cells: string[], opts2: { header?: boolean }): void => {
      const heights = cells.map((c, i) => {
        const w = cols[i]!.width - 2 * cellPadX;
        return doc.heightOfString(c, { width: w });
      });
      const rowHeight = Math.max(...heights) + 2 * cellPadY;
      // Page break if the row won't fit.
      if (doc.y + rowHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }
      const y = doc.y;
      let x = startX;
      // Background for header row
      if (opts2.header === true) {
        const totalWidth = cols.reduce((s, c) => s + c.width, 0);
        doc.fillColor("#f5f7fa").rect(startX, y, totalWidth, rowHeight).fill();
      }
      for (let i = 0; i < cells.length; i++) {
        const col = cols[i]!;
        const w = col.width - 2 * cellPadX;
        doc
          .font(opts2.header === true ? FONTS.bold : FONTS.regular)
          .fontSize(fontSize)
          .fillColor("#111")
          .text(cells[i]!, x + cellPadX, y + cellPadY, {
            width: w,
            align: col.align ?? "left",
            lineBreak: true,
          });
        x += col.width;
      }
      // Bottom border
      const totalWidth = cols.reduce((s, c) => s + c.width, 0);
      doc.strokeColor("#e3e6ea").lineWidth(0.5)
        .moveTo(startX, y + rowHeight).lineTo(startX + totalWidth, y + rowHeight).stroke();
      doc.y = y + rowHeight;
      doc.x = startX;
    };

    drawRow(cols.map((c) => c.label), { header: true });
    for (const row of rows) {
      drawRow(row, {});
    }
    doc.moveDown(0.6);
  };

  // ---------- title page ----------
  heading1(opts.title);
  doc.font(FONTS.regular).fontSize(10).fillColor("#666");
  doc.text(`Generated ${opts.generatedAt.toISOString()}`);
  doc.text(`Source: ${agg.source}`);
  doc.text(`Scan window duration (sum of per-lab elapsed): ${formatDurationMs(agg.scan_duration_ms)}`);
  doc.fillColor("#111");

  // ---------- executive summary ----------
  heading2("Executive summary");
  table(
    [
      { label: "Metric", width: 260 },
      { label: "Value", width: 235, align: "right" },
    ],
    [
      ["Labs scanned", num(agg.total_labs_scanned)],
      ["Labs with anomalies", `${num(agg.total_labs_with_anomalies)}  (${pct(agg.total_labs_with_anomalies, agg.total_labs_scanned)})`],
      ["Labs errored (unfetchable)", `${num(agg.total_labs_errored)}  (${pct(agg.total_labs_errored, agg.total_labs_scanned)})`],
      ["Total anomalies", num(agg.total_anomalies)],
      ["Panels scanned", num(agg.total_panels_scanned)],
      ["Observations scanned", num(agg.total_observations_scanned)],
    ],
  );

  doc.font(FONTS.bold).fontSize(10).fillColor("#111").text("By severity");
  doc.moveDown(0.2);
  table(
    [
      { label: "Severity", width: 200 },
      { label: "Count", width: 295, align: "right" },
    ],
    [
      ["Error", num(agg.per_severity.error)],
      ["Warn", num(agg.per_severity.warn)],
      ["Info", num(agg.per_severity.info)],
    ],
  );

  // ---------- forecast ----------
  const forecast = computeForecast(agg);
  if (forecast !== null) {
    heading2("Forecast for full deployment");
    para(`Estimated total labs in deployment: ${num(agg.estimated_total_labs!)}. Linear projection — actual ratios may differ when sampling missed certain dataset eras.`);
    table(
      [
        { label: "Metric", width: 200 },
        { label: "Scanned", width: 95, align: "right" },
        { label: "Per lab", width: 100, align: "right" },
        { label: "Forecast", width: 100, align: "right" },
      ],
      forecast.map((r) => [r.metric, num(r.scanned), r.per_lab_rate, r.forecast]),
    );
  }

  // ---------- per-class breakdown ----------
  heading2("Anomalies by class");
  para("Sorted by severity (highest first), then by hit count.", "#666");
  table(
    [
      { label: "Sev", width: 60 },
      { label: "Class", width: 250 },
      { label: "Hits", width: 65, align: "right" },
      { label: "Labs", width: 65, align: "right" },
      { label: "% scanned", width: 55, align: "right" },
    ],
    agg.per_class.map((c) => [
      c.severity.toUpperCase(),
      `${CLASS_DESCRIPTIONS[c.class].title}\n${c.class}`,
      num(c.count),
      num(c.affected_labs),
      pct(c.affected_labs, agg.total_labs_scanned),
    ]),
  );

  // ---------- detailed findings ----------
  doc.addPage();
  heading2("Detailed findings");
  for (const c of agg.per_class) {
    if (c.count === 0) continue;
    const meta = CLASS_DESCRIPTIONS[c.class];
    heading3(meta.title, c.severity);
    muted(meta.rule);
    para(`${num(c.count)} hits across ${num(c.affected_labs)} labs. Up to ${opts.maxSamplesPerClass} samples below.`);
    table(
      [
        { label: "Lab", width: 95 },
        { label: "Where", width: 110 },
        { label: "Message", width: 290 },
      ],
      c.samples.map((s) => {
        const where = s.anomaly.observation_code !== undefined
          ? `obs ${s.anomaly.observation_code}`
          : s.anomaly.panel_code !== undefined
            ? `panel ${s.anomaly.panel_code}`
            : "";
        return [s.lab_number, where, s.anomaly.message];
      }),
    );
  }

  // ---------- top panels ----------
  if (agg.top_panels.length > 0) {
    heading2("Top affected panels");
    table(
      [
        { label: "Panel", width: 200 },
        { label: "Anomalies", width: 145, align: "right" },
        { label: "Affected labs", width: 150, align: "right" },
      ],
      agg.top_panels.map((p) => [p.panel_code, num(p.anomaly_count), num(p.affected_labs)]),
    );
  }

  // ---------- errors ----------
  if (agg.errors.length > 0) {
    heading2("Unfetchable labs");
    muted("Labs the audit pipeline couldn't fetch (typically SQL escape bugs). Excluded from anomaly counts.");
    table(
      [
        { label: "Error", width: 250 },
        { label: "Count", width: 60, align: "right" },
        { label: "Sample labs", width: 185 },
      ],
      agg.errors.map((e) => [e.message, num(e.count), e.sample_labs.join(", ")]),
    );
  }

  // ---------- methodology ----------
  doc.addPage();
  heading2("Methodology");
  para("Each lab is examined for the following anomaly classes. The detector is a pure function over either a DISA SpecimenRecpt or a projected OpenLDR v1 row set.");
  for (const klass of Object.keys(CLASS_DESCRIPTIONS) as Array<keyof typeof CLASS_DESCRIPTIONS>) {
    const meta = CLASS_DESCRIPTIONS[klass];
    drawBadge(meta.severity);
    doc.font(FONTS.bold).fontSize(9.5).fillColor("#111").text(" " + meta.title);
    doc.font(FONTS.regular).fontSize(9).fillColor("#444").text(meta.rule, { indent: 6 });
    doc.moveDown(0.4);
  }

  heading2("Limitations");
  para("- DOB checks skip when source is OpenLDR v1 — v1 doesn't preserve raw DOB strings.");
  para("- Panel/specimen mismatch relies on a curated keyword vocabulary; new deployments may need it widened.");
  para("- Result-format heuristics err toward false negatives over false positives.");
  para("- Forecast assumes the scan sample is representative; older dataset eras may differ.");

  doc.end();
  await done;
  return Buffer.concat(chunks);
}

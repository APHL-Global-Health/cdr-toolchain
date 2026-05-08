import type { Severity } from "../types.js";
import type { AuditAggregation, ReportOpts } from "../report-types.js";
import { CLASS_DESCRIPTIONS } from "../report-types.js";
import { computeForecast, formatDurationMs, pct } from "./forecast.js";

const SEV_HEX: Record<Severity, string> = {
  info: "5b6b7a",
  warn: "a3700e",
  error: "a72020",
};

function num(n: number): string {
  return n.toLocaleString();
}

/** Lazy-loads the docx package so cold-start of audit isn't penalised. */
export async function renderDocx(agg: AuditAggregation, opts: ReportOpts): Promise<Buffer> {
  const docx = await import("docx");
  const {
    Document, Packer, Paragraph, HeadingLevel, AlignmentType, TextRun,
    Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType,
  } = docx;

  const heading = (text: string, level: typeof HeadingLevel.HEADING_1 | typeof HeadingLevel.HEADING_2 | typeof HeadingLevel.HEADING_3): InstanceType<typeof Paragraph> =>
    new Paragraph({
      heading: level,
      spacing: { before: level === HeadingLevel.HEADING_1 ? 200 : 240, after: 80 },
      children: [new TextRun({ text, bold: true })],
    });

  const para = (text: string, color?: string): InstanceType<typeof Paragraph> =>
    new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text, ...(color !== undefined ? { color } : {}) })],
    });

  const muted = (text: string): InstanceType<typeof Paragraph> => para(text, "555555");

  const sevRun = (sev: Severity): InstanceType<typeof TextRun> =>
    new TextRun({
      text: ` ${sev.toUpperCase()} `,
      bold: true,
      color: "ffffff",
      shading: { type: ShadingType.SOLID, fill: SEV_HEX[sev], color: "auto" },
    });

  const cell = (text: string, opts2: { header?: boolean; align?: typeof AlignmentType.RIGHT | typeof AlignmentType.LEFT } = {}): InstanceType<typeof TableCell> =>
    new TableCell({
      shading: opts2.header === true ? { type: ShadingType.SOLID, fill: "f5f7fa", color: "auto" } : undefined,
      children: [
        new Paragraph({
          alignment: opts2.align,
          children: [new TextRun({ text, bold: opts2.header === true })],
        }),
      ],
    });

  const table = (headers: string[], rows: string[][], rightCols: number[] = []): InstanceType<typeof Table> => {
    const isRight = (i: number): boolean => rightCols.includes(i);
    return new Table({
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top:    { style: BorderStyle.SINGLE, size: 4, color: "e3e6ea" },
        bottom: { style: BorderStyle.SINGLE, size: 4, color: "e3e6ea" },
        left:   { style: BorderStyle.SINGLE, size: 4, color: "e3e6ea" },
        right:  { style: BorderStyle.SINGLE, size: 4, color: "e3e6ea" },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 2, color: "e3e6ea" },
        insideVertical:   { style: BorderStyle.SINGLE, size: 2, color: "e3e6ea" },
      },
      rows: [
        new TableRow({
          children: headers.map((h, i) => cell(h, { header: true, align: isRight(i) ? AlignmentType.RIGHT : AlignmentType.LEFT })),
        }),
        ...rows.map((r) => new TableRow({
          children: r.map((c, i) => cell(c, { align: isRight(i) ? AlignmentType.RIGHT : AlignmentType.LEFT })),
        })),
      ],
    });
  };

  const sections: InstanceType<typeof Paragraph | typeof Table>[] = [];

  // ---- title block ----
  sections.push(
    new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 60 },
      children: [new TextRun({ text: opts.title, bold: true, size: 36 })],
    }),
    para(`Generated: ${opts.generatedAt.toISOString()}`, "666666"),
    para(`Source: ${agg.source}`, "666666"),
    para(`Scan duration (sum of per-lab elapsed): ${formatDurationMs(agg.scan_duration_ms)}`, "666666"),
  );

  // ---- executive summary ----
  sections.push(heading("Executive summary", HeadingLevel.HEADING_1));
  sections.push(table(
    ["Metric", "Value"],
    [
      ["Labs scanned", num(agg.total_labs_scanned)],
      ["Labs with anomalies", `${num(agg.total_labs_with_anomalies)} (${pct(agg.total_labs_with_anomalies, agg.total_labs_scanned)})`],
      ["Labs errored (unfetchable)", `${num(agg.total_labs_errored)} (${pct(agg.total_labs_errored, agg.total_labs_scanned)})`],
      ["Total anomalies", num(agg.total_anomalies)],
      ["Panels scanned", num(agg.total_panels_scanned)],
      ["Observations scanned", num(agg.total_observations_scanned)],
    ],
    [1],
  ));
  sections.push(para(""));
  sections.push(heading("By severity", HeadingLevel.HEADING_2));
  sections.push(table(
    ["Severity", "Count"],
    [
      ["Error", num(agg.per_severity.error)],
      ["Warn", num(agg.per_severity.warn)],
      ["Info", num(agg.per_severity.info)],
    ],
    [1],
  ));

  // ---- forecast ----
  const forecast = computeForecast(agg);
  if (forecast !== null) {
    sections.push(heading("Forecast for full deployment", HeadingLevel.HEADING_1));
    sections.push(para(`Estimated total labs in deployment: ${num(agg.estimated_total_labs!)}. Linear projection — actual ratios may differ when sampling missed certain dataset eras.`));
    sections.push(table(
      ["Metric", "Scanned", "Per lab", "Forecast"],
      forecast.map((r) => [r.metric, num(r.scanned), r.per_lab_rate, r.forecast]),
      [1, 2, 3],
    ));
  }

  // ---- per-class breakdown ----
  sections.push(heading("Anomalies by class", HeadingLevel.HEADING_1));
  sections.push(muted("Sorted by severity (highest first), then by hit count."));
  sections.push(table(
    ["Severity", "Class", "Hits", "Affected labs", "% scanned"],
    agg.per_class.map((c) => [
      c.severity.toUpperCase(),
      `${CLASS_DESCRIPTIONS[c.class].title} (${c.class})`,
      num(c.count),
      num(c.affected_labs),
      pct(c.affected_labs, agg.total_labs_scanned),
    ]),
    [2, 3, 4],
  ));

  // ---- detailed findings ----
  sections.push(heading("Detailed findings", HeadingLevel.HEADING_1));
  for (const c of agg.per_class) {
    if (c.count === 0) continue;
    const meta = CLASS_DESCRIPTIONS[c.class];
    sections.push(new Paragraph({
      heading: HeadingLevel.HEADING_2,
      spacing: { before: 240, after: 60 },
      children: [sevRun(c.severity), new TextRun({ text: ` ${meta.title}`, bold: true })],
    }));
    sections.push(muted(meta.rule));
    sections.push(para(`${num(c.count)} hits across ${num(c.affected_labs)} labs. Up to ${opts.maxSamplesPerClass} samples below.`));
    sections.push(table(
      ["Lab", "Where", "Message"],
      c.samples.map((s) => {
        const where = s.anomaly.observation_code !== undefined
          ? `obs ${s.anomaly.observation_code}`
          : s.anomaly.panel_code !== undefined
            ? `panel ${s.anomaly.panel_code}`
            : "";
        return [s.lab_number, where, s.anomaly.message];
      }),
    ));
  }

  // ---- top panels ----
  if (agg.top_panels.length > 0) {
    sections.push(heading("Top affected panels", HeadingLevel.HEADING_1));
    sections.push(table(
      ["Panel", "Anomalies", "Affected labs"],
      agg.top_panels.map((p) => [p.panel_code, num(p.anomaly_count), num(p.affected_labs)]),
      [1, 2],
    ));
  }

  // ---- errors ----
  if (agg.errors.length > 0) {
    sections.push(heading("Unfetchable labs", HeadingLevel.HEADING_1));
    sections.push(muted("Labs the audit pipeline couldn't fetch (typically SQL escape bugs). Excluded from anomaly counts."));
    sections.push(table(
      ["Error", "Count", "Sample labs"],
      agg.errors.map((e) => [e.message, num(e.count), e.sample_labs.join(", ")]),
      [1],
    ));
  }

  // ---- methodology ----
  sections.push(heading("Methodology", HeadingLevel.HEADING_1));
  sections.push(para("Each lab is examined for the following anomaly classes."));
  for (const klass of Object.keys(CLASS_DESCRIPTIONS) as Array<keyof typeof CLASS_DESCRIPTIONS>) {
    const meta = CLASS_DESCRIPTIONS[klass];
    sections.push(new Paragraph({
      spacing: { before: 80, after: 40 },
      children: [
        sevRun(meta.severity),
        new TextRun({ text: ` ${meta.title}`, bold: true }),
      ],
    }));
    sections.push(muted(meta.rule));
  }

  // ---- limitations ----
  sections.push(heading("Limitations", HeadingLevel.HEADING_1));
  sections.push(para("- DOB checks skip when source is OpenLDR v1 — v1 doesn't preserve raw DOB strings."));
  sections.push(para("- Panel/specimen mismatch relies on a curated keyword vocabulary; new deployments may need it widened."));
  sections.push(para("- Result-format heuristics err toward false negatives over false positives."));
  sections.push(para("- Forecast assumes the scan sample is representative; older dataset eras may differ."));

  const doc = new Document({
    creator: "DISA Toolchain",
    title: opts.title,
    description: "DISA migration data-quality audit",
    sections: [{ children: sections }],
  });

  return await Packer.toBuffer(doc);
}

import type { Command } from "commander";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { CliError } from "../errors.js";
import { AuditAggregator } from "../audit/aggregator.js";
import { detectFormat, isValidFormat, renderReport } from "../audit/renderers/index.js";
import type { ReportFormat } from "../audit/report-types.js";
import { emitMeta } from "../output.js";

interface AuditReportOpts {
  input?: string;
  out?: string;
  format?: string;
  title?: string;
  maxSamplesPerClass?: string;
  totalLabs?: string;
}

/** Read NDJSON from a file or stdin, line by line, into the aggregator. */
async function ingestNdjson(agg: AuditAggregator, inputPath: string | undefined): Promise<void> {
  const stream = inputPath !== undefined ? createReadStream(inputPath, { encoding: "utf8" }) : process.stdin;
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    agg.ingest(line);
  }
}

function pickFormat(opts: AuditReportOpts, outPath: string): ReportFormat {
  if (opts.format !== undefined && opts.format.length > 0) {
    if (!isValidFormat(opts.format)) {
      throw new CliError(
        "USAGE",
        `--format must be one of pdf, docx, md, html (got "${opts.format}").`,
      );
    }
    return opts.format;
  }
  const detected = detectFormat(outPath);
  if (detected !== null) return detected;
  throw new CliError(
    "USAGE",
    `Cannot infer format from --out path "${outPath}"; pass --format pdf|docx|md|html explicitly.`,
  );
}

export function registerAuditReportCommand(program: Command): void {
  program
    .command("audit-report")
    .description(
      "Render an audit-batch NDJSON stream into a stakeholder-ready report (PDF, DOCX, Markdown, or HTML). Reads NDJSON from --input <path> or stdin; format inferred from --out extension or set explicitly with --format.",
    )
    .option("--input <path>", "Audit-batch NDJSON file. Reads stdin when omitted.")
    .option("--out <path>", "Output file path. Format is inferred from extension when --format isn't given.")
    .option("--format <fmt>", "Output format: pdf, docx, md, html. Overrides extension detection.")
    .option("--title <str>", "Report title (default: \"DISA Migration Audit Report\").")
    .option("--max-samples-per-class <n>", "Max sample anomalies kept per class in the detailed-findings section (default: 10).")
    .option("--total-labs <n>", "Total labs in the deployment for the forecast section. Omit to skip the forecast.")
    .action(async (opts: AuditReportOpts) => {
      if (opts.out === undefined || opts.out.length === 0) {
        throw new CliError("USAGE", "--out <path> is required (e.g. --out /tmp/audit.pdf).");
      }
      const outPath = resolve(opts.out);
      const format = pickFormat(opts, outPath);
      const maxSamples = opts.maxSamplesPerClass !== undefined ? Number(opts.maxSamplesPerClass) : 10;
      if (!Number.isFinite(maxSamples) || maxSamples < 1) {
        throw new CliError("USAGE", `--max-samples-per-class must be a positive integer.`);
      }
      const estimatedTotal = opts.totalLabs !== undefined ? Number(opts.totalLabs) : undefined;
      if (estimatedTotal !== undefined && (!Number.isFinite(estimatedTotal) || estimatedTotal <= 0)) {
        throw new CliError("USAGE", `--total-labs must be a positive integer.`);
      }

      const aggregator = new AuditAggregator({ maxSamplesPerClass: maxSamples });
      const start = Date.now();
      await ingestNdjson(aggregator, opts.input);
      const aggregation = aggregator.finalize(estimatedTotal);

      const rendered = await renderReport(format, aggregation, {
        title: opts.title ?? "DISA Migration Audit Report",
        generatedAt: new Date(),
        maxSamplesPerClass: maxSamples,
      });

      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, rendered);

      const meta: Record<string, unknown> = {
        _meta: "audit-report",
        out: outPath,
        format,
        bytes: typeof rendered === "string" ? Buffer.byteLength(rendered) : rendered.length,
        labs_scanned: aggregation.total_labs_scanned,
        labs_with_anomalies: aggregation.total_labs_with_anomalies,
        total_anomalies: aggregation.total_anomalies,
        elapsed_ms: Date.now() - start,
      };
      if (!aggregator.hasAuthoritativeTotals()) {
        // No summary line in the stream — totals reflect only the lines
        // we saw. If the producer used --only-anomalies, "labs scanned"
        // and "% scanned" in the report will be wrong. Warn loudly.
        meta["warning"] = "Input had no audit-batch-summary line; totals may undercount if --only-anomalies was used. Re-run audit-batch without --only-anomalies (or use audit-batch --report-out for a one-shot report).";
      }
      emitMeta(meta);
    });
}

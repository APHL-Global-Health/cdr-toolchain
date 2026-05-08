#!/usr/bin/env node
import { Command, Option } from "commander";
import { VERSION as DISALAB_VERSION } from "disalab";
import { formatError } from "./errors.js";
import { maybeEmitJsonHelp } from "./help.js";
import { registerTablesCommand } from "./commands/tables.js";
import { registerSchemaCommand } from "./commands/schema.js";
import { registerErrorsCommand } from "./commands/errors.js";
import { registerListCommand } from "./commands/list.js";
import { registerGetCommand } from "./commands/get.js";
import { registerCountCommand } from "./commands/count.js";
import { registerStreamCommand } from "./commands/stream.js";
import { registerSpecimenCommand } from "./commands/specimen.js";
import { registerConfigCommand } from "./commands/config.js";
import { registerPingCommand } from "./commands/ping.js";
import { registerCompareCommand } from "./commands/compare.js";
import { registerCompareBatchCommand } from "./commands/compare-batch.js";
import { registerCompareResultsCommand } from "./commands/compare-results.js";
import { registerProbeBytesCommand } from "./commands/probe-bytes.js";
import { registerExportCommand } from "./commands/export.js";
import { registerExportBatchCommand } from "./commands/export-batch.js";
import { registerAuditCommand, registerAuditBatchCommand } from "./commands/audit.js";
import { registerAuditReportCommand } from "./commands/audit-report.js";

const program = new Command();

program
  .name("cdr")
  .description(
    "CLI for the DISA database (disalab). JSON on stdout, structured errors on stderr, deterministic exit codes. AI-friendly by default.",
  )
  .version(`cli 0.1.0 / disalab ${DISALAB_VERSION}`, "-v, --version", "display versions")
  .option("--cs, --connection-string <url>", "DISA MSSQL connection string (overrides env + .env)")
  .option("--openldr-cs <url>", "OpenLDR v1 MSSQL connection string (used by `compare`)")
  .option("--env-file <path>", "path to a .env file to load (default: ./.env)")
  .addOption(
    new Option("--output <fmt>", "output format").choices(["ndjson", "json", "pretty"]),
  )
  .option("--no-color", "disable ANSI colors")
  .option("--quiet", "suppress informational output on stderr")
  .addOption(
    new Option("--log-level <lvl>", "log verbosity")
      .choices(["error", "warn", "info", "debug"])
      .default("info"),
  )
  .showHelpAfterError(true);

registerTablesCommand(program);
registerSchemaCommand(program);
registerErrorsCommand(program);
registerListCommand(program);
registerGetCommand(program);
registerCountCommand(program);
registerStreamCommand(program);
registerSpecimenCommand(program);
registerConfigCommand(program);
registerPingCommand(program);
registerCompareCommand(program);
registerCompareBatchCommand(program);
registerCompareResultsCommand(program);
registerProbeBytesCommand(program);
registerExportCommand(program);
registerExportBatchCommand(program);
registerAuditCommand(program);
registerAuditBatchCommand(program);
registerAuditReportCommand(program);

async function main(): Promise<void> {
  if (maybeEmitJsonHelp(program, process.argv)) return;

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    const { json, exitCode } = formatError(err);
    process.stderr.write(json + "\n");
    process.exit(exitCode);
  }
}

void main();

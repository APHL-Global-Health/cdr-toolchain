import type { Command } from "commander";
import { REGDAT4, SpecimenRecpt } from "disalab";
import { CliError } from "../errors.js";
import { emitRow } from "../output.js";
import { withServer } from "../db.js";
import { loadRuntime } from "./context.js";

export function registerSpecimenCommand(program: Command): void {
  program
    .command("specimen <labNumber>")
    .description("Fetch the composite SpecimenRecpt view for one lab number")
    .action(async (labNumber: string, _opts, cmd: Command) => {
      const { config, output } = loadRuntime(cmd);

      await withServer(config, async (server) => {
        const escaped = labNumber.replace(/'/g, "''");
        const regs = await REGDAT4.All(`WHERE [LabNo] = '${escaped}'`, server);
        if (regs.length === 0) {
          throw new CliError(
            "GET_NO_ROWS",
            `No registration found for lab number ${labNumber}`,
          );
        }
        if (regs.length > 1) {
          throw new CliError(
            "GET_MULTIPLE_ROWS",
            `Expected 1 registration, matched ${regs.length}`,
            { count: regs.length },
          );
        }
        const recpt = await SpecimenRecpt.Fetch(regs[0]!, server);
        if (recpt === null) {
          throw new CliError(
            "DB_QUERY_FAILED",
            "SpecimenRecpt.Fetch returned null",
            { labNumber },
          );
        }
        emitRow(recpt as unknown as Record<string, unknown>, output);
      });
    });
}

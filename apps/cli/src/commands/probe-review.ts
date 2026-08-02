import type { Command } from "commander";
import mssql from "mssql";
import { getPool, TestDataHeader } from "disalab";
import { CliError } from "../errors.js";
import { closePool } from "../db.js";
import { loadRuntime } from "./context.js";
import { scoreFR, scoreTimestamp, type LabelledPanel, type TimestampRow } from "../compare/review-score.js";
import {
  decodeLongDatetime,
  decodeShortDatetime,
} from "../compare/disa-datetime-candidates.js";

interface Row {
  header: TestDataHeader;
  v1Status: string;
  authorisedAt: Date | null;
}

/**
 * Labelled join. DISA is the blob source; v1 Requests is ground truth.
 * READ-ONLY. The join is the one measured sound at 13,253/13,254:
 *   RequestID = <prefix> + LABNO  AND  LIMSPanelCode = TESTCODE
 */
async function fetchLabelled(
  connectionString: string,
  v1Database: string,
  prefix: string,
  limit: number,
): Promise<Row[]> {
  const pool = await getPool(connectionString);
  // Parameterised: @limit and @prefix are bound, never interpolated. `--limit`
  // is CLI-supplied and `prefix` comes from .env, so neither belongs in the
  // SQL text. The database NAME cannot be a bind parameter (it is an
  // identifier, not a value), so it is whitelisted instead.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v1Database)) {
    throw new CliError("CONFIG_INVALID", `Refusing to query unsafe database identifier: ${v1Database}`);
  }
  const sql = `
    SELECT TOP (@limit)
           t.[TESTDATA_STATUS] AS blob,
           r.[HL7ResultStatusCode] AS status,
           r.[AuthorisedDateTime]  AS authorised
    FROM [DisalabData].[dbo].[TESTDATA] t
    JOIN [${v1Database}].[dbo].[Requests] r
      ON r.[RequestID] = @prefix + t.[LABNO]
     AND r.[LIMSPanelCode] = t.[TESTCODE]`;
  const rs = (
    await pool
      .request()
      .input("limit", mssql.Int, limit)
      .input("prefix", mssql.VarChar, prefix)
      .query(sql)
  ).recordset as Record<string, unknown>[];
  return rs.map((row) => ({
    header: TestDataHeader.fromBytes(row.blob as Buffer),
    v1Status: String(row.status ?? ""),
    authorisedAt: row.authorised instanceof Date ? row.authorised : null,
  }));
}

export function registerProbeReview(program: Command): void {
  program
    .command("probe-review")
    .description("Score the TESTDATA header review signal against OpenLDR v1 (read-only)")
    .option("--limit <n>", "max labelled panels to score", "200000")
    .option("--tolerance-sec <n>", "timestamp match tolerance in seconds", "60")
    .option("--min-year <n>", "candidate year floor", "2000")
    .option("--max-year <n>", "candidate year ceiling", "2030")
    .option("--initials-start <n>", "reviewer-initials slot start (hypothesis under test)", "77")
    .option("--initials-end <n>", "reviewer-initials slot end, EXCLUSIVE", "80")
    .action(async (opts: Record<string, string>, cmd: Command) => {
      const { config } = loadRuntime(cmd);
      const limit = Number(opts.limit);
      const tolerance = Number(opts.toleranceSec);
      const minY = Number(opts.minYear);
      const maxY = Number(opts.maxYear);
      if (!Number.isFinite(limit) || limit <= 0) throw new CliError("USAGE", "--limit must be a positive number");

      try {
        const rows = await fetchLabelled(
          config.connectionString,
          config.openldrDataDatabase,
          config.openldrLabnoPrefix,
          limit,
        );
        console.log(`labelled panels fetched: ${rows.length}`);

        // ---- (a) F/R rule -------------------------------------------------
        // ⛔ The probe reads config/<country>.yaml NOT AT ALL — it exists to
        // MEASURE the offset that later populates that file. Reading config
        // here would be circular. The slot under test comes from the flag,
        // defaulting to the 2026-07-16 hypothesis of 77-80.
        const slot = { start: Number(opts.initialsStart), end: Number(opts.initialsEnd) };
        const frRows: LabelledPanel[] = rows.map((r) => ({
          initialsPresent: r.header.initialsAt(slot) !== null,
          v1Status: r.v1Status,
        }));
        const m = scoreFR(frRows);
        console.log("\n=== F/R rule: initials non-zero => F, else R ===");
        console.log(`  F & reviewed  (correct) = ${m.fCorrect}`);
        console.log(`  R & !reviewed (correct) = ${m.rCorrect}`);
        console.log(`  F & !reviewed (miss)    = ${m.fMiss}`);
        console.log(`  R & reviewed  (miss)    = ${m.rMiss}`);
        console.log(`  ACCURACY = ${(m.accuracy * 100).toFixed(2)}%  (n = ${m.total})`);

        // ---- (b) timestamp search ----------------------------------------
        // Only rows that are reviewed AND carry a v1 timestamp are scorable.
        const tsRows = rows.filter((r) => r.header.initialsAt(slot) !== null && r.authorisedAt !== null);
        console.log(`\n=== timestamp search (n = ${tsRows.length}, tolerance ${tolerance}s) ===`);

        const kinds = [
          { name: "long-datetime",  fn: decodeLongDatetime  },
          { name: "short-datetime", fn: decodeShortDatetime },
        ];
        let best = { name: "", offset: -1, rate: 0, hits: 0, total: 0 };
        for (const kind of kinds) {
          for (let offset = 0; offset <= 74; offset++) {
            const scored: TimestampRow[] = tsRows.map((r) => ({
              decoded: kind.fn(r.header.raw, offset, minY, maxY),
              target: r.authorisedAt as Date,
            }));
            const s = scoreTimestamp(scored, tolerance);
            if (s.rate > best.rate) best = { name: kind.name, offset, rate: s.rate, hits: s.hits, total: s.total };
          }
        }
        // best.offset stays -1 only when every candidate/offset scored a flat
        // 0 (the `s.rate > best.rate` comparison never fires against the
        // initial 0). That is not "a genuine 0% result" — it usually means
        // the scorer itself is broken (e.g. comparing incompatible time
        // frames) rather than the data lacking any correct decode. Report it
        // as inconclusive instead of printing a confident, misleading FAIL.
        const noCandidateScored = best.offset === -1;
        if (noCandidateScored) {
          console.log(
            `  BEST: no candidate scored above zero (n=${tsRows.length}) — INCONCLUSIVE: this points at a scorer/harness fault, not a data finding.`,
          );
        } else {
          console.log(`  BEST: kind=${best.name} offset=${best.offset} hits=${best.hits}/${best.total} rate=${(best.rate * 100).toFixed(2)}%`);
        }

        // ---- GATE ---------------------------------------------------------
        console.log("\n=== GATE (spec: >=95% minute-exact) ===");
        if (noCandidateScored) {
          console.log(
            "  INCONCLUSIVE — no candidate scored above zero; probable scorer/harness fault. Fix the scorer/harness and re-run before drawing any conclusion; do NOT report this as FAIL.",
          );
        } else if (best.rate >= 0.95) {
          console.log(`  PASS (${(best.rate * 100).toFixed(2)}%) — proceed to Phase 2.`);
        } else if (best.rate >= 0.90) {
          console.log(`  BORDERLINE (${(best.rate * 100).toFixed(2)}%) — surface to the user; do NOT proceed unilaterally.`);
        } else {
          console.log(`  FAIL (${(best.rate * 100).toFixed(2)}%) — STOP. Ship result_status alone and report the ceiling.`);
        }
      } finally {
        await closePool();
      }
    });
}

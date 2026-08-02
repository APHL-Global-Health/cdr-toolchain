import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { HEADER_LENGTH, type TestDataHeader } from "disalab";
import { CliError } from "../errors.js";
import { configDir } from "./country-config.js";

export const DEFAULT_SELF_CHECK_SAMPLE = 500;

const slotSchema = z
  .object({ start: z.number().int().min(0).max(HEADER_LENGTH - 1), end: z.number().int().min(1).max(HEADER_LENGTH) })
  .refine((s) => s.start < s.end, { message: "start must be less than end (end is EXCLUSIVE)" });

const reviewedAtSchema = z.object({
  start: z.number().int().min(0).max(HEADER_LENGTH - 1),
  kind: z.enum(["long-datetime", "short-datetime"]),
});

const schema = z.object({
  disa_blob_offsets: z
    .object({ reviewer_initials: slotSchema.optional(), reviewed_at: reviewedAtSchema.optional() })
    .optional(),
});

export interface BlobOffsets {
  /** Null ⇒ this deployment is UNMEASURED; do not attempt an F/R decode. */
  reviewerInitials: { start: number; end: number } | null;
  reviewedAt: { start: number; kind: "long-datetime" | "short-datetime" } | null;
}

/**
 * ⛔ NO Tanzania fallback. An unconfigured deployment decodes NOTHING.
 *
 * Decided 2026-08-02: inheriting Tanzania's 77-80 would let an unconfigured
 * Zambia silently decode with the wrong offsets. `null` offsets mean no decode,
 * so result_status/authorised_at stay null — exactly today's behaviour, which
 * is fail-safe rather than a plausible wrong answer. This is the plan's
 * "Never hardcode country-specific values" constraint applied literally.
 *
 * disalab's DEFAULT_HEADER_OFFSETS still exists, but as an EXPLICIT opt-in for
 * tests and direct callers — it is deliberately not used as a config default.
 */
const UNCONFIGURED: BlobOffsets = { reviewerInitials: null, reviewedAt: null };

export function loadBlobOffsets(country: string | undefined, dir: string = configDir()): BlobOffsets {
  if (country === undefined || country.trim().length === 0) return UNCONFIGURED;
  const path = resolve(dir, `${country.trim().toLowerCase()}.yaml`);
  if (!existsSync(path)) return UNCONFIGURED;

  const parsed = schema.safeParse(parse(readFileSync(path, "utf8")) ?? {});
  if (!parsed.success) {
    throw new CliError(
      "CONFIG_INVALID",
      `Invalid disa_blob_offsets in ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const block = parsed.data.disa_blob_offsets;
  if (block === undefined) return UNCONFIGURED;
  return {
    reviewerInitials: block.reviewer_initials ?? null,
    reviewedAt: block.reviewed_at ?? null,
  };
}

/**
 * Wrong offsets do not throw — they return plausible garbage. This is the
 * guard that makes a hand-edited YAML fail loudly instead of silently
 * emitting wrong statuses for an entire migration.
 */
export function assertOffsetsPlausible(headers: readonly TestDataHeader[], offsets: BlobOffsets): void {
  // Unconfigured deployment: nothing is decoded, so there is nothing to check.
  if (offsets.reviewerInitials === null) return;
  const slot = offsets.reviewerInitials;
  const sample = headers.slice(0, DEFAULT_SELF_CHECK_SAMPLE);
  let nonZero = 0;
  let printable = 0;
  // A few offending (non-printable, non-empty) slots, formatted as hex + decimal
  // bytes, so a failure can be diagnosed from the error message alone — no need
  // to re-run with a debugger attached to see what the offset actually decoded.
  const badSamples: string[] = [];
  const MAX_BAD_SAMPLES = 5;
  for (const h of sample) {
    let any = false;
    let ok = true;
    const bytes: number[] = [];
    for (let i = slot.start; i < slot.end; i++) {
      const b = h.byteAt(i);
      bytes.push(b);
      if (b === 0 || b === 32) continue;
      any = true;
      // Printable ASCII letters/digits are what real initials look like ("APB").
      if (!((b >= 48 && b <= 57) || (b >= 65 && b <= 90) || (b >= 97 && b <= 122))) ok = false;
    }
    if (any) {
      nonZero++;
      if (ok) {
        printable++;
      } else if (badSamples.length < MAX_BAD_SAMPLES) {
        const hex = bytes.map((b) => `0x${b.toString(16).padStart(2, "0")}`).join(" ");
        const dec = bytes.join(",");
        badSamples.push(`[${hex}] (dec ${dec})`);
      }
    }
  }
  // An all-not-reviewed sample is legitimate and proves nothing either way.
  if (nonZero === 0) return;
  const rate = printable / nonZero;
  if (rate < 0.9) {
    throw new CliError(
      "CONFIG_INVALID",
      `disa_blob_offsets.reviewer_initials looks wrong: only ${printable}/${nonZero} sampled non-empty slots ` +
        `(${(rate * 100).toFixed(1)}%) decode to printable ASCII. Expected letters/digits such as "APB". ` +
        `Sample of offending byte(s) at offset [${slot.start}, ${slot.end}): ${badSamples.join("; ")}. ` +
        `Re-run \`cdr probe-review\` and set the measured offset for this deployment.`,
    );
  }
}

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CliError } from "../errors.js";
import { configDir } from "./country-config.js";

export interface ParmdictOffsets {
  /** Byte offset of the high reporting limit (float32 little-endian) in PARMDICT_STATUS. */
  highLimit: number;
  /** Byte offset of the low reporting limit (float32 little-endian) in PARMDICT_STATUS. */
  lowLimit: number;
}

const schema = z.object({
  disa_parmdict_offsets: z
    .object({
      high_limit: z.number().int().min(0),
      low_limit: z.number().int().min(0),
    })
    .optional(),
});

/**
 * No Tanzania fallback. An unknown country, or a yaml without the block,
 * returns null and the codebook carries null limits. A block that is present
 * but has a bad value is refused.
 */
export function loadParmdictOffsets(country: string | undefined, dir: string = configDir()): ParmdictOffsets | null {
  if (country === undefined || country.trim().length === 0) return null;
  const path = resolve(dir, `${country.trim().toLowerCase()}.yaml`);
  if (!existsSync(path)) return null;

  const parsed = schema.safeParse(parse(readFileSync(path, "utf8")) ?? {});
  if (!parsed.success) {
    throw new CliError(
      "CONFIG_INVALID",
      `Invalid disa_parmdict_offsets in ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
    );
  }
  const block = parsed.data.disa_parmdict_offsets;
  if (block === undefined) return null;
  return { highLimit: block.high_limit, lowLimit: block.low_limit };
}

import { inspect } from "node:util";

export type OutputFormat = "ndjson" | "json" | "pretty";

export function isValidFormat(value: string): value is OutputFormat {
  return value === "ndjson" || value === "json" || value === "pretty";
}

export interface OutputOptions {
  format: OutputFormat;
  color: boolean;
  fields?: string[];
}

export function project<T extends Record<string, unknown>>(
  obj: T,
  fields: string[] | undefined,
): Record<string, unknown> {
  if (fields === undefined || fields.length === 0) return obj;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in obj) out[f] = obj[f];
  }
  return out;
}

function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Date) return v.toISOString();
    if (typeof v === "bigint") return v.toString();
    return v;
  });
}

export function emitRow(
  value: Record<string, unknown>,
  opts: OutputOptions,
  arrayAccumulator?: Record<string, unknown>[],
): void {
  const projected = project(value, opts.fields);
  if (opts.format === "ndjson") {
    process.stdout.write(serialize(projected) + "\n");
    return;
  }
  if (opts.format === "json") {
    arrayAccumulator?.push(projected);
    return;
  }
  process.stdout.write(
    inspect(projected, { colors: opts.color, depth: 6, breakLength: 100 }) + "\n",
  );
}

export function emitArray(
  values: Record<string, unknown>[],
  opts: OutputOptions,
): void {
  if (opts.format === "json") {
    const projected = values.map((v) => project(v, opts.fields));
    process.stdout.write(JSON.stringify(projected) + "\n");
    return;
  }
  for (const v of values) emitRow(v, opts);
}

export function emitMeta(obj: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify(obj) + "\n");
}

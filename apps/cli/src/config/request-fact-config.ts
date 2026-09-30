import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { CliError } from "../errors.js";
import { configDir } from "./country-config.js";

// Measured per deployment (config/<country>.yaml) and shared across deployments
// (config/request-attributes.yaml). An unconfigured deployment decodes NOTHING new,
// the same fail-safe rule as blob-offsets.ts: no Tanzania fallback.

export interface RegistrationOffsets {
  requestType: { offset: number; values: ReadonlyMap<number, string> } | null;
  ageYears: { offset: number } | null;
  /** Two bytes, little-endian, starting at `offset`. */
  ageDays: { offset: number } | null;
  newborn: { offset: number; mask: number } | null;
}

/** Attribute codes in urn:openldr:cs:request-attribute, keyed by the DISA source the code knows. */
export interface AttributeCodes {
  therapy: string | null;
  folderNumber: string | null;
  newborn: string | null;
}

export interface RequestFactConfig {
  registration: RegistrationOffsets;
  /** TESTDICT.SECTION letter to v1 HL7SectionCode. The key "" is a blank section. */
  sectionCodes: ReadonlyMap<string, string>;
  attributeCodes: AttributeCodes;
}

const NO_REGISTRATION: RegistrationOffsets = { requestType: null, ageYears: null, ageDays: null, newborn: null };
const NO_ATTRIBUTES: AttributeCodes = { therapy: null, folderNumber: null, newborn: null };
export const EMPTY_REQUEST_FACT_CONFIG: RequestFactConfig = {
  registration: NO_REGISTRATION, sectionCodes: new Map(), attributeCodes: NO_ATTRIBUTES,
};

const byte = z.number().int().min(0);
const countrySchema = z.object({
  disa_registration_offsets: z.object({
    request_type: z.object({
      offset: byte,
      values: z.record(z.string(), z.string().min(1))
        .refine((v) => Object.keys(v).every((k) => /^\d+$/.test(k)), { message: "values keys must be byte values" }),
    }).optional(),
    age_years: z.object({ offset: byte }).optional(),
    age_days: z.object({ offset: byte }).optional(),
    newborn: z.object({ offset: byte, mask: z.number().int().min(1).max(255) }).optional(),
  }).optional(),
  hl7_section_codes: z.record(z.string(), z.string().min(1)).optional(),
});
const attributeCode = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);
const attributesSchema = z.object({
  request_attributes: z.object({
    therapy: attributeCode.optional(),
    folder_number: attributeCode.optional(),
    newborn: attributeCode.optional(),
  }).optional(),
});

function readYaml(path: string): unknown {
  return existsSync(path) ? parse(readFileSync(path, "utf8")) ?? {} : {};
}

function invalid(path: string, err: z.ZodError): CliError {
  return new CliError("CONFIG_INVALID", `Invalid ${path}: ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
}

export function loadRequestFactConfig(country: string | undefined, dir: string = configDir()): RequestFactConfig {
  const attrPath = resolve(dir, "request-attributes.yaml");
  const attrs = attributesSchema.safeParse(readYaml(attrPath));
  if (!attrs.success) throw invalid(attrPath, attrs.error);
  const a = attrs.data.request_attributes ?? {};
  const attributeCodes: AttributeCodes = {
    therapy: a.therapy ?? null, folderNumber: a.folder_number ?? null, newborn: a.newborn ?? null,
  };

  if (country === undefined || country.trim().length === 0) return { ...EMPTY_REQUEST_FACT_CONFIG, attributeCodes };
  const path = resolve(dir, `${country.trim().toLowerCase()}.yaml`);
  const parsed = countrySchema.safeParse(readYaml(path));
  if (!parsed.success) throw invalid(path, parsed.error);
  const reg = parsed.data.disa_registration_offsets ?? {};
  return {
    registration: {
      requestType: reg.request_type === undefined ? null : {
        offset: reg.request_type.offset,
        values: new Map(Object.entries(reg.request_type.values).map(([k, v]) => [Number(k), v])),
      },
      ageYears: reg.age_years ?? null,
      ageDays: reg.age_days ?? null,
      newborn: reg.newborn ?? null,
    },
    sectionCodes: new Map(Object.entries(parsed.data.hl7_section_codes ?? {})),
    attributeCodes,
  };
}

# v1 Request Facts on the Wire (cdr-toolchain side) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send every v1 request fact DISA holds to OpenLDR CE in the FHIR slots CE already reads, and fix the four facts the V2 payload sends wrongly today.

**Architecture:** disalab keeps the raw REGDAT4 bytes and the registering user. The CLI decodes the new header and registration bytes with offsets from `config/<country>.yaml`; an unmeasured deployment decodes nothing. `toV2` fills the V2 fields that already exist (analysis time, age, section, tested by, authorised by) and puts the new facts in `source_payload.request_facts`, which v2 ignores. `toFhir` writes them as the ServiceRequest and DiagnosticReport slots in the CE spec, section 6.

**Tech Stack:** TypeScript, node:test + tsx, zod, yaml, pnpm/turbo. The official HL7 validator runs behind `FHIR_CONFORMANCE=1`.

**Spec:** `openldr_ce/docs/superpowers/specs/2026-09-29-v1-request-facts-design.md` (binding, sections 5 and 6), with the measured sources in `openldr_ce/docs/superpowers/specs/2026-09-29-v1-request-facts-disa-sources.md`. The CE side is merged and pushed (`39debf02`): CE reads every slot below.

## Global Constraints

- Wire slots, exactly as CE reads them (spec 6):
  - section: `DiagnosticReport.category[].coding[]`, system `http://terminology.hl7.org/CodeSystem/v2-0074`, code = v1's HL7 section code.
  - authorised by: `DiagnosticReport.resultsInterpreter[0].display`.
  - point of care: `ServiceRequest.locationCode[0].text`.
  - clinical info: `ServiceRequest.note[0].text` (already sent). Requesting doctor: contained `PractitionerRole.practitioner.display` (already sent). OBR set: identifier `urn:openldr:obr-set-id` (already sent).
  - ServiceRequest extensions: `urn:openldr:ext:analysis-time` (`valueDateTime`), `urn:openldr:ext:registered-by` (`valueString`), `urn:openldr:ext:tested-by` (`valueString`), `urn:openldr:ext:request-type` (`valueCode`), `urn:openldr:ext:age-at-request` (sub-extensions `years`, `days`, each `valueInteger`), `urn:openldr:ext:analyzer` (`valueCode`), `urn:openldr:ext:rejection` (sub-extensions `code` `valueCode`, `reason` `valueString`), `urn:openldr:ext:request-attribute` (repeating; sub-extensions `code` `valueCoding` with system `urn:openldr:cs:request-attribute`, and `value` as one of `valueString`, `valueDecimal`, `valueDateTime`, `valueBoolean`).
- An absent fact is omitted, never sent empty, never filled with a constant (spec D6). A sub-extension that has no value is omitted. An extension with no sub-extensions is omitted.
- No country switch (spec D5). The code sends every fact it can decode, for every country. What differs per deployment is only MEASURED configuration in `config/<country>.yaml`. An unconfigured deployment decodes nothing new, the same fail-safe rule `blob-offsets.ts` already follows.
- Codes live in YAML, never in source (CLAUDE.md: "Never hardcode codes"). That covers the section letter map, the request type byte values, and the attribute codes.
- Byte reads use `Core.ConvertToBytes` (latin1, lossless), never `Core.FixBytes`, which turns byte 0 into a space. Request type byte 333 is 0 for `D`.
- Tanzania measured values (Task 1 findings): TESTDATA header analysis time at 15 (long-datetime, same layout as `reviewed_at` at 21), analyser 56-61, tester initials 74-77, reviewer initials 77-80; REGDAT4 request type byte 333 (0 = D, 8 = E), age years byte 414, age days bytes 417-418 little-endian, newborn bit value 2 in byte 409.
- Analysis time comes from the FIRST iteration of an OBR (68/68 and 177/177 against v1; the last iteration scored 67 and 169). Tester, reviewer and analyser come from the same iteration `buildStatusByObr` already picks (the latest), so `authorised_by` and `authorised_at` never come from different runs.
- Work in `D:/Projects/Repositories/cdr-toolchain/.claude/worktrees/v1-request-facts-wire`, branch `spec/v1-request-facts-wire`. Prefix every command with `cd` to it and check `git branch --show-current` before committing. Stage by exact path.
- apps/cli imports disalab from `packages/disalab/dist`. After any disalab change, run `pnpm --filter disalab build` before running apps/cli tests.
- Tests: `pnpm --filter <pkg> exec node --import tsx --test <file>`. The cli package is `@cdr-toolchain/cli`; disalab is `disalab`. `$SCRATCH` is any scratch folder outside the repo (Windows Python cannot see `/tmp`). Typecheck: `pnpm --filter <pkg> typecheck > <file> 2>&1; echo "exit=$?"`. Never read an exit code through a pipe.
- No em dashes and no emoji in any new writing: code comments, YAML comments, commit messages, reports. Never a `Co-Authored-By` trailer.

## Rulings made while planning

Each can be reversed. The cost of being wrong is stated.

1. **Offsets stay per country.** New byte offsets go in `config/<country>.yaml` beside `disa_blob_offsets`, because Tanzania is the only measured DISA (`testdata-header.ts:17-20` warns versions vary). Cost if wrong: Mozambique ships these facts empty until someone measures and adds its offsets.
2. **Age falls back to date of birth when offsets are unconfigured.** That is today's behaviour, a derivation, not a constant. With offsets configured, the REGDAT4 bytes win (they match v1 on every TDS row; the date of birth path misses 82 of 136). Cost if wrong: an unmeasured deployment keeps today's partly wrong ages.
3. **`tested_by` becomes null when offsets are unconfigured.** Today it sends `ReceivedInLabBy`, which is the wrong fact (4 of 136 match). Cost if wrong: an unmeasured deployment loses a value that was wrong anyway.
4. **Point of care is the ward.** `locationCode[0].text` carries the WARDDICT-resolved ward, else the raw ward code. v1's `LIMSPointOfCareDesc` is a composite (`facility~ward` in Tanzania, `district~facility~ward` in Mozambique). A country view composes it from `requester_display` and `point_of_care`. Cost if wrong: CE's column holds the ward, not v1's composite string.
5. **Blank section maps through config.** v1 writes `OTH` for a blank TESTDICT section (91,679 TDS rows). `config/tanzania.yaml` maps `""` to `OTH` so Tanzania matches v1; a deployment without that key sends no section for blank. An unmapped letter sends nothing. Cost if wrong: remove one YAML line.
6. **Newborn is sent only when the bit is set.** A clear bit sends nothing. A view reads a missing row as not newborn. Cost if wrong: CE cannot tell "not newborn" from "not measured"; the measured state is known per deployment from its YAML.
7. **New facts ride in `source_payload.request_facts`, not as new V2 fields.** The V2 payload also goes to openldr-v2 (`export-batch.ts:970`), and `source_payload` is its free-form bag. Existing V2 fields (analysis_at, age, section_code, tested_by, authorised_by) get correct values in place. Cost if wrong: v2 also receives the corrected existing fields, which is the point.
8. **Registered by reads `REGDAT4.ReceivedBy` (bytes 135-138),** which disalab already decodes with fixed offsets like every other REGDAT4 field. It is not moved to YAML. Cost if wrong: a deployment with another layout gets wrong initials, the same exposure every existing REGDAT4 field has.
9. **Out of scope, listed in the findings, not fixed here:** `cdr export --type v1` crashing on 31 of 75 labs, its constant request type D, its age-based newborn rule, its WL101 analysis time, and `core.ts:199-201` reading byte 418 as hours. Also out: compare-gate grading of the new facts (spec 10).

---

### Task 1: disalab keeps the raw registration bytes and the registering user

**Files:**
- Modify: `packages/disalab/src/lib/DisalabData/REGDAT4.ts`
- Modify: `packages/disalab/src/lib/Forms/specimenrecpt.ts`
- Create: `packages/disalab/src/lib/DisalabData/REGDAT4.test.ts`

**Interfaces:**
- Produces: `REGDAT4.Raw: string` (latin1, one char per byte, byte 0 preserved); `SpecimenRecpt.RegisteredBy: string | null` (initials); `SpecimenRecpt.RegistrationBlob: string | null` (the same latin1 string).

- [ ] **Step 1: Write the failing test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { REGDAT4 } from "./REGDAT4.js";

function blob(): Buffer {
  const buf = Buffer.alloc(700, 0);
  buf.write("ABC", 135, "latin1"); // registering user initials
  buf[333] = 0;                    // request type byte: must survive as 0
  buf[409] = 2;
  buf[414] = 34;
  buf[417] = 0x82; buf[418] = 0x30; // 12418 little-endian
  return buf;
}

test("Raw keeps every byte, including 0", () => {
  const r = new REGDAT4("TDS0000001", blob());
  assert.equal(r.Raw.length, 700);
  assert.equal(r.Raw.charCodeAt(333), 0);
  assert.equal(r.Raw.charCodeAt(409), 2);
  assert.equal(r.Raw.charCodeAt(417) + 256 * r.Raw.charCodeAt(418), 12418);
});

test("ReceivedBy still decodes the registering user's initials", () => {
  assert.equal(new REGDAT4("TDS0000001", blob()).ReceivedBy, "ABC");
});
```

- [ ] **Step 2: Run it and check it fails**

Run: `pnpm --filter disalab exec node --import tsx --test src/lib/DisalabData/REGDAT4.test.ts`
Expected: FAIL on `r.Raw` (undefined).

- [ ] **Step 3: Keep the raw string**

In `REGDAT4.ts`, add a field beside `LabNumber`:

```ts
  /** The whole REGDAT4_STATUS blob as latin1, one char per byte. Byte 0 is kept as 0
   *  (Core.FixBytes would turn it into a space), so single-byte fields can be read. */
  Raw!: string;
```

and make the first line of `Populate`:

```ts
    this.Raw = Core.ConvertToBytes(bytes);
```

- [ ] **Step 4: Carry it onto SpecimenRecpt**

In `specimenrecpt.ts`, add the two fields beside `ReceivedInLabBy`:

```ts
  /** REGDAT4 bytes 135-138: the user who registered the request (initials). */
  RegisteredBy: string | null = null;
  /** REGDAT4_STATUS as latin1, one char per byte. For the CLI's measured byte reads. */
  RegistrationBlob: string | null = null;
```

In `Fetch`, next to `r.ReceivedInLabBy = regdat4.ReceivedInLabBy ?? null;`, add:

```ts
      r.RegisteredBy = Core.IsNullOrEmpty(regdat4.ReceivedBy) ? null : regdat4.ReceivedBy;
      r.RegistrationBlob = regdat4.Raw ?? null;
```

- [ ] **Step 5: Run the tests, typecheck and build**

Run: `pnpm --filter disalab exec node --import tsx --test src/lib/DisalabData/REGDAT4.test.ts src/lib/DisalabData/testdata-header.test.ts > $SCRATCH/t1.txt 2>&1; echo "exit=$?"`. Expected: `exit=0`.
Run: `pnpm --filter disalab typecheck`, then `pnpm --filter disalab build`, each redirected with `echo "exit=$?"`. Expected: `exit=0`.

- [ ] **Step 6: Commit**

```bash
git add packages/disalab/src/lib/DisalabData/REGDAT4.ts packages/disalab/src/lib/DisalabData/REGDAT4.test.ts packages/disalab/src/lib/Forms/specimenrecpt.ts
git commit -m "feat(disalab): keep the raw registration bytes and the registering user"
```

---

### Task 2: Measured offsets and codes in config

**Files:**
- Modify: `apps/cli/src/config/blob-offsets.ts`
- Modify: `apps/cli/src/config/blob-offsets.test.ts`
- Create: `apps/cli/src/config/request-fact-config.ts`
- Create: `apps/cli/src/config/request-fact-config.test.ts`
- Create: `config/request-attributes.yaml`
- Modify: `config/tanzania.yaml`

**Interfaces:**
- Produces: `BlobOffsets` gains `analysisAt: { start: number; kind: "long-datetime" | "short-datetime" } | null`, `analyzerCode: { start: number; end: number } | null`, `testerInitials: { start: number; end: number } | null`.
- Produces: `interface RequestFactConfig { registration: RegistrationOffsets; sectionCodes: ReadonlyMap<string, string>; attributeCodes: AttributeCodes }`, `interface RegistrationOffsets { requestType: { offset: number; values: ReadonlyMap<number, string> } | null; ageYears: { offset: number } | null; ageDays: { offset: number } | null; newborn: { offset: number; mask: number } | null }`, `interface AttributeCodes { therapy: string | null; folderNumber: string | null; newborn: string | null }`, `loadRequestFactConfig(country: string | undefined, dir?: string): RequestFactConfig`, `EMPTY_REQUEST_FACT_CONFIG`.

- [ ] **Step 1: Write the failing tests**

Append to `blob-offsets.test.ts`:

```ts
test("loads the analysis, analyser and tester slots", () => {
  const dir = dirWith(`disa_blob_offsets:
  reviewer_initials: { start: 77, end: 80 }
  analysis_at: { start: 15, kind: long-datetime }
  analyzer_code: { start: 56, end: 61 }
  tester_initials: { start: 74, end: 77 }
`);
  try {
    const o = loadBlobOffsets("tanzania", dir);
    assert.deepEqual(o.analysisAt, { start: 15, kind: "long-datetime" });
    assert.deepEqual(o.analyzerCode, { start: 56, end: 61 });
    assert.deepEqual(o.testerInitials, { start: 74, end: 77 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the new slots are null when the yaml does not name them", () => {
  const dir = dirWith(GOOD);
  try {
    const o = loadBlobOffsets("tanzania", dir);
    assert.equal(o.analysisAt, null);
    assert.equal(o.analyzerCode, null);
    assert.equal(o.testerInitials, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

Create `request-fact-config.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRequestFactConfig } from "./request-fact-config.js";

function dirWith(country: string | null, attributes: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "cdr-facts-"));
  if (country !== null) writeFileSync(join(dir, "tanzania.yaml"), country);
  if (attributes !== null) writeFileSync(join(dir, "request-attributes.yaml"), attributes);
  return dir;
}

const COUNTRY = `disa_registration_offsets:
  request_type: { offset: 333, values: { 0: D, 8: E } }
  age_years: { offset: 414 }
  age_days: { offset: 417 }
  newborn: { offset: 409, mask: 2 }
hl7_section_codes:
  V: VR
  "": OTH
`;
const ATTRS = `request_attributes:
  therapy: therapy
  folder_number: ordering-notes
  newborn: newborn
`;

test("loads registration offsets, section codes and attribute codes", () => {
  const dir = dirWith(COUNTRY, ATTRS);
  try {
    const c = loadRequestFactConfig("tanzania", dir);
    assert.equal(c.registration.requestType?.offset, 333);
    assert.equal(c.registration.requestType?.values.get(0), "D");
    assert.equal(c.registration.requestType?.values.get(8), "E");
    assert.deepEqual(c.registration.ageYears, { offset: 414 });
    assert.deepEqual(c.registration.ageDays, { offset: 417 });
    assert.deepEqual(c.registration.newborn, { offset: 409, mask: 2 });
    assert.equal(c.sectionCodes.get("V"), "VR");
    assert.equal(c.sectionCodes.get(""), "OTH");
    assert.deepEqual(c.attributeCodes, { therapy: "therapy", folderNumber: "ordering-notes", newborn: "newborn" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unknown country decodes nothing but still gets the shared attribute codes", () => {
  const dir = dirWith(null, ATTRS);
  try {
    const c = loadRequestFactConfig("mozambique", dir);
    assert.equal(c.registration.requestType, null);
    assert.equal(c.registration.ageYears, null);
    assert.equal(c.sectionCodes.size, 0);
    assert.equal(c.attributeCodes.therapy, "therapy");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no attribute file means no attribute is sent", () => {
  const dir = dirWith(COUNTRY, null);
  try {
    assert.deepEqual(loadRequestFactConfig("tanzania", dir).attributeCodes, { therapy: null, folderNumber: null, newborn: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects an attribute code outside lowercase-hyphen form", () => {
  const dir = dirWith(COUNTRY, "request_attributes:\n  therapy: Therapy Code\n");
  try {
    assert.throws(() => loadRequestFactConfig("tanzania", dir), /request_attributes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run them and check they fail**

Run: `pnpm --filter @cdr-toolchain/cli exec node --import tsx --test src/config/blob-offsets.test.ts src/config/request-fact-config.test.ts`.
Expected: FAIL (no new fields, no module).

- [ ] **Step 3: Extend `blob-offsets.ts`**

In the zod `schema`, the `disa_blob_offsets` object gains:

```ts
        analysis_at: reviewedAtSchema.optional(),
        analyzer_code: slotSchema.optional(),
        tester_initials: slotSchema.optional(),
```

`BlobOffsets` gains the three fields from Interfaces, each with a one-line comment naming the Tanzania measurement. `UNCONFIGURED` sets all three to `null`. `loadBlobOffsets` returns `analysisAt: block.analysis_at ?? null`, `analyzerCode: block.analyzer_code ?? null`, `testerInitials: block.tester_initials ?? null`. `assertOffsetsPlausible` is unchanged. Update every other literal `BlobOffsets` in the repo (tests included; `grep -rn "reviewedAt:" apps/cli/src`) to add the three fields as `null`, or the typecheck fails.

- [ ] **Step 4: Create `request-fact-config.ts`**

```ts
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
    request_type: z.object({ offset: byte, values: z.record(z.string(), z.string().min(1)) }).optional(),
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
```

A `request_type.values` key that is not an integer must fail: add `.refine((v) => Object.keys(v).every((k) => /^\d+$/.test(k)), { message: "values keys must be byte values" })` to the `values` record, and a test for it.

- [ ] **Step 5: The YAML files**

Create `config/request-attributes.yaml`:

```yaml
# Shared by every deployment (no country switch). Maps a DISA source the exporter
# knows to a code in urn:openldr:cs:request-attribute, the CE vocabulary in
# openldr_ce packages/terminology/codesystems/openldr-request-attribute.json.
# Remove a line to stop sending that attribute.
request_attributes:
  therapy: therapy              # TXT1DATA frame 21, else REGDAT4 Therapy
  folder_number: ordering-notes # REGDAT4 FolderNumber; v1 OrderingNotes matched 136 of 136
  newborn: newborn              # REGDAT4 newborn bit, sent only when set
```

Append to `config/tanzania.yaml` (keep the file's existing comment style; no em dashes):

```yaml
# Measured 2026-09-29 against OpenLDR v1 Requests (TZDISAT%), see openldr_ce
# docs/superpowers/specs/2026-09-29-v1-request-facts-disa-sources.md.
# analysis_at: 169,844 match, 0 mismatch. analyzer_code: 170,465 agree, 0 mismatch.
# tester_initials: initials match; 4% of names differ because USERDIC6 changed.
# (These three belong inside the existing disa_blob_offsets block above.)
disa_registration_offsets:
  request_type: { offset: 333, values: { 0: D, 8: E } }  # 93,161 D and 5,098 E, no exceptions
  age_years: { offset: 414 }                             # equals v1 AgeInYears on every row
  age_days: { offset: 417 }                              # 417-418 little-endian, equals v1 AgeInDays
  newborn: { offset: 409, mask: 2 }                      # 3 of 3 v1 newborns; thin base
# TESTDICT.SECTION letter to v1 HL7SectionCode. "" is a blank section.
hl7_section_codes:
  V: VR
  S: SR
  C: CH
  M: MB
  H: HM
  P: PAR
  B: BLB
  L: OTH
  G: OTH
  HT: OTH
  TB: OTH
  "": OTH
```

Add the three header slots inside the existing `disa_blob_offsets` block:

```yaml
  analysis_at: { start: 15, kind: long-datetime }
  analyzer_code: { start: 56, end: 61 }
  tester_initials: { start: 74, end: 77 }
```

Add a test that loads the real `config/` directory (`loadBlobOffsets("tanzania", <repo>/config)` and `loadRequestFactConfig("tanzania", <repo>/config)`) and asserts the Tanzania values, so a typo in the YAML fails a test.

- [ ] **Step 6: Run tests and typecheck**

Run the two test files and `pnpm --filter @cdr-toolchain/cli typecheck`, each redirected, `echo "exit=$?"`. Expected: `exit=0`.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/config config/request-attributes.yaml config/tanzania.yaml
git commit -m "feat(config): measured offsets and codes for the v1 request facts"
```

Also stage any test file you touched in Step 3 to add the three `null` fields, by exact path.

---

### Task 3: Per-panel facts from the TESTDATA header

**Files:**
- Modify: `apps/cli/src/export/review-status.ts`
- Modify: `apps/cli/src/export/review-status.test.ts`

**Interfaces:**
- Consumes: Task 2 `BlobOffsets.analysisAt`, `.analyzerCode`, `.testerInitials`.
- Produces: `ObrStatus` gains `analysisAt: Date | null`, `analyzerCode: string | null`, `testerInitials: string | null`, `reviewerInitials: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `review-status.test.ts`. Reuse the file's existing header builder and `PanelIteration` helpers if it has them; otherwise build headers with `TestDataHeader.fromBytes(Buffer)` the way `v2-transform-review-status.test.ts` does. The cases:

```ts
const ALL: BlobOffsets = {
  reviewerInitials: { start: 77, end: 80 },
  reviewedAt: { start: 21, kind: "long-datetime" },
  analysisAt: { start: 15, kind: "long-datetime" },
  analyzerCode: { start: 56, end: 61 },
  testerInitials: { start: 74, end: 77 },
};

function header(opts: { analysis?: [number, number, number, number, number]; analyzer?: string; tester?: string; reviewer?: string }): TestDataHeader {
  const buf = Buffer.alloc(HEADER_LENGTH, 0);
  if (opts.analysis) {
    const [y, m, d, h, mi] = opts.analysis;
    buf[15] = d; buf[16] = m; buf[17] = y % 256; buf[18] = Math.floor(y / 256); buf[19] = mi; buf[20] = h;
  }
  if (opts.analyzer) buf.write(opts.analyzer, 56, "latin1");
  if (opts.tester) buf.write(opts.tester, 74, "latin1");
  if (opts.reviewer) buf.write(opts.reviewer, 77, "latin1");
  return TestDataHeader.fromBytes(buf);
}

test("reads analysis time from the FIRST iteration and people from the latest", () => {
  const iterations: PanelIteration[] = [
    { panelCode: "PROT", panelIndex: 1, datestamp: new Date(2013, 7, 5, 20, 0), header: header({ analysis: [2013, 8, 5, 20, 53], analyzer: "ALNK1", tester: "SMM" }) },
    { panelCode: "PROT", panelIndex: 2, datestamp: new Date(2013, 7, 5, 21, 0), header: header({ analysis: [2013, 8, 5, 21, 10], analyzer: "ALNK2", tester: "RJB", reviewer: "APB" }) },
  ];
  const s = buildStatusByObr({ iterations, obrOf: () => 1, obsCountByObr: new Map([[1, 3]]), rejectedObrs: new Set(), offsets: ALL }).get(1)!;
  assert.equal(s.analysisAt?.getHours(), 20);
  assert.equal(s.analysisAt?.getMinutes(), 53);
  assert.equal(s.analyzerCode, "ALNK2");
  assert.equal(s.testerInitials, "RJB");
  assert.equal(s.reviewerInitials, "APB");
});

test("an unconfigured slot yields null, never a guess", () => {
  const offsets: BlobOffsets = { ...ALL, analysisAt: null, analyzerCode: null, testerInitials: null };
  const iterations: PanelIteration[] = [
    { panelCode: "PROT", panelIndex: 1, datestamp: null, header: header({ analysis: [2013, 8, 5, 20, 53], analyzer: "ALNK1", tester: "SMM" }) },
  ];
  const s = buildStatusByObr({ iterations, obrOf: () => 1, obsCountByObr: new Map([[1, 1]]), rejectedObrs: new Set(), offsets }).get(1)!;
  assert.equal(s.analysisAt, null);
  assert.equal(s.analyzerCode, null);
  assert.equal(s.testerInitials, null);
});

test("a rejected panel still carries the header facts it has", () => {
  const iterations: PanelIteration[] = [
    { panelCode: "PROT", panelIndex: 1, datestamp: null, header: header({ tester: "SMM" }) },
  ];
  const s = buildStatusByObr({ iterations, obrOf: () => 1, obsCountByObr: new Map([[1, 0]]), rejectedObrs: new Set([1]), offsets: ALL }).get(1)!;
  assert.equal(s.status, "X");
  assert.equal(s.testerInitials, "SMM");
});

test("an all-zero analysis time is null", () => {
  const iterations: PanelIteration[] = [{ panelCode: "PROT", panelIndex: 1, datestamp: null, header: header({}) }];
  const s = buildStatusByObr({ iterations, obrOf: () => 1, obsCountByObr: new Map([[1, 1]]), rejectedObrs: new Set(), offsets: ALL }).get(1)!;
  assert.equal(s.analysisAt, null);
});
```

Every existing literal `ObrStatus` or `BlobOffsets` in the test files must gain the new fields.

- [ ] **Step 2: Run and check they fail**

Run: `pnpm --filter @cdr-toolchain/cli exec node --import tsx --test src/export/review-status.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

In `buildStatusByObr`, track the earliest iteration per OBR beside the latest (`isEarlier` is `isLater` with the arguments swapped; do not add a second ordering rule). Compute the four facts once per OBR, before the `X` and `I` early returns, and put them in every `out.set(...)`:

```ts
function headerFacts(first: PanelIteration | null, winner: PanelIteration | null, offsets: BlobOffsets) {
  const w = winner?.header ?? null;
  const f = first?.header ?? null;
  return {
    analysisAt: f !== null && offsets.analysisAt !== null ? decodeAt(f, offsets.analysisAt) : null,
    analyzerCode: w !== null && offsets.analyzerCode !== null ? w.initialsAt(offsets.analyzerCode) : null,
    testerInitials: w !== null && offsets.testerInitials !== null ? w.initialsAt(offsets.testerInitials) : null,
    reviewerInitials: w !== null && offsets.reviewerInitials !== null ? w.initialsAt(offsets.reviewerInitials) : null,
  };
}
```

`decodeAt(header, slot)` is the body of today's `decodeReviewedAt` taking the slot as a parameter; make `decodeReviewedAt` call it, so there is one decoder. `initialsAt` already drops byte 0 and trims; it reads the analyser code the same way (the name says initials; add a one-line comment that it reads any short ASCII field).

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter @cdr-toolchain/cli exec node --import tsx --test src/export/review-status.test.ts src/export/v2-transform-review-status.test.ts`, and the cli typecheck, redirected. Expected: `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/export/review-status.ts apps/cli/src/export/review-status.test.ts
git commit -m "feat(export): read analysis time, analyser, tester and reviewer per panel"
```

---

### Task 4: Registration facts from the REGDAT4 bytes

**Files:**
- Create: `apps/cli/src/export/registration-facts.ts`
- Create: `apps/cli/src/export/registration-facts.test.ts`

**Interfaces:**
- Consumes: Task 1 `SpecimenRecpt.RegistrationBlob`; Task 2 `RegistrationOffsets`.
- Produces: `export interface RegistrationFacts { requestType: string | null; ageYears: number | null; ageDays: number | null; newborn: boolean }` and `export function readRegistrationFacts(blob: string | null, offsets: RegistrationOffsets): RegistrationFacts`.

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readRegistrationFacts } from "./registration-facts.js";
import type { RegistrationOffsets } from "../config/request-fact-config.js";

const TZ: RegistrationOffsets = {
  requestType: { offset: 333, values: new Map([[0, "D"], [8, "E"]]) },
  ageYears: { offset: 414 },
  ageDays: { offset: 417 },
  newborn: { offset: 409, mask: 2 },
};

function blob(set: Record<number, number>): string {
  const buf = Buffer.alloc(700, 0);
  for (const [i, v] of Object.entries(set)) buf[Number(i)] = v;
  return buf.toString("latin1");
}

test("decodes request type, age and newborn", () => {
  const f = readRegistrationFacts(blob({ 333: 8, 409: 2, 414: 1, 417: 0x80, 418: 0x02 }), TZ);
  assert.deepEqual(f, { requestType: "E", ageYears: 1, ageDays: 640, newborn: true });
});

test("byte 0 is the D request type, not a blank", () => {
  assert.equal(readRegistrationFacts(blob({}), TZ).requestType, "D");
});

test("a byte value the config does not name is null", () => {
  assert.equal(readRegistrationFacts(blob({ 333: 5 }), TZ).requestType, null);
});

test("zero age is empty, as v1 writes 0 as a filler", () => {
  const f = readRegistrationFacts(blob({}), TZ);
  assert.equal(f.ageYears, null);
  assert.equal(f.ageDays, null);
});

test("other bits in the newborn byte do not count", () => {
  assert.equal(readRegistrationFacts(blob({ 409: 4 }), TZ).newborn, false);
});

test("no blob or no offsets decodes nothing", () => {
  const none = { requestType: null, ageYears: null, ageDays: null, newborn: false };
  assert.deepEqual(readRegistrationFacts(null, TZ), none);
  assert.deepEqual(readRegistrationFacts(blob({ 333: 8, 414: 3 }), { requestType: null, ageYears: null, ageDays: null, newborn: null }), none);
});

test("an offset past the end of a short blob is null", () => {
  assert.equal(readRegistrationFacts("\u0000".repeat(100), TZ).ageYears, null);
});
```

- [ ] **Step 2: Run and check they fail**

Run: `pnpm --filter @cdr-toolchain/cli exec node --import tsx --test src/export/registration-facts.test.ts`. Expected: FAIL (no module).

- [ ] **Step 3: Implement**

```ts
import type { RegistrationOffsets } from "../config/request-fact-config.js";

export interface RegistrationFacts {
  requestType: string | null;
  ageYears: number | null;
  ageDays: number | null;
  /** True only when the configured bit is set. A clear bit and an unmeasured deployment both give false. */
  newborn: boolean;
}

/** Reads the measured single-byte facts from REGDAT4_STATUS (latin1, one char per byte).
 *  Offsets come from config/<country>.yaml; a null offset decodes nothing. */
export function readRegistrationFacts(blob: string | null, offsets: RegistrationOffsets): RegistrationFacts {
  const at = (i: number): number | null => (blob !== null && i < blob.length ? blob.charCodeAt(i) & 0xff : null);
  const rt = offsets.requestType;
  const typeByte = rt === null ? null : at(rt.offset);
  const years = offsets.ageYears === null ? null : at(offsets.ageYears.offset);
  const lo = offsets.ageDays === null ? null : at(offsets.ageDays.offset);
  const hi = offsets.ageDays === null ? null : at(offsets.ageDays.offset + 1);
  const days = lo === null || hi === null ? null : lo + 256 * hi;
  const flags = offsets.newborn === null ? null : at(offsets.newborn.offset);
  return {
    requestType: typeByte === null || rt === null ? null : rt.values.get(typeByte) ?? null,
    ageYears: years === null || years === 0 ? null : years,
    ageDays: days === null || days === 0 ? null : days,
    newborn: flags !== null && offsets.newborn !== null && (flags & offsets.newborn.mask) !== 0,
  };
}
```

- [ ] **Step 4: Run tests and typecheck**, redirected, `exit=0`.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/export/registration-facts.ts apps/cli/src/export/registration-facts.test.ts
git commit -m "feat(export): read request type, age and newborn from the registration bytes"
```

---

### Task 5: The V2 payload carries the facts

**Files:**
- Modify: `apps/cli/src/export/types.ts`
- Modify: `apps/cli/src/export/v2-transform.ts`
- Create: `apps/cli/src/export/v2-transform-request-facts.test.ts`
- Modify: `apps/cli/src/commands/export.ts`, `apps/cli/src/commands/export-batch.ts`, `apps/cli/src/commands/compare-batch.ts` (load the config once, pass it)

**Interfaces:**
- Consumes: Tasks 2-4.
- Produces: `ToV2Opts.factConfig: RequestFactConfig` (required). In `types.ts`:

```ts
/** A rare request fact for CE's lab_request_attributes (urn:openldr:cs:request-attribute). */
export type V2RequestAttribute =
  | { code: string; valueString: string }
  | { code: string; valueBoolean: boolean };

/** Request facts v2 has no field for. They ride in source_payload.request_facts, which v2
 *  stores as free JSON, and toFhir sends them to CE. Every field is absent when unknown. */
export interface V2RequestFacts {
  registered_by?: string;
  request_type?: string;
  analyzer_code?: string;
  rejection_code?: string;
  rejection_reason?: string;
  point_of_care?: string;
  attributes?: V2RequestAttribute[];
}
```

- [ ] **Step 1: Write the failing tests**

Create `v2-transform-request-facts.test.ts`. Copy the fixture approach of `v2-transform-review-status.test.ts` (the TZ pin at the top, `stubCodebook`, a hand-built `SpecimenRecpt` literal cast with `as unknown as SpecimenRecpt`, `makeItem`). Give the stub codebook a `userEntry` for `SMM` and `APB` and a `panelEntry` with `section: "V"` (extend `stubCodebook` with optional overrides if it has none, and say so in the report). Cases, each asserting on `toV2(...).lab_requests[0]`:

1. With Tanzania offsets and config: `analysis_at` is the local ISO of the first iteration's header time; `tested_by` is the USERDIC6 name for `SMM`; `authorised_by` is the name for `APB`; `section_code` is `VR`; `age_years` and `age_days` come from the blob, not the date of birth (give the specimen a `DobAge` that would compute a different age); `source_payload.request_facts` deep-equals `{ registered_by: <name for the RegisteredBy initials>, request_type: "E", analyzer_code: "ALNK1", point_of_care: <ward>, attributes: [{ code: "therapy", valueString: "ART" }, { code: "ordering-notes", valueString: <FolderNo> }, { code: "newborn", valueBoolean: true }] }`.
2. Initials with no USERDIC6 entry are sent as the initials.
3. A rejected panel: the OBR whose RJREA item has `RawValue: "CONU"` and `Value: "Spec contaminated with urine"` gets `rejection_code: "CONU"` and `rejection_reason: "Spec contaminated with urine"`; a sibling OBR has neither key.
4. Unconfigured (all offsets null, empty section map, all attribute codes null): `analysis_at`, `tested_by`, `authorised_by`, `section_code` are null; age is the date-of-birth value (ruling 2); `request_facts` has no `request_type`, `analyzer_code` or `attributes` key; `registered_by` and `point_of_care` are still present (they need no offsets).
5. A blank section with `"": "OTH"` in the map gives `OTH`; the same blank with no `""` key gives null; an unmapped letter gives null.
6. `newborn` is absent from `attributes` when the bit is clear.

- [ ] **Step 2: Run and check they fail.**

- [ ] **Step 3: Implement in `v2-transform.ts`**

- Add `factConfig: RequestFactConfig` to `ToV2Opts` with a comment matching `blobOffsets`'s ("loaded ONCE at startup").
- `buildLabRequest` gains `rejectionReason: { code: string; reason: string } | null` and `registration: RegistrationFacts` parameters, and reads `codebook`, `opts.factConfig` for names, sections and attribute codes. Name resolution: `const person = (initials: string | null) => initials === null ? null : codebook.userEntry(initials)?.description ?? initials;`.
- Field changes, one line each:
  - `analysis_at: reviewStatus?.analysisAt ? dateToLocalIso(reviewStatus.analysisAt) : null`
  - `tested_by: person(reviewStatus?.testerInitials ?? null)` (replaces the `ReceivedInLabBy` chain)
  - `authorised_by: person(reviewStatus?.reviewerInitials ?? null)`
  - `section_code: sectionCodes.get(panel?.section ?? "") ?? null` (a missing panel entry and a blank section both look up `""`)
  - `age_years: registration.ageYears`, `age_days: registration.ageDays` (the date-of-birth block in `toV2` then runs only for a request whose `age_years` and `age_days` are both null, which is ruling 2)
  - `source_payload.request_facts`: built with only the keys that have a value; `point_of_care` is `wardDescription ?? nz(s.WardClinic)`; `attributes` is built from `attributeCodes`: therapy from `nz(s.TherapyText) ?? nz(s.Therapy)`, ordering notes from `nz(s.FolderNo)`, newborn `{ valueBoolean: true }` only when `registration.newborn`; omit `attributes` when empty.
- In `toV2`: compute `readRegistrationFacts(specimen.RegistrationBlob ?? null, opts.factConfig.registration)` once. Extend the existing RJREA loop so it also records `{ code: o.rawValue.trim(), reason: String(o.value).trim() }` per OBR (first one wins), and pass the entry for each OBR to `buildLabRequest`. Empty strings become absent.

- [ ] **Step 4: Wire the commands**

At each of the three `loadBlobOffsets(...)` call sites (`export.ts:229`, `export-batch.ts:1075`, `compare-batch.ts:353`), load `loadRequestFactConfig(<same country expression>)` next to it and pass it as `factConfig` wherever `blobOffsets` is passed into `toV2` options. Find every `toV2(` call with grep, tests included; test calls pass `EMPTY_REQUEST_FACT_CONFIG` unless they test these facts.

- [ ] **Step 5: Run the whole cli suite**

Run: `pnpm --filter @cdr-toolchain/cli test > $SCRATCH/t5.txt 2>&1; echo "exit=$?"`.
Some existing tests pin the old wrong values (`tested_by` from `ReceivedInLabBy`, age from date of birth, the raw section letter). For each failure: if the test pins one of those three old behaviours, update its expectation and list the file and assertion in the report. Any other failure is a regression: fix the code, not the test. Typecheck, redirected. Expected: `exit=0` for both.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/export/types.ts apps/cli/src/export/v2-transform.ts apps/cli/src/export/v2-transform-request-facts.test.ts apps/cli/src/commands/export.ts apps/cli/src/commands/export-batch.ts apps/cli/src/commands/compare-batch.ts
git commit -m "feat(export): fill the v1 request facts, and fix tested by, age and section"
```

Stage by exact path every other test file you updated in Step 5.

---

### Task 6: The FHIR slots CE reads

**Files:**
- Modify: `apps/cli/src/export/fhir-transform.ts`
- Modify: `apps/cli/src/export/fhir-transform.test.ts`
- Modify: `apps/cli/src/export/fhir-conformance.test.ts`

**Interfaces:**
- Consumes: Task 5 `V2LabRequest.section_code`, `.authorised_by`, `.analysis_at`, `.tested_by`, `.age_years`, `.age_days`, and `source_payload.request_facts: V2RequestFacts`.

- [ ] **Step 1: Write the failing tests**

Append to `fhir-transform.test.ts`, using its `basePayload` helper. Build a payload whose first lab request has every fact set, run `toFhir`, pick the `ServiceRequest` and `DiagnosticReport`, and assert exact JSON:

```ts
test("sends every request fact in the slot CE reads", () => {
  const p = basePayload();
  Object.assign(p.lab_requests[0]!, {
    analysis_at: "2013-08-05T20:55:00", tested_by: "Sylvester Mattunda", authorised_by: "Regnald Julius",
    age_years: 1, age_days: 640, section_code: "VR",
    source_payload: {
      ...p.lab_requests[0]!.source_payload,
      request_facts: {
        registered_by: "Ester Mwavika", request_type: "E", analyzer_code: "ALNK1",
        rejection_code: "CONU", rejection_reason: "Spec contaminated with urine",
        point_of_care: "Medical Ward 2",
        attributes: [{ code: "therapy", valueString: "ART" }, { code: "newborn", valueBoolean: true }],
      },
    },
  });
  const out = toFhir(p, { tzOffset: "+03:00" });
  const sr = out.find((r) => r.resourceType === "ServiceRequest")!;
  const dr = out.find((r) => r.resourceType === "DiagnosticReport")!;
  assert.deepEqual(sr.locationCode, [{ text: "Medical Ward 2" }]);
  assert.deepEqual(sr.extension, [
    { url: "urn:openldr:ext:analysis-time", valueDateTime: "2013-08-05T20:55:00+03:00" },
    { url: "urn:openldr:ext:registered-by", valueString: "Ester Mwavika" },
    { url: "urn:openldr:ext:tested-by", valueString: "Sylvester Mattunda" },
    { url: "urn:openldr:ext:request-type", valueCode: "E" },
    { url: "urn:openldr:ext:age-at-request", extension: [{ url: "years", valueInteger: 1 }, { url: "days", valueInteger: 640 }] },
    { url: "urn:openldr:ext:analyzer", valueCode: "ALNK1" },
    { url: "urn:openldr:ext:rejection", extension: [{ url: "code", valueCode: "CONU" }, { url: "reason", valueString: "Spec contaminated with urine" }] },
    { url: "urn:openldr:ext:request-attribute", extension: [{ url: "code", valueCoding: { system: "urn:openldr:cs:request-attribute", code: "therapy" } }, { url: "value", valueString: "ART" }] },
    { url: "urn:openldr:ext:request-attribute", extension: [{ url: "code", valueCoding: { system: "urn:openldr:cs:request-attribute", code: "newborn" } }, { url: "value", valueBoolean: true }] },
  ]);
  assert.deepEqual(dr.category, [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0074", code: "VR" }] }]);
  assert.deepEqual(dr.resultsInterpreter, [{ display: "Regnald Julius" }]);
});

test("an absent fact is omitted, not sent empty", () => {
  const out = toFhir(basePayload(), { tzOffset: "+03:00" });
  const sr = out.find((r) => r.resourceType === "ServiceRequest")!;
  const dr = out.find((r) => r.resourceType === "DiagnosticReport")!;
  assert.equal("extension" in sr, false);
  assert.equal("locationCode" in sr, false);
  assert.equal("category" in dr, false);
  assert.equal("resultsInterpreter" in dr, false);
});

test("age with only years sends only the years sub-extension", () => {
  const p = basePayload();
  Object.assign(p.lab_requests[0]!, { age_years: 34, age_days: null });
  const sr = toFhir(p, { tzOffset: "+03:00" }).find((r) => r.resourceType === "ServiceRequest")!;
  assert.deepEqual(sr.extension, [
    { url: "urn:openldr:ext:age-at-request", extension: [{ url: "years", valueInteger: 34 }] },
  ]);
});

test("a rejection with a code and no reason sends only the code", () => {
  const p = basePayload();
  Object.assign(p.lab_requests[0]!, {
    source_payload: { ...p.lab_requests[0]!.source_payload, request_facts: { rejection_code: "CONU" } },
  });
  const sr = toFhir(p, { tzOffset: "+03:00" }).find((r) => r.resourceType === "ServiceRequest")!;
  assert.deepEqual(sr.extension, [
    { url: "urn:openldr:ext:rejection", extension: [{ url: "code", valueCode: "CONU" }] },
  ]);
});
```

If `basePayload()` already sets `age_years`, `age_days` or other facts, null them first in each test so the expected lists stay exact. Adjust the `analysis-time` expectation to whatever `fhirDateTime(value, tzOffset)` produces for other datetimes in this file (read one existing assertion first); the point is that analysis time goes through the same `fhirDateTime` call as `authoredOn`.

- [ ] **Step 2: Run and check they fail.**

- [ ] **Step 3: Implement**

In `fhir-transform.ts`, add named constants at the top with one-line comments: `EXT = "urn:openldr:ext:"`, `REQUEST_ATTRIBUTE_SYSTEM = "urn:openldr:cs:request-attribute"`, `SECTION_SYSTEM = "http://terminology.hl7.org/CodeSystem/v2-0074"`. Add `function requestFactExtensions(lr: V2LabRequest, opts: ToFhirOptions): Record<string, unknown>[]` that builds the list in the order the test shows, skipping every absent value; read `request_facts` through a small typed accessor (`source_payload` is `Record<string, unknown>`) that returns `{}` when absent. Then in `requestResources`:

- ServiceRequest: `...(poc !== undefined ? { locationCode: [{ text: poc }] } : {})` and `...(ext.length > 0 ? { extension: ext } : {})`. Use `fhirText` on every string, as the file already does.
- DiagnosticReport: `category` when `section_code` is set, `resultsInterpreter` when `authorised_by` is set.

- [ ] **Step 4: Run tests and typecheck**, redirected, `exit=0`.

- [ ] **Step 5: The HL7 validator**

Add one case to `fhir-conformance.test.ts` that validates the full-facts payload from Step 1. Run: `FHIR_CONFORMANCE=1 pnpm --filter @cdr-toolchain/cli exec node --import tsx --test src/export/fhir-conformance.test.ts > $SCRATCH/conf.txt 2>&1; echo "exit=$?"`. The first run downloads the validator (100-200 MB).

If the validator reports the `urn:openldr:ext:*` extensions as errors because it cannot resolve them, do NOT change the URLs: CE already reads these exact URLs (spec 6, merged `39debf02`). Look for the harness option that allows unknown extensions (the official validator's `-allow-any-extensions`, or its equivalent in fhir-validator-js), turn it on for this harness only, and say so in the report. If no such option exists, STOP and report BLOCKED with the validator's exact message.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/export/fhir-transform.ts apps/cli/src/export/fhir-transform.test.ts apps/cli/src/export/fhir-conformance.test.ts
git commit -m "feat(export): send the v1 request facts in the FHIR slots CE reads"
```

---

### Task 7: Gates, live comparison, merge (controller)

Run by the controller. Steps 3 and 4 write the shared CE dev database and need the operator's go-ahead first.

- [ ] **Step 1: Gates**

`pnpm turbo run test --force` and `pnpm turbo run typecheck --force`, each redirected, each `exit=0`. `FHIR_CONFORMANCE=1` run from Task 6 Step 5 green.

- [ ] **Step 2: A dry run against v1 (read-only)**

Export the deterministic sample `abs(checksum([LabNo])) % 2000 = 0` (75 labs, the Task 1 findings sample) to FHIR files without pushing, and compare each new fact per OBR with `OpenLDRData.dbo.Requests` (`RequestID = 'TZDISA' + LabNo`, count a trimmed empty string as empty). Expected, from the findings: analysis time, request type, age, analyser, rejection and ordering notes match on every paired row; section matches except blank or missing letters; the three staff names match on initials, with 2 to 4% name differences from USERDIC6 changes. Write the table into the branch as `docs/superpowers/specs/2026-09-29-v1-request-facts-wire-check.md`.

- [ ] **Step 3: Push the sample to the local CE (ask first)**

`export-batch` to the local CE with `OPENLDR_LAB_CODE` set, for the same 75 labs. Then query CE's `openldr_target`: for each new `lab_requests` and `diagnostic_reports` column and each attribute code, compare with v1 for the same requests. That table is the spec's section 9 "live" check.

- [ ] **Step 4: Merge (ask first)**

Merge `spec/v1-request-facts-wire` to local `main` with `--no-ff`. Do not push unless asked.

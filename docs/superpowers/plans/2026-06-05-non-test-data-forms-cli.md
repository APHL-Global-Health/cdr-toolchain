# Non-test (documentation) data — cdr-toolchain (CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Classify DISA documentation/questionnaire observations per record and route them to OpenLDR v2's new forms feed as form submissions, while keeping real tests on the lab feed and stopping documentation-only records from quarantining.

**Architecture:** A per-country YAML config marks documentation panels/params; a small classifier splits each record's observations into `test` vs `documentation` (config ∪ the existing `isQuestionnaireParam` heuristic). Documentation observations build a form-submission payload (reusing the existing patient/facility/concept shaping) POSTed to a dedicated forms data-feed; test observations follow the existing `toV2` lab path. The audit becomes documentation-aware so `specimen_missing` only fires for genuine test gaps.

**Tech Stack:** TypeScript, Node 20+ (`tsx`), `commander`, `zod`, `yaml` (new dep), `node:test` (new test runner).

**Scope:** This plan covers **System B only** (this repo). **System A (OpenLDR v2 forms feed + plugins + tables)** is a separate codebase and needs its own plan authored there. This plan builds and unit-tests independently of v2 up to Task 12 (opt-in live smoke), which requires v2's forms feed to exist.

**Contract reference:** `docs/superpowers/specs/2026-06-05-non-test-data-forms-subsystem-design.md` (form-submission payload).

---

## File Structure

**Create:**
- `config/zambia.yaml`, `config/tanzania.yaml` — country documentation classifiers.
- `apps/cli/src/export/non-test.ts` — classifier (`DocConfig`, `isDocumentationObs`, `splitObservations`).
- `apps/cli/src/config/country-config.ts` — load `config/<country>.yaml` → `DocConfig`.
- `apps/cli/src/export/forms-types.ts` — `FormSubmissionPayload`, `FormResponse`.
- `apps/cli/src/export/forms-transform.ts` — `toFormSubmission(specimen, opts)`.
- `apps/cli/src/test-helpers/stub-codebook.ts` — minimal `Codebook` for tests.
- Tests: `apps/cli/src/export/non-test.test.ts`, `apps/cli/src/config/country-config.test.ts`, `apps/cli/src/export/forms-transform.test.ts`, `apps/cli/src/audit/detector-non-test.test.ts`, `apps/cli/src/export/v2-transform-exclude.test.ts`.

**Modify:**
- `apps/cli/package.json` — add `yaml` dep + `test` script.
- `apps/cli/src/config.ts` — add `country` + `openldrFormsDataFeedName` config.
- `apps/cli/src/audit/types.ts` — add `routed_as_form` anomaly class.
- `apps/cli/src/audit/detector.ts` — documentation-aware specimen/orphan/empty checks + `routed_as_form`.
- `apps/cli/src/export/v2-transform.ts` — export `buildPatient` + `buildFacilityConcept`; add `ToV2Opts.excludeObs` filter.
- `apps/cli/src/commands/export-batch.ts` — split routing, forms POST, reporting fields, forms-feed config.

---

## Task 1: Test runner + `yaml` dependency

**Files:**
- Modify: `apps/cli/package.json`
- Test: `apps/cli/src/export/smoke.test.ts`

- [ ] **Step 1: Add the `yaml` dependency**

Run from repo root:
```bash
pnpm -C apps/cli add yaml
```
Expected: `yaml` appears under `dependencies` in `apps/cli/package.json`.

- [ ] **Step 2: Add a `test` script**

In `apps/cli/package.json`, add to `"scripts"`:
```json
"test": "node --import tsx --test \"src/**/*.test.ts\""
```

- [ ] **Step 3: Write a runner smoke test**

Create `apps/cli/src/export/smoke.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";

test("test runner works", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 4: Run it**

Run: `pnpm -C apps/cli test`
Expected: PASS — `1 passing` (tests run via tsx).

- [ ] **Step 5: Commit**

```bash
git add apps/cli/package.json apps/cli/pnpm-lock.yaml pnpm-lock.yaml apps/cli/src/export/smoke.test.ts
git commit -m "test: add node:test runner and yaml dependency"
```

---

## Task 2: Stub codebook test helper

**Files:**
- Create: `apps/cli/src/test-helpers/stub-codebook.ts`

- [ ] **Step 1: Write the stub**

Create `apps/cli/src/test-helpers/stub-codebook.ts`:
```ts
import type { Codebook } from "../export/codebook.js";
import type { ParmEntry, PanelEntry } from "../export/codebook.js";

export interface StubOpts {
  /** Param codes to treat as questionnaire/metadata. */
  questionnaire?: string[];
  /** paramCode -> ParmEntry overrides. */
  params?: Record<string, Partial<ParmEntry>>;
  /** panelCode -> description. */
  panels?: Record<string, string>;
  /** specimenCode -> description. */
  specimens?: Record<string, string>;
  antibiotics?: string[];
  pathogenIdParams?: string[];
}

export function stubCodebook(opts: StubOpts = {}): Codebook {
  const q = new Set(opts.questionnaire ?? []);
  const abx = new Set(opts.antibiotics ?? []);
  const pid = new Set(opts.pathogenIdParams ?? []);
  return {
    isAntibiotic: (c) => abx.has(c),
    isTbAntibiotic: () => false,
    isPathogenIdParam: (c) => pid.has(c),
    isQuestionnaireParam: (c) => q.has(c),
    paramEntry: (c) => {
      const o = opts.params?.[c];
      if (o === undefined) return undefined;
      return { code: c, description: "", abbreviation: "", context: 0, units: "", reference: "", ...o };
    },
    panelEntry: (c) => {
      const d = opts.panels?.[c];
      if (d === undefined) return undefined;
      return { code: c, description: d, abbreviation: "", section: null } as PanelEntry;
    },
    specimenEntry: (c) => {
      const d = opts.specimens?.[c];
      if (d === undefined) return undefined;
      return { code: c, description: d };
    },
    organismEntry: () => undefined,
    organismCategory: () => "none",
    userEntry: () => undefined,
    stats: { parmRows: 0, testRows: 0, commOrganismRows: 0, commSpecimenRows: 0, userRows: 0 },
  };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm -C apps/cli typecheck`
Expected: exit 0. (If `CommEntry` requires more fields, add them to the `specimenEntry`/`organismEntry` return to satisfy the compiler.)

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/test-helpers/stub-codebook.ts
git commit -m "test: add stub Codebook helper"
```

---

## Task 3: Classifier (`non-test.ts`)

**Files:**
- Create: `apps/cli/src/export/non-test.ts`
- Test: `apps/cli/src/export/non-test.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/export/non-test.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDocumentationObs, splitObservations, EMPTY_DOC_CONFIG, type DocConfig } from "./non-test.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";

const docConfig: DocConfig = {
  panels: new Set(["VIRAL"]),
  params: new Set(["ARTNO"]),
  forms: new Map([["VIRAL", "hiv_vl_documentation"]]),
};

test("config panel makes an observation documentation", () => {
  const cb = stubCodebook();
  assert.equal(isDocumentationObs({ panelCode: "VIRAL", paramCode: "ARTRS" }, cb, docConfig), true);
});

test("config param makes an observation documentation", () => {
  const cb = stubCodebook();
  assert.equal(isDocumentationObs({ panelCode: "HIVVL", paramCode: "ARTNO" }, cb, docConfig), true);
});

test("questionnaire heuristic makes an observation documentation", () => {
  const cb = stubCodebook({ questionnaire: ["FEED"] });
  assert.equal(isDocumentationObs({ panelCode: "X", paramCode: "FEED" }, cb, EMPTY_DOC_CONFIG), true);
});

test("a plain test observation is not documentation", () => {
  const cb = stubCodebook();
  assert.equal(isDocumentationObs({ panelCode: "HIVVL", paramCode: "HIVVC" }, cb, docConfig), false);
});

test("splitObservations partitions test vs documentation", () => {
  const cb = stubCodebook();
  const obs = [
    { panelCode: "VIRAL", paramCode: "ARTRS" },
    { panelCode: "HIVVL", paramCode: "HIVVC" },
  ];
  const { test: t, documentation: d } = splitObservations(obs, cb, docConfig);
  assert.deepEqual(t, [{ panelCode: "HIVVL", paramCode: "HIVVC" }]);
  assert.deepEqual(d, [{ panelCode: "VIRAL", paramCode: "ARTRS" }]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm -C apps/cli test -- --test-name-pattern="documentation|partitions"`
Expected: FAIL — cannot find module `./non-test.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/cli/src/export/non-test.ts`:
```ts
import type { Codebook } from "./codebook.js";

/** Operator-asserted documentation classifiers for a country deployment. */
export interface DocConfig {
  /** Panel codes whose every observation is documentation. */
  panels: ReadonlySet<string>;
  /** Individual param codes that are documentation regardless of panel. */
  params: ReadonlySet<string>;
  /** panelCode -> logical form code, for the form-submission `form_code`. */
  forms: ReadonlyMap<string, string>;
}

export const EMPTY_DOC_CONFIG: DocConfig = {
  panels: new Set(),
  params: new Set(),
  forms: new Map(),
};

export interface ObsLike { panelCode: string; paramCode: string; }

/**
 * An observation is documentation when its panel or param is config-flagged,
 * OR the existing PARMDICT-context heuristic classes the param as
 * questionnaire/metadata. Config is layered ON TOP of the heuristic.
 */
export function isDocumentationObs(o: ObsLike, cb: Codebook, doc: DocConfig): boolean {
  if (doc.panels.has(o.panelCode)) return true;
  if (doc.params.has(o.paramCode)) return true;
  return cb.isQuestionnaireParam(o.paramCode);
}

export interface RecordSplit<T extends ObsLike> {
  /** Real instrument/test observations. */
  test: T[];
  /** Documentation/questionnaire observations. */
  documentation: T[];
}

export function splitObservations<T extends ObsLike>(
  obs: readonly T[],
  cb: Codebook,
  doc: DocConfig,
): RecordSplit<T> {
  const test: T[] = [];
  const documentation: T[] = [];
  for (const o of obs) {
    if (isDocumentationObs(o, cb, doc)) documentation.push(o);
    else test.push(o);
  }
  return { test, documentation };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C apps/cli test -- --test-name-pattern="documentation|partitions"`
Expected: PASS — 5 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/export/non-test.ts apps/cli/src/export/non-test.test.ts
git commit -m "feat: observation-level documentation classifier"
```

---

## Task 4: Country config loader

**Files:**
- Create: `config/zambia.yaml`, `config/tanzania.yaml`, `apps/cli/src/config/country-config.ts`
- Test: `apps/cli/src/config/country-config.test.ts`

- [ ] **Step 1: Write the config files**

Create `config/zambia.yaml`:
```yaml
# Zambia deployment — documentation (non-test) classifiers.
# Codes that capture ART/VL questionnaire data rather than instrument results.
documentation:
  panels:
    - VIRAL
  params: []
  forms:
    VIRAL: hiv_vl_documentation
```

Create `config/tanzania.yaml`:
```yaml
# Tanzania deployment — documentation (non-test) classifiers.
documentation:
  panels:
    - VLID
    - EIDID
  params: []
  forms:
    VLID: hiv_vl_documentation
    EIDID: eid_documentation
```

- [ ] **Step 2: Write the failing test**

Create `apps/cli/src/config/country-config.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCountryDocConfig } from "./country-config.js";

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cdr-cfg-"));
  writeFileSync(
    join(dir, "zambia.yaml"),
    "documentation:\n  panels:\n    - VIRAL\n  forms:\n    VIRAL: hiv_vl_documentation\n",
  );
  return dir;
}

test("loads documentation panels and forms from yaml", () => {
  const dir = fixtureDir();
  try {
    const cfg = loadCountryDocConfig("zambia", dir);
    assert.equal(cfg.panels.has("VIRAL"), true);
    assert.equal(cfg.forms.get("VIRAL"), "hiv_vl_documentation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undefined country yields empty config", () => {
  const cfg = loadCountryDocConfig(undefined, fixtureDir());
  assert.equal(cfg.panels.size, 0);
});

test("missing country file falls back to empty config", () => {
  const cfg = loadCountryDocConfig("nowhere", fixtureDir());
  assert.equal(cfg.panels.size, 0);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm -C apps/cli test -- --test-name-pattern="yaml|empty config"`
Expected: FAIL — cannot find module `./country-config.js`.

- [ ] **Step 4: Write the implementation**

Create `apps/cli/src/config/country-config.ts`:
```ts
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { EMPTY_DOC_CONFIG, type DocConfig } from "../export/non-test.js";

/**
 * Resolve the repo-root `config/` directory. Mirrors config.ts's implicit-env
 * resolution: prefer cwd/config (pnpm -C apps/cli and per-deployment layouts),
 * else module-relative (apps/cli/{src,dist}/config -> repo-root/config).
 */
export function configDir(): string {
  const cwdDir = resolve(process.cwd(), "config");
  if (existsSync(cwdDir)) return cwdDir;
  // src/config/country-config.ts OR dist/config/country-config.js -> up 4 to repo root.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "config");
}

interface RawDoc {
  documentation?: {
    panels?: string[];
    params?: string[];
    forms?: Record<string, string>;
  };
}

function cleanList(xs: string[] | undefined): string[] {
  return (xs ?? []).map((s) => String(s).trim()).filter((s) => s.length > 0);
}

/**
 * Load `config/<country>.yaml` into a DocConfig. Unknown/undefined country or
 * a missing file returns EMPTY_DOC_CONFIG (heuristic-only, back-compatible).
 */
export function loadCountryDocConfig(country: string | undefined, dir: string = configDir()): DocConfig {
  if (country === undefined || country.trim().length === 0) return EMPTY_DOC_CONFIG;
  const path = resolve(dir, `${country.trim().toLowerCase()}.yaml`);
  if (!existsSync(path)) return EMPTY_DOC_CONFIG;
  const raw = parse(readFileSync(path, "utf8")) as RawDoc | null;
  const doc = raw?.documentation ?? {};
  return {
    panels: new Set(cleanList(doc.panels)),
    params: new Set(cleanList(doc.params)),
    forms: new Map(Object.entries(doc.forms ?? {})),
  };
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm -C apps/cli test -- --test-name-pattern="yaml|empty config"`
Expected: PASS — 3 tests.

- [ ] **Step 6: Commit**

```bash
git add config/zambia.yaml config/tanzania.yaml apps/cli/src/config/country-config.ts apps/cli/src/config/country-config.test.ts
git commit -m "feat: per-country documentation config loader"
```

---

## Task 5: Config wiring (`country`, forms feed name)

**Files:**
- Modify: `apps/cli/src/config.ts`

- [ ] **Step 1: Add the env schema keys**

In `apps/cli/src/config.ts`, inside `EnvSchema = z.object({ ... })`, after `OPENLDR_DATA_FEED_ID`:
```ts
  OPENLDR_FORMS_DATA_FEED_NAME: z.string().min(1).optional(),
  OPENLDR_FORMS_DATA_FEED_ID: z.string().min(1).optional(),
  OPENLDR_COUNTRY: z.string().min(1).optional(),
```

- [ ] **Step 2: Add the `LoadedConfig` fields**

In the `LoadedConfig` interface, after `openldrDataFeedId?`:
```ts
  /** Data feed name for the v2 forms (non-test) feed; resolved like the lab feed. */
  openldrFormsDataFeedName?: string;
  /** Pre-resolved forms X-DataFeed-Id (skips forms discovery if set). */
  openldrFormsDataFeedId?: string;
  /** Country key selecting config/<country>.yaml documentation classifiers. */
  country?: string;
```

- [ ] **Step 3: Add the `ConfigOverrides` fields**

In the `ConfigOverrides` interface, after `openldrDataFeedId?`:
```ts
  openldrFormsDataFeedName?: string;
  openldrFormsDataFeedId?: string;
  country?: string;
```

- [ ] **Step 4: Populate them in the returned object**

In the `return { ... }` of `loadConfig`, after `openldrDataFeedId:`:
```ts
    openldrFormsDataFeedName: overrides.openldrFormsDataFeedName ?? env.data.OPENLDR_FORMS_DATA_FEED_NAME,
    openldrFormsDataFeedId: overrides.openldrFormsDataFeedId ?? env.data.OPENLDR_FORMS_DATA_FEED_ID,
    country: overrides.country ?? env.data.OPENLDR_COUNTRY,
```

- [ ] **Step 5: Typecheck**

Run: `pnpm -C apps/cli typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/config.ts
git commit -m "feat: config keys for forms feed and country"
```

---

## Task 6: Export reusable builders from `v2-transform.ts`

**Files:**
- Modify: `apps/cli/src/export/v2-transform.ts`

- [ ] **Step 1: Export `buildFacilityConcept`**

In `apps/cli/src/export/v2-transform.ts`, change the declaration:
```ts
function buildFacilityConcept(facility: Facility | null, site: SiteConfig): V2ConceptCode | null {
```
to:
```ts
export function buildFacilityConcept(facility: Facility | null, site: SiteConfig): V2ConceptCode | null {
```

- [ ] **Step 2: Export `buildPatient`**

Change:
```ts
function buildPatient(s: SpecimenRecpt, refIso: string | null, requestId: string): V2Patient {
```
to:
```ts
export function buildPatient(s: SpecimenRecpt, refIso: string | null, requestId: string): V2Patient {
```

- [ ] **Step 3: Typecheck**

Run: `pnpm -C apps/cli typecheck`
Expected: exit 0 (export-only change; no behaviour difference).

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/export/v2-transform.ts
git commit -m "refactor: export buildPatient and buildFacilityConcept for reuse"
```

---

## Task 7: Forms transform

**Files:**
- Create: `apps/cli/src/export/forms-types.ts`, `apps/cli/src/export/forms-transform.ts`
- Test: `apps/cli/src/export/forms-transform.test.ts`

- [ ] **Step 1: Write the payload types**

Create `apps/cli/src/export/forms-types.ts`:
```ts
import type { V2ConceptCode, V2Patient } from "./types.js";

export interface FormResponse {
  concept_code: V2ConceptCode;
  value_type: "numeric" | "text" | "coded";
  numeric_value: number | null;
  text_value: string | null;
  coded_value: string | null;
  ordinal: number;
  raw_value: Record<string, unknown>;
}

export interface FormSubmission {
  external_ref: string;
  source_system: "disa";
  related_request_id: string | null;
  form_code: string | null;
  patient: V2Patient;
  facility_code: V2ConceptCode | null;
  submitted_at: string | null;
  responses: FormResponse[];
}

export interface FormSubmissionPayload {
  submission: FormSubmission;
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/cli/src/export/forms-transform.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFormResponse } from "./forms-transform.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";

test("text observation becomes a text form response", () => {
  const cb = stubCodebook({ params: { ARTRS: { description: "Viral load reason" } } });
  const r = buildFormResponse(
    { panelCode: "VIRAL", paramCode: "ARTRS", valueStr: "Routine Monitoring", value: "Routine Monitoring", type: "", rawValue: { disa_type_code: 5, raw_value: "x" } },
    1,
    cb,
    "DEFAULT_RESULT",
  );
  assert.equal(r.value_type, "text");
  assert.equal(r.text_value, "Routine Monitoring");
  assert.equal(r.numeric_value, null);
  assert.equal(r.concept_code.concept_code, "ARTRS");
  assert.equal(r.concept_code.display_name, "Viral load reason");
  assert.equal(r.ordinal, 1);
});

test("numeric observation becomes a numeric form response", () => {
  const cb = stubCodebook({ params: { ARTNO: { description: "N ART" } } });
  const r = buildFormResponse(
    { panelCode: "VIRAL", paramCode: "ARTNO", valueStr: "504", value: 504, type: String.fromCharCode(1), rawValue: {} },
    2,
    cb,
    "DEFAULT_RESULT",
  );
  assert.equal(r.value_type, "numeric");
  assert.equal(r.numeric_value, 504);
  assert.equal(r.text_value, null);
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `pnpm -C apps/cli test -- --test-name-pattern="form response"`
Expected: FAIL — cannot find module `./forms-transform.js`.

- [ ] **Step 4: Write the implementation**

Create `apps/cli/src/export/forms-transform.ts`:
```ts
import type { SpecimenRecpt } from "disalab";
import { flattenDisa, supersedePanelIterations, type DisaObs } from "../compare/result-mapping.js";
import type { Codebook } from "./codebook.js";
import type { SiteConfig } from "./site-config.js";
import { buildFacilityConcept, buildPatient } from "./v2-transform.js";
import { splitObservations, type DocConfig } from "./non-test.js";
import type { FormResponse, FormSubmissionPayload } from "./forms-types.js";

/** Classify a single DISA observation's value slot for the forms payload. */
export function buildFormResponse(
  o: Pick<DisaObs, "panelCode" | "paramCode" | "valueStr" | "value" | "type" | "rawValue">,
  ordinal: number,
  cb: Codebook,
  systemId: string,
): FormResponse {
  const c = o.type.length > 0 ? o.type.charCodeAt(0) : -1;
  const isNumeric = c === 1 || c === 2;
  const isCoded = c === 0 || c === 3 || c === 4 || c === 11 || c === 12;
  const valueType: FormResponse["value_type"] = isNumeric ? "numeric" : isCoded ? "coded" : "text";
  const desc = cb.paramEntry(o.paramCode)?.description ?? null;
  return {
    concept_code: {
      system_id: systemId,
      concept_code: o.paramCode,
      display_name: desc !== null && desc.length > 0 ? desc : null,
      concept_class: "test",
      datatype: "coded",
    },
    value_type: valueType,
    numeric_value: valueType === "numeric" && typeof o.value === "number" ? o.value : null,
    text_value: valueType === "text" ? o.valueStr : null,
    coded_value: valueType === "coded" ? o.valueStr : null,
    ordinal,
    raw_value: o.rawValue,
  };
}

export interface ToFormOpts {
  prefix: string;
  site: SiteConfig;
  codebook: Codebook;
  docConfig: DocConfig;
  /** request_id of the test leg when this is a split record; null otherwise. */
  relatedRequestId: string | null;
}

/**
 * Build a form-submission payload from a specimen's documentation observations.
 * Returns null when the specimen carries no documentation observations.
 */
export function toFormSubmission(specimen: SpecimenRecpt, opts: ToFormOpts): FormSubmissionPayload | null {
  const obs = supersedePanelIterations(flattenDisa(specimen)).kept;
  const { documentation } = splitObservations(obs, opts.codebook, opts.docConfig);
  if (documentation.length === 0) return null;

  const labNo = String(specimen.LabNumber).trim();
  const externalRef = opts.prefix + labNo;
  const facility = specimen.Facility ?? null;
  const submittedAt =
    nzIso(specimen.ReceivedInLabDateTime) ?? nzIso(specimen.CollectedDateTime) ?? nzIso(specimen.TakenDateTime);
  const patient = buildPatient(specimen, submittedAt, externalRef);

  // form_code: first documentation panel with a configured form mapping wins.
  let formCode: string | null = null;
  for (const o of documentation) {
    const mapped = opts.docConfig.forms.get(o.panelCode);
    if (mapped !== undefined) { formCode = mapped; break; }
  }

  const responses = documentation.map((o, i) =>
    buildFormResponse(o, i + 1, opts.codebook, opts.site.observation_system_id));

  return {
    submission: {
      external_ref: externalRef,
      source_system: "disa",
      related_request_id: opts.relatedRequestId,
      form_code: formCode,
      patient,
      facility_code: buildFacilityConcept(facility, opts.site),
      submitted_at: submittedAt,
      responses,
    },
  };
}

/** DISA "MM/DD/YYYY[ HH:MM[:SS]]" -> ISO-ish string; pass through otherwise. */
function nzIso(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (t.length === 0) return null;
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m === null) return t;
  const [, mm, dd, yyyy, hh, mi, ss] = m;
  return hh === undefined ? `${yyyy}-${mm}-${dd}` : `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss ?? "00"}`;
}
```

> Note: `DisaObs` field names (`panelCode`, `paramCode`, `valueStr`, `value`, `type`, `rawValue`, `panelIndex`) are used by `detector.ts` already; confirm against `compare/result-mapping.ts` when implementing and adjust the `Pick<>` if a name differs. `SiteConfig.observation_system_id` is the field `observationSystemId()` falls back to in `v2-transform.ts` — confirm the property name there.

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm -C apps/cli test -- --test-name-pattern="form response"`
Expected: PASS — 2 tests.

- [ ] **Step 6: Typecheck**

Run: `pnpm -C apps/cli typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/cli/src/export/forms-types.ts apps/cli/src/export/forms-transform.ts apps/cli/src/export/forms-transform.test.ts
git commit -m "feat: forms-transform builds form submissions from documentation observations"
```

---

## Task 8: `toV2` documentation exclusion seam

**Files:**
- Modify: `apps/cli/src/export/v2-transform.ts`
- Test: `apps/cli/src/export/v2-transform-exclude.test.ts`

- [ ] **Step 1: Add `excludeObs` to `ToV2Opts`**

In `apps/cli/src/export/v2-transform.ts`, add to the `ToV2Opts` interface:
```ts
  /** When set, observations matching this predicate are dropped before
   *  building lab_results / isolates / panel selection — used to route
   *  documentation observations to the forms feed instead. */
  excludeObs?: (o: DisaObs) => boolean;
```

- [ ] **Step 2: Apply the filter in `toV2`**

In `toV2`, change:
```ts
  const obs = supersedePanelIterations(flattenDisa(specimen)).kept;
```
to:
```ts
  const keptAll = supersedePanelIterations(flattenDisa(specimen)).kept;
  const obs = opts.excludeObs ? keptAll.filter((o) => !opts.excludeObs!(o)) : keptAll;
```

- [ ] **Step 3: Write the test**

Create `apps/cli/src/export/v2-transform-exclude.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toV2 } from "./v2-transform.js";
import { DEFAULT_SITE } from "./site-config.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";

// Minimal SpecimenRecpt-shaped fixture with two ordered panels, one
// documentation (VIRAL) and one real (HIVVL). Shape follows the disalab
// SpecimenRecpt; only fields the transform reads are populated. Build the
// OrderItems so flattenDisa yields two DisaObs (one per panel).
function specimenFixture(): any {
  return {
    LabNumber: "ZUL0800028",
    Facility: { Code: "MATUC", FacilityName: "Matero Main Urban Clinic", Region: "", District: "", PostalAddress: "", Street: "" },
    Specimen: null,
    TestOrders: ["VIRAL", "HIVVL"],
    Sex: "F",
    DobAge: "09/13/1972",
    OrderItems: [
      { PanelCode: "VIRAL", ParamCode: "ARTRS", Value: "Routine", Type: "", TestIndex: 1 },
      { PanelCode: "HIVVL", ParamCode: "HIVVC", Value: "LDL", Type: "", TestIndex: 1 },
    ],
  };
}

test("excludeObs drops documentation observations from lab_results", () => {
  const cb = stubCodebook({ panels: { VIRAL: "VIRAL", HIVVL: "HIVVL HIV Viral Load" } });
  const payload = toV2(specimenFixture(), {
    prefix: "",
    site: DEFAULT_SITE,
    codebook: cb,
    excludeObs: (o) => o.panelCode === "VIRAL",
  });
  const codes = payload.lab_results.map((r) => r.observation_code.concept_code);
  assert.equal(codes.includes("ARTRS"), false);
  assert.equal(codes.includes("HIVVC"), true);
});
```

> Note: the `OrderItems` shape above is illustrative. When implementing, build the fixture to match what `flattenDisa` actually reads (inspect `compare/result-mapping.ts` `flattenDisa`); adjust field names/types so `flattenDisa` yields two `DisaObs`. The assertion (documentation code absent, test code present) is the contract — fix the fixture, never the assertion.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm -C apps/cli test -- --test-name-pattern="excludeObs"`
Expected: PASS.

- [ ] **Step 5: Typecheck + full test run**

Run: `pnpm -C apps/cli typecheck && pnpm -C apps/cli test`
Expected: exit 0; all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/export/v2-transform.ts apps/cli/src/export/v2-transform-exclude.test.ts
git commit -m "feat: toV2 excludeObs seam to drop documentation observations"
```

---

## Task 9: Documentation-aware audit

**Files:**
- Modify: `apps/cli/src/audit/types.ts`, `apps/cli/src/audit/detector.ts`
- Test: `apps/cli/src/audit/detector-non-test.test.ts`

- [ ] **Step 1: Add the anomaly class**

In `apps/cli/src/audit/types.ts`, add to the `AnomalyClass` union:
```ts
  | "routed_as_form"
```

- [ ] **Step 2: Thread documentation flags into `AuditInputs`**

In `apps/cli/src/audit/detector.ts`, add to the `AuditInputs` interface:
```ts
  /** Panel codes classified as documentation for this deployment. Ordered
   *  panels in this set are excluded from the specimen requirement and routed
   *  to the forms feed instead. Empty by default (heuristic-only behaviour). */
  documentationPanels: ReadonlySet<string>;
```

- [ ] **Step 3: Write the failing test**

Create `apps/cli/src/audit/detector-non-test.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, type AuditInputs } from "./detector.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";

function baseInput(over: Partial<AuditInputs>): AuditInputs {
  return {
    labNumber: "ZUL0800028", requestId: "ZUL0800028",
    specimenCode: null, orderedPanels: [], observations: [],
    supersededIterations: [], dobRaw: null, takenAtRaw: null,
    collectedAtRaw: null, receivedAtRaw: null, sex: "F",
    rejected: false, rejectionReason: null,
    documentationPanels: new Set(), ...over,
  };
}

test("specimen_missing suppressed when only documentation panels are ordered", () => {
  const cb = stubCodebook({ panels: { VIRAL: "VIRAL" }, questionnaire: ["ARTRS"] });
  const input = baseInput({
    orderedPanels: ["VIRAL"],
    observations: [{ panelCode: "VIRAL", panelIndex: 1, paramCode: "ARTRS", valueStr: "x", value: "x", type: "", rawValue: {} } as any],
    documentationPanels: new Set(["VIRAL"]),
  });
  const anomalies = detectAnomalies(input, cb);
  assert.equal(anomalies.some((a) => a.class === "specimen_missing"), false);
  assert.equal(anomalies.some((a) => a.class === "routed_as_form"), true);
});

test("specimen_missing still fires when a real test panel lacks a specimen", () => {
  const cb = stubCodebook({ panels: { VIRAL: "VIRAL", HIVVL: "HIVVL HIV Viral Load" } });
  const input = baseInput({
    orderedPanels: ["VIRAL", "HIVVL"],
    observations: [{ panelCode: "HIVVL", panelIndex: 1, paramCode: "HIVVC", valueStr: "LDL", value: "LDL", type: "", rawValue: {} } as any],
    documentationPanels: new Set(["VIRAL"]),
  });
  const anomalies = detectAnomalies(input, cb);
  assert.equal(anomalies.some((a) => a.class === "specimen_missing"), true);
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `pnpm -C apps/cli test -- --test-name-pattern="specimen_missing"`
Expected: FAIL — `documentationPanels` not on `AuditInputs` / `routed_as_form` not produced.

- [ ] **Step 5: Make `detectPanelSpecimenMismatch` documentation-aware**

In `apps/cli/src/audit/detector.ts`, replace the `specimen_missing` block inside `detectPanelSpecimenMismatch` (the `if (specimenIsMissing && input.orderedPanels.length > 0) { ... }`) with:
```ts
  // Real (non-documentation) ordered panels are the ones that genuinely
  // require a specimen. Documentation panels route to the forms feed instead.
  const realPanels = input.orderedPanels.filter((p) => !input.documentationPanels.has(p));
  const docPanels = input.orderedPanels.filter((p) => input.documentationPanels.has(p));

  if (specimenIsMissing && realPanels.length > 0) {
    const firstPanel = realPanels[0]!;
    const firstPanelDesc = describePanel(cb, firstPanel);
    out.push({
      class: "specimen_missing",
      severity: "error",
      message: `Lab has ${realPanels.length} ordered test panel(s) but no specimen recorded. v2 storage will reject — fix the source data before re-attempting.`,
      panel_code: firstPanel,
      details: {
        ordered_panels: realPanels,
        first_panel_description: firstPanelDesc,
        specimen_code: input.specimenCode,
      },
    });
  }

  // Documentation panels with no specimen are expected — surface for visibility,
  // not as a defect.
  if (docPanels.length > 0) {
    out.push({
      class: "routed_as_form",
      severity: "info",
      message: `${docPanels.length} documentation panel(s) routed to the forms feed (no specimen required).`,
      panel_code: docPanels[0]!,
      details: { documentation_panels: docPanels },
    });
  }
```

- [ ] **Step 6: Make `detectEmptyRecord` documentation-aware**

In `detectEmptyRecord`, after `if (input.orderedPanels.length === 0) return [];`, add:
```ts
  // If every ordered panel is documentation, the record is a form submission,
  // not a clinically-empty lab — don't flag it as an error. (When real panels
  // remain, fall through to the existing rejected/empty logic below.)
  const realOrdered = input.orderedPanels.filter((p) => !input.documentationPanels.has(p));
  if (realOrdered.length === 0) {
    return [{
      class: "routed_as_form",
      severity: "info",
      message: `Record has ${input.orderedPanels.length} documentation panel(s) and no test observations — routed to the forms feed.`,
      details: { documentation_panels: input.orderedPanels },
    }];
  }
```

- [ ] **Step 7: Set `documentationPanels` in `auditFromSpecimen`**

`auditFromSpecimen` constructs `AuditInputs`. Add a `documentationPanels` parameter (default empty so existing callers stay green). Change the signature:
```ts
export function auditFromSpecimen(
  specimen: SpecimenRecpt,
  prefix: string,
  cb: Codebook,
  documentationPanels: ReadonlySet<string> = new Set(),
): AuditReport {
```
and add to the `input` object literal:
```ts
    documentationPanels,
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm -C apps/cli test -- --test-name-pattern="specimen_missing"`
Expected: PASS — 2 tests.

- [ ] **Step 9: Typecheck + full test run + call-site check**

Run: `grep -rn "auditFromSpecimen" apps/cli/src` then `pnpm -C apps/cli typecheck && pnpm -C apps/cli test`
Expected: exit 0. Existing callers (e.g. `audit.ts`, `compare*`) compile because the new param defaults to an empty set.

- [ ] **Step 10: Commit**

```bash
git add apps/cli/src/audit/types.ts apps/cli/src/audit/detector.ts apps/cli/src/audit/detector-non-test.test.ts
git commit -m "feat: documentation-aware audit (routed_as_form, specimen check on real panels only)"
```

---

## Task 10: Wire split routing into `export-batch`

**Files:**
- Modify: `apps/cli/src/commands/export-batch.ts`

This task threads the `DocConfig` through the run, builds + POSTs the forms payload, and reports routing. It touches the run context, `resolvePostConfig`, `processLab`, the CLI flags, and the summary.

- [ ] **Step 1: Imports, flags, and load the DocConfig once**

Add imports near the other `../export` / `../config` imports:
```ts
import { loadCountryDocConfig } from "../config/country-config.js";
import { toFormSubmission } from "../export/forms-transform.js";
import { isDocumentationObs, type DocConfig } from "../export/non-test.js";
```
Add command options (alongside `--data-feed-name`):
```ts
.option("--country <name>", "Country key selecting config/<country>.yaml documentation classifiers (overrides OPENLDR_COUNTRY)")
.option("--forms-data-feed-name <name>", "OpenLDR data feed name for the forms (non-test) feed")
```
Where the run resolves `config` + `codebook`, resolve the doc config:
```ts
const docConfig = loadCountryDocConfig(opts.country ?? config.country);
```
Add `docConfig: DocConfig` to the `ctx` object type and populate it where `ctx` is built.

- [ ] **Step 2: Resolve the forms feed id in `resolvePostConfig`**

Add `formsDataFeedId?: string` to the `PostConfig` interface. In `resolvePostConfig`, after the lab `dataFeedId` block, add:
```ts
let formsDataFeedId: string | undefined = opts.formsDataFeedId ?? config.openldrFormsDataFeedId;
if (formsDataFeedId === undefined) {
  const formsFeedName = opts.formsDataFeedName ?? config.openldrFormsDataFeedName;
  const projectName = opts.projectName ?? config.openldrProjectName;
  const useCaseName = opts.useCaseName ?? config.openldrUseCaseName;
  if (
    formsFeedName !== undefined && formsFeedName.length > 0 &&
    projectName !== undefined && projectName.length > 0 &&
    useCaseName !== undefined && useCaseName.length > 0
  ) {
    formsDataFeedId = await resolveDataFeedId({
      baseUrl, token: initialToken, projectName, useCaseName, dataFeedName: formsFeedName,
    });
  }
}
```
Include `formsDataFeedId` in the returned `PostConfig`. (No fail-fast here — a run with no documentation records legitimately needs no forms feed; guard at POST time in Step 5.)

- [ ] **Step 3: Pass `docConfig` into the audit**

Where `processLab` calls `auditFromSpecimen(specimen, ctx.prefix, ctx.codebook)`, pass the documentation panels:
```ts
const auditReport: AuditReport | null = ctx.doQuarantine
  ? auditFromSpecimen(specimen, ctx.prefix, ctx.codebook, ctx.docConfig.panels)
  : null;
```

- [ ] **Step 4: Exclude documentation observations from the lab payload**

In `processLab`, in BOTH `toV2(specimen, { ... })` calls (the quarantine-branch build and the main build), add:
```ts
excludeObs: (o) => isDocumentationObs(o, ctx.codebook, ctx.docConfig),
```

- [ ] **Step 5: Skip the empty lab POST + add the forms leg**

In `processLab`, guard the existing lab `postLabRequest` so a documentation-only record (no test observations) does not POST an empty lab payload. Wrap the lab POST block:
```ts
let post: Awaited<ReturnType<typeof postLabRequest>> | null = null;
if (payload.lab_results.length > 0 || payload.lab_request.panel_code !== null) {
  post = await postLabRequest(payload, {
    baseUrl: ctx.postConfig.baseUrl, token, path: ctx.postConfig.path, extraHeaders,
  });
  result.http_status = post.status;
}
```
(Adjust the existing `post`/`body`/track handling to be inside this `if`, since `post` may now be null.)

Then add the forms leg before building the return value:
```ts
// -------- forms (non-test) leg --------
const formPayload = toFormSubmission(specimen, {
  prefix: ctx.prefix,
  site: DEFAULT_SITE,
  codebook: ctx.codebook,
  docConfig: ctx.docConfig,
  relatedRequestId: post !== null ? norm.openldrRequestId : null,
});
if (formPayload !== null) {
  if (ctx.postConfig.formsDataFeedId === undefined) {
    result.status = "errored";
    result.error_code = "API_CONFIG_MISSING";
    result.error_message =
      'Record has documentation observations but no forms feed is configured. Set OPENLDR_FORMS_DATA_FEED_NAME (and OPENLDR_COUNTRY / config) or --forms-data-feed-name.';
    result.duration_ms = Date.now() - start;
    return result;
  }
  const formsPost = await postLabRequest(formPayload, {
    baseUrl: ctx.postConfig.baseUrl,
    token,
    path: ctx.postConfig.path,
    extraHeaders: { "X-DataFeed-Id": ctx.postConfig.formsDataFeedId },
  });
  result.forms_http_status = formsPost.status;
  result.routing = post !== null ? "split" : "form";
} else {
  result.routing = "lab";
}
```
Add `routing?: "lab" | "form" | "split"` and `forms_http_status?: number` to the per-lab `result` type.

- [ ] **Step 6: Add reporting fields to the summary**

In the `_meta: "export-batch-summary"` object, add a `forms_posted` counter (incremented when `result.forms_http_status` is 2xx) and a `split` counter (incremented when `result.routing === "split"`).

- [ ] **Step 7: Typecheck**

Run: `pnpm -C apps/cli typecheck`
Expected: exit 0. Resolve any missing `PostConfig` / `ctx` / `result` field types introduced above.

- [ ] **Step 8: Manual verification with `--emit-payloads` (no network)**

The exclusion is observable without POSTing: documentation observations should leave `lab_results`. Run a 1-record emit against a known documentation lab:
```bash
pnpm -C apps/cli dev export-batch --where "LabNo = 'ZUL0800028'" --limit 1 --country zambia --emit-payloads 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const line=s.trim().split('\n')[0];const p=JSON.parse(line);const codes=(p.lab_results||[]).map(r=>r.observation_code.concept_code);console.log('lab_results codes:',codes);console.log('ARTRS in lab leg (should be false):', codes.includes('ARTRS'));})"
```
Expected: `ARTRS in lab leg (should be false): false`.

- [ ] **Step 9: Commit**

```bash
git add apps/cli/src/commands/export-batch.ts
git commit -m "feat: export-batch splits documentation observations to the forms feed"
```

---

## Task 11: Docs + env vars

**Files:**
- Modify: env documentation (`apps/cli/.env.example` if present, else README env table)

- [ ] **Step 1: Document the new env vars**

Add:
```bash
# Country key selecting config/<country>.yaml documentation classifiers (e.g. zambia, tanzania)
OPENLDR_COUNTRY=zambia
# Data feed name for the v2 forms (non-test) feed — resolved like OPENLDR_DATA_FEED_NAME
OPENLDR_FORMS_DATA_FEED_NAME=Built-in-Forms
```

- [ ] **Step 2: Note the config convention**

Add a short README/PRD note: documentation panel/param codes live in `config/<country>.yaml` under `documentation:` and are never hardcoded (per CLAUDE.md).

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "docs: document OPENLDR_COUNTRY, forms feed, and config/<country>.yaml"
```

---

## Task 12 (opt-in): Live forms-feed smoke

**Depends on:** System A (v2 forms feed) implemented and a forms `X-DataFeed-Id` resolvable.

- [ ] **Step 1: Health + feed-resolution check**

```bash
curl -sk https://<host>/data-processing/health
```
Expected: `{"status":"ok",...}`. Confirm `OPENLDR_FORMS_DATA_FEED_NAME` resolves via `/feeds`.

- [ ] **Step 2: One-record live split**

```bash
pnpm -C apps/cli dev export-batch --where "LabNo = 'ZUL0800028'" --limit 1 --country zambia --concurrency 1 --insecure-tls --track
```
Expected: NDJSON line with `"routing":"split"` or `"form"`, `forms_http_status: 200`, no `API_REJECTED`.

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "test: live forms-feed smoke fixups"
```

---

## Self-Review

**Spec coverage:**
- Per-country config → Tasks 4, 5. Classifier → Task 3. Forms transform → Task 7. Split routing → Tasks 8, 10. Audit changes (`routed_as_form`, real-panel specimen check) → Task 9. Reporting (`routing`, `forms_posted`) → Task 10. Forms feed discovery → Task 10. Testing (`node:test`) → Tasks 1–9. Live smoke → Task 12. v2 side → out of scope (separate plan), noted in header.
- **Gap acknowledged:** `export.ts` (single-record command) split routing is NOT in this plan — `export-batch` is the migration workhorse and carries the full mechanism. Add a follow-up plan to mirror it in `export.ts` if single-record forms posting is needed.

**Placeholder scan:** No `TBD`/`TODO`. Tasks 7 and 8 carry explicit "confirm the `DisaObs`/`flattenDisa`/`SiteConfig` field names when implementing" notes — these are verification instructions, not placeholders; the contract (the assertion) is concrete.

**Type consistency:** `DocConfig` (Task 3) is consumed unchanged in Tasks 4, 7, 9, 10. `isDocumentationObs`/`splitObservations` signatures match across Tasks 7, 10. `auditFromSpecimen`'s new 4th param (Task 9) matches its call site (Task 10 Step 3). `ToV2Opts.excludeObs` (Task 8) matches the predicate passed in Task 10 Step 4. `FormSubmissionPayload` (Task 7) is what `postLabRequest` receives in Task 10 Step 5 (`postLabRequest` takes `unknown` payload — compatible). `result.routing` / `result.forms_http_status` defined once (Task 10 Step 5) and read in the summary (Task 10 Step 6).

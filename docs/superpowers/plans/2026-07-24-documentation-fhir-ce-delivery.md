# Documentation → FHIR QuestionnaireResponse delivery to CE Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop dropping documentation observations on the CE target — build them into FHIR `QuestionnaireResponse` (+ a minimal `Questionnaire`) and post them alongside the test-leg FHIR to the existing CE webhook.

**Architecture:** A pure builder `documentationResources(obs, ctx)` turns documentation observations into FHIR; a thin `toDocumentationFhir(specimen, payload, opts)` wrapper flattens the specimen, derives the same patient/root ids `toFhir` uses (from the V2 payload), and calls the pure builder. The `export-batch` CE branch concatenates test + documentation resources into the one bare array it already POSTs.

**Tech Stack:** TypeScript, Vitest, commander CLI. Spec: `docs/superpowers/specs/2026-07-24-documentation-fhir-ce-delivery-design.md`. Reference: `openldr_ce/packages/fhir` (the FHIR contract CE enforces).

## Global Constraints

- Documentation panel/param → form mappings come from the loaded `docConfig` (country YAML `documentation:` key) — **never hardcode DISA codes** in the transform.
- FHIR ids obey CE's `ID_RE` (`[A-Za-z0-9.\-]`, no underscore) — always run id strings through `fhirId`. Canonical `url`/`name` strings may keep underscores (`hiv_vl_documentation`).
- Timestamps use the deployment offset (`opts.tzOffset` = `--ce-tz`) via `fhirDateTime` — DISA is unzoned local time; never assume UTC.
- `valueString` must be non-empty (CE `fhirString` is `min(1)`) — use `fhirText`, and omit the answer when empty.
- The transform is **pure / no I/O**, like the sibling `fhir-transform.ts`.
- Commit after each task. No `Co-Authored-By` trailer.

---

### Task 1: `documentationResources` (pure builder) + `toDocumentationFhir` wrapper

**Files:**
- Create: `apps/cli/src/export/fhir-documentation-transform.ts`
- Test: `apps/cli/src/export/fhir-documentation-transform.test.ts`

**Interfaces:**
- Consumes: `fhirId`, `fhirDateTime`, `fhirText` from `./fhir-primitives.js`; `isNumericTypeChar` from `./v2-transform.js`; `splitObservations`, `type DocConfig` from `./non-test.js`; `flattenDisa`, `supersedePanelIterations` from `../compare/result-mapping.js`; `type Codebook` from `./codebook.js`; `type V2Payload` from `./types.js`; `type SpecimenRecpt` from `disalab`.
- Produces:
  - `documentationResources(obs: DocObs[], ctx: DocResourceCtx): FhirResource[]`
  - `toDocumentationFhir(specimen: SpecimenRecpt, payload: V2Payload, opts: ToDocOpts): FhirResource[]`
  - Types: `DocObs = { panelCode: string; paramCode: string; valueStr: string; value: string | number; type: string }`; `DocResourceCtx = { patientRef: string; basedOnRef: string | null; authored: string | undefined; docConfig: DocConfig; codebook: Pick<Codebook, 'paramEntry'> }`; `ToDocOpts = { prefix: string; codebook: Codebook; docConfig: DocConfig; tzOffset: string }`.

- [ ] **Step 1: Write the failing test**

Create `apps/cli/src/export/fhir-documentation-transform.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { documentationResources } from "./fhir-documentation-transform.js";

const docConfig = {
  panels: new Set(["VLID"]),
  params: new Set<string>(),
  forms: new Map([["VLID", "hiv_vl_documentation"]]),
};
const codebook = { paramEntry: (code: string) => ({ description: `desc-${code}` }) };

const baseCtx = {
  patientRef: "Patient/req1",
  basedOnRef: "ServiceRequest/req1-obr1",
  authored: "2026-01-01T00:00:00+02:00",
  docConfig,
  codebook,
};

describe("documentationResources", () => {
  it("builds a Questionnaire + QuestionnaireResponse for one documentation form", () => {
    const obs = [
      { panelCode: "VLID", paramCode: "VL_REASON", valueStr: "Routine", value: "Routine", type: "T" },
      { panelCode: "VLID", paramCode: "VL_COUNT", valueStr: "40", value: 40, type: "N" },
    ];
    const out = documentationResources(obs, baseCtx);

    const q = out.find((r) => r.resourceType === "Questionnaire") as Record<string, unknown>;
    expect(q).toMatchObject({ url: "urn:openldr:form:hiv_vl_documentation", name: "hiv_vl_documentation", status: "active" });

    const qr = out.find((r) => r.resourceType === "QuestionnaireResponse") as Record<string, unknown>;
    expect(qr).toMatchObject({
      status: "completed",
      questionnaire: "urn:openldr:form:hiv_vl_documentation",
      subject: { reference: "Patient/req1" },
      authored: "2026-01-01T00:00:00+02:00",
      basedOn: [{ reference: "ServiceRequest/req1-obr1" }],
    });
    const items = qr.item as { linkId: string; answer?: { valueString?: string; valueDecimal?: number }[] }[];
    expect(items.map((i) => i.linkId)).toEqual(["VL_REASON", "VL_COUNT"]);
    expect(items[0].answer).toEqual([{ valueString: "Routine" }]);
    expect(items[1].answer).toEqual([{ valueDecimal: 40 }]);
  });

  it("omits basedOn for documentation-only records (null basedOnRef)", () => {
    const out = documentationResources(
      [{ panelCode: "VLID", paramCode: "VL_REASON", valueStr: "Routine", value: "Routine", type: "T" }],
      { ...baseCtx, basedOnRef: null },
    );
    const qr = out.find((r) => r.resourceType === "QuestionnaireResponse") as Record<string, unknown>;
    expect(qr.basedOn).toBeUndefined();
  });

  it("returns [] when there are no observations", () => {
    expect(documentationResources([], baseCtx)).toEqual([]);
  });

  it("emits one Questionnaire per distinct form_code, deduped", () => {
    const cfg = {
      panels: new Set(["VLID", "ARTID"]),
      params: new Set<string>(),
      forms: new Map([["VLID", "hiv_vl_documentation"], ["ARTID", "hiv_art_documentation"]]),
    };
    const obs = [
      { panelCode: "VLID", paramCode: "A", valueStr: "x", value: "x", type: "T" },
      { panelCode: "VLID", paramCode: "B", valueStr: "y", value: "y", type: "T" },
      { panelCode: "ARTID", paramCode: "C", valueStr: "z", value: "z", type: "T" },
    ];
    const out = documentationResources(obs, { ...baseCtx, docConfig: cfg });
    const questionnaires = out.filter((r) => r.resourceType === "Questionnaire");
    const responses = out.filter((r) => r.resourceType === "QuestionnaireResponse");
    expect(questionnaires).toHaveLength(2);
    expect(responses).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @cdr/cli test fhir-documentation-transform` (use the repo's actual CLI package name — check `apps/cli/package.json`; the filter below in later steps must match).
Expected: FAIL (module not found).

- [ ] **Step 3: Write the implementation**

Create `apps/cli/src/export/fhir-documentation-transform.ts`:

```ts
import type { SpecimenRecpt } from "disalab";
import { flattenDisa, supersedePanelIterations } from "../compare/result-mapping.js";
import { splitObservations, type DocConfig } from "./non-test.js";
import { isNumericTypeChar } from "./v2-transform.js";
import { fhirId, fhirDateTime, fhirText } from "./fhir-primitives.js";
import type { Codebook } from "./codebook.js";
import type { V2Payload } from "./types.js";

export type FhirResource = Record<string, unknown>;

export interface DocObs {
  panelCode: string;
  paramCode: string;
  valueStr: string;
  value: string | number;
  type: string;
}

export interface DocResourceCtx {
  patientRef: string;
  /** ServiceRequest reference id for split records; null for documentation-only. */
  basedOnRef: string | null;
  /** FHIR-ready authored timestamp (already tz-stamped), or undefined to omit. */
  authored: string | undefined;
  docConfig: DocConfig;
  codebook: Pick<Codebook, "paramEntry">;
}

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** Map a documentation obs value to a single QuestionnaireResponse answer, or null. */
function answerFor(o: DocObs): Record<string, unknown> | null {
  if (isNumericTypeChar(o.type) && typeof o.value === "number") return { valueDecimal: o.value };
  const s = fhirText(o.valueStr);
  return s !== undefined ? { valueString: s } : null;
}

/** Pure: documentation observations -> [Questionnaire..., QuestionnaireResponse...]. */
export function documentationResources(obs: DocObs[], ctx: DocResourceCtx): FhirResource[] {
  if (obs.length === 0) return [];

  // form_code: configured mapping wins, else fall back to the panel code so
  // nothing is silently lost.
  const formCodeOf = (panelCode: string): string => ctx.docConfig.forms.get(panelCode) ?? panelCode;

  // Group obs by form_code, preserving order.
  const groups = new Map<string, DocObs[]>();
  for (const o of obs) {
    const fc = formCodeOf(o.panelCode);
    const list = groups.get(fc) ?? [];
    list.push(o);
    groups.set(fc, list);
  }

  const questionnaires: FhirResource[] = [];
  const responses: FhirResource[] = [];

  for (const [formCode, groupObs] of groups) {
    questionnaires.push(compact({
      resourceType: "Questionnaire",
      id: fhirId(formCode),                         // underscores -> hyphens
      url: `urn:openldr:form:${formCode}`,          // canonical keeps underscores
      name: formCode,
      status: "active",                             // CE-required
    }));

    const item = groupObs
      .filter((o) => fhirText(o.paramCode) !== undefined)
      .map((o) => {
        const ans = answerFor(o);
        const desc = ctx.codebook.paramEntry(o.paramCode)?.description ?? null;
        return compact({
          linkId: o.paramCode,
          text: fhirText(desc),
          answer: ans !== null ? [ans] : undefined,
        });
      });

    responses.push(compact({
      resourceType: "QuestionnaireResponse",
      id: fhirId(`${ctx.patientRef.split("/")[1]}-${formCode}`),
      status: "completed",                          // CE-required
      questionnaire: `urn:openldr:form:${formCode}`,
      subject: { reference: ctx.patientRef },
      authored: ctx.authored,
      basedOn: ctx.basedOnRef !== null ? [{ reference: ctx.basedOnRef }] : undefined,
      item,
    }));
  }

  return [...questionnaires, ...responses];
}

export interface ToDocOpts {
  prefix: string;
  codebook: Codebook;
  docConfig: DocConfig;
  tzOffset: string;
}

/**
 * Thin wrapper: extract documentation obs from the specimen, derive the same
 * patient/root ids `toFhir` derives from the payload (so both legs point at one
 * patient in CE), and build the FHIR. Returns [] when the specimen carries no
 * documentation observations.
 */
export function toDocumentationFhir(specimen: SpecimenRecpt, payload: V2Payload, opts: ToDocOpts): FhirResource[] {
  const first = payload.lab_requests[0];
  if (first === undefined) return []; // no order graph -> nothing to attach to

  const rootId = fhirId(first.request_id);
  if (rootId === undefined) return [];
  // toFhir: patientId = fhirId(patient_guid) ?? rootId (patient_guid = request_id).
  const patientId = fhirId(payload.patient.patient_guid) ?? rootId;
  const patientRef = `Patient/${patientId}`;
  // Link documentation to the specimen's first ordered panel (its ServiceRequest).
  const basedOnRef = `ServiceRequest/${rootId}-obr${first.obr_set_id}`;
  // Reuse the normalized order timestamps the payload already carries.
  const authored = fhirDateTime(first.received_at ?? first.collected_datetime ?? first.taken_datetime, opts.tzOffset);

  const allObs = supersedePanelIterations(flattenDisa(specimen)).kept as DocObs[];
  const { documentation } = splitObservations(allObs, opts.codebook, opts.docConfig);
  if (documentation.length === 0) return [];

  return documentationResources(documentation, {
    patientRef,
    basedOnRef,
    authored,
    docConfig: opts.docConfig,
    codebook: opts.codebook,
  });
}
```

> Note: this firms up the spec's `toDocumentationFhir(specimen, opts)` to `(specimen, payload, opts)` — the payload is needed to derive the exact patient/root ids `toFhir` uses so both legs share one Patient. Confirm `V2LabRequest` exposes `received_at` / `collected_datetime` / `taken_datetime` and `obr_set_id` (it does per `fhir-transform.ts:167,181,220`); adjust field names if the compiler disagrees.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter <cli-pkg> test fhir-documentation-transform`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter <cli-pkg> typecheck` (or the repo's typecheck script)
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/export/fhir-documentation-transform.ts apps/cli/src/export/fhir-documentation-transform.test.ts
git commit -m "feat(export): build documentation obs into FHIR QuestionnaireResponse"
```

---

### Task 2: Wire documentation into the `export-batch` CE branch

**Files:**
- Modify: `apps/cli/src/commands/export-batch.ts` (the `ctx.ceConfig !== undefined` branch, ~lines 583-600; add import)
- Test: `apps/cli/src/api/ce-client.test.ts` OR a new `apps/cli/src/commands/export-batch.ce.test.ts` — assert the posted array carries both legs (reuse the fetch-stub harness the ce-client tests already use).

**Interfaces:**
- Consumes: `toDocumentationFhir` (Task 1); the in-scope `specimen` (same var the `toV2(...)` call builds `payload` from) and `payload`; `ctx.prefix`, `ctx.codebook`, `ctx.docConfig`, `ctx.ceConfig`.
- Produces: the CE branch posts `[...testResources, ...documentationResources]`; sets `result.routing` to `"split"` / `"form"` / `"lab"`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/cli/src/commands/export-batch.ce.test.ts` (adapt setup from `apps/cli/src/api/ce-client.test.ts`'s fetch-stub pattern):

```ts
import { describe, it, expect, vi } from "vitest";
import { postFhirResources } from "../api/ce-client.js";

// This asserts the CONTRACT the CE branch relies on: postFhirResources sends
// exactly the array it is given, so an integration test that stubs fetch can
// inspect the posted body. The branch wiring is exercised by asserting the
// concatenation in a focused unit around the resource assembly. If export-batch
// exposes no seam, factor the "build CE resources" step into a small exported
// helper `buildCeResources(specimen, payload, ceConfig, ctx)` and test THAT.

it("posts the exact array it is handed (bare FHIR array contract)", async () => {
  const seen: unknown[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: { body?: string }) => {
    seen.push(JSON.parse(init.body ?? "[]"));
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;

  const resources = [{ resourceType: "Patient", id: "p1" }, { resourceType: "QuestionnaireResponse", id: "qr1", status: "completed" }];
  await postFhirResources(resources, { baseUrl: "https://ce", path: "/hooks/x", token: "t", fetchImpl });
  expect(seen[0]).toEqual(resources);
});
```

Then, if `export-batch` has no test seam for the branch, extract a pure helper in Task 2 Step 3 and unit-test the concatenation directly:

```ts
// buildCeResources returns [...toFhir(payload), ...toDocumentationFhir(specimen, payload, opts)]
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter <cli-pkg> test export-batch.ce`
Expected: FAIL (helper not exported) — or PASS on the contract test but no coverage of the branch yet; proceed to wire the branch.

- [ ] **Step 3: Extract a `buildCeResources` helper and use it in the CE branch**

In `apps/cli/src/commands/export-batch.ts`, add the import near the other `./export/*` imports:

```ts
import { toDocumentationFhir } from "../export/fhir-documentation-transform.js";
```

Add a small exported helper (above `processOneLab`) so the assembly is unit-testable:

```ts
export function buildCeResources(
  specimen: import("disalab").SpecimenRecpt,
  payload: import("../export/types.js").V2Payload,
  opts: { prefix: string; codebook: Codebook; docConfig: DocConfig; tzOffset: string },
): Record<string, unknown>[] {
  const test = toFhir(payload, { tzOffset: opts.tzOffset });
  const documentation = toDocumentationFhir(specimen, payload, opts);
  return [...test, ...documentation];
}
```

Replace the CE branch body (currently `const resources = toFhir(payload, { tzOffset: ctx.ceConfig.tzOffset }); const post = await postFhirResources(...)`) with:

```ts
    if (ctx.ceConfig !== undefined) {
      const documentation = toDocumentationFhir(specimen, payload, {
        prefix: ctx.prefix, codebook: ctx.codebook, docConfig: ctx.docConfig, tzOffset: ctx.ceConfig.tzOffset,
      });
      const resources = [...toFhir(payload, { tzOffset: ctx.ceConfig.tzOffset }), ...documentation];
      const post = await postFhirResources(resources, {
        baseUrl: ctx.ceConfig.baseUrl, path: ctx.ceConfig.path, token: ctx.ceConfig.token,
      });
      result.http_status = post.status;
      result.status = "posted";
      result.routing = documentation.length > 0 ? (payload.lab_results.length > 0 ? "split" : "form") : "lab";
      result.duration_ms = Date.now() - start;
      return result;
    }
```

(`specimen` here is the same fetched `SpecimenRecpt` already used to build `payload`; confirm the local variable name in `processOneLab` and match it.)

- [ ] **Step 4: Add a focused test for `buildCeResources`**

Append to `apps/cli/src/commands/export-batch.ce.test.ts` a test that builds a minimal `payload` (one lab_request, one documentation-eligible obs via a specimen stub or a hand-rolled `documentationResources` comparison) and asserts the array contains both a `ServiceRequest` (from `toFhir`) and a `QuestionnaireResponse` (from the documentation leg). If a full `SpecimenRecpt` stub is heavy, assert instead that `buildCeResources` with a documentation-free specimen returns exactly `toFhir(payload)` (length + no QuestionnaireResponse), which pins the "test-only path unchanged" guarantee.

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter <cli-pkg> test export-batch && pnpm --filter <cli-pkg> typecheck`
Expected: PASS / no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/export-batch.ts apps/cli/src/commands/export-batch.ce.test.ts
git commit -m "feat(export-batch): deliver documentation FHIR to CE alongside the test leg"
```

---

### Task 3: Manual end-to-end acceptance (documented, not automated)

**Files:** none (runbook; also add to `CDR_TOOLCHAIN.md` if the repo documents CE runs there).

- [ ] **Step 1: Dry-run confirms documentation is now present**

```bash
OPENLDR_COUNTRY=tanzania openldr export-batch <lab-with-VLID> \
  --ce-url http://localhost:8080 --ce-token <webhook-token> --ce-tz +02:00 --emit-payloads
```
Expected: the emitted payload array contains a `QuestionnaireResponse` (`questionnaire: urn:openldr:form:hiv_vl_documentation`) — previously absent.

- [ ] **Step 2: Live post against a local CE** (ingest webhook enabled; strictness `high`)

```bash
OPENLDR_COUNTRY=tanzania openldr export-batch <lab-with-VLID> \
  --ce-url http://localhost:8080 --ce-token <webhook-token> --ce-tz +02:00
```
Expected: HTTP 200; in CE the `QuestionnaireResponse` is in the canonical `fhir` store and (with the CE-side plan shipped) in `questionnaire_responses`; the test observations are in `lab_results`. This reproduces-then-fixes the field scenario where documentation-heavy batches "failed."

---

## Self-Review

- **Spec coverage:** `toDocumentationFhir` transform (Task 1) ✓; per-`form_code` QR + deduped Questionnaire, dynamic `item[]`, `basedOn` linking, value-type mapping (Task 1 tests) ✓; CE-branch concatenation + documentation-only handling + `routing` (Task 2) ✓; `OPENLDR_COUNTRY`/`--ce-tz` reuse, no forms-feed env (Task 2 wiring uses only `ceConfig` + `docConfig`) ✓; end-to-end acceptance (Task 3) ✓.
- **Placeholder scan:** `<cli-pkg>` is a real value to read from `apps/cli/package.json` at execution — flagged explicitly, not a silent TODO. Test seams that depend on repo specifics (fetch-stub harness, SpecimenRecpt stubbing) point at the exact existing test to copy.
- **Type consistency:** `documentationResources` / `toDocumentationFhir` / `buildCeResources` signatures and the `DocObs`/`DocResourceCtx`/`ToDocOpts` types are consistent across Tasks 1–2; `urn:openldr:form:<form_code>` canonical matches the CE projector's `form_code` extraction in the companion plan.
- **Cross-repo note:** the CE-side `questionnaire_responses` projection is a separate plan (`openldr_ce/docs/superpowers/plans/2026-07-24-documentation-questionnaireresponse-ce-projection.md`); Task 3's read-model assertion depends on it, but Tasks 1–2 (and canonical-store landing) do not.

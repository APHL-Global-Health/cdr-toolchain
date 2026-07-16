# Corroboration-gated `panel_specimen_mismatch` + in-band specimen-anomaly namespace

**Date:** 2026-06-12
**Status:** Approved (design), pending implementation
**Spans two repos:** `cdr-toolchain` (migration tool) and `openldr-v2` (one-time seed)
**Motivating record:** `ZUL0800023` (Zambia, UTH) — quarantined as legit data.

---

## 1. Problem

DISA records exactly **one specimen per request** (reception field), but a single
order can mix specimen types. `ZUL0800023` orders blood panels (FBCP, DIFF, LFT,
UECA) **and** CSF panels (CSFM, CSFCU, CSFCH, plus CRAG/CRINK) under one specimen,
`Blood`. The audit's `detectPanelSpecimenMismatch` reads each panel description
(`CSF: MICROSCOPY` → kind `csf`), finds it incompatible with `blood`, and raises
`panel_specimen_mismatch` at **error** severity → the whole record quarantines.

The record is **legitimate**: the CSF panels carry real CSF observations
(`Fluid: Clear colourless fluid`, CSF Glucose/Protein/Chloride). The CSF tests
genuinely ran on CSF; DISA simply could not record a second specimen, so the whole
request inherited `Blood`. OpenLDR v1 has carried this exact record, mislabelled the
same way, for 10+ years.

### The hard constraint (decided)

**No fabrication.** The specimen for the CSF tests was never recorded in any
reachable structured field, so we **cannot** assert `CSF` on those results — the
panel *name* is not the *specimen*. We confirmed the only reachable specimen sources:

- `REGDAT4` / `SpecimenRecpt.Specimen` → one coded value (`Blood`) + free-text
  `SpecimenText`/`SpecimenInfo`.
- `TESTDICT` (test definition) as decoded by `disalab` exposes `PARAMETERS` but **no
  required-specimen field** (the "up-to-5 required specimens" lives, if anywhere, in
  the unparsed TESTDICT blob region ~offset 105–205; unverified, and per operators
  frequently blank/contradictory). Out of scope here.

So `Blood` is the only recorded specimen. The design preserves it untouched and
never invents another.

---

## 2. Decision

Two coordinated changes:

1. **Corroboration gate (cdr-toolchain):** a `panel_specimen_mismatch` becomes a
   **`warn`** (record migrates) when the mismatched panel actually produced resulted
   observations; it stays **`error`** (quarantine) when it did not. The specimen is
   never altered — `Blood` migrates as `Blood`.

2. **In-band specimen-anomaly namespace (both repos):** when a corroborated
   (warn-level) mismatch fired, the migrated `specimen_code` carries
   `system_id: "DEFAULT_SPEC_ANOMALY"` instead of `"DEFAULT_SPEC"`; `concept_code`
   (`B`) and `display_name` (`Blood`) are unchanged. This makes the
   "recorded specimen may not apply to all panels" condition **visible and queryable
   inside v2**, rather than living only in the migration logs.

### Why a separate `system_id` (and not a flag on the concept)

v2 deduplicates concepts globally by `(system_id, concept_code)`. A flag/property on
the shared `(DEFAULT_SPEC, B)` concept would taint **every** blood record, because the
concept row is global, not per-message. A separate coding system creates a **distinct**
`(DEFAULT_SPEC_ANOMALY, B)` concept that only anomalous records point at — which is
exactly what makes them isolatable.

---

## 3. How v2 behaves (verified in openldr-v2 source)

- **Coding system must pre-exist.** `validation.ts` → `assertCodingSystemsExist()`
  throws `UNKNOWN_CODING_SYSTEM` (`retryable: false`, hard reject) for any
  `system_id` absent from the `coding_systems` table. ⇒ We **must register
  `DEFAULT_SPEC_ANOMALY` before migrating**, or every tagged record bounces.
- **Concepts auto-create.** `terminology.service.ts` → `resolveOrCreateConceptRef()`
  looks up `(system_id, concept_code)` and, if absent, **inserts** it from the
  `display_name` we send. ⇒ We do **not** seed specimen concepts; v2 vivifies
  `Blood` under the new namespace on first sight.
- **Seed location:** `apps/openldr-internal-database/migrations/02-openldr_external.sql`
  (~line 785; mirrored in `97-…whonet_reference.sql`) — a flat
  `INSERT INTO coding_systems (system_code, system_name, system_uri, system_type, owner) VALUES …`.
  An already-running DB can also use the entity-services `createCodingSystem` API.

---

## 4. Changes

### 4.1 openldr-v2 (one-time, MUST precede any tagged migration)

Add one `coding_systems` row to the seed (and/or insert into the live external DB):

```sql
('DEFAULT_SPEC_ANOMALY',
 'Anomalous Specimen Codes (recorded specimen may not apply to all ordered panels)',
 NULL, 'external', NULL)
```

### 4.2 cdr-toolchain

- **`apps/cli/src/export/site-config.ts`** — add field:
  `specimen_anomaly_system_id: string;` to `SiteConfig`, default
  `"DEFAULT_SPEC_ANOMALY"` in `DEFAULT_SITE`.

- **`apps/cli/src/audit/detector.ts`** (`detectPanelSpecimenMismatch`) — the gate.
  Build a set of panel codes present in `input.observations`. In the
  `!kindsCompatible(...)` branch:
  - `corroborated = resultedPanels.has(panelCode)`
  - `severity: corroborated ? "warn" : "error"`
  - reworded `message` for the corroborated case (states observation count + DISA
    single-specimen limitation + "migrating with the recorded specimen")
  - `details` gains `corroborated: boolean` and `observation_count: number`.

- **`apps/cli/src/export/v2-transform.ts`** — derive the signal from the audit report
  already passed in `ToV2Opts.auditReport`:
  ```ts
  function hasCorroboratedSpecimenMismatch(r?: AuditReport | null): boolean {
    return !!r && r.anomalies.some(
      (a) => a.class === "panel_specimen_mismatch" && a.severity === "warn");
  }
  ```
  In `toV2`, compute the boolean and pass it to `buildLabRequest`; the specimen block
  uses `specimenAnomalous ? site.specimen_anomaly_system_id : site.specimen_system_id`.
  `concept_code` / `display_name` unchanged.

- **`apps/cli/src/audit/report-types.ts`** — `CLASS_DESCRIPTIONS.panel_specimen_mismatch`:
  set the static `severity` to `warn` (the expected, migrating outcome) and update
  `rule` to describe the conditional error fallback (uncorroborated → error → quarantine).

### 4.3 Trigger discriminator

The specimen tag keys on a **warn-level** `panel_specimen_mismatch` in the audit
report — i.e. the corroborated, migrating case. Uncorroborated (error) mismatches
quarantine and never reach the emit path, so they are never tagged.

---

## 5. Sequencing (strict)

1. **First:** seed `DEFAULT_SPEC_ANOMALY` in v2 (§4.1). Until this lands, a tagged
   record hard-rejects with `UNKNOWN_CODING_SYSTEM`.
2. **Then:** ship the cdr-toolchain changes (§4.2) and run the migration.

A migration run that emits the anomaly namespace against a v2 that hasn't been seeded
is a guaranteed batch failure — call this out in the run checklist.

---

## 6. Expected result for `ZUL0800023`

- All three CSF mismatches (CSFM/CSFCU/CSFCH) have observations → demote to `warn`.
- Remaining anomalies are `info` (orphan CRINK, routed_as_form). `max_severity` → `warn`.
- At the default `error` quarantine threshold the record **migrates** instead of
  quarantining.
- v2 resolves the specimen to **Blood** (auto-created `(DEFAULT_SPEC_ANOMALY, B)`),
  and the record is queryable as a multi-specimen-collision case.

---

## 7. Accepted cost / known limitation

- **Two "Blood" concept rows.** `(DEFAULT_SPEC, B)` and `(DEFAULT_SPEC_ANOMALY, B)`
  are distinct concept ids, both displaying `Blood`. Analytics grouping by
  `concept_id` see two Blood buckets; grouping by `display_name` see one. This split
  *is* the queryability mechanism — accepted deliberately.
- **Request-level coarseness.** The specimen is one request-level block, but the
  defect is per-panel (FBCP/LFT/UECA are correctly Blood). Tagging the request
  specimen taints the whole request. Defensible: the request's single specimen
  genuinely does not represent all its panels, and request-level is the finest signal
  v2's model carries.

---

## 8. Out of scope

- Decoding the TESTDICT required-specimen bytes (the only path to a *correct*
  per-panel specimen) — separate research spike; often blank/contradictory.
- Any v2 schema change. We only add terminology data (one coding-system row).
- Splitting one DISA request into multiple v2 requests.
- Per-result specimen on `lab_results` (v2 model has none).

---

## 9. Testing

- **detector** (`detector-non-test.test.ts` style, `node:test` + `assert/strict`,
  `baseInput` + `stubCodebook`):
  - corroborated mismatch (panel has observations) → `warn`, `details.corroborated === true`.
  - uncorroborated mismatch (mismatched panel, no observations) → `error`.
  - `ZUL0800023`-shaped fixture (blood specimen + CSF panels with CSF obs) → three
    `warn` mismatches, `max_severity` not `error`.
- **transform** (v2-transform tests): given an audit report with a warn-level
  `panel_specimen_mismatch`, `specimen_code.system_id === "DEFAULT_SPEC_ANOMALY"` while
  `concept_code`/`display_name` are unchanged; without it, `system_id` stays
  `"DEFAULT_SPEC"`.

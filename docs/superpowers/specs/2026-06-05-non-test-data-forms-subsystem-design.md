# Non-test (documentation) data — generic forms subsystem

**Date:** 2026-06-05
**Status:** Approved design, pre-implementation
**Scope:** Both OpenLDR v2 (data model + API contract) and cdr-toolchain (CLI)

## Problem

DISA carries lab requests whose ordered panels are **documentation/questionnaire
workflows**, not instrument tests — they legitimately have **no specimen**.
Examples: Zambia `VIRAL` (ARV reason `ARTRS`, ART number `ARTNO`); Tanzania
`VLID`, `EIDID`. Today these quarantine en masse on the `specimen_missing`
audit (severity `error`), because that check fires for any lab with ≥1 ordered
panel and a null specimen. v2 storage also mandates `specimen_concept_id`, so
even if the audit were relaxed the POST would be rejected.

The records are genuinely non-test, but classification **varies per record**:
some documentation labs sit alongside what looks like a real result
(`ZUL0800028` orders `VIRAL` + `HIVVL`, where `HIVVL` → `HIVVC` = "Target Not
Detected"). The operator cannot always say up front whether such a co-occurring
result is a real instrument value or data-entered documentation. The mechanism
must therefore classify per record and **surface** ambiguous cases rather than
silently assume.

## Goal

Make non-test/documentation data **first-class in OpenLDR v2** via a generic
forms subsystem, and route DISA documentation observations into it during
migration — without weakening the test-data model or losing real results.

## Non-goals

- Authoring a bespoke form definition for every legacy DISA questionnaire
  before its data can migrate (schemaless-first; definitions optional).
- Changing the existing `lab_request` / test-results model or its invariants.
- Building UI for forms. (Storage + ingest contract only.)

## Key decisions (from brainstorming)

1. **End state:** non-test data is first-class in v2 (not skipped, not a
   relaxed lab_request).
2. **v2 representation:** generic **forms subsystem** (Approach 3), reusing the
   data-processing service's existing `X-DataFeed-Id` → schema/mapper/storage/
   outpost plugin architecture via a **new forms data-feed**.
3. **Form definitions:** **schemaless-first** — submissions carry concept-tagged
   responses; `form_id`/definitions optional and backfillable.
4. **Classification:** observation-level tag → record-level routing.
5. **Mixed records:** **split** — documentation always emitted as a form;
   test observations still emitted as a `lab_request` when present, linked.

---

## System A — OpenLDR v2 generic forms subsystem

A new **forms data-feed** with its own `X-DataFeed-Id` and its own
schema → mapper → storage → outpost plugin chain. No new endpoint; the CLI
POSTs to the same `process-feed` with the forms feed id.

### Storage model

- **`form_submissions`**
  - `submission_id` (PK)
  - `patient_id`, `facility_id`
  - `source_system` (e.g. `disa`)
  - `external_ref` — origin id (DISA lab number, e.g. `ZUL0800028`)
  - `submitted_at`
  - `related_request_id` — nullable FK to `lab_request`; set on split records
  - `form_id` — nullable FK to `form_definitions`
  - `metadata` — JSON (free-form provenance)
- **`form_responses`**
  - `response_id` (PK), `submission_id` (FK)
  - `concept_id` — resolves via existing dictionary (`system_id` + `concept_code`,
    e.g. `DEFAULT_RESULT` / `ARTRS`)
  - `value_type` (`numeric` | `text` | `coded`)
  - `value_numeric` / `value_text` / `value_coded`
  - `ordinal`, `raw_value`
- **`form_definitions`** *(optional)* — `form_id`, `code`, `name`, `version`
- **`form_fields`** *(optional)* — `field_id`, `form_id`, `concept_id`,
  `datatype`, `ordinal` (for validation / UI later)

### Plugin chain (forms feed)

- **schema:** validates the form-submission payload shape (below). Concept
  resolution is best-effort: unresolved concepts are accepted and stored with
  `raw_value`, not rejected.
- **mapper:** resolves `system_id`/`concept_code` → `concept_id`; resolves
  patient/facility; classifies `value_type`.
- **storage:** writes `form_submissions` + `form_responses`. **No specimen
  required.**
- **outpost:** existing downstream behaviour, forms-aware.

### API contract — form-submission payload

```jsonc
{
  "submission": {
    "external_ref": "ZUL0800028",
    "source_system": "disa",
    "related_request_id": "ZUL0800028",   // null when not a split record
    "form_code": "hiv_vl_documentation",  // null when schemaless
    "patient": { /* same patient shape as lab payload */ },
    "facility_code": { "system_id": "DEFAULT_FAC", "concept_code": "MATUC", "...": "..." },
    "submitted_at": "2019-01-25T09:49:00",
    "responses": [
      {
        "concept_code": { "system_id": "DEFAULT_RESULT", "concept_code": "ARTRS",
                          "display_name": "Viral load reason", "...": "..." },
        "value_type": "text",
        "text_value": "Routine Monitoring 18|15:15:50|02/12/2018|11:00",
        "ordinal": 1,
        "raw_value": { "disa_type_code": 5, "raw_value": "" }
      }
    ]
  }
}
```

The patient / facility / concept-code sub-shapes are **identical** to the
existing lab payload so the CLI reuses its concept-shaping code.

### v2 tests (owned in the OpenLDR v2 repo — dependency, not built here)

Storage plugin writes, schema validation (incl. unresolved-concept tolerance),
feed routing by `X-DataFeed-Id`, split-record `related_request_id` linkage.

---

## System B — cdr-toolchain (CLI)

### 1. Per-country config (`config/<country>.yaml`)

Honors CLAUDE.md ("never hardcode codes"). Layered on top of the existing
`isQuestionnaireParam` context heuristic.

```yaml
# config/zambia.yaml
documentation:
  panels:  [VIRAL]      # whole panel is documentation
  params:  []           # optional individual param codes
  forms:                # optional panel -> logical form code
    VIRAL: hiv_vl_documentation
```

- Tanzania config lists `VLID`, `EIDID`.
- Loaded once per run. Absent/unknown country → heuristic-only (back-compatible).
- Selection of which country file to load: explicit flag/env (e.g.
  `--country zambia` / `OPENLDR_COUNTRY`), resolved during planning.

### 2. Classifier (new module, e.g. `src/export/non-test.ts`)

- Tag each observation `test | documentation`:
  `documentation = isQuestionnaireParam(param) OR param∈config.params OR
  panel∈config.panels`.
- Record rollup: count `test` observations.
  - `0 test` → **non-test record**
  - `≥1 test` → **has test component**

### 3. Routing — split

For every record:
- Documentation observations (if any) → **forms transform** → forms feed.
- Test observations (if any) → existing `lab_request` transform → lab feed.
- On a split record, set `related_request_id`/`external_ref` to join them.
- Nothing is dropped. A real test with no specimen still follows the lab path
  and still surfaces `specimen_missing` (the genuine gap). The `HIVVL`
  ambiguity is resolved by config: moving `HIVVC` into `documentation` makes
  the record 0-test → flows entirely as a form.

### 4. Forms transform (`src/export/forms-transform.ts`)

Builds the form-submission payload from documentation observations, reusing the
concept-code shaping in `v2-transform.ts` (patient, facility, concept codes,
`external_ref`, optional `related_request_id`, `form_code` from config).

### 5. Feed discovery / config

- Forms feed needs its own id: `OPENLDR_FORMS_DATA_FEED_NAME` (+ project/use-case
  reuse), resolved through existing `feed-discovery.ts`.
- The fail-fast missing-`X-DataFeed-Id` guard (added 2026-06-05) applies to the
  forms feed too.

---

## Audit changes (`src/audit/detector.ts`)

The classifier feeds the detector:

- **`specimen_missing`** recomputes its trigger against **real-test panels
  only** (documentation panels removed). Real panels remain + null specimen →
  still `error`. No real panels remain → **suppressed**, replaced by `info`
  `routed_as_form`.
- **`record_has_no_observations`** does not fire for form-routed records (they
  carry documentation observations; they just aren't a `lab_request`).
- **`orphan_ordered_panel`** for a documentation panel → relabeled `info`
  "documentation panel, no test observations".
- **New `info` classes** in `data_quality`: `routed_as_form` (+ a split note
  linking the two legs).

---

## Edge cases & error handling

- **Split partial failure:** both legs must land. Per-lab status carries both
  outcomes; record is `errored` if either POST fails, naming the failed leg.
  Idempotency via v2 content/`messageId` dedup keyed on `external_ref`.
- **Truly empty record** (no observations, not rejected): unchanged — still
  `record_has_no_observations` error.
- **No config / unknown country:** heuristic-only; fully back-compatible.
- **Unresolved documentation concept:** stored as `form_response` with
  `raw_value`, concept unresolved, plus a `warn` anomaly.

## Reporting

- Each `export-batch` NDJSON line gains `routing` (`lab` | `form` | `split`).
- Summary gains `forms_posted` (and split counts).

---

## Testing (cdr-toolchain)

Runner: **`node:test` + `tsx`** (zero new deps; matches existing clean-dep
ethos). Vitest is an acceptable swap if preferred.

1. **Classifier (unit):** heuristic-only, config-only, layered; rollup 0-test vs
   ≥1-test; mixed records. Highest-risk logic → most cases.
2. **Forms transform (unit):** documentation observations → correct payload
   (concepts, `external_ref`, `related_request_id`).
3. **Audit deltas:** fixtures `ZUL0800028` / `ZUL0800026` assert
   `specimen_missing` suppressed + `routed_as_form` present; synthetic
   "real test, no specimen" fixture asserts `specimen_missing` still `error`.
4. **Config loader:** YAML parse; unknown-country / missing-file fallback.
5. **Routing/split (builder-level, no network):** via existing `--emit-payloads`
   / `--dry-run-post` — doc+test → two payloads; doc-only → one form payload.
6. **Live smoke (opt-in):** `--insecure-tls` smoke against the real forms feed
   once v2 implements it, behind an env flag.

v2-side tests live in the OpenLDR v2 repo (dependency, not built here).

---

## Build order (dependency-aware)

1. Define & freeze the **form-submission payload contract** (this doc).
2. v2: forms feed + plugins + storage (System A).
3. CLI: config loader + classifier (System B core, testable without v2).
4. CLI: forms transform + split routing + audit changes.
5. CLI: forms feed discovery wiring + reporting fields.
6. Live smoke against v2 forms feed.

Steps 2 and 3 can proceed in parallel once step 1 is frozen.

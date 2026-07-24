# Documentation data → CE as FHIR QuestionnaireResponse (producer design)

**Date:** 2026-07-24
**Repo:** `cdr-toolchain` (producer side). Companion CE-side spec lives in
`openldr_ce/docs/superpowers/specs/2026-07-24-documentation-questionnaireresponse-ce-ingest-design.md`.

## Problem

On the CE target, `export-batch` builds the FHIR payload with `excludeObs: isDocumentationObs`
and has **no forms leg** (unlike the v2 target, which posts documentation to a dedicated forms
feed via `toFormSubmission`). So documentation observations — Zambia `VIRAL`, Tanzania `ARTID`
/`EIDID`/`VLID` (see `config/<country>.yaml`) — are **dropped** and never reach CE.

We are porting the v2 "documentation → forms" capability to CE. Per the agreed CE-side design,
documentation reaches CE as FHIR `QuestionnaireResponse` (+ a minimal `Questionnaire`) delivered
in the **same bare FHIR array** the CE branch already POSTs to the workflow webhook — no new
endpoint, no v2 forms-feed env. CE persists it (structural validation only; a QR is not a lab
result, so it escapes the `result-requires-request` rule even at strictness `high`).

## Approach

Add a FHIR analogue of `toFormSubmission`: build documentation observations into FHIR resources
instead of the v2 `FormSubmissionPayload`. cdr-toolchain owns the DISA codebook and the country
`docConfig`, so it — not CE — carries the dynamic param knowledge; CE stores dumb FHIR.

### New transform: `toDocumentationFhir(specimen, opts)`

`apps/cli/src/export/fhir-documentation-transform.ts`. Mirrors `toFormSubmission`'s
structure but emits FHIR:

1. Flatten + supersede iterations (`flattenDisa` / `supersedePanelIterations`), then
   `splitObservations(obs, codebook, docConfig)` → take the `documentation` half. Return `[]`
   when there are none (documentation-free specimen).
2. Group documentation obs by their mapped `form_code` (`docConfig.forms.get(panelCode)`), so a
   specimen carrying more than one documentation panel produces one `QuestionnaireResponse` per
   form.
3. For each group emit one **`QuestionnaireResponse`**:
   - `status: "completed"`
   - `questionnaire`: canonical reference to the form, e.g. `urn:openldr:form:<form_code>`
   - `subject`: the same Patient reference the test leg uses (shared patient id)
   - `authored`: `submitted_at` (`ReceivedInLab ?? Collected ?? Taken`, tz-normalised via
     `--ce-tz` — same offset the lab leg already requires for CE)
   - `basedOn`: `[{ reference: "ServiceRequest/<related_request_id>" }]` when the specimen also
     produced a test leg (split record); omitted for documentation-only specimens
   - `item[]`: one per documentation obs — `linkId` = param code, `text` = param description
     (from the codebook), `answer` = value mapped by DISA type: numeric → `valueQuantity` /
     `valueInteger`, coded → `valueCoding`, else `valueString`. Dynamic; no fixed schema.
4. Emit a minimal **`Questionnaire`** per distinct `form_code` (deduped across the batch):
   `{ resourceType, url: urn:openldr:form:<form_code>, name: <form_code>, status: "active",
   title: <human title> }`. This is the "real form" resource in CE. Items are intentionally not
   enumerated (params are dynamic); the QR's `item[]` carries the answers.

Pure and I/O-free like the other transforms; unit-testable with fixtures.

### `export-batch` CE branch change

Today the CE branch (`ceConfig !== undefined`) builds `toFhir(payload)` — where `payload` already
excluded documentation — and returns. Change it to:

1. Build the **test-leg** FHIR: `toFhir(payload, { tzOffset })` (unchanged — payload still excludes
   documentation obs, so lab resources are test-only, exactly as now).
2. Build the **documentation** FHIR: `toDocumentationFhir(specimen, { … , relatedRequestId })`,
   where `relatedRequestId` is the test leg's `request_id` when the test leg is non-empty, else
   `null`.
3. Concatenate `[...testResources, ...documentationResources]` into one bare array and POST once
   to the existing CE webhook (`postFhirResources`, `x-webhook-token`).
4. Documentation-only specimen (all obs documentation): the test leg is empty → post the
   `Questionnaire` + `QuestionnaireResponse` (+ Patient) alone. Patient must still be emitted so
   `subject` resolves — reuse the same patient-resource builder `toFhir` uses.

`result.routing` is set the same way the v2 branch does (`"lab"` / `"form"` / `"split"`) so the
batch summary tallies documentation delivery on CE too.

### Config

- Reuses the already-loaded `OPENLDR_COUNTRY` → `docConfig` (panels/params/forms). No change.
- Reuses `--ce-tz` / `OPENLDR_CE_TIMEZONE` (required for CE). No new env.
- **No** `OPENLDR_FORMS_DATA_FEED_*` — that is the v2 forms feed and does not apply to CE.

## Data flow

```
DISA specimen
  → flatten + supersede → splitObservations(docConfig)
      test obs          → (existing) toV2 payload (documentation excluded) → toFhir → lab FHIR
      documentation obs → toDocumentationFhir → Questionnaire + QuestionnaireResponse(basedOn SR)
  → concat → bare FHIR array → CE webhook (x-webhook-token) → CE persist
```

## Error handling / edge cases

- **Documentation-only specimen:** empty lab leg; the CE branch still posts the QR + Patient +
  Questionnaire. Guard against posting an empty array.
- **Value typing:** unknown/blank DISA type → `valueString` fallback (never drop an answer).
- **Missing form mapping:** a documentation obs whose panel has no `docConfig.forms` entry still
  belongs on a QR; fall back to a `form_code` of the panel code (so nothing is lost) and log.
- **Patient id consistency:** the QR `subject` must reference the same Patient id `toFhir` emits,
  so both legs point at one patient in CE.
- **Timezone:** documentation timestamps use the same `--ce-tz` offset as the lab leg (DISA is
  unzoned local time).

## Testing

- **Unit (`toDocumentationFhir`):**
  - A `VLID` specimen (Tanzania) → one `QuestionnaireResponse` (`form_code hiv_vl_documentation`)
    with dynamic `item[]`, plus a deduped `Questionnaire`.
  - Split record → QR `basedOn` references the test-leg ServiceRequest id.
  - Documentation-only specimen → QR with no `basedOn`; lab leg empty.
  - Multiple documentation panels on one specimen → one QR per `form_code`; Questionnaire deduped.
  - Value-type mapping (numeric/coded/text) → correct `answer[x]`.
- **CE branch integration:** with `--ce-url`, the posted array contains both the lab resources and
  the documentation resources (assert on the payload captured by a fetch stub — reuse the existing
  `ce-client` test harness).
- **End-to-end acceptance:** `OPENLDR_COUNTRY=tanzania openldr export-batch <lab w/ VLID>
  --ce-url <local CE> --ce-token … --ce-tz +02:00` → CE persists the documentation QR (and, once
  the CE projector ships, it appears in `questionnaire_responses`), while test obs land in
  `lab_results`. Use `--emit-payloads` / dry run first to confirm the documentation resources are
  present before hitting the wire.

## Out of scope (v1)

- Enumerating `Questionnaire.item` from the codebook (params stay dynamic on the QR).
- Any change to the v2 target path (its forms-feed leg is untouched).
- CE-side projection/read-model — covered by the companion CE spec.

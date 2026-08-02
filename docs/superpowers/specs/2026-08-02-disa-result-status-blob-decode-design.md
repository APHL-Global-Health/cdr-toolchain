# DISA result status + authorisation time from the TESTDATA blob header (design)

**Date:** 2026-08-02
**Repo:** `cdr-toolchain`
**Prior art:** `openldr_ce/docs/superpowers/specs/2026-07-16-disa-result-status-findings.md`
(signal located and measured; decoder not implemented). Memory:
`disa-result-status-signal`, `disa-stores-blobs-not-columns`, `disa-datamine-views-broken`.

## Problem

CE's Specimen Turnaround Time report returns 0 rows. The query needs
`issued - received_time` and requires `issued is not null`; `diagnostic_reports.issued`
is NULL on every row.

The FHIR layer is already correct — `fhir-transform.ts:249` maps
`issued: fhirDateTime(lr.authorised_at, …)`. The defect is upstream, in two stubs in
`apps/cli/src/export/v2-transform.ts`:

- `:329` `authorised_at: null` — "ditto authorised_at"
- `:343` `result_status: rejection.rejected ? "X" : null` — so nothing is ever FINAL

Fixing `authorised_at` alone achieves nothing: v1's measured rule is that
`AuthorisedDateTime` is empty on 100% of interim, 99.9% of rejected and 88% of
not-reviewed rows, and present on 99.95% of FINAL. **Status must be fixed first**,
then authorisation time.

### Why the blob, and not the clean source

DISA ships a "Datamine" reporting layer whose typed columns are exactly what is needed
(`TESTMINE_U.REVIEWEDDATETIME` + `REVIEWER`). It is unusable here. Re-confirmed
2026-08-02 by full enumeration: all Datamine objects live in `DisalabData` and are
**12 views over 0 tables**; 11 of 12 fail `Invalid object name`. The 9 base tables
(`PARAMMINE`, `TESTMINE`, `PARMMINE`, `SENSMINE`, `CCOMMINE`, `IDMINE`, `RCOMMINE`,
`SNMDMINE`, `SURVMINE`) exist in no schema of any database on the instance. The one
working view, `Datamine_Demographics`, is a plain projection over `dbo.REGDAT4` and
carries no offset map. So the values must come from the packed blob.

## Established facts (measured, this instance, 2026-08-02)

| fact | value |
|---|---|
| `DisalabData.dbo.TESTDATA` | 191,121 rows · 105,860 labs · 149 panels |
| v1 `OpenLDRData.dbo.Requests` scoped `TZDISA%` | 3,437,966 rows · 1,739,522 requests |
| v1 status spread | `F` 2,702,268 · `I` 545,317 · `R` 112,639 · `X` 77,115 · `A` 624 · blank 3 |
| TESTDATA panels joinable to v1 | **176,287** |
| v1 `AuthorisedDateTime` populated | 2,703,931 |
| …with real time (not midnight) | 2,703,235 vs 696 midnight |
| …range | 2013-03-01 16:21 → 2019-01-20 13:02 |
| joinable panels **with** a v1 timestamp | **160,931** |

The join is `r.RequestID = <prefix> + t.LABNO AND r.LIMSPanelCode = t.TESTCODE`.

Two consequences. First, the F/R rule can be re-measured locally on 176,287 labelled
panels — more than the 168,289 the original finding used. Second, and this is what makes
the timestamp tractable: 160,931 panels carry a **known target datetime**, so decoding
bytes ~21-26 is a constrained search scored against ground truth, not open-ended
reverse-engineering.

### The per-panel/per-request blocker is gone

The 2026-07-16 findings doc names one question that "must be decided before
implementing": v1's status is per-OBR but `V2Payload.result_status` was a single
per-request field. **The code has since changed.** `export/types.ts:174` is now
`lab_requests: V2LabRequest[]` — one per ordered panel (`v2-transform.ts:223`) — and
`result_status` sits on that per-OBR object (`types.ts:64`). That is exactly v1's grain
and DISA's `TESTDATA` grain. No aggregation rule is needed and no schema change.

## Approach

Four phases, each gated. The design assumes the timestamp **might not crack** and makes
that a survivable outcome rather than a dead slice.

### Phase 0 — expose the header

`TESTDATA.initialize()` does `Core.FixString(_data, 80, _data.length)`
(`packages/disalab/src/lib/DisalabData/TESTDATA.ts:39`), discarding bytes 0-79. Add a
`TestDataHeader` value object built from those bytes, exposed as `TESTDATA.HEADER`:

- `raw: Uint8Array` — the 80 header bytes
- `reviewerInitials: string | null` — ASCII, `null` when the slot is all-zero
- `reviewedAt: string | null` — shape determined by Phase 1

No behaviour change; nothing reads it yet. Lands independently.

### Phase 1 — measure before writing any production rule

A CLI command joins `TESTDATA` to v1 `Requests` and scores candidate decodes against
ground truth. Two jobs:

1. Reproduce `bytes[77..79] != 0 ⇒ F, else R` on this data and confirm it agrees with
   the recorded 98.99%.
2. Constrained search for the review-timestamp encoding over the 160,931 rows labelled
   with v1's `AuthorisedDateTime`. Known anchor: `uint16LE` at offset 23 is the review
   year (clean 2013→2019 histogram). Offsets 25/26 are **not** a plain month (values
   30/31/55 and 11/12/14 observed), so the structure is not a naive `SYSTEMTIME`.

The command reads through the same `TestDataHeader` object the production path uses, so
the search cannot drift from what ships.

> **GATE.** The bar is **exact match to the minute on ≥95% of the 160,931 labelled
> rows**. Below that, **stop**: report the measured ceiling, ship `result_status` alone,
> and state the turnaround consequence plainly. Do not proceed to Phase 3-4 on a guess.
> 95% is chosen to sit clearly above the ~99%-accurate status rule's own error floor
> while leaving room for the same class of timing artefacts; if the achieved number lands
> between 90% and 95%, surface it and let the user decide rather than deciding silently.

### Phase 2 — production decode + config

Offsets move into `config/<country>.yaml`; decode logic lives in `disalab`. See Config.

### Phase 3 — transform wiring

`result_status` and `authorised_at` populated on the per-OBR `V2LabRequest`.

### Phase 4 — CE re-ingest + live verification

Re-ingest into the local CE instance and confirm the Specimen Turnaround Time report
returns rows. Existing CE rows keep NULL `issued`; a re-ingest is required.

## Data flow

```
specimen.TestResults ──► header per (panelCode, base(TESTINDEX))
                            │
obrSets ──► obrOf ──────────┼──► statusByObr: Map<obr_set_id, {status, authorisedAt}>
                            │
obs (superseded, filtered) ─┘         │
                                      ▼
                          buildLabRequest(..., statusByObr)
                            → result_status, authorised_at
```

`buildLabRequest` currently receives neither `obs` nor `obrOf` (`v2-transform.ts:710`),
so `statusByObr` is computed in `toV2` and passed down.

### ⛔ Grain trap — resolve the header PER OBR, not per panel code

`supersedePanelIterations` picks a winner keyed by **`panelCode` alone**
(`compare/result-mapping.ts:511`), while OBR grain is **`(panelCode, base(TESTINDEX))`**
(`export/obr-sets.ts:42`, `:89`). These disagree whenever one panel code occupies two
OBRs. Sourcing the header from the panelCode-level winner would attach one panel's
review state to a sibling OBR.

The header is therefore resolved **per OBR**, choosing the latest iteration within that
OBR by the same rule supersession uses (datestamp, then panelIndex). This divergence is
deliberate and must carry a comment at the call site.

### Status rule (per OBR)

```
X   rejected                       — existing detectDisaRejection, unchanged
I   zero kept observations for this OBR
F   reviewerInitials non-null      — reviewed
R   otherwise                      — results stored, not verified
A   NOT DERIVABLE — accepted gap (624 rows in 3.4M)
```

Precedence is top-down: `X` wins over `I`, `I` over `F`/`R`.

## Config

```yaml
disa_blob_offsets:
  reviewer_initials: { start: 77, end: 80 }   # end exclusive
  reviewed_at:       { start: 21, end: 27 }   # shape set by Phase 1
```

Validated with `zod` at startup.

**Structural validation:** keys present, integers, `start < end`, `start` within 0-79 and
`end` within 1-80 (**`end` is exclusive**, so `end: 80` is the legal maximum and addresses
byte 79). A `start` ≥ 80 or `end` > 80 would read result payload as review metadata, so
the bound is enforced.

**Semantic self-check** — the half that matters. Wrong offsets do not throw; they return
plausible garbage. On the first **500** decoded panels the loader asserts two properties
the correct offsets are known to have (500 is ample: the initials slot is non-zero on
~94% of panels, so a wrong offset is caught within the first handful of rows, and 500
keeps the check inside a single query):

- Non-zero initials decode to printable ASCII letters (observed `65,80,66` = `"APB"`).
- Decoded review years fall in a sane window (the corroborating histogram is a clean
  2013→2019).

On failure the run **aborts**, printing the sampled bytes and decoded values. This is the
mitigation for putting measurement-derived values in a hand-editable file.

## Error handling / edge cases

Per-row decode failures are **warnings, never quarantine**. A header that will not decode
yields `null` status/`authorised_at` — today's behaviour exactly, so it cannot be a
regression and must not block a record.

New flags:

| flag | severity | trigger |
|---|---|---|
| `review_header_undecodable` | warning | header bytes present but do not parse |
| `authorised_before_received` | warning | decoded timestamp predates `received_at` |

`authorised_before_received` produces a **negative turnaround** in CE. Per the PRD's
"garbage in, flagged out" rule (§1, §14) the value is **emitted and flagged**, not
silently nulled. Decided explicitly with the user on 2026-08-02: negatives are visible to
the reviewer rather than suppressed.

## Testing

The acceptance oracle already exists. `compare/v2-mapping.ts` carries gate entries for
both fields: `result_status` → `HL7ResultStatusCode` (`:309`) and `authorised_at` →
`AuthorisedDateTime` (`:233`). The task is to turn these from **expected-RED stubs into
fields reporting real measured agreement** — not to build a harness, and not to chase a
green light (see "Expectation to set honestly" below).

`authorised_at` already encodes the correct rule: `emptyIsCorrectWhen` treats empty as
correct unless v1's status is `F` (`:247`), and the 73 `F`-rows-without-authorisation stay
RED deliberately. Conform to it; do not relax it.

**Expected churn:** `compare/v2-mapping.test.ts:48-56` asserts the *current stub is RED*.
Fixing the stub necessarily rewrites that assertion. This is a test encoding "this is
broken" reaching end of life, not a loosened gate — say so in the commit.

Four layers:

1. **Unit** (`node --import tsx --test`, `apps/cli/package.json:16`) — header decode
   against byte fixtures: the real `65,80,66` → `"APB"` case, the all-zero case, and a
   non-printable case that must trip the guard. Plus the X/I/R/F precedence table and the
   per-OBR resolution case where supersession's panelCode winner disagrees.
2. **Phase 1 measurement** — `cdr probe-review --limit 200000`, run against live DISA/v1
   (2026-08-02). 176,287 labelled panels fetched (join of `DisalabData.TESTDATA` to
   `<v1>.Requests` on `RequestID = prefix + LABNO AND LIMSPanelCode = TESTCODE`).

   F/R rule (initials slot 77-80 non-zero ⇒ F, else R), n = 169,969 scorable (F/R only):
   ```
   F & reviewed  (correct) = 159188
   R & !reviewed (correct) = 8923
   F & !reviewed (miss)    = 632
   R & reviewed  (miss)    = 1226
   ACCURACY = 98.91%  (n = 169969)
   ```

   Timestamp search (long-datetime / short-datetime decoders, every offset 0-74,
   tolerance 60s), n = 160,371 rows scorable (reviewed AND v1 has `AuthorisedDateTime`):

   The first run of this measurement was invalidated by a scorer bug (it compared
   local-vs-UTC `Date` instants, producing a constant 3h skew) and is superseded by the
   re-measured output below.
   ```
   labelled panels fetched: 176287

   === F/R rule: initials non-zero => F, else R ===
     F & reviewed  (correct) = 159188
     R & !reviewed (correct) = 8923
     F & !reviewed (miss)    = 632
     R & reviewed  (miss)    = 1226
     ACCURACY = 98.91%  (n = 169969)

   === timestamp search (n = 160371, tolerance 60s) ===
     BEST: kind=long-datetime offset=21 hits=159340/160371 rate=99.36%

   === GATE (spec: >=95% minute-exact) ===
     PASS (99.36%) — proceed to Phase 2.
   ```
   Per the plan's gate rule: proceed to Phase 2 with both `result_status` and
   `authorised_at` derivable from this header via the winning decoder (kind=long-datetime,
   offset=21).
3. **Gate** — `cdr compare-batch` against live v1, reporting both fields.
4. **Phase 4** — re-ingest local CE, run CE's turnaround query, assert `issued` populated
   and durations plausible.

### Expectation to set honestly

Phases 1-2 of this project reported **100.0000%** match, and that is the house standard.
`result_status` will not reach it: the rule is ~99% by construction, with a known ~1% miss
and `A` underivable. **Success means matching the measured ceiling, not going green.**
State the achieved number so a non-100% field does not read as a regression.

## Known gaps

- `A` ("some but not all results available") is not derivable — 624 rows in 3.4M.
- ~1% F/R miss: 1,225 `R & reviewed` and 476 `F & !reviewed` in the original measurement,
  both unexplained. The `R & reviewed` set may be a timing artefact (review after v1
  ingest), testable against the offset-23 review year.
- All figures are **Tanzania** (`TDS0%` / `TZDISA%`) and the DISA side is a laptop subset
  (1 site of 22). Mozambique and Zambia are unverified; DISA versions vary even within one
  database (`WS101` vs `WL101`). **The method transfers, the numbers do not** — each
  country re-measures and sets its own YAML offsets.

## Out of scope

- Populating `analysis_at` (`v2-transform.ts:328`) — separate stub, separate signal.
- Fixing the `testing_facility_code` defect documented at `v2-transform.ts:287-313`.
- Reconciling the `supersedePanelIterations` panelCode-vs-OBR divergence itself; this
  spec works around it per-OBR and documents it, but does not change supersession.
- Any DISA-side write. All DISA/v1 access is read-only.

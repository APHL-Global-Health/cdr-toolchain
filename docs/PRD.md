# DISA → OpenLDR Migration Tool

**Project:** `cdr-toolchain` (monorepo: `apps/cli`, `apps/api`, `packages/disalab`)
**Status:** Phases 1 + 2 complete (DISA decoder + fidelity audit against OpenLDR v1); Phase 3 (direct DISA → v2 migration) pending
**Scope:** Data-only migration from DISA\*Lab (SQL Server, read directly) to OpenLDR v2 (REST API)

---

## 0. Status & Progress

> This section is authoritative for where the project is *today*. The rest of the PRD (sections 1-16) describes the original design target and is **pending revision** — it pre-dates the disalab-as-direct-reader pivot and partially conflates OpenLDR v1's schema with DISA's.

### Schema clarification

The original PRD described reading `Requests` / `LabResults` from "DISA SQL Server." Those tables actually belong to **OpenLDR v1** — an intermediate system that has historically migrated DISA data. DISA itself stores data in a blob-encoded schema across tables like `REGDAT4` (specimen reception), `TESTDATA` (observation values), `TXT1DATA` (text overflow), `AUDTDATA` (audit trail), and a set of dictionaries (`PARMDICT`, `COMMDICT`, `LOCNDIC4`, etc.). `packages/disalab` is the TypeScript decoder for this native DISA format.

### Phase 1 — Request-level fidelity (complete)

**Goal:** prove `disalab` decodes DISA's request-level fields faithfully, using the existing DISA → OpenLDR v1 migration as ground truth.

- CLI commands `cdr compare <lab-no>` and `cdr compare-batch` diff DISA's `SpecimenRecpt` record against v1's `Requests` row across 13 request-level fields (facility code/name, ward, panel, specimen, taken/collected/received/etc. datetimes, priority, sex, ICD-10, therapy, clinical info).
- Candidate-array comparator pattern: v1 frequently collapses several DISA fields into one column (e.g. `SpecimenDateTime` = DISA.TakenDateTime OR DISA.CollectedDateTime), so comparators accept multiple DISA candidates and match-any-wins.
- 500-lab TDS013% survey: **13/13 fields, 100% Request-level match.**

### Phase 2 — Per-observation fidelity (complete)

**Goal:** prove `disalab` correctly decodes per-observation DISA data (TESTDATA → OrderItem) by comparing against v1's `LabResults` table per (RequestID, OBRSetID, OBXSetID).

- CLI commands `cdr compare-results <lab-no>` and `cdr compare-batch --results` flatten both sides into observation tuples, align by `(panelCode, paramCode)` with positional zip, and diff per-observation.
- `RESULT_FIELDS` registry: primary `result` + `observation_desc` + typed sub-fields `numeric_value` / `coded_value` / `text_value` with `skipWhenBothEmpty` semantics so the rollup is proportional.
- Migration-wide rollup: `labs_pending_in_v1` bucket correctly excludes interim-status labs (where v1 intentionally skips LabResults migration for `HL7ResultStatusCode='I'` requests).

**Final fidelity results** (commit `7508aa4`):

| survey | labs scanned | perfect | pending | observations | match | mismatch | only_disa | only_v1 | rate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| TDS013% | 500 | 500 | 212 | 2,255 | 2,255 | 0 | 0 | 0 | **100.0000%** |
| TDS012% | 2,000 | 1,956 | 27 | 15,220 | 15,220 | 0 | 0 | 0 | **100.0000%** |
| TDS0115-119 | 3,000 | 2,881 | 159 | 17,122 | 17,122 | 0 | 0 | 0 | **100.0000%** |
| **Combined** | **5,500** | **5,337** | **398** | **34,597** | **34,597** | **0** | **0** | **0** | **100.0000%** |

### Decoder fixes landed during the audit

The fidelity audit surfaced eight distinct bugs in `disalab` that affected any consumer of the library, not just the compare tool:

1. **windows-1252 → latin1** (`Core.ConvertToBytes`, commit `e50207c`). iconv-lite decodes the 5 undefined windows-1252 positions (`0x81, 0x8D, 0x8F, 0x90, 0x9D`) to `U+FFFD`; downstream `charCodeAt(i) & 0xFF` then round-tripped them as `0xFD`, silently corrupting ~2% of float/int byte patterns. Latin-1 is a lossless 1:1 mapping `0x00-0xFF → U+0000-U+009F`. Example failure: TDS0130048 HIVTL bytes `1F DB 90 40 00` should decode to 4.527 (log₁₀(33631)) — under windows-1252 they decoded to 7.933.
2. **`Core.Trim` strips binary bytes as whitespace** (`OrderItem` RawValue path, commit `7508aa4`). JS `.trim()` treats `0x09-0x0D` as whitespace, so any binary date whose day = 9/10/11/12/13 (e.g. day=12 → `0x0C` form-feed) had its byte stripped, leaving the date undecodable. Binary-typed slots now skip `.trim()` and only drop NULs.
3. **PARMDICT description column corruption** (commit `343d957`). The `[DESCRIPTION]` column is stored 3 bytes into the blob's string slot for many rows (`"Remarks"` → `"arks"`, `"Comment"` → `"ment"`). The blob carries the correct value, so `PARMDICT.All()` now parses via `fromBytes()` instead of reading the corrupt column.
4. **DISA datetime `.trim()` bug** (commit `c0b096b`). Same trim-destroys-binary family as #2 but in the datetime decoders.
5. **MS-DOS short-date decoder** and **facility-prefix v1 stripper** (commit `095e015`). Two systematic decoding gaps fixed.
6. **Fallback datetime candidate** (commit `c692e2b`). v1's `SpecimenDateTime` collapses DISA's `TakenDateTime` and `CollectedDateTime`; comparators now accept either.
7. **`OrderItem.RawValue`** (commit `7508aa4`). Preserves the pre-COMMDICT raw code alongside the decoded description. v1 often stores the code (e.g. `"NONE"`) while DISA presents the description (e.g. `"No ART given to child"`) — both are now available as comparison candidates.
8. **Date-type (type=7) decoding** in `OrderItem` (commit `7508aa4`). `FromDisaDate` now runs on Date-type OrderItems, formatting as `DD/MM/YYYY` to match v1.

### Tool capabilities as of Phase 2 end

`apps/cli` (`cdr` command) ships with:

- `cdr tables` / `cdr schema <table>` — DISA schema introspection.
- `cdr list <table>` / `cdr get` / `cdr count` / `cdr stream` — raw row access.
- `cdr specimen <lab-no>` — fetch a specimen receipt (SpecimenRecpt) with hydrated TESTDATA.
- `cdr compare <lab-no>` / `cdr compare-batch [--where --limit --results]` — Phase 1 + Phase 2 fidelity audit.
- `cdr compare-results <lab-no>` — per-observation diff for a single lab.
- `cdr probe-bytes <lab-no>` — brute-force date-pattern scan through REGDAT4_STATUS for reverse-engineering unmapped fields.
- `cdr ping` / `cdr config` — config + connectivity check.

Structured filters baked into the audit defaults (off with `--include-empty`):
- `isResulted=false` DISA OrderItems.
- Whitespace/control-byte-only values (panel-template placeholders).
- Stray 1-char HL7 status flags in Text/Graphic slots (where TXT1DATA overflow is missing).
- DISA's `"Information missing"` sentinel (COMMDICT code `888` in contexts 131-137).
- DISA `RJREA` / `RJREM` (panel rejection metadata v1 doesn't carry).
- v1 rows with all three result columns empty, or `rpt_result="0.00"` + empty coded + implausible SIValue.

Cross-parameter recognitions that reclassify would-be `only_*` cases as expected behavior:
- **v1 pending-in-v1:** when `HL7ResultStatusCode='I'` + zero v1 LabResults (per-OBR-aware — TDS0130550 taught us the check needs to be on aggregate LR, not first-OBR status).
- **Below-detection synthesis** (both directions): when DISA has `SCOM/VCOM='TLINT'` resulted on a HIVVL panel, v1's `HIVVQ="< 40"` / `HIVVM="< 20"` / `HIVTL="0.00"` sentinels without DISA counterparts are reclassified as match (v1 synthesis); symmetrically, DISA's `HIVVQ=0` below-detection zero without a v1 row is also match.

### Tanzania-specific domain context (captured in memory)

Two synthetic "test" codes in DISA hold questionnaire data, since DISA has no form concept:

- **VLID** — Viral Load Intake Data. Auto-ordered with `HIVVL`. Fields: pregnancy status, breastfeeding, TB, ART regimen, adherence, reason for testing, etc. Stored as DISA "observations" with codes `ARVPP`, `ARVBF`, `ARVTB`, `ARVRT`, `ARVDA`, `ARVA2/3`, `ARVP2/3`, `ARA1O`/`ARA2O`, `ARP1O`/`ARP2O`, `ARRTR`, `ARTBT`, `ARVAR`, `ARVPR`, `HIVRQ`, `VTXT`.
- **EIDID** — Early Infant Diagnosis Intake Data. Auto-ordered with the EID assay panel (e.g. `HIVPC`). Fields: ART during pregnancy/delivery, feeding, DBS collection. Observation codes `FEED`, `ARVC`, `ARTCR`, `ARTCD`, `ARVM`, `ARTMR`, `ARTMD`, `ARTRD`, `HIVRQ`, `DBSC`.

Other countries are likely to have their own hub-and-spoke hacks; the country config (section 6) is the right place to surface them.

### What's next (Phase 3)

The Phase 3 plan is not yet committed. Working hypothesis: with `disalab` now a trustworthy source-of-truth DISA reader, Phase 3 implements the actual DISA → OpenLDR v2 transform described in sections 4-16 below — but reading from DISA directly via `disalab` rather than from OpenLDR v1's `Requests`/`LabResults` tables. The v2 JSON contract (section 3) remains the target.

Sections 1-16 below were drafted before the disalab pivot and before Phase 1/2. They are **preserved for reference** and should be revised before Phase 3 implementation begins. Specifically:

- Section 2 ("Source data model") should be rewritten to describe DISA's native schema (`REGDAT4`, `TESTDATA`, `TXT1DATA`, `AUDTDATA`, dictionaries) instead of OpenLDR v1's `Requests`/`LabResults`.
- Section 4 ("Architecture") should reference `disalab` as the reader layer.
- Section 6 ("Country configuration") can now be informed by real empirical findings (TLINT synthesis, VLID/EIDID questionnaire panels, 888 sentinel, etc.).
- Section 7 ("Flag taxonomy") already anticipated many of the data-quality signals `compare-batch` has now quantified in practice — align the two lists.

---

## 1. Context & goals

### What is DISA

DISA\*Lab is a legacy Laboratory Information System (LIS) widely deployed across PEPFAR-funded sites in Southern and Eastern Africa. It stores laboratory orders and results in a SQL Server database using a flattened, HL7-adjacent schema. The DISA product is no longer actively developed and its data model is idiosyncratic (HL7-inspired but non-compliant in several places).

### What is OpenLDR v2

OpenLDR is the target platform — a modern laboratory data repository with a structured REST API that accepts lab requests with nested lab results, isolates, and susceptibility tests in a documented JSON schema. The v2 API owns all validation, terminology mapping, and downstream processing.

### Why migrate

Country programs in Tanzania, Zambia, Mozambique, and Kenya need to move historical DISA data into OpenLDR v2 so that:
- AMR surveillance and HIV VL reporting happen on a supported platform
- Historical data is queryable alongside new data entering v2 directly
- The v1 DISA servers can be decommissioned

### Scope of this tool

**In scope:**
- Reading `Requests` and `LabResults` tables from DISA SQL Server databases
- Transforming each request + its results into the v2 JSON contract
- Streaming transformed records to the v2 REST API
- Capturing all data-quality issues as structured flags
- Writing unprocessable records to a quarantine file for later review
- Resumability from last processed `RequestID`

**Out of scope:**
- Patient record migration (v2 handles patient identity via a separate process)
- DBF file reading (DISA's legacy file format — handled by a different tool in this repo's history)
- WHONET AMR interpretation (happens on the v2 side after migration)
- Schema changes to v2
- Historical correction of DISA data quality issues — garbage in, flagged out

### Success criteria

1. A single-command migration that can run against any DISA country deployment
2. Country-specific code mappings configurable without code changes
3. Every record either lands in v2 or in quarantine — no silent data loss
4. Restart after interruption resumes within the current request, no duplication
5. A quarantine reviewer can understand *why* each quarantined record failed

---

## 2. Source data model (DISA v1)

DISA's schema is not documented publicly. The conventions below are derived from direct inspection of Tanzanian data and are expected to hold across deployments with some variation.

### Core tables

Only two tables matter for this migration:

- **`Requests`** — one row per (RequestID, OBRSetID). A single `RequestID` can have multiple rows when the order includes multiple panels (e.g., HIV VL results + VL patient info metadata; or bacterial culture + sensitivity panel).
- **`LabResults`** — one row per (RequestID, OBRSetID, OBXSetID, OBXSubID). Each row is a single observation.

Both tables use `varchar` with right-padding, so every string field must be `TRIM`med. Empty strings are semantically null.

### Field semantics (DISA quirks)

These are the fields the tool depends on, and what they actually mean in practice:

| Field | Semantic |
|---|---|
| `RequestID` | The lab order identifier. One request can span multiple panels. |
| `OBRSetID` | Panel index within the request (1, 2, 3…). Each OBR set is a logical sub-order with its own panel code. |
| `OBXSetID`, `OBXSubID` | Observation index within an OBR set. |
| `LIMSPanelCode` | Panel code per OBR set (e.g., `HIVVL`, `CULPU`, `SENPU`, `VLID`). |
| `HL7SectionCode` | Lab section — `MB` = microbiology, `VR` = virology, `OTH` = patient info / metadata panels. |
| `LIMSPointOfCareDesc` | Contains ward/clinic info but often polluted: a `CHAR(6)` control character prefix and a `~` delimiter separating facility name from ward. Example: `"Bugando Medical Centre (BMC)~Ward C5"`. |
| `LIMSObservationCode` | The semantic "what was measured" for a LabResults row. Key codes: `ORGS` (organism identified), `SCOM` (comment), plus antibiotic codes and panel-specific codes. |
| `LIMSCodedValue` | The coded result. For AST rows this is `S` / `I` / `R`. For organism rows this is the organism code (e.g., `STAAU`, `ECO`, `NBG`). |
| `LIMSRptResult` | The display string of the result (e.g., `"Staphylococcus aureus"`, `"Target Not Detected"`, `"14"`). |
| `SIValue` | Numeric value if the result is numeric. Often 0 for non-numeric rows. For `"< 20"` viral loads, sometimes stores `20`. |
| `HL7ResultTypeCode` | `NM` = numeric, `V` = viral-load-style, `R` = coded result, `C` = comment. Inconsistent across deployments. |
| `HL7SectionCode = 'MB'` | **The primary discriminator for microbiology requests.** Used to branch between viral load logic and culture/AST logic. |

### Key DISA conventions

1. **A `RequestID` has multiple OBR sets.** The first OBR is usually the "real" test; subsequent OBRs may be patient-info metadata panels (like `VLID` for HIV VL clinical context).
2. **Organism identification lives in `LabResults` where `LIMSObservationCode = 'ORGS'`.** The organism code is in `LIMSCodedValue`, display name in `LIMSRptResult`.
3. **AST results and ORGS rows live in different OBR sets within the same request.** DISA does not provide an explicit foreign key linking an isolate to its antibiotics. The tool must infer linkage.
4. **"No growth" is represented as an ORGS row** with codes like `NBG`, `NF`, `NG`, `NFLO`, `NORGS`. These are still valid observations and must be preserved as isolates with `organism_type = 'none'`.
5. **Panel codes vary per deployment.** `VLID` is the Tanzanian code for "HIV VL Patient Information"; other countries may use different codes for the equivalent metadata panel.
6. **Antibiotic codes vary per deployment.** Tanzanian data uses `CIPRO`, `AMIK`, `CEFTA`, etc. Other countries may use WHONET codes, local shorthand, or both.

---

## 3. Target data model (OpenLDR v2)

Each DISA `RequestID` maps to one v2 record with this shape:

```json
{
  "lab_request": {
    "request_id": "...",
    "facility_code": { "system_id", "concept_code", "display_name", "concept_class", "datatype" },
    "panel_code":    { "system_id", "concept_code", "display_name", "concept_class", "datatype" },
    "specimen_code": { "system_id", "concept_code", "display_name", "concept_class", "datatype" },
    "taken_datetime": "...",
    "collected_datetime": "...",
    "received_at": "...",
    "registered_at": "...",
    "analysis_at": "...",
    "authorised_at": "...",
    "clinical_info": "...",
    "icd10_codes": "...",
    "therapy": "...",
    "priority": "...",
    "age_years": 0,
    "age_days": 0,
    "sex": "...",
    "patient_class": "...",
    "section_code": "...",
    "result_status": "...",
    "requesting_facility": "...",
    "testing_facility": "...",
    "requesting_doctor": "...",
    "tested_by": "...",
    "authorised_by": "..."
  },
  "lab_results": [
    { "source_test_code", "obx_sub_id", "observation_code", "result_value", "result_type", "coded_value", "abnormal_flag", "rpt_range", "is_resulted" }
  ],
  "isolates": [
    { "isolate_index", "source_test_code", "organism_code", "organism_type", "isolate_number", "patient_age_days", "patient_sex", "ward", "origin" }
  ],
  "susceptibility_tests": [
    { "isolate_index", "source_test_code", "antibiotic_code", "test_method", "result_raw", "result_numeric", "susceptibility_value", "guideline" }
  ]
}
```

The exact field list and v2 API contract is owned by the OpenLDR v2 repo — the tool should consume it from a shared schema (TypeScript types generated from the v2 OpenAPI spec, or a linked package in the monorepo).

**Empty string → null:** Every DISA string field is right-padded. `TRIM` then treat empty string as null in the output.

**Empty arrays, not null:** `lab_results`, `isolates`, `susceptibility_tests` must always be present as arrays (possibly empty), never null.

---

## 4. Architecture

### Streaming topology

```
DISA SQL Server (mssql streaming cursor)
  └─> distinct RequestIDs
        └─> for each RequestID:
              fetch all Requests rows + LabResults rows
              transform → v2 JSON record
              attach collected flags
              POST to v2 API  ─┬─> success: advance checkpoint
                               └─> quarantine-worthy failure: write to quarantine.jsonl
```

### Key properties

- **One request at a time.** No batching at transformation level. v2 API may accept batches; if so, the HTTP client can buffer a handful of records before POSTing, but the unit of work is a single request.
- **mssql `stream: true`.** No buffering 10GB into memory. Use streaming row events.
- **Two-phase record assembly.** Query `Requests` rows and `LabResults` rows separately per `RequestID`, not a giant join. A join causes row explosion and complicates streaming.
- **Checkpoint file.** A small JSON file with the last successfully POSTed `RequestID` and a UTC timestamp. Written after each successful POST.

### Components

| Component | Responsibility |
|---|---|
| `db/reader.ts` | mssql connection, streaming cursor over distinct RequestIDs, per-request batch fetch of Requests + LabResults |
| `transform/request.ts` | Build the `lab_request` object from Requests rows |
| `transform/results.ts` | Build the `lab_results` array (non-ORGS, non-AST observations) |
| `transform/isolates.ts` | Build the `isolates` array from ORGS rows |
| `transform/ast.ts` | Build the `susceptibility_tests` array, linked to isolates |
| `transform/index.ts` | Orchestrate the four transforms, collect flags |
| `mapping/loader.ts` | Load YAML country config at startup |
| `mapping/codes.ts` | Code lookup helpers (antibiotic, organism, specimen, no-growth, info-only panels) |
| `flags/types.ts` | Enumerated flag codes and severities |
| `flags/collector.ts` | Per-record flag accumulator passed through transforms |
| `api/client.ts` | v2 API HTTP client, auth, retries, error classification |
| `quarantine/writer.ts` | Append-only JSONL writer for quarantined records |
| `checkpoint/store.ts` | Read and write the checkpoint file |
| `cli.ts` | Commander-based CLI with start, resume, dry-run, and stats commands |

### Non-goals of the architecture

- No local staging of transformed records. Output is v2-only; if v2 is down, the migration pauses.
- No retry logic inside transformations. A transformation either succeeds or quarantines.
- No parallel workers in v1. Sequential processing keeps resumability trivial. Parallelism can be added later behind a flag if throughput demands it.

---

## 5. Transformation rules

### 5.1 Request-level fields

- **Primary panel selection:** when a `RequestID` has multiple OBR sets, the tool picks one OBR row to source `panel_code` from. Rule:
  1. Exclude OBR rows whose `LIMSPanelCode` is in the country config's `info_only_panels` list (e.g., `VLID`).
  2. Of the remaining, pick the one with the lowest `OBRSetID`.
  3. If all OBR rows are info-only, fall back to lowest `OBRSetID`.
- **Facility display name:** `LIMSPointOfCareDesc` often has a `CHAR(6)` control-char prefix and `~`-delimited "facility~ward" format. Strip the control char, split on `~`, take the first segment as facility display.
- **Empty strings → null:** every string field is TRIM'd; empty becomes null.
- **Dates:** DISA stores local time without timezone. Pass through as-is (ISO-8601 local). v2 is responsible for timezone handling per deployment.

### 5.2 `lab_results` array

Include every LabResults row EXCEPT:
- Rows where `LIMSObservationCode = 'ORGS'` (those go to `isolates`)
- Rows where `LIMSObservationCode` is in the country's antibiotic code list AND `LIMSCodedValue ∈ {S, I, R}` (those go to `susceptibility_tests`)

For each included row:
- `source_test_code` = the `LIMSPanelCode` from the Requests row matching the same `OBRSetID`. If no matching Requests row, flag `orphan_obr_set` and set null.
- Trim all strings, null out empties.
- `is_resulted` = true (DISA doesn't distinguish ordered-but-not-resulted; presence in LabResults implies resulted).

### 5.3 `isolates` array

- One isolate per LabResults row where `LIMSObservationCode = 'ORGS'` AND `LIMSCodedValue` is non-empty.
- `isolate_index`: 1-based, ordered by `(OBRSetID, OBXSetID)`.
- `organism_code.concept_code` = `LIMSCodedValue`.
- `organism_code.display_name` = `LIMSRptResult`.
- `organism_type`:
  - If `LIMSCodedValue` is in the country's `no_growth_codes` list → `'none'`
  - If in country's `fungus_codes` list → `'fungus'`
  - If in country's `parasite_codes` list → `'parasite'`
  - Otherwise default to `'bacteria'` (flag with `organism_type_defaulted` so reviewer knows it was a guess)
- `isolate_number` = string of `isolate_index` unless country config provides a different scheme.
- `patient_age_days`, `patient_sex`, `ward`, `origin` copied from the request.

### 5.4 `susceptibility_tests` array

- Source rows: LabResults where `LIMSObservationCode` ∈ country antibiotic codes AND `LIMSCodedValue` ∈ {`S`, `I`, `R`}.
- Linkage to isolates:
  1. Filter isolates to growth-positive only (exclude `organism_type = 'none'`).
  2. For each AST row, find the growth-positive isolate whose `OBRSetID` is numerically closest to the AST row's `OBRSetID`. Ties broken by lower `OBRSetID`.
  3. If no growth-positive isolate exists in the request, flag `ast_without_isolate` and emit the AST row with `isolate_index = null` so v2 can decide.
  4. If the request has multiple growth-positive isolates, flag `multiple_isolates_ambiguous_linkage` at the request level.
- `test_method`: derive from `SIValue` and `SIUnits`:
  - `SIValue > 0` and `SIUnits` contains `"mm"` → `'DISK'`
  - `SIValue > 0` and `SIUnits` contains `"mg"` or `"µg"` → `'MIC'`
  - `SIValue > 0` with no unit → `'DISK'` (most common in DISA) + flag `test_method_inferred`
  - otherwise null
- `result_raw` = `LIMSRptResult`.
- `result_numeric` = `SIValue` if > 0 else null.
- `susceptibility_value` = `LIMSCodedValue` (already S/I/R).
- `guideline` = default `'CLSI'` unless country config overrides to `'EUCAST'`.
- `guideline_version` = null (DISA does not record this).

### 5.5 Numeric parsing special cases

- **Censored viral loads:** `"< 20"`, `">10000000"`, etc. Don't try to parse to `numeric_value`. Keep the raw string in `result_value`. Flag `censored_numeric_value`. v2 handles interpretation.
- **Non-numeric HL7ResultTypeCode:** if type code is `V` but `LIMSRptResult` is a range (`"0 - 0"`) or text, leave `numeric_value` null.

---

## 6. Country configuration

One YAML file per country, loaded at tool startup. Path specified by CLI flag or env var.

### Example: `config/tanzania.yaml`

```yaml
country: tanzania
# Panels that are metadata-only and should be deprioritized when selecting
# the primary panel for lab_request.panel_code
info_only_panels:
  - VLID

# Organism codes meaning "no growth" or "normal flora" — mapped to organism_type='none'
no_growth_codes:
  - NBG
  - NF
  - NG
  - NFLO
  - NORGS

fungus_codes:
  - CANDI
  - CAN
  - CANAL
  - CRYP

parasite_codes: []

# Antibiotic codes — only observation codes in this list are treated as AST results
# when combined with LIMSCodedValue ∈ {S, I, R}
antibiotic_codes:
  - AMC
  - AMIK
  - AMP
  - AMPIC
  - AUG
  - AUGUM
  - AZYT
  - CEF
  - CEFAZ
  - CEFOT
  - CEFOX
  - CEFTA
  - CEPHR
  - CHLOR
  - CIPRO
  - CLIND
  - COTRI
  - CTX
  - ERYTH
  - GENT
  - GENTA
  - IMIP
  - NALID
  - NITRO
  - NORF
  - OXACI
  - PENG
  - PIPER
  - RIF
  - SXT
  - TETRA
  - TOBRA
  - VANCO
  # TB panel — verify these should remain here or branch separately
  - TBETM
  - TBISO
  - TBPYR
  - TBRIF
  - TBSTR

# Default guideline for susceptibility interpretation
default_guideline: CLSI
```

### Config validation

At startup the tool validates the config against a JSON schema. Missing or malformed config = hard fail before any DB connection.

### Loading order

1. CLI `--config` flag
2. Env var `DISA_MIGRATION_CONFIG`
3. Convention: `config/<country>.yaml` where country comes from `--country`

---

## 7. Flag taxonomy

Every flag has: `code`, `severity`, `target` (which field or sub-object), `message`, optional `context`.

Severities:
- **`warning`** — record is usable; v2 can accept it. Flag logged alongside the successful POST.
- **`quarantine`** — record is not safe to send; written to quarantine.jsonl instead of POSTed.

### Flag codes (initial set)

| Code | Severity | Trigger |
|---|---|---|
| `unknown_antibiotic_code` | warning | A LabResults row has `LIMSCodedValue` ∈ {S, I, R} but its `LIMSObservationCode` is not in the country antibiotic list. Row is routed to `lab_results` instead of `susceptibility_tests`. |
| `ast_without_isolate` | warning | AST rows present but no growth-positive isolate in the request. AST emitted with `isolate_index=null`. |
| `multiple_isolates_ambiguous_linkage` | warning | Request has >1 growth-positive isolate; AST linkage used nearest-OBR heuristic. |
| `organism_type_defaulted` | warning | Organism code wasn't in any known type list; defaulted to `'bacteria'`. |
| `censored_numeric_value` | warning | Result string contains `<`, `>`, `<=`, `>=` — numeric parse skipped. |
| `test_method_inferred` | warning | AST method inferred from `SIValue` presence without unit info. |
| `orphan_obr_set` | warning | LabResults row references an OBRSetID with no matching Requests row. |
| `garbled_facility_desc` | warning | `LIMSPointOfCareDesc` parse produced an empty or control-char-only result. |
| `unparseable_date` | quarantine | A required date field (`SpecimenDateTime`, `AuthorisedDateTime`) can't be parsed. |
| `missing_request_id` | quarantine | A LabResults row has null/empty RequestID. |
| `no_primary_panel` | quarantine | Couldn't select a primary panel — all OBR rows missing panel code. |
| `v2_validation_rejected` | quarantine | v2 API returned 4xx indicating schema violation. |
| `v2_transient_error` | (retry) | v2 returned 5xx or network error. Retry with exponential backoff; if still failing after N attempts, pause migration (do NOT quarantine — this is v2's problem, not the data's). |

The flag list is expected to grow as we encounter new edge cases. Adding a new flag should only require updating `flags/types.ts` and the relevant transform.

### Quarantine record shape

```json
{
  "request_id": "TZDISATBG0010168",
  "quarantined_at": "2026-04-23T14:30:00Z",
  "flags": [
    { "code": "unparseable_date", "severity": "quarantine", "target": "lab_request.authorised_at", "message": "...", "context": { "raw_value": "0000-00-00" } }
  ],
  "warnings": [
    { "code": "organism_type_defaulted", "target": "isolates[0].organism_type", "message": "Organism code 'XYZ' not in any type list" }
  ],
  "partial_record": { /* whatever transformation managed to produce */ },
  "source": {
    "requests_rows": [ /* raw Requests rows */ ],
    "lab_results_rows": [ /* raw LabResults rows */ ]
  }
}
```

Including raw source rows is intentional. A quarantine reviewer needs to see what DISA actually had, not just what the tool tried to do with it.

---

## 8. Resumability

### Checkpoint file

Path: `./checkpoint.json` (overridable via CLI flag). Written atomically (write to `.tmp`, rename) after each successful v2 POST.

```json
{
  "last_request_id": "TZDISATBG0010500",
  "last_request_id_sort_key": "TZDISATBG0010500",
  "processed_count": 50234,
  "quarantined_count": 127,
  "started_at": "2026-04-23T09:00:00Z",
  "updated_at": "2026-04-23T14:30:00Z",
  "config_hash": "sha256-of-loaded-country-config",
  "source_db": "openldr_tanzania_prod"
}
```

### Resume behavior

On start, if checkpoint file exists:
- Verify `config_hash` matches current config. If not, hard fail with instructions: reviewer must decide whether to restart from scratch or accept the mismatch (it might indicate someone added a new antibiotic code mid-migration, which is fine but worth confirming).
- Verify `source_db` matches. If not, hard fail.
- Begin the DISTINCT `RequestID` cursor with `WHERE RequestID > @last_request_id` ordered deterministically.

### Ordering

The DISTINCT RequestID cursor MUST use an ORDER BY on `RequestID` so resumption is deterministic. DISA's `RequestID` format (e.g., `TZDISATBG0010168`) sorts lexicographically in a useful order. Don't order by a timestamp field — timestamps aren't guaranteed unique.

### Interruption contract

- Ctrl+C: finish the current request's POST (or quarantine), write checkpoint, exit cleanly.
- Hard kill: worst case, the record being processed when killed is retried on next run. Because v2 POSTs must be idempotent by `request_id` on v2's side (documented dependency), this is safe.

**Dependency on v2:** the v2 POST endpoint for lab_request must be idempotent by `request_id`. If not, duplicate records will enter v2 on resume. This needs to be confirmed with the v2 team before production migration.

---

## 9. v2 API client

### Endpoint

`POST /api/v2/lab-requests` (actual path per OpenLDR v2 docs).

### Auth

Bearer token from Keycloak. Config via env: `OPENLDR_V2_URL`, `OPENLDR_V2_TOKEN` or OAuth client credentials flow (`OPENLDR_V2_CLIENT_ID` + secret).

### Retry policy

- **2xx:** success, advance checkpoint.
- **4xx (except 429):** treat as `v2_validation_rejected`, quarantine, continue.
- **429:** honor `Retry-After`, then retry indefinitely.
- **5xx, network errors:** exponential backoff (1s, 2s, 4s, 8s, 16s, 32s, 60s), then pause migration with a clear log message. Do not quarantine — this is v2's problem.

### Token refresh

If auth is OAuth client credentials, refresh ~60s before expiry. Don't let a long-running migration die because a token aged out.

---

## 10. CLI

```bash
# Start a new migration
disa-migrate run \
  --country tanzania \
  --source-db "Server=...;Database=openldr_tanzania_prod;..." \
  --target-api https://v2.openldr.example.com \
  --checkpoint ./checkpoint.json \
  --quarantine ./quarantine.jsonl

# Resume (same command; checkpoint detected automatically)
disa-migrate run --country tanzania --source-db "..." --target-api "..."

# Dry run: transform and print to stdout without POSTing
disa-migrate run --dry-run --limit 100 ...

# Stats on an in-progress or completed migration
disa-migrate stats --checkpoint ./checkpoint.json

# Replay quarantined records after fixing config
disa-migrate requeue --quarantine ./quarantine.jsonl --target-api ...
```

---

## 11. Observability

### Logs

Structured JSON logs to stdout. Levels: `debug`, `info`, `warn`, `error`.

Per-record log at `debug`: one line with RequestID, flag count, POST duration.
Per-batch log at `info`: every N records (default 100) — total processed, total quarantined, current rate (records/s), ETA.

### Metrics (optional, v1.x)

If OpenTelemetry is easy to wire in, emit:
- `disa_migration_records_processed_total{status}`
- `disa_migration_records_quarantined_total{flag_code}`
- `disa_migration_record_duration_seconds` (histogram)
- `disa_migration_v2_api_duration_seconds` (histogram)

Not a blocker for v1.

### Progress indicator

Plain stderr progress line when `process.stderr.isTTY`: `[ 52,341 / ~1,200,000 ] 4.4% | 127 quarantined | 340 rec/s | ETA 56m`. Total count comes from a cheap `SELECT COUNT(DISTINCT RequestID)` at startup.

---

## 12. Testing strategy

### Unit tests

- Transformation functions in isolation with hand-crafted Requests/LabResults fixtures.
- Fixtures as JSON files in `test/fixtures/` — one fixture per interesting scenario:
  - Simple HIV VL request
  - HIV VL with `VLID` metadata panel (verify primary panel selection)
  - Bacterial culture with single organism + single AST panel
  - Bacterial culture with multiple isolates
  - No-growth culture
  - AST without isolate (data quality edge case)
  - Censored viral load (`< 20`)
  - Request with unknown antibiotic codes
- Each fixture has an expected v2 JSON output + expected flag list.
- Snapshot tests where appropriate.

### Integration tests

- Small SQL Server container (Docker) seeded with a sample of anonymized DISA data.
- Mock v2 API (simple Express app that validates POST shape, returns 201).
- Run the full CLI end-to-end, assert checkpoint state and quarantine content.

### Real-data validation

- Before any country's production migration, run against a read-replica or restored snapshot in dry-run mode.
- Compare record counts: `SELECT COUNT(DISTINCT RequestID) FROM Requests` vs `processed_count + quarantined_count` at migration end.
- Sample 50 records by hand: verify the transformation matches expectations.

---

## 13. Known unknowns

Things we haven't resolved and Claude Code should NOT attempt to solve silently:

1. **Multi-isolate linkage.** The nearest-OBR-set heuristic is a defensible default but genuinely imperfect. If any country's DISA deployment uses a different convention (e.g., isolates and their AST in the SAME OBR set, or linkage via a panel-name prefix convention like `CULPU` paired with `SENPU`), the current rule will misassign AST to the wrong isolate. **Flag always; trust the reviewer.**
2. **Antibiotic code completeness.** The initial Tanzanian antibiotic list was derived from one distribution query. Mozambique and Kenya data may use codes not in the current list. The `unknown_antibiotic_code` warning catches these — expect to see warnings on first runs in new countries and use them to expand the YAML.
3. **`HL7ResultTypeCode` consistency.** DISA's use of `NM` vs `V` vs `R` is inconsistent across deployments. The numeric parsing logic is conservative — when in doubt, keep the string and flag.
4. **`TBxxx` codes.** The Tanzanian list includes TB drug susceptibility codes. Whether TB AST should go through the same `susceptibility_tests` array or a separate `mycobacterial_ast` structure is a v2 schema question — confirm with the v2 team before migrating a TB-heavy deployment.
5. **`HL7SectionCode = 'OTH'` panels.** These are metadata panels like `VLID`. Currently treated as `info_only_panels` in config. Whether any country has meaningful lab data filed under `OTH` needs verification per-deployment.
6. **Patient identity.** Deferred to v2's patient matching process. The `EncryptedPatientID` field in Requests is not used by this tool. Confirm this is acceptable with v2 team before first country migration.
7. **Date handling.** DISA stores local time. Some deployments may be mixing local-time and UTC in the same database if servers were moved. No detection for this — flag any suspicious dates during sample validation.

---

## 14. Out of scope (explicit non-goals)

- Patient record migration
- DBF file reading
- WHONET AMR interpretation
- Changes to v2 schema or API
- Parallel/sharded migration (possible future work)
- Bidirectional sync (this is a one-way, one-time migration per deployment)
- Historical DISA data correction
- Terminology mapping to LOINC/SNOMED (v2's concern)

---

## 15. Dependencies

### Runtime

- Node.js 20+
- TypeScript 5+
- `mssql` — SQL Server client with streaming support
- `yaml` — config parsing
- `zod` — config and schema validation
- `pino` — structured logging
- `commander` — CLI
- `undici` or `ky` — HTTP client

### Dev

- `vitest` — testing
- `tsx` — TypeScript execution without build
- `@types/node`, eslint config from the monorepo

### External

- OpenLDR v2 API running and reachable
- DISA SQL Server credentials (read-only user preferred)
- Country YAML config reviewed with in-country lab leads before first run

---

## 16. Rollout plan (operational, not code)

1. **Tanzania dry-run** against a snapshot. Review quarantine, refine YAML, re-run. Iterate until quarantine rate is acceptable (<5% target, but country-dependent).
2. **Tanzania production migration**. Monitor. Spot-check migrated records in v2.
3. **Zambia, Mozambique, Kenya** each follow the same pattern. Each country's YAML is its own artifact and may differ substantially.
4. **Post-migration**: each country's quarantine file is handed to the in-country data team for manual triage. Anything salvageable goes back in via `disa-migrate requeue` with an updated config.

---

## Appendix A: Example transformed record

See `docs/examples/` directory (to be populated with one representative record per scenario during implementation).

## Appendix B: DISA schema reference

Full `Requests` and `LabResults` CREATE TABLE statements included in `docs/disa-schema.sql`.

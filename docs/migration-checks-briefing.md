# CDR Toolchain — Migration Checks Briefing

> **Purpose of this document.** Background briefing for building a presentation
> about how the CDR toolchain decides whether a lab record is safe to migrate from
> DISA into OpenLDR v2. It explains *what* the tool checks, *how* each record is
> classified (pass / pass-with-anomalies / quarantine / check-failed / error),
> *how we arrived at those rules*, and *real examples* from production-scale runs.
>
> Source of truth: the code in `apps/cli/src/commands/export-batch.ts`,
> `apps/cli/src/audit/detector.ts`, the v1 comparators, git history (commit
> hashes quoted inline), and run logs from May 2026. Compiled 2026-10-14.
>
> **Note for the presenter:** individual lab numbers have been left out on
> purpose. Where an example refers to a specific record, it is described
> generically ("a sample lab"); the commits cited hold the traceable detail.

---

## 1. One-paragraph summary (elevator pitch)

The CDR toolchain migrates laboratory records from **DISA** (a legacy laboratory
information system, data stored in SQL Server with much of it packed in binary
"blobs") into **OpenLDR v2** (the new national lab data repository). Every record
passes through a fixed pipeline of gates. A record is only sent if (1) it matches
what the previous system, **OpenLDR v1**, already holds for the same lab
("fidelity check"), and (2) an automated **audit** finds no error-level data
problem. Records with minor problems are still sent but carry a machine-readable
`data_quality` label. Records with serious problems are **quarantined** — set
aside with a full report so a lab clerk can correct them at the source. Technical
failures are reported as **errors**. The rules were not designed in the abstract:
most were added or adjusted after running the tool against the full 129,408-lab
DISA database and investigating each cluster of failures.

---

## 2. The systems involved

| System | Role | Notes |
|---|---|---|
| **DISA** | Source. Legacy LIS used in labs (Tanzania `TDS…` and Zambia `ZUL…` data seen). | SQL Server. Results, registrations and dictionaries partly stored in binary blobs that the toolchain decodes (`packages/disalab`). Datetimes are local time with no timezone. Records **one specimen per request**. |
| **OpenLDR v1** | The previous national repository; has carried DISA data for 10+ years. | Used as the **reference** ("ground truth") for the fidelity check. Our copy is **partial** — many labs simply aren't in it. |
| **OpenLDR v2** | Target. New repository with an ingestion pipeline (validation → mapping → storage → outpost) running over Kafka. | Rejects records that fail its storage validation (e.g. missing specimen, empty request). Processing is asynchronous: an HTTP 200 on POST does not mean it was stored, so the tool optionally **tracks** each run to completion. |
| **OpenLDR CE** | Alternative target (FHIR). | Receives a FHIR transaction Bundle. Much more permissive than v2 — e.g. accepts a request with no specimen — so the toolchain's own gates matter more on this path. |
| **CDR toolchain (`cdr` CLI)** | This project. | Commands: `export` (one lab), `export-batch` (many labs), `audit` / `audit-batch` (scan only), `compare` (DISA vs v1), `audit-report` (PDF/DOCX/HTML for stakeholders). |

---

## 3. The decision pipeline — how one lab record is classified

Each lab number goes through these stages **in order**. The first stage that
fails decides the outcome; later stages don't run.

```
 ┌──────────────┐   ┌───────────────────┐   ┌──────────────────┐   ┌───────────┐   ┌──────┐   ┌──────────────┐
 │ 1. Fetch from│──►│ 2. v1 fidelity    │──►│ 3. Audit +       │──►│ 4. Build  │──►│5.POST│──►│ 6. Track v2  │
 │    DISA      │   │    check          │   │    quarantine    │   │  payload  │   │      │   │  pipeline run│
 └──────┬───────┘   └────────┬──────────┘   └────────┬─────────┘   └───────────┘   └──┬───┘   └──────┬───────┘
        │                    │                       │                                │              │
   not_found           check_failed             quarantined                       errored        errored
                                           (payload + report written         (HTTP / SQL /   (v2 accepted but
                                            to temp/quarantine/<lab>.json)    config failure)  processing failed)

 Otherwise →  posted                        (clean)
              posted + data_quality block   ("passed with anomalies": warn/info findings)
              deduplicated                  (v2 had already ingested this exact payload)
```

Important consequences:

- The **v1 check runs before the audit.** A record with *both* a v1 mismatch
  and a data-entry problem is reported as `check_failed`, not `quarantined`.
- **Both gates are on by default** in `export-batch`. They can be switched off
  with `--no-check` and `--no-quarantine`.
- The batch exits with code 0 **only** if every lab ended `posted` or
  `deduplicated`; otherwise it exits 9 (`API_REJECTED`) with a summary.
- The quarantine threshold is configurable: `--quarantine-severity error`
  (default), `warn` (stricter) or `info` (strictest).
- A batch can be resumed (`--resume-from`) — previously processed labs are
  skipped, so after lab staff fix quarantined records only those are retried.

### 3.1 Outcome reference table

| Outcome | Precise trigger | What happens to the record | Whose problem is it | Typical fix |
|---|---|---|---|---|
| `posted` | All gates passed, v2 accepted (and, with `--track`, finished processing). | In v2. | — | — |
| `posted` + `data_quality` | Audit found anomalies, but the worst one is **below** the quarantine threshold (default: only `warn`/`info`). | In v2, with a `data_quality` block listing each anomaly (class, severity, message). Queryable later. | Nobody is blocked; visible for later cleanup. | Optional cleanup in DISA or dictionaries. |
| `deduplicated` | v2 replied that this exact payload was already ingested. | Already in v2. | — | `--force` to re-process if needed. |
| `quarantined` | Audit's worst anomaly ≥ threshold (default `error`). | **Not sent.** File `temp/quarantine/<lab>.json` with the audit report and the would-be payload. Exit code 11 in single-lab mode. | The **lab** (source data). | Clerk corrects the record in DISA's UI, then re-run. |
| `check_failed` | DISA-derived record disagrees with OpenLDR v1, or v1 has no row for this lab. | **Not sent.** Field-level diff summary recorded in the NDJSON output. | Usually **us** (decoder bug) or an as-yet-unexplained v1 quirk. | Fix decoder, or add a justified comparator tolerance. |
| `not_found` | DISA has no registration (`REGDAT4`) row for the lab number. | Nothing to send. | — | — |
| `errored` | Something technical broke: SQL error, HTTP failure, missing config, or v2's pipeline reported failure after accepting the POST. | Not (successfully) stored. `error_code`, `error_message`, and for v2 failures `pipeline_error_stage/code/message`. | **Engineering** or the **v2 server**. | Code fix, config fix, or v2-side fix. |

### 3.2 Severity ladder

`info < warn < error`. Each audit anomaly class has a fixed severity (one class,
`panel_specimen_mismatch`, picks `warn` or `error` depending on evidence — see
§5.4). The record's `max_severity` is the worst anomaly found; that is compared
with the quarantine threshold.

Design intent behind the three levels:

- **error** — physically impossible, or certain to be rejected by v2 / certain to
  corrupt analytics. Must not migrate as-is.
- **warn** — suspicious, often a decoder or dictionary symptom; worth a human
  look but not worth blocking the migration.
- **info** — normal-but-notable; shown in totals so nothing is hidden.

---

## 4. Gate 1 — The v1 fidelity check (`check_failed`)

### 4.1 Why it exists

OpenLDR v1 has carried DISA's data for over a decade and is trusted by its users.
The DISA decoder in this toolchain is new. So the working assumption is:
**if our decoding disagrees with v1, assume we are wrong until we can explain the
difference.** The fidelity check is the safety net for decoder bugs — it catches
problems no audit rule would (e.g. results silently missing).

### 4.2 What it compares

Two levels, both must pass:

1. **Request level** (one per lab): facility name, ward, collection / received /
   taken dates, panel code, ICD-10 code, clinical information, etc. Any field in
   status `mismatch`, `only_disa` or `only_v1` fails the lab — unless a
   comparator for that field has an explicit, justified tolerance.
2. **Per-observation level** (each result): DISA results are matched to v1
   results. The lab fails if any result has a different value (`mismatch`) or if
   v1 has a result that DISA doesn't (`only_v1`).

Plus a special case: **"OpenLDR v1 has no Requests row for this lab"** —
`check_failed` because there is nothing to compare against. In our environment
this is expected, because our v1 copy is partial.

### 4.3 How the rules evolved — tolerances added from real data

A large part of the work after the first full run was separating **genuine
toolchain bugs** from **known v1 quirks**. Each tolerance below was added only
after investigating sample records, and each keeps genuine divergences visible.

| Tolerance (commit) | The evidence that justified it | What still fails |
|---|---|---|
| **Per-result `only_disa` is accepted** (`135ba4c`, 2026-05-14) | Three sample labs (results APTT, ORGS and SGLU) failed because DISA had a well-formed result that v1's old migration didn't carry — e.g. SGLU's faithfully decoded but clinically impossible 0.07 mmol/L glucose, which v1 sensibly dropped. A presence asymmetry, not a bug. | `only_v1` stays strict: it means *our decoder missed data*. Example: one sample lab was missing five HIV drug-resistance (HIVDR) results — a real decoder gap. |
| **Ward: DISA has it, v1 empty → match** | 5 labs: v1's migration dropped/emptied the combined "Facility~Ward" field. | A ward that differs on both sides. |
| **Received date: v1-only accepted** | Received date present only in v1 — shape confirmed by probing v1's database. | Other date disagreements. |
| **Facility name: DISA has it, v1 empty → match** (`056a7dd`, 2026-05-15) | **594 labs** in the full run. Same root cause as the ward case. Verified on a sample lab. | Partial-name divergences, e.g. DISA "KCMC CLINICAL LABORATORY" vs v1 "KCMC" — later handled by substring matching for 88 labs in `34e561f`. |
| **Panel re-runs: compare only the final iteration** (`a8ef852`, 2026-05-14) | DISA re-runs a panel by appending a higher `TESTINDEX` row (preliminary + final, or two-technician verification). v1 kept only the final run, so comparing DISA's preliminary value created false mismatches. v2 export was also sending both iterations. | Dropped iterations are recorded as an `info` anomaly (`panel_iterations_superseded`) so nothing is silently discarded. |
| **Collection time is the clinical time** (`87530af`, 2026-07-17) | 479 labs flagged `collected_at only_v1` + `taken_at mismatch`. Investigation showed the "taken" field we were using was garbage on **92.5%** of records; a result's effective time should be the collection time. | — |
| **Compare timestamps by wall clock, not instant** (`6f0622c`, 2026-08-02) | 5,174 "wall clock differs" findings: DISA stores local time without a timezone, while v1 serialises with a `Z` (falsely claiming UTC). Comparing absolute instants flagged identical local times as different. | Real time differences. |

### 4.4 The principle

> Add a tolerance only when the difference is proven to be **v1's** quirk, and
> keep it narrow enough that real divergences still surface.

---

## 5. Gate 2 — The audit (`quarantined` vs `posted` with `data_quality`)

### 5.1 Why it exists

Fixing a bad record **before** migration costs a lab clerk minutes in DISA's
UI. Fixing it **after** it reaches v2 means a forensic trace through v2's
pipeline, edits across several v2 tables, possibly retracting it from
dashboards — often hours plus an engineer and a domain expert. At national
scale even a 0.5% anomaly rate is ~25,000 records per 5 million labs. The audit
makes that cost visible and moves it to the cheap end.

The same detector runs in three places:

1. `cdr audit <lab>` — one record.
2. `cdr audit-batch` — whole-deployment scan with a summary, optional PDF/DOCX
   report and a **forecast** for the full deployment (`--total-labs`), so
   leadership gets a number *before* migration starts ("expect ~N mismatches;
   budget X weeks of lab-manager time").
3. Inside every `export` — payloads gain the `data_quality` block; the
   quarantine gate blocks error-level records.

It can also audit **already-migrated v1 data** (`--source openldr`) to show how
much of what's already in v1 would fail today's rules.

### 5.2 The 18 anomaly classes

#### Error — quarantined by default

| Class | What it detects | Example / rationale | Origin |
|---|---|---|---|
| `panel_specimen_mismatch` (uncorroborated) | Panel description implies one specimen kind, the recorded specimen is another, **and the panel has no results**. | Urine-microscopy panel on a stool specimen — a registration error. Catching it costs a minute pre-migration; post-migration it means undoing concept mappings and maybe retracting a dashboard. | Original set |
| `dob_after_specimen_date` | Date of birth after the earliest specimen date. | "Patient had blood drawn before being born" — usually a typo. Contaminates age-binned analysis. | Original set |
| `dob_future_dated` | Date of birth in the future. | Typically a transposed year. | Original set |
| `observation_wrong_panel` | Antimicrobial susceptibility (AST) results recorded inside a microscopy panel. | Clinicians would see "ciprofloxacin susceptibility" inside "rectal swab microscopy" and lose trust; v2 maps them to the wrong concept system. | Original set |
| `specimen_missing` | Real (non-documentation) panels ordered but no specimen recorded. | v2 storage **always** rejects these, so retries would fail forever. OpenLDR CE would silently accept them — on the CE path this gate is the only protection. | Original set; refined in `28e4aff` |
| `record_has_no_observations` | Panels ordered but **zero** results across the whole record (not rejected, not documentation). | **Born from the full-DB run:** 1,276 labs were rejected by v2 with `CANONICAL_STORAGE_VALIDATION_FAILED`, all with this shape. The existing `orphan_ordered_panel` was only `info` (legitimate when *some* panels have results), so it couldn't catch them. Confirmed on 5 sample labs. | `1ab478e`, 2026-05-15 |

#### Warn — migrated, flagged in `data_quality`

| Class | What it detects | Why it matters |
|---|---|---|
| `panel_specimen_mismatch` (corroborated) | Same mismatch, but the panel **did** produce results — evidence the test really ran on a different specimen than the one recorded. | See §5.4 (Zambia case). Migrated with the specimen tagged in a special namespace instead of quarantined. |
| `cross_panel_duplicate_observation` | Same result code under several panels whose specimen kinds don't overlap. | Suggests a result attached to the wrong panel at entry. |
| `result_unrealistic_numeric` | Numeric value > 10¹² or < 10⁻⁶ (zero excluded). | Almost always uninitialised memory read from a mis-decoded blob slot. Would wreck min/max/mean dashboards. |
| `result_contains_control_chars` | Stray control bytes (0x01–0x1F, except tab/LF/CR) in a result. | A decoder signal: a slot is reading the wrong bytes for that record type. |
| `result_format_microscopy_count` | WBC/RBC/leucocyte/epithelial value not in a recognised count/range/semi-quantitative format. | Free text in a structured field; v2 can store it but can't aggregate it. |
| `result_format_invalid_decoded` | Coded result decodes to "Invalid" outside susceptibility testing. | Usually a site-wide dictionary (COMMDICT) typo affecting hundreds of records — fix once in the dictionary. |
| `sex_code_invalid` | Sex code not in M / F / U / I / blank. | Catches "Make", "Femal", stray characters. Cheap to fix in DISA, expensive in v2 demographics. |

#### Info — migrated, visible in totals

| Class | What it records | Origin |
|---|---|---|
| `orphan_ordered_panel` | A panel ordered with no results while others have results. Normal (sample lost, test not done). | Original set |
| `specimen_description_vague` | Specimen description doesn't match any known kind — tells engineers the specimen vocabulary needs a new term. | Original set |
| `result_format_units_inline` | Units typed into the value although the dictionary supplies them. Cosmetic. | Original set |
| `panel_iterations_superseded` | An earlier run of a re-run panel was dropped; kept for transparency. | `a8ef852`, 2026-05-14 |
| `record_rejected` | The lab rejected the sample (e.g. "Unsuitable for testing"); empty by design. Sent to v2 with result status `X`. | `b8416de`, 2026-06-05 |
| `routed_as_form` | Documentation panels (forms/questionnaires, e.g. ARTID) sent to the forms feed rather than the lab feed. | `28e4aff`, 2026-06-05 |

### 5.3 Remediation lanes (who fixes what)

Each anomaly class points to one clear owner:

| Lane | Examples | Who |
|---|---|---|
| Data-entry error | panel/specimen mismatch, DOB errors, wrong panel, missing specimen | Lab clerk, in DISA's UI |
| Decoder bug | unrealistic numerics, control characters | Toolchain engineers |
| Dictionary typo | "Invalid" decoded results | One-time update to the site dictionary (COMMDICT) |
| Genuine clinical edge case | legitimate cross-specimen pairs (swab↔pus, swab↔tissue, swab↔genital) | Whitelisted in the specimen vocabulary (`KIND_COMPATIBLE`) — only when real data proves a false positive |

### 5.4 Stories where a rule was **softened** because real data was legitimate

These are the clearest illustration of *how* the rules were tuned: strict by
default, relaxed only on evidence, never by inventing data.

**1. Rejected samples (`b8416de`, 2026-06-05).**
A sample marked "Unsuitable for testing" has ordered panels and no results, so
the new `record_has_no_observations` rule quarantined it as clinically empty.
DISA stores the rejection as special observations (RJREA / RJREM, e.g.
RJREA = "Unsuitable for testing" / code UNS) that the flattening step strips, so
the record *looked* empty. Fix: detect rejection (specimen condition set, or any
panel carries RJREA/RJREM), emit `record_rejected` at `info` instead, and send to
v2 with result status `X` and the ordered panel code. A rejected sample is a
real, reportable outcome — not a defect.

**2. Documentation-only records (`28e4aff`, 2026-06-05).**
Some DISA "panels" are forms (e.g. ART identification data), not lab tests. They
have no specimen and often no results, and were tripping `specimen_missing` and
the empty-record rule. Fix: identify documentation panels from configuration,
route them to a separate **forms feed**, and only apply the specimen rule to real
test panels. A record can be "split": a lab leg plus a forms leg.

**3. The multi-specimen order — a Zambian record (design 2026-06-12).**
One request ordered blood panels (FBC, differential, LFT, U&E) **and** CSF
panels (CSF microscopy, culture, chemistry, CrAg). DISA can store only **one
specimen per request**, so everything was recorded under "Blood". The audit saw
"CSF: MICROSCOPY" on a blood specimen → `panel_specimen_mismatch` at `error` →
quarantine. But the CSF panels had real CSF results ("Clear colourless fluid",
CSF glucose/protein/chloride) — the tests genuinely ran on CSF. v1 had carried
this record, mislabelled the same way, for 10+ years.
Hard constraint: **no fabrication** — the CSF specimen was never recorded
anywhere, so we may not assert it. Resolution:
- If the mismatched panel produced results (*corroborated*), severity drops to
  `warn` and the record migrates.
- The specimen keeps its recorded value ("Blood") but is tagged with the coding
  system `DEFAULT_SPEC_ANOMALY`, making every such collision queryable in v2.
- If the panel has no results (*uncorroborated*), it stays `error`.
- **Operational dependency:** the `DEFAULT_SPEC_ANOMALY` coding system must be
  seeded in the production v2 database first, otherwise v2 rejects these
  records with `UNKNOWN_CODING_SYSTEM`.

---

## 6. `errored` — technical failures

| Error | Meaning | Real example |
|---|---|---|
| `UNKNOWN` | An exception was thrown before/during POST (not a v2 rejection). | **152 labs** in the first full run: 150 × SQL Server "Unclosed quotation mark…", 2 × "invalid name … NULL character". Root cause: DISA values (lab numbers, locations, and especially **result comments containing apostrophes**) were inserted into SQL queries unescaped. A wider search found **10** such places across three files. Fixed in `07babd9` with an escape helper (doubles apostrophes, strips NUL padding). All 5 sample labs that had failed succeeded afterwards. |
| `API_REJECTED` with pipeline code `CANONICAL_STORAGE_VALIDATION_FAILED` | v2 accepted the POST, then its storage stage rejected the record. | **1,276 labs** — clinically empty records. Converted into an audit rule so they are now quarantined *before* sending (see `record_has_no_observations`). An earlier fix (`f62f36b`) covered a different cause: a missing facility display name when the location dictionary has no entry. |
| `API_REJECTED` with `EXTERNAL_PERSISTENCE_FAILED` | v2's downstream persistence failed. | 12 labs in the first run; likely a transient v2-side issue. Not seen in the rerun; never root-caused. |
| `API_REJECTED` with `UNKNOWN_CODING_SYSTEM` | v2 doesn't know a coding system we sent. | Would occur for multi-specimen records if `DEFAULT_SPEC_ANOMALY` isn't seeded. |
| `OPENLDR_CONFIG_MISSING` | v1 check enabled but no v1 connection string. | Configuration. |
| `API_CONFIG_MISSING` | Record has documentation (forms) data but no forms feed is configured. | Configuration. |

A recurring lesson: **when the same v2 rejection repeats across many records,
turn it into an audit rule** so it's caught locally, explained in plain language,
and fixed once at source — instead of failing on every retry.

---

## 7. How we arrived at these rules — the method

1. **Initial rule set (before 2026-05-08).** 14 audit classes written from known
   DISA data-entry and decoding failure modes, plus the v1 fidelity comparison.
   (These predate the repository's squashed initial commit; the rationale is in
   the README's anomaly catalogue.)
2. **Small probe.** Run ~500 labs end-to-end. Example result after one fix:
   465 posted, 29 quarantined, 6 check_failed (5 × no v1 row + 1 real decoder
   issue).
3. **Full-database run.** All 129,408 `TDS…` labs, concurrency 20, ~1h 35m.
   Failures that were invisible at 500 labs appeared at scale.
4. **Bucket and histogram.** Group failures by shape (error code, which fields
   disagree, how many results differ) and rank by count.
5. **Probe samples.** For each bucket, take ~5 sample labs and diff their
   payload against a **passing neighbour** lab (the adjacent lab number that posted cleanly)
   to isolate the field responsible. Ask v2 which pipeline stage rejected it.
6. **Classify the root cause** into one of three:
   - **Our bug** → fix the code (e.g. SQL escaping, collection time).
   - **v1's quirk** → add a narrow, justified comparator tolerance.
   - **Bad or special source data** → add/adjust an audit rule with the right
     severity (quarantine it, or let it through with a label).
7. **Verify** on the same sample labs, check the passing neighbour is unchanged,
   then rerun.
8. **Soften only on evidence; never fabricate.** Severity is lowered only when
   real records prove the pattern legitimate (rejected samples, forms,
   multi-specimen orders). Missing information is flagged, never invented.

Every rule change is a reviewed code commit — the specimen vocabulary is
deliberately kept in TypeScript under code review rather than a loose config
file.

---

## 8. The numbers — before and after

### First full run (2026-05-14), 129,408 labs

| Outcome | Count | % |
|---|---:|---:|
| posted | 94,386 | 72.9% |
| check_failed | 33,223 | 25.7% |
| errored | 1,440 | 1.1% |
| quarantined | 359 | 0.3% |

Breakdown:
- check_failed: 31,138 no v1 row (expected — partial v1 copy); 1,231
  request-level mismatches; 854 per-result mismatches.
- errored: 1,276 `CANONICAL_STORAGE_VALIDATION_FAILED`; 152 `UNKNOWN` (SQL
  escaping); 12 `EXTERNAL_PERSISTENCE_FAILED`.

Request-level mismatch shapes (1,231): 594 facility name only in DISA · 479
collection/taken time issues · 87 facility name mismatch · 28 clinical info only
in v1 · 20 ward mismatch · 19 collection+taken only in v1 · 3 panel code ·
1 ICD-10.

Per-result mismatch shapes (854): dominated by `only_v1` (DISA missing 1–3
results v1 has: 314 + 211 + 20 labs) → decoder gaps; ~80 labs with exactly one
value disagreement.

### Rerun the next day (2026-05-15), same 129,408 labs

| Outcome | Count |
|---|---:|
| posted | 95,462 |
| quarantined | 1,639 |
| check_failed | 32,307 |
| **errored** | **0** |

Story for a slide: **errors went from 1,440 to 0.** The 152 SQL errors were
fixed in code; the 1,276 v2 rejections became quarantines — caught *before*
sending, with a human-readable explanation, instead of failing inside v2. The
remaining `check_failed` is overwhelmingly the partial-v1 case.

Later fixes (July–August 2026: collection time, wall-clock comparison) addressed
further fidelity buckets; a fresh full-run count after those fixes is not
recorded in this repo.

---

## 9. Still open / caveats (be honest on slides)

- **Per-result decoder gaps (`only_v1`)** — the ~854-lab bucket has no
  dedicated fix commit; likely still partly open.
- Small request-level buckets (clinical info 28, ward mismatch 20, panel code 3)
  have no dedicated fix commit.
- `EXTERNAL_PERSISTENCE_FAILED` (12 labs) was never root-caused.
- **ARTID forms mapping** is configured but untested — the local DISA database
  has no authorised ARTID record; needs a larger database restore.
- **`DEFAULT_SPEC_ANOMALY`** must be seeded in production v2 before migrating
  multi-specimen records.
- Rejected-sample handling: when it was committed, posting a populated panel
  code with empty results to *live* v2 still needed confirmation.
- Accepted known quirks: the same organism in several panels counts as separate
  isolates (no de-duplication); DISA times are local with no timezone; the
  v1-format export's age-in-days can be off by one.
- The full-run numbers are from May 2026; the rule set has evolved since.

---

## 10. Suggested slide narrative (optional)

1. **The problem** — a large volume of legacy lab records; mistakes are cheap to
   fix before migration, expensive after.
2. **The pipeline** — diagram from §3; the possible outcomes.
3. **Gate 1: trust but verify against v1** — why v1 is the reference; how
   tolerances were earned (facility-name example: 594 labs).
4. **Gate 2: the audit** — severity ladder; a few vivid examples (born after
   the blood draw, ciprofloxacin inside a microscopy panel, 10¹² values).
5. **Pass vs quarantine vs error** — table from §3.1; who owns each.
6. **How the rules were made** — the bucket → probe → classify → verify loop (§7).
7. **Three stories of softening a rule** — rejected samples, forms, the Zambia
   blood+CSF order (§5.4). Principle: never fabricate.
8. **Results** — 1,440 errors → 0; remaining failures are explained (§8).
9. **What's left** — §9.

---

## 11. Glossary

| Term | Meaning |
|---|---|
| Lab / lab number | One DISA request (registration), identified by a lab number. |
| Panel | An ordered test (e.g. FBC, CSF microscopy). |
| Observation / result | One measured value within a panel. |
| Specimen | The sample type (blood, urine, CSF, …). DISA stores one per request. |
| Blob | Binary-packed DISA data the toolchain decodes. |
| COMMDICT / PARMDICT / LOCNDIC4 | DISA dictionaries: coded comments/results, parameters (tests), locations. |
| Fidelity check | Comparison of the DISA-derived record with what OpenLDR v1 holds. |
| `only_disa` / `only_v1` / `mismatch` | Value present only in DISA / only in v1 / present in both but different. |
| Audit / anomaly | Rule-based data-quality scan and its findings. |
| `data_quality` block | Section added to a v2 payload listing anomalies; absent for clean records. |
| Quarantine | Record withheld from sending; saved with its audit report for review. |
| Corroborated | A mismatched panel that has results — evidence the test really ran. |
| `DEFAULT_SPEC_ANOMALY` | v2 coding system marking a specimen that may not apply to all its panels. |
| Forms feed | Separate v2 feed for documentation/questionnaire data (not lab results). |
| NDJSON | One JSON object per line — the batch's per-lab output log. |

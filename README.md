# CDR Toolchain

End-to-end tooling for migrating DISA\*Lab data into OpenLDR v2. Read DISA's native blob schema, transform records into the v2 contract, and POST them to the v2 API — with a fidelity gate, a data-quality audit, and resumable batch orchestration in front of every send.

Built for PEPFAR-funded sites where DISA\*Lab is being phased out. Designed to be deployment-agnostic: country-specific code semantics come from DISA's own dictionaries, not from per-country YAML.

For the original product spec see [`docs/PRD.md`](docs/PRD.md). For deeper architectural notes see [`CDR_TOOLCHAIN.md`](CDR_TOOLCHAIN.md). This README is for operators and engineers who need to set up the CLI, run a migration, and understand what each command actually does.

---

## Disclaimer

**This is not an official LST product.** It is not built, endorsed, supported, or maintained by LST (the vendor that created DISA\*Lab). It is an independent, third-party tool.

The DISA blob format is undocumented externally. The decoder in this repo was reverse-engineered the hard way: running **MS SQL Server Profiler** against a live DISA\*Lab instance, observing the writes triggered by each UI action, and **manually tracing how each field, dictionary, and event lands in the underlying tables** (`REGDAT4`, `TESTDATA`, `TXT1DATA`, `AUDTDATA`, `PARMDICT`, `COMMDICT`, `LOCNDIC4`, `TESTDICT`, `USERDIC6`). Every byte offset and dictionary lookup in [`packages/disalab/`](packages/disalab/) was derived from that observation work, then validated by diffing decoded output against an existing OpenLDR v1 mirror until 100 % fidelity was reached across thousands of labs.

Claude (Anthropic's AI assistant) was used **after** the core decoder and transform were built, to iron out edge-case bugs — date/timezone handling, stray control characters in decoded strings, off-by-one quirks, audit-rule refinement, and similar. The architecture, schema discovery, blob decoding, and migration design are not Claude's work; they are the product of profiling, tracing, and manual schema reconstruction.

**Use at your own risk.** This tool was built for one specific purpose: migrating DISA\*Lab data into OpenLDR v2 for sites being phased off DISA. It is not a general-purpose DISA SDK, not a backup tool, not a clinical reporting tool, and not certified for any regulatory use. It does not write to DISA — only reads — but it makes no guarantees about completeness, correctness, or fitness for any other purpose. Verify against your own data before relying on its output for production decisions.

If your organisation needs an officially supported integration with DISA\*Lab, contact LST.

---

## Table of contents

1. [Why this exists](#why-this-exists)
2. [What's in the box](#whats-in-the-box)
3. [Setup](#setup)
4. [Running the CLI](#running-the-cli)
5. [Quick start](#quick-start)
6. [CLI command reference](#cli-command-reference)
7. [The audit subsystem — what it catches and why it matters](#the-audit-subsystem--what-it-catches-and-why-it-matters)
8. [POST integration (`--post`)](#post-integration---post)
9. [Configuration reference](#configuration-reference)
10. [Exit codes](#exit-codes)
11. [Gotchas](#gotchas)

---

## Why this exists

DISA\*Lab is a Laboratory Information System that stores data in a custom binary blob schema inside SQL Server (`REGDAT4`, `TESTDATA`, `TXT1DATA`, `AUDTDATA`, plus dictionaries `PARMDICT` / `COMMDICT` / `LOCNDIC4` / `TESTDICT` / `USERDIC6`). OpenLDR v2 is the modern target — a REST API that takes structured JSON and routes it through a validation/mapping/storage/outpost pipeline.

There is no off-the-shelf bridge between the two. Without this toolchain, a migration looks like:

- Hand-write a SQL Server blob decoder and hope you got the byte offsets right.
- Hand-write a transform from a hundred-plus DISA fields into the v2 schema, with no way to know whether your transform is correct except "it looks plausible."
- Manually POST each lab and lose an unknowable number to network blips, expired tokens, and silent server-side dedup.
- Discover months later that 10 % of the migrated data is meaningless because a panel/specimen mismatch in DISA flowed straight through, and now those rows are wired into dashboards that decision-makers are already using.

That last point is the expensive one. **Once bad data is in v2, the cost to fix it goes up by an order of magnitude** — you have to reverse-trace from v2 storage back through the mapper, undo the concept-id assignments, find the source row in DISA, fix it there, then re-migrate. If it's already in someone's dashboard, you also have to retract.

This toolchain exists so that does not happen. Concretely:

| Problem                                  | What this toolchain provides                                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Reading DISA's binary blobs              | A lossless decoder ([`packages/disalab/`](packages/disalab/)) — audited at 100 % fidelity vs an existing v1 mirror across thousands of labs.                                                                       |
| Knowing the transform is correct         | A request-level + per-observation diff (`compare`, `compare-results`, `compare-batch`) and a `--check` gate on `export` that refuses to ship until the new transform matches the legacy v1 mirror byte-for-byte.   |
| Catching bad data **before** it migrates | A pre-flight audit (`audit`, `audit-batch`) with 14 anomaly classes covering data-entry errors, decode bugs, dictionary typos, and impossible values. Same detector also runs retroactively against the v1 mirror. |
| Blocking bad data at the API door        | `--quarantine-on-anomaly` writes flagged labs to disk with a full audit report and refuses to POST them. The clean labs flow through.                                                                              |
| Reliable, resumable bulk migration       | `export-batch` with Keycloak token refresh, retry/backoff, server-side dedup awareness, `--force` replay, run tracking, concurrent POSTs, heartbeat progress, and `--resume-from` journalling for multi-hour runs. |
| Visibility for stakeholders              | `audit-report` renders PDF / DOCX / Markdown / HTML reports with severity breakdown, top affected panels, methodology, and a forecast that projects per-lab anomaly rates from a sample to the full deployment.    |

In short: the CLI exists to turn migration from a leap-of-faith into a measurable, gated, resumable engineering exercise.

---

## What's in the box

```
cdr-toolchain/
├── apps/
│   ├── cli/        # @cdr-toolchain/cli — the `cdr` command (this README's main subject)
│   └── api/        # @cdr-toolchain/api — Express scaffold (stub, not used by the migration flow)
├── packages/
│   └── disalab/    # DISA blob decoder (REGDAT4 / TESTDATA / dictionaries)
└── docs/
    └── PRD.md      # original product spec
```

Tooling: pnpm 10.33+ workspace, Node ≥ 18.19 (built-in `fetch`), TypeScript 5+ strict ESM, `mssql` (with `tedious` driver) for SQL Server connectivity.

---

## Setup

```bash
# 1. Clone + install
git clone <this-repo>
cd cdr-toolchain
pnpm install

# 2. Configure the CLI
cd apps/cli
cp .env.example .env
# Edit .env — at minimum set DISA_CONNECTION_STRING.
# Set OPENLDR_V1_CONNECTION_STRING if you want to use `compare` or `export --check`.
# Set OPENLDR_V2_URL + Keycloak (or OPENLDR_V2_TOKEN) if you want `export --post` to send.

# 3. Build the disalab package (CLI imports compiled output)
pnpm --filter disalab build

# 4. Smoke test
pnpm dev ping
# → {"ok":true,"driver":"mssql","elapsed_ms":46}
```

If `ping` fails with `DB_CONNECT_FAILED`, your `DISA_CONNECTION_STRING` is wrong or the SQL Server isn't reachable. The error JSON includes the underlying mssql message.

### Connection-string formats

Both DISA and OpenLDR v1 connection strings accept either form:

```
Server=hostname;Database=DBName;User=user;Password=pass;Encrypt=false
mssql://user:pass@hostname:1433/DBName
```

`cdr config show` redacts passwords in the output (`pwd=***`, `://user:***@host`); logs follow the same convention.

---

## Running the CLI

Three equivalent invocations:

```bash
# (a) From inside apps/cli — easiest for daily use:
cd apps/cli
pnpm dev <subcommand> [args]

# (b) From the repo root via filter:
pnpm --filter @cdr-toolchain/cli dev <subcommand> [args]

# (c) After building, run the bundled JS:
pnpm --filter @cdr-toolchain/cli build
node apps/cli/dist/index.js <subcommand> [args]
```

**Don't run `pnpm dev <subcommand>` from the repo root** — that's Turbo's recursive form; it runs every workspace's `dev` script and eats `--`-prefixed args.

---

## Quick start

```bash
# Reachability + config check
pnpm dev ping
pnpm dev config show

# Inspect what entities the CLI knows about
pnpm dev tables
pnpm dev schema registration

# Pull one lab's full record (richest single-lab view)
pnpm dev specimen <labNumber> --output json

# Build a v2 payload to stdout
pnpm dev export <labNumber>

# Build it to a file (avoids pnpm's lifecycle banner polluting stdout on Windows)
pnpm dev export <labNumber> --output json --out ./out.json

# Audit one lab — does it have anomalies a human should look at first?
pnpm dev audit <labNumber>

# Preview a POST without sending (confirms URL, token source, X-DataFeed-Id)
pnpm dev export <labNumber> --post --dry-run-post

# When you're ready: full pipeline with v1-fidelity gate, audit gate, and run tracking
pnpm dev export <labNumber> --post --check --track
```

> **Pick a clean lab from your own dataset to verify with first.** Run `audit` on it to confirm it's anomaly-free, and `compare` against your v1 mirror (if you have one) to verify the transform is byte-for-byte correct before you trust bulk runs.

---

## CLI command reference

Every command emits JSON on **stdout**, structured errors `{"error":{"code":"…","message":"…","details":{…}}}` on **stderr**, and uses deterministic exit codes ([table below](#exit-codes)). Output format is governed by the global `--output` flag.

### Global flags

| Flag                                 | Purpose                                                                                     |
| ------------------------------------ | ------------------------------------------------------------------------------------------- |
| `--cs` / `--connection-string <url>` | DISA MSSQL connection (overrides env)                                                       |
| `--openldr-cs <url>`                 | OpenLDR v1 MSSQL connection (used by `compare`, `export --check`)                           |
| `--env-file <path>`                  | Path to `.env` (default `./.env`)                                                           |
| `--output <fmt>`                     | `ndjson` (default, single-line) \| `json` (indented) \| `pretty` (`util.inspect` w/ colors) |
| `--no-color`                         | Disable ANSI colors                                                                         |
| `--quiet`                            | Suppress informational stderr output                                                        |
| `--log-level <lvl>`                  | `error` \| `warn` \| `info` (default) \| `debug`                                            |

### Health & introspection

| Command               | What it does                                                                  |
| --------------------- | ----------------------------------------------------------------------------- |
| `cdr ping`            | Open + close a DB connection — quick reachability check.                      |
| `cdr config show`     | Print the effective config (passwords redacted).                              |
| `cdr tables`          | List entities the CLI knows about (alias + class + table path).               |
| `cdr schema <entity>` | Schema + field documentation for one entity (e.g. `cdr schema registration`). |
| `cdr errors`          | Enumerate every CliError code, exit code, and description.                    |

### Raw row access

These walk DISA entities directly. `--where` pushes the filter into SQL when the entity has a SQL cursor column; otherwise it filters post-hydration.

```bash
cdr list <entity> [--where SQL] [--limit N] [--offset N] [--fields csv] [--explain]
cdr get <entity> [--where SQL]                     # exactly-one-row fetch
cdr stream <entity> [--where SQL]                  # NDJSON stream over a cursor
cdr count <entity> [--where SQL]                   # row count
```

```bash
pnpm dev list registration --where "WHERE LabNumber LIKE 'XYZ%'" --limit 50
pnpm dev get registration --where "WHERE LabNumber='<labNumber>'"
pnpm dev stream regdat4 --where "WHERE PatientID IS NOT NULL" > regdat.ndjson
pnpm dev count regdat4 --where "WHERE LabNumber LIKE 'XYZ%'"
```

### DISA-specific

```bash
cdr specimen <labNumber>          # Fetch one SpecimenRecpt — the richest single-lab view
cdr probe-bytes <labNumber>       # Brute-force scan of REGDAT4_STATUS for date patterns (reverse-engineering)
```

### Compare — fidelity audit (DISA ↔ OpenLDR v1)

Use these when migrating a deployment that already has an OpenLDR v1 mirror. They prove the transform produces byte-for-byte the same data the v1 ETL produced. Currently 100 % fidelity in the reference deployment.

```bash
cdr compare <labNumber>                    # 13-field request-level diff
cdr compare-results <labNumber>            # per-observation diff
cdr compare-batch [--where SQL] [--limit N] [--offset N] [--results]
                   [--include-empty] [--summary-only] [--only-differences]
                   [--explain]
```

Common flags:

- `--prefix <str>` — override `OPENLDR_LABNO_PREFIX` (empty by default; set per deployment, e.g. `TZDISA` for Tanzania, empty for Zambia).
- `--only-differences` — hide perfect-match fields/rows.
- `--explain` — print the SQL plan and exit without hitting either DB.

```bash
pnpm dev compare <labNumber> --only-differences
pnpm dev compare-batch --where "WHERE [LabNo] LIKE 'XYZ%'" --limit 5000 --results --summary-only
```

### Audit — data-quality detection

See [the dedicated section below](#the-audit-subsystem--what-it-catches-and-why-it-matters) for the full anomaly catalogue.

```bash
cdr audit <labNumber> [--source disa|openldr] [--prefix <str>] [--openldr-cs <url>]
cdr audit-batch [--source disa|openldr] [--where SQL] [--limit N] [--offset N]
                 [--summary-only] [--only-anomalies] [--explain]
                 [--report-out <path>] [--total-labs <n>] [--report-title <str>]
                 [--report-format pdf|docx|md|html] [--report-max-samples <n>]
cdr audit-report --input <ndjson> --out <path>
                  [--format pdf|docx|md|html] [--total-labs <n>] [--title <str>]
```

```bash
# One lab — DISA source (default)
pnpm dev audit <labNumber>

# One lab — retroactively against the v1 mirror
pnpm dev audit <labNumber> --source openldr

# Batch, only print labs with anomalies
pnpm dev audit-batch --where "WHERE [LabNumber] LIKE 'XYZ%'" --only-anomalies

# One-shot scan + render PDF report inline, with forecast for full deployment
pnpm dev audit-batch --limit 50000 \
  --report-out ./preview.pdf \
  --total-labs 5000000 \
  --report-title "Pre-migration data-quality preview"

# Render PDF from an existing NDJSON stream
pnpm dev audit-report --input ./scan.ndjson --out ./report.pdf --total-labs 5000000
```

Performance: ~0.10 s/lab on `--source disa` (per-lab blob hydration), ~0.015 s/lab on `--source openldr` (flat columns, no decode). A 50,000-lab DISA scan completes in roughly 55 minutes on a single thread.

### Export — DISA → v1 / v2 (single lab)

The data-shaping half of the migration. Default is v2; `--type v1` produces the legacy mirror shape.

```bash
cdr export <labNumber>
  [--type v1|v2]                    # default v2
  [--check]                         # require diffRecord + diffResults to match v1 first
  [--out <path>]                    # write to file instead of stdout
  [--openldr-cs <url>]              # only used by --check
  [--prefix <str>]                  # override OPENLDR_LABNO_PREFIX
  # --post flow (v2 only):
  [--post]
  [--target-api <url>] [--token <bearer>] [--api-path <path>]
  [--data-feed-id <uuid>]
  [--project-name <name>] [--use-case-name <name>] [--data-feed-name <name>]
  [--dry-run-post]                  # preview the prepared HTTP request
  [--force]                         # append ?force=true to bypass server-side dedup
  [--insecure-tls]                  # skip TLS cert verification (self-signed local dev)
  [--track]                         # poll /api/v1/runs/{messageId} until terminal
  [--track-timeout <ms>] [--track-interval <ms>]
  # audit + quarantine (v2 only):
  [--no-data-quality]               # suppress the data_quality block in output
  [--quarantine-on-anomaly <path>]
  [--quarantine-severity error|warn|info]   # threshold (default error)
```

```bash
# Build v2 payload, write to file
pnpm dev export <labNumber> --output json --out ./out.json

# Build v1 payload (legacy mirror shape — for diagnostics)
pnpm dev export <labNumber> --type v1 --output json --out ./out.v1.json

# Belt-and-braces: v1 fidelity check, then POST, then poll the run to terminal
pnpm dev export <labNumber> --post --check --track

# Preview a POST without sending
pnpm dev export <labNumber> --post --dry-run-post

# Force re-process of a payload v2 already deduplicated
pnpm dev export <labNumber> --post --track --force

# Send to a one-off target (e.g. staging)
pnpm dev export <labNumber> --post \
  --target-api https://staging.openldr.example.com \
  --token <bearer> --insecure-tls

# Block high-severity audit anomalies from POSTing
pnpm dev export <labNumber> --post \
  --quarantine-on-anomaly ./quarantine \
  --quarantine-severity error
```

The v2 payload shape is documented in [`temp/default.schema.example.json`](temp/default.schema.example.json) and [`CDR_TOOLCHAIN.md`](CDR_TOOLCHAIN.md). At a high level it carries `patient`, `lab_request`, `lab_results[]`, `isolates[]`, `susceptibility_tests[]`, and (when the audit finds anomalies) a `data_quality` block.

### Export — bulk (`export-batch`)

Per-lab POST orchestration for many labs. Both gates (`--check` for v1 fidelity, `--quarantine-on-anomaly` for audit anomalies) are **on by default** — clean matching data is the goal of the migration.

```bash
cdr export-batch
  [--where <sql>] [--limit <n>] [--offset <n>] [--prefix <str>]
  [--concurrency <n>]              # default 1; raise to test API rate limit
  [--no-check]                     # skip v1 fidelity check
  [--no-quarantine]                # skip audit-driven quarantine
  [--quarantine-dir <path>]        # default ./temp/quarantine
  [--quarantine-severity <level>]  # error (default), warn, info
  [--openldr-cs <url>]             # required when --check is on
  # POST config (same as `cdr export --post`):
  [--target-api <url>] [--token <bearer>] [--api-path <path>]
  [--data-feed-id <uuid>]
  [--project-name ...] [--use-case-name ...] [--data-feed-name ...]
  [--insecure-tls] [--force]
  [--track] [--track-timeout <ms>] [--track-interval <ms>]
  # Operational:
  [--resume-from <path>]           # skip lab numbers seen in this prior NDJSON
  [--dry-run]                      # run gates + build payload, skip POST
  [--summary-only]                 # suppress per-lab stdout
  [--explain]                      # show config, exit
```

Per-lab status (one NDJSON line per lab on stdout):

| status         | Meaning                                                                                                                           |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `posted`       | New POST accepted by v2 (HTTP 2xx).                                                                                               |
| `deduplicated` | v2 returned 200 with `deduplicated: true` — same payload was already ingested. Use `--force` to re-process.                       |
| `quarantined`  | Audit's `max_severity` met `--quarantine-severity` threshold; payload + audit report written to `--quarantine-dir`. POST skipped. |
| `check_failed` | `--check` found v1-fidelity drift; POST skipped.                                                                                  |
| `not_found`    | DISA had no REGDAT4 row for the lab number.                                                                                       |
| `errored`      | Fetch / build / POST / track failed. `error_code` + `error_message` populated.                                                    |

Operational notes:

- **Token freshness.** Keycloak tokens are short-lived (default 5 min). The batch resolves a token _resolver_ at startup and calls it before every POST, so multi-hour runs don't fail with stale-token 401s. Refresh happens ~30 s before expiry.
- **Concurrency model.** A DB-only mutex serialises the fetch + check phases (mssql exposes one shared pool that doesn't tolerate concurrent connection-string switching), but **POSTs run free**. So `--concurrency 5` parallelises five HTTP calls at a time — exactly what you want for API rate-limit testing.
- **Resume.** Each lab gets one NDJSON line on stdout. To resume after an interruption, point `--resume-from <path>` at the previous run's stdout file — labs that already appear (any status) are skipped. The same file is journal + checkpoint.
- **Heartbeat.** Every `min(500, concurrency * 25)` labs, `export-batch-progress` lines emit on stderr with running counts.
- **Exit code 0 only when every attempted lab landed in `posted` or `deduplicated`.** Anything else exits 9 (`API_REJECTED`) with a summary so the operator knows the run wasn't fully clean.

```bash
# Full production export — env-driven config, both gates on
pnpm dev export-batch --limit 5000000 --concurrency 1 --insecure-tls --track \
  > ./export.ndjson 2> ./export.log

# Resume after interruption — re-uses run1's progress
pnpm dev export-batch --limit 5000000 --concurrency 1 \
  --insecure-tls --track \
  --resume-from ./export.ndjson \
  > ./export.run2.ndjson 2>> ./export.log

# Build payloads + run gates, but don't POST
pnpm dev export-batch --limit 1000 --dry-run

# Show resolved config and exit
pnpm dev export-batch --explain
```

**Recommended workflow for a fresh deployment:**

1. **Audit-only preview** to size the cleanup ahead.
   ```bash
   pnpm dev audit-batch --source openldr --limit 100000 \
     --report-out ./preview.pdf --total-labs <total> \
     > ./preview.ndjson 2> ./preview.log
   ```
2. **Real export** — gates on, env-driven config.
   ```bash
   pnpm dev export-batch --limit <total> --concurrency 1 \
     --insecure-tls --track \
     > ./export.ndjson 2> ./export.log
   ```
3. **Triage quarantine.** Quarantined / errored labs land in `./temp/quarantine/`. Review, fix in DISA's UI (or in dictionaries / decoder, depending on root cause), then re-run with `--resume-from ./export.ndjson` so only the previously-blocked labs get retried.

---

## The audit subsystem — what it catches and why it matters

The audit is the single highest-leverage feature in the toolchain. It runs a pure detector ([`apps/cli/src/audit/detector.ts`](apps/cli/src/audit/detector.ts)) over a `SpecimenRecpt` and emits `Anomaly` records, each tagged with a class and a severity. Same detector is reachable from three places:

1. **`cdr audit <lab>`** — single-lab triage.
2. **`cdr audit-batch`** — full-deployment scan + summary + optional rendered report.
3. **Embedded in `cdr export --type v2`** — every payload gets a `data_quality` block when anomalies exist; `--quarantine-on-anomaly` blocks high-severity labs from POSTing.

A v1 adapter ([`apps/cli/src/audit/v1-adapter.ts`](apps/cli/src/audit/v1-adapter.ts)) projects OpenLDR v1 rows back into the same input shape, so `--source openldr` audits already-migrated data retroactively too.

### Severity ladder

`info < warn < error`. Severity drives the `--quarantine-severity` threshold and the report's severity breakdown. The audit reports the highest seen as `max_severity`.

### Anomaly catalogue

| Class                               | Severity | What it catches                                                                                                                       | Why it saves work                                                                                                                                                                                                                                              |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panel_specimen_mismatch`           | error    | Panel description implies one specimen kind but the specimen description says another (e.g. urine-microscopy panel + stool specimen). | Registration data-entry error. Catching pre-migration costs one minute of lab-clerk time. Catching post-migration means tracing back through the v2 mapper, undoing concept-id assignments, and possibly retracting a dashboard.                               |
| `dob_after_specimen_date`           | error    | Patient DOB is after the earliest specimen-event date — physically impossible.                                                        | Same root cause (typo at registration). Migrating it produces a "patient who hadn't been born yet had blood drawn" record in v2 — an analytics outlier that contaminates age-binned cohorts.                                                                   |
| `dob_future_dated`                  | error    | DOB is in the future.                                                                                                                 | Almost always a transposed-year typo. Same downstream contamination as above.                                                                                                                                                                                  |
| `observation_wrong_panel`           | error    | AST observations (PARMDICT context 60/79) recorded inside a microscopy-described panel.                                               | DISA workflow bug: results entered against the wrong panel. v2's mapping engine will route them to the wrong concept system; clinicians will see "ciprofloxacin susceptibility" inside a "rectal swab microscopy" panel and lose trust in the data.            |
| `specimen_missing`                  | error    | Panel implies a specimen kind but the request has no specimen recorded at all.                                                        | v2 storage requires `specimen_concept_id`; a null `specimen_code` never gets mapped, so storage **always rejects**. Quarantining at the gate means the operator fixes the upstream record once; otherwise every retry fails identically until someone notices. |
| `cross_panel_duplicate_observation` | warn     | Same observation code appears under multiple panels with disjoint specimen kinds.                                                     | Indicates the result was associated to the wrong panel at entry. Worth a human glance before migration.                                                                                                                                                        |
| `result_unrealistic_numeric`        | warn     | Numeric value > 1 × 10¹² or < 1 × 10⁻⁶ (excluding 0).                                                                                 | Almost always uninitialised-float garbage from a misdecoded blob slot. Keep these out of v2's analytics — they wreck min/max/mean dashboards instantly.                                                                                                        |
| `result_contains_control_chars`     | warn     | Result string contains stray DISA control bytes (0x01–0x1F excluding tab/LF/CR).                                                      | Decode-layer bug rather than a data error. Surfacing it tells the engineering team a decoder slot is reading the wrong bytes for that record class.                                                                                                            |
| `result_format_microscopy_count`    | warn     | Microscopy parameter (WBC, RBC, leucocytes, epithelial) value doesn't match a recognised count / range / semi-quantitative pattern.   | Free-text in a structured field. v2 won't be able to numericise it; the row will land but won't aggregate.                                                                                                                                                     |
| `result_format_invalid_decoded`     | warn     | Coded result decoded to "Invalid" outside an AST context (typically a dictionary typo at the deployment level).                       | Often a deployment-wide COMMDICT typo affecting hundreds of records. Audit lets you find it once and fix the dictionary, not once per row downstream.                                                                                                          |
| `sex_code_invalid`                  | warn     | Sex code outside `M` / `F` / `U` / `I` / blank.                                                                                       | Catches "Make" / "Femal" / typo single-chars. Cheap to fix in DISA, expensive to fix after the row is in v2 demographics tables.                                                                                                                               |
| `orphan_ordered_panel`              | info     | Panel ordered but no observations entered.                                                                                            | Common; legitimate (sample lost, test not performed). Surfaced as info so it's visible in totals without halting a migration.                                                                                                                                  |
| `specimen_description_vague`        | info     | Specimen has a code but the description doesn't tokenise to any known specimen kind.                                                  | Tells the engineering team the [`specimen-vocab.ts`](apps/cli/src/audit/specimen-vocab.ts) vocabulary is missing a token.                                                                                                                                      |
| `result_format_units_inline`        | info     | Numeric value contains units inline despite `PARMDICT` supplying them in a separate column.                                           | Cosmetic — v2 storage is tolerant — but worth knowing.                                                                                                                                                                                                         |

Adding a new class is a six-step recipe documented in [`CDR_TOOLCHAIN.md`](CDR_TOOLCHAIN.md#adding-a-new-anomaly-class).

### How auditing saves work

In a 5-million-lab migration, even a 0.5 % anomaly rate is 25,000 bad rows. The economics are blunt:

- **Pre-migration fix** (audit catches it; lab clerk corrects in DISA's UI): minutes per row, no engineering involvement.
- **Post-migration fix** (the row is already in v2): forensic reverse-trace through v2's pipeline, manual updates across multiple v2 tables, possible retraction from downstream analytics consumers, often hours per row plus an engineer + a domain expert.

Concretely, the audit + quarantine workflow gives you:

1. **A pre-migration size estimate.** `audit-batch --total-labs <N>` projects per-lab anomaly rates from a sample to the full deployment, so leadership has a number _before_ migration starts: "expect ~12,000 panel/specimen mismatches; budget two weeks of lab-manager time."
2. **Actionable per-class triage.** Each anomaly class maps to a clear remediation lane — data-entry error (DISA UI fix), decode bug (engineering), dictionary typo (one-time SQL UPDATE on `COMMDICT`), genuine clinical edge case (whitelist via `KIND_COMPATIBLE`).
3. **Productive bulk runs.** With `--quarantine-on-anomaly` on, a 100,000-lab batch with 500 bad records produces 99,500 successful POSTs and 500 quarantine files — one productive run instead of 500 manual interventions blocking everything.
4. **Visibility for non-engineers.** PDF / DOCX reports give site managers, M&E officers, and country leads something to act on without reading NDJSON.
5. **Retroactive auditing of v1.** `--source openldr` runs the same detector against your existing v1 mirror — telling you how much of _what's already migrated_ would have failed today's gates.

### Specimen-kind vocabulary

The panel-vs-specimen mismatch detector uses a hand-curated vocabulary in [`apps/cli/src/audit/specimen-vocab.ts`](apps/cli/src/audit/specimen-vocab.ts) — kept in TypeScript (under code review) rather than YAML, matching the project's "no per-country YAMLs" stance. Kinds: `urine`, `stool`, `blood` (incl. plasma/serum/whole-blood), `csf`, `sputum`, `swab`, `pus`, `tissue`, `genital`, `body_fluid` (pleural/pericardial/peritoneal/synovial/ascitic), `skin_hair_nail`. Plus a `KIND_COMPATIBLE` override list for legitimate cross-kind pairings (swab↔pus, swab↔tissue, swab↔genital). Add overrides only when real data proves a false positive.

### `data_quality` annotation

Every `cdr export --type v2` runs the audit internally. When it finds at least one anomaly, the v2 payload gains a `data_quality` block:

```json
{
  "patient": {…},
  "lab_request": {…},
  "lab_results": […],
  "isolates": […],
  "susceptibility_tests": […],
  "data_quality": {
    "max_severity": "error",
    "audited_at": "2026-04-29T11:12:21.991Z",
    "anomalies": [
      { "class": "panel_specimen_mismatch", "severity": "error",
        "message": "Panel \"…\" implies csf, but specimen \"…\" is stool.",
        "panel_code": "MCSF", "details": {…} }
    ]
  }
}
```

Clean labs produce payloads **without** the `data_quality` field — byte-identical to pre-audit behaviour. Use `--no-data-quality` to suppress the block regardless.

### Quarantine file shape

When `--quarantine-on-anomaly` triggers, the CLI writes `<dir>/<labNumber>.json`:

```json
{
  "lab_number": "<labNumber>",
  "request_id": "<prefix><labNumber>",
  "quarantined_at": "2026-04-29T11:12:21.991Z",
  "threshold": "error",
  "audit_report": {
    /* full AuditReport */
  },
  "payload": {
    /* full V2Payload, including data_quality */
  }
}
```

Then throws `CliError("QUARANTINED")` with exit code **11** and **does not** POST.

### Stakeholder reports

`audit-report` and `audit-batch --report-out` render PDF / DOCX / Markdown / HTML. Format is inferred from the output extension; override with `--format`. Sections:

- Title block — generated-at timestamp, source (`disa` / `openldr` / `mixed`), scan duration.
- Executive summary — labs scanned, labs with anomalies, total anomalies, severity breakdown.
- **Forecast** (when `--total-labs` is supplied) — linear projection of per-lab rates × estimated total. Treat this as a planning aid, not a guarantee: real ratios shift when the sample misses dataset eras, skews to one section, or unfetchable-lab errors cluster in one ingestion era.
- Anomalies by class — sorted by severity, then count.
- Detailed findings — one section per class with up to `--report-max-samples` (default 10) sample lab numbers and messages.
- Top affected panels — up to 25 panels by anomaly count.
- Unfetchable labs — aggregated unique error messages with sample lab numbers.
- Methodology — what each anomaly class checks.
- Limitations — explicit caveats (e.g. DOB checks skip on `--source openldr` because v1 doesn't preserve raw DOB strings).

> When using the **standalone** `audit-report` path, capture both stdout and stderr from the source `audit-batch` (`audit-batch … > scan.ndjson 2>> scan.ndjson`). The summary line lives on stderr; without it, "labs scanned" reflects only the lines actually in the stream — undercounting when `--only-anomalies` was set. The one-shot `audit-batch --report-out` path doesn't have this problem.

---

## POST integration (`--post`)

`cdr export <lab> --type v2 --post` builds the v2 payload and POSTs it to OpenLDR v2 in one shot. Happy path:

```
build payload  →  mint Keycloak token  →  resolve X-DataFeed-Id  →  POST  →  (optional) --track run
```

### Token resolution precedence

For each `--post` invocation, the CLI picks a token in this order:

1. `--token <bearer>` flag — manual override, highest priority.
2. **Keycloak**, when all four `KEYCLOAK_*` vars are set — minted via `client_credentials` and cached in-process. Refreshes ~30 s before expiry.
3. `OPENLDR_V2_TOKEN` env var — static fallback, useful for sites without Keycloak.

The output JSON includes `"token_source": "flag" | "keycloak" | "env"`.

### X-DataFeed-Id resolution

The v2 API needs an `X-DataFeed-Id` header to pick which schema / mapper / storage / outpost plugins apply. Resolution order:

| Source                                         | Used when                                     |
| ---------------------------------------------- | --------------------------------------------- |
| `--data-feed-id <uuid>` flag                   | always                                        |
| `OPENLDR_DATA_FEED_ID` env                     | flag absent                                   |
| Discovery via `(project, useCase, feed)` names | both above absent and the three names are set |
| Header omitted                                 | none of the above resolve                     |

Discovery chain (cached per run):

```
GET /api/v1/projects                              → projectId   by projectName
GET /api/v1/projects/{projectId}/use-cases        → useCaseId   by useCaseName
GET /api/v1/projects/use-cases/{useCaseId}/feeds  → dataFeedId  by dataFeedName
```

Output JSON includes `"data_feed_source": "explicit" | "discovered" | "none"`.

### Tracking the pipeline

```bash
pnpm dev export <labNumber> --post --track
```

Polls `GET /api/v1/runs/{messageId}` every 1 s (configurable via `--track-interval`) until `currentStatus` is terminal (`completed` / `failed` / `error` / `dlq` / `rejected`) or the timeout (default 60 s, `--track-timeout`) elapses. Output appends a `"tracking"` block with the full run + per-stage events.

Exit codes:

- **0** — `currentStatus = "completed"`.
- **9** (`API_REJECTED`) — non-`completed` terminal state (full run + events + error fields in JSON details).
- **10** (`API_UNAVAILABLE`) — run row never appeared, or the tracking endpoint returned 5xx after retries.

### Server-side dedup

The v2 API hashes incoming payloads. A second POST of an identical payload returns **HTTP 200** with `"deduplicated": true`. The CLI surfaces that flag in the `response` block. With `--track`, it tracks the _original_ run (which is already terminal). To force re-processing, pass `--force` — the CLI appends `?force=true` and the API processes it as a new message with a fresh `messageId`.

### Retry policy

| Response                    | Behaviour                                                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 2xx                         | Success, return immediately.                                                                                                               |
| 4xx (not 429)               | `CliError("API_REJECTED")` exit 9 — payload is wrong, don't retry. Response body included in error details.                                |
| 429                         | Honour `Retry-After` header (or default backoff), retry without consuming attempt budget.                                                  |
| 5xx, network error, timeout | Retry with exponential backoff (1 s, 2 s, 4 s, 8 s, 16 s, 32 s, 60 s capped) up to 5 attempts. Then `CliError("API_UNAVAILABLE")` exit 10. |

Per-request timeout is 30 s. Both are tunable via `PostOptions` in [`apps/cli/src/api/client.ts`](apps/cli/src/api/client.ts).

### `--type v1 --post` is rejected

v1 has no target API. Using `--post --type v1` errors with `NOT_SUPPORTED`.

---

## Configuration reference

All env vars live in `apps/cli/.env` (or override via global flags). See [`apps/cli/.env.example`](apps/cli/.env.example) for the template.

| Var                            | Required                               | Used by                                                             | Notes                                                                                                                              |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `DISA_CONNECTION_STRING`       | yes                                    | every command except `errors` / `tables` / `schema` / `config show` | MSSQL connection string. Two formats supported — see [Setup](#setup).                                                              |
| `DISA_OUTPUT`                  | no                                     | every command                                                       | Default output format (`ndjson` \| `json` \| `pretty`). Overridable per-call with `--output`.                                      |
| `OPENLDR_V1_CONNECTION_STRING` | only for `compare*` / `export --check` | `compare`, `compare-results`, `compare-batch`, `export --check`     | OpenLDR v1 SQL Server. Same format as DISA.                                                                                        |
| `OPENLDR_LABNO_PREFIX`         | no                                     | `compare*`, `export`                                                | Prefix added to DISA labno when constructing v1 RequestID. Empty by default — set per deployment (e.g. `TZDISA` for Tanzania; leave empty for Zambia).                                  |
| `OPENLDR_V1_DATABASE_DATA`     | no                                     | `compare*`                                                          | Default `OpenLDRData`. SQL is fully-qualified.                                                                                     |
| `OPENLDR_V1_DATABASE_DICT`     | no                                     | (placeholder)                                                       | Default `OpenLDRDict`. Reserved for future commands.                                                                               |
| `OPENLDR_V2_URL`               | only for `export --post`               | `export --post`                                                     | Base URL of the OpenLDR v2 API. No trailing slash.                                                                                 |
| `OPENLDR_V2_TOKEN`             | optional fallback for `export --post`  | `export --post`                                                     | Static bearer token. Used only when no `--token` flag and no Keycloak vars are set.                                                |
| `OPENLDR_V2_PATH`              | no                                     | `export --post`                                                     | Endpoint path. Default `/api/v2/lab-requests`.                                                                                     |
| `OPENLDR_V2_INSECURE_TLS`      | no                                     | `export --post`                                                     | `true`/`1`/`yes`/`on` skips TLS cert verification. Self-signed local dev only — sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for the run. |
| `KEYCLOAK_PUBLIC_URL`          | only for Keycloak                      | `export --post`                                                     | Base URL. Token endpoint is `{url}/realms/{realm}/protocol/openid-connect/token`.                                                  |
| `KEYCLOAK_REALM`               | only for Keycloak                      | `export --post`                                                     | Realm hosting the OpenLDR client.                                                                                                  |
| `KEYCLOAK_CLIENT_ID`           | only for Keycloak                      | `export --post`                                                     | Client ID with service-account / `client_credentials` grant.                                                                       |
| `KEYCLOAK_CLIENT_SECRET`       | only for Keycloak                      | `export --post`                                                     | Client secret.                                                                                                                     |
| `OPENLDR_PROJECT_NAME`         | only for X-DataFeed-Id discovery       | `export --post`                                                     | OpenLDR project name.                                                                                                              |
| `OPENLDR_USE_CASE_NAME`        | only for X-DataFeed-Id discovery       | `export --post`                                                     | OpenLDR use-case name.                                                                                                             |
| `OPENLDR_DATA_FEED_NAME`       | only for X-DataFeed-Id discovery       | `export --post`                                                     | OpenLDR data-feed name.                                                                                                            |
| `OPENLDR_DATA_FEED_ID`         | optional                               | `export --post`                                                     | Pre-resolved data-feed UUID. Skips discovery when set.                                                                             |
| `OPENLDR_COUNTRY`              | only for documentation routing         | `export --post` / `export-batch`                                    | Country key selecting `config/<country>.yaml` documentation classifiers (e.g. `zambia`, `tanzania`). Controls which DISA panels/params are treated as non-test "documentation" and routed to the forms feed instead of quarantined. Documentation panel/param codes live under the `documentation:` key in the country YAML — never hardcode them. |
| `OPENLDR_FORMS_DATA_FEED_NAME` | only for documentation routing         | `export --post` / `export-batch`                                    | Data-feed name for the v2 forms (non-test) feed. Resolved the same way as `OPENLDR_DATA_FEED_NAME` (project → use-case → feeds). Required only when a run produces documentation records to POST.                                                      |
| `OPENLDR_V1_POC_FORMAT`        | no                                     | `compare*`, `export`, `export-batch`                                | How v1 stores `LIMSPointOfCareDesc`: `facility_ward` (default, Tanzania) or `district_facility_ward` (Mozambique). Unverified for Zambia — confirm against a real v1 row before a bulk run. Overridable with `--poc-format`.                          |
| `OPENLDR_CE_URL`               | only for the CE target                 | `export-batch`                                                      | Base URL of the OpenLDR CE install, no trailing slash. Its presence selects the CE target instead of v2; the `OPENLDR_V2_*`, `KEYCLOAK_*` and data-feed vars are unused on this path. Overridable with `--ce-url`.                                    |
| `OPENLDR_CE_HOOK_PATH`         | no                                     | `export-batch`                                                      | CE workflow webhook path, appended to `OPENLDR_CE_URL`. Default `/api/workflows/hooks/ingest` already matches CE's built-in "Ingest" workflow — leave unset unless that path changed. Overridable with `--ce-hook-path`.                              |
| `OPENLDR_CE_WEBHOOK_TOKEN`     | only for the CE target                 | `export-batch`                                                      | Sent as `x-webhook-token`. A random UUID minted when that CE install was seeded — per-install, not transferable. Read it from Studio → Workflows → Ingest → the webhook trigger node. Overridable with `--ce-token`.                                  |
| `OPENLDR_CE_TIMEZONE`          | **yes, for the CE target**             | `export-batch`                                                      | UTC offset for DISA's unzoned timestamps, e.g. `+02:00`. No default and no fallback — assuming UTC silently shifts every clinical timestamp. Tanzania `+03:00`; Zambia/Mozambique `+02:00`. Overridable with `--ce-tz`.                               |

**CE target gates.** `export-batch` refuses `--no-check` and `--no-quarantine` when `--ce-url` is set, so `OPENLDR_V1_CONNECTION_STRING` is required on the CE path even though it is optional for v2 — CE's FHIR schemas are passthrough, so those two gates are the only checks between bad source data and the store.

---

## Exit codes

These are stable — scripting against them is safe.

| Code                                                                                                          | Exit | When                                                   |
| ------------------------------------------------------------------------------------------------------------- | ---: | ------------------------------------------------------ |
| `USAGE` / `UNKNOWN_ENTITY` / `MISSING_FLAG` / `NOT_SUPPORTED`                                                 |    2 | bad args                                               |
| `CONFIG_MISSING` / `CONFIG_INVALID` / `ENV_FILE_UNREADABLE` / `OPENLDR_CONFIG_MISSING` / `API_CONFIG_MISSING` |    3 | bad env                                                |
| `DB_CONNECT_FAILED` / `DB_QUERY_FAILED`                                                                       |    4 | mssql failure                                          |
| `GET_NO_ROWS` / `GET_MULTIPLE_ROWS`                                                                           |    6 | get/compare/export row mismatch                        |
| `MISMATCH`                                                                                                    |    7 | `compare` or `--check` found drift                     |
| `NOT_IMPLEMENTED`                                                                                             |    8 | reserved                                               |
| `API_REJECTED`                                                                                                |    9 | v2 returned 4xx (not 429), or batch had non-clean labs |
| `API_UNAVAILABLE`                                                                                             |   10 | v2 unreachable / 5xx after retries                     |
| `QUARANTINED`                                                                                                 |   11 | audit gate blocked a single-lab POST                   |
| `UNKNOWN`                                                                                                     |    1 | anything unmapped                                      |

Run `cdr errors` to print the same table at runtime with full descriptions.

---

## Gotchas

### Operational

- **Run from `apps/cli/`** (or `pnpm --filter @cdr-toolchain/cli dev …`). `pnpm dev <subcommand>` from the repo root goes through Turbo, which runs every workspace's `dev` and eats `--`-prefixed args.
- **Git Bash on Windows path-mangles leading-`/` args.** A CLI arg starting with `/` (e.g. `--api-path /post`) gets prepended with the Git installation path. Workaround: use `--api-path //post` (Git Bash strips one slash). Env vars in `.env` aren't affected.
- **`pnpm dev export … > out.json` on Windows captures pnpm's lifecycle banner** because pnpm writes it to stdout. Use `--out <path>` for clean file output.

### Data semantics

- **`OrderItem.Value` is COMMDICT-decoded; `OrderItem.RawValue` is the pre-decode code.** For coded types (especially S/I/R), always prefer `RawValue` for canonical short codes (`"S"` not `"Susceptible"`).
- **Same organism observed in multiple panels = multiple isolates.** v2 may want dedup — not currently implemented.
- **Disalab `Facility` class assigns LOCNDIC4 address columns by ORDER, not content.** Some sites have misleading labels (e.g. `region` containing an HFR code). Output is faithful, just labelled per disalab's convention.
- **DISA datetimes are local time without TZ.** v2 export emits ISO without `Z`. v1 export emits `…Z` to match real v1's serialisation byte-for-byte (a false UTC claim — both are local).

### v1 export

- **`AgeInDays` is off by 1 for some labs.** Real v1's day-counts vary across rows for the same `AgeInYears`, so there's no single formula to match. Off-by-1 accepted.
- **4 LIS-stamped fields per Requests row** (`DateTimeStamp`, `Versionstamp`, `LIMSDateTimeStamp`, `LIMSVersionstamp`) and same for LabResults are intentionally `null` — only OpenLDR mints those.

---

## Conventions

- JSON on stdout, errors on stderr — no mixed output. Scripts can pipe stdout cleanly.
- Deterministic exit codes, scriptable.
- No country YAMLs — code categorisation comes from DISA's own dictionaries.
- Comments explain _why_, not _what_. Identifiers carry the "what".

For deeper architectural notes (data flow, where things live in the code, how to add a new export field, how to add a new anomaly class), see [`CDR_TOOLCHAIN.md`](CDR_TOOLCHAIN.md).

# CDR Toolchain

End-to-end tooling for migrating DISA*Lab data into OpenLDR v2: read DISA's native blob schema, transform records into the v2 contract, and POST them to the v2 API. Built for PEPFAR-funded sites in Tanzania, Zambia, Mozambique, Kenya — anywhere DISA*Lab is being phased out.

For the original design intent, see [`docs/PRD.md`](docs/PRD.md). For *current state*, this doc is the source of truth.

---

## Table of contents

1. [What this is](#what-this-is)
2. [Repo layout](#repo-layout)
3. [Setup](#setup)
4. [CLI command reference](#cli-command-reference)
5. [Export deep-dive (v2 + v1)](#export-deep-dive-v2--v1)
6. [API integration (`--post`)](#api-integration---post)
7. [Audit subsystem](#audit-subsystem)
8. [Configuration reference](#configuration-reference)
9. [Error codes & exit codes](#error-codes--exit-codes)
10. [Architecture](#architecture)
11. [Verification & known-good labs](#verification--known-good-labs)
12. [Known limitations & gotchas](#known-limitations--gotchas)
13. [Where things live in the code](#where-things-live-in-the-code)

---

## What this is

DISA*Lab is a legacy LIS storing data in a custom blob-encoded SQL Server schema (`REGDAT4`, `TESTDATA`, `TXT1DATA`, `AUDTDATA`, dictionaries `PARMDICT`/`COMMDICT`/`LOCNDIC4`/`TESTDICT`/`USERDIC6`). OpenLDR v2 is the modern target: a REST API accepting structured JSON payloads.

This monorepo provides:

- **`disalab`** — TypeScript decoder for DISA's native binary format. Lossless and audited (5,500 labs / 34,597 observations at 100 % fidelity vs the existing OpenLDR v1 mirror).
- **`cdr` CLI** — operator and developer-facing tool: query DISA, fetch specimens, build v1/v2 payloads, POST to v2.
- **`@cdr-toolchain/api`** — Express HTTP API scaffold that wraps `disalab` for downstream consumers (currently a stub with `/api/health` only — not used by the migration flow).

The migration flow you'll actually use:

```
DISA SQL Server  ─►  disalab decoder  ─►  cdr CLI export  ─►  v2 JSON payload  ─►  POST → OpenLDR v2 API
                                                          │
                                                          └─► (optional) write to file, OR run --check first against OpenLDR v1
```

---

## Repo layout

```
cdr-toolchain/
├── apps/
│   ├── cli/                # @cdr-toolchain/cli — `cdr` command
│   │   ├── src/
│   │   │   ├── commands/   # one file per subcommand
│   │   │   ├── compare/    # request- and observation-level diff (Phase 1+2)
│   │   │   ├── export/     # v1 + v2 transforms (Phase 3)
│   │   │   ├── api/        # client.ts — POST to OpenLDR v2
│   │   │   ├── config.ts   # env loading + Zod validation
│   │   │   ├── errors.ts   # CliError + exit-code mapping
│   │   │   ├── output.ts   # ndjson/json/pretty serializers
│   │   │   ├── openldr.ts  # OpenLDR v1 SQL helpers
│   │   │   └── index.ts    # Commander wiring
│   │   └── .env.example
│   └── api/                # @cdr-toolchain/api — Express scaffold (stub)
├── packages/
│   └── disalab/            # DISA blob decoder (PARMDICT/COMMDICT/SpecimenRecpt/...)
├── docs/
│   └── PRD.md              # original product spec (sections 1-16 pre-date Phase 1)
├── temp/                   # gitignored; output dumps, throwaway probes
├── CDR_TOOLCHAIN.md       # this file
└── pnpm-workspace.yaml
```

Tooling:
- **pnpm 10.33+** (workspace + turbo)
- **Node ≥ 18.19** (we test on 20+; built-in `fetch` requires 18+)
- **TypeScript 5+** strict, ESM
- **mssql** (with `tedious` driver) for SQL Server connectivity

---

## Setup

```bash
# 1. Clone + install
git clone <this-repo>
cd cdr-toolchain
pnpm install

# 2. Configure CLI
cd apps/cli
cp .env.example .env
# Edit .env — at minimum set DISA_CONNECTION_STRING.
# Set OPENLDR_V1_CONNECTION_STRING if you want to use `compare` or `export --check`.
# Set OPENLDR_V2_URL + OPENLDR_V2_TOKEN if you want `export --post` to actually send.

# 3. Build the disalab package (CLI imports compiled output)
pnpm --filter disalab build

# 4. Smoke test
pnpm dev ping
# → {"ok":true,"driver":"mssql","elapsed_ms":46}
```

If `ping` fails with `DB_CONNECT_FAILED`, your `DISA_CONNECTION_STRING` is wrong or the SQL Server isn't reachable. The error JSON includes the underlying mssql message.

### Windows (PowerShell / cmd) setup

The toolchain runs natively on Windows. `pnpm install`, `pnpm build`, `pnpm clean`, and `pnpm dev <subcommand>` all work in PowerShell, cmd, Git Bash, and WSL — the package.json `build` and `clean` scripts use `node -e` rather than `chmod`/`rm -rf`, so they're shell-agnostic.

The shell *examples* in this doc default to bash/zsh, but the only POSIX-only bits are the path conventions and output redirection. Quick reference for the PowerShell / cmd equivalents:

**Copy `.env.example` → `.env`** in PowerShell:

```powershell
Copy-Item apps/cli/.env.example apps/cli/.env
```

**Output redirection.** PowerShell's `>` writes UTF-16 with a BOM by default, which corrupts NDJSON consumers (`openldr ingest stream`, `jq`, `--resume-from`). For all `> file.ndjson` examples in this doc, use one of:

```powershell
# Force UTF-8 (no BOM) — works in PowerShell 7+
pnpm dev export-batch ... | Out-File -FilePath out.ndjson -Encoding utf8NoBOM

# Or use cmd.exe redirection (UTF-8, no BOM)
cmd /c "pnpm dev export-batch ... > out.ndjson 2> out.log"
```

Git Bash / WSL do not have this problem — bash `>` is byte-stream-clean.

**Path separators.** Forward slashes work in pnpm scripts and Node tooling. Examples like `--out ../../temp/output.json` work as-is in PowerShell. Backslashes are required only for native Windows commands (`Copy-Item`, `Remove-Item`).

**Unix-style paths in examples.** Several examples use `/tmp/...` and `/var/lib/...` paths. Substitute Windows equivalents:

| Unix example | Windows substitute |
|---|---|
| `/tmp/scan.ndjson` | `$env:TEMP\scan.ndjson` (PowerShell) or `%TEMP%\scan.ndjson` (cmd) |
| `/var/lib/disa/quarantine` | `C:\disa\quarantine` (or any writable path) |
| `apps/cli/node_modules/.bin/tsx` | `apps/cli/node_modules/.bin/tsx.cmd` (PowerShell auto-resolves either) |

### Installing `cdr` as a global command

The CLI auto-discovers `apps/cli/.env` regardless of cwd ([config.ts](apps/cli/src/config.ts) falls back to the package-relative `.env` when no cwd-relative one is present), so once `cdr` is on PATH it works from any directory.

#### Linux / macOS

`apps/cli/dist/index.js` carries a `#!/usr/bin/env node` shebang and the build's `chmod +x` makes it directly executable. Two options:

```bash
# Build first
pnpm --filter disalab build
pnpm --filter @cdr-toolchain/cli build

# Option 1 — symlink the bin shim into a directory on PATH
chmod +x apps/cli/dist/index.js     # already done by build, but harmless
ln -s "$(pwd)/apps/cli/dist/index.js" ~/.local/bin/cdr
cdr ping

# Option 2 — pnpm link --global (handles PATH for you via pnpm setup)
pnpm -C apps/cli link --global
cdr ping
```

Caveat for Option 2: `pnpm link --global` resolves the workspace's `disalab: workspace:*` dep by symlink, so the link breaks if you move or delete the monorepo directory. Option 1 has the same constraint (the symlink target is a fixed path), but is easier to reason about.

#### Windows (PowerShell / cmd)

Windows has no shebang concept, so you need an explicit launcher to type a bare `cdr ping` from any directory. Three options, easiest first:

**Option 1 — PowerShell function in `$PROFILE` (no setup, instant).**

```powershell
# One-time: ensure the profile file exists (PowerShell doesn't create it for
# you — `notepad $PROFILE` on a fresh machine errors with "system cannot
# find the path specified" because the parent dir doesn't exist either).
if (-not (Test-Path $PROFILE)) {
  New-Item -ItemType File -Path $PROFILE -Force | Out-Null
}
notepad $PROFILE

# Add this block (substitute the absolute path to your clone). The conditional
# matters — a plain `function cdr { node ... @args }` does NOT forward
# pipeline input to node's stdin, so `cat foo.ndjson | cdr ...` (and the
# `cdr export-batch --emit-payloads | openldr ingest stream` workflow)
# silently receive empty stdin. The $MyInvocation.ExpectingInput check
# forwards only when actually piped, so interactive `cdr ping` (no pipe)
# still works.
function cdr {
    if ($MyInvocation.ExpectingInput) {
        $input | & node D:\Projects\Repositories\cdr-toolchain\apps\cli\dist\index.js @args
    } else {
        & node D:\Projects\Repositories\cdr-toolchain\apps\cli\dist\index.js @args
    }
}

# Save, close Notepad, then reload — or open a new PowerShell window
. $PROFILE

# Now from anywhere:
cdr ping
```

**Option 2 — `.cmd` shim on PATH (works in PowerShell, cmd, and any tool that shells out).**

```powershell
# Create a directory on PATH, e.g. C:\Users\you\bin (add to PATH via System Properties → Environment Variables)
# Then create C:\Users\you\bin\cdr.cmd with these two lines:
@echo off
node "D:\Projects\Repositories\cdr-toolchain\apps\cli\dist\index.js" %*
```

Identical behaviour to Option 1 but visible to every Windows process, not just PowerShell.

**Option 3 — `pnpm link --global` (closest to "install once globally").**

Requires a one-time machine setup:

```powershell
# One-time: set up pnpm's global bin directory + PATH
pnpm setup
# → Restart your terminal so the new $env:PNPM_HOME is picked up

# Build the CLI (and its workspace dep) so `dist/` exists
pnpm -C packages/disalab build
pnpm -C apps/cli build

# Link the workspace package globally
pnpm -C apps/cli link --global

# Verify
cdr ping
```

Caveat: `pnpm link --global` resolves the workspace's `disalab: workspace:*` dep by symlink, so the link breaks if you move or delete the monorepo directory. For long-term portability, prefer Option 1 or 2.

**Rebuilding after code changes.** Options 1 and 2 invoke `dist/index.js`, so `pnpm -C apps/cli build` after each change. Or skip the build entirely during development with `pnpm -C apps/cli dev <subcommand>` (tsx, runs TS directly — no `cdr` shortcut, but no build step either).

### Running the CLI

There are three equivalent ways:

```bash
# (a) From inside apps/cli — easiest for daily use:
cd apps/cli
pnpm dev <subcommand> [args]

# (b) From repo root via filter:
pnpm --filter @cdr-toolchain/cli dev <subcommand> [args]

# (c) After building, install the bin:
pnpm --filter @cdr-toolchain/cli build
node apps/cli/dist/index.js <subcommand> [args]
```

**Don't** run `pnpm dev <subcommand>` from the repo root — that's Turbo's recursive form and it (a) runs every workspace's `dev` script and (b) eats `--` args en route to the actual command.

---

## CLI command reference

Every command emits JSON on stdout, structured errors (`{"error":{"code":"…","message":"…","details":{…}}}`) on stderr, and uses deterministic exit codes (see [Error codes](#error-codes--exit-codes)). Output format is governed by the global `--output` flag.

### Global flags

| Flag | Purpose |
|---|---|
| `--cs / --connection-string <url>` | DISA MSSQL connection (overrides env) |
| `--openldr-cs <url>` | OpenLDR v1 MSSQL connection (used by `compare`, `export --check`) |
| `--env-file <path>` | Path to `.env` (default `./.env`) |
| `--output <fmt>` | `ndjson` (default, single-line) \| `json` (indented) \| `pretty` (Node `util.inspect` with colors) |
| `--no-color` | Disable ANSI colors |
| `--quiet` | Suppress informational stderr output |
| `--log-level <lvl>` | `error` \| `warn` \| `info` (default) \| `debug` |

### Health & introspection

| Command | What it does |
|---|---|
| `cdr ping` | Open and close a DB connection — quick reachability check. |
| `cdr config show` | Print the effective config (connection strings redacted). |
| `cdr tables` | List entities the CLI knows about (aliases + class names + table paths). |
| `cdr schema <entity>` | Schema + field documentation for one entity (e.g. `cdr schema registration`). |
| `cdr errors` | Enumerate every CliError code + exit code + description. |

### Raw row access

| Command | What it does |
|---|---|
| `cdr list <entity> [--where SQL] [--limit N] [--offset N] [--fields csv] [--explain]` | Buffered rows from one entity. `--where` pushes the filter to SQL when the entity has a SQL cursor column; otherwise filters post-hydration. |
| `cdr get <entity> [--where SQL]` | Single-row fetch — errors if 0 or >1 rows match. |
| `cdr stream <entity> [--where SQL]` | NDJSON stream over a cursor — for very large result sets. |
| `cdr count <entity> [--where SQL]` | Row count. |

### DISA-specific

| Command | What it does |
|---|---|
| `cdr specimen <labNumber>` | Fetch one `SpecimenRecpt` (REGDAT4 + TESTDATA hydration) for a lab. The richest single-lab view. |
| `cdr probe-bytes <labNumber>` | Brute-force scan of REGDAT4_STATUS for date patterns — for reverse-engineering unmapped fields. |

### Phase 1+2: fidelity audit (DISA ↔ OpenLDR v1)

Used to prove `disalab` decodes DISA correctly by diffing against the existing v1 mirror. **Currently at 100 % fidelity** across 5,500 audited labs.

| Command | What it does |
|---|---|
| `cdr compare <labNumber>` | 13-field request-level diff. |
| `cdr compare-results <labNumber>` | Per-observation diff. |
| `cdr compare-batch [--where SQL] [--limit N] [--offset N] [--results] [--include-empty] [--summary-only] [--only-differences] [--explain]` | Run either compare across many labs. Per-lab results to stdout (NDJSON), batch summary to stderr. |

Common flags on `compare` / `compare-results`:
- `--openldr-cs <url>` — override v1 connection
- `--prefix <str>` — override the OpenLDR labno prefix (empty by default; set per deployment, e.g. `TZDISA` for Tanzania, empty for Zambia)
- `--only-differences` — hide perfect-match fields/rows
- `--explain` — print the SQL plan and exit without hitting either DB

### Phase 4: audit (data-quality detection)

Detects panel/specimen mismatches, impossible ages, garbage decoded values, and other data-quality anomalies before migration. Documented in detail in [Audit subsystem](#audit-subsystem).

| Command | What it does |
|---|---|
| `cdr audit <labNumber> [--source disa\|openldr]` | Single-lab audit. Default source is DISA; `--source openldr` runs the same detector against the OpenLDR v1 mirror retrospectively. |
| `cdr audit-batch [--source ...] [--where SQL] [--limit N] [--offset N] [--summary-only] [--only-anomalies] [--explain] [--report-out <path>] [--total-labs <n>]` | Batch audit with NDJSON per-lab + summary. Optionally renders a stakeholder report (PDF / DOCX / Markdown / HTML) inline. |
| `cdr audit-report --input <ndjson> --out <path> [--format pdf\|docx\|md\|html] [--total-labs <n>]` | Render an audit-batch NDJSON stream into a stakeholder-ready report. |

### Phase 3: export (DISA → v1 / v2)

The data-shaping half of the migration. Documented in detail [below](#export-deep-dive-v2--v1).

```bash
cdr export <labNumber>
  [--type v1|v2]              # default v2
  [--check]                   # require diffRecord + diffResults to perfectly match v1 first
  [--out <path>]              # write to file instead of stdout
  [--openldr-cs <url>]        # only used by --check
  [--prefix <str>]            # override OPENLDR_LABNO_PREFIX
  # --post flow (v2 only):
  [--post]                    # send the payload to OpenLDR v2
  [--target-api <url>]        # override OPENLDR_V2_URL
  [--token <bearer>]          # override OPENLDR_V2_TOKEN (and Keycloak)
  [--api-path <path>]         # override OPENLDR_V2_PATH
  [--data-feed-id <uuid>]     # pre-resolved X-DataFeed-Id (skips discovery)
  [--project-name <name>]     # X-DataFeed-Id discovery: project (overrides env)
  [--use-case-name <name>]    # X-DataFeed-Id discovery: use-case (overrides env)
  [--data-feed-name <name>]   # X-DataFeed-Id discovery: feed (overrides env)
  [--dry-run-post]            # preview the prepared HTTP request without sending
  [--force]                   # append ?force=true so the API re-processes an identical payload
  [--insecure-tls]            # skip TLS cert verification (self-signed local dev)
  [--track]                   # poll /api/v1/runs/{messageId} until terminal
  [--track-timeout <ms>]      # default 60000
  [--track-interval <ms>]     # default 1000
  # audit + quarantine (v2 only):
  [--no-data-quality]         # suppress the data_quality audit annotation in output
  [--quarantine-on-anomaly <path>]
                              # write payload + audit report to <path>/<lab>.json
                              # instead of POSTing when severity ≥ threshold
  [--quarantine-severity <level>]
                              # error (default), warn, or info
```

---

## Export deep-dive (v2 + v1)

### v2 export — the migration target

Default mode. Builds the nested JSON shape exemplified in [`temp/default.schema.example.json`](temp/default.schema.example.json):

```json
{
  "patient":              { "patient_guid", "firstname", "surname", "sex", "date_of_birth", "patient_data": {…}, ... },
  "lab_request":          { "request_id", "facility_code": {…}, "panel_code": {…}, "specimen_code": {…},
                            "taken_datetime", "received_at", "section_code", "requesting_facility_code": {…},
                            "testing_facility_code": {…}, ... },
  "lab_results":          [ { "source_test_code", "obx_set_id", "obx_sub_id", "observation_code": {…},
                              "result_value", "numeric_value", "coded_value", "text_value",
                              "isolate_index", "is_resulted", "raw_result": {…} }, … ],
  "isolates":             [ { "isolate_index", "organism_code": {…}, "organism_type", … } ],
  "susceptibility_tests": [ { "isolate_index", "antibiotic_code": {…}, "susceptibility_value", "test_method", … } ]
}
```

#### Concept-code system_ids

v2 uses concept-system identifiers to drive its mapping engine. These are the canonical defaults the transform emits:

| Field | system_id |
|---|---|
| `lab_request.facility_code` | `DEFAULT_FAC` |
| `lab_request.panel_code` | `DEFAULT_TEST` |
| `lab_request.specimen_code` | `DEFAULT_SPEC` |
| `lab_request.{requesting,testing}_facility_code` | `DEFAULT_FAC` |
| `lab_results[].observation_code` (organism param) | `DEFAULT_ORG` |
| `lab_results[].observation_code` (antibiotic param) | `DEFAULT_ABX` |
| `lab_results[].observation_code` (other) | `DEFAULT_RESULT` |
| `isolates[].organism_code` | `DEFAULT_ORG` |
| `susceptibility_tests[].antibiotic_code` | `DEFAULT_ABX` |

These aren't placeholders — they're the literal strings v2's mapping table expects. Don't substitute country names. Configurable in [`apps/cli/src/export/site-config.ts`](apps/cli/src/export/site-config.ts) if a deployment ever needs different ones.

#### Dictionary-driven categorisation (no YAML)

Code semantics come from DISA itself, not a country YAML:

- `PARMDICT.CONTEXT = 79` → generic antibiotics (AMP, CIPRO, GENT…)
- `PARMDICT.CONTEXT = 60` → TB drugs (TBETM, TBISO…)
- `PARMDICT.CONTEXT = 50` → pathogen-ID parameters (ORGS, EEC…)
- `PARMDICT.CONTEXT ∈ {77, 88, 101, 102, 108, 110, 112, 131-137, 150, 155}` → questionnaire / ART-regimen panels (VLID, EIDID territory)
- `COMMDICT[CONTEXT=50]` → organism codes (`VIBCO → "Vibrio cholera 01 Ogawa"`)
- `COMMDICT[CONTEXT=97]` → specimen codes (`PUSR → "Rectal Swab"`)
- `TESTDICT.CODE/DESCRIPTION/SECTION` → panel name + section (`MRCSW → "MICROBIOLOGY : RECTAL SWAB" / "M"`)
- `USERDIC6.CODE/LOGIN/DESCRIPTION` → staff initials → full names (`NSN → "Neema Saul"`)

The codebook hydrates all of these in one pass per command run ([`apps/cli/src/export/codebook.ts`](apps/cli/src/export/codebook.ts)). PARMDICT's `ACTIVE` column is whitespace (not `'Y'`) so don't filter on it.

#### Universal `lab_results` + AMR-specific views

`lab_results[]` carries **every resulted observation** — generic results, organism rows (ORGS), and antibiotic susceptibility rows (S/I/R). The same observation also appears in `isolates[]` (for ORGS) and `susceptibility_tests[]` (for S/I/R), tied back via `isolate_index`.

This means consumers can choose:
- A generic stream view via `lab_results[]`
- An AMR-specific view via `isolates[]` + `susceptibility_tests[]`

#### HL7 OBX numbering

`obx_set_id` increments 1, 2, 3, … *per panel* (resets at each new `(panelCode, panelIndex)` pair). `obx_sub_id` is always `0` for DISA — DISA OrderItems are flat, not sub-componented.

#### S/I/R detection

`OrderItem.RawValue` carries the canonical short code (`"S"` / `"I"` / `"R"`); `OrderItem.Value` is the COMMDICT-decoded long form (`"Susceptible"` / `"Resistant"` — sometimes literally `"Invalid"` instead of `"Intermediate"` in this Tanzania deployment due to a dictionary typo at CONTEXT=79). The transform classifies AST rows by `RawValue` and emits the canonical short code as `susceptibility_value`, regardless of how the deployment's dictionary spells out the long form. The decoded value is preserved in `raw_result.decoded_value` for traceability.

### v1 export — the legacy mirror

`--type v1` produces JSON shaped like the OpenLDR v1 SQL tables it would replace:

```json
{
  "requests":     [ { /* one row per ordered panel — 60 columns */ } ],
  "lab_results":  [ { /* one row per resulted observation — 28 columns */ } ]
}
```

Phasing out — kept around for "what would v1 store?" diagnostics. Currently 51/60 Requests fields and 23/28 LabResults fields match real v1 byte-for-byte (96 % of derivable fields). The unmatched ones are mostly LIS-stamped (intentionally null), uninitialised-float garbage in v1 (where `0` is more correct), and `EncryptedPatientID` (which v1 mints itself).

Notable v1-specific behaviour the transform reproduces:
- `RequestTypeCode = "D"` (deployment-wide constant — confirmed across 35,126 rows)
- `HL7ResultTypeCode` uses non-standard codes: `"R"` = coded, `"C"` = comment/text, `"NM"` = numeric (not HL7 v2's `CE`/`TX`)
- `OBXSubID = 1` for text rows (vs `0` for everything else)
- Audit-trail people (`RegisteredBy` / `TestedBy` / `AuthorisedBy`) hydrated from `AUDTDATA` events `WS100` / `WL101` / `WA500`, with `USERDIC6` resolving initials → full names
- Audit datetimes truncated to whole minutes (matches v1's storage)
- Per-panel: panels with no results entered (e.g. an MSENS that was ordered but never processed) get null `AnalysisDateTime` / `AuthorisedDateTime`

### `--check` (fidelity gate)

Before emitting (or POSTing), runs both `diffRecord` (request-level) and `diffResults` (per-observation) against OpenLDR v1. Refuses to emit on any non-perfect match — exit code 7 (`MISMATCH`). Use it as a safety gate when you don't yet trust the transform on a new deployment.

---

## API integration (`--post`)

`cdr export <lab> --type v2 --post` builds the v2 payload and POSTs it to the OpenLDR v2 API in one shot. The full happy path is:

```
build payload  →  mint Keycloak token  →  resolve X-DataFeed-Id  →  POST  →  (optional) --track run
```

### Setup — minimum env

```bash
# In apps/cli/.env

# 1. Where to POST. URL is base only, no trailing slash; PATH is appended.
OPENLDR_V2_URL=https://v2.openldr.example.com
OPENLDR_V2_PATH=/api/v1/processor/process-feed

# 2. Auth — Keycloak (preferred). Tokens are minted on demand via the
#    client_credentials grant. The CLI caches them in-process and refreshes
#    ~30s before expiry.
KEYCLOAK_PUBLIC_URL=https://keycloak.example.com/keycloak
KEYCLOAK_REALM=openldr-realm
KEYCLOAK_CLIENT_ID=openldr-client
KEYCLOAK_CLIENT_SECRET=<client-secret>

# 3. Country key — selects config/<country>.yaml documentation classifiers.
#    Controls which DISA panels/params are non-test "documentation" routed to
#    the forms feed. Never hardcode panel/param codes — add them to the YAML.
OPENLDR_COUNTRY=zambia

# 4. X-DataFeed-Id — the v2 API requires this header to pick which schema /
#    mapper / storage / outpost plugins apply. The CLI resolves it by name:
#    /projects → /use-cases → /feeds. Cached for the run.
OPENLDR_PROJECT_NAME=Built-in
OPENLDR_USE_CASE_NAME=Built-in
OPENLDR_DATA_FEED_NAME=Built-in
# OR skip discovery and pin the UUID directly:
# OPENLDR_DATA_FEED_ID=00000000-0000-0000-0001-000000000003

# 5. Forms feed — data feed for the v2 forms (non-test) feed. Resolved the
#    same way as OPENLDR_DATA_FEED_NAME. Required only when a run produces
#    documentation records to POST.
OPENLDR_FORMS_DATA_FEED_NAME=Built-in-Forms
```

If the v2 instance has a self-signed cert (typical for local dev), also set:

```bash
OPENLDR_V2_INSECURE_TLS=true   # equivalent to NODE_TLS_REJECT_UNAUTHORIZED=0
```

### Token resolution precedence

For each `--post` invocation the CLI picks a token in this order, stopping at the first match:

1. `--token <bearer>` flag — manual override, highest priority
2. **Keycloak**, when all four `KEYCLOAK_*` vars are set — minted via `client_credentials` and cached
3. `OPENLDR_V2_TOKEN` env var — static fallback, useful for sites without Keycloak

The output JSON includes `"token_source": "flag" | "keycloak" | "env"` so you can confirm which path ran.

### X-DataFeed-Id resolution

Same idea: explicit ID wins, else discover by name.

| Source | Used when |
|---|---|
| `--data-feed-id <uuid>` flag | always |
| `OPENLDR_DATA_FEED_ID` env | flag absent |
| Discovery via `(project, useCase, feed)` names | both above absent and the three names are set |
| Header omitted | none of the above resolve |

The discovery chain GETs three endpoints in sequence, matches by name, and caches the result in-process:

```
GET /api/v1/projects                              → projectId by projectName
GET /api/v1/projects/{projectId}/use-cases        → useCaseId by useCaseName
GET /api/v1/projects/use-cases/{useCaseId}/feeds  → dataFeedId by dataFeedName
```

The output JSON includes `"data_feed_source": "explicit" | "discovered" | "none"`.

### Verify wiring without sending

```bash
pnpm dev export TDS0114466 --post --dry-run-post
```

Prints the prepared HTTP request: full URL, redacted Authorization header, the resolved X-DataFeed-Id, payload size, and `token_source` / `data_feed_source` so you can confirm what would have been sent.

### Send for real

```bash
pnpm dev export TDS0114466 --post
```

Success (exit 0) → JSON on stdout:

```json
{
  "posted": true,
  "request_id": "TZDISATDS0114466",
  "status": 200,
  "attempts": 1,
  "duration_ms": 168,
  "token_source": "keycloak",
  "data_feed_id": "00000000-0000-0000-0001-000000000003",
  "data_feed_source": "discovered",
  "response": {
    "message": "Message successfully processed.",
    "messageId": "c57f84a4-…",
    "deduplicated": false,
    "size": 11088
  }
}
```

The HTTP 200 here only confirms **ingest** — the message is on Kafka. Validation, mapping, storage, and outpost run async after that. Use `--track` (below) to wait for the actual outcome.

### `--track`: wait for the pipeline

```bash
pnpm dev export TDS0114466 --post --track
```

Polls `GET /api/v1/runs/{messageId}` every second (configurable) until `currentStatus` is terminal (`completed` / `failed` / `error` / `dlq` / `rejected`) or the timeout (default 60 s) elapses.

Output appends a `"tracking"` block:

```json
"tracking": {
  "run": {
    "currentStage": "outpost",
    "currentStatus": "completed",
    "errorStage": null, "errorCode": null, "errorMessage": null,
    "createdAt": "…", "completedAt": "…"
  },
  "events": [ /* one entry per stage event: ingest → validation → mapping → storage → outpost */ ],
  "attempts": 1,
  "duration_ms": 132,
  "timed_out": false
}
```

Exit codes:
- **0** — `currentStatus = "completed"`
- **9** (`API_REJECTED`) — non-`completed` terminal state. The full run + events + error fields are in the JSON details so you can see *which stage* failed.
- **10** (`API_UNAVAILABLE`) — the run row never appeared, or the tracking endpoint returned 5xx after retries.

Tunables: `--track-timeout <ms>` (default 60000), `--track-interval <ms>` (default 1000).

### Server-side dedup

The v2 API hashes incoming payloads. A second POST of an identical payload returns **HTTP 200** with:

```json
{
  "message": "File already processed (deduplicated).",
  "messageId": "<original-id>",
  "deduplicated": true
}
```

The CLI surfaces `"deduplicated": true` in the `response` block. When `--track` is also set, it tracks the *original* run (which is already terminal). The v2 API itself dedups silently — there's no force/cancel prompt at the API level (the UI implements that client-side by checking `deduplicated`).

To force re-processing of an identical payload, pass **`--force`** — the CLI appends `?force=true` to the POST URL and the API processes it as a new message with a fresh `messageId`:

```bash
pnpm dev export TDS0123369 --post --track --force
# → "deduplicated": false, new messageId, fresh pipeline run
```

### Combining with other flags

```bash
# POST + save the payload locally too
pnpm dev export TDS0114466 --post --out ../../temp/output.json

# POST only after v1 fidelity passes (full belt-and-braces run)
pnpm dev export TDS0114466 --post --check --track

# Override the target API for a one-off (e.g. staging)
pnpm dev export TDS0114466 --post --target-api https://staging.openldr --token <bearer>

# Skip TLS verification just for this invocation
pnpm dev export TDS0114466 --post --insecure-tls
```

### Retry policy (POST itself, per [PRD §9](docs/PRD.md))

| Response | Behaviour |
|---|---|
| 2xx | Success, return immediately. |
| 4xx (not 429) | `CliError("API_REJECTED")` exit 9 — payload is wrong, don't retry. Response body included in error details. |
| 429 | Honour `Retry-After` header (or default backoff), retry without consuming attempt budget. |
| 5xx, network error, timeout | Retry with exponential backoff (1s, 2s, 4s, 8s, 16s, 32s, 60s capped) up to 5 attempts. Then `CliError("API_UNAVAILABLE")` exit 10. |

Per-request timeout is 30 s. Both are tunable via `PostOptions` in [`apps/cli/src/api/client.ts`](apps/cli/src/api/client.ts) — surface as flags if needed.

### v1 + `--post` is rejected

`--post` only works with `--type v2` (v1 has no target API). Using `--post --type v1` errors with `NOT_SUPPORTED`.

### Batch export (`export-batch`)

Per-lab POST for many labs in one shot. Both gates (`--check` for v1 fidelity, `--quarantine-on-anomaly` for audit anomalies) are **on by default** because clean matching data is the goal of the migration.

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
  [--data-feed-id <uuid>] [--project-name ...] [--use-case-name ...] [--data-feed-name ...]
  [--insecure-tls] [--force]
  [--track] [--track-timeout <ms>] [--track-interval <ms>]
  # Operational:
  [--resume-from <path>]           # skip lab numbers seen in this prior NDJSON
  [--dry-run]                      # run gates + build payload, skip POST
  [--summary-only]                 # suppress per-lab stdout
  [--explain]                      # show config, exit
  [--emit-payloads]                # write v2 payloads to stdout as NDJSON
                                   # instead of POSTing — pipes into
                                   # `openldr ingest stream`
```

**Per-lab status** (one NDJSON line per lab on stdout):

| status | Meaning |
|---|---|
| `posted` | New POST accepted by v2 (HTTP 2xx). |
| `deduplicated` | v2 returned 200 with `deduplicated: true` — same payload was already ingested. Use `--force` to re-process. |
| `quarantined` | Audit's `max_severity` met `--quarantine-severity` threshold; payload + audit report written to `--quarantine-dir`. POST skipped. |
| `check_failed` | `--check` found v1-fidelity drift; POST skipped. |
| `not_found` | DISA had no REGDAT4 row for the lab number. |
| `errored` | Fetch / build / POST / track failed. `error_code` + `error_message` populated. |
| `emitted` | `--emit-payloads` mode only: payload was written to stdout. Tallied as `posted` in the summary so existing exit-code logic still works. |

**Token freshness.** Keycloak access tokens are short-lived (default 5 min). The batch resolves a token resolver at startup (not the token itself) and calls it before every POST, so multi-hour runs don't fail with stale-token 401s. Resolver is the cached `fetchKeycloakToken` from [`apps/cli/src/api/keycloak.ts`](apps/cli/src/api/keycloak.ts) — refreshes ~30s before expiry, otherwise returns the cached value (essentially free).

**Concurrency.** A DB-only mutex serialises the fetch + check phases (mssql exposes one shared pool that doesn't tolerate concurrent connection-string switching), but the **POST runs free**. Real parallelism shows up at the API tier — exactly what you want for rate-limit testing. Default `--concurrency 1` is the safe starting point.

**Resume.** Each lab gets one NDJSON line on stdout. To resume after an interruption, point `--resume-from <path>` at the previous run's stdout file — labs that already appear (any status) are skipped. The same file works as journal + checkpoint.

```bash
# First attempt — interrupted at lab N
cdr export-batch --limit 50000 --concurrency 5 \
  --target-api https://v2.openldr.example.com --insecure-tls \
  > /tmp/run1.ndjson 2> /tmp/run1.log

# Resume — re-uses run1's progress
cdr export-batch --limit 50000 --concurrency 5 \
  --target-api https://v2.openldr.example.com --insecure-tls \
  --resume-from /tmp/run1.ndjson \
  > /tmp/run2.ndjson 2>> /tmp/run1.log
```

**Heartbeat.** Every `min(500, concurrency * 25)` labs the batch emits an `export-batch-progress` line on stderr with running counts. So a multi-hour run isn't a black box.

**Exit codes.** `0` only when every attempted lab landed in `posted` or `deduplicated`. Anything else → exit 9 (`API_REJECTED`) with a summary so the operator knows the run wasn't fully clean.

**Workflow recommendation.** For your 90 GB production scenario, with `OPENLDR_V2_URL` / `KEYCLOAK_*` / `OPENLDR_*_NAME` already in `.env`:

```bash
# 1. Audit-only preview to size the cleanup ahead (fast, no POST)
cdr audit-batch --source openldr --limit 100000 \
  --report-out ../../temp/preview.pdf --total-labs 5000000 \
  > ../../temp/preview.ndjson 2> ../../temp/preview.log

# 2. Real export — env-driven config; --insecure-tls only for self-signed v2
cdr export-batch --limit 5000000 --concurrency 1 \
  --insecure-tls --track \
  > ../../temp/export.ndjson 2> ../../temp/export.log

# 3. Quarantined / errored labs land in temp/quarantine/ — review, fix
#    in DISA, then re-run export-batch with --resume-from temp/export.ndjson
#    so only the previously-blocked labs get retried.
```

### Stream into `openldr ingest stream` (`--emit-payloads`)

Faster alternative to the per-lab `--post` path: cdr-toolchain builds the v2 payload as usual but writes it to **stdout as NDJSON** instead of POSTing. `openldr ingest stream` reads stdin and POSTs each line through the gateway with its own worker pool. Two CLIs each do what they're good at; the OS pipe handles back-pressure.

```bash
# Quick smoke
cdr export-batch --where "LabNo LIKE '00613%'" --emit-payloads --limit 10 \
  | openldr ingest stream --feed <feedId> --concurrency 4 --track

# Production bulk migration — drop --check on the cdr side (the fidelity
# gate dominates per-lab cost), raise both concurrencies
cdr export-batch \
    --where "LabNo BETWEEN '0061300000' AND '0061399999'" \
    --emit-payloads \
    --no-check \
    --concurrency 8 \
  | openldr ingest stream \
      --feed <feedId> \
      --concurrency 16 \
  > ./temp/submitted.ndjson \
  2> ./temp/summary.ndjson
```

**What changes in `--emit-payloads` mode:**

- **stdout** carries the v2 payload, one JSON object per line — ready for `openldr ingest stream` (or `jq`, or `curl`, or anything else that reads NDJSON).
- **stderr** carries the per-lab journal (same NDJSON shape as the normal-mode stdout journal) plus the progress heartbeat and the final `_meta: "export-batch-summary"` line. This keeps stdout clean of metadata so the consumer sees only payloads.
- **`--post`, `--target-api`, `--token`, `--data-feed-id`, `--track`** are ignored — there's no POST in this mode. cdr-toolchain stops at "payload built"; openldr-cli takes over the network and tracking.
- **`--check` and `--quarantine-on-anomaly` still run** ahead of payload build. A `check_failed` or `quarantined` lab is skipped on the cdr side and never reaches the consumer pipe — the upstream fidelity / data-quality gates remain enforced.
- **`--no-check`** is recommended when you've already accepted v1 fidelity drift (or you don't have a v1 mirror configured). The v1-diff query is the largest single per-lab cost — disabling it drops `avg_ms_per_lab` from ~120 ms to ~30 ms.

**Why pipe instead of `--post`?**

- **Concurrency on both sides.** cdr's `--concurrency` parallelises DISA reads + v2 transforms; openldr's `--concurrency` parallelises POSTs. The two pools size independently to their respective bottlenecks.
- **Path-scoped relaxed nginx zone.** openldr's gateway has a `limit_req zone=ingest-bulk rate=500r/s burst=200 nodelay;` location specifically on `/data-processing/api/v1/processor/process-feed`, so a single ingest client can sustain ~10× more throughput than the default 50 r/s ceiling. See `apps/openldr-gateway/nginx.conf.template` in the openldr-v2 repo.
- **OS-level back-pressure.** If the openldr consumer slows down (server-side stage congestion, Kafka lag), the OS pipe buffer fills and cdr's worker pool blocks on `process.stdout.write`. No retry queue, no head-of-line blocking — natural flow control.

**Shell quoting tip.** pnpm prints workspace banners (`Scope: all`, `> @cdr-toolchain/cli@...`) to stdout that pollute the pipe. Either run with `pnpm -s` (silent) or bypass pnpm entirely:

```bash
# Cleanest invocation — no pnpm banner risk
apps/cli/node_modules/.bin/tsx apps/cli/src/index.ts export-batch \
    --where "LabNo LIKE '00613%'" --emit-payloads \
  | openldr ingest stream --feed <feedId> --concurrency 16
```

---

## Audit subsystem

Detects data-quality anomalies in DISA records before they migrate to v2. Two surfaces share one detector:

1. **Standalone commands** — `cdr audit <lab>` and `cdr audit-batch` for on-demand triage.
2. **Embedded in `cdr export`** — every `--type v2` invocation runs the audit internally; anomalies surface as a `data_quality` block in the payload, and `--quarantine-on-anomaly` blocks high-severity labs from POSTing.

The detector is a pure function over `SpecimenRecpt`, plus a v1 adapter that projects OpenLDR v1 `Requests`/`LabResults` rows back into the same input shape — so the same detector audits the legacy mirror retrospectively.

### Anomaly classes

| Class | Severity | What it catches |
|---|---|---|
| `panel_specimen_mismatch` | error | Panel description implies one specimen kind but specimen description says another. Registration data-entry error (e.g. urine-microscopy panel + stool specimen). |
| `dob_after_specimen_date` | error | Patient DOB is after the earliest specimen-event date. |
| `dob_future_dated` | error | DOB is in the future. |
| `observation_wrong_panel` | error | AST observations (PARMDICT context 60/79) inside a microscopy-described panel. |
| `specimen_missing` | error | Panel implies a specimen kind but the request has no specimen recorded at all. v2 storage requires `specimen_concept_id`; a null `specimen_code` never gets mapped, so storage always rejects. Quarantined by default so the operator fixes the upstream data. |
| `cross_panel_duplicate_observation` | warn | Same observation code under multiple panels with disjoint specimen kinds. |
| `result_unrealistic_numeric` | warn | Numeric value > 1e12 or < 1e-6 (excluding 0). Almost always uninitialised-float garbage from a misdecoded blob slot. |
| `result_contains_control_chars` | warn | Result string contains stray DISA control bytes (0x01–0x1F excluding tab/LF/CR). Decode-layer bug. |
| `result_format_microscopy_count` | warn | Microscopy parameter (WBC, RBC, leucocytes, epithelial) value doesn't match recognised count/range/semi-quantitative pattern. |
| `result_format_invalid_decoded` | warn | Coded result decoded to "Invalid" outside an AST context — known Tanzania COMMDICT typo at CONTEXT=79. |
| `sex_code_invalid` | warn | Sex code outside `M`/`F`/`U`/`I`/blank. |
| `orphan_ordered_panel` | info | Panel ordered but no observations entered. |
| `specimen_description_vague` | info | Specimen has a code but description doesn't tokenise to any known kind. |
| `result_format_units_inline` | info | Numeric value contains units inline despite PARMDICT supplying them separately. |

Severity ladder: `info < warn < error`. The audit emits one `Anomaly` per finding and reports the highest seen as `max_severity`.

### Single-lab audit

```bash
cdr audit <labNumber>
  [--source disa|openldr]   # default: disa
  [--prefix <str>]
  [--openldr-cs <url>]      # only used by --source openldr
```

`--source openldr` runs the same detector against the OpenLDR v1 mirror — for retrospective review of records that already migrated. The codebook (PARMDICT/COMMDICT/TESTDICT/USERDIC6) always loads from DISA because v1 mirrors DISA's codes; `DISA_CONNECTION_STRING` is required regardless of source. DOB checks (`dob_after_specimen_date`, `dob_future_dated`) skip cleanly under `--source openldr` because v1 doesn't preserve raw DOB strings.

Output is one NDJSON `AuditReport` line. Exit code is `0` regardless of anomalies — anomalies are data, not failures.

### Batch audit

```bash
cdr audit-batch
  [--source disa|openldr]
  [--where <sql>] [--limit <n>] [--offset <n>]
  [--summary-only] [--only-anomalies]
  [--explain]
```

Per-lab `AuditReport` to stdout (NDJSON), batch summary on stderr. The summary includes per-class counts, top-10 panel codes by anomaly count, and labs scanned / errored.

Performance: ~0.10s per lab on `--source disa` (per-lab blob hydration), ~0.015s per lab on `--source openldr` (flat columns, no decode). A 50,000-lab DISA scan completes in ~55 minutes.

### `data_quality` block in v2 payloads

Every `cdr export --type v2` runs the audit internally. When the audit finds at least one anomaly, the v2 payload gains a `data_quality` field:

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
        "message": "Panel \"MICROBIOLOGY : CSF\" implies csf, but specimen \"Stools\" is stool.",
        "panel_code": "MCSF", "details": {…} }
    ]
  }
}
```

Clean labs (no anomalies) produce payloads **without** the `data_quality` field — byte-identical to pre-audit behaviour for migration consumers that don't expect it. Use `--no-data-quality` to suppress the block regardless of anomaly state.

### `--quarantine-on-anomaly` (gated migration)

```bash
cdr export <lab> --post --type v2 \
  --quarantine-on-anomaly /var/lib/disa/quarantine \
  [--quarantine-severity error|warn|info]
```

When the audit's `max_severity` meets the threshold (default `error`), the CLI:

1. Writes `<dir>/<labNumber>.json` containing the full audit report and the prepared payload.
2. Throws `CliError("QUARANTINED")` with exit code **11**.
3. **Does NOT** POST to v2.

Quarantine file shape:

```json
{
  "lab_number": "TDS0011621",
  "request_id": "TZDISATDS0011621",
  "quarantined_at": "2026-04-29T11:12:21.991Z",
  "threshold": "error",
  "audit_report": { /* full AuditReport */ },
  "payload":      { /* full V2Payload, including data_quality */ }
}
```

Compatible with `--check`: the v1-fidelity check evaluates first (exits 7 `MISMATCH` on miss); if it passes, the audit runs and may exit 11 instead. v1 + `--quarantine-on-anomaly` is rejected with `NOT_SUPPORTED` (v1 has no audit-driven quarantine path).

### Specimen-kind vocabulary

The panel-vs-specimen mismatch detector uses a hand-curated vocabulary in [`apps/cli/src/audit/specimen-vocab.ts`](apps/cli/src/audit/specimen-vocab.ts) — kept in TypeScript (under code review) rather than YAML, matching the project's "no per-country YAMLs" stance. Kinds:

`urine`, `stool`, `blood` (incl. plasma/serum/whole-blood), `csf`, `sputum`, `swab`, `pus`, `tissue`, `genital`, `body_fluid` (pleural/pericardial/peritoneal/synovial/ascitic), `skin_hair_nail`.

Plus a `KIND_COMPATIBLE` override list for legitimate cross-kind pairings (swab↔pus, swab↔tissue, swab↔genital). Add overrides only when real data proves a false positive — resist growing the list.

### Generating a stakeholder report (PDF / DOCX / MD / HTML)

`cdr audit-report` consumes an audit-batch NDJSON stream and renders it into a single file. The same renderer is also reachable inline via `cdr audit-batch --report-out` for a one-shot scan + report flow.

**Standalone (consume existing NDJSON):**

```bash
# Generate a full NDJSON (no --only-anomalies) so totals are correct
cdr audit-batch --limit 50000 > /tmp/scan.ndjson 2>> /tmp/scan.ndjson

# Render
cdr audit-report \
  --input /tmp/scan.ndjson \
  --out /tmp/report.pdf \
  --total-labs 5000000 \
  --title "Tanzania DISA Migration Audit (50k sample)"
```

**One-shot (scan + render together):**

```bash
cdr audit-batch --limit 50000 \
  --report-out /tmp/report.pdf \
  --total-labs 5000000 \
  --report-title "Tanzania DISA Migration Audit"
```

**Format selection.** `audit-report` infers the format from the `--out` extension (`.pdf` / `.docx` / `.md` / `.html`). Override with `--format`. The same applies to `--report-out` / `--report-format` on `audit-batch`.

**Report sections:**
- Title block — generated-at timestamp, source (`disa` / `openldr` / `mixed`), scan duration.
- Executive summary — labs scanned, labs with anomalies, total anomalies, severity breakdown.
- Forecast (when `--total-labs` is supplied) — linear projection of per-lab rates × estimated total. Useful for previewing a 90 GB production scan from a 1 GB sample.
- Anomalies by class — sorted by severity then count.
- Detailed findings — one section per anomaly class with up to `--report-max-samples` (default 10) sample lab numbers and messages.
- Top affected panels — up to 25 panels by anomaly count.
- Unfetchable labs — aggregated unique error messages with sample lab numbers.
- Methodology — what each anomaly class checks (sourced from `CLASS_DESCRIPTIONS` in `apps/cli/src/audit/report-types.ts`).
- Limitations — explicit caveats (e.g. DOB checks skip on `--source openldr`).

**Forecast caveats.** The forecast is a linear extrapolation: `(per-lab rate from sample) × estimated_total_labs`. Real ratios may differ when:
- The sample missed dataset eras with different schemas (early DISA versions, recent format changes).
- The sample skews to one section (microbiology vs chemistry) with different anomaly density.
- Unfetchable-lab errors cluster in a specific era (e.g. lab numbers with NULL chars from a single ingestion bug).

Treat forecasts as a planning aid, not a guarantee.

**Standalone path totals.** `audit-batch` writes per-lab NDJSON to **stdout** and the summary to **stderr**. When using the standalone `audit-report` path, capture both: `audit-batch ... > scan.ndjson 2>> scan.ndjson`. Without the summary line, the report's "labs scanned" reflects only the lines actually in the stream — which undercounts when `--only-anomalies` was set. `audit-report` emits a `warning` field on stderr in that case.

The one-shot `audit-batch --report-out` path doesn't have this problem — the aggregator hooks directly into the per-lab loop.

**Performance.** Rendering is fast even for large scans because the aggregator caps samples per class (default 10) and top panels (25). A 50,000-lab NDJSON renders to PDF in ~120 ms.

### Adding a new anomaly class

1. Append to `AnomalyClass` in [`apps/cli/src/audit/types.ts`](apps/cli/src/audit/types.ts).
2. Add the same string to `ALL_CLASSES` in [`apps/cli/src/commands/audit.ts`](apps/cli/src/commands/audit.ts) (used by the batch summary's per-class rollup).
3. Add the detection logic to [`apps/cli/src/audit/detector.ts`](apps/cli/src/audit/detector.ts) — usually as a new `detect*()` helper called from `detectAnomalies()`.
4. Add a `CLASS_DESCRIPTIONS` entry in [`apps/cli/src/audit/report-types.ts`](apps/cli/src/audit/report-types.ts) so the new class appears in report methodology + per-class tables.
5. If the class needs new dictionary fields, extend [`apps/cli/src/export/codebook.ts`](apps/cli/src/export/codebook.ts).
6. Smoke-test on `TDS0114466` (clean), `TDS0011621` (panel/specimen mismatch), and `TDS0035473` (unrealistic-numeric); expect deterministic severity + class assignment.

---

## Configuration reference

All env vars live in `apps/cli/.env` (or override via global flags). See `apps/cli/.env.example` for the template.

| Var | Required | Used by | Notes |
|---|---|---|---|
| `DISA_CONNECTION_STRING` | yes | every command except `errors` / `tables` / `schema` / `config show` | MSSQL connection string. Two formats supported: `Server=...;Database=...;User=...;Password=...;Encrypt=false` or `mssql://user:pass@host:1433/db`. |
| `DISA_OUTPUT` | no | every command | Default output format (`ndjson` \| `json` \| `pretty`). Overridable per-call with `--output`. |
| `OPENLDR_V1_CONNECTION_STRING` | only for `compare*` / `export --check` | `compare`, `compare-results`, `compare-batch`, `export --check` | OpenLDR v1 SQL Server. Same format as DISA. |
| `OPENLDR_LABNO_PREFIX` | no | `compare*`, `export` | Prefix added to DISA labno when constructing v1 RequestID. Empty by default — set per deployment (e.g. `TZDISA` for Tanzania; leave empty for Zambia). |
| `OPENLDR_V1_DATABASE_DATA` | no | `compare*` | Default `OpenLDRData`. SQL is fully-qualified, so the DB name doesn't have to match the connection string's. |
| `OPENLDR_V1_DATABASE_DICT` | no | (placeholder) | Default `OpenLDRDict`. Reserved for future commands. |
| `OPENLDR_V2_URL` | only for `export --post` | `export --post` | Base URL of the OpenLDR v2 API. No trailing slash. |
| `OPENLDR_V2_TOKEN` | optional fallback for `export --post` | `export --post` | Static bearer token. Used only when no `--token` flag and no Keycloak vars are set. |
| `OPENLDR_V2_PATH` | no | `export --post` | Endpoint path. Default `/api/v2/lab-requests`. |
| `OPENLDR_V2_INSECURE_TLS` | no | `export --post` | `true`/`1`/`yes`/`on` skips TLS cert verification on v2 + Keycloak fetches. Self-signed local dev only — sets `NODE_TLS_REJECT_UNAUTHORIZED=0` for the run. |
| `KEYCLOAK_PUBLIC_URL` | only for Keycloak token-minting | `export --post` | Base URL of the Keycloak instance. No trailing slash. Token endpoint is `{url}/realms/{realm}/protocol/openid-connect/token`. |
| `KEYCLOAK_REALM` | only for Keycloak token-minting | `export --post` | Realm hosting the OpenLDR client. |
| `KEYCLOAK_CLIENT_ID` | only for Keycloak token-minting | `export --post` | Client ID configured for service accounts (client_credentials grant). |
| `KEYCLOAK_CLIENT_SECRET` | only for Keycloak token-minting | `export --post` | Client secret. |
| `OPENLDR_PROJECT_NAME` | only for X-DataFeed-Id discovery | `export --post` | OpenLDR project name. Resolved against `/api/v1/projects`. |
| `OPENLDR_USE_CASE_NAME` | only for X-DataFeed-Id discovery | `export --post` | OpenLDR use case name. Resolved against `/api/v1/projects/{projectId}/use-cases`. |
| `OPENLDR_DATA_FEED_NAME` | only for X-DataFeed-Id discovery | `export --post` | OpenLDR data feed name. Resolved against `/api/v1/projects/use-cases/{useCaseId}/feeds`. |
| `OPENLDR_DATA_FEED_ID` | optional | `export --post` | Pre-resolved data feed UUID. Skips the discovery chain when set. |
| `OPENLDR_COUNTRY` | only for documentation routing | `export --post` / `export-batch` | Country key selecting `config/<country>.yaml` documentation classifiers (e.g. `zambia`, `tanzania`). Controls which DISA panels/params are treated as non-test "documentation" and routed to the forms feed instead of quarantined. Documentation panel/param codes live under the `documentation:` key in the country YAML — never hardcode them. |
| `OPENLDR_FORMS_DATA_FEED_NAME` | only for documentation routing | `export --post` / `export-batch` | Data feed name for the v2 forms (non-test) feed. Resolved the same way as `OPENLDR_DATA_FEED_NAME` (project → use-case → feeds). Required only when a run produces documentation records to POST. |

**Connection-string secret hygiene:** `cdr config show` redacts passwords (`pwd=***` and `://user:***@host`). Logs follow the same convention.

---

## Error codes & exit codes

`cdr errors` prints the same table at runtime. Every CliError emits to stderr as:
```json
{"error": {"code": "…", "message": "…", "details": { … }}}
```

| Code | Exit | When it fires |
|---|---:|---|
| `USAGE` | 2 | Invalid args / Commander parse error |
| `UNKNOWN_ENTITY` | 2 | Unknown alias passed to `list` / `schema` / etc. |
| `MISSING_FLAG` | 2 | Required flag not provided |
| `NOT_SUPPORTED` | 2 | Operation not supported for this entity (e.g. `--post --type v1`) |
| `CONFIG_MISSING` | 3 | `DISA_CONNECTION_STRING` not set |
| `CONFIG_INVALID` | 3 | Zod schema validation failed on env |
| `ENV_FILE_UNREADABLE` | 3 | `--env-file` path can't be read |
| `OPENLDR_CONFIG_MISSING` | 3 | `OPENLDR_V1_CONNECTION_STRING` not set when `compare` / `--check` is used |
| `API_CONFIG_MISSING` | 3 | `OPENLDR_V2_URL` or `OPENLDR_V2_TOKEN` not set when `--post` is used |
| `DB_CONNECT_FAILED` | 4 | mssql couldn't open a connection |
| `DB_QUERY_FAILED` | 4 | mssql returned an error during query |
| `NOT_IMPLEMENTED` | 8 | Capability recognised but not built. (Currently no command throws this — kept for future stubs.) |
| `GET_NO_ROWS` | 6 | `get` / `compare` / `export` matched no rows |
| `GET_MULTIPLE_ROWS` | 6 | `get` matched more than one row |
| `MISMATCH` | 7 | `compare` or `--check` found at least one differing field/observation |
| `API_REJECTED` | 9 | OpenLDR v2 returned 4xx (not 429) |
| `API_UNAVAILABLE` | 10 | OpenLDR v2 unreachable / 5xx after retries |
| `QUARANTINED` | 11 | `export --quarantine-on-anomaly` triggered: audit found anomalies at or above threshold; payload written to quarantine path instead of POSTed |
| `UNKNOWN` | 1 | Anything not mapped above |

These are stable — scripting against them is safe. Add new codes by editing [`apps/cli/src/errors.ts`](apps/cli/src/errors.ts).

---

## Architecture

### Data flow for a single-lab export

```
                         ┌────────────────────────┐
                         │  apps/cli/src/index.ts │
                         │  (Commander wiring)    │
                         └──────────┬─────────────┘
                                    ▼
                         ┌────────────────────────┐
                         │  commands/export.ts    │
                         │  parses flags          │
                         └──────────┬─────────────┘
                                    ▼
       ┌────────────────────────────┴────────────────────────────┐
       ▼                            ▼                            ▼
┌──────────────┐           ┌──────────────────┐         ┌────────────────────┐
│ disalab      │           │ codebook.ts      │         │ openldr.ts (v1)    │
│ REGDAT4.All  │           │ loadCodebook(srv)│         │ fetchRequest…      │
│ Specimen-    │           │ → PARMDICT/      │         │ fetchLabResults…   │
│ Recpt.Fetch  │           │   COMMDICT/      │         │ (only if --check)  │
│              │           │   TESTDICT/      │         └────────────────────┘
│ AUDTDATA.All │           │   USERDIC6       │
│ (only v1)    │           │   maps           │
└──────┬───────┘           └────────┬─────────┘
       │                            │
       ▼                            ▼
┌──────────────────────────────────────────┐
│  toV2(specimen, {prefix, site, codebook})│   or  toV1(specimen, {prefix, codebook,
│  → V2Payload                             │                       auditRows})
└──────────────────┬───────────────────────┘                  → V1Payload
                   ▼
          ┌─────────────────────┐
          │ Output dispatch     │
          │  --out file?        │
          │  --post?            │
          │  stdout?            │
          └────────┬────────────┘
                   ▼
          ┌─────────────────────┐
          │ api/client.ts       │  (only with --post)
          │ postLabRequest()    │
          │ fetch + retries     │
          └────────┬────────────┘
                   ▼
            OpenLDR v2 API
```

### Streaming topology (NOT yet built)

`docs/PRD.md §4` describes a streaming `disa-migrate run` for whole-deployment migrations: a single-pass cursor over distinct RequestIDs, transforming and POSTing one at a time with checkpoint/resume. Not implemented — current scope is single-lab `cdr export`. When we do build it, the per-lab pipeline above is exactly what each iteration calls.

### Why no country YAML?

`docs/PRD.md §6` originally proposed per-country YAML config with antibiotic / no-growth / fungus / panel lists. Phase 3 abandoned that in favour of dictionary-driven categorisation: the same codes live in DISA's own `PARMDICT` / `COMMDICT` / `TESTDICT` / `USERDIC6`, and the CLI queries them directly. Means zero per-country YAML drift and the rules adapt automatically to whatever the deployment's dictionary says.

The small set of things the dictionary genuinely doesn't know — v2 `system_id` strings, default susceptibility guideline — live as constants in [`apps/cli/src/export/site-config.ts`](apps/cli/src/export/site-config.ts).

---

## Verification & known-good labs

The Tanzania DISA deployment has two labs that exercise different code paths well:

### `TDS0114466` — microbiology, no AST

```bash
pnpm dev export TDS0114466 --output json --out ../../temp/output.json
```

Expected v2 output:
- 1 isolate: VIBCO ("Vibrio cholera 01 Ogawa", `bacteria`)
- 4 lab_results: 3 generic (OXID/INDOL/MTXT) + 1 ORGS. MSENS panel was ordered but empty so no AST rows.
- 0 susceptibility_tests
- panel_code = MRCSW (lower TESTINDEX wins)
- specimen_code = PUSR ("Rectal Swab")
- Patient: EZRONI KICHWA, M, age 20

```bash
# v1 export of the same lab — compare against actual v1 row in DB
pnpm dev export TDS0114466 --type v1 --output json --out ../../temp/output.v1.json
# Should produce 3 Requests rows (MRCSW, MICBM, MSENS) + 4 LabResults rows
# matching real v1 at 96% of derivable fields
```

### `TDS0123369` — microbiology with AST

```bash
pnpm dev export TDS0123369 --output json --out ../../temp/output.json
```

Expected v2 output:
- 2 isolates: ACIBA ("Acinetobacter baumanii") in both MICU and MSENS panels (DISA recorded the same organism in two panels)
- 11 lab_results: 3 generic + 2 ORGS + 6 AST
- 6 susceptibility_tests, all linked to isolate 1 (CIPRO=R, CTX=I, AMIK=S, GENTA=R, CEFTA=I, TOBRA=R)

### Dry-run POST (no live API needed)

```bash
OPENLDR_V2_URL="https://example.com" OPENLDR_V2_TOKEN="any-string" \
  pnpm dev export TDS0114466 --post --dry-run-post
# Prints the prepared request — URL composed, headers redacted, payload bytes counted
```

### Live POST against httpbin (echoes the request)

```bash
OPENLDR_V2_TOKEN="test" pnpm dev export TDS0114466 --post \
  --target-api https://httpbin.org --api-path //post   # //post is intentional, see Git Bash gotcha
# Expect: status 200, response.json contains the full v2 payload echoed back
```

### Phase 1+2 fidelity audit (still passes 100 %)

```bash
# Single lab, request-level only
pnpm dev compare TDS0114466

# Single lab, per-observation
pnpm dev compare-results TDS0114466

# Batch — first 100 labs in TDS013 series, observation-level
pnpm dev compare-batch --where "WHERE [LabNo] LIKE 'TDS013%'" --limit 100 --results
```

---

## Known limitations & gotchas

### Operational

- **Git Bash on Windows path-mangles leading-`/` args.** A CLI arg starting with `/` (e.g. `--api-path /post`) gets prepended with the Git installation path (`/c/Program Files/Git/post`). Workaround: use `//post` (Git Bash strips one slash). Env vars in `.env` are not affected.
- **`pnpm dev export TDS… > out.json` includes pnpm's lifecycle banner** on Windows because pnpm writes it to stdout (not stderr). Use `--out <path>` for clean file output.
- **Running from repo root via `pnpm dev <subcommand>`** goes through Turbo, which runs every workspace's `dev` and eats `--` args. Run from `apps/cli/` or use `pnpm --filter @cdr-toolchain/cli dev <subcommand>`.
- **PowerShell `>` redirection writes UTF-16 with a BOM**, which breaks NDJSON consumers (e.g. `openldr ingest stream`, `jq`, `--resume-from`). When piping `cdr export-batch` output to a file in PowerShell, use `| Out-File -Encoding utf8NoBOM out.ndjson` (PowerShell 7+) or wrap the call in `cmd /c "... > out.ndjson"`. Git Bash / WSL do not have this problem. See [Windows (PowerShell / cmd) setup](#windows-powershell--cmd-setup) for the full PowerShell / cmd reference.

### Data semantics

- **`OrderItem.Value` is COMMDICT-decoded; `OrderItem.RawValue` is the pre-decode code.** For coded types, always prefer `RawValue` for canonical short codes (e.g. `"S"` not `"Susceptible"`).
- **CONTEXT 79 in this Tanzania COMMDICT decodes `I → "Invalid"` instead of `"Intermediate"`.** Real DISA data quality issue. The transform sidesteps it by reading `RawValue` for the AST `susceptibility_value`.
- **Same organism observed in multiple panels = multiple isolates.** TDS0123369 has ACIBA in both MICU and MSENS, producing two isolates. v2 may want dedupe — not currently implemented; could be added by deduping `isolates[]` on `organism_code.concept_code` within a request.
- **Disalab `Facility` class assigns LOCNDIC4 address columns to `Region`/`District`/`PostalAddress`/`Street` based on column ORDER, not content.** For some facilities the labels are misleading (e.g. `region: "108713-9"` is actually the HFR code). Output is faithful, just labelled per disalab's convention.
- **DISA datetimes are local time without TZ.** v2 export emits ISO without `Z`. v1 export emits `…Z` to match real v1's serialisation byte-for-byte (false UTC claim — both are local).

### v1 export

- **`AgeInDays` is off by 1 for some labs.** Real v1's day-counts vary across rows for the same `AgeInYears`, so there's no single formula to match. Off-by-1 accepted.
- **`LIMSRptResult` for OXID/INDOL etc. ships as `"POS"` instead of v1's `"Positive"`.** Disalab doesn't COMMDICT-decode params with `CONTEXT=-1`; v1's migration apparently did a fallback lookup across multiple contexts. Acceptable for "phasing out v1".
- **4 LIS-stamped fields per Requests row** (`DateTimeStamp`, `Versionstamp`, `LIMSDateTimeStamp`, `LIMSVersionstamp`) and same for LabResults are intentionally `null` — only OpenLDR mints those.

---

## Where things live in the code

| What | File |
|---|---|
| CLI entrypoint, all subcommand registration | [`apps/cli/src/index.ts`](apps/cli/src/index.ts) |
| Global flags + runtime context | [`apps/cli/src/commands/context.ts`](apps/cli/src/commands/context.ts) |
| Env loading + Zod validation | [`apps/cli/src/config.ts`](apps/cli/src/config.ts) |
| Error codes + exit-code map | [`apps/cli/src/errors.ts`](apps/cli/src/errors.ts) |
| Output serializers (ndjson/json/pretty) | [`apps/cli/src/output.ts`](apps/cli/src/output.ts) |
| Entity registry (table aliases, columns, fields) | [`apps/cli/src/entities.ts`](apps/cli/src/entities.ts) |
| OpenLDR v1 SQL helpers | [`apps/cli/src/openldr.ts`](apps/cli/src/openldr.ts) |
| Lab-number normalisation (DISA labno ↔ v1 RequestID) | [`apps/cli/src/compare/lab-number.ts`](apps/cli/src/compare/lab-number.ts) |
| Phase 1+2 diff: request-level | [`apps/cli/src/compare/diff.ts`](apps/cli/src/compare/diff.ts) + [`mapping.ts`](apps/cli/src/compare/mapping.ts) |
| Phase 1+2 diff: per-observation | [`apps/cli/src/compare/result-diff.ts`](apps/cli/src/compare/result-diff.ts) + [`result-mapping.ts`](apps/cli/src/compare/result-mapping.ts) |
| Phase 3 V2 payload types | [`apps/cli/src/export/types.ts`](apps/cli/src/export/types.ts) |
| Phase 3 site / system_id config | [`apps/cli/src/export/site-config.ts`](apps/cli/src/export/site-config.ts) |
| Phase 3 dictionary loader (PARMDICT/COMMDICT/TESTDICT/USERDIC6) | [`apps/cli/src/export/codebook.ts`](apps/cli/src/export/codebook.ts) |
| Phase 3 V2 transform (SpecimenRecpt → V2Payload) | [`apps/cli/src/export/v2-transform.ts`](apps/cli/src/export/v2-transform.ts) |
| Phase 3 V1 transform (SpecimenRecpt → V1Payload) | [`apps/cli/src/export/v1-transform.ts`](apps/cli/src/export/v1-transform.ts) |
| Phase 3 export command (orchestrator) | [`apps/cli/src/commands/export.ts`](apps/cli/src/commands/export.ts) |
| Phase 3 batch export (per-lab POST + concurrency + resume) | [`apps/cli/src/commands/export-batch.ts`](apps/cli/src/commands/export-batch.ts) |
| Phase 3 shared `collectOrderedPanels` (used by v1 export + audit) | [`apps/cli/src/export/panels.ts`](apps/cli/src/export/panels.ts) |
| Phase 4 audit types (`Anomaly`, `AuditReport`, severity helpers) | [`apps/cli/src/audit/types.ts`](apps/cli/src/audit/types.ts) |
| Phase 4 specimen-kind vocabulary | [`apps/cli/src/audit/specimen-vocab.ts`](apps/cli/src/audit/specimen-vocab.ts) |
| Phase 4 result-format heuristics (microscopy regex, control-char scan, garbage-float check) | [`apps/cli/src/audit/result-formats.ts`](apps/cli/src/audit/result-formats.ts) |
| Phase 4 detector (`detectAnomalies`, `auditFromSpecimen`) | [`apps/cli/src/audit/detector.ts`](apps/cli/src/audit/detector.ts) |
| Phase 4 v1 adapter (project OpenLDR v1 rows → AuditInputs) | [`apps/cli/src/audit/v1-adapter.ts`](apps/cli/src/audit/v1-adapter.ts) |
| Phase 4 audit + audit-batch commands | [`apps/cli/src/commands/audit.ts`](apps/cli/src/commands/audit.ts) |
| Phase 4 NDJSON aggregator (streaming, capped samples, summary-aware) | [`apps/cli/src/audit/aggregator.ts`](apps/cli/src/audit/aggregator.ts) |
| Phase 4 report types + per-class human-readable descriptions | [`apps/cli/src/audit/report-types.ts`](apps/cli/src/audit/report-types.ts) |
| Phase 4 report renderers (md / html / pdf / docx) + dispatcher | [`apps/cli/src/audit/renderers/`](apps/cli/src/audit/renderers/) |
| Phase 4 audit-report command | [`apps/cli/src/commands/audit-report.ts`](apps/cli/src/commands/audit-report.ts) |
| OpenLDR v2 API client (POST + retry, extra-headers passthrough) | [`apps/cli/src/api/client.ts`](apps/cli/src/api/client.ts) |
| Keycloak token-fetcher (client_credentials grant + cache) | [`apps/cli/src/api/keycloak.ts`](apps/cli/src/api/keycloak.ts) |
| X-DataFeed-Id discovery (project → use-case → feed) | [`apps/cli/src/api/feed-discovery.ts`](apps/cli/src/api/feed-discovery.ts) |
| Pipeline run tracker (polls `/api/v1/runs/{messageId}`) | [`apps/cli/src/api/run-tracker.ts`](apps/cli/src/api/run-tracker.ts) |
| disalab public surface | [`packages/disalab/src/index.ts`](packages/disalab/src/index.ts) |
| disalab decoders (per dictionary / form / data table) | [`packages/disalab/src/lib/`](packages/disalab/src/lib/) |
| Express API scaffold (stub) | [`apps/api/src/`](apps/api/src/) |
| Original product spec | [`docs/PRD.md`](docs/PRD.md) |
| Example v2 schema (canonical reference) | [`temp/default.schema.example.json`](temp/default.schema.example.json) |

---

## Adding a new export field

The most common change. Workflow:

1. Add the field to the relevant type in [`apps/cli/src/export/types.ts`](apps/cli/src/export/types.ts).
2. Populate it in [`v2-transform.ts`](apps/cli/src/export/v2-transform.ts) (or [`v1-transform.ts`](apps/cli/src/export/v1-transform.ts)).
3. If it needs a new dictionary lookup, extend [`codebook.ts`](apps/cli/src/export/codebook.ts) with a new query in `loadCodebook()` and a new method on the `Codebook` interface.
4. `pnpm typecheck` from `apps/cli/`.
5. Test on `TDS0114466` (no AST) and `TDS0123369` (with AST) — they cover most code paths.
6. Commit with a descriptive message.

## Adding a new subcommand

1. New file under [`apps/cli/src/commands/`](apps/cli/src/commands/) exporting `register<Foo>Command(program: Command): void`.
2. Use `loadRuntime(cmd, { requireConnection: ? })` to get config + output settings.
3. Call `process.stdout.write(JSON.stringify(payload) + "\n")` for normal output, or throw `CliError` for failures.
4. Register in [`apps/cli/src/index.ts`](apps/cli/src/index.ts).
5. If you add a new error code, declare it in [`errors.ts`](apps/cli/src/errors.ts).

---

## Conventions

- **JSON on stdout, errors on stderr.** No mixed output. Scripts can pipe stdout cleanly.
- **Deterministic exit codes** (see table above). Suitable for scripting.
- **No emoji** in source, comments, commits, or JSON output. The user does not want them.
- **No co-author trailers on commits.** Don't add `Co-Authored-By: Claude <…>` or "Generated with Claude Code" anywhere.
- **No country YAMLs.** Code categorisation comes from DISA's own dictionaries — see [Architecture](#architecture).
- **Comments explain *why*, not *what*.** Identifiers carry the "what". Comments justify non-obvious choices, hidden constraints, and bug-history wars.
- **Tests live alongside the file under test** (when they exist — coverage is sparse currently).

---

## Roadmap

Confirmed done:
- Keycloak `client_credentials` token minting with in-process cache.
- X-DataFeed-Id resolution via `/projects` → `/use-cases` → `/feeds` discovery.
- `--track` to poll `/api/v1/runs/{messageId}` until terminal.
- `--force` to bypass server-side dedup.
- `OPENLDR_V2_INSECURE_TLS` for self-signed local dev.
- Audit subsystem (Phase 4): single + batch commands, DISA + OpenLDR-v1 sources, 14 anomaly classes, `data_quality` annotation in v2 payloads, `--quarantine-on-anomaly` gating in `cdr export --post`.
- Audit reports (Phase 4 cont.): `cdr audit-report` + `audit-batch --report-out` render PDF / DOCX / Markdown / HTML stakeholder deliverables, with optional forecast section (`--total-labs`) for previewing full-deployment scale from a sample.
- Batch export (`cdr export-batch`): per-lab POST orchestration with both gates on by default, `--concurrency` worker pool (parallel POSTs, serialised DB), `--resume-from` journaling via stdout, heartbeat progress, fatal-handler safety net.

Likely soon:
- Country-pluggable `system_id` values in `site-config.ts`.
- Fix the SQL-escape bug in `REGDAT4.LabNumbers` that errors on lab numbers containing single-quote / NULL chars (~0.1% of the Tanzania dataset).
- Per-connection-string mssql pool registry so `export-batch --concurrency` can parallelise the DB phase too (current implementation serialises DB and parallelises only POST).

Maybe later:
- Move v2 schema TypeScript types into a shared package consumed by both CLI and the v2 API repo.
- WHONET / SNOMED / LOINC mapping (currently v2's responsibility downstream).

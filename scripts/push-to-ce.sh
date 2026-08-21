#!/usr/bin/env bash
# Push DISA*Lab data into an OpenLDR CE install via the CDR toolchain.
#
#   ./scripts/push-to-ce.sh verify    # config + connectivity only, no DISA reads
#   ./scripts/push-to-ce.sh smoke     # 10 labs, full pipeline, NOTHING is POSTed
#   ./scripts/push-to-ce.sh run       # the real push
#   ./scripts/push-to-ce.sh resume    # continue an interrupted run
#
# Reads config from .env (see scripts/.env.ce.example). Every setting can also
# be exported in the environment; the env file never overrides an already-set
# variable.
#
# Run from the repo root.
set -euo pipefail

# ---------------------------------------------------------------- tunables --
LIMIT="${LIMIT:-5000000}"        # upper bound on labs; the WHERE clause is the real filter
CONCURRENCY="${CONCURRENCY:-4}"  # labs in flight; raise once the CE target proves stable
WHERE="${WHERE:-}"               # e.g. "LabNo BETWEEN '0061300000' AND '0061399999'"
ORDER="${ORDER:-asc}"            # asc = oldest labs first (default), desc = newest first
OUTDIR="${OUTDIR:-./temp/ce-push}"

# Invoke the CLI through tsx directly. `pnpm dev -- <cmd>` passes a literal `--`
# that breaks commander's option parsing: flags are SILENTLY ignored and the
# defaults used instead. That failure is invisible in the output, so never
# route this through pnpm.
CDR_BIN="${CDR_BIN:-apps/cli/node_modules/.bin/tsx apps/cli/src/index.ts}"

MODE="${1:-}"
[ -n "$MODE" ] || { echo "Usage: $0 {verify|smoke|run|resume}" >&2; exit 2; }
[ -f package.json ] && [ -d apps/cli ] || { echo "ERROR: run from the cdr-toolchain repo root" >&2; exit 1; }

# Load the env file without clobbering anything already exported. Mirrors the
# CLI's own resolution (config.ts resolveImplicitEnvPath): cwd/.env wins, else
# apps/cli/.env — which is where the file actually lives in a stock checkout.
ENV_FILE="${ENV_FILE:-}"
if [ -z "$ENV_FILE" ]; then
  if   [ -f .env ];          then ENV_FILE=.env
  elif [ -f apps/cli/.env ]; then ENV_FILE=apps/cli/.env
  fi
fi
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  echo "Config: $ENV_FILE"
  while IFS='=' read -r k v; do
    case "$k" in ''|\#*) continue ;; esac
    k="$(printf '%s' "$k" | tr -d '[:space:]')"
    [ -n "${!k:-}" ] || export "$k=$(printf '%s' "$v" | sed 's/^"//;s/"$//')"
  done < "$ENV_FILE"
else
  echo "Config: no .env found (relying on exported environment)"
fi

# ------------------------------------------------------------- preflight ----
fail=0
need() {
  if [ -z "${!1:-}" ]; then echo "  MISSING  $1 — $2" >&2; fail=1; else echo "  ok       $1"; fi
}

echo "Preflight:"
need DISA_CONNECTION_STRING      "Zambia's DISA*Lab MSSQL instance"
# The CE path REFUSES --no-check (see assertCeGatesEnabled in export-batch.ts),
# so a reachable v1 mirror is mandatory here, not optional as it is for v2.
need OPENLDR_V1_CONNECTION_STRING "OpenLDR v1 mirror — the fidelity gate is NOT optional on the CE path"
need OPENLDR_CE_URL              "base URL of the target CE, no trailing slash"
need OPENLDR_CE_WEBHOOK_TOKEN    "Studio -> Workflows -> Ingest -> webhook node -> secret"
need OPENLDR_CE_TIMEZONE         "Zambia is +02:00 — there is no default and no fallback"
need OPENLDR_COUNTRY             "must be 'zambia' to load config/zambia.yaml"

# DISA stores unzoned local wall-clock. A missing/By-UTC offset shifts every
# clinical timestamp 2h with no error, so the CLI hard-fails — mirror that here
# with a clearer message before anything touches the database.
case "${OPENLDR_CE_TIMEZONE:-}" in
  Z|[+-][0-9][0-9]:[0-9][0-9]) ;;
  "") ;;
  *) echo "  BAD      OPENLDR_CE_TIMEZONE='$OPENLDR_CE_TIMEZONE' — want +02:00 for Zambia" >&2; fail=1 ;;
esac

# Zambia does NOT prefix v1 RequestIDs (v1 RequestID == DISA LabNo, e.g.
# ZUL0010002). A stray TZDISA here silently matches zero v1 rows, so every lab
# fails the fidelity check for a reason that looks like missing data.
if [ -n "${OPENLDR_LABNO_PREFIX:-}" ]; then
  echo "  WARN     OPENLDR_LABNO_PREFIX='$OPENLDR_LABNO_PREFIX' is set — Zambia expects it EMPTY" >&2
fi

[ "$fail" -eq 0 ] || { echo; echo "Fix the settings above (see scripts/.env.ce.example) and re-run." >&2; exit 1; }

mkdir -p "$OUTDIR"
JOURNAL="$OUTDIR/journal.ndjson"
SUMMARY="$OUTDIR/summary.log"

common=(export-batch
  --limit "$LIMIT"
  --concurrency "$CONCURRENCY"
  --order "$ORDER"
  --country "$OPENLDR_COUNTRY"
  --ce-url "$OPENLDR_CE_URL"
  --ce-tz "$OPENLDR_CE_TIMEZONE")
# An `[ -n ... ] && arr+=(...)` one-liner would abort the whole script under
# `set -e` whenever WHERE is empty, because the list's exit status is then 1.
if [ -n "$WHERE" ]; then common+=(--where "$WHERE"); fi

case "$MODE" in
  verify)
    # Prints the lab-selection SQL and the effective config, then exits without
    # opening a DISA connection. Confirms flags/env resolved as intended.
    exec $CDR_BIN "${common[@]}" --explain
    ;;
  smoke)
    # Full pipeline (fidelity check + audit quarantine + FHIR transform) with
    # the POST suppressed. Proves the mapping before any data reaches CE.
    echo "Smoke: 10 labs, --dry-run (nothing is POSTed)"
    # Build as an array: an unquoted ${WHERE:+--where "$WHERE"} word-splits a
    # SQL clause on its spaces and passes fragments as separate arguments.
    smoke=(export-batch --limit 10 --concurrency 1
      --order "$ORDER"
      --country "$OPENLDR_COUNTRY"
      --ce-url "$OPENLDR_CE_URL" --ce-tz "$OPENLDR_CE_TIMEZONE"
      --dry-run)
    if [ -n "$WHERE" ]; then smoke+=(--where "$WHERE"); fi
    exec $CDR_BIN "${smoke[@]}"
    ;;
  run)
    echo "Pushing to $OPENLDR_CE_URL  (journal: $JOURNAL)"
    $CDR_BIN "${common[@]}" > "$JOURNAL" 2> "$SUMMARY"
    ;;
  resume)
    [ -f "$JOURNAL" ] || { echo "No journal at $JOURNAL — use 'run' first." >&2; exit 1; }
    # --resume-from reads a PRIOR journal and writes a new one, so the input
    # and output must be different files or the run truncates its own resume set.
    cp "$JOURNAL" "$JOURNAL.prev"
    echo "Resuming, skipping labs already in $JOURNAL.prev"
    $CDR_BIN "${common[@]}" --resume-from "$JOURNAL.prev" > "$JOURNAL" 2> "$SUMMARY"
    ;;
  *)
    echo "Unknown mode: $MODE (want verify|smoke|run|resume)" >&2; exit 2 ;;
esac

echo
echo "Done. Per-lab journal: $JOURNAL"
echo "Summary + progress:    $SUMMARY"
echo
echo "Counts by status:"
grep -o '"status":"[a-z_]*"' "$JOURNAL" 2>/dev/null | sort | uniq -c || true
echo
echo "Quarantined payloads (if any): ./temp/quarantine"

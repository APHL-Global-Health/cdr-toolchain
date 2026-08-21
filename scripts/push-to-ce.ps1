# Push DISA*Lab data into an OpenLDR CE install via the CDR toolchain (Windows).
#
#   .\scripts\push-to-ce.ps1 verify   # config + connectivity only, no DISA reads
#   .\scripts\push-to-ce.ps1 smoke    # 10 labs, full pipeline, NOTHING is POSTed
#   .\scripts\push-to-ce.ps1 run      # the real push
#   .\scripts\push-to-ce.ps1 resume   # continue an interrupted run
#
# Run from the repo root. See scripts/.env.ce.example for the settings.
param([Parameter(Mandatory = $true)][ValidateSet('verify','smoke','run','resume')][string]$Mode)

$ErrorActionPreference = 'Stop'

$Limit       = if ($env:LIMIT)       { $env:LIMIT }       else { '5000000' }
$Concurrency = if ($env:CONCURRENCY) { $env:CONCURRENCY } else { '4' }
$Where       = $env:WHERE
$Order       = if ($env:ORDER)       { $env:ORDER }       else { 'asc' }
$OutDir      = if ($env:OUTDIR)      { $env:OUTDIR }      else { './temp/ce-push' }

if (-not (Test-Path 'package.json') -or -not (Test-Path 'apps/cli')) {
  throw 'Run this from the cdr-toolchain repo root.'
}

# Load the env file without overriding anything already set. Mirrors the CLI's
# own resolution (config.ts resolveImplicitEnvPath): cwd/.env wins, else
# apps/cli/.env - which is where the file actually lives in a stock checkout.
$envFile = if ($env:ENV_FILE) { $env:ENV_FILE }
           elseif (Test-Path '.env') { '.env' }
           elseif (Test-Path 'apps/cli/.env') { 'apps/cli/.env' }
           else { $null }
if ($envFile) {
  Write-Host "Config: $envFile"
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
    $k, $v = $line -split '=', 2
    $k = $k.Trim(); $v = $v.Trim().Trim('"')
    if ($k -and -not [Environment]::GetEnvironmentVariable($k)) { Set-Item -Path "env:$k" -Value $v }
  }
} else {
  Write-Host 'Config: no .env found (relying on the existing environment)'
}

$fail = $false
function Need($name, $hint) {
  if (-not [Environment]::GetEnvironmentVariable($name)) {
    Write-Host "  MISSING  $name - $hint"; $script:fail = $true
  } else { Write-Host "  ok       $name" }
}

Write-Host 'Preflight:'
Need 'DISA_CONNECTION_STRING'       "Zambia's DISA*Lab MSSQL instance"
Need 'OPENLDR_V1_CONNECTION_STRING' 'OpenLDR v1 mirror - the fidelity gate is NOT optional on the CE path'
Need 'OPENLDR_CE_URL'               'base URL of the target CE, no trailing slash'
Need 'OPENLDR_CE_WEBHOOK_TOKEN'     'Studio -> Workflows -> Ingest -> webhook node -> secret'
Need 'OPENLDR_CE_TIMEZONE'          'Zambia is +02:00 - there is no default and no fallback'
Need 'OPENLDR_COUNTRY'              "must be 'zambia' to load config/zambia.yaml"

if ($env:OPENLDR_CE_TIMEZONE -and $env:OPENLDR_CE_TIMEZONE -notmatch '^(Z|[+-]\d{2}:\d{2})$') {
  Write-Host "  BAD      OPENLDR_CE_TIMEZONE='$($env:OPENLDR_CE_TIMEZONE)' - want +02:00 for Zambia"; $fail = $true
}
# Zambia's v1 RequestID equals the DISA LabNo (e.g. ZUL0010002). A stray prefix
# matches zero v1 rows and fails every lab as if the data were missing.
if ($env:OPENLDR_LABNO_PREFIX) {
  Write-Host "  WARN     OPENLDR_LABNO_PREFIX='$($env:OPENLDR_LABNO_PREFIX)' is set - Zambia expects it EMPTY"
}
if ($fail) { throw 'Fix the settings above (see scripts/.env.ce.example) and re-run.' }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$journal = Join-Path $OutDir 'journal.ndjson'
$summary = Join-Path $OutDir 'summary.log'

# Invoke the CLI through tsx directly. `pnpm dev -- <cmd>` passes a literal `--`
# that breaks commander's option parsing - flags are SILENTLY ignored and the
# defaults used instead, which does not show up anywhere in the output.
$cdr = 'apps/cli/node_modules/.bin/tsx apps/cli/src/index.ts'

$args = "export-batch --limit $Limit --concurrency $Concurrency --order $Order " +
        "--country $($env:OPENLDR_COUNTRY) --ce-url $($env:OPENLDR_CE_URL) --ce-tz $($env:OPENLDR_CE_TIMEZONE)"
if ($Where) { $args += " --where `"$Where`"" }

# ⚠ PowerShell's `>` writes UTF-16 with a BOM, which corrupts NDJSON for every
# downstream consumer (--resume-from, jq, openldr ingest stream). Redirect
# through cmd.exe so the journal stays UTF-8.
switch ($Mode) {
  'verify' { cmd /c "$cdr $args --explain" }
  'smoke'  {
    Write-Host 'Smoke: 10 labs, --dry-run (nothing is POSTed)'
    $s = "export-batch --limit 10 --concurrency 1 --order $Order --country $($env:OPENLDR_COUNTRY) " +
         "--ce-url $($env:OPENLDR_CE_URL) --ce-tz $($env:OPENLDR_CE_TIMEZONE) --dry-run"
    if ($Where) { $s += " --where `"$Where`"" }
    cmd /c "$cdr $s"
  }
  'run' {
    Write-Host "Pushing to $($env:OPENLDR_CE_URL)  (journal: $journal)"
    cmd /c "$cdr $args > `"$journal`" 2> `"$summary`""
  }
  'resume' {
    if (-not (Test-Path $journal)) { throw "No journal at $journal - use 'run' first." }
    # --resume-from reads a PRIOR journal and writes a new one, so input and
    # output must be different files or the run truncates its own resume set.
    Copy-Item $journal "$journal.prev" -Force
    Write-Host "Resuming, skipping labs already in $journal.prev"
    cmd /c "$cdr $args --resume-from `"$journal.prev`" > `"$journal`" 2> `"$summary`""
  }
}

Write-Host ''
Write-Host "Done. Per-lab journal: $journal"
Write-Host "Summary + progress:    $summary"
if (Test-Path $journal) {
  Write-Host ''
  Write-Host 'Counts by status:'
  Select-String -Path $journal -Pattern '"status":"([a-z_]+)"' -AllMatches |
    ForEach-Object { $_.Matches } | ForEach-Object { $_.Groups[1].Value } |
    Group-Object | Select-Object Count, Name | Format-Table -AutoSize
}
Write-Host 'Quarantined payloads (if any): ./temp/quarantine'

# Diagnosing export-batch throughput

When `export-batch` (or `push-to-ce.sh`) is slower per lab than you expect,
these five measurements tell you where the time goes before anyone changes
code or configuration. They separate the three explanations that otherwise
look identical from the outside:

1. **Network latency** between the exporter host and the SQL Servers.
2. **SQL Server resource starvation** — CPU, memory, or disk.
3. **Index quality** on the DISA tables, which degrades as they grow.

A developer laptop cannot distinguish these. Latency is near zero locally,
the box is idle, and the tables are small enough to sit entirely in RAM.
Every one of the three only shows up on the real deployment.

## Everything here is read-only

No writes, no schema changes, no index builds, no `DBCC`, no stats update,
no cache clear, no configuration changes. The SQL reads only `sys.*` dynamic
management views — counters and plan statistics, never patient or lab data.
The latency probe issues one statement: `SELECT 1`.

Safe to run on production, during a live push.

**Run these while a push is actually in flight.** Steps 2, 3 and 5 measure an
idle instance otherwise and will tell you nothing.

---

## Step 1 — Round-trip latency to each server

Run on the **host that runs the exporter**, not on a DBA workstation. What
matters is the latency the exporter itself pays.

```bash
node scripts/diagnose-rtt.mjs "$DISA_CONNECTION_STRING"        DISA
node scripts/diagnose-rtt.mjs "$OPENLDR_V1_CONNECTION_STRING"  V1
```

`cdr ping` is not a substitute — it opens and closes a connection, so it
measures connection setup rather than the per-query round trip that gets
multiplied by roughly 110 per lab.

| p50 RTT | Reading |
|---|---|
| < 1 ms | Same LAN segment. Latency is not the bottleneck — 110 trips cost ~0.1 s. Look at steps 3 and 5. |
| 1-5 ms | Routed LAN. Contributes 0.1-0.6 s per lab. Real but not dominant. |
| 20-50 ms | Latency dominates. ~110 sequential trips means 2-5 s per lab before any query executes. Raising concurrency is the first thing to try. |
| > 50 ms | Check whether this is really a LAN, or actually a VPN / WAN link. |

The script needs `pnpm install` to have been run at the repo root — it
resolves `mssql` out of `apps/cli`, because pnpm does not hoist dependencies
to the workspace root.

## Step 2 — SQL batches per lab, per server

Establishes how many round trips one lab actually costs. Run on **each**
server separately; the counter is instance-wide, so a shared instance mixes
databases into one number and a split deployment gives you the breakdown for
free.

```sql
SELECT GETDATE() AS sampled_at, cntr_value
FROM sys.dm_os_performance_counters
WHERE counter_name = 'Batch Requests/sec';
```

Run it, wait 30-60 seconds, run it again. At those same two moments, record
the journal line count on the exporter host:

```bash
wc -l ./temp/ce-push/journal.ndjson
```

```powershell
(Get-Content ./temp/ce-push/journal.ndjson | Measure-Object -Line).Lines
```

Then, per server:

```
batches_per_lab = (cntr_2 - cntr_1) / (lines_2 - lines_1)
```

Keep the four raw readings, not just the quotient:

```
server=DISA  t1=2026-01-15T09:00:00 cntr=184203991 lines=10422
server=DISA  t2=2026-01-15T09:00:45 cntr=184215668 lines=10437
server=V1    t1=2026-01-15T09:00:00 cntr=90114233  lines=10422
server=V1    t2=2026-01-15T09:00:45 cntr=90114263  lines=10437
```

**Expected shape.** With `--check` on, the v1 server should show almost
exactly **2 batches per lab** — `fetchRequestByRequestId` then
`fetchLabResultsByRequestId` in
[`export-batch.ts`](../apps/cli/src/commands/export-batch.ts), and nothing
else. Everything else lands on DISA, dominated by the per-parameter
`PARMDICT` / `TXT1DATA` / `COMMDICT` lookups in
[`orderitem.ts`](../packages/disalab/src/lib/orderitem.ts). A v1 count much
above 2 means something is querying it that the code path does not explain.

If other workloads share these instances, take one sample with the push
stopped and subtract that idle baseline.

## Step 3 — Table sizes, index shapes, query cost

```bash
sqlcmd -S <disa-host> -d DisalabData -i scripts/diagnose-sql-health.sql -o disa-health.txt
sqlcmd -S <v1-host>   -d OpenLDRData  -i scripts/diagnose-sql-health.sql -o v1-health.txt
```

Or paste it into SSMS with results-to-text. Sections 1 and 2 are meaningful
only on DISA; sections 0 and 4-6 matter on both.

Two things that change the conclusion:

- **Rank section 3 by `total_elapsed_sec`, not `avg_elapsed_ms`.** A 2 ms
  query run 40,000 times costs far more than a 50 ms query run once per lab.
  Ranking by average makes the two scanning queries look like the problem
  when a much larger number of small dictionary lookups may dominate.
- **Trust `avg_logical_reads` over `avg_elapsed_ms`.** Reads are independent
  of both latency and server load — a seek is single-digit, a scan of a large
  table is tens of thousands. That distinction survives a busy server;
  elapsed time does not.

## Step 4 — What is actually being run

Confirm rather than assume, because several of these change how every number
above is read:

1. The exact command — `push-to-ce.sh run`, or `cdr export-batch` directly?
   Include any `CONCURRENCY=` / `LIMIT=` / `WHERE=` prefix.
2. Where `CONCURRENCY` comes from — shell, `.env`, or unset. The CLI defaults
   to 1; `push-to-ce.sh` and `push-to-ce.ps1` default to **4**, and an
   explicit `.env` value silently wins over both.
3. Whether "seconds per lab" means total elapsed / labs done, or the per-lab
   `duration_ms` in the journal. At concurrency N those differ by N times.
4. Whether the dataset size quoted is records or labs — DISA averages roughly
   6-7 observations per lab, so the projection shifts by about that factor.
5. Current progress and status mix:

   ```bash
   grep -o '"status":"[a-z_]*"' ./temp/ce-push/journal.ndjson | sort | uniq -c
   ```

### Concurrency ceiling

Before raising `--concurrency`, know where it stops helping. The toolchain
opens one connection pool per connection string
([`pool.ts`](../packages/disalab/src/lib/pool.ts)) with no pool options, so
mssql's default `max: 10` applies. A lab is internally sequential and holds
one connection at a time, so concurrency scales roughly linearly to about 10
per server and then queues on connection acquisition.

Going beyond 10 needs no code change — append `Max Pool Size=N` to the
connection string:

```
DISA_CONNECTION_STRING="Server=...;Database=...;User=...;Password=...;Encrypt=false;Max Pool Size=32"
```

Raise the v1 string too when `--check` is on, or v1 becomes the new ceiling.
Changing this mid-diagnostic invalidates comparisons between runs.

## Step 5 — Is SQL Server starved?

Covered by sections 4, 5 and 6 of `diagnose-sql-health.sql` — no extra run
needed. Read section 6 first: the dominant wait type usually names the
bottleneck outright.

| Top wait | Points at |
|---|---|
| `ASYNC_NETWORK_IO` | Network, or the client not draining results fast enough. Supports the latency explanation. |
| `PAGEIOLATCH_*` | Reading from disk rather than memory. Supports the scan / working-set explanation, and it worsens as tables grow. |
| `SOS_SCHEDULER_YIELD` | CPU pressure. Cross-check section 4. |
| `LCK_M_*` | Blocking — unexpected on a read-only export. |

Check `uptime_hours` in section 0 first. Sections 3 and 6 are cumulative
since instance start, so a recently restarted server has not accumulated a
representative sample.

---

## Fixes, in cost order

Do not apply these before the measurements come back — which one helps
depends entirely on what steps 1-5 say.

1. **Raise `--concurrency`.** Config only, no code risk. Helps most when
   step 1 shows high RTT. Bounded by the pool ceiling above.
2. **Move the exporter next to DISA.** Reads are ~110 round trips per lab;
   the POST is one HTTP request. Put the chatty side local and the cheap side
   remote. With `--check` on, only 2 round trips per lab stay remote.
3. **Feed the existing codebook into the decoder** so `PARMDICT` and
   `COMMDICT` stop being queried per parameter. `loadCodebook` already pulls
   all of `PARMDICT` once per run
   ([`codebook.ts`](../apps/cli/src/export/codebook.ts)) and the decoder does
   not use it. Note the key mismatch flagged in section 2 of the SQL script
   before attempting this — the codebook keys on the blob-decoded `CODE`
   while the decoder filters on a SQL `[CODE]` column, and swapping them
   silently changes decoded output if the two ever disagree. Gate any such
   change behind `--check`.
4. **Batch `TXT1DATA` per test** instead of per frame.
5. **Add non-clustered indexes** for `RDOBIDX4(LABNO)` and
   `RTKNIDX5(INVOICENO)` — **on a mirror or replica only.** DISA is
   vendor-controlled; never alter its schema in place.

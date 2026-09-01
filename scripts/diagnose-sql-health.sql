/* ============================================================================
   export-batch throughput diagnostic — read-only.

   Run on the DISA instance. Sections 0 and 3-6 are also worth running on the
   OpenLDR v1 instance (skip 1 and 2 there; those tables are DISA's).

   Nothing here writes, creates, or alters anything. No DBCC, no index work,
   no stats update, no cache clear. Safe on production during a live push.

   See scripts/DIAGNOSTICS.md for how to run this and how to read the output.
   ========================================================================= */

SET NOCOUNT ON;

/* -- 0. Identify the instance so results can't be mixed up ---------------- */
SELECT
    section          = '0-identity',
    server_name      = CONVERT(sysname, SERVERPROPERTY('MachineName')),
    instance_name    = CONVERT(sysname, SERVERPROPERTY('InstanceName')),
    product_version  = CONVERT(sysname, SERVERPROPERTY('ProductVersion')),
    edition          = CONVERT(sysname, SERVERPROPERTY('Edition')),
    cpu_count        = (SELECT cpu_count FROM sys.dm_os_sys_info),
    max_server_mb    = (SELECT CONVERT(bigint, value_in_use) FROM sys.configurations WHERE name = 'max server memory (MB)'),
    uptime_hours     = DATEDIFF(hour, (SELECT sqlserver_start_time FROM sys.dm_os_sys_info), GETDATE());
/* uptime_hours matters: dm_os_wait_stats and dm_exec_query_stats are
   cumulative since start / since the plan entered cache. A recently
   restarted instance makes both sections below unrepresentative. */


/* -- 1. Row counts for the tables on the per-lab path --------------------- */
/* dm_db_partition_stats, not COUNT(*) — instant, and no scan on a large
   table during a live push. Counts are near-exact, not transactionally
   exact. */
SELECT
    section    = '1-row-counts',
    table_name = OBJECT_NAME(p.object_id),
    row_count  = SUM(CASE WHEN p.index_id IN (0,1) THEN p.row_count ELSE 0 END),
    total_mb   = CONVERT(decimal(18,1), SUM(p.reserved_page_count) * 8.0 / 1024)
FROM sys.dm_db_partition_stats AS p
WHERE OBJECT_NAME(p.object_id) IN ('RDOBIDX4','RTKNIDX5','TESTDATA','REGDAT4',
                                   'PARMDICT','COMMDICT','TXT1DATA')
GROUP BY OBJECT_NAME(p.object_id)
ORDER BY row_count DESC;


/* -- 2. Clustered key of the two suspected scanning tables ---------------- */
/* On the deployment this was first profiled against, RDOBIDX4 was clustered
   on (DOBDATE, LABNO) and RTKNIDX5 on (TAKENDATE, INVOICENO) — so a lookup
   by LabNo / INVOICENO could not seek and scanned instead. Confirm the same
   holds here before proposing any index: DISA builds differ between
   deployments, and the fix (a non-clustered index) must go on a mirror or
   replica, never on the vendor-controlled database itself. */
SELECT
    section       = '2-index-shape',
    table_name    = OBJECT_NAME(i.object_id),
    index_name    = i.name,
    index_type    = i.type_desc,
    key_columns   = STUFF((
                      SELECT ', ' + c2.name
                      FROM sys.index_columns AS ic2
                      JOIN sys.columns AS c2
                        ON c2.object_id = ic2.object_id AND c2.column_id = ic2.column_id
                      WHERE ic2.object_id = i.object_id
                        AND ic2.index_id  = i.index_id
                        AND ic2.is_included_column = 0
                      ORDER BY ic2.key_ordinal
                      FOR XML PATH('')), 1, 2, '')
FROM sys.indexes AS i
WHERE OBJECT_NAME(i.object_id) IN ('RDOBIDX4','RTKNIDX5','TESTDATA','REGDAT4','TXT1DATA','PARMDICT')
  AND i.type > 0
ORDER BY table_name, i.index_id;

/* Does PARMDICT have a physical CODE column? The blob decoder filters on
   [CODE] (packages/disalab/src/lib/orderitem.ts) while the codebook decodes
   CODE from the blob and its comment claims no such column exists
   (apps/cli/src/export/codebook.ts). Both cannot be right, and the answer
   decides whether the decoder's per-parameter lookup can safely be replaced
   by the already-loaded codebook. */
SELECT
    section     = '2-parmdict-columns',
    column_name = c.name,
    data_type   = t.name,
    max_length  = c.max_length
FROM sys.columns AS c
JOIN sys.types  AS t ON t.user_type_id = c.user_type_id
WHERE c.object_id = OBJECT_ID('DisaGlobal.dbo.PARMDICT')
ORDER BY c.column_id;


/* -- 3. The actual cost of the per-lab queries ---------------------------- */
/* avg_elapsed_time and, crucially, avg_logical_reads. Reads are the honest
   signal: elapsed time on a busy box conflates real work with waiting for a
   scheduler, but logical reads per execution are latency-independent. A seek
   on a large table is single-digit reads; a scan is tens of thousands. */
SELECT TOP 25
    section            = '3-query-cost',
    executions         = qs.execution_count,
    avg_elapsed_ms     = CONVERT(decimal(18,2), qs.total_elapsed_time / 1000.0 / NULLIF(qs.execution_count,0)),
    avg_worker_ms      = CONVERT(decimal(18,2), qs.total_worker_time  / 1000.0 / NULLIF(qs.execution_count,0)),
    avg_logical_reads  = qs.total_logical_reads  / NULLIF(qs.execution_count,0),
    avg_physical_reads = qs.total_physical_reads / NULLIF(qs.execution_count,0),
    total_elapsed_sec  = CONVERT(decimal(18,1), qs.total_elapsed_time / 1000000.0),
    query_text         = SUBSTRING(st.text, 1, 300)
FROM sys.dm_exec_query_stats AS qs
CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) AS st
WHERE st.text LIKE '%RDOBIDX4%'
   OR st.text LIKE '%RTKNIDX5%'
   OR st.text LIKE '%PARMDICT%'
   OR st.text LIKE '%TXT1DATA%'
   OR st.text LIKE '%COMMDICT%'
   OR st.text LIKE '%TESTDATA%'
   OR st.text LIKE '%REGDAT4%'
ORDER BY qs.total_elapsed_time DESC;
/* Rank by total_elapsed_sec, not by avg. A 2 ms query run 40,000 times per
   thousand labs outranks a 50 ms query run once per lab. That ordering is
   the whole point of this section. */


/* -- 4. Is the instance CPU-starved? ------------------------------------- */
SELECT TOP 1
    section              = '4-cpu',
    sql_cpu_pct          = r.record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]','int'),
    other_process_cpu_pct= 100
                           - r.record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]','int')
                           - r.record.value('(./Record/SchedulerMonitorEvent/SystemHealth/ProcessUtilization)[1]','int'),
    idle_pct             = r.record.value('(./Record/SchedulerMonitorEvent/SystemHealth/SystemIdle)[1]','int')
FROM (
    SELECT CONVERT(xml, record) AS record, timestamp
    FROM sys.dm_os_ring_buffers
    WHERE ring_buffer_type = 'RING_BUFFER_SCHEDULER_MONITOR'
      AND record LIKE '%<SystemHealth>%'
) AS r
ORDER BY r.timestamp DESC;

/* Runnable tasks queued right now: sustained > 0 means threads are waiting
   for a CPU scheduler, i.e. genuine CPU starvation rather than slow
   queries. */
SELECT
    section            = '4-cpu-pressure',
    schedulers         = COUNT(*),
    total_runnable     = SUM(runnable_tasks_count),
    total_pending_io   = SUM(pending_disk_io_count)
FROM sys.dm_os_schedulers
WHERE status = 'VISIBLE ONLINE';


/* -- 5. Memory: page life expectancy + buffer size ----------------------- */
SELECT
    section  = '5-memory',
    object   = RTRIM(object_name),
    counter  = RTRIM(counter_name),
    instance = RTRIM(instance_name),
    value    = cntr_value
FROM sys.dm_os_performance_counters
WHERE (object_name LIKE '%Buffer Manager%' AND counter_name IN ('Page life expectancy','Database pages'))
   OR (object_name LIKE '%Buffer Node%'    AND counter_name IN ('Page life expectancy','Database pages'))
   OR (object_name LIKE '%Memory Manager%' AND counter_name IN ('Total Server Memory (KB)','Target Server Memory (KB)'));
/* PLE is also published per NUMA node; the instance-wide figure hides a
   starved node, so both objects are pulled here.
   Low PLE alongside high avg_physical_reads in section 3 means the working
   set does not fit in RAM. That is what turns a scan on a growing table from
   "slow" into "catastrophically slow" — and it is size-dependent, which is
   why a developer laptop cannot reproduce it. */


/* -- 6. Top waits since instance start ----------------------------------- */
/* Filters the standard benign/idle waits. Read the top 5. */
SELECT TOP 15
    section        = '6-waits',
    wait_type      = w.wait_type,
    wait_sec       = CONVERT(decimal(18,1), w.wait_time_ms / 1000.0),
    pct_of_total   = CONVERT(decimal(5,2), 100.0 * w.wait_time_ms
                       / NULLIF(SUM(w.wait_time_ms) OVER (), 0)),
    waiting_tasks  = w.waiting_tasks_count,
    avg_wait_ms    = CONVERT(decimal(18,2), w.wait_time_ms * 1.0 / NULLIF(w.waiting_tasks_count, 0)),
    signal_wait_ms = w.signal_wait_time_ms
FROM sys.dm_os_wait_stats AS w
WHERE w.waiting_tasks_count > 0
  AND w.wait_type NOT IN (
      'CLR_SEMAPHORE','LAZYWRITER_SLEEP','RESOURCE_QUEUE','SLEEP_TASK',
      'SLEEP_SYSTEMTASK','SQLTRACE_BUFFER_FLUSH','WAITFOR','LOGMGR_QUEUE',
      'CHECKPOINT_QUEUE','REQUEST_FOR_DEADLOCK_SEARCH','XE_TIMER_EVENT',
      'BROKER_TO_FLUSH','BROKER_TASK_STOP','CLR_MANUAL_EVENT','CLR_AUTO_EVENT',
      'DISPATCHER_QUEUE_SEMAPHORE','FT_IFTS_SCHEDULER_IDLE_WAIT','XE_DISPATCHER_WAIT',
      'XE_DISPATCHER_JOIN','SQLTRACE_INCREMENTAL_FLUSH_SLEEP','ONDEMAND_TASK_QUEUE',
      'BROKER_EVENTHANDLER','SLEEP_BPOOL_FLUSH','SP_SERVER_DIAGNOSTICS_SLEEP',
      'HADR_FILESTREAM_IOMGR_IOCOMPLETION','DIRTY_PAGE_POLL','QDS_ASYNC_QUEUE',
      'QDS_PERSIST_TASK_MAIN_LOOP_SLEEP','QDS_SHUTDOWN_QUEUE','PWAIT_ALL_COMPONENTS_INITIALIZED')
ORDER BY w.wait_time_ms DESC;
/* How to read the top waits:
     ASYNC_NETWORK_IO high -> the client is not draining results fast enough,
                              or the link between exporter and SQL is the
                              limit. Points at the network hypothesis.
     PAGEIOLATCH_*    high -> reading from disk, not RAM. Points at the
                              scan + working-set hypothesis.
     SOS_SCHEDULER_YIELD   -> CPU pressure. Cross-check section 4.
     LCK_M_*          high -> blocking, unexpected on a read-only export.
     Signal wait as a large share of total also indicates CPU pressure. */

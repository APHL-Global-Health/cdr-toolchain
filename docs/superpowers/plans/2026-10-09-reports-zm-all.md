# reports-zm: the rest of Zambia's reports, implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Port the other 56 Zambia v1 reports (plus one second result set) into the `reports-zm` pack
as CE custom queries, with shared copy-table builders, and release it as 0.1.1.

**Architecture:** Shared SQL builders in `packs/reports-zm/zm-sql.mjs` rebuild Zambia's copy tables as
CTEs. Each report is a query in `packs/reports-zm/queries/<area>.mjs` with a check group in
`packs/reports-zm/checks/<area>.mjs`. The shared runner runs each check group in its own transaction.

**Tech Stack:** Node ESM, Postgres 16 (CE dev container), the shared runner `packs/shared/pg-check.mjs`.

**Spec:** `docs/superpowers/specs/2026-10-09-reports-zm-all-design.md` (rulings 1-15 bind every task).
**Inventory:** `packs/reports-zm/INVENTORY.md`; raw rows per object with line references:
`.superpowers/sdd/2026-10-09-reports-zm-all/zm-inv-all.json`; v1 object texts (UTF-8, one file per
object, `<Type>__dbo_<Name>.sql`): `.superpowers/sdd/2026-10-09-reports-zm-all/v1/`.

## Global Constraints

- Worktree `D:/Projects/Repositories/cdr-toolchain/.claude/worktrees/reports-zm-all`, branch
  `feat/reports-zm-all`. `cd` into it in every command. Check `git branch --show-current` before each
  commit. Stage by exact path. No `Co-Authored-By` trailer. Never commit `dist/` or `.superpowers/`.
- **Output parity** (spec ruling 1): v1's columns, names, order; same rows and values for the same data
  and window. Odd-but-running v1 behaviour is kept and listed; non-running or constant v1 output gets
  its evident intent (ruling 2). Every kept quirk and every deviation is a JS comment in the query and a
  line in the task report (the docs task collects them).
- **Pack SQL**: one read-only SELECT per query; no `--` comments; no CE-banned word (`insert update
  delete drop alter create truncate grant revoke merge call copy into`) as an identifier, alias or CTE
  name; `optionsSql` obeys the same rules and returns one column. ORDER BY must be total when v1 orders
  (CE pages with LIMIT/OFFSET); if v1 has no ORDER BY, order by every output column.
- **v1 semantics**: SQL Server default collation (text compare ignores case and trailing spaces;
  `LIKE`, `REPLACE`, `CHARINDEX` ignore case); `ISNUMERIC` via `isNumericSql`; `NOT IN` drops NULLs;
  `datediff(dd,a,b)` counts date boundaries, not 24-hour periods; `BETWEEN` on datetimes is inclusive.
- **Parameters** (rulings 3, 4): `from`/`to` text `YYYY-MM-DD` (required where v1 had a window), compared
  as text with `to || 'T23:59:59.999Z'`; province and district `select` with `optionsSql` from ZMFAC;
  facility text matched on register name (`facility_map.name`, case-insensitive); laboratory text
  matched on `diagnostic_reports.performer`; blank optional = all. Use the helpers in `zm-sql.mjs`.
- **CE mapping** (from `cdr-v1-ce-field-mapping` and slice 1): Requests -> `lab_requests` (+
  `diagnostic_reports` on `based_on_id`, `specimens`, `lab_request_attributes`); LabResults ->
  `lab_results`; Patients -> `patients` (+ attributes `reference-numbers`, `unique-id`);
  RegisteredDateTime -> `lab_requests.authored_at`; SpecimenDateTime -> `diagnostic_reports.effective`;
  ReceivedDateTime -> `specimens.received_time`; AnalysisDateTime -> `lab_requests.analysis_at`;
  AuthorisedDateTime -> `diagnostic_reports.issued`; HL7ResultStatusCode F -> `diagnostic_reports.status
  = 'final'`, X -> `'cancelled'` (Y, Z, others -> `'unknown'`); LIMSRptResult -> `rpt()`; SIValue ->
  `lab_results.numeric_value`; LIMSCodedValue -> `coded_value`; LIMSRejectionCode/Desc ->
  `lab_requests.rejection_code/reason`; TestingFacilityCode -> `diagnostic_reports.performer`;
  RequestingFacilityCode -> `lab_requests.requester_code`; province/district/facility name -> the mapped
  register row (`facility_map` region/district/name, as `zm-queries.mjs`); AgeInYears/AgeInDays ->
  `lab_requests.age_years/age_days`; HL7SexCode -> `patients.sex`; LIMSAnalyzerCode ->
  `lab_requests.analyzer_code`; VIRAL panel answers -> `questionnaire_responses` (ruling 6). A v1 fact CE
  lacks stays an empty column under its v1 name (ruling 7). Lab names: ruling 8.
- **Check groups**: each task adds one group (`{ name, suites }`) to its area's `checks/<area>.mjs`;
  fixture ids are prefixed with the task number (`t7-...`) so groups never collide. Run
  `node packs/reports-zm/check-reports-zm.mjs` (all groups) and expect `N checks, 0 failed`.
- No em dashes in new text. Short plain comments.

## The porting recipe (every port task follows it)

- [ ] **R1** Read the target and merge files in `v1/`, their rows in `zm-inv-all.json`, and the builders
  the task names. Note the output columns (names and order), each filter, each join, each constant.
- [ ] **R2** Write the check group first, in `checks/<area>.mjs`: warehouse rows (prefixed ids) that
  exercise every branch, every merge parameter and the window edges; for each case, the exact rows v1
  would return, worked out by hand from the v1 text, with `// v1: <file> line N` comments. Use
  `querySuite`-style exact row-set checks with a row count (copy the pattern from
  `check-reports-zm.mjs`: column order, exact rows, no extra rows).
- [ ] **R3** Run `node packs/reports-zm/check-reports-zm.mjs`; see the new group fail (missing export).
- [ ] **R4** Write the query in `queries/<area>.mjs` (exported in the area's `queries()` list with its
  `params`), using `zm-sql.mjs` helpers and builders. Keep v1 quirks (ruling 1) with a comment.
- [ ] **R5** Run the checks until all pass. If an expectation looks wrong, re-read v1 before changing it,
  and say what you found in the report. Never edit an expectation to match the query.
- [ ] **R6** Scan: `node packs/reports-zm/scan-sql.mjs` (created in Task 1) prints `ok` for every query.
- [ ] **R7** Commit the task's files with the task's commit message.

---

### Task 1: Groundwork

**Files:** `packs/shared/pg-check.mjs`; create `packs/reports-zm/zm-sql.mjs`,
`packs/reports-zm/queries/` (six area files, each exporting `queries()` returning `[]`),
`packs/reports-zm/checks/` (six area files, each exporting `groups = []`), `packs/reports-zm/scan-sql.mjs`;
modify `packs/reports-zm/check-reports-zm.mjs`, `packs/reports-zm/build.mjs`.

**Interfaces produced:**
- `pg-check.mjs`: `runSuiteGroups(groups)` where `groups` is `{ name, suites }[]`: each group runs in its
  own `begin ... rollback` (its own psql call), then one combined report `N checks, M failed` and exit
  code. `runSuites` stays as is.
- `zm-sql.mjs` exports (move from `zm-queries.mjs` where they exist, re-export there so slice 1 keeps
  working unchanged): `sqlLit`, `sqlList(values)`, `inRange(expr, fromParam = 'from', toParam = 'to')`,
  `ZM_REGISTER_URL`, `ATTR_SYSTEM`, `provinceParam(id='province', required=false)`,
  `districtParam(id='district', required=false)` (select; options = distinct ZMFAC districts),
  `facilityParam()`, `labParam()`, `dateParams(required=true)` (the `from`/`to` pair),
  `requesterJoin(lrAlias, fmAlias)` (the slice 1 facility_map join on the requesting facility, mapped
  rows only), `areaFilter({ province, district, facility })` (SQL for the optional
  province/district/facility parameters against the mapped row), `zmIdsCte(name)` (slice 1's
  `zm_ids`), `artNumberSql` (from slice 1), `genderSql(sexExpr)` (v1 `getGenderFromSexCode`: F Female,
  M Male, N Not Applicable, O Other, U Unknown, I Indeterminate, else Not Specified),
  `ageGroupSql(yearsExpr)` (v1 `dbo.Agegroup` exactly, including its 50-54 label; read
  `v1/UserDefinedFunction__dbo_Agegroup.sql`), `formAnswerSql(requestIdExpr, observationCode)` (the text
  answer of a VIRAL form question for a request, from `questionnaire_responses` form
  `hiv_vl_documentation`, `based_on_id` = request id, `items` JSON, `linkId` = code, first answer's
  `valueString`, else `valueDecimal::text`), `labNameSql(drAlias)` (ruling 8: performer_display, else
  the performer's mapped register name, else the code).
- `scan-sql.mjs`: imports every area's `queries()` plus slice 1's query, checks each `sql` and each
  param's `optionsSql` (banned words outside literals, `--`), prints `ok <name>` or `BAD <name>: <why>`,
  exits 1 on any BAD.
- `check-reports-zm.mjs`: wraps slice 1's suites as group `slice1`, then every area's `groups`, and calls
  `runSuiteGroups`.
- `build.mjs`: the custom-queries step lists slice 1's query, then each area's `queries()` in the order
  vl, eid, tb, tests, covid, lab-ops.

**Steps:**
- [ ] Write check cases for the new helpers that produce SQL values (`genderSql`, `ageGroupSql` with every
  band edge 0..50+ including 50-54, `formAnswerSql` with a form row, `inRange` edges) as group `t1`, using
  `caseSuite` (the helper expressions over a VALUES table) and one fixture suite for `formAnswerSql`.
- [ ] See them fail; implement; see `35 + N checks, 0 failed` (slice 1's 35 still pass).
- [ ] `node packs/reports-zm/scan-sql.mjs` prints `ok VL clients by province`.
- [ ] `node packs/reports-zm/build.mjs`: same counts as 0.1.0 (3788 rows, 42 coordinate pairs left out).
- [ ] `node packs/vl-reports-mz/check-vl-functions.mjs`: `76 checks, 0 failed`.
- [ ] Commit: `feat(packs): reports-zm groundwork for the remaining Zambia reports`.

### Task 2: The `hivvl` builder

**Files:** `zm-sql.mjs`, `checks/vl.mjs`.
**Source:** `v1/StoredProcedure__dbo_sp_update_HIVVLTable.sql`, `v1/Table__dbo_HIVVL.sql`.
**Interface:** `hivvlCte(name, { from, to } = {})` returns `"<name> as (...)"`: one row per v1 hivvl row,
columns = the HIVVL table's columns in snake_case, same order (`province, district, facility, lab_id,
gender, age_group, tested_date, suppressed, uu, tat, tat_within14, pregnant, breastfeeding, baseline_vl,
run_date, received_date, registered_date, collected_date, tested_at, referral, disalink,
three_m_post_unsuppressed, poc, poc_w48h`). With `from`/`to` (param names), rows are limited to
`tested_date` in range. Rebuilds the MERGE's source rows (`vl_s`, `ranking = 1`), including the
`viral` flags from the VIRAL form (ruling 6) and RTRI lab results; Referral and Disalink per ruling 7.
Keep `sp_remove_dupsHIVVLEID`'s effect: one row per lab ID, earliest `tested_date` (inventory note).
**Steps:** recipe R2-R7 (group `t2`; suite over `select * from <name>` per fixture). Commit
`feat(packs): rebuild Zambia's hivvl table as SQL`.

### Task 3: The `eid` builder

**Files:** `zm-sql.mjs`, `checks/eid.mjs`. **Source:** `v1/StoredProcedure__dbo_sp_update_EIDTable.sql`,
`v1/Table__dbo_EID.sql`. **Interface:** `eidCte(name, { from, to } = {})`, columns = EID table columns in
snake_case, same order; one row per lab ID (earliest tested date). Commit
`feat(packs): rebuild Zambia's eid table as SQL`.

### Task 4: The `tbgnx` builder

**Files:** `zm-sql.mjs`, `checks/tb.mjs`. **Source:** `v1/StoredProcedure__dbo_sp_getTBsLastHour.sql`,
`v1/View__dbo_v_GeneXpert.sql`, `v1/Table__dbo_TBGNX.sql`. **Interface:** `geneXpertCte(name)` (the
`v_GeneXpert` rows) and `tbgnxCte(name, { from, to } = {})` (TBGNX table columns in snake_case, same
order). Commit `feat(packs): rebuild Zambia's tbgnx table as SQL`.

### Task 5: The `recency` and `vleidrequests` builders

**Files:** `zm-sql.mjs`, `checks/tests.mjs`, `checks/lab-ops.mjs`. **Sources:**
`v1/StoredProcedure__dbo_sp_getTestLevelRecency_CIDRZ.sql`, `v1/StoredProcedure__dbo_sp_recency_surveillance.sql`,
`v1/Table__dbo_Recency.sql`, `v1/Table__dbo_Recency_Surveillance.sql`,
`v1/StoredProcedure__dbo_sp_UpdateVLEIDRequests.sql`, `v1/Table__dbo_VLEIDRequests.sql`.
**Interface:** `recencyCte(name, { from, to } = {})`, `recencySurveillanceCte(name, { from, to } = {})`,
`vleidRequestsCte(name)`; columns = the tables' columns in snake_case, same order. The recency builders'
v1 window (from 2023-10-01) becomes `from`/`to`. `tb_edits` patch values are not available (ruling 7).
Commit `feat(packs): rebuild Zambia's recency and VLEID request tables as SQL`.

### Port tasks 6 to 30

Each follows the recipe. Each task lists: queries (name in CE), v1 target and merges (files in `v1/`),
area, parameters, builders, commit message. Read each object's `zm-inv-all.json` row first: its
`notes`, `ce_data` and `reason` carry known quirks and gaps.

| Task | Area | CE query name(s) | v1 target <= merges | Parameters | Builders |
|---|---|---|---|---|---|
| 6 | vl | VL dashboard summary | sp_dash_getHIVVL_v2 <= sp_dash_getHIVVL, vSuppressionByFacility, vVLQuarterlyFacilitySuppressionRate | province, district, facility, from, to | hivvl, tnd |
| 7 | vl | VL dashboard by sex and age; VL dashboard by sex and age (totals); VL monthly trend | sp_dash_getHIVVL_v2_List (two result sets); sp_dash_getMonthlyVLTrend | province, district, from, to; trend: province, district, facility, from, to | hivvl |
| 8 | vl | Client by ART number; VL results for a facility's clients | sp_GetDetailsFromARTNumber; sp_getFacilityVLClientDetails | art_number; facility, from, to | zm_ids, artNumberSql |
| 9 | vl | Earlier VL results of high-VL clients; VL results history by client | sp_GetPreviousVLResultforCohort; sp_GetPreviousVLResultforCohort2 <= sp_GetPreviousVLResultforCohort2_Prega | from, to; from, to, province, pregnant_only (select yes/no) | zm_ids, artNumberSql, formAnswerSql |
| 10 | vl+eid | VL testing summary by area; EID testing summary by area | sp_getSummaryTestEpiData <= District, Facility variants; sp_getSummaryTestEpiDataEID <= EIDDistrict, EIDFacility | level (select province/district/facility), province, district, from, to | hivvl / eid |
| 11 | vl | Unique VL clients | sp_getUniqueVLClientsInfo <= sp_getUniqueVLClientsInfoList, sp_getUniqueVLClientsInfo_bkup, sp_getUniqueVLClientsLast12Months_SPHO_WPHO | province, district, facility, from, to, rows (select: totals / one row per sub-area) | hivvl, tnd |
| 12 | vl | Unique VL clients, 12-month rates; VL requests and tests by lab and month; VL result bands by month | sp_getUniqueVLClientsInfoLast1Year; vVLRequestsTestsByMonth; vVLResRangeBreakDownByMonth | province, district, facility, from, to; none -> from, to; none -> from, to | hivvl, tnd |
| 13 | eid | EID dashboard summary; EID dashboard by facility, sex and age; EID monthly trend | sp_dash_getEID_V2 <= sp_dash_getEID; sp_dash_getEID_v2_List; sp_dash_getMonthlyEIDTrend | province, district, facility, from, to | eid |
| 14 | eid | EID clients by province; EID results; EID tests on GeneXpert | sp_SPHO_eid_clients_month; fn_getEIDs <= vPCR, vPCRInfo; v_GxEIDTests | province, from, to; from, to; from, to | eid |
| 15 | tb | TB GeneXpert dashboard summary; TB GeneXpert by facility, sex and age; TB GeneXpert monthly trend | sp_dash_getTBGNX; sp_dash_getTBGNX_List; sp_dash_getMonthlyTBTrend | province, district, facility, from, to | tbgnx |
| 16 | tb | TB GeneXpert report; VL tests on GeneXpert | fn_GeneXpertReport; v_GxVLTests | from, to; from, to | geneXpert, hivvl |
| 17 | tests | Recency tests; Recency surveillance counts; Recency tests with client names | get_Test_level_Recency; get_Test_level_Recency_Surveillance; get_Test_level_Recency_ZNPHI | from, to | recency, recencySurveillance |
| 18 | tests | DBS monitoring (VL and EID) | sp_CIDRZ_DBS_Monitoring | from, to | hivvl, eid, tnd |
| 19 | tests | CD4 by area, age and sex; HPV results by month | sp_get_CDC_CD4_data_month; sp_get_HPV_data | from, to | none |
| 20 | tests | Culture and susceptibility results; HIV drug resistance | sp_Levy_ast_data_month <= sp_LStone_, sp_Ndola_, sp_UTH_ast_data_month; v_HIVDR | laboratory, from, to; from, to | none |
| 21 | tests | Pathogen panel results (NMPDP); Public health surveillance results (PHSIMS) | v_NMPDP; v_PHSIMS | from, to | none |
| 22 | covid | COVID-19 by testing lab; COVID-19 positive patients; COVID-19 by source facility | sp_COV2_LabStats; sp_COV2_PListing; sp_COV2_SourceStats <= sp_COV2_PSources, sp_COV2_TSources | from, to; from, to, laboratory, facility; from, to, laboratory, show (select all / tested / positive) | none |
| 23 | covid | COVID-19 daily line list; COVID-19 daily positivity | sp_cov_getDayLineList <= sp_cov_getDayLineList_Levy; sp_dash_covid_7d_moving_avg | from, to (date and time), facility; from, to | none |
| 24 | covid | COVID-19 results with location; COVID-19 results (VRDSS); Wastewater results | vw_Covid19_PD <= vw_Covid19; v_vrdss_Covid <= v_vrdss_Covid_V2; WasteWaterData <= WastewaterDataCHAZ | from, to; from, to, layout (select full / V2); from, to, laboratory | none |
| 25 | lab-ops | VL lab performance; EID lab performance; TB lab performance | sp_dash_getLabStats; sp_dash_getLabStatsEID; sp_dash_getTBLabStats | from, to | hivvl, eid, tbgnx |
| 26 | lab-ops | Days since last transmission; Suspect collection dates; DISA Link weekly stats | sp_DQ_DaysSinceLastVLEIDTans; sp_DQ_VLEIDSuspectedWrongSampleCollectionDateEntries; sp_getDisaLinkStats (and fn_WeeklyDisaLinkUpdate) | from (the 2019 floor); from, to; from, to | none |
| 27 | lab-ops | VL and EID weekly stats; Tests authorised by lab and type; VL throughput by lab and month | sp_getVLEIDstats (and fn_WeeklyLISUpdate); sp_LabTestingSummary; sp_LabThroughputTrendbyYear (and fn_annualrequestsTestsTrend) | from, to; from, to; year | vleidRequests |
| 28 | lab-ops | Rejections by facility and reason; VL rejections by lab | vAllSampleRejectionsByFacility <= vEIDSampleRejectionsByFacility, vVLSampleRejectionsByFacility, vVLTotalRejectionsByFacility; vVLSpecimenRejections | test_type (select all/VL/EID), grain (select period/total), from, to; from, to | none |
| 29 | lab-ops | Date completeness; Turnaround times | vDatesCompletionRatesByFacility <= 8 completeness views; vTATLab <= 6 TAT views | level, test_type, from, to; level, test_type, grain, from, to | none |
| 30 | lab-ops | Requests received by week | vWeeklyRequestTrend <= vReceivedRequestsSummary | from, to | vleidRequests |

Commit message per port task: `feat(packs): <CE query names, comma-separated> in reports-zm`.
Where a merge needs a parameter value that changes the output shape (a level or grain), the output
columns follow the v1 object for that value; say so in the query comment.

### Task 31: Build, docs, version 0.1.1

**Files:** `build.mjs` (version `0.1.1`), `PACK.md`, `README.md`, `QUESTIONS-FOR-ZM.md`.
- [ ] Build: every query in the custom-queries step; counts printed; `scan-sql.mjs` ok for all;
  `check-reports-zm.mjs` all pass; MZ check 76/76.
- [ ] PACK.md (admin-facing, signed): what it installs, the query list with one line each, parameters,
  how it differs from v1 (summary), the 1000-row rule, the facility mapping step, the unmeasured-DISA note.
- [ ] README.md (authors): file layout, builders and their v1 sources, the query table (CE name -> v1
  objects), every kept quirk and deviation (collected from the task reports), data CE lacks per query,
  check counts, HONEST NON-PROOF. Link INVENTORY.md.
- [ ] QUESTIONS-FOR-ZM.md: add the MFL `DisaLCode1`-`4` columns; `FacilityList`, `LabList`, `tb_edits`
  (read by the script, not defined in it); ask which reports they use most.
- [ ] unslop over new prose; no em dashes. Commit `feat(packs): reports-zm 0.1.1, the rest of Zambia's reports`.

### Task 32 (controller): sign, install, live check

Sign with the CLI from CE source; `market update` on the dev CE (0.1.0 installed); confirm the query
count in the studio; run three queries (one per builder family) with real parameters; report.

## Self-review notes

- Spec coverage: every row of the spec's query table maps to a task (6-30); builders (2-5); runner and
  layout (1); build/docs/version (31); live (32).
- Builder names and column rules are fixed in Tasks 2-5; port tasks name the builders they use.
- Check group names `t1`..`t31` and fixture id prefixes keep groups apart.

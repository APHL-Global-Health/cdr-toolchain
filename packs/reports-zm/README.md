# reports-zm pack

A content pack for OpenLDR CE. It installs Zambia's health facility register and 74 custom queries
that port Zambia's v1 reports. Version 0.1.0 held one query, "VL clients by province", which replaces
12 v1 procedures. Version 0.1.1 adds the other 73. This is the source of the pack. The signed bundle
is built from it.

Read `INVENTORY.md` for what happens to each of the 181 objects of Zambia's v1 reporting database.
Read `QUESTIONS-FOR-ZM.md` for what we still need from the Zambia team.

## Files

| File | What it is |
|---|---|
| `build.mjs` | Reads Zambia's master facility list (a CSV), adds every query of `all-queries.mjs`, and writes `dist/`. It needs no database. |
| `all-queries.mjs` | The list of every query, in build order: slice 1's query, then each area's. Build and scan both read it. |
| `zm-queries.mjs` | Slice 1: the SQL of "VL clients by province", its text lists and the province picker. It reads the shared builders. |
| `zm-sql.mjs` | Shared SQL helpers and the builders for v1's copy tables. The header comment of each export says what it does. |
| `queries/vl.mjs` | The 16 VL queries after slice 1. |
| `queries/eid.mjs` | The 10 EID queries. |
| `queries/tb.mjs` | The 4 TB queries. |
| `queries/tests.mjs` | The 10 queries for recency, DBS, CD4, HPV, culture, drug resistance, NMPDP and PHSIMS. |
| `queries/covid.mjs` | The 10 COVID-19 and wastewater queries. |
| `queries/lab-ops.mjs` | The 23 lab operations queries: lab performance, data quality, weekly stats, rejections, date completeness, turnaround, weekly requests. |
| `check-reports-zm.mjs` | Runs every check suite against the dev Postgres. 12,908 checks. Run it by hand before a release. |
| `checks/*.mjs` | The suites, one file per area, and `helpers.mjs` for the shared helpers. `epi-fixture.mjs` holds fixture helpers shared by the area files. |
| `scan-sql.mjs` | Scans every query and option list the way CE's SQL check does. Prints `ok` or `BAD` for each. |
| `INVENTORY.md` | What each of Zambia's 181 v1 objects became: port, merge, absorb, blocked or drop. |
| `QUESTIONS-FOR-ZM.md` | Open questions for the Zambia team. |
| `PACK.md` | The text an admin reads in the marketplace before installing. It becomes the manifest readme. |
| `.gitignore` | Keeps `dist/` out of git. |
| `../shared/pg-check.mjs` | The runner `check-reports-zm.mjs` shares with the Mozambique pack. It runs suite groups, one transaction per group. |
| `../shared/pack-build.mjs` | The CSV writer and step summary `build.mjs` shares with the Mozambique pack. |
| `../vl-reports-mz/vl-queries.mjs` | Helpers this pack imports: `rpt`, `isNumericSql`, `inListSql`, `foldSql`. |

`build.mjs` writes these to `dist/`:

| File | What it is |
|---|---|
| `pack.json` | The pack payload: `{ formatVersion: 1, steps }`. |
| `manifest.json` | The unsigned artifact manifest, version `0.1.1`. |
| `build-summary.json` | Row counts, and every row or value left out with the reason. |

## Build

    node packs/reports-zm/build.mjs

It reads the CSV at `ZM_MFL_CSV`, or else the corlix fixture
`Zambia_master_facility_list/mfl_facilities_export20260810155748.csv`. It copies `PACK.md` into the
manifest readme and appends the list of rows and values it left out. An unknown operational status
stops the build. It prints the two steps: the register (3,788 rows) and the custom queries (74).

## Check

    node packs/reports-zm/check-reports-zm.mjs
    node packs/reports-zm/scan-sql.mjs
    node packs/vl-reports-mz/check-vl-functions.mjs

The first runs 12,908 checks in the CE dev Postgres container, on temporary copies of the warehouse
tables, and rolls back. It reads no warehouse rows. It takes several minutes and exits 1 on any
mismatch. The second prints `ok` for each of the 74 queries. The third is the Mozambique pack's check
(76 checks). Run it too, because this pack imports helpers from `vl-queries.mjs`.

Checks per file, with the 35 of slice 1 that sit in `check-reports-zm.mjs`:

| File | Checks |
|---|---|
| `check-reports-zm.mjs` (slice 1) | 35 |
| `checks/helpers.mjs` | 1,055 |
| `checks/vl.mjs` | 1,408 |
| `checks/eid.mjs` | 922 |
| `checks/tb.mjs` | 2,039 |
| `checks/tests.mjs` | 2,206 |
| `checks/covid.mjs` | 1,478 |
| `checks/lab-ops.mjs` | 3,765 |
| Total | 12,908 |

Each check has hand-worked expected rows, made from the v1 text with a comment naming the v1 file and
line. Fixture ids start with the task number (`t14-`). Each suite group runs in its own transaction,
so one area's fixture rows never reach another area's counts. Many suites also run the query with
one rule changed (a mutation) to prove a check fails when the rule is wrong.

## Sign and publish

Pack and sign the build output with the publisher key:

    openldr artifact pack packs/reports-zm/dist --key <publisher key>

`artifact pack` fills `publisher.keyFingerprint` and the payload hash, then signs the manifest.
Publish the signed bundle:

    openldr artifact publish <bundle dir>

The private key never enters a repo. Keep it outside every working tree. Never commit `dist/`.

## Steps, in install order

1. `facility-register` `urn:openldr:zm:facilities`, code `ZMFAC`, name "Zambia health facilities".
2. `custom-queries`: the 74 queries of the table below.

There is no link-matching step. DISA*Lab facility codes are short letter codes (v1's
`sp_update_HIVVLTable` tests `isnumeric(left(...,5)) = 0`). MFL codes are numbers. Matching equal
codes would link nothing. An admin maps each DISA*Lab code to its register row in CE's Facilities
screen, which suggests matches by name. Until a code is mapped, its requests are left out of most
reports. A later version can ship the mapping once Zambia sends its dictionary.

## How the register is built

One row per row of the master facility list (3,788 rows, 21 columns).

| Register column | From the MFL CSV |
|---|---|
| `national_code` | `MFL Code` |
| `name` | `Name` |
| `region` | `Province` |
| `district` | `District` |
| `status` | `Operational status`: Functional `active`, Closed and Permanent closure `inactive`, Temporarily closure `suspended` |
| `latitude`, `longitude` | `Latitude`, `Longitude`, when both are a valid pair |
| `ownership` | `Ownership` |
| `ward` | `Ward` |
| `extras` | `Hims code`, `DHIS2 UID`, `Type`, `Ownership type`, `Constituency` and `Location`, as `hims_code`, `dhis2_uid`, `type`, `ownership_type`, `constituency` and `location` |

- `ownership` and `ward` are standard register columns in CE's facility CSV, so they are not
  extras. The step lists the six extras in `extraColumns`, so CE keeps them and still refuses any
  other unknown column. The headers are lowercase because CE stores extras keys in lowercase.
- CE uses status for display and filtering only. An inactive facility is still listed and reported.
- CE drops a row's coordinates unless both are valid, so the build keeps both or neither. A pair is
  valid only inside Zambia's box: latitude -18.5 to -8.0 and longitude 21.5 to 34.0 (Zambia's extent
  with a small margin). It left them out on 42 rows. 12 are not a valid pair (for example a
  longitude of `29580210`). 30 are valid numbers outside Zambia (MFL 4434 is a position in Paris,
  4159 has latitude and longitude swapped, 4418 lost its minus sign). 98 rows have none in the list.
  `build-summary.json` names the 42.
- Left out of the register: `Zone`, `Mobility status`, `Accesibility`, and the catchment and
  household counts. No output uses them.
- A blank code, a blank name or a repeated code is left out and named in `build-summary.json`.
- Result from the 2026-08-10 export: 3,788 rows, none left out. 3,771 are active, 16 inactive and
  1 suspended.
- Two extras are read by queries. `hims_code` is v1's MOHFacilityCode (see "Names and codes").
  `type` is the FacilityType of "Tests authorised by lab and type".

## Rules every query follows

These come from the spec `docs/superpowers/specs/2026-10-09-reports-zm-all-design.md`. The cost of
each, if wrong, is in the spec.

1. **Output parity first.** A query returns v1's columns, in v1's order and names, and the same rows
   and values for the same data and dates. Where v1 behaves oddly but runs and returns real data,
   the port keeps it. This file lists each such case as "Kept".
2. **Intent where v1 cannot run.** Where v1 stops with an error, or its view selects columns its
   source does not have, the port returns the evident intent. Each case is listed as "Differs".
3. **Fixed windows become parameters.** A window computed from `getdate()` (last month, last 12
   months, the last 7 days) or a hard floor (2018-05-31, 2019, 2020, 2021) becomes `from` and `to`.
   For the window v1 computed, the rows match.
4. **Pickers.** Province and district are pick lists filled from the register. Facility is a text
   box matched on the register name (the COVID-19 daily line list takes a requesting facility code).
   A blank province is "all", except in DBS monitoring (Lusaka, Southern, Eastern, Western and
   North-Western) and Unique VL clients by facility (Southern and Western). Laboratory is matched on
   the testing lab code, except where v1's own parameter is a lab description (the two COVID-19 lab
   queries), a procedure name (Culture and susceptibility results) or one of two fixed names (the
   pick list of Wastewater results).
5. **Copy tables are rebuilt as SQL.** CE keeps no copy of v1's `hivvl`, `tnd`, `eid`, `tbgnx`,
   recency or `VLEIDRequests` tables. One builder per table rebuilds it from the warehouse inside
   each query. See "Shared builders".
6. **The VIRAL questionnaire comes from forms.** cdr-toolchain sends Zambia's VIRAL panel as a form.
   CE keeps the answers as text, not as coded values. The port maps the text with the same rules
   (`Yes`, `Y`, `Yest`, `Pregnant Mother`; case and trailing spaces ignored). Pregnant, breastfeeding,
   baseline and 3-month flags are 0 (blank in the trends) when no form arrived for the request, or
   when its text is not on the yes list (`QUESTIONS-FOR-ZM.md` question 20).
7. **Data CE lacks stays as an empty column** under v1's name. See "Data CE lacks, by query".
8. **Lab names come from CE.** A lab name is the name written on the report, else the mapped register
   name, else the code. A lab code has one name, the same on every row. A name that is not just the
   code beats the bare code, then the smallest in byte order wins. The name is chosen among the
   rows the query lists, so one lab can show another name under another window, when its reports
   carry different names. The two weekly-request queries choose among all reports of the lab, so their
   names do not move with the window. One exception: Wastewater results keeps v1's two-constant
   CASE for its Laboratory (ZCX is CHAZ Laboratory, ZLX is ZNPHRL), because the CHAZ filter needs
   v1's literal.
9. **One query per column set.** A query cannot change its columns by parameter. Where merged v1
   copies had different columns, the port has separate queries.

### Dates, text and numbers

- **Local dates.** A stamp counts on the date written in it (its first ten characters, DISA*Lab writes
  `+02:00`). Elapsed hours use the instant. A stamp that does not start with a full `YYYY-MM-DD`
  (`2026-07`, `''`) counts as no date and is outside every window. A stamp with a well-formed but
  impossible date, such as `2026-02-30`, makes the shared `localDate` helper raise a Postgres error.
  v1's datetime columns cannot hold one, so cdr-toolchain should never send it.
- **Date parameters are checked.** `dateParamSql` (`zm-sql.mjs`) accepts only `YYYY-MM-DD`: four
  digits, a real month and day, 29 February only in a leap year, no year 0000. Any other value
  raises `<parameter> must be YYYY-MM-DD, got <value>`, inside Postgres' own wording
  `invalid input syntax for type integer:`. The error is raised at plan time because the integer cast
  is immutable and Postgres folds it. A date cast is only stable and would run per row, so a window
  over an empty table would never see a bad date. A blank required date raises. A blank optional one
  is no limit. The COVID-19 daily line list checks `YYYY-MM-DDTHH:MM` its own way (`dateTimeOkSql`:
  a real date, hours 00 to 23), with the same integer cast, so its error also comes at plan time. The `year` of "VL throughput by lab and month"
  is not a date. It is cast with `::int`, and a bad value gives Postgres' own message.
- **Where the last day counts only its first instant.** v1 compares a datetime column with a date
  parameter, so `to` means `to` 00:00:00. The port keeps this in: VL results for a facility's clients,
  Earlier VL results of high-VL clients, VL results history by client, VL testing summary by district
  and by facility, Unique VL clients, Unique VL clients by facility (12 months), the three EID testing
  summaries, EID results (list "All requests"), TB GeneXpert report, COVID-19 by testing lab,
  COVID-19 by source facility and Suspect collection dates. A window with `from` equal to `to` holds
  only what happened at exactly midnight. Other windows differ in the notes below. HPV results by month
  runs from `from` 00:00:01 to `to` 23:59:59. COVID-19 positive patients adds one day to `to`.
- **The day after `to` is included.** The dashboard procedures add a day to the end date. The port
  keeps it in VL dashboard summary, EID dashboard summary, TB GeneXpert dashboard summary and TB
  GeneXpert by facility, sex and age (the whole next day). VL dashboard by sex and age and EID
  dashboard by facility, sex and age include `to` plus one day up to 00:00:00 only.
- **Text compares like SQL Server.** Case and trailing spaces are ignored in joins, filters and
  groups (`foldSql`). A leading space counts. A group shows one spelling, the smallest in byte order.
  Where v1's output depends on text order (MAX or MIN of text, `row_number` over text, row order) the
  port uses `ssTextKey`, the measured word sort of SQL Server's `Latin1_General_CI_AS`: underscore
  first, hyphens and apostrophes ignored. It assumes Zambia's v1 columns use that collation, as
  Tanzania's v1 does. It maps characters up to U+00FF only. It cannot tell `co-op` from `coop`.
- **Numbers like ISNUMERIC.** `numberOfTextSql` reads a result text as v1's `ISNUMERIC` would:
  leading spaces, tabs, line feeds and carriage returns; a sign; commas; one exponent of up to three
  digits. A trailing tab, CR or LF, a currency sign and a lone dot are not numbers. Where v1
  casts such a text and stops with an error (`999.5` cast to bigint, `1,500`, `1E3`), the port
  reads the number. Those expected rows are intent, not v1 output. The helper does not read a comma
  in front of the digits (`,5`), a comma after the decimal point (`1.5,0`) or the exponent letter `d`
  (`1d2`), which ISNUMERIC accepts. `isNumericSql` in `vl-reports-mz` shares these gaps and is not
  changed.
- **Rates.** SQL Server cuts a division in `decimal` at its scale, so rates are cut, not rounded
  (`rateCutSql`: 1 of 3 is 33.333333333333). Averages of integers cut toward zero (-1.5 gives -1).
  Where a fixture could not tell float from decimal, a check pins the type.
- **Weeks.** `dateWeekSql` is `datepart(wk)`: Sunday first, week 1 holds 1 January, so week 53 can be
  a short week. It assumes SQL Server's default `DATEFIRST` of 7.
- **Zambia's clock.** "Today" is the date in `Africa/Lusaka` (UTC+2, no daylight saving), not the
  server's date. `TODAY_ZM` in `zm-sql.mjs`.
- **Row order.** v1 mostly had no ORDER BY, and CE pages with LIMIT and OFFSET. Each query orders by
  every output column, so paging is stable. Each fixed pick list ends in an ORDER BY on one column,
  and its first value is the default (`all`, `standard`, `Totals`).

### Names and codes

- **Facility mapping.** `requesterJoin` matches the requesting facility code exactly against
  `facility_map.source_code`. That table keeps one row for each spelling of a code that CE has seen,
  and cdr-toolchain trims codes (`facility-reconcile.ts:168-178, 906-914` in `openldr_ce`). So each
  spelling needs its own mapping. A join that folded case would count a request twice. A request
  from an unmapped facility is left out of the area reports. Other queries keep it with blank names:
  COVID-19 by testing lab and by source facility (it counts as Registered only), COVID-19 positive
  patients, the COVID-19 daily line list, the two COVID-19 results extracts and the two VRDSS feeds,
  EID results, HIV drug resistance, NMPDP, PHSIMS, Rejections by facility and reason and VL
  rejections by facility (total).
- **Area names** come from the mapped register row. Some queries keep a mapped row with no province,
  where v1's inner join to its dictionary would drop it. The comments say which. Spellings can differ
  from v1's `Facilities.Description` and `HealthcareAreas.HealthcareAreaDesc`.
- **Testing lab.** CE's testing lab is `diagnostic_reports.performer`. cdr-toolchain writes it from its
  configured `OPENLDR_LAB_CODE` for each push (cdr `v2-transform.ts:401`, `site-config.ts:39-74`). It
  is not a value DISA*Lab writes per request. So every query that reads `TestingFacilityCode` needs
  each lab's push to set `OPENLDR_LAB_CODE` to that lab's v1 code (`ZUA`, `ZTT` and so on). If it is
  unset, the "lab" is the requesting clinic. One DISA*Lab instance that serves several sub-lab codes
  (UTH: `ZUA`, `ZUE`, `ZUL`) collapses to one code. cdr pushes a report for every OBR, resulted or
  not, and credits a blank DISA testing code to the pushing lab. v1 handled a blank code in different
  ways. Some reports fall back to the receiving facility code, which CE does not carry, so there only
  the lab that gets the credit differs. Others leave the request out (COVID-19 by testing lab
  filters `len([Lab Description]) > 0`, and the all-requests and EID turnaround views inner-join
  `LabList` on the testing code). PHSIMS keeps a blank code with no lab name. CE always names the
  pushing lab, so some counts can be higher than v1's. Only a report with a blank performer (data cdr
  did not push) or a request with no report has no lab. Such a request is left out of the per-lab
  reports.
- **MOHFacilityCode** is the register's HMIS code, `extras.hims_code`. v1's own alias is
  `f.MOHFacilityCode HMISCode` (VRDSS line 47) and the column is `nvarchar(10)`, which fits the
  8-digit HMIS code. Recency tests, Recency tests with client names and both VRDSS feeds read it. A
  facility with no register row, no extras or no `hims_code` gives NULL. PHSIMS `MFL Code` is another
  v1 column and keeps the register's `national_code`.
- **ART number.** v1 builds it from `REFNO` and `UNIQUEID` (request attributes `reference-numbers` and
  `unique-id`) and `HOSPID`. `HOSPID` is not sent. Three variants exist because each v1 procedure
  copies the rule with changes: `artNumberSql` (slice 1, with the `,ELABS` steps), `artNumberShortSql`
  (no `,ELABS` steps, dashes and spaces removed), `artNumberRawSql` (spaces and dashes stay). Each
  query uses the one whose CASE matches its procedure.
- **Forms.** A request entered through a CE form has no `request_id` (the forms code,
  `extract.ts:175-180`). `count(request_id)` skips it, as v1's count skips a NULL.
- **Gender.** CE stores the FHIR gender `other` as `O`. The hivvl and eid builders know only F, M, I
  and U, so a v1 client with sex `I` falls under Missing. Reports that print the raw letter show a
  blank.
- **Locale.** The COVID-19 result CASE keeps v1's misspelled `Ínconclusive`. The pack lower-cases the
  accented I when it writes the SQL, so the database must lower-case it too. That needs a UTF-8
  `LC_CTYPE` (`SHOW lc_ctype;`). In a C-locale database even the exact text fails to match.
- **Row limit.** The pack's queries are meant to run on the Query page (`/query`). It calls
  `/api/query/run`, which returns at most 1000 rows a call, and the page asks for one page at a time
  with `limit` and `offset` (`openldr_ce` `apps/server/src/query-routes.ts:137-168`,
  `apps/studio/src/query/workspace/QueryTab.tsx:43`). So it has no overall limit. A report
  definition on `/reports` runs its query through `runStoredQuery`
  (`packages/bootstrap/src/index.ts:295`), and a report design's PDF does too
  (`report-designs-routes.ts:171`). That stops at 1000 rows (`ROW_CAP` in `custom-query-run.ts`):
  past it, the run fails with an error, not a cut list. The designer's Excel export pages through
  `/api/query/run` and gets every row (`exportExcel.ts:45-58`). Line lists can pass 1000 rows in a
  busy month.
- **Size.** "Unique VL clients" is about 39 KB of SQL and "COVID-19 daily line list" about 11 KB,
  because the builders are inlined. CE has no size limit that we found.

## Performance notes

Nothing here was timed on a large warehouse (see HONEST NON-PROOF). These notes say where the cost
sits.

- **VIRAL form answers.** `questionnaire_responses` has no index on `based_on_id` in CE (only the
  primary key). `formAnswerSql` is a subquery per request, so each call scans the whole table. The
  queries do not call it any more. `formAnswersCte` reads the form once per query, for the requests
  in scope, and the hivvl builder and "VL results history by client" join that. We recommend an
  index on `questionnaire_responses (based_on_id)` in CE. It is a CE change and is not part of this
  pack.

## Shared builders

Each builder is a function in `zm-sql.mjs` that returns a CTE (a named sub-query). It takes the date
range so it reads only what the report needs. Each has its own check suite. Column names are v1's
table columns in snake_case.

| Builder | Rebuilds | From v1 | Notes |
|---|---|---|---|
| `hivvlCte` | `HIVVL` | `sp_update_HIVVLTable` | One row per lab number after v1's dedupe. `rowIds`, `extraDays`, `labsInWindow` options. Reads the VIRAL form answers. |
| `tndCte` | `TND` | `sp_GetPreviousVLResultforCohort2x` | Slice 1's part 1, as a builder. `rank: true` adds v1's rank over all time, with its 2017-01-01 floor and `now()` ceiling. |
| `eidCte` | `EID` | `sp_update_EIDTable` | Keeps v1's column spelling `recieved_date`. |
| `geneXpertCte` | `v_GeneXpert` | `v_GeneXpert` | MTB and RIF results joined on eleven columns, as v1 does. |
| `tbgnxCte` | `TBGNX` | `sp_getTBsLastHour` over `v_GeneXpert` | `extraDays` option. |
| `recencyCte` | `Recency` | `sp_getTestLevelRecency_CIDRZ` | Lab numbers join ignoring case and trailing spaces. |
| `recencySurveillanceCte` | `Recency_Surveillance` | `sp_recency_surveillance` | Window on the registered date. |
| `vleidRequestsCte` | `VLEIDRequests` | `sp_UpdateVLEIDRequests` | Four panels, plus a VIRAL row per host with a form answer. `rowIds` option. |
| `epiSummarySql` | the epi summaries | `sp_getSummaryTestEpiData*` | Shared by the six testing summaries. |

Other shared helpers: `inRange`, `localDate`, `localTs`, `utcTs`, `dateParamSql`, `optionalWindowSql`,
`requesterJoin`, `registryRowJoin`, `hmisCodeSql`, `areaFilter`, `given`, `blank`, `same`, `count1`,
`ratio`, `ssTextKey`, `numberOfTextSql`, `likeVarcharSql` (SQL Server's varchar LIKE: a trailing space
can fill a `_`), `testedAtSql`, `referralSql`, `labNameSql`, `labNamesCte`, `testingCodeSql`,
`requestAttrSql`, `formAnswerSql`, `formAnswersCte`, `genderSql`, `ageGroupSql`, `dateWeekSql`, `optionsListSql` and
`TODAY_ZM`.

## The queries

Each row names the v1 objects the query replaces. The first is the target. The others are merged
into it. `INVENTORY.md` has the verdict for every object.

| # | Query | v1 objects it replaces |
|---|---|---|
| 1 | VL clients by province | sp_SPHO_hivvl_clients_month; the 11 other copies (`sp_<province>_hivvl_clients_month` for nine provinces, sp_EPHO_hivvl_clients_quarter, sp_SPHO_hivvl_clients_quarter) |
| 2 | VL dashboard summary | sp_dash_getHIVVL_v2; sp_dash_getHIVVL |
| 3 | VL dashboard by sex and age | sp_dash_getHIVVL_v2_List (also the intent of vSuppressionByFacility and vVLQuarterlyFacilitySuppressionRate) |
| 4 | VL monthly trend | sp_dash_getMonthlyVLTrend |
| 5 | Client by ART number | sp_GetDetailsFromARTNumber |
| 6 | VL results for a facility's clients | sp_getFacilityVLClientDetails |
| 7 | Earlier VL results of high-VL clients | sp_GetPreviousVLResultforCohort |
| 8 | VL results history by client | sp_GetPreviousVLResultforCohort2; sp_GetPreviousVLResultforCohort2_Prega |
| 9 | VL testing summary by province | sp_getSummaryTestEpiData |
| 10 | VL testing summary by district | sp_getSummaryTestEpiDataDistrict |
| 11 | VL testing summary by facility | sp_getSummaryTestEpiDataFacility |
| 12 | Unique VL clients | sp_getUniqueVLClientsInfo; sp_getUniqueVLClientsInfoList; sp_getUniqueVLClientsInfo_bkup |
| 13 | Unique VL clients by facility (12 months) | sp_getUniqueVLClientsLast12Months_SPHO_WPHO |
| 14 | Unique VL clients, 12-month rates | sp_getUniqueVLClientsInfoLast1Year |
| 15 | VL requests and tests by lab and month | vVLRequestsTestsByMonth |
| 16 | VL result bands by month | vVLResRangeBreakDownByMonth (helper view vVLReportData) |
| 17 | VL tests on GeneXpert | v_GxVLTests |
| 18 | EID testing summary by province | sp_getSummaryTestEpiDataEID |
| 19 | EID testing summary by district | sp_getSummaryTestEpiDataEIDDistrict |
| 20 | EID testing summary by facility | sp_getSummaryTestEpiDataEIDFacility |
| 21 | EID dashboard summary | sp_dash_getEID_V2; sp_dash_getEID |
| 22 | EID dashboard by facility, sex and age | sp_dash_getEID_v2_List |
| 23 | EID monthly trend | sp_dash_getMonthlyEIDTrend |
| 24 | EID clients by province | sp_SPHO_eid_clients_month |
| 25 | EID results | fn_getEIDs; vPCR |
| 26 | EID request answers | vPCRInfo |
| 27 | EID tests on GeneXpert | v_GxEIDTests |
| 28 | TB GeneXpert dashboard summary | sp_dash_getTBGNX |
| 29 | TB GeneXpert by facility, sex and age | sp_dash_getTBGNX_List |
| 30 | TB GeneXpert monthly trend | sp_dash_getMonthlyTBTrend |
| 31 | TB GeneXpert report | fn_GeneXpertReport |
| 32 | Recency tests | get_Test_level_Recency |
| 33 | Recency surveillance counts | get_Test_level_Recency_Surveillance |
| 34 | Recency tests with client names | get_Test_level_Recency_ZNPHI |
| 35 | DBS monitoring (VL and EID) | sp_CIDRZ_DBS_Monitoring |
| 36 | CD4 by area, age and sex | sp_get_CDC_CD4_data_month |
| 37 | HPV results by month | sp_get_HPV_data |
| 38 | Culture and susceptibility results | sp_Levy_ast_data_month; sp_LStone_ast_data_month; sp_Ndola_ast_data_month; sp_UTH_ast_data_month |
| 39 | HIV drug resistance | v_HIVDR |
| 40 | Pathogen panel results (NMPDP) | v_NMPDP |
| 41 | Public health surveillance results (PHSIMS) | v_PHSIMS |
| 42 | COVID-19 by testing lab | sp_COV2_LabStats |
| 43 | COVID-19 positive patients | sp_COV2_PListing |
| 44 | COVID-19 by source facility | sp_COV2_SourceStats; sp_COV2_PSources; sp_COV2_TSources |
| 45 | COVID-19 daily line list | sp_cov_getDayLineList; sp_cov_getDayLineList_Levy |
| 46 | COVID-19 daily positivity | sp_dash_covid_7d_moving_avg |
| 47 | COVID-19 results with location | vw_Covid19_PD |
| 48 | COVID-19 results with facility location | vw_Covid19 |
| 49 | COVID-19 results (VRDSS) | v_vrdss_Covid |
| 50 | COVID-19 results (VRDSS V2) | v_vrdss_Covid_V2 |
| 51 | Wastewater results | WasteWaterData; WastewaterDataCHAZ |
| 52 | VL lab performance | sp_dash_getLabStats |
| 53 | EID lab performance | sp_dash_getLabStatsEID |
| 54 | TB lab performance | sp_dash_getTBLabStats |
| 55 | Days since last transmission | sp_DQ_DaysSinceLastVLEIDTans |
| 56 | Suspect collection dates | sp_DQ_VLEIDSuspectedWrongSampleCollectionDateEntries |
| 57 | DISA Link weekly stats | sp_getDisaLinkStats (body of fn_WeeklyDisaLinkUpdate) |
| 58 | VL and EID weekly stats | sp_getVLEIDstats (body of fn_WeeklyLISUpdate) |
| 59 | Tests authorised by lab and type | sp_LabTestingSummary |
| 60 | VL throughput by lab and month | sp_LabThroughputTrendbyYear (function fn_annualrequestsTestsTrend) |
| 61 | Rejections by facility and reason | vAllSampleRejectionsByFacility; vEIDSampleRejectionsByFacility; vVLSampleRejectionsByFacility |
| 62 | VL rejections by facility (total) | vVLTotalRejectionsByFacility |
| 63 | VL rejections by lab | vVLSpecimenRejections |
| 64 | Date completeness by province | vDatesCompletionRatesByProvince |
| 65 | Date completeness by district | vDatesCompletionRatesByDistrict |
| 66 | Date completeness by facility | vDatesCompletionRatesByFacility; vDatesCompletionRatesByFacilityEID; vDatesCompletionRatesByFacilityVL |
| 67 | Date completeness by lab | vDatesCompletionRatesByLab |
| 68 | Date completeness by lab facility | vDatesCompletionRatesByLabEID; vDatesCompletionRatesByLabVL |
| 69 | Date completeness by lab area | vDatesCompletionRatesByLabArea |
| 70 | Turnaround times by lab | vTATLab; vTATEIDLab; vTATVLoadLab |
| 71 | Turnaround times by province | vTATProvince; vTATEIDProvince; vTATVLoadProvince |
| 72 | VL turnaround by month | vTATVLoadLabMonth |
| 73 | Requests received by week | vWeeklyRequestTrend |
| 74 | Requests received by week (VLEID copy) | vReceivedRequestsSummary |

## VL clients by province

Takes the place of v1's 12 province procedures. One query with three parameters.

- `province`: optional. A select, filled by `provinceOptionsSql`: the distinct `region` of the
  `in_register` rows of `urn:openldr:zm:facilities` in `facility_registry`. Blank means all.
- `from`, `to`: required. Dates as `YYYY-MM-DD`. A month or a quarter is a range.

Dates compare on the date written in the stamp (its first ten characters, the local date), so
`from <= date <= to`. A request at 23:30 with a `+02:00` offset stays on its local day.

Province, District and Facility come from the register row the requesting facility is mapped to.
Every part keeps only requests with a mapped facility, as v1's inner joins drop facilities missing
from its dictionary. The columns keep v1's order. The rows sort by province, district, facility
and lab ID.

Three parts, joined with `UNION`, which removes duplicate rows as v1's does:

1. `zm_valid` (v1's table `TND`, built by `sp_GetPreviousVLResultforCohort2x`, now the `tndCte`
   builder). Panel `HIVVL` or `RTRI`. Observation `HIVVL`, `HIVVC`, `HIVTM`, `HIVVD`, `POCVR` or
   `POCVC` (`ZM_CODES`). Report status final and `ResultDate` in range. The result is not in
   `INVALID_RESULTS` (26 texts). One row per result. `Suppressed` is `Yes` when the result is in
   `SUPPRESSED_RESULTS` (16 texts) or the number is under 1000, else `No`.
2. `zm_rejected`. Panel `HIVVL`. Report status `cancelled` (v1 `X`) and `RegisteredDate` in range.
   The request is not in part 1. `Result` is `REJECTED` and `Suppressed` is NULL.
3. `zm_unclear`. Panel `HIVVL`. Observation `HIVVL`, `HIVVC` or `HIVVD`. Report status final and
   `ResultDate` in range. The result is not a number (`isNumericSql`, shared with `vl-reports-mz`)
   and is not in `BELOW_LIMIT_RESULTS` (9 texts). The request is not in part 1. `Suppressed` is
   NULL.

The three lists differ from each other in v1, and differ again from the lists in other Zambia
procedures. Each part keeps its own list as v1 has it. They are Zambia content, not CE vocabulary
(AGENTS.md section 8), so they live here and not in CE. Text comparison follows SQL Server's default
collation: case-insensitive, trailing spaces ignored.

`Result` is the reported value (`rpt()` in `vl-reports-mz`): text, else comparator and number, else
code. `Gender` maps the HL7 letter: F `Female`, M `Male`, U `Unknown`, I `Indeterminate`, else
`Missing`. `Name` is first name, a space, then surname, with a missing part read as empty.

### The ART number

Part 1 builds `ARTNumber` with `artNumberSql`, v1's rule from `sp_GetPreviousVLResultforCohort2x`.
Parts 2 and 3 show the unique ID raw, as v1's `rejects` and `incs` do. The rule reads two request
attributes in `urn:openldr:cs:request-attribute`: `reference-numbers` (v1 `REFNO`, DISA*Lab
`RefNos`) and `unique-id` (v1 `UNIQUEID`, DISA*Lab `UniqueID`). cdr-toolchain sends nothing for an
empty ID, so part 1 reads a missing one as `''`, which is what v1 holds. Steps, in order:

1. `REFNO` starts `,ELABS`: the text after the first `T.`.
2. `REFNO` contains `,ELABS`: the part before `,elabs`, less its first 3 characters.
3. v1: `REFNO` blank and `HOSPID` set gives `HOSPID`. The pack skips this step. DISA*Lab's
   hospital number field is not known, so `HOSPID` is not sent.
4. `REFNO` blank after removing `,`, `AT.`, spaces and `-`: `UNIQUEID` without spaces and `-`.
5. `REFNO`, less `,` and `AT.`, starts `ART.` or `ELABS.`: `UNIQUEID` without spaces and `-`.
6. Otherwise `REFNO` without `,`, `AT.`, spaces and `-`.

Steps 1 and 2 follow v1's `LEN` and `RIGHT` arithmetic. `LEN` ignores trailing spaces and `RIGHT`
counts them. So a trailing space makes the result one character short at the front and keeps the
space. The check has two cases for it. Step 2 errors in SQL Server when the text before `,elabs` is
under 3 characters. The pack returns `''`. Matching is case-insensitive, as `LIKE` and `REPLACE`
are in SQL Server. Postgres `replace` is case-sensitive, so the `AT.` removal is a case-insensitive
regular expression.

### Where it differs from v1

- **Names.** Province, District and Facility come from the master facility list, not from v1's
  `Facilities.Description` and `HealthcareAreas.HealthcareAreaDesc`. Spellings can differ.
- **Rejected means cancelled only.** cdr-toolchain maps v1 `X` to `cancelled` and sends `Y` and `Z`
  as `unknown` (`fhir-transform.ts:109-118`), so they cannot be picked out. Listed, not fixed. See
  `QUESTIONS-FOR-ZM.md`.
- **Gender and RegisteredDate are always filled.** v1 part 1 takes them from its `hivvl` table,
  which has a row only when the request also has VIRAL or RTRI data. So v1 shows them blank
  otherwise. Where v1 shows a value, it is the same value. CollectedDate and ResultDate are empty
  when the report has no date.
- **A request with no patient still lists.** v1's `TND` needs a `Patients` row (an inner join). The
  port uses a left join, so such a request lists with an empty name.
- **No 2017 floor.** v1's `TND` keeps results from 2017-01-01. The date range replaces it.
- **The ART number has no `HOSPID` step** until its DISA*Lab source is known.
- **ART number per part.** v1 builds it in part 1 only. Parts 2 and 3 show the raw unique ID, and
  so does the port.
- **Blank IDs.** v1 holds `''` for an empty ID. cdr-toolchain sends nothing. Part 1 reads a
  missing one as `''`. Parts 2 and 3 show NULL.
- **v1's `RIGHT` error.** Step 2 returns `''` where v1 raises an error.
- **Changed in 0.1.1.** The date parameters are checked, and a stamp that does not start with a full
  date is outside every window. The `TND` part now comes from `tndCte`. Its rows are the same.

## Notes on each query

Each query has a comment above it in `queries/*.mjs`. The comment names the v1 objects, every kept
quirk, every deviation and every CE gap, with v1 line numbers. The comment is the most current
source. These notes sum it up. "Kept" is a v1 behaviour the port keeps. "Differs" is where the port
gives the evident intent. "CE lacks" is data CE does not hold.

v1 declares its area parameters as short `varchar`s (province 15 to 20, district 20 to 50, facility 40
to 50). A longer name is cut and matches nothing in v1. The port matches the full name in every query.
No Zambian name is that long.

### VL

- **VL dashboard summary.**
  - Kept: the whole day after `to` is included. A district without a province, or a facility without
    both, returns no row. AverageTAT and AverageTAT_POC cut toward zero. Gender knows F, M, I and U.
    The 12 age bands count tests, and Suppressed is a total only. Pregnant, BreastFeeding, BaselineVL
    count where the flag is 1. ThreeMPostUnSuppressed is NULL when no flag is set. TatWithin48h_POC
    tests 24 hours. Zambia with no test in range is one row with Tests 0 and NULL sums.
  - Differs: SuppressionRate is NULL where v1 stops with "divide by zero" (every test is baseline).
    v1 lists AgeMissing twice in the province, district and facility branches. A result keyed by
    name cannot hold two, so every branch has the 108 columns of the national shape.
  - Not carried from the older `sp_dash_getHIVVL`: its rate counts baseline tests, its result lists
    are shorter, it does not dedupe per lab number, it left-joins the facility dictionary and it reads
    panel HIVVL only.
- **VL dashboard by sex and age.**
  - Kept: one query. v1's second result set is the row it returns when nothing matches, so the
    fallback row has the main column names and UnSuppressed 0. Without a province the groups are per
    province, with District and Facility `All`. A district without a province returns nothing. The
    window runs from `from` 00:00:00 to `to` plus one day at 00:00:00, so a test at exactly midnight
    shows in two touching windows. Gender and AgeGroup are Missing when unknown.
  - Differs: rows sort by the lower-cased name in byte order, not by SQL Server's word sort (row order
    only). It stands in for the two broken views (`vSuppressionByFacility` selects columns its
    source does not have, and `vVLQuarterlyFacilitySuppressionRate` tests a label its source never
    produces, so its rate is always 100). It has their suppressed and unsuppressed counts by sex and
    age. It has no time split, so run it once per quarter or month. The rate is Suppressed / Tests.
- **VL monthly trend.**
  - Kept: any other area combination shows all of Zambia. Pregnant, BreastFeeding and Baseline are
    NULL for a month with no flagged test. The month is the local month.
  - Differs: the first and last month are partial when the window does not sit on month edges.
- **Client by ART number.**
  - Kept: the stored ART number has its dashes and spaces removed, the parameter does not, so
    `AB-1234` finds nothing. One row per lab number. The ART rule has no `,ELABS` steps
    (`artNumberShortSql`).
  - CE lacks: HOSPID. The query shows patient names. v1's `Patients` is assumed to hold one row per
    request number, so the port shows each lab number, first name and surname once.
- **VL results for a facility's clients.**
  - Kept: SerialNumber counts over the whole window before the facility filter, so one facility's
    numbers have gaps and a different window renumbers. Suppressed is 1 for any coded value, even
    beside a number of 1000 or more. The suppressed list is shorter than the `hivvl` one. The facility
    matches on name. TAT3 is hours cut to 7 decimals, not rounded.
  - Differs: a decimal result text (`999.5`) is read as a number, where v1 stops. The facility is a
    required text box with no "all" mode. v1 overflows (Msg 8115) when analysis to authorised is
    100,000,000 seconds or more. The port returns a value.
- **Earlier VL results of high-VL clients.**
  - Kept: the cohort rule has no panel or observation filter, so a numeric result of four or more
    characters from any test puts a client in. Visits are numbered per sex but the pivot merges the
    sexes, and MAX keeps the greater text. A client is a facility name plus an ART number, case
    ignored. Visits past 10 are not shown. The history is 365 days before `from`.
  - CE lacks: HOSPID.
- **VL results history by client.**
  - Kept: it repeats every history row once per cohort result. Rank 1 is the newest. Any text that is
    not a number is "Suppressed". The history is 730 days.
  - Differs: `5,000`, `123.4` and `1E3` are read as numbers, where v1 stops. Province is a parameter
    (v1 fixed Lusaka). `pregnant_only` merges the `_Prega` copy. Its VIRAL request has no CE row, so
    the window comes from the reports of the same lab number.
- **VL testing summary by province, by district, by facility.**
  - Kept: province adds a day to the end date, district and facility end at `to` 00:00:00. The
    invalid and suppressed lists differ per level, and GT10 is unsuppressed at district level only.
    All parts join on the registrations, so a facility with tests but no registration in range has
    no row. District gives a NULL district its own row. Facility filters on the district name only, so
    same-named districts of two provinces mix. TATpre is an average cut per facility, times
    TATTests.
  - Differs: decimal result texts are read as numbers. Names are grouped ignoring case and
    trailing spaces and show one mapping row's spelling.
- **Unique VL clients.**
  - Kept: a client is first name, surname and ART number at one facility. The window ends at `to`
    00:00:00. Baseline labs are dropped before ranking. `rank()` lets ties all count. The facility
    branch ranks by ART number only, so two people on one number are one client. The province-and-district
    branch's UndetectableC list lacks `<883 copies/mL`. Clients counts a numeric result or one of 15 texts,
    while the 65 sex-by-age columns count every client. A branch needs a TND row in range, else the
    all-zero row.
  - CE lacks: HOSPID. v1's 2017-01-01 floor and "today" ceiling.
- **Unique VL clients by facility (12 months).**
  - Kept: blank province means Southern and Western, as v1's constants. The baseline lab is dropped
    after ranking, so a client whose newest result is a baseline test leaves the report. Clients
    counts any text.
  - Differs: v1 cannot run as dumped, because `BaselineVL` is ambiguous (measured on SQL Server:
    "Ambiguous column name"). The port reads the `hivvl` flag.
- **Unique VL clients, 12-month rates.**
  - Kept: the latest result ever decides the client, with no fallback. The district and facility
    branches lack `ND` in the text list, and `<400` is a dead entry. The rank partition has panel
    and sex, so one client can count twice. Rates are cut at 12 decimals. v1's floor and ceiling
    apply. An area with no client gives 0 and NULLs. Any other parameter combination gives zeros.
  - Differs: `from` and `to` are the 12 months. For a run in October 2026 that is 2025-10-01 to
    2026-09-30.
- **VL requests and tests by lab and month.**
  - Kept: Tested matches the month only, not the year, so May 2026 also counts every other May. It
    matches on the testing code only. A request with no date is one row with NULL Year and Month.
  - Differs: `from` and `to` are optional, and cut Requests only. Laboratory is the stored
    performer code.
- **VL result bands by month.**
  - Kept: a request with no date shows its Total and 0 in every band. Unknown results count in Total
    only. The month is the collection date, else received, else registered.
  - Differs: v1's last two columns are always 0, because the view tests labels its source never
    produces. The port counts `< 1000 copies/ml` as 20 up to 1000, and `>= 1000 copies/ml` as 1000 and
    over. A result of exactly 1000 is in the last column, as the header says. Zambia should confirm.
- **VL tests on GeneXpert.**
  - Kept: a test repeats once per request row of its lab number with a `G____` analyser. `G____`
    follows SQL Server's varchar LIKE.
  - Differs: the rolling 1,095-day window is `from` and `to`. A test with a blank performer is out.
  - CE lacks: Referral (NULL). Disalink is 0 until cdr-toolchain sends the pre-registration facts.

### EID

- **EID testing summary by province, district, facility.**
  - Kept: the window ends at `to` 00:00:00. The joins hang off the tests, the opposite of VL: a
    facility with registrations but no tests has no row, and one with tests but no registrations has
    Registrations NULL. Facility filters on province and district. There is no invalid-text filter
    (v1 has it commented out).
- **EID dashboard summary.**
  - Kept: the whole day after `to`. Negative is Tests minus Positive. TatWithin48h_POC is NULL when POC
    tests exist and none is within 24 hours, and it tests 24 hours. Age-by-sex columns of a missing
    age end `AgeMissingm`, `AgeMissingf` and so on.
  - Differs: the zero rows of v1 have their own column lists. The port uses the main names and 0 for
    the four columns v1 leaves out.
  - Not carried from `sp_dash_getEID`: its narrower population, its own positive texts and its
    left-joined facility.
- **EID dashboard by facility, sex and age.**
  - Kept: all of Zambia is per facility, not per province. The ORDER BY of two branches omits
    District or Facility. The window runs to `to` plus one day at 00:00:00. Negative, Error and Invalid
    are the table flags, so an unlisted result counts in Tests only. A negative received-to-tested gap
    counts in every bucket. A fallback row uses the main names.
- **EID monthly trend.**
  - Kept: any other area combination shows all of Zambia. No extra day at the end. The month is
    local.
- **EID clients by province.**
  - Kept: AgeInYears of a valid row counts calendar-year boundaries. Result is NULL for Invalid and
    unlisted texts. Valid Gender is NULL where rejected is Missing. A rejected request is dropped when
    its lab number is valid in the same window and province. The rejected part reads panels HIVPC and
    POCGH. `UNION` merges equal rows.
  - CE lacks: HealthcareNo and HOSPID (empty). Statuses Y and Z.
- **EID results.**
  - Kept: day 366 is in no band. Any observation of an HIVPC request counts, and a non-result shows as
    Unknown. The list "All requests" windows on the specimen date, else the registered date, at
    midnight.
  - Differs: the list "Under 2 years, no rejected requests" is `vPCR`. It had no window in v1, so
    it takes `from` and `to` with the whole last day in.
  - CE lacks: ProvinceID and DistrictCode (empty). Names come from the register, not from `FacilityList`
    (not in the script).
- **EID request answers.**
  - Differs: where a request has two results for one observation, v1 takes `top 1` with no order.
    The port takes the lowest result row id. It has no parameters, as v1 has none.
- **EID tests on GeneXpert.** Same notes as "VL tests on GeneXpert".

### TB

- **TB GeneXpert dashboard summary, by facility, sex and age, monthly trend.**
  - Kept: the whole day after `to` for the summary and the list. An unsupported area combination
    returns nothing there, and the trend falls to the unfiltered branch. The province and district
    branches of the summary have no zero row, the facility branch has one. Tests counts rows with
    no dedupe. A reported `Detected _ Low` (spaces) is not on the RIF list, `Detected_Low` is. The
    MTB and RIF results join on eleven columns, so a missing fact loses the RIF.
  - Differs: the zero rows repeat or misspell columns in v1. The port uses the main names.
- **TB GeneXpert report.**
  - Kept: the window ends at `to` 00:00:00. MTB uses a prefix match (`Detected%`) and RIF an equality.
    A negative age is Unknown. There is no dedupe. Groups fold case and spaces. One lab name per
    testing code.
  - CE lacks: LabName is NULL for a report with a blank performer.

### Tests

- **Recency tests, Recency surveillance counts, Recency tests with client names.**
  - Kept: rows multiply (several baseline results or answers give a row each). A baseline text on no
    list has no status. `<883 copies/mL` is suppressed in the list and not in the counts. In the
    counts, age 50 is `<15`, and a lab number with baselines in two classes counts once in each. The
    week is `datepart(wk)`.
  - Differs: v1's fixed window (from 2023-10-01) is `from` and `to` on the registered date, with the
    whole first day in. A decimal baseline (`540.5`) stops v1. The port reads the number. In the list
    with names, equal first name and surname merge and the greater REFNO shows.
  - CE lacks: Implementing Partner (NULL). The hand-kept `tb_edits` baselines. The test date is the
    RTRTD result text read as a date. MOHFacilityCode is the HMIS code.
- **DBS monitoring (VL and EID).**
  - Kept: a Result of `REJECTED` also gets the reason join, so two reasons give two rows. The text
    list is v1's fourth variant. Unclear rows are not excluded by valid rows. EID Result has no
    Invalid class. A specimen with a NULL or blank type shows Unrecorded. A request with no
    specimen shows Other.
  - Parameter: a blank province means Lusaka, Southern, Eastern, Western and North-Western, v1's
    constant. A province given replaces the list.
  - CE lacks: rejected statuses Y and Z. The 16 v1 rows with a NULL type code (of 3.6 million) show
    Unrecorded where v1 shows Other.
- **CD4 by area, age and sex.**
  - Kept: absolute and percent rows join many to many. A request with CD4 and CD4L results counts in
    both. A report with no status test counts. The month is local. v1's
    labels keep their capitals.
  - Differs: `1,000`, `1E5` are read as numbers, where v1 stops. The window is `from` and `to`.
- **HPV results by month.**
  - Kept: the final joins omit the lab type, so a facility with three lab types gives 3 x 3 = 9 rows
    and positives of another lab type show on a row. Zambia may want this repaired (one line;
    `QUESTIONS-FOR-ZM.md` asks).
    A district, facility or lab with no value never meets its positives.
  - Differs: HPVOT joins on the month, where v1 joins the month to the year and always gets 0.
- **Culture and susceptibility results.**
  - Kept: a drug off the 54-name list has no column but still makes a row. MAX(ASTValue) in SQL
    Server text order. Specimen splits pivot rows. The final DISTINCT merges equal output rows.
  - CE lacks: Methodology, LocationCode, Gram Results (NULL). HOSPID. The AST row is a result with an
    S, I or R flag. The organism link is cdr-toolchain's rule re-run on the OBR set. The `laboratory`
    pick list has the four v1 procedures by name.
- **HIV drug resistance.**
  - Kept: no status filter. A drug off the 26 names is dropped but its request stays. Two results
    for one drug show the larger text.
  - Differs: v1 has no window. `from` and `to` are optional and use the registered date.
- **Pathogen panel results (NMPDP).**
  - Kept: the left join to results acts as an inner join, so a request with no result is out.
    PathogenTestRequests is 1 on every row. IsolateCount is 1, 0 or NULL. `Remarks` is out.
  - CE lacks: FirstPrinted (NULL). TestingStatus is the stock OpenLDRDict text for F (`Final results;
    results stored and verified. Can only be changed with a corrected result.`). Zambia should confirm
    its row.
- **Public health surveillance results (PHSIMS).**
  - Kept: an inner join to results. A blank lab code stays. A result with no value is a row with an
    empty Result.
  - CE lacks: CDRTimeStamp, SourceLIMSTimeStamp, LOINCPanelCode, LOINCCode and FirstPrinted (NULL).
    `ingest_events.recorded_at` is not what v1's stamp means, so it is not used. The MFL code is the
    mapped register row's, shown even where v1's MFL table lists no DISA code for it.

### COVID-19

- **COVID-19 by testing lab, positive patients, by source facility.**
  - Kept: the window ends at midnight of the end date, except that the positive patients list adds a
    day. A facility missing from the dictionary counts as Registered only. `show` `tested` means
    tested and positive, as v1's `sp_COV2_TSources`. The positive patients Result column is always
    `Positive`. It lists one row per positive result row.
  - Differs: `laboratory` is a Lab Description (UTH, TDRC and so on), as in v1. Entering `ZUA` finds
    nothing.
  - CE lacks: Lab Number (HOSPID). The testing lab comes from the push (see "Names and codes").
- **COVID-19 daily line list.**
  - Kept: the result CASE has no ELSE. The accented `Ínconclusive` stays. Several answers to one symptom
    multiply rows. The standard version has no facility or status filter. Disalab Number is the patient
    row's request id. Positivity counts result rows. Rate and average are cut.
  - Differs: `version` standard or Levy switches Levy's four differences together. `from` and `to` are
    `YYYY-MM-DDTHH:MM`, the 04:00 to 04:00 window.
  - CE lacks: Lab Number, and the work phone (CE keeps one phone).
- **COVID-19 daily positivity.** Run it with `from` 2021-01-01 to match v1's series. The `to` is a
  whole day. A report with no performer is dropped from the series. A blank performer is counted.
- **COVID-19 results with location, with facility location, VRDSS, VRDSS V2.**
  - Kept: ages 50 to 54 are `45-49`. A left join to results with no observation filter. No ELSE in
    the result CASE. DISTINCT merges rows. Requests with no patient are dropped.
  - Differs: the window is optional and uses the authorised date.
  - CE lacks: about 15 request columns (NULL). FacilityLocation is a guess, `facility, district,
    province`. HMISCode is the HMIS code. Request attributes that v1 holds as dates or numbers print
    as text. A v1 client with sex `I` shows a blank Gender.
- **Wastewater results.**
  - Kept: the five CTEs join on request id without the OBR set, so repeated values multiply rows. The
    site text is cut at `~` as v1 cuts it.
  - Differs: the window uses the collection date. The lab is the testing lab only, so a sample received
    at one lab and tested at another is missing.

### Lab operations

- **VL lab performance, EID lab performance, TB lab performance.**
  - Kept: VL and TB join `b LEFT JOIN a`, EID joins `a LEFT JOIN b`. EID counts ZUA tests in the ZUE
    row. TB reads all tests, whatever their date, for every aggregate except the request counts. A
    constant lab name follows the test lab.
  - Differs: a request with no report has no lab and is dropped, and a request with two reports
    counts once per report. cdr sends one report for every OBR, so with cdr data nothing is lost.
  - CE lacks: Referrals (NULL).
- **Days since last transmission.** Kept: v1's own definition, the age of the latest registration or of
  the latest authorised DISA Link request. `from` is v1's 2019 floor and is strict. Part b is empty
  until cdr sends the pre-registration facts.
- **Suspect collection dates.** Kept: more than 90 days, counted in local dates. The window ends at `to`
  00:00:00. DISTINCT merges spellings.
- **DISA Link weekly stats.** Kept: the whole `to` day. The old-request columns are NULL when nothing
  qualifies. Differs: two codes with one description add up. Empty until cdr sends the pre-registration
  facts.
- **VL and EID weekly stats.** Kept: every count keeps its own v1 definition, gaps included. Suppressed
  counts any non-empty coded value. LabTAT cuts toward zero. Differs: `999.5` is read as a number.
- **Tests authorised by lab and type.** Kept: request rows are counted. The summary has 16 type columns.
  CE lacks: FacilityCode (NULL, v1 holds the DISA code of the lab's host facility).
- **VL throughput by lab and month.** Kept: the month-only Tested match. `year` replaces v1's 2019.
- **Rejections by facility and reason, VL rejections by facility (total), VL rejections by lab.**
  - Kept: a reason column needs a facility code and a bucket date, else it shows 0. NULL request ids
    are not counted. Week numbers can be partial. VIRAL is in the period query but not the total or
    the lab query.
  - Differs: `test_type` VL switches the panels and the bucket date together. Windows are optional
    and use the bucket date.
- **Date completeness (six queries).** Kept: `count(RequestID)` counts rows. Two facilities with one
  name are one row. NULL names are one row.
  - Differs: a group with no request number gives Requests 0 and NULL rates, where v1 stops with a
    division by zero. The window is `coalesce(collection, received, registered)`. LabName equals
    LabFacility until Zambia sends its lab list.
- **Turnaround times (three queries).** Kept: each step is an average of integer day counts, cut toward
  zero. An unfinished step runs to today. Dates running backwards give negative steps. The province
  view for all requests keeps rejected requests. Week is the US week.
  - CE lacks: the receiving lab. A blank DISA testing code is credited to the pushing lab. v1's VL views
    use the receiving lab, while its all-requests and EID lab views inner-join `LabList` on the testing
    code and leave such a request out. So those CE counts can be higher.
- **Requests received by week, and its VLEID copy.** Kept: Total is not PCR plus VL plus Other. The part
  counts ignore the floor and the window. They match year, month and week. `from` of the first query
  is v1's 2018-05-31 floor and is strict. Counts are distinct request numbers.
  - CE lacks: labs with no requests (V's right join). A request with no report.

## Data CE lacks, by query

| Query | Empty or NULL column, or reduced meaning |
|---|---|
| VL dashboards, trend, VL tests on GeneXpert, Unique VL clients | Pregnant, BreastFeeding, BaselineVL, ThreeMPostUnSuppressed read the VIRAL form text. They are 0 or NULL when no form arrived or its text is not on the yes list. Referral is NULL. Disalink is 0. |
| Client by ART number, VL results for a facility's clients, Earlier VL results of high-VL clients, VL results history by client, Unique VL clients | HOSPID is not sent. |
| EID clients by province | HealthcareNo, HOSPID. |
| EID results | ProvinceID, DistrictCode. |
| Recency tests (three) | Implementing Partner. The `tb_edits` baselines. |
| DBS monitoring, EID clients by province | Rejected statuses Y and Z. |
| Culture and susceptibility results | Methodology, LocationCode, Gram Results, HOSPID. |
| PHSIMS | CDRTimeStamp, SourceLIMSTimeStamp, LOINCPanelCode, LOINCCode, FirstPrinted. |
| NMPDP | FirstPrinted. |
| COVID-19 positive patients, COVID-19 daily line list | Lab Number. Contact number has one phone only. |
| COVID-19 extracts and VRDSS feeds | About 15 request columns. FacilityLocation is a guess. |
| VL, EID and TB lab performance | Referrals. |
| Days since last transmission, DISA Link weekly stats | The pre-registration facts. |
| Tests authorised by lab and type | FacilityCode. |
| All queries by testing lab | ReceivingFacilityCode. A lab dictionary. |

## Source

`corlix/fixtures/Zambia_views/script.sql`, UTF-16, database `OpenLDRReporting`. Read it with
`iconv -f UTF-16 -t UTF-8`. Slice 1's report is the procedure `sp_SPHO_hivvl_clients_month`. Its
siblings differ only in province name and date window. The ART number is in
`sp_GetPreviousVLResultforCohort2x`. The script reads `FacilityList`, `LabList` and `tb_edits`
without defining them. It also calls functions of `OpenLDRDict` that Zambia has not sent.

## HONEST NON-PROOF

What this pack has not shown:

- **Parity with v1 on real data.** No Zambia result data is on this machine. Every one of the 12,908
  checks runs made-up cases in real Postgres, with expected rows worked out by hand from the v1
  text. They prove the SQL against those cases. They do not prove CE and v1 agree on real DISA data.
- **What was run on SQL Server.** For "Turnaround times" and "Requests received by week", the v1 view
  text ran read-only on a local SQL Server over the fixture rows and gave the same rows. Many
  expressions were probed there (casts, rates, ISNUMERIC, LIKE, text order, datetime windows).
  No full procedure was compared on real data.
- **The patient ID sources.** `REFNO` is `RefNos` and `UNIQUEID` is `UniqueID` by name and value
  shape, not by observation.
- **v1's Patients key.** Several queries assume `Patients` holds one row per request number.
  Tanzania's v1 has no `Patients` table to check.
- **Facility names and codes.** The master facility list names were never compared with Zambia's
  dictionary. The lab-to-facility link of "Days since last transmission" part b is our assumption.
- **ASTValue.** It is read as the S, I or R flag. v1's `ASTResults` table is not in the script.
- **Zambia's collation** is assumed to be Tanzania's `Latin1_General_CI_AS`.
- **Speed.** Nothing was timed on a large warehouse. The dev warehouse is empty. "Unique VL clients"
  and the rank mode of `tndCte` read every VL and RTRI request of all time.
- **Zambia's DISA*Lab layout.** It is unmeasured (`config/zambia.yaml`). Until `cdr probe-review`
  runs, `result_status` and `authorised_at` stay null. cdr-toolchain then sends report status
  `unknown`. Most reports need a final status or an authorised date, so they are empty on real data
  until Zambia's DISA*Lab is measured.
- **The "today" and week rules** rest on SQL Server's documented behaviour and the Lusaka time zone
  (UTC+2), not on Zambia's server settings.
- **Checks that read the clock.** The "today" and ceiling checks of "Unique VL clients, 12-month rates"
  read the clock when they start. One can fail once if a run crosses midnight in Lusaka. Run it again.
  The "today" check also uses two far-off time zones. On the old code its east case fails from 12:00
  and its west case before 14:00 in Lusaka, so one run shows only one of them.

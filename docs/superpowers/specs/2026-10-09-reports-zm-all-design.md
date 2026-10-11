# reports-zm: the rest of Zambia's reports

Date: 2026-10-09. Status: approved by delegation (the operator asked to "do the Zambia inventory, keep
going till you are done with the pack" and to stop only for something destructive or urgent).
Every design decision below is recorded as a ruling with its cost if wrong.

## Problem

Slice 1 (reports-zm 0.1.0, published 2026-10-09) ported one of Zambia's reports: "VL clients by
province". The inventory (`packs/reports-zm/INVENTORY.md`) classifies all 181 objects of Zambia's v1
reporting database: 57 reports to port, 52 copies that merge into them, 41 helpers, 1 blocked, 30
dropped. This spec ports the other 56 reports, and the second result set of one of them, so a Zambia
lab running CE has every report v1 gave it.

## Rulings

Each ruling: what was decided, why, what it costs if wrong.

1. **Output parity is the default.** A query returns v1's columns, in v1's order and names, and the
   same rows and values for the same data and window. Where v1 behaves oddly but runs and returns real
   data (ages 50 to 54 labelled `45-49` by `Agegroup`; `vVLRequestsTestsByMonth` matching tests on
   month only, not year; `sp_dash_getTBLabStats` with no date filter on one aggregate), the port keeps
   it and the README lists it. Why: the operator's rule is "the output must match", and Zambia will
   check CE against v1 side by side. Cost if wrong: a few known v1 defects carry into CE until Zambia
   asks for the fix, which is one line each.
2. **Where v1 cannot run or cannot produce real output, port the evident intent.** Examples:
   `vSuppressionByFacility` selects columns its source does not have; `vVLQuarterlyFacilitySuppressionRate`
   tests labels its source never produces, so its rate is always 100%. Each case is listed. Cost if
   wrong: a report that differs from a v1 report nobody could have used.
3. **Fixed windows become parameters.** `getdate()`-relative windows (last month, last quarter, last
   12 full months, last 7 days, yesterday 04:00 to today 04:00, last 1,095 days) and hard-coded floors
   (2018-05-31, 2019-01-01, 2020-01-01, 2021-01-01, 2023-10-01) become `from`/`to` parameters. For
   the window v1 computed, the output matches. Dates compare as text, as in slice 1:
   `>= from` and `<= to || 'T23:59:59.999Z'`, unless the v1 window has a time of day (the COVID day
   line list: `from`/`to` take a full `YYYY-MM-DDTHH:MM`). Cost if wrong: users type the window v1
   used to compute.
4. **Province, district, facility, laboratory parameters.** Province and district are `select`
   parameters filled by `optionsSql` from the ZMFAC register (as slice 1). Facility is a text box
   matched on the register name, as v1 matches `Facilities.Description`. Laboratory is a text box
   matched on the testing lab code (`diagnostic_reports.performer`), because CE has no Zambia lab
   register. A blank optional parameter means "all". Cost if wrong: a select list for facilities can
   replace the text box later.
5. **Zambia's copy tables are rebuilt as shared SQL, never stored.** One builder per copy table in
   `packs/reports-zm/zm-sql.mjs`, each a CTE text function, each ported from the procedure that fills
   the table and each tested on its own: `hivvl` (`sp_update_HIVVLTable`), `tnd` (slice 1's part 1),
   `eid` (`sp_update_EIDTable`), `tbgnx` (`sp_getTBsLastHour` over `v_GeneXpert`), `recency`
   (`sp_getTestLevelRecency_CIDRZ`, `sp_recency_surveillance`), `vleidrequests`
   (`sp_UpdateVLEIDRequests`). A builder takes the date range so it reads only what the report needs.
   Cost if wrong: none for output; a builder bug shows in every query that uses it, which is why each
   builder gets its own check suite.
6. **Zambia's VIRAL questionnaire comes from forms.** cdr-toolchain sends Zambia's VIRAL panel as a
   form (`config/zambia.yaml`), so CE stores the answers in `questionnaire_responses` (form
   `hiv_vl_documentation`, `based_on_id` = the request, `items` = JSON `{linkId, answer:[{valueString}]}`).
   A helper reads an answer by observation code. The form keeps the reported text, not the coded
   value; v1's `isPregnant` and `isBreastFeeding` read the coded value (`[YES]`, `Y`, `NA`, `U`). The
   port maps the text with the same rules and lists the difference. Cost if wrong: pregnant and
   breastfeeding flags differ where the text and the code disagree.
7. **Data CE does not hold stays as an empty column under v1's name**, and the query's README entry
   lists it, as `vl-reports-mz` does: `ReceivingFacilityCode` (so `Referral`), `ReferringRequestID`,
   `FirstPrinted`, `HealthcareNo`, `HOSPID`, Implementing Partner, the `tb_edits` patch values, v1
   load stamps. The pre-registration facts (`LIMSPreReg_*`, DISA Link) have CE attribute codes that
   cdr-toolchain does not fill yet; the queries read the attributes, so they work once filled. Cost if
   wrong: those columns stay empty until the data arrives, which the README says.
8. **Laboratory names come from CE, not v1's `Laboratories`.** v1 joins `OpenLDRDict.Laboratories`
   for lab names. CE has the testing lab's code (`diagnostic_reports.performer`) and display
   (`performer_display`). The port shows the display, else the mapped register name, else the code.
   `Equip_TestingLabs` stays blocked. Cost if wrong: lab names read differently until Zambia sends its
   dictionary (QUESTIONS-FOR-ZM.md question 1).
9. **Every report is a custom query.** The dashboard procedures (`sp_dash_*`) are ported as queries
   too; CE's dashboards can chart them later. `sp_dash_getHIVVL_v2_List` returns two result sets, so it
   becomes two queries. Cost if wrong: none; a query can be dropped.
10. **Merges become parameters** exactly as the inventory's Merge table says (province, level,
    test type, laboratory, show-facilities, pregnant-only, grain). Cost if wrong: a merged copy whose
    difference was missed shows as a parity failure in the check or in Zambia's comparison.
11. **Query names are plain English**, for example "VL dashboard summary". README maps each query to
    the v1 objects it replaces.
12. **Patient names and IDs appear where v1 shows them**, to whoever may run custom queries, as in
    slice 1.
13. **Check isolation.** The shared runner gains suite groups; each group runs in its own transaction
    so one area's fixture rows never reach another area's aggregates. `vl-reports-mz` keeps using
    `runSuites` unchanged.
14. **Code layout.** `zm-sql.mjs` holds shared helpers and builders. Queries live in
    `packs/reports-zm/queries/<area>.mjs` (vl, eid, tb, tests, covid, lab-ops). Their check suites
    live in `packs/reports-zm/checks/<area>.mjs`; `check-reports-zm.mjs` runs every group. Slice 1's
    `zm-queries.mjs` keeps the province query; the build collects every area's queries.
15. **One release at the end: reports-zm 0.1.1.** Patch numbering, as the operator set for packs.

## The queries

`v1 target` is the object whose output the query reproduces; `merges` are folded in as parameters.

| Area | Query | v1 target | Merges |
|---|---|---|---|
| vl | VL dashboard summary | sp_dash_getHIVVL_v2 | sp_dash_getHIVVL, vSuppressionByFacility, vVLQuarterlyFacilitySuppressionRate |
| vl | VL dashboard by sex and age (two queries) | sp_dash_getHIVVL_v2_List | |
| vl | VL monthly trend | sp_dash_getMonthlyVLTrend | |
| vl | Client by ART number | sp_GetDetailsFromARTNumber | |
| vl | VL results for a facility's clients | sp_getFacilityVLClientDetails | |
| vl | Earlier VL results of high-VL clients | sp_GetPreviousVLResultforCohort | |
| vl | VL results history by client | sp_GetPreviousVLResultforCohort2 | sp_GetPreviousVLResultforCohort2_Prega |
| vl | VL testing summary by area | sp_getSummaryTestEpiData | sp_getSummaryTestEpiDataDistrict, sp_getSummaryTestEpiDataFacility |
| vl | Unique VL clients | sp_getUniqueVLClientsInfo | sp_getUniqueVLClientsInfoList, sp_getUniqueVLClientsInfo_bkup, sp_getUniqueVLClientsLast12Months_SPHO_WPHO |
| vl | Unique VL clients, 12-month rates | sp_getUniqueVLClientsInfoLast1Year | |
| vl | VL requests and tests by lab and month | vVLRequestsTestsByMonth | |
| vl | VL result bands by month | vVLResRangeBreakDownByMonth | |
| eid | EID dashboard summary | sp_dash_getEID_V2 | sp_dash_getEID |
| eid | EID dashboard by facility, sex and age | sp_dash_getEID_v2_List | |
| eid | EID monthly trend | sp_dash_getMonthlyEIDTrend | |
| eid | EID testing summary by area | sp_getSummaryTestEpiDataEID | sp_getSummaryTestEpiDataEIDDistrict, sp_getSummaryTestEpiDataEIDFacility |
| eid | EID clients by province | sp_SPHO_eid_clients_month | |
| eid | EID results | fn_getEIDs | vPCR, vPCRInfo |
| eid | EID tests on GeneXpert | v_GxEIDTests | |
| tb | TB GeneXpert dashboard summary | sp_dash_getTBGNX | |
| tb | TB GeneXpert by facility, sex and age | sp_dash_getTBGNX_List | |
| tb | TB GeneXpert monthly trend | sp_dash_getMonthlyTBTrend | |
| tb | TB GeneXpert report | fn_GeneXpertReport | |
| tb | VL tests on GeneXpert | v_GxVLTests | |
| tests | Recency tests | get_Test_level_Recency | |
| tests | Recency surveillance counts | get_Test_level_Recency_Surveillance | |
| tests | Recency tests with client names | get_Test_level_Recency_ZNPHI | |
| tests | DBS monitoring (VL and EID) | sp_CIDRZ_DBS_Monitoring | |
| tests | CD4 by area, age and sex | sp_get_CDC_CD4_data_month | |
| tests | HPV results by month | sp_get_HPV_data | |
| tests | Culture and susceptibility results | sp_Levy_ast_data_month | sp_LStone_ast_data_month, sp_Ndola_ast_data_month, sp_UTH_ast_data_month |
| tests | HIV drug resistance | v_HIVDR | |
| tests | Pathogen panel results (NMPDP) | v_NMPDP | |
| tests | Public health surveillance results (PHSIMS) | v_PHSIMS | |
| covid | COVID-19 by testing lab | sp_COV2_LabStats | |
| covid | COVID-19 positive patients | sp_COV2_PListing | |
| covid | COVID-19 by source facility | sp_COV2_SourceStats | sp_COV2_PSources, sp_COV2_TSources |
| covid | COVID-19 daily line list | sp_cov_getDayLineList | sp_cov_getDayLineList_Levy |
| covid | COVID-19 daily positivity | sp_dash_covid_7d_moving_avg | |
| covid | COVID-19 results with location | vw_Covid19_PD | vw_Covid19 |
| covid | COVID-19 results (VRDSS) | v_vrdss_Covid | v_vrdss_Covid_V2 |
| covid | Wastewater results | WasteWaterData | WastewaterDataCHAZ |
| lab-ops | VL lab performance | sp_dash_getLabStats | |
| lab-ops | EID lab performance | sp_dash_getLabStatsEID | |
| lab-ops | TB lab performance | sp_dash_getTBLabStats | |
| lab-ops | Days since last transmission | sp_DQ_DaysSinceLastVLEIDTans | |
| lab-ops | Suspect collection dates | sp_DQ_VLEIDSuspectedWrongSampleCollectionDateEntries | |
| lab-ops | DISA Link weekly stats | sp_getDisaLinkStats | |
| lab-ops | VL and EID weekly stats | sp_getVLEIDstats | |
| lab-ops | Tests authorised by lab and type | sp_LabTestingSummary | |
| lab-ops | VL throughput by lab and month | sp_LabThroughputTrendbyYear | |
| lab-ops | Rejections by facility and reason | vAllSampleRejectionsByFacility | vEIDSampleRejectionsByFacility, vVLSampleRejectionsByFacility, vVLTotalRejectionsByFacility |
| lab-ops | Date completeness | vDatesCompletionRatesByFacility | vDatesCompletionRatesByDistrict, vDatesCompletionRatesByProvince, vDatesCompletionRatesByFacilityEID, vDatesCompletionRatesByFacilityVL, vDatesCompletionRatesByLab, vDatesCompletionRatesByLabArea, vDatesCompletionRatesByLabEID, vDatesCompletionRatesByLabVL |
| lab-ops | Turnaround times | vTATLab | vTATEIDLab, vTATEIDProvince, vTATProvince, vTATVLoadLab, vTATVLoadLabMonth, vTATVLoadProvince |
| lab-ops | VL rejections by lab | vVLSpecimenRejections | |
| lab-ops | Requests received by week | vWeeklyRequestTrend | vReceivedRequestsSummary |

## How each query is built and tested

For each query, the implementer:

1. Reads the v1 target and every merge (`.superpowers/sdd/<plan>/v1/`), its inventory row, and the
   copy-table builders it needs.
2. Writes the check suite first: made-up warehouse rows, and the exact rows v1's logic would return for
   them, worked out from the v1 text (with line references in comments). Cases cover each branch,
   each merge parameter, the date edges and the parity quirks the query keeps.
3. Writes the query until the suite passes.
4. Passes the banned-word and `--` scan.

A reviewer then checks the query against the v1 text, not against the implementer's report.

## Delivery

- `packs/reports-zm/zm-sql.mjs`, `queries/*.mjs`, `checks/*.mjs`; `packs/shared/pg-check.mjs` (suite
  groups); `build.mjs` (all queries); `PACK.md`, `README.md` (query list, v1 mapping, differences,
  data CE lacks, HONEST NON-PROOF); `QUESTIONS-FOR-ZM.md` (add: the `MFL` table's `DisaLCode1`-`4`
  columns, which map DISA facility codes to MFL codes; `FacilityList`, `LabList`, `tb_edits`, which the
  script reads but does not define).
- Pack version 0.1.1. Built, checked, signed and installed on the dev CE. Merge, publish and push wait
  for the operator.

## HONEST NON-PROOF

- No Zambia result data: every check runs on made-up rows.
- Zambia's DISA is unmeasured, so reports that need a final status or a result date are empty on real
  Zambia data until it is.
- The VIRAL form answers carry text, not codes (ruling 6).
- Lab names and the facility mapping wait on Zambia's dictionary.

## Out of scope

- The 30 dropped objects and `Equip_TestingLabs`.
- Fixing v1 defects that produce real output (ruling 1).
- Charts or dashboards for the dashboard queries.

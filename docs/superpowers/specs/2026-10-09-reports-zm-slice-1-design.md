# reports-zm slice 1: Zambia facility register, VL clients by province, ART number

Date: 2026-10-09. Status: approved 2026-10-09.

## Problem

Zambia sent the script of its v1 reporting database on 2026-10-09:
`corlix/fixtures/Zambia_views/script.sql` (UTF-16, 17,730 lines, database `OpenLDRReporting`). It holds
55 views, 83 stored procedures, 18 functions and 25 tables. They read v1's `OpenLDRData` (590
references) and `OpenLDRDict` (351 references), the same source shape as Mozambique's views.

Twelve of the procedures produce one report: the list of viral load clients for one province office
over last month or last quarter. They differ only in the province name and the date window:

- monthly: `sp_CBPHO_`, `sp_Central_`, `sp_EPHO_`, `sp_LPHO_`, `sp_Luapula_`, `sp_much_`, `sp_North_`,
  `sp_NWPHO_`, `sp_SPHO_`, `sp_WPHO_hivvl_clients_month`
- quarterly: `sp_EPHO_hivvl_clients_quarter`, `sp_SPHO_hivvl_clients_quarter`

This slice moves that report to OpenLDR CE, with the facility register it needs.

## Decisions taken (operator, 2026-10-09)

- **The goal is output, not script.** A country pack moves the country's v1 views onto CE. The SQL
  may be rewritten and improved as long as the output matches. Copies that differ by a constant
  become one query with a parameter.
- **One Zambia pack, grown in slices.** Pack id `reports-zm`. Later slices add EID, COVID, HPV,
  recency, microbiology, TB and CD4 as new versions of the same pack.
- **The register comes from the MFL CSV now**, not from Zambia's dictionary, which we do not have.
- **The ART number fix is in scope.**
- **Gender, collected date and registered date are always filled** from the request, where v1 leaves
  some blank.

## Scope

1. A facility register built from Zambia's master facility list.
2. One custom query, "VL clients by province", replacing the twelve procedures.
3. cdr-toolchain sends two more patient IDs so the query can build the ART number. CE adds their two
   codes to its request-attribute vocabulary.
4. `packs/reports-zm/QUESTIONS-FOR-ZM.md`, the open questions for the Zambia team.

## 1. The pack and the facility register

- Source: cdr-toolchain `packs/reports-zm/`. Built, signed and published the same way as
  `vl-reports-mz` (`build.mjs` writes `dist/`; `openldr artifact pack`; marketplace repo). Version
  `0.1.0`.
- Input: `corlix/fixtures/Zambia_master_facility_list/mfl_facilities_export20260810155748.csv`
  (UTF-8 with BOM, 3,788 rows, 21 columns, quoted cells). `build.mjs` reads the path from
  `ZM_MFL_CSV`, else that default path.
- Register `urn:openldr:zm:facilities`, code `ZMFAC`, name "Zambia health facilities".

| Register column | From the MFL CSV | Notes |
|---|---|---|
| `national_code` | `MFL Code` | unique, numeric, never blank (3,788 distinct) |
| `name` | `Name` | trimmed |
| `region` | `Province` | 10 values |
| `district` | `District` | 116 values, never blank |
| `status` | `Operational status` | Functional `active` (3,771); Closed and Permanent closure `inactive` (16); Temporarily closure `suspended` (1) |
| `latitude`, `longitude` | `Latitude`, `Longitude` | trimmed; one cell holds a trailing tab |
| extras | `Hims code`, `DHIS2 UID`, `Type`, `Ownership`, `Ownership type`, `Constituency`, `Ward`, `Location` | raw, as `hims_code`, `dhis2_uid`, `type`, `ownership`, `ownership_type`, `constituency`, `ward`, `location`; empty values left out |

- Left out: `Zone`, `Mobility status`, `Accesibility`, and the catchment and household counts. No
  output uses them.
- A blank code, a blank name or a repeated code is left out and named in `build-summary.json`, as in
  `vl-reports-mz`.
- **No link-matching step.** v1 treats DISA facility codes as short letter codes
  (`sp_update_HIVVLTable` tests `isnumeric(left(…,5))=0`). MFL codes are numbers, so matching equal
  codes would link nothing.
- **How a request gets its province.** An admin maps each DISA facility code to its MFL row in CE's
  Facilities screen, which suggests matches by name (`facility-mapping-suggest.ts`). Until a code is
  mapped, its requests are left out of the report. A later version can ship the DISA to MFL mapping
  when Zambia's dictionary arrives.

## 2. The query "VL clients by province"

### Parameters

| id | label | type | required |
|---|---|---|---|
| `province` | Province (blank for all) | `select`, options from `optionsSql` | no |
| `from` | Date from (YYYY-MM-DD) | `text` | yes |
| `to` | Date to (YYYY-MM-DD) | `text` | yes |

`optionsSql` lists the distinct `region` of the warehouse `facility_registry` rows with
`facility_system = 'urn:openldr:zm:facilities'` and `register_state = 'in_register'`, sorted.
A month or a quarter is a date range: v1's "last month" is the month's first and last day.

### Columns, in v1's order

`Province, District, Facility, LabID, Name, AgeInYears, Gender, ARTNumber, CollectedDate,
RegisteredDate, ResultDate, Result, Suppressed`

| Column | CE source |
|---|---|
| Province, District, Facility | the requesting facility's mapped register row: `facility_map` `region`, `district`, `name` (the same join as the Mozambique queries) |
| LabID | `lab_requests.request_id` |
| Name | `firstname || ' ' || surname` from `patients`, NULL parts read as empty (v1 `concat`) |
| AgeInYears | `lab_requests.age_years` |
| Gender | `patients.sex`: F `Female`, M `Male`, U `Unknown`, I `Indeterminate`, else `Missing` |
| ARTNumber | built from the request attributes in section 3 |
| CollectedDate | `diagnostic_reports.effective` |
| RegisteredDate | `lab_requests.authored_at` |
| ResultDate | `diagnostic_reports.issued` |
| Result | per part, below |
| Suppressed | per part, below |

The warehouse stores `patients.sex` as the HL7 letter (dev CE: `F`), so v1's mapping applies as is.

### Rows

Three parts, joined with `UNION` (which removes duplicate rows, as v1's does). Every part keeps only
requests whose requesting facility is mapped to a register row, and, when `province` is set, whose
row's `region` equals it. v1 inner-joins the dictionary, so its unmapped facilities drop out the same way.

**Part 1, valid results** (v1: table `TND`, built by `sp_GetPreviousVLResultforCohort2x`).

- Panel `HIVVL` or `RTRI`; observation `HIVVL`, `HIVVC`, `HIVTM`, `HIVVD`, `POCVR` or `POCVC`.
- Report status final; `ResultDate` in the range.
- The result is not one of the 26 invalid texts:
  `antibodies. @mat3`, `FAIL`, `Haemolysed`, `Haemolysed ++`, `Insufficient for further tests`,
  `Insufficient serum received`, `INV`, `INVAL`, `Negative`, `No`, `Please repeat`, `Positive`,
  `to confirm patient identity.`, `Weak Positive`, `Invalid`, `Absent`, `antibodies.`, `AT`, `Failed`,
  `Icteric ++++`, `Indeterminate`, `per request`, `Positive (Repeat sample)`,
  `This result has been checked`, `VAL`, `@con1 @con2`.
- One row per result, so a request with HIVVL and HIVVC results gives two rows, as in v1.
- `Result` is the reported value (`rpt()` in `vl-reports-mz`: text, else comparator and number,
  else code).
- `Suppressed` is `Yes` when the result is one of the 16 below-limit texts or the number is under
  1000, else `No`. The 16: `<20 copies/mL`, `TAR`, `Target Not Detected`, `TARG`, `< 20`,
  `RNA not detected`, `<30 copies/ml`, `<30 copies/mL`, `NDET`, `ND`, `<20CP`, `< 40`,
  `<40 copies/mL`, `<400 copies/mL`, `<400`, `<883 copies/mL`.

**Part 2, rejected requests.**

- Panel `HIVVL`; report status `cancelled` (v1 `X`); `RegisteredDate` in the range.
- The request is not already in part 1.
- `Result` is `REJECTED`; `Suppressed` is NULL.

**Part 3, unclear results.**

- Panel `HIVVL`; observation `HIVVL`, `HIVVC` or `HIVVD`; report status final; `ResultDate` in the
  range.
- The result is not a number (v1 `ISNUMERIC`; the port reuses `isNumericSql` from
  `vl-reports-mz/vl-queries.mjs`) and is not one of 9 texts: `< 20`, `<30 copies/mL`, `> 10000000`,
  `NDET`, `Target Not Detected`, `RNA Not Detected`, `<400 copies/mL`, `<400`, `<40 copies/mL`.
- The request is not already in part 1.
- `Result` is the reported value; `Suppressed` is NULL.

The three lists differ from each other in v1, and differ again from the lists in other Zambia
procedures. Each part keeps its own list exactly. The lists live in the pack source as constants and
are written into the SQL, as `vl-reports-mz` does with its reason-for-test list. They are Zambia
content, not CE vocabulary (AGENTS.md section 8). Text comparison follows SQL Server's default
collation: case-insensitive, trailing spaces ignored.

Dates compare as text, as in `vl-reports-mz`: `>= from` and `<= to || 'T23:59:59.999Z'`.

The SQL follows the custom-query rules: one read-only SELECT, no `--` comments, and no banned word
(`merge`, `update`, `into` and the rest of `validateSelectSql`) as an identifier.

### Differences from v1

- **Facility, Province and District names** come from the MFL, not from Zambia's dictionary
  `Facilities.Description` and `HealthcareAreas.HealthcareAreaDesc`. Spellings can differ (for
  example `North-Western`).
- **Rejected means `cancelled` only.** cdr-toolchain maps v1 `X` to `cancelled` and sends `Y` and `Z`
  as `unknown` (`fhir-transform.ts:109-118`), so they cannot be picked out. Listed, not fixed here.
- **Gender, CollectedDate, RegisteredDate are always filled.** v1 part 1 takes them from its `hivvl`
  table, which has a row only when the request also has VIRAL or RTRI data, so v1 shows them blank
  otherwise. Where v1 shows a value, it is the same value.
- **No 2017 floor.** v1's `TND` keeps results from 2017-01-01 only. The date range replaces it.
- **ARTNumber has no HOSPID step** until its DISA source is known (section 3).

## 3. The ART number

v1 builds it in `sp_GetPreviousVLResultforCohort2x` from three `Patients` fields:

1. `REFNO` starting `,ELABS`: the text after `T.`.
2. `REFNO` containing `,ELABS`: the part before `,elabs`, less its first 3 characters.
3. `REFNO` blank after removing `,`, `AT.`, spaces and `-`, and `HOSPID` set: `HOSPID` without spaces
   and `-`.
4. `REFNO` and `HOSPID` both blank: `UNIQUEID` without spaces and `-`.
5. `REFNO` starting `ART.` or `ELABS.` (after removing `,` and `AT.`): `UNIQUEID` without spaces
   and `-`.
6. Otherwise: `REFNO` without `,`, `AT.`, spaces and `-`.

The query ports this rule as written.

### Where the fields come from

CE receives two patient IDs from cdr-toolchain today: `FolderNumber` (as attribute `ordering-notes`;
v1 `OrderingNotes` matched 136 of 136) and `NID`. DISA's `REGDAT4` record also holds:

- `RefNos`, offsets 66-121 (`REGDAT4.ts:108`), a comma-separated list. Zambia's values start
  `,ELABS`, which fits. Taken as v1 `REFNO`.
- `UniqueID`, offsets 32-41 (`REGDAT4.ts:98`). Taken as v1 `UNIQUEID`.

`HOSPID` has no confirmed source. The folder number is already v1's `OrderingNotes`, so it is
probably not `HOSPID`. The export reads no other DISA hospital-number field (`ORDRDAT5.HospitalNo`
and `HISDAT5.HospitalNo` are not used). Until Zambia says, the query treats `HOSPID` as blank: rule 3
never fires, and a request with a blank `REFNO` falls to rule 4 and shows `UNIQUEID`. Where v1 had a
`HOSPID` there, the two differ. The query's comment says so.

### Changes

- **cdr-toolchain.** `config/request-attributes.yaml` gains `reference_numbers: reference-numbers`
  and `unique_id: unique-id`. `request-fact-config.ts` reads them. `v2-transform.ts` sends REGDAT4
  `RefNos` and `UniqueID` as request attributes when set, as it does the folder number. The file is
  shared by every deployment, so Tanzania and Mozambique send them too. Both are DISA fields there as
  well.
- **CE.** `packages/terminology/codesystems/openldr-request-attribute.json` gains the concepts
  `reference-numbers` ("Reference numbers") and `unique-id` ("Unique ID"). CE stores any code it
  receives (`service-request.ts:40-84`), so ingestion works without this; the vocabulary stays true
  with it. The plan checks how an existing install picks up new concepts.

Both IDs are patient identifiers, like the names CE already holds. The report shows them, as v1's
does, to whoever can run custom queries.

## Precondition: Zambia's DISA is not measured

`config/zambia.yaml` marks Zambia "UNMEASURED": until `cdr probe-review` runs against Zambia's
DISA*Lab and v1, `result_status` and `authorised_at` stay null for Zambia data. Parts 1 and 3 filter
on final status and `ResultDate`, so on unmeasured Zambia data they return almost nothing. This slice
does not measure Zambia. The pack works once that data is measured and exported.

## Testing

- **Pack.** `packs/reports-zm/check-reports-zm.mjs`, like `check-vl-functions.mjs`: runs the query
  in the CE dev Postgres on temp copies of the warehouse tables, rolled back. Cases cover each part,
  each list, the ART number rule (each of its branches), the province filter (set, blank, unmapped
  facility), the date edges, and the UNION across parts (a request in part 1 is not repeated in
  parts 2 or 3).
- **Build.** Row counts and left-out rows printed and written to `build-summary.json`.
- **cdr-toolchain.** Unit tests for the config keys and the two attributes in `v2-transform`.
- **CE.** The code system file change; the existing terminology tests.
- **Live.** Install on the dev CE; run the query in the studio. The dev warehouse is empty, so this
  proves install and parse only.

## Delivery

| Repo | Files |
|---|---|
| cdr-toolchain | `packs/reports-zm/` (`build.mjs`, `zm-queries.mjs`, `check-reports-zm.mjs`, `PACK.md`, `README.md`, `QUESTIONS-FOR-ZM.md`, `.gitignore`); `config/request-attributes.yaml`; `apps/cli/src/config/request-fact-config.ts`; `apps/cli/src/export/v2-transform.ts` and tests |
| openldr_ce | `packages/terminology/codesystems/openldr-request-attribute.json`; changelog if the change is a `feat` or `fix` |
| marketplace | `bundles/reports-zm-0.1.0`, `index.json` entry |

`QUESTIONS-FOR-ZM.md` asks for:

1. A backup of their `OpenLDRDict` (at least `Facilities`, `HealthcareAreas`, `Laboratories`), to map
   DISA facility codes to MFL rows and to check province spellings.
2. A small result sample: a few hundred VL requests, as DISA*Lab and as v1 `OpenLDRData` for the same
   requests, so `cdr probe-review` can measure Zambia's DISA and the report can be compared with v1's.
3. Which DISA field fills v1 `Patients.HOSPID` (and confirm `REFNO` is `RefNos`, `UNIQUEID` is
   `UniqueID`).
4. What v1 result status `Y` and `Z` mean, and whether they count as rejected.
5. Which of the 55 views and 83 procedures are still used, to order the next slices.

## HONEST NON-PROOF

- **Parity with v1 on real data.** No Zambia result data is on this machine.
- **The patient ID sources.** `REFNO` = `RefNos` and `UNIQUEID` = `UniqueID` are inferred from names
  and value shapes, not observed. Tanzania's v1 has no `Patients` table to compare.
- **Facility names.** MFL names were never compared with Zambia's dictionary names.
- **Zambia's DISA layout.** Unmeasured (precondition above).

## Out of scope

- The other 53 views and 71 procedures (later slices).
- Procedures that write (`sp_update_*`, `sp_Remove*`, `sp_BackupDatabases`) and the helpdesk tables.
- Measuring Zambia's DISA (`cdr probe-review`).
- Mapping v1 status `Y` and `Z`.
- Shipping a DISA to MFL facility mapping.

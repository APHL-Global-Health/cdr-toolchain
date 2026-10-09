# reports-zm pack

A content pack for OpenLDR CE. It installs Zambia's health facility register and one custom query,
"VL clients by province". The query replaces Zambia's 12 v1 procedures `sp_<province>_hivvl_clients_month`
(ten provinces) and `sp_<province>_hivvl_clients_quarter` (two). Later versions add more of Zambia's
reports. This is the source of the pack. The signed bundle is built from it.

## Files

| File | What it is |
|---|---|
| `build.mjs` | Reads Zambia's master facility list (a CSV) and writes `dist/`. It needs no database. |
| `zm-queries.mjs` | The SQL of "VL clients by province", the three text lists, the ART number rule and the province picker. |
| `check-reports-zm.mjs` | Runs the ART number rule and the query against the dev Postgres over a table of cases. 33 checks. Run it by hand before a release. |
| `QUESTIONS-FOR-ZM.md` | Open questions for the Zambia team. |
| `PACK.md` | The text an admin reads in the marketplace before installing. It becomes the manifest readme. |
| `.gitignore` | Keeps `dist/` out of git. |
| `../shared/pg-check.mjs` | The runner `check-reports-zm.mjs` shares with the Mozambique pack. |
| `../shared/pack-build.mjs` | The CSV writer and step summary `build.mjs` shares with the Mozambique pack. |

`build.mjs` writes these to `dist/`:

| File | What it is |
|---|---|
| `pack.json` | The pack payload: `{ formatVersion: 1, steps }`. |
| `manifest.json` | The unsigned artifact manifest. |
| `build-summary.json` | Row counts, and every row or value left out with the reason. |

## Build

    node packs/reports-zm/build.mjs

It reads the CSV at `ZM_MFL_CSV`, or else the corlix fixture
`Zambia_master_facility_list/mfl_facilities_export20260810155748.csv`. It copies `PACK.md` into the
manifest readme and appends the list of rows and values it left out. An unknown operational status
stops the build.

## Check

    node packs/reports-zm/check-reports-zm.mjs

It runs 33 checks: 15 ART number cases, 1 province picker case, and the full query twice (9 checks
for all provinces, 8 for Southern only). It runs in the CE dev Postgres container on temporary
copies of the warehouse tables and rolls back, so it reads no warehouse rows. It exits 1 on any
mismatch.

## Sign and publish

Pack and sign the build output with the publisher key:

    openldr artifact pack packs/reports-zm/dist --key <publisher key>

`artifact pack` fills `publisher.keyFingerprint` and the payload hash, then signs the manifest.
Publish the signed bundle:

    openldr artifact publish <bundle dir>

The private key never enters a repo. Keep it outside every working tree. Never commit `dist/`.

## Steps, in install order

1. `facility-register` `urn:openldr:zm:facilities`, code `ZMFAC`, name "Zambia health facilities".
2. `custom-queries`: "VL clients by province".

There is no link-matching step. DISA*Lab facility codes are short letter codes (v1's
`sp_update_HIVVLTable` tests `isnumeric(left(...,5)) = 0`). MFL codes are numbers. Matching equal
codes would link nothing. An admin maps each DISA*Lab code to its register row in CE's Facilities
screen, which suggests matches by name. Until a code is mapped, its requests are left out of the
report. A later version can ship the mapping once Zambia sends its dictionary.

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
- CE drops a row's coordinates unless both are valid, so the build keeps both or neither. It left
  them out on 12 rows because the pair is not valid (for example a longitude of `29580210`).
  98 rows have none. `build-summary.json` names the 12.
- Left out of the register: `Zone`, `Mobility status`, `Accesibility`, and the catchment and
  household counts. No output uses them.
- A blank code, a blank name or a repeated code is left out and named in `build-summary.json`.
- Result from the 2026-08-10 export: 3,788 rows, none left out. 3,771 are active, 16 inactive and
  1 suspended.

## The query

"VL clients by province" takes three parameters.

- `province`: optional. A select, filled by `provinceOptionsSql`: the distinct `region` of the
  `in_register` rows of `urn:openldr:zm:facilities` in `facility_registry`. Blank means all.
- `from`, `to`: required. Dates as `YYYY-MM-DD`. A month or a quarter is a range.

Dates compare as text, as in `vl-reports-mz`: `>= from` and `<= to || 'T23:59:59.999Z'`. A request
near midnight at a UTC offset can fall on the other side of `from` or `to`.

Province, District and Facility come from the register row the requesting facility is mapped to.
Every part keeps only requests with a mapped facility, as v1's inner joins drop facilities missing
from its dictionary. The columns keep v1's order. The rows sort by province, district, facility
and lab ID.

Three parts, joined with `UNION`, which removes duplicate rows as v1's does:

1. `zm_valid` (v1's table `TND`, built by `sp_GetPreviousVLResultforCohort2x`). Panel `HIVVL` or
   `RTRI`. Observation `HIVVL`, `HIVVC`, `HIVTM`, `HIVVD`, `POCVR` or `POCVC` (`ZM_CODES`). Report
   status final and `ResultDate` in range. The result is not in `INVALID_RESULTS` (26 texts). One
   row per result. `Suppressed` is `Yes` when the result is in `SUPPRESSED_RESULTS` (16 texts) or
   the number is under 1000, else `No`.
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

## Where it differs from v1

- **Names.** Province, District and Facility come from the master facility list, not from v1's
  `Facilities.Description` and `HealthcareAreas.HealthcareAreaDesc`. Spellings can differ.
- **Rejected means cancelled only.** cdr-toolchain maps v1 `X` to `cancelled` and sends `Y` and `Z`
  as `unknown` (`fhir-transform.ts:109-118`), so they cannot be picked out. Listed, not fixed. See
  `QUESTIONS-FOR-ZM.md`.
- **Gender, CollectedDate and RegisteredDate are always filled.** v1 part 1 takes them from its
  `hivvl` table, which has a row only when the request also has VIRAL or RTRI data. So v1 shows
  them blank otherwise. Where v1 shows a value, it is the same value.
- **No 2017 floor.** v1's `TND` keeps results from 2017-01-01. The date range replaces it.
- **The ART number has no `HOSPID` step** until its DISA*Lab source is known.
- **ART number per part.** v1 builds it in part 1 only. Parts 2 and 3 show the raw unique ID, and
  so does the port.
- **Blank IDs.** v1 holds `''` for an empty ID. cdr-toolchain sends nothing. Part 1 reads a
  missing one as `''`. Parts 2 and 3 show NULL.
- **v1's `RIGHT` error.** Step 2 returns `''` where v1 raises an error.

## Source

`corlix/fixtures/Zambia_views/script.sql`, UTF-16, database `OpenLDRReporting`. Read it with
`iconv -f UTF-16 -t UTF-8`. The report is the procedure `sp_SPHO_hivvl_clients_month`. Its siblings
differ only in province name and date window. The ART number is in
`sp_GetPreviousVLResultforCohort2x`.

## HONEST NON-PROOF

What this pack has not shown:

- **Parity with v1 on real data.** No Zambia result data is on this machine. The check runs made-up
  cases in real Postgres.
- **The patient ID sources.** `REFNO` is `RefNos` and `UNIQUEID` is `UniqueID` by name and value
  shape, not by observation. Tanzania's v1 has no `Patients` table to compare.
- **Facility names.** The master facility list names were never compared with Zambia's dictionary.
- **Zambia's DISA*Lab layout.** It is unmeasured (`config/zambia.yaml`). Until `cdr probe-review`
  runs, `result_status` and `authorised_at` stay null, and parts 1 and 3 return almost nothing.

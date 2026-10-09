# vl-reports-mz pack

A content pack for OpenLDR CE. It installs two custom queries that port Mozambique's v1 views
`viewVL_Info` and `viewVL_Result`, plus the lab register, the health facility register and three
value sets they need (POC sites, link sites and coded viral load results). A third query
lists the facilities in the layout of v1's `viewFacilities`.
This is the source of the pack. The signed bundle is built from it.

## Files

| File | What it is |
|---|---|
| `build.mjs` | Reads the v1 dictionary `OpenLDRDict_MZ` (SELECT only) and writes `dist/`. |
| `vl-queries.mjs` | The SQL of both queries: "VL info" and "VL results". |
| `facility-queries.mjs` | The SQL of "Mozambique facilities (v1 layout)", v1's `viewFacilities` read from the warehouse table `facility_registry`. |
| `vl-coded-results.mjs` | Picks one description per coded VL result for the coded-results code system. |
| `check-vl-functions.mjs` | Runs the ported v1 functions and both VL queries against the dev Postgres over a table of cases. Run it by hand before a release. |
| `QUESTIONS-FOR-MZ.md` | Open questions for the Mozambique team. |
| `PACK.md` | The text an admin reads in the marketplace before installing. It becomes the manifest readme. |
| `.gitignore` | Keeps `dist/` out of git. |

`build.mjs` writes these to `dist/`:

| File | What it is |
|---|---|
| `pack.json` | The pack payload: `{ formatVersion: 1, steps }`. |
| `manifest.json` | The unsigned artifact manifest. |
| `build-summary.json` | Row counts, and every dictionary row left out with the reason. |

## Build

    node packs/vl-reports-mz/build.mjs

It reads the connection string from `DISA_CONNECTION_STRING`, or else from that line of
`cdr-toolchain/apps/cli/.env`. It needs the `mssql` package. Set `MSSQL_MODULE` if it is not at
the cdr-toolchain path in the script. No password is written to any output file.

## Steps, in install order

1. `code-system` for the POC sites, `urn:openldr:mz:cs:poc-sites`.
2. `value-set` `urn:openldr:mz:poc-sites`.
3. `code-system` for the link sites, `urn:openldr:mz:cs:link-sites`.
4. `value-set` `urn:openldr:mz:link-sites`.
5. `code-system` for the coded VL results, `urn:openldr:mz:cs:vl-coded-results`.
6. `value-set` `urn:openldr:mz:vl-coded-results`. "VL results" reads it.
7. `facility-register` `urn:openldr:mz:laboratories`, code `MZLABS`, with the register CSV.
8. `facility-register` `urn:openldr:mz:facilities`, code `MZFAC`, from `viewFacilities`.
9. `link-matching` against the facility register.
10. `link-matching` against the lab register. Without these two the facility names, provinces
    and districts stay empty in both queries.
11. `custom-queries`: "VL info", "VL results" and "Mozambique facilities (v1 layout)". The
    facilities query reads the warehouse copy of the register, so it needs a CE with the warehouse
    table `facility_registry`. It leaves out retired rows. `DateTimeStamp` is CE's update time.

The order of steps 9 and 10 matters. CE's link-matching (`facility-link-matching.ts`) links every
unmapped observed code that equals a register code, from every observed system, and never
replaces an existing mapping. So the register linked first takes a code both registers share, for
testing labs (`urn:openldr:default_lab`) and requesting facilities (`urn:openldr:default_fac`)
alike. On 2026-10-07 the two registers share 45 codes, and each pair names the same place. The
lab rows for those codes have no province or district, and the facility rows do. So the facility
register links first. A per-system filter in CE would remove the order rule. It is not built.

Link-matching only links codes CE has already seen. On a new install with no results it links
nothing, and the order matters again when someone runs it by hand later.

## Sign and publish

Pack and sign the build output with the publisher key:

    openldr artifact pack packs/vl-reports-mz/dist --key <publisher key>

`artifact pack` fills `publisher.keyFingerprint` and the payload hash, then signs the manifest.
Publish the signed bundle:

    openldr artifact publish <bundle dir>

The private key never enters a repo. Keep it outside every working tree. Never commit `dist/`.

## How the register is built

- `Laboratories`: code `LabCode`, name `LabName`. No province or district in that table.
- `DisaPoc`: code is the first 3 characters of `DisaPocLabNo`. Name `DisaPocName`, `region`
  `DisaPocProvinceName`, `district` `DisapocDistrictName`.
- A POC prefix equal to a lab code: the POC row is kept. v1 prefers the POC for the testing lab.
  Today this is code 211.
- Two POCs with one prefix: the active one (`DisapocState = 1`) is kept. Today this is 124, 127
  and 142. v1's join returns two rows for these labs. CE returns one.
- Left out: 2 POCs with a blank `DisaPocLabNo` and 2 labs with a blank `LabName`.
- Result from the dictionary on 2026-09-30: 311 rows (208 POC, 103 lab), 8 rows left out.
  `build-summary.json` names each one.
- Two lab names read "Autopsia Laborat¢rio Maputo" (codes PAA and PPP). The dictionary stores
  byte `0xA2` in a CP1252 column. That byte is `ó` in DOS code page 850, so the name was typed
  under CP850. The build reads it correctly and does not change it. `viewFacilities` has one
  more: REALF "Priv. Fam¡lia Real" (`0xA1`, `í` in CP850).

## How the facility register is built

- One row per `viewFacilities` row. Code `FacilityCode` (the DISA code, not the MISAU national
  code), name `Description`, `region` `ProvinceName`, `district` `DistrictName`.
- `ProvinceCode`, `DistrictCode`, `FacilityType`, `HFStatus` and `FacilityNationalCode` go in
  `extras`, as `province_code`, `district_code`, `facility_type`, `hf_status` and
  `facility_national_code`, with v1's raw values. The step
  lists them in `extraColumns`, so CE keeps them and still refuses any other unknown column. The
  headers are lowercase because CE stores `extras` keys in lowercase. This needs a CE with extra
  register columns (0.3.0 onward of this pack); an older CE refuses the pack.
- `HFStatus` also sets CE's `status` column: 1 is `active`, 0 is `inactive` (the Mozambique team
  confirmed 0 means closed, 2026-10-09). CE uses `status` for display and filtering only; retirement
  is `register_state`, so an inactive facility is not hidden.
- `FacilityType` is not mapped into CE's `level`. The letters come from DISA*Lab's location
  dictionary (`DisaGlobal.LOCNDIC4`), which we do not have for Mozambique. See QUESTIONS-FOR-MZ.md.
- An empty value, or the text `NULL`, is written as empty.
- A blank code, a blank name or a repeated code is left out and named in `build-summary.json`.
- Result from the dictionary on 2026-10-07: 2,830 rows, none left out. 37 have no province and
  53 have no district. 2,793 have a province code and 2,781 a district code. FacilityType: H
  2,554, blank 171, Q 60, Y 20, F 17, C 4, and P, V, T, G once each. HFStatus: 1 on 2,370, 0 on 460.
  FacilityNationalCode: 2,305 rows, 1,889 distinct codes, so some MISAU codes cover several DISA
  facilities.

The value sets hold every `DisaPoc` and `Disalink` row, active or not. v1's `IsDisaPoc` and
`IsDisaLink` do not check the state either. Those two output columns keep v1's names on purpose.

## Parameters

Both queries take the same three text parameters.

- `from`, `to`: required. Dates as `YYYY-MM-DD`, on registered time (`lab_requests.authored_at`).
- `facility`: requesting facility code. Leave it blank for all facilities. On a CE before the
  blank-parameter fix, leaving it out entirely fails with "unbound parameter: facility", so pass
  an empty string there.

A report run stops at 1000 rows. Narrow the dates for a big lab.

## Where each column comes from

The columns keep v1's names and order. Most come straight from `lab_requests`,
`diagnostic_reports`, `specimens`, `patients` and `lab_results`. The rare v1 facts are rows in
`lab_request_attributes`. Some values use CE's words, not v1's codes:

- `HL7PriorityCode` is the FHIR priority (`routine`), not `R`.
- `HL7ResultStatusCode` is the FHIR report status (`final`, `registered`), not `F`.
- A reported value is CE's text value, else its numeric value, else its coded value. CE keeps the
  full numeric value, so `61.736...` where v1 shows `62`. A value outside the reporting range
  shows its comparator, as in `< 20`.
- A request fact stored as true or false prints `true` or `false`, not `1` or `0`.

## Columns that are always NULL

| Column | Why |
|---|---|
| `Versionstamp`, `LIMSVersionstamp` | v1 row versions. CE has no equivalent. |
| `LIMSDateTimeStamp` | The LIMS's own row time. Not on the wire. |
| `RequestingFacilityNationalCode` | The MISAU national code. CE's register is keyed on the lab system's code, so `facility_map.national_code` holds that code, not this. |
| `LIMSFacilityCode`, `LIMSFacilityName`, `LIMSProvinceName`, `LIMSDistrictName` | CE stores the requesting and the testing facility, not a third LIMS facility. In Tanzania's v1 this code equals the requesting code, but that is not confirmed for Mozambique. |
| `ReceivingFacilityCode`, `ReceivingFacilityName`, `ReceivingProvinceName`, `ReceivingDistrictName` | Not carried to CE (decision of 2026-07-17, marked to revisit). |

`DateTimeStamp` is CE's `lab_requests.created_at`, the time CE wrote the row. It is not v1's time.

These columns have a CE home but cdr-toolchain does not fill it today, so they are empty:
`LIMSPreReg_*`, `LOINCPanelCode`, `AdmitAttendDateTime`, `ICD10ClinicalInfoCodes`,
`HL7SpecimenSourceCode`, the three specimen-site columns, `HL7EthnicGroupCode`,
`HL7PatientClassCode`, `ReferringRequestID`, `WorkUnits`, `TargetTimeDays`, `TargetTimeMins`.
`CollectionVolume`, `CostUnits`, `Deceased`, `Newborn`, `Repeated` and `EncryptedPatientID` are
sent only when the lab system has a value. v1 wrote `0` or `false` where CE has nothing.

## The three v1 functions

The Mozambique team sent v1's functions on 2026-10-09
(`corlix/fixtures/Mozambique_views/openldr-functions-script.sql`, UTF-16). A custom query is one
SELECT and cannot create SQL functions, so each one is an SQL expression built in `vl-queries.mjs`.
`check-vl-functions.mjs` runs them over a table of cases.

| v1 column | Function | Port |
|---|---|---|
| `ReasonForTest` | `GetReasonForTest(ESCOL)` | `reasonForTestSql` |
| `HIVVL_ViralLoadResult` | `ViralLoadResultMerge(HIVVD)` | `resultMergeSql` |
| `HIVVL_ViralLoadCAPCTM` | `ViralLoadResultMerge(HIVVR)` | `resultMergeSql` |
| `HIVVL_Low_value` | `ViralLoadResultMerge(HIVVC)` | `resultMergeSql` |
| `HIVVL_Viral` | `ViralLoadResultMerge(HIVVF)` | `resultMergeSql` |
| `FinalViralLoadResult` | `ViralLoadFinalResult(...)` | `finalResultSql` |

The port matches v1, including where v1 looks wrong:

- The merge takes the reported value without the coded fallback that `rpt()` adds. Otherwise it
  would never be blank and would return a code where v1 returns its description.
- A code missing from `LIMSCodedValues` gives NULL. v1's `SELECT @x = ... WHERE Code = @code`
  matches no row and leaves `@x` NULL.
- Rule 2 of `ViralLoadFinalResult` has no numeric branch. A plain number in HIVVD with nothing in
  HIVVR, HIVVC or HIVVF gives `INDETECTAVEL`.
- Rule 3 tests whether the two inputs joined together are a number (`'20' || '1000'`).
- Comparisons ignore case and trailing spaces, as SQL Server's default collation does.
- `ISNUMERIC` is a Postgres regular expression: sign, digits with commas, a decimal point, an
  exponent, `$ £ € ¥`, surrounding spaces. SQL Server also accepts a lone `+`, `$` or `.`, and tabs.

One place the port cannot match: v1's error list has `Indeterminado` twice. Rules 2 and 3 test
`(SELECT 1 FROM @errors WHERE Error = x) = 1`, which raises SQL Server error 512 when two rows
match. So v1 fails the whole `viewVL_Result` query on such a request. The port returns NULL.

`LIMSCodedValues` lists five codes with more than one description (`LDL`, `NEG`, `POS`, `INVAL`,
`NDET`). v1 reads them in no fixed order. The build keeps the most frequent description, and on a
tie the first in `(LIMSPanelCode, Description)` order. `build-summary.json` lists each choice
under `vlCodedResults.choices`.

`HIVVL_VRLogValue` needs no function and is returned as v1 did.

## HONEST NON-PROOF

What this pack has not shown:

- **Mozambique codes on real data.** The dev CE has no Mozambique requests. The info query
  returns zero rows. The results query is not zero: Tanzania also uses panel `HIVVL` and
  observation `HIVVC`, so it returns Tanzania rows.
- **The info observations reaching `lab_results`.** Tanzania routes its `VLID` questions to forms.
  If a Mozambique cdr-toolchain config routes `VIRAL` the same way, every info column reads
  `Unreported` or NULL. There is no Mozambique cdr-toolchain config yet.
- **The dictionary joins on real data.** The register and value sets were imported and projected,
  but no Mozambique code has been matched against them.
- **Link matching on real data.** The dev CE has no results, so both link-matching steps link
  nothing. The order rule for the 45 shared codes is reasoned from the code, not observed.
- **The ported functions on real results.** `check-vl-functions.mjs` runs every branch on made-up
  cases in real Postgres. It does not show that v1 and the port agree on Mozambique data. That
  needs the sample data (QUESTIONS-FOR-MZ.md, question 4): run "VL results" and v1's
  `viewVL_Result` side by side and compare the six columns request by request.
- **Which description v1 shows for a duplicated code.** The build's pick is a rule, not an
  observation.
- **Duplicate observations.** A request with one observation code twice returns two rows, as v1
  did. No Tanzania HIVVL request has this, so it was not exercised.
- **Time zones.** The date filter compares text, as the built-in reports do. A request registered
  near midnight at a UTC offset can fall on the other side of `from` or `to`.

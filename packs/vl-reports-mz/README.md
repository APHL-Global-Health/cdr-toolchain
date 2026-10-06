# vl-reports-mz pack

A content pack for OpenLDR CE. It installs two custom queries that port Mozambique's v1 views
`viewVL_Info` and `viewVL_Result`, plus the lab register and two value sets they need.
This is the source of the pack. The signed bundle is built from it.

## Files

| File | What it is |
|---|---|
| `build.mjs` | Reads the v1 dictionary `OpenLDRDict_MZ` (SELECT only) and writes `dist/`. |
| `vl-queries.mjs` | The SQL of both queries: "VL info" and "VL results". |
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
5. `facility-register` `urn:openldr:mz:laboratories`, code `MZLABS`, with the register CSV.
6. `link-matching` against that register. Without it the testing lab name, province and
   district stay empty in both queries.
7. `custom-queries`: "VL info" and "VL results".

Requesting facilities come from the v1 facility dictionary register (slice A). Link that
register the same way.

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

The value sets hold every `DisaPoc` and `Disalink` row, active or not. v1's `IsDisaPoc` and
`IsDisaLink` do not check the state either. Those two output columns keep v1's names on purpose.

## Parameters

Both queries take the same three text parameters.

- `from`, `to`: required. Dates as `YYYY-MM-DD`, on registered time (`lab_requests.authored_at`).
- `facility`: requesting facility code. Pass an empty string for all facilities. Leaving it out
  entirely fails with "unbound parameter: facility".

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

## Columns left out: the three missing functions

v1 computed these columns with SQL functions that are not in the views script:

| v1 column | Function | Returned instead |
|---|---|---|
| `HIVVL_ViralLoadResult` | `ViralLoadResultMerge(HIVVD)` | `HIVVD_LIMSRptResult`, `HIVVD_LIMSCodedValue` |
| `HIVVL_ViralLoadCAPCTM` | `ViralLoadResultMerge(HIVVR)` | `HIVVR_LIMSRptResult`, `HIVVR_LIMSCodedValue` |
| `HIVVL_Low_value` | `ViralLoadResultMerge(HIVVC)` | `HIVVC_LIMSRptResult`, `HIVVC_LIMSCodedValue` |
| `HIVVL_Viral` | `ViralLoadResultMerge(HIVVF)` | `HIVVF_LIMSRptResult`, `HIVVF_LIMSCodedValue` |
| `FinalViralLoadResult` | `ViralLoadFinalResult(...)` | the four pairs above |
| `ReasonForTest` (info) | `GetReasonForTest(ESCOL)` | `ESCOL_LIMSRptResult` |

`HIVVL_VRLogValue` needs no function and is returned as v1 did.

**Request to Mozambique:** please send the scripts of `dbo.ViralLoadResultMerge`,
`dbo.ViralLoadFinalResult` and `dbo.GetReasonForTest` from the OpenLDR data database. With them
these columns can be ported. Without them we would be guessing, so they stay out.

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
- **Link matching for this register.** The link-matching step was not run on the dev CE.
- **Anything the three missing functions do.**
- **Duplicate observations.** A request with one observation code twice returns two rows, as v1
  did. No Tanzania HIVVL request has this, so it was not exercised.
- **Time zones.** The date filter compares text, as the built-in reports do. A request registered
  near midnight at a UTC offset can fall on the other side of `from` or `to`.

# Viral load reports (v1 layout)

This pack adds two custom queries that give viral load data in the column layout of the
OpenLDR v1 views `viewVL_Info` and `viewVL_Result`. It is for labs whose data comes from DISA*Lab.
It also installs Mozambique's lab register and health facility register.

## What it installs

In this order:

1. Code system and value set for the POC sites: `urn:openldr:mz:poc-sites`.
2. Code system and value set for the link sites: `urn:openldr:mz:link-sites`.
3. The lab register `urn:openldr:mz:laboratories` (laboratories and POC sites), code `MZLABS`.
4. The health facility register `urn:openldr:mz:facilities`, code `MZFAC`. It has 2,830
   facilities from the v1 dictionary view `viewFacilities`, keyed on the DISA facility code.
5. Link-matching against the facility register.
6. Link-matching against the lab register.
7. The queries "VL info" and "VL results".

Link-matching links each observed facility code to the register row with the same code. It does
not look at whether the code came in as a testing lab or a requesting facility. 45 codes are in
both registers, and each pair names the same place. The facility register links first, so these
45 codes link to the facility rows, which carry province and district. Their testing labs show
the facility register's name.

Installing again is safe. It replaces the terminology and the two queries, and updates the
register rows. A register you already loaded under the same URL is reused, not duplicated. A
query you edited under one of these names is overwritten.

The facility register has the code, name, province and district. It also keeps five v1 values in
each facility's `extras`, exactly as v1 has them: `province_code`, `district_code`,
`facility_type` (a letter such as H or Q), `hf_status` (1 or 0) and `facility_national_code` (the
MISAU code, where v1 has one; several facilities can share one). Custom queries read them from
the warehouse table `facility_registry`. The facility type and status are not put in CE's own
level and status fields: what each letter means is not known yet.

This version needs a CE that supports extra register columns. An older CE refuses it and writes
nothing.

## Parameters

Both queries take the same three text parameters.

- `from`, `to`: required. Dates as `YYYY-MM-DD`, on the registered time.
- `facility`: requesting facility code. Leave it blank for all facilities. An older CE fails a
  blank box with "unbound parameter: facility"; there, the report must send an empty string.

A report run stops at 1000 rows. Narrow the dates for a big lab.

## How the values differ from v1

- The columns keep v1's names and order.
- `HL7PriorityCode` is the FHIR priority (`routine`), not `R`.
- `HL7ResultStatusCode` is the FHIR report status (`final`, `registered`), not `F`.
- A reported value is the text value, else the numeric value, else the coded value. The full
  numeric value is kept, so `61.736...` where v1 shows `62`. A value outside the reporting range
  shows its comparator, as in `< 20`.
- A true or false fact prints `true` or `false`, not `1` or `0`.
- `DateTimeStamp` is the time CE wrote the row, not v1's time.

## Columns that are always empty

- `Versionstamp`, `LIMSVersionstamp`, `LIMSDateTimeStamp`: v1 row versions and times. CE has none.
- `RequestingFacilityNationalCode`: the register is keyed on the lab system's code, not the
  national code.
- `LIMSFacilityCode`, `LIMSFacilityName`, `LIMSProvinceName`, `LIMSDistrictName`: CE stores the
  requesting and the testing facility only.
- `ReceivingFacilityCode`, `ReceivingFacilityName`, `ReceivingProvinceName`,
  `ReceivingDistrictName`: not carried to CE.
- Columns the data feed does not send today: `LIMSPreReg_*`, `LOINCPanelCode`,
  `AdmitAttendDateTime`, `ICD10ClinicalInfoCodes`, `HL7SpecimenSourceCode`, the three
  specimen-site columns, `HL7EthnicGroupCode`, `HL7PatientClassCode`, `ReferringRequestID`,
  `WorkUnits`, `TargetTimeDays`, `TargetTimeMins`.

## Columns not provided yet

v1 computed these with database functions that are not available, so the raw inputs are
returned instead:

| v1 column | Returned instead |
|---|---|
| `HIVVL_ViralLoadResult` | `HIVVD_LIMSRptResult`, `HIVVD_LIMSCodedValue` |
| `HIVVL_ViralLoadCAPCTM` | `HIVVR_LIMSRptResult`, `HIVVR_LIMSCodedValue` |
| `HIVVL_Low_value` | `HIVVC_LIMSRptResult`, `HIVVC_LIMSCodedValue` |
| `HIVVL_Viral` | `HIVVF_LIMSRptResult`, `HIVVF_LIMSCodedValue` |
| `FinalViralLoadResult` | the four pairs above |
| `ReasonForTest` (info) | `ESCOL_LIMSRptResult` |

## Known limits

- A request with one observation code twice returns two rows, as v1 did.
- The date filter compares text. A request registered near midnight at a UTC offset can fall on
  the other side of `from` or `to`.

# Viral load reports (v1 layout)

This pack adds two custom queries that give viral load data in the column layout of the
OpenLDR v1 views `viewVL_Info` and `viewVL_Result`. It is for labs whose data comes from DISA*Lab.
It also installs Mozambique's lab register and health facility register, and a query that lists
the facilities in the layout of v1's `viewFacilities`.

## What it installs

In this order:

1. Code system and value set for the POC sites: `urn:openldr:mz:poc-sites`.
2. Code system and value set for the link sites: `urn:openldr:mz:link-sites`.
3. Code system and value set for the viral load result codes: `urn:openldr:mz:vl-coded-results`.
   26 codes from the v1 dictionary list `LIMSCodedValues`, each with one description.
4. The lab register `urn:openldr:mz:laboratories` (laboratories and POC sites), code `MZLABS`.
5. The health facility register `urn:openldr:mz:facilities`, code `MZFAC`. It has 2,830
   facilities from the v1 dictionary view `viewFacilities`, keyed on the DISA facility code.
6. Link-matching against the facility register.
7. Link-matching against the lab register.
8. The queries "VL info", "VL results" and "Mozambique facilities (v1 layout)".

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
the warehouse table `facility_registry`. Each facility's status in CE comes from `hf_status`: 1 is
active and 0 is inactive (closed). In CE a facility's status is information only: an inactive
facility is still listed, linked and reported. The facility type is not put in CE's own level field:
what each letter means is not known yet.

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
- `FinalViralLoadResult` keeps CE's full numeric value too.
- v1 stops with an error when a request's only result is the code `I` (`Indeterminado`). The pack
  gives an empty `FinalViralLoadResult` for that request.
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

## Columns v1 computed with functions

v1 worked out six columns with SQL functions. The pack does the same work in each query.

- `ReasonForTest` (VL info): the reason for the test, in English. `Rotina` reads `Routine`,
  `Nao Prenchido` reads `Not Specified`, and an empty reason reads `Reason Not Specified`.
- `HIVVL_ViralLoadResult`, `HIVVL_ViralLoadCAPCTM`, `HIVVL_Low_value`, `HIVVL_Viral` (VL results):
  the reported value. When only a code was reported, the code's description, such as
  `Target not detected` for `LDL`. A code that is not in the pack's list gives an empty value, as
  in v1.
- `FinalViralLoadResult` (VL results): one result per request, by v1's rules. It is a number, a
  range such as `< 20`, `INDETECTAVEL`, or empty.

Where v1's rules look odd, the pack still follows them:

- A plain number in `HIVVL_ViralLoadResult`, with the other three empty, gives `INDETECTAVEL`.
- When both inputs are set, v1 tests whether the two joined together are a number.

Some codes have more than one description in the v1 dictionary. The pack keeps the most frequent
one: `LDL` reads `Target not detected`, `NEG` reads `Negative`, `NDET` reads `NOT DETECTED`,
`POS` reads `POS`, and `INVAL` reads `INVAL`. v1 picks one with no fixed order.

## Known limits

- A request with one observation code twice returns two rows, as v1 did.
- The date filter compares text. A request registered near midnight at a UTC offset can fall on
  the other side of `from` or `to`.
- v1 counts some odd text as a number, such as a lone `+`, `$` or `.`. The pack does not. No real
  viral load result looks like that.

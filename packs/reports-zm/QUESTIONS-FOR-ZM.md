# Questions for the Zambia team

Open questions about the v1 reporting database and the DISA*Lab data. Opened 2026-10-09. None is
answered yet. Questions 1 to 5 came with the first version. Questions 6 to 23 came with the rest of
the reports (version 0.1.1).

## 1. A backup of OpenLDRDict

The script you sent reads v1's `OpenLDRDict` 351 times, but the dictionary itself is not in it. The
pack takes province, district and facility names from the master facility list, so nothing is
blocked.

Please send a backup of `OpenLDRDict`, at least the tables `Facilities`, `HealthcareAreas` and
`Laboratories`, and the function `GetFacilityDetails`. With it we can map DISA*Lab facility codes to
master facility list rows, so labs no longer map them by hand. We can also compare province
spellings, for example `North-Western`, and give lab names the way v1 does.

## 2. A small sample of result data

No Zambia result data has been available. The queries have only run on made-up cases.

Please send a few hundred viral load requests from one lab, twice. Once as DISA*Lab data
(`DisalabData`). Once as v1 `OpenLDRData` for the same requests. Patient names can be removed first. Please
keep the request numbers so the two sets line up. Please also keep `RefNos`, `UniqueID` and
`HOSPID`, because question 3 and the ART number comparison need them. If they must go, replace each
with a stand-in, the same stand-in for the same value.

We need the DISA*Lab copy to measure your DISA*Lab with `cdr probe-review`. Until then results have
no status and no result date, and most reports are empty. We need the v1 copy to run the reports
beside v1's procedures and compare the rows one by one.

## 3. Where v1 gets the hospital number, and two other patient fields

v1 builds the ART number from three patient fields: `REFNO`, `HOSPID` and `UNIQUEID`. We read two
of them from DISA*Lab record `REGDAT4`: `RefNos` (offsets 66 to 121) as `REFNO`, and `UniqueID`
(offsets 32 to 41) as `UNIQUEID`. We matched them by name. The `,ELABS` shape comes from v1's
script, not from your data. We have not seen these fields in your data.

Please confirm both. Please also tell us which DISA*Lab field fills `HOSPID`. The folder number is
already v1's `OrderingNotes`, so we think it is not that one. Until we know, the queries treat
`HOSPID` as blank. Where v1 showed a hospital number as the ART number, the pack shows the unique ID.
The same field fills the `Lab Number` column of the COVID-19 reports, which is empty for now.

## 4. What status Y and Z mean

v1 counts a request as rejected when its result status is `X`, `Y` or `Z`. The DISA*Lab export
carries `X` as cancelled. It carries `Y` and `Z` as "unknown", so the queries cannot pick them out.

Please tell us what `Y` and `Z` mean and whether they belong in the rejected rows. If they do, we
map them to cancelled in the export and the rejected rows match v1.

## 5. Which reports you use most

The script holds 55 views and 83 procedures. This version ports 74 queries that replace the 109
objects the inventory sorted as reports or copies of reports (`INVENTORY.md`).

Please tell us which reports your offices still run, and which matter most. The ones nobody uses can
be dropped from the pack. Please tell us in particular whether the COVID-19 feeds (`v_vrdss_Covid`,
`v_vrdss_Covid_V2`, `v_PHSIMS`) still have a consumer, and whether anyone still uses the four culture
and susceptibility procedures, the HPV report and the wastewater views.

## 6. Does v1's Patients hold one row per request number?

Several v1 procedures join `Patients` on `RequestID` alone: the ART number lookup, the facility client
list, the recency list with names and the culture report. We assumed one row per request number. We
could not check it, because Tanzania's v1 has no `Patients` table.

Please tell us if `Patients` can hold two rows for one request number. If it can, v1 lists that
request twice and we do not.

## 7. What is ASTValue?

For the culture and susceptibility report we read `ASTValue` as the S, I or R flag that
cdr-toolchain sends with each antibiotic result. We have not seen v1's `ASTResults` table.

Please tell us if `ASTValue` is that flag, the decoded word (Sensitive, Resistant), or a MIC or zone
number. Please also tell us where `Methodology` (MIC or KB) comes from. CE has no field for it, so the
column is empty.

## 8. What is your text for result status F?

The pathogen panel report (`v_NMPDP`) shows `TestingStatus` from v1's `HL7ResultStatusCodes` table.
We took the stock text of OpenLDRDict version 1.0.1: `Final results; results stored and verified.
Can only be changed with a corrected result.`

Please tell us if your row for `F` has the same text.

## 9. What is the format of FacilityLocation?

The report `vw_Covid19` calls `GetFacilityDetails(LIMSFacilityCode)` for its `FacilityLocation`
column. That function is not in the script. We show `facility, district, province` as one text.

Please send the function, or an example of its output.

## 10. Is MOHFacilityCode the HMIS code?

v1's recency lists and the VRDSS feeds read `MOHFacilityCode` from the facility dictionary. The VRDSS
feed names it `HMISCode`, and the column is `nvarchar(10)`, which fits the 8-digit HMIS code. We show
the register's `hims_code`.

Please confirm. If it holds the MFL code instead, we change one line.

## 11. What is the collation of your v1 databases?

Tanzania's v1 `OpenLDRData` text columns are `varchar` with `Latin1_General_CI_AS`. We sort and
compare text as that collation does (a word sort that ignores hyphens and apostrophes). We assumed
Zambia's v1 matches.

Please run `SELECT DATABASEPROPERTYEX('OpenLDRData', 'Collation')` on Zambia's v1 server, and tell us
the result. If a column differs, a few text picks (for example which of two results `MAX` returns)
could differ.

## 12. The MFL table's DisaLCode1 to DisaLCode4 columns

v1's `MFL` table has four columns, `DisaLCode1` to `DisaLCode4`, that map DISA*Lab facility codes to
MFL codes. The master facility list we ship has no such columns. With them the pack could ship the
facility mapping, so labs no longer map by hand.

Please send the `MFL` table, or at least its MFL code and the four DISA code columns.

## 13. FacilityList, LabList and tb_edits

The script reads three tables without defining them.

- `FacilityList` gives province, district and facility names to `fn_getEIDs` and the date
  completeness views. We use the master facility list in its place.
- `LabList` gives the lab names and the lab area (`LabName`) of the date completeness and weekly
  request views. We show the lab name of the report for both columns.
- `tb_edits` holds hand-kept baseline viral loads that `get_Test_level_Recency` shows when the
  recency table has none. CE cannot rebuild them.

Please send the three tables. Please also tell us if a `DisaCode` can appear twice in `FacilityList`.
If it can, v1 counts those requests twice and we do not.

## 14. Which lab codes does each lab send?

CE takes the testing lab from the lab code that each lab's push is set to (`OPENLDR_LAB_CODE` in
cdr-toolchain). It does not use a value that DISA*Lab writes for each request. Every report that
groups by lab needs that code to be the lab's v1 code (`ZUA`, `ZTT` and so on).

Please give us the list of labs, the code each one uses, and whether one DISA*Lab instance serves
several codes. UTH, for example, uses `ZUA`, `ZUE` and `ZUL`. A push carries one code, so those labs
become one lab in CE. Please also tell us how often `TestingFacilityCode` is blank in your DISA*Lab
data. CE credits such a request to the pushing lab. v1 handled a blank code in different ways: some
reports use the receiving lab, others leave the request out or leave it without a lab name.

## 15. Do you use ReceivingFacilityCode, and for what?

CE has no receiving facility code. So the `Referral` and `Referrals` columns are empty, and v1's
fallback from a blank testing code to the receiving code, in the reports that have it, does not exist.
The wastewater report loses samples received at one lab and tested at another.

Please tell us whether the receiving code carries real referrals in Zambia, and whether you need
the referral columns.

## 16. When do the DISA Link pre-registration facts arrive?

The DISA Link reports, part b of "Days since last transmission" and the `Disalink` columns read the
pre-registration facility, `LIMSPreReg_RegistrationFacilityCode`, and the referring request id.
cdr-toolchain does not send them yet. Those reports are empty, and the `Disalink` columns are 0,
until it does.

Please tell us if your DISA*Lab feed carries these fields, and which record holds them. Please also
tell us how a DISA Link lab links to its host facility. We assumed the lab's code maps to the same
register facility as the pre-registration code. v1 uses `Laboratories.FacilityCode`.

## 17. Are the viral load result bands right?

v1's `vVLResRangeBreakDownByMonth` has two band columns that are always 0, because they test labels
its source view never produces. We built them as `< 1000 copies/ml` (20 up to 1000) and
`>= 1000 copies/ml` (1000 and over).

Please confirm the bands. A result of exactly 1000 is in the last column.

## 18. Should the HPV report repeat rows?

`sp_get_HPV_data` joins its counts without the lab type. A facility whose lab has three lab types
gets 9 rows, and the positive counts on a row can belong to another lab type. We kept this so the
output matches v1. We fixed one slip that always gave 0 (`HPVOT` joined the month to the year).

Please tell us if you want the lab type join added.

## 19. Does your live TND table have a BaselineVL column?

`sp_getUniqueVLClientsLast12Months_SPHO_WPHO` stops on SQL Server with "Ambiguous column name
BaselineVL", because both `TND` and the second `HIVVL` join carry it. We read the `HIVVL` flag.

Please tell us if your live `TND` table lacks `BaselineVL`. If it does, v1 reads the same flag and we
match. If it has the column, the procedure fails today and nobody could have used it.

## 20. What are the text answers to the VIRAL questions?

CE keeps the VIRAL questionnaire answers as the text DISA*Lab shows, not as codes. v1 tests the codes.
We read `Yes`, `Y` and `Yest` as pregnant or breastfeeding, and `Pregnant Mother` for `ARTRS`.

Please tell us the texts that DISA*Lab shows for yes, no and not applicable in the questions `ARTPR`,
`VPREG`, `VBREA`, `ARTBR` and `ARTRS`.

## 21. Which date should a window use?

Some v1 reports have no date window. We had to pick the date. Rejections by facility and reason use
the registered date (the collection date for VL). HIV drug resistance uses the registered date. The
pathogen and surveillance feeds, and the COVID-19 extracts, use the authorised date. Wastewater uses
the collection date. Date completeness uses the first of collection, received and registered date.

Please tell us if any of these should use another date.

## 22. What does LabName mean in the lab area view?

`vDatesCompletionRatesByLabArea` and the two weekly request views show a `LabName` that the script
does not define. We show the lab name, the same as `LabFacility`. v1's `LabName` is probably a lab
area name.

Please tell us what it holds, or send `LabList`.

## 23. What do the HIVST panel and its eight answer codes mean?

"EID request answers" (v1 `vPCRInfo`) reads the panel `HIVST` and eight observations: `CDHIV`,
`CPMTC`, `INFBR`, `INFN`, `MOHIC`, `MPMTC`, `PCRT` and `PCRTT`. The v1 script does not say what the
panel or the codes mean, so the columns keep the codes as their names.

Please tell us what each code asks, and which answers it takes, so we can name the columns and decide
whether the report belongs with the EID results.

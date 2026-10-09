# Questions for the Zambia team

Open questions about the v1 reporting database and the DISA*Lab data. Opened 2026-10-09. None is
answered yet.

## 1. A backup of OpenLDRDict

The script you sent reads v1's `OpenLDRDict` 351 times, but the dictionary itself is not in it. The
pack takes province, district and facility names from the master facility list, so nothing is
blocked.

Please send a backup of `OpenLDRDict`, at least the tables `Facilities`, `HealthcareAreas` and
`Laboratories`. With it we can map DISA*Lab facility codes to master facility list rows, so labs no
longer map them by hand. We can also compare province spellings, for example `North-Western`.

## 2. A small sample of result data

No Zambia result data has been available. The query has only run on made-up cases.

Please send a few hundred viral load requests from one lab, twice. Once as DISA*Lab data
(`DisalabData`). Once as v1 `OpenLDRData` for the same requests. Patient names can be removed first. Please
keep the request numbers so the two sets line up. Please also keep `RefNos`, `UniqueID` and
`HOSPID`, because question 3 and the ART number comparison need them. If they must go, replace each
with a stand-in, the same stand-in for the same value.

We need the DISA*Lab copy to measure your DISA*Lab with `cdr probe-review`. Until then results have
no status and no result date, and the report is empty. We need the v1 copy to run "VL clients by
province" beside v1's procedures and compare the rows one by one.

## 3. Where v1 gets the hospital number, and two other patient fields

v1 builds the ART number from three patient fields: `REFNO`, `HOSPID` and `UNIQUEID`. We read two
of them from DISA*Lab record `REGDAT4`: `RefNos` (offsets 66 to 121) as `REFNO`, and `UniqueID`
(offsets 32 to 41) as `UNIQUEID`. We matched them by name. The `,ELABS` shape comes from v1's
script, not from your data. We have not seen these fields in your data.

Please confirm both. Please also tell us which DISA*Lab field fills `HOSPID`. The folder number is
already v1's `OrderingNotes`, so we think it is not that one. Until we know, the query treats
`HOSPID` as blank. Where v1 showed a hospital number as the ART number, the pack shows the unique ID.

## 4. What status Y and Z mean

v1 counts a request as rejected when its result status is `X`, `Y` or `Z`. The DISA*Lab export
carries `X` as cancelled. It carries `Y` and `Z` as "unknown", so the query cannot pick them out.

Please tell us what `Y` and `Z` mean and whether they belong in the rejected rows. If they do, we
map them to cancelled in the export and the rejected rows match v1.

## 5. Which views and procedures are still used

The script holds 55 views and 83 procedures. This version ports one report, which replaces 12
procedures. We plan to add EID, COVID, HPV, recency, microbiology, TB and CD4 next.

Please tell us which views and procedures your offices still run, and which ones matter most. We
order the next versions by that list and skip the ones nobody uses.

# Questions for the Mozambique team

Open questions about the v1 dictionary and views. Raise them with the Mozambique team.
Opened 2026-10-07. The team answered questions 1 to 4 on 2026-10-09; what is still open is marked
**Still open**.

## 1. Province codes in viewFacilities.xlsx (answered)

`OpenLDRDict_MZ.dbo.viewFacilities` codes the nine provinces `01` to `09`. The exported
`viewFacilities.xlsx` showed them as `1` to `9`.

**Answer (2026-10-09):** use `01`. The `1` form came from copying the data into Excel.

The pack already writes `01` to `09` from the dictionary. The nine `1` to `9` rows a hand import of
the xlsx had put on the dev CE were retired on 2026-10-07 (`register_state` dropped).

**Still open:** why are the provinces rows in the facility view at all? Are they used as a fallback
facility when a request names only a province?

## 2. The three v1 functions (answered)

The v1 views call `dbo.ViralLoadResultMerge`, `dbo.ViralLoadFinalResult` and `dbo.GetReasonForTest`.

**Answer (2026-10-09):** the team sent `openldr-functions-script.sql`. It defines all three, plus
functions the VL views do not call (`ViralLoadResultRange`, `GetAgeGroup` and others).

**Still open:** `ViralLoadResultMerge` turns a coded result into its description with
`OpenLDRDict.dbo.LIMSCodedValues` (panels HIVVL and VIRAL). In `OpenLDRDict_MZ` several codes appear
more than once with different descriptions:

- `LDL`: "Target not detected" three times, "Nível de detecção baixo" once
- `NEG`: "Negative" three times, "NOT DETECTED" once
- `POS`: "Positive" once, "POS" twice
- `INVAL`: "Invalid" once, "INVAL" once
- `NDET`: "NOT DETECTED" twice, "Not Detected" once

The function picks one with no ordering, so SQL Server decides which. Ask which description v1
actually shows for `LDL` and `NEG`. The sample data in question 4 would also show it.

Until the team answers, the pack keeps the most frequent description, and on a tie the first in
`(LIMSPanelCode, Description)` order.

**Still open (found porting the functions, 2026-10-09):**

- `ViralLoadFinalResult` turns a plain number in HIVVD into `INDETECTAVEL` when HIVVR, HIVVC and
  HIVVF are empty. Its rule for that case has no numeric branch. Is that intended? The pack does
  the same as v1.
- The function's error list has `Indeterminado` twice. For a request whose only result is the code
  `I` (`Indeterminado`), SQL Server raises error 512 and the whole `viewVL_Result` query fails. Has
  the team seen that error? The pack returns an empty `FinalViralLoadResult` there.
- A coded result whose code is not in `LIMSCodedValues` comes out empty in the four
  `HIVVL_*` columns. Is that what the team sees in v1?
- What rule does v1 use to round a viral load result for display (for example `61.736` shown as
  `62`)? The port needs it to match `FinalViralLoadResult` when both inputs are decimals.

## 3. Facility type letters and HFStatus (partly answered)

`viewFacilities.FacilityType` holds one letter: H (2,554 rows), blank (171), Q (60), Y (20), F (17),
C (4), and P, V, T, G once each. `HFStatus` is 1 (2,370 rows) or 0 (460).

**Answer (2026-10-09):** HFStatus 1 is active and 0 is closed. The FacilityType letters come from
DISA*Lab.

In DISA*Lab the letters live in the location dictionary, `DisaGlobal.dbo.LOCNDIC4.FacilityType`
(beside `FacilityArrangement`). The DISA*Lab database we have is Tanzania's, where both columns are
empty for all 8,754 locations, so the meanings cannot be read from it.

**Still open:**

- Send a `DisaGlobal` backup from Mozambique, or the list of facility type letters and their names
  from DISA*Lab's location setup.
- Should a closed facility (HFStatus 0) still receive results, or appear in pickers?

## 4. A small sample of result data (answered: coming)

No Mozambique result data has been available so far. The VL queries, the facility registers and
link-matching have only been tested against empty tables.

**Answer (2026-10-09):** the team will send sample data.

Useful in it: a few hundred viral load requests from one lab, as a DISA*Lab backup (`DisalabData`,
and `DisaGlobal` for question 3) or an `OpenLDRData` extract (`Requests` and `LabResults`). Patient
names and identifiers can be removed first; the comparison only needs the request and result
fields. With it we can compare "VL info" and "VL results" against v1's `viewVL_Info` and
`viewVL_Result` request by request, including the ported functions in question 2.

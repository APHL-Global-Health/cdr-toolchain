# Questions for the Mozambique team

Open questions about the v1 dictionary and views. Raise them with the Mozambique team.
Opened 2026-10-07.

## 1. Province codes in viewFacilities.xlsx

`OpenLDRDict_MZ.dbo.viewFacilities` codes the nine provinces `01` to `09`. The column is text
(varchar). The exported `viewFacilities.xlsx` shows them as `1` to `9`. Excel reads those cells as
numbers and drops the leading zero.

Ask:

- Which form do other systems use, `01` or `1`?
- Do lab feeds ever send a province code as a requesting facility? If so, in which form?
- Why are provinces rows in the facility view at all? Are they used as a fallback facility?

The pack uses the dictionary, so it writes `01` to `09`. A hand import of the xlsx had put `1` to `9`
on the dev CE as well. Those nine rows were retired on 2026-10-07 (`register_state` dropped), so they
stay in history but no longer count as part of the register. The question above still stands.

## 2. The three missing functions

The v1 views call three SQL functions that are not in `openldr-views-script.sql`:

- `dbo.ViralLoadResultMerge`
- `dbo.ViralLoadFinalResult`
- `dbo.GetReasonForTest`

Ask for their scripts from the OpenLDR data database. Without them these columns stay out of the
VL queries: `HIVVL_ViralLoadResult`, `HIVVL_ViralLoadCAPCTM`, `HIVVL_Low_value`, `HIVVL_Viral`,
`FinalViralLoadResult` and `ReasonForTest`. README.md lists what is returned instead.

## 3. Facility type letters and HFStatus

`viewFacilities.FacilityType` holds one letter, with no definitions anywhere in the dictionary:
H (2,554 rows), blank (171), Q (60), Y (20), F (17), C (4), and P, V, T, G once each.
`HFStatus` is 1 (2,370 rows) or 0 (460).

Ask:

- What does each FacilityType letter mean? Is there a list, for example in MISAU's facility master?
- Does HFStatus 0 mean the facility is closed, or something else (not reporting, not verified)?
- Should a facility with HFStatus 0 still receive results?

Since pack 0.4.0 both are kept raw in each facility's `extras` (`facility_type`, `hf_status`). With
the answers, the pack can map them into CE's facility level and status.

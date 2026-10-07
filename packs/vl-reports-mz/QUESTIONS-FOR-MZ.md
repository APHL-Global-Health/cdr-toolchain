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

The pack uses the dictionary, so it writes `01` to `09`. The dev CE also holds `1` to `9` from a
hand import of the xlsx. Those nine rows were left in place on purpose.

## 2. The three missing functions

The v1 views call three SQL functions that are not in `openldr-views-script.sql`:

- `dbo.ViralLoadResultMerge`
- `dbo.ViralLoadFinalResult`
- `dbo.GetReasonForTest`

Ask for their scripts from the OpenLDR data database. Without them these columns stay out of the
VL queries: `HIVVL_ViralLoadResult`, `HIVVL_ViralLoadCAPCTM`, `HIVVL_Low_value`, `HIVVL_Viral`,
`FinalViralLoadResult` and `ReasonForTest`. README.md lists what is returned instead.

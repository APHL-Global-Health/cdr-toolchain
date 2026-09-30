# The v1 request facts on the wire, checked against v1

Date: 2026-09-29. Branch `spec/v1-request-facts-wire`, first run at `4398726`, re-run at `4a60ce1` after fix `7c3f26e`. Plan Task 7 step 2.

15 facts checked on 136 paired rows. 10 agree with v1 on every row where either side has a value. 4 differ only where USERDIC6 names or blank sections differ, as the findings predicted. 1 (point of care) could not be checked, because v1 holds no ward in this sample.

## Re-run after fix 7c3f26e

Fix `7c3f26e` takes analysis time from the run with the lowest TESTINDEX per OBR, with the earlier DATESTAMP breaking a tie. The same script on the same three samples (main, rejected, therapy) now gives analysis time 136 of 136, 177 of 177 and 68 of 68, with no mismatches. That equals the measured source. Before the fix it was 136, 169 of 177 and 67 of 68. No other fact's counts changed, and the pairing and error counts are the same. The newborn sample was not re-run.

## Method

A scratch script ran the exporter's own code path for each lab. It fetched the SpecimenRecpt through disalab (`REGDAT4.All` then `SpecimenRecpt.Fetch`), resolved the ward through `WardDictResolver`, built the audit report, and ran `toV2` with `loadBlobOffsets("tanzania")`, `loadRequestFactConfig("tanzania")`, the codebook from `loadCodebook` and the Tanzania documentation config. It then ran `toFhir` with `+03:00` and read every fact back out of the FHIR resources, not the V2 payload. It paired each ServiceRequest and DiagnosticReport with a v1 `OpenLDRData.dbo.Requests` row on (lab, `urn:openldr:obr-set-id`), with `RequestID = 'TZDISA' + LabNo`. Normalisation follows the findings script: a trimmed empty string is empty, 0 is empty for numbers, case and whitespace are ignored. Staff names match loosely: v1 starts with the CE name, or v1 holds initials that USERDIC6 names as the CE name. Analysis time is compared to the minute in local time. Point of care compares CE `locationCode[0].text` with the ward part of v1 `LIMSPointOfCareDesc`, split the way the compare gate splits it (`splitPointOfCare`, `facility_ward`). Every query was a SELECT. Nothing was posted to CE or v2.

Sample: `abs(checksum([LabNo])) % 2000 = 0`, 75 labs. 66 are in v1, with 136 rows. The exporter built 136 OBRs for them, and every v1 row paired with one. The other 9 labs are not in v1. For 8 of those 9, `toFhir` throws "payload has no lab_requests". None of the 8 has a v1 row.

Rejection, therapy and newborn are rare in that sample, so I also ran the same script on the findings' targeted samples: rejected labs (`% 80 = 0` and a v1 rejection code, 84 labs, 177 rows), all 9 TDS labs with v1 therapy (68 rows), and the 3 v1 newborn labs (6 rows). All pair fully.

## Main sample, 136 rows

| Fact | FHIR slot read | Match | Mismatch | Only CE | Only v1 | Both empty |
|---|---|---|---|---|---|---|
| analysis time | SR ext `analysis-time` | 136 | 0 | 0 | 0 | 0 |
| request type | SR ext `request-type` | 136 | 0 | 0 | 0 | 0 |
| age years | SR ext `age-at-request.years` | 104 | 0 | 0 | 0 | 32 |
| age days | SR ext `age-at-request.days` | 113 | 0 | 0 | 0 | 23 |
| analyser code | SR ext `analyzer` | 75 | 0 | 0 | 0 | 61 |
| rejection code | SR ext `rejection.code` | 1 | 0 | 0 | 0 | 135 |
| rejection reason | SR ext `rejection.reason` | 1 | 0 | 0 | 0 | 135 |
| section code | DR `category` v2-0074 | 133 | 3 | 0 | 0 | 0 |
| tested by | SR ext `tested-by` | 132 | 3 | 0 | 0 | 1 |
| authorised by | DR `resultsInterpreter[0].display` | 111 | 9 | 0 | 0 | 16 |
| registered by | SR ext `registered-by` | 132 | 2 | 0 | 0 | 2 |
| point of care (ward) | SR `locationCode[0].text` | 0 | 0 | 2 | 0 | 134 |
| ordering notes | SR attribute `ordering-notes` | 136 | 0 | 0 | 0 | 0 |
| therapy | SR attribute `therapy` | 0 | 0 | 0 | 0 | 136 |
| newborn | SR attribute `newborn` | 0 | 0 | 0 | 0 | 136 |

Also present, not compared value by value: `note` (clinical info) on 26 ServiceRequests, and a contained PractitionerRole on all 136.

## Targeted samples

| Fact | Rejected, 177 rows | Therapy, 68 rows | Newborn, 6 rows |
|---|---|---|---|
| analysis time | 177 match (169 and 8 mismatch before `7c3f26e`) | 68 match (67 and 1 mismatch before) | 6 match (not re-run) |
| request type | 177 match | 68 match | 6 match |
| age years | 173 match, 4 both empty | 55 match, 13 both empty | 6 both empty |
| age days | 173 match, 4 both empty | 56 match, 12 both empty | 6 both empty |
| analyser code | 1 match, 176 both empty | 57 match, 11 both empty | 2 match, 4 both empty |
| rejection code | 98 match, 79 both empty | 1 match, 67 both empty | 1 match, 5 both empty |
| rejection reason | 98 match, 79 both empty | 1 match, 67 both empty | 1 match, 5 both empty |
| section code | 176 match, 1 mismatch | 68 match | 6 match |
| tested by | 87 match, 90 both empty | 56 match, 12 mismatch | 5 match, 1 both empty |
| authorised by | 78 match, 1 mismatch, 98 both empty | 65 match, 3 both empty | 3 match, 3 both empty |
| registered by | 159 match, 18 both empty | 56 match, 12 mismatch | 6 match |
| point of care (ward) | 177 both empty | 68 both empty | 6 both empty |
| ordering notes | 177 match | 68 match | 6 match |
| therapy | 177 both empty | 68 match | 6 both empty |
| newborn | 177 both empty | 68 both empty | 6 match |

No fact has an only-CE or only-v1 row in any targeted sample.

## Mismatch examples

Section code. All 4 are panel HBSAG, whose TESTDICT section is NULL. The config maps blank to OTH. v1 has SR.
- TDS0119404#10: CE `OTH`, v1 `SR`
- TDS0119420#4: CE `OTH`, v1 `SR`
- TDS0119490#4: CE `OTH`, v1 `SR`

Staff names. Every name mismatch is a USERDIC6 description that changed after v1 was loaded. The main sample has 3 people behind 14 rows.
- TDS0119404#1 authorised by: CE `Regnald Julius (RJB Medical Sc`, v1 `Regnald Julius  Medical Scientist` (9 authorised-by rows in the main sample, all this name; the 12 therapy-sample mismatches are this name too)
- TDS0011401#1 tested and registered by: CE `Sylvester Mattunda`, v1 `Sylvester Mbanga  Medical Technologist`
- TDS0012343#2 tested by: CE `Miriam Matonya`, v1 `Martha Matola` plus a line break and a job title

Analysis time, before fix `7c3f26e` only. Every mismatch was an OBR with a rerun, where the exporter picked the wrong run as "first". The re-run has none.
- TDS0010409#10 GLUC: CE `2013-04-09T13:30`, v1 `2013-04-10T16:28`
- TDS0011349#1 COL: CE `2013-06-21T13:09`, v1 `2014-06-11T11:29`
- TDS0011354#1 COL: CE `2013-06-21T13:35`, v1 `2014-06-11T11:30`

Point of care. The only non-empty CE values:
- TDS0050012#1 and TDS0050082#1: CE `AFYA`, v1 `NHLQATC` (facility only, no ward part)

## Against the findings

- Request type, age, analyser, rejection code and reason, ordering notes, therapy and newborn: as expected. Every paired row agrees.
- Section: as expected. The findings' 7 misses were letter L and blank sections. The config now maps L to OTH, so only the blank HBSAG rows remain.
- Staff names: as expected. Initials agree, names differ where USERDIC6 changed. The rate is higher than the 2 to 4% population figure on these small samples (9 of 136 authorised by, 12 of 68 tested by in the therapy sample), because one renamed user (RJB) signs many rows.
- Analysis time: as expected since fix `7c3f26e`. Before it, analysis time fell short of the measured source. The findings measured the first iteration by TESTINDEX: 177 of 177 on the rejected sample and 68 of 68 on the therapy sample. The exporter scores 169 and 67, the same as the findings' "last iteration" figures. The cause is in `apps/cli/src/export/review-status.ts:106-113`. `firstByObr` picks the earliest by DATESTAMP, then by panelIndex (`isLater`, `:46-51`). On the rerun OBRs the base slot (TESTINDEX 1 or 10) carries a DATESTAMP of 2016-03-08, later than the rerun slot (101 or 110). So the exporter takes the rerun, and v1 has the base slot's header time. Example TDS0011349 COL: slot 1 has DATESTAMP 2016-03-08 and header 2014-06-11 11:29, which is v1's value. Slot 101 has DATESTAMP 2014-06-11 and header 2013-06-21 13:09, which CE got. The main sample has no such OBR, so it scores 136 of 136. Fix `7c3f26e` now picks the lowest TESTINDEX, and the re-run matches every row.
- Point of care: not checkable on this data. v1 `LIMSPointOfCareDesc` has no `~` on any sample row, so v1 holds the facility name and no ward. DISA has a ward on 1 lab (2 rows, `AFYA`, not in WARDDICT). CE sends that raw code, as ruling 4 says. The findings' "ward 66 of 66" came from the gate's `wardComparator`, which counts a DISA ward against an empty v1 ward as a match.

## Not checked

- The facility part of v1's point of care. CE composes it from `requester_display`, which this check did not read.
- Clinical info (`note`) and the requesting doctor (contained PractitionerRole) values against v1. Both were already sent before this branch. I counted their presence only.
- What CE stores. This reads the FHIR resources the exporter builds. It does not post them, so it proves nothing about CE's ingest or its `lab_requests` columns. Plan Task 7 step 3 covers that.
- Newborn rests on 3 labs, the only 3 v1 newborns in TDS.
- The 8 labs where `toFhir` throws have no v1 rows, so nothing was lost against v1. Why their payloads have no lab requests was not investigated.

## Mozambique

HONEST NON-PROOF. Every figure here is Tanzania (TDS) data with `config/tanzania.yaml`. No Mozambique DISA copy was run. v1's Mozambique point of care is `district~facility~ward`, which this check never saw. What would prove it: a Mozambique DISA copy, its v1 `Requests` table and a measured `config/mozambique.yaml`, then the same script.

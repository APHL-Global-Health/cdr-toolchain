# Zambia reports

Zambia's v1 reports in OpenLDR CE, for data exported from DISA*Lab. This version has the Zambia
health facility register and 74 reports. Read "Set up before you use it" first. Steps 1 to 3 decide
whether the reports show anything.

## What it installs

1. The facility register `urn:openldr:zm:facilities`, code `ZMFAC`. It has 3,788 facilities from
   Zambia's master facility list (August 2026), keyed on the MFL code.
2. 74 custom queries. "The reports" below lists each one with its parameters.

Installing again is safe. It updates the register rows and replaces each query by name. A query you
edited under the same name is overwritten.

Version 0.1.0 had the register and one report, "VL clients by province". This version keeps that
report and adds 73. Two things changed in the old report. A date outside `YYYY-MM-DD` is now refused.
A result stamp that does not start with a full date (for example `2026-07`) is now outside every date
range.

## What it needs from CE

- **CE 0.1.9 or later.** The reports read the warehouse table `facility_registry`, CE's copy of the
  facility registers. It arrived after CE 0.1.8 (warehouse migration `021_facility_registry`), so
  0.1.9 is the first release that has it. On an older CE, 25 of the 74 reports fail with "relation
  facility_registry does not exist": every province and district pick list reads it, and so do the
  reports that show an HMIS code or a facility type.
- **The connector `Target Warehouse (Postgres)`.** CE's own setup creates it. The install binds each
  new query to the connector with that exact name, and fails if there is none. A query that already
  exists under the same name keeps its connector.
- The manifest says it works with any CE version (`ceVersion` `*`). It cannot say 0.1.9 or later yet:
  CE checks the range against a version number fixed at 0.1.0 in its code, so any minimum would
  block the install everywhere. Check your CE version yourself before you install.

## Set up before you use it

**1. Map your lab's facility codes.** DISA*Lab names facilities with its own codes, not MFL codes, so
the pack cannot link them for you. In CE, open Facilities and map each requesting facility code to
its register row. CE suggests matches by name. CE keeps one mapping row for each spelling of a code it
has seen, so `ZSOUT` and `zsout` need a mapping each. A request from an unmapped facility is left out
of most reports. A few reports keep it with blank names.

**2. Set each lab's lab code.** CE takes the testing lab of a result from the lab code that the
sending side (cdr-toolchain) is set to for each push. That is its `OPENLDR_LAB_CODE` setting. It is
not a value DISA*Lab writes per request. Every report that reads the testing lab code needs each
lab's push to use that lab's v1 code (`ZUA`, `ZTT` and so on). If it is unset, CE names the
requesting clinic as the lab. One DISA*Lab instance can serve several lab codes. UTH, for example,
uses `ZUA`, `ZUE` and `ZUL`. A push carries one lab code, so those labs collapse into one code in CE.
A request whose DISA*Lab testing code is blank is not lost in CE. CE credits it to the pushing lab.
v1 handled a blank code in different ways. Some reports used the receiving lab. Others left the
request out or left it without a lab name. So some CE counts can be higher than v1's.

**3. Measure Zambia's DISA*Lab.** Zambia's DISA*Lab data export has not been measured yet. Until
the OpenLDR team runs `cdr probe-review` on a sample export from Zambia, results carry no status and no
result date. Every report that needs a
final result or a result date is empty on real Zambia data. The reports are tested on made-up
cases only. Compare them with v1 on a real export before you trust a number.

**4. Check the database locale.** COVID-19 results keep v1's misspelled result text `Ínconclusive`,
with an accent on the first letter. CE matches it case-insensitively, which needs a UTF-8 `LC_CTYPE`
on the CE database. Check it with `SHOW lc_ctype;` in psql. It should name a UTF-8 locale, such as
`en_US.utf8`. In the C locale the accented letter does not fold, and that result text shows no
value. This touches the COVID-19 daily line list, both COVID-19 results extracts and both VRDSS
feeds.

## How the reports behave

**Dates.** A date parameter is `YYYY-MM-DD` and a real calendar date. `09/10/2026` and `2026-02-30`
are refused. The error names the parameter and shows the value, for example
`from must be YYYY-MM-DD, got 09/10/2026`. CE puts Postgres wording in front of it, so the message
starts `invalid input syntax for type integer:`. Read the part after the colon. The error comes when
CE plans the query, so you see it even when no rows match. A blank optional date means no limit. The
COVID-19 daily line list takes `YYYY-MM-DDTHH:MM`, the 04:00 to 04:00 window of v1. Its error starts the
same way, and also comes when no rows match.

**Which day a stamp is on.** A stamp counts on the date written in it. DISA*Lab writes `+02:00`, so a
result at `2026-05-31T23:30:00+02:00` is on 31 May. Several v1 reports compare a datetime column with
a date. The last day then counts only its first instant (00:00:00). The port keeps this where v1
does it. The README lists those reports.

**Row limit.** The pack's reports are custom queries. Run them on the Query page (`/query`). It shows
1000 rows a page and pages through the rest, so it has no row limit. A report definition on the
Reports page (`/reports`) built on one of these queries stops at 1000 rows: past that, the run fails
with an error and gives no rows. A report design's PDF does the same: the table shows an error in
place of the rows. Line lists such as "VL clients by province" and "Culture and
susceptibility results" can pass 1000 rows in a busy month. Run them on the Query page, or narrow the
dates or pick a province.

**Row order.** Most v1 reports had no ORDER BY. These reports sort by every column, so paging is
stable.

**Forms.** A request entered through a CE form has no request number. Counts of request numbers skip
it, as v1's count skips a NULL. In the date completeness reports a group made only of such requests
shows Requests 0 and blank rates.

**Gender.** CE stores the FHIR gender `other` as `O`. A v1 client with sex `I` shows as Missing, or
with a blank Gender, depending on the report.

**Pregnancy and baseline flags.** The pregnant, breastfeeding, baseline and 3-month flags read the text
answers of the VIRAL form (`hiv_vl_documentation`). A flag is 0 (blank in the monthly trends) when no
form arrived for the request, or when its text is not on the yes list. QUESTIONS-FOR-ZM question 20
asks for the texts.

**Names.** Province, district and facility names come from the register, not from v1's dictionary.
Some spellings can differ. A lab name is the name written on the report, else the register name of the
mapped code, else the code, and a lab code has one name. A lab that v1's dictionary did not list
still appears here.

**Data CE does not hold.** These stay empty, or reduced, under their v1 names.
- The receiving facility code. Referral and Referrals columns are empty.
- The hospital number (HOSPID), so the ART number falls back to the unique ID and the COVID-19
  `Lab Number` is empty.
- The implementing partner, the hand-kept `tb_edits` baselines, the LOINC codes and the v1 load
  stamps.
- Rejected statuses Y and Z. CE sees them only as "unknown", so only status X (cancelled) counts
  as rejected.
- The DISA Link pre-registration facts. Disalink columns show 0, and the DISA Link reports are
  empty, until cdr-toolchain sends them.

## Reports that show personal data

These reports show client names, dates of birth, phone numbers, ART numbers or other client
reference numbers:

| Report | Personal columns |
|---|---|
| VL clients by province | Name, ARTNumber |
| Client by ART number | FIRSTNAME, SURNAME (looked up by ART number) |
| VL results for a facility's clients | ARTNo |
| Earlier VL results of high-VL clients | ARTNumber |
| VL results history by client | ARTNumber |
| EID clients by province | Name, UNIQUEID, HealthcareNo, HOSPID, REFNO |
| Recency tests with client names | ClientName, REFNO |
| Culture and susceptibility results | FIRSTNAME, LastName, DOB, IdentificationNumber |
| COVID-19 positive patients | FIRSTNAME, SURNAME, Epid |
| COVID-19 daily line list | Patient Name, Contact Number, Epid |
| COVID-19 results (VRDSS) | DOB |
| COVID-19 results (VRDSS V2) | dob, ct_case_id, Other Ref Number |

Anyone with the `query.run` capability ("Use query workbench") can run every custom query, these
included. In CE's preset roles that is Administrator, Lab Manager and Data Analyst. A report
definition built on one of these queries also shows the rows to anyone who can run that report.
Give `query.run`, and run access to such reports, only to staff who may see client data. Give staff
who may not see it a role without `query.run`.

Most other reports show lab numbers, ages, sex and dates. Those are not names, but anyone who can
look a lab number up in DISA*Lab can find the client.

## The reports

Parameters in square brackets are optional. A blank optional date means no limit. Province and
district are pick lists from the register. A facility is typed as its register name. Where province,
district or facility is optional, blank means all, with three exceptions:

- DBS monitoring (VL and EID): a blank province means Lusaka, Southern, Eastern, Western and
  North-Western.
- Unique VL clients by facility (12 months): a blank province means Southern and Western.
- COVID-19 daily line list: `facility` is a requesting facility code, not a register name. Blank shows
  every facility in the standard version, and only LVCVD and LPMGH in the Levy version.

A blank pick list that is not a place (`show`, `version`, `rows`, `list`, `test_type`, `laboratory` of
the wastewater report) takes its first value. In the TB reports, MTB is the TB bacteria result and
RIF is the rifampicin resistance result of a GeneXpert test.

| Report | What it gives | Parameters |
|---|---|---|
| VL clients by province | Viral load clients of a province for a date range: valid results, rejected requests and unclear results. | [`province`], `from`, `to` |
| VL dashboard summary | Viral load tests, suppression, turnaround, and sex and age counts for Zambia, a province, a district or a facility. | [`province`], [`district`], [`facility`], `from`, `to` |
| VL dashboard by sex and age | Viral load tests, suppressed and unsuppressed counts per sex and age group, by province or facility. | [`province`], [`district`], `from`, `to` |
| VL monthly trend | Viral load tests, suppression and turnaround counts for each month of the range. | [`province`], [`district`], [`facility`], `from`, `to` |
| Client by ART number | Lab numbers and names of the clients with an ART number. | `art_number` |
| VL results for a facility's clients | Each viral load result of one facility, with ART number, suppressed flag and three turnaround times. | `facility`, `from`, `to` |
| Earlier VL results of high-VL clients | For clients with a high result in the range, their results of up to 10 visits side by side. | `from`, `to` |
| VL results history by client | Every viral load result of the clients tested in the range, newest first. Can list pregnant clients only. | `from`, `to`, [`province`], [`pregnant_only`] |
| VL testing summary by province | Viral load registrations, tests, suppressed and unsuppressed counts and turnaround totals per province. | `from`, `to` |
| VL testing summary by district | The same counts per district of one province. | `province`, `from`, `to` |
| VL testing summary by facility | The same counts per facility of one district. | `district`, `from`, `to` |
| Unique VL clients | Unique clients with a result in the range, by suppression, sex and age band. Totals or one row per sub-area. | [`province`], [`district`], [`facility`], `from`, `to`, [`rows`] |
| Unique VL clients by facility (12 months) | Unique clients and how many are suppressed, per facility. Blank province means Southern and Western. | `from`, `to`, [`province`] |
| Unique VL clients, 12-month rates | One row: unique clients, suppressed and undetectable counts, and the two rates. | [`province`], [`district`], [`facility`], `from`, `to` |
| VL requests and tests by lab and month | Viral load requests registered and tests finished per lab and month. | [`from`], [`to`] |
| VL result bands by month | Viral load requests per month by result band: not detected, under 20, under 1000 and 1000 or more. | [`from`], [`to`] |
| VL tests on GeneXpert | Viral load tests run on GeneXpert analysers, with the testing lab name. | `from`, `to` |
| EID testing summary by province | Early infant diagnosis (EID) registrations, tests, negatives, positives and turnaround totals per province. | `from`, `to` |
| EID testing summary by district | The same counts per district of one province. | `from`, `to`, `province` |
| EID testing summary by facility | The same counts per facility of one district. | `from`, `to`, `province`, `district` |
| EID dashboard summary | EID tests, positives, point-of-care split, turnaround, and sex and age counts for Zambia, a province, district or facility. | [`province`], [`district`], [`facility`], `from`, `to` |
| EID dashboard by facility, sex and age | EID results per facility, sex and age band, with lab turnaround counts. | [`province`], [`district`], `from`, `to` |
| EID monthly trend | EID tests, positives, negatives and tests within 14 days for each month of the range. | [`province`], [`district`], [`facility`], `from`, `to` |
| EID clients by province | EID results and rejected requests of a province, one row per client request. | [`province`], `from`, `to` |
| EID results | One row per EID request and result class, with province, district, facility and age band. A list option gives the under 2 years view. | `from`, `to`, [`list`] |
| EID request answers | The first answer to each of eight questions on the HIVST panel, one row per request. | none |
| EID tests on GeneXpert | EID tests run on GeneXpert analysers, with the testing lab name. | `from`, `to` |
| TB GeneXpert dashboard summary | TB GeneXpert tests, positivity, rifampicin resistance, errors, turnaround, and sex and age counts. | [`province`], [`district`], [`facility`], `from`, `to` |
| TB GeneXpert by facility, sex and age | TB GeneXpert measures per facility, sex and age group. | [`province`], [`district`], `from`, `to` |
| TB GeneXpert monthly trend | TB tests, MTB and RIF positives, and tests within 24, 48 and 72 hours for each month. | [`province`], [`district`], [`facility`], `from`, `to` |
| TB GeneXpert report | GeneXpert results per testing lab, age group and TB/HIV status. | `from`, `to` |
| Recency tests | Recent infection (recency) tests with the client baseline viral load, suppression status and reporting status. | `from`, `to` |
| Recency surveillance counts | Counts of recency tests by facility, age group, sex, result, modality and registration week. | `from`, `to` |
| Recency tests with client names | The recency test list with the client name and reference number added. | `from`, `to` |
| DBS monitoring (VL and EID) | Dried blood spot viral load and EID samples: valid results, rejections and unclear results, with specimen type and reason. A blank province means Lusaka, Southern, Eastern, Western and North-Western. | `from`, `to`, [`province`] |
| CD4 by area, age and sex | CD4 tests per facility, age group and sex, split by absolute count range and percentage range. | `from`, `to` |
| HPV results by month | HPV tests and positives per facility, testing lab and month, with HPV16, HPV18, other and high-risk counts. | `from`, `to` |
| Culture and susceptibility results | Culture results of one lab with organism and antibiotic susceptibility, one row per organism. | `laboratory`, `from`, `to` |
| HIV drug resistance | One row per request with a column for each of 26 antiretroviral drugs. | [`from`], [`to`] |
| Pathogen panel results (NMPDP) | One row per pathogen for the FTD33 and REPCR panels, with isolated yes or no. | [`from`], [`to`] |
| Public health surveillance results (PHSIMS) | Result feed of 44 surveillance panels with facility MFL code, lab, dates and result. | [`from`], [`to`] |
| COVID-19 by testing lab | COVID-19 requests registered, tested, authorised and positive per testing lab. | `from`, `to` |
| COVID-19 positive patients | Patients with an authorised positive COVID-19 result for one lab and one facility. | `from`, `to`, `laboratory`, `facility` |
| COVID-19 by source facility | The same four counts per source facility for one lab. Can show only facilities with positives or with tests. | `from`, `to`, `laboratory`, [`show`] |
| COVID-19 daily line list | COVID-19 patients with a result authorised in a date-time window, with contact, test and symptom answers. The facility is a requesting facility code. Version Levy with a blank facility shows only LVCVD and LPMGH. | `from`, `to`, [`version`], [`facility`] |
| COVID-19 daily positivity | Daily COVID-19 tests, positives, positivity rate and 7-day moving average. | `from`, `to` |
| COVID-19 results with location | Final COVID-19 requests with their results and province, district and facility. | [`from`], [`to`] |
| COVID-19 results with facility location | The same rows with one facility location text in place of province, district and facility. | [`from`], [`to`] |
| COVID-19 results (VRDSS) | One row per final COVID-19 result, shaped as a feed for the surveillance system. | [`from`], [`to`] |
| COVID-19 results (VRDSS V2) | The same feed in the second column layout. | [`from`], [`to`] |
| Wastewater results | SARS-CoV-2 CT values and result for six Lusaka wastewater sites, or the CHAZ lab. Blank means the six sites. | [`from`], [`to`], [`laboratory`] |
| VL lab performance | Viral load lab summary: completeness, throughput, referrals, DISA Link share, suppression and timeliness per lab. | `from`, `to` |
| EID lab performance | EID lab summary: completeness, throughput, rejections, result classes and timeliness per lab. | `from`, `to` |
| TB lab performance | TB GeneXpert lab summary: completeness, throughput, MTB and RIF results, errors and 24, 48 and 72 hour turnaround. | `from`, `to` |
| Days since last transmission | Days since each lab last sent a registration or an authorised DISA Link request. | `from` |
| Suspect collection dates | VL and EID requests whose collection date is more than 90 days before registration. | `from`, `to` |
| DISA Link weekly stats | New registrations, tests and reviews per DISA Link site, and tests of older requests. | `from`, `to` |
| VL and EID weekly stats | Requests, tests, backlog, rejects, invalids, suppressed, positives and turnaround per lab and test type. | `from`, `to` |
| Tests authorised by lab and type | Tests authorised per lab, with its facility, in 16 test types. | `from`, `to` |
| VL throughput by lab and month | Viral load requests received and tested per lab and month for one year. | `year` |
| Rejections by facility and reason | Rejected samples per facility and period, split by 28 reasons. Can limit to EID or VL. | [`test_type`], [`from`], [`to`] |
| VL rejections by facility (total) | Rejected viral load requests per facility over all periods. | [`from`], [`to`] |
| VL rejections by lab | Rejected viral load requests per lab. | [`from`], [`to`] |
| Date completeness by province | Share of requests with collection, received, registered, analysed and authorised dates, per province. | [`from`], [`to`] |
| Date completeness by district | The same shares per district. | [`from`], [`to`] |
| Date completeness by facility | The same shares per facility. Can limit to EID or VL. | [`test_type`], [`from`], [`to`] |
| Date completeness by lab | The same shares per lab, for the panels HIVVL, HIVPC, VIRAL and HIVST. | [`from`], [`to`] |
| Date completeness by lab facility | The same shares per lab facility, for EID or for VL. | `test_type`, [`from`], [`to`] |
| Date completeness by lab area | The same shares per lab area, for all panels. | [`from`], [`to`] |
| Turnaround times by lab | Average days for each step from collection to authorisation, per lab and period. Can limit to EID or VL. | [`test_type`], [`from`], [`to`] |
| Turnaround times by province | The same averages per province. | [`test_type`], [`from`], [`to`] |
| VL turnaround by month | Total VL turnaround in days per lab and month. | [`from`], [`to`] |
| Requests received by week | Requests received per lab and week, split into PCR, viral load and other. | `from`, [`to`] |
| Requests received by week (VLEID copy) | The same, read from the copy of four panels, with the lab facility column. | [`from`], [`to`] |

## How it differs from v1

- Each report has v1's column names, in v1's order, and the same rows for the same data and dates.
  Where v1 runs but behaves oddly, the port keeps the behaviour. Where v1 cannot run, or stops with
  an error on an odd value, the port gives the evident intent. The README lists every case.
- v1 reports with a fixed window (last month, last 12 months, since a fixed year) take `from` and
  `to` instead.
- v1 copies that differed by a constant (a province, a lab, a test type) are one report with a
  parameter. Where the copies had different columns, they are separate reports.
- The tables v1 filled (`hivvl`, `tnd`, `eid`, `tbgnx` and others) do not exist in CE. Each report
  rebuilds what it needs from the warehouse on every run.
- Text matches ignore case and trailing spaces, as SQL Server does. Groups merge such spellings.

## VL clients by province

Takes the place of v1's 12 province procedures (`sp_<province>_hivvl_clients_month` and the two
quarterly ones). Pick a province, or leave it blank for all, and a date range. A month or a quarter
is a date range.

Columns, in v1's order: Province, District, Facility, LabID, Name, AgeInYears, Gender, ARTNumber,
CollectedDate, RegisteredDate, ResultDate, Result, Suppressed.

It lists, for the range:

- every valid viral load result, by result date. Suppressed is Yes under 1000 copies, or for a
  not-detected or under-limit text on Zambia's list (for example "Target Not Detected" or
  "<20 copies/mL").
- every rejected viral load request (HIVVL), by registered date, with Result `REJECTED`. It leaves
  out requests already listed as valid.
- every viral load result (HIVVL) that is neither a number nor one of Zambia's listed under-limit or
  over-limit texts (for example "< 20" or "> 10000000"), by result date, as written. It leaves out
  requests already listed as valid.

Differences from v1 that belong to this report:

- Gender and RegisteredDate are always filled. v1 left them blank for some results. CollectedDate
  and ResultDate are empty when the report has no date.
- Rejected means a cancelled result. v1 also counted statuses Y and Z.
- The ART number is built as v1 builds it, from the reference number, else the unique ID. v1 also
  used a hospital number, which CE does not receive yet.
- v1 kept results from 2017-01-01 only. This report has no such floor. The date range decides.

## The facility register

Each facility has its MFL code, name, province, district, status, ownership and ward. Where the list
has a valid pair inside Zambia, it also has latitude and longitude. The build leaves out 42 pairs
that are not valid or fall outside Zambia (for example a position in Paris). Status comes from the
list's operational status. Functional is active. Closed and Permanent closure are inactive.
Temporarily closure is suspended. In CE a facility's status is information only. An inactive
facility is still listed and reported.

The register keeps six more list values in each facility's `extras`, as the list has them, trimmed of
spaces: `hims_code`, `dhis2_uid`, `type`, `ownership_type`, `constituency` and `location`. Reports
read `hims_code` for v1's MOHFacilityCode (the recency lists and the VRDSS feeds) and `type` for the
facility type.

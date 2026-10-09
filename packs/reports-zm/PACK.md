# Zambia reports

Zambia's v1 reports in OpenLDR CE, for data exported from DISA*Lab. This version has the Zambia
health facility register and one report. Later versions add more of Zambia's reports.

## What it installs

1. The facility register `urn:openldr:zm:facilities`, code `ZMFAC`. It has 3,788 facilities from
   Zambia's master facility list (August 2026), keyed on the MFL code.
2. The query "VL clients by province".

Installing again is safe. It updates the register rows and replaces the query. A query you edited
under the same name is overwritten.

## The facility register

Each facility has its MFL code, name, province, district, status, ownership and ward. Where the list
has a valid pair inside Zambia, it also has latitude and longitude. The build leaves out 42 pairs
that are not valid or fall outside Zambia (for example a position in Paris). Status comes from the list's operational
status. Functional is active. Closed and Permanent closure are inactive. Temporarily closure is
suspended. In CE a facility's status is information only. An inactive facility is still listed and
reported.

The register keeps six more list values in each facility's `extras`, as the list has them, trimmed of spaces:
`hims_code`, `dhis2_uid`, `type`, `ownership_type`, `constituency` and `location`.

**Map your lab's facility codes.** DISA*Lab names facilities with its own codes, not MFL codes, so
the pack cannot link them for you. In CE, open Facilities and map each requesting facility code to
its register row. CE suggests matches by name. A request from an unmapped facility does not appear
in the report.

## VL clients by province

One query in place of v1's 12 province procedures (`sp_<province>_hivvl_clients_month` and the two
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

A report run refuses to return more than 1000 rows. The Query page pages through more. For a big
range, narrow the dates or pick a province.

## How it differs from v1

- Province, District and Facility names come from the master facility list, not from v1's
  dictionary. Some spellings can differ.
- Gender and RegisteredDate are always filled. v1 left them blank for some results. CollectedDate
  and ResultDate are empty when the report has no date.
- Rejected means a cancelled result. v1 also counted statuses Y and Z, which reach CE only as
  "unknown", so they cannot be picked out.
- The ART number is built as v1 builds it, from the reference number, else the unique ID. v1 also
  used a hospital number, which CE does not receive yet.
- v1 kept results from 2017-01-01 only. This query has no such floor. The date range decides.
- The DISA*Lab data export for Zambia has to be checked first against Zambia's own DISA*Lab and v1
  data. Until then results carry no status or result date, and the report is empty.

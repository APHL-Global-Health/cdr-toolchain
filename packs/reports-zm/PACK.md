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
has a valid pair, it also has latitude and longitude. Status comes from the list's operational
status. Functional is active. Closed and Permanent closure are inactive. Temporarily closure is
suspended. In CE a facility's status is information only. An inactive facility is still listed and
reported.

The register keeps six more list values in each facility's `extras`, exactly as the list has them:
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

- every valid viral load result, by result date. Suppressed is Yes under 1000 copies or for a
  below-limit text.
- every rejected viral load request, by registered date, with Result `REJECTED`.
- every result that is neither a number nor a below-limit text, by result date, as written.

A report run stops at 1000 rows. Narrow the dates or pick a province for a big range.

## How it differs from v1

- Province, District and Facility names come from the master facility list, not from v1's
  dictionary. Some spellings can differ.
- Gender, CollectedDate and RegisteredDate are always filled. v1 left them blank for some results.
- Rejected means a cancelled result. v1 also counted statuses Y and Z, which reach CE only as
  "unknown", so they cannot be picked out.
- The ART number is built as v1 builds it, from the reference number, else the unique ID. v1 also
  used a hospital number, which CE does not receive yet.
- v1 kept results from 2017-01-01 only. This query has no such floor. The date range decides.
- The data must come from a DISA*Lab that cdr-toolchain has measured. Until then results have no
  status or result date, and the report is empty.

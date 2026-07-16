// PIN THE HOST TIMEZONE — load-bearing, must run before the assertions below.
//
// The property under test is "use the Date's UTC components, never its LOCAL
// components". On a UTC host those two are IDENTICAL for every possible input,
// so a local-getters implementation is indistinguishable from a correct one and
// NO choice of fixture can tell them apart. The only way to observe the
// difference is to run under a non-UTC zone. We pin Africa/Dar_es_Salaam: it is
// the real deployment zone (UTC+3) and observes no DST, so its offset is a
// constant -180 year-round.
//
// Verified on Node 24: assigning process.env.TZ resets ICU's default zone at
// runtime, even after Dates already exist. If that ever stops holding, the
// "TZ pin took effect" test below fails LOUDLY rather than letting the guards
// silently degrade into no-ops.
process.env.TZ = "Africa/Dar_es_Salaam";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpecimenRecpt } from "disalab";
import { disaDatestampToIso, toV2 } from "./v2-transform.js";
import { DEFAULT_SITE } from "./site-config.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";

const PINNED_OFFSET_MINUTES = -180; // UTC+3

// GUARD THE GUARD: if the TZ pin silently fails to take, every local-vs-UTC
// assertion below becomes vacuous (they would pass against a local-getters
// mutant). Fail loudly here instead of reporting a false GREEN.
test("TZ pin took effect (else the mutation guards below are vacuous)", () => {
  const probe = new Date(Date.UTC(2019, 0, 23, 15, 56, 42));
  assert.equal(
    probe.getTimezoneOffset(),
    PINNED_OFFSET_MINUTES,
    `process.env.TZ pin did not take: expected UTC+3 (offset ${PINNED_OFFSET_MINUTES}), got ${probe.getTimezoneOffset()}. ` +
      `The timezone assertions in this file cannot distinguish UTC from local components on a UTC host, ` +
      `so they are NOT guarding anything until this passes. Pin TZ before the process starts.`,
  );
});

// Measured against DisalabData.TESTDATA: SQL `2019-01-23 15:56:42.257` is read by
// mssql/tedious (useUTC = its default) into a Date whose UTC components ARE the
// wall-clock digits DISA stored. We must return those digits, UNZONED.
// Under the pinned UTC+3 zone a local-getters impl yields 18:56:42 — caught.
test("disaDatestampToIso returns the stored wall-clock, unzoned", () => {
  const d = new Date(Date.UTC(2019, 0, 23, 15, 56, 42, 257));
  assert.equal(disaDatestampToIso(d), "2019-01-23T15:56:42");
});

// Second guard, DIFFERENT input: a late-evening stamp that rolls the DATE over
// under the pinned +3 zone (local getters give 2019-01-24T01:30:05). This pins
// the calendar date, not just the clock — a rollover bug reddens this test alone.
// It also documents the `Z` hazard: a full toISOString() returns "...05.001Z",
// and fhirDateTime passes an already-zoned value straight through, which would
// silently declare Tanzania local time to be UTC and shift every timestamp.
test("disaDatestampToIso keeps the UTC calendar date across a local day rollover, with no zone suffix", () => {
  const d = new Date(Date.UTC(2019, 0, 23, 22, 30, 5, 1));
  const out = disaDatestampToIso(d);
  assert.equal(out, "2019-01-23T22:30:05");
  assert.equal(out?.endsWith("Z"), false);
  assert.equal(/[+-]\d{2}:\d{2}$/.test(out ?? ""), false);
});

test("disaDatestampToIso returns null for null and for an invalid Date", () => {
  assert.equal(disaDatestampToIso(null), null);
  assert.equal(disaDatestampToIso(new Date(Number.NaN)), null);
});

// ---------- wiring: buildLabResults.result_timestamp -----------------------
//
// buildLabResults is private, so these drive it through the public toV2. The
// fixture mirrors v2-transform-exclude.test.ts: flattenDisa reads TESTCODE /
// TESTINDEX / DATESTAMP plus ORDER[i].{Code,Type,Value,RawValue,IsResulted,
// Description}. Type char code 1 = Real (numeric), which passes the structural
// filters. ORDER is a plain array — flattenDisa's Array.isArray branch.
//
// These inherit the TZ pin at the top of this file, and that pin is what makes
// them guards: under UTC+3 a local-getters extractor yields "2019-01-23T18:56:42",
// so the exact-equality assertion below reddens. On a UTC host it could not.
function datestampFixture(datestamp: Date | null): SpecimenRecpt {
  const numericType = String.fromCharCode(1);
  return ({
    LabNumber: "TEST001",
    TestOrders: ["HIVVL"],
    TestResults: [
      {
        TESTCODE: "HIVVL",
        TESTINDEX: 1,
        DATESTAMP: datestamp,
        ORDER: [
          {
            Code: "HIVVC",
            Type: numericType,
            Value: "456",
            RawValue: "",
            IsResulted: true,
            Description: null,
          },
        ],
      },
    ],
    Facility: null,
    WardClinic: null,
    WardClinicResolved: null,
    FolderNo: null,
    LastName: null,
    MiddleName: null,
    FirstName: null,
    Sex: null,
    Phone: null,
    Work: null,
    Mobile: null,
    Email: null,
    Address: null,
    ICD10: null,
    Therapy: null,
    TherapyText: null,
    ClinicalDiagnosis: null,
    ClinicalDiagnosisText: null,
    Specimen: null,
    Condition: null,
    TakenDateTime: null,
    CollectedDateTime: null,
    ReceivedInLabDateTime: null,
    RegisteredDateTime: null,
    CollectedBy: null,
    TakenBy: null,
    ReceivedInLabBy: null,
    Priority: null,
    DoctorCode: null,
    Doctor: null,
    DobAge: null,
    NID: null,
  } as unknown) as SpecimenRecpt;
}

function firstResult(datestamp: Date | null) {
  const payload = toV2(datestampFixture(datestamp), {
    prefix: "",
    site: DEFAULT_SITE,
    codebook: stubCodebook({ panels: { HIVVL: "HIVVL HIV Viral Load" } }),
  });
  assert.equal(payload.lab_results.length, 1, "fixture should yield exactly one lab_result");
  return payload.lab_results[0]!;
}

// The bug this pins: result_timestamp was a hardcoded `null` stub, so every
// ingested Observation carried no time and the AMR date-range reports returned
// zero rows silently. Exact equality — truthiness would also "pass" on a stub
// that returned some other timestamp, and the pre-fix value is null.
test("toV2 carries TESTDATA.DATESTAMP into lab_results[].result_timestamp", () => {
  const r = firstResult(new Date(Date.UTC(2019, 0, 23, 15, 56, 42)));
  assert.equal(r.result_timestamp, "2019-01-23T15:56:42");
});

test("toV2 leaves result_timestamp null when the panel has no DATESTAMP", () => {
  const r = firstResult(null);
  assert.equal(r.result_timestamp, null);
});

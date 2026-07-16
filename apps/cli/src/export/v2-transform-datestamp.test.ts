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
import { disaDatestampToIso } from "./v2-transform.js";

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

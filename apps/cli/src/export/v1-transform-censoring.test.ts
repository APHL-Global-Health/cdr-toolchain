import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpecimenRecpt } from "disalab";
import { toV1 } from "./v1-transform.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";

// Type byte 1 (Real) is a numeric item. Type byte 3 is a coded comment.
const numericType = String.fromCharCode(1);
const codedType = String.fromCharCode(3);

const makeItem = (code: string, value: string, type = numericType) => ({
  Code: code,
  Type: type,
  Value: type === numericType ? Number(value) : value,
  RawValue: type === numericType ? "" : value,
  IsResulted: true,
  Description: null,
});

function specimenFixture(item: unknown): SpecimenRecpt {
  return ({
    LabNumber: "TEST001",
    TestOrders: ["RNAHF"],
    TestResults: [{ TESTCODE: "RNAHF", TESTINDEX: 1, DATESTAMP: null, ORDER: [item] }],
    Facility: null,
    WardClinic: null,
    WardClinicResolved: null,
  } as unknown) as SpecimenRecpt;
}

const run = (item: unknown, params: Record<string, { lowLimit: number | null; highLimit: number | null }>) =>
  toV1(specimenFixture(item), {
    prefix: "TZDISA",
    codebook: stubCodebook({ panels: { RNAHF: "RNA HF" }, params }),
    auditRows: [],
  }).lab_results[0]!;

const LIMITS = { HIVVM: { lowLimit: 20, highLimit: 10000000 } };

test("a numeric result below the low limit shows as v1 shows it, and SIValue keeps the measured value", () => {
  const row = run(makeItem("HIVVM", "0"), LIMITS);
  assert.equal(row.LIMSRptResult, "< 20");
  assert.equal(row.SIValue, 0);
});

test("a numeric result above the high limit shows the high limit", () => {
  const row = run(makeItem("HIVVM", "12000000"), LIMITS);
  assert.equal(row.LIMSRptResult, "> 10000000");
  assert.equal(row.SIValue, 12000000);
});

test("a numeric result inside the range, or equal to a limit, is unchanged", () => {
  assert.equal(run(makeItem("HIVVM", "540"), LIMITS).LIMSRptResult, "540");
  assert.equal(run(makeItem("HIVVM", "20"), LIMITS).LIMSRptResult, "20");
});

test("a parameter with no limits is unchanged", () => {
  const row = run(makeItem("HIVVM", "0"), { HIVVM: { lowLimit: null, highLimit: null } });
  assert.equal(row.LIMSRptResult, "0");
});

test("a coded result is never censored", () => {
  const row = run(makeItem("HIVVM", "5", codedType), LIMITS);
  assert.equal(row.LIMSRptResult.startsWith("<"), false);
});

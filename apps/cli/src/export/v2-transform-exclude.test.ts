import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpecimenRecpt } from "disalab";
import { toV2 } from "./v2-transform.js";
import { DEFAULT_SITE } from "./site-config.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";
import type { BlobOffsets } from "../config/blob-offsets.js";

const UNCONFIGURED_OFFSETS: BlobOffsets = { reviewerInitials: null, reviewedAt: null };

/**
 * Build a minimal SpecimenRecpt fixture that flattenDisa will yield two
 * DisaObs from:
 *   - panel VIRAL, param ARTRS  (documentation panel — target for exclusion)
 *   - panel HIVVL, param HIVVC  (test panel — should survive)
 *
 * flattenDisa reads:
 *   s.TestResults[]  →  TESTDATA array
 *     .TESTCODE      →  panelCode
 *     .TESTINDEX     →  panelIndex
 *     .DATESTAMP     →  datestamp (null ok)
 *     .ORDER         →  Order<OrderItem> | OrderItem[]
 *       [i].Code       →  paramCode
 *       [i].Type       →  type char (1 byte string; char code 1 = Real/numeric)
 *       [i].Value      →  value (non-empty to pass structural filter)
 *       [i].RawValue   →  rawValue
 *       [i].IsResulted →  must be true (or coded fallback)
 *       [i].Description → paramDesc
 *
 * We supply ORDER as a plain array (not an Order class instance) — flattenDisa's
 * Array.isArray(order) branch handles this case.
 */
function specimenFixture(): SpecimenRecpt {
  // Numeric type byte: char code 1 (Real). Passes all structural filters:
  // not empty, IsResulted=true, not coded/text/date, not stray-status-flag.
  const numericType = String.fromCharCode(1);

  const makeItem = (code: string, value: string) => ({
    Code: code,
    Type: numericType,
    Value: value,
    RawValue: "",
    IsResulted: true,
    Description: null,
  });

  return ({
    LabNumber: "TEST001",
    TestOrders: ["VIRAL", "HIVVL"],
    TestResults: [
      {
        TESTCODE: "VIRAL",
        TESTINDEX: 1,
        DATESTAMP: null,
        ORDER: [makeItem("ARTRS", "123")],
      },
      {
        TESTCODE: "HIVVL",
        TESTINDEX: 2,
        DATESTAMP: null,
        ORDER: [makeItem("HIVVC", "456")],
      },
    ],
    // Remaining SpecimenRecpt fields that toV2 reads — null/empty stubs
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

test("excludeObs drops documentation observations from lab_results", () => {
  const cb = stubCodebook({ panels: { VIRAL: "VIRAL", HIVVL: "HIVVL HIV Viral Load" } });
  const payload = toV2(specimenFixture(), {
    prefix: "",
    site: DEFAULT_SITE,
    codebook: cb,
    excludeObs: (o) => o.panelCode === "VIRAL",
    blobOffsets: UNCONFIGURED_OFFSETS,
  });
  const codes = payload.lab_results.map((r) => r.observation_code.concept_code);
  assert.equal(codes.includes("ARTRS"), false);  // documentation obs excluded
  assert.equal(codes.includes("HIVVC"), true);   // test obs retained
});

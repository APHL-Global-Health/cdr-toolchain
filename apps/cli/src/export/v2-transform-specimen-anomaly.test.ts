import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpecimenRecpt } from "disalab";
import { toV2 } from "./v2-transform.js";
import { DEFAULT_SITE } from "./site-config.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";
import type { AuditReport } from "../audit/types.js";
import type { BlobOffsets } from "../config/blob-offsets.js";

const UNCONFIGURED_OFFSETS: BlobOffsets = { reviewerInitials: null, reviewedAt: null };

// Minimal SpecimenRecpt with one resulted panel and a recorded specimen "B".
function specimenFixture(): SpecimenRecpt {
  const numericType = String.fromCharCode(1);
  const makeItem = (code: string, value: string) => ({
    Code: code, Type: numericType, Value: value, RawValue: "", IsResulted: true, Description: null,
  });
  return ({
    LabNumber: "TEST001",
    TestOrders: ["CSFM"],
    TestResults: [
      { TESTCODE: "CSFM", TESTINDEX: 1, DATESTAMP: null, ORDER: [makeItem("CGLU", "3.5")] },
    ],
    Specimen: "B",
    Facility: null, WardClinic: null, WardClinicResolved: null, FolderNo: null,
    LastName: null, MiddleName: null, FirstName: null, Sex: null, Phone: null,
    Work: null, Mobile: null, Email: null, Address: null, ICD10: null,
    Therapy: null, TherapyText: null, ClinicalDiagnosis: null, ClinicalDiagnosisText: null,
    Condition: null, TakenDateTime: null, CollectedDateTime: null,
    ReceivedInLabDateTime: null, RegisteredDateTime: null, CollectedBy: null,
    TakenBy: null, ReceivedInLabBy: null, Priority: null, DoctorCode: null,
    Doctor: null, DobAge: null, NID: null,
  } as unknown) as SpecimenRecpt;
}

function reportWithMismatch(severity: "warn" | "error"): AuditReport {
  return {
    lab_number: "TEST001", request_id: "TEST001", source: "disa",
    scanned_panels: 1, scanned_observations: 1,
    anomalies: [
      {
        class: "panel_specimen_mismatch", severity,
        message: "Panel \"CSF: MICROSCOPY\" implies csf but recorded specimen \"Blood\" is blood.",
        panel_code: "CSFM",
        details: { corroborated: severity === "warn", observation_count: 1 },
      },
    ],
    max_severity: severity, elapsed_ms: 0,
  };
}

const cb = () => stubCodebook({ panels: { CSFM: "CSF: MICROSCOPY" }, specimens: { B: "Blood" } });

test("corroborated (warn) panel_specimen_mismatch tags specimen with the anomaly system_id, code/display unchanged", () => {
  const payload = toV2(specimenFixture(), {
    prefix: "", site: DEFAULT_SITE, codebook: cb(), auditReport: reportWithMismatch("warn"),
    blobOffsets: UNCONFIGURED_OFFSETS,
  });
  const spec = payload.lab_requests[0]!.specimen_code;
  assert.ok(spec, "expected specimen_code");
  assert.equal(spec.system_id, "DEFAULT_SPEC_ANOMALY");
  assert.equal(spec.concept_code, "B");
  assert.equal(spec.display_name, "Blood");
});

test("no audit report leaves the specimen on the default system_id", () => {
  const payload = toV2(specimenFixture(), {
    prefix: "", site: DEFAULT_SITE, codebook: cb(),
    blobOffsets: UNCONFIGURED_OFFSETS,
  });
  assert.equal(payload.lab_requests[0]!.specimen_code?.system_id, "DEFAULT_SPEC");
});

test("an error-level (uncorroborated) mismatch does NOT tag the specimen (it would quarantine, not migrate)", () => {
  const payload = toV2(specimenFixture(), {
    prefix: "", site: DEFAULT_SITE, codebook: cb(), auditReport: reportWithMismatch("error"),
    blobOffsets: UNCONFIGURED_OFFSETS,
  });
  assert.equal(payload.lab_requests[0]!.specimen_code?.system_id, "DEFAULT_SPEC");
});

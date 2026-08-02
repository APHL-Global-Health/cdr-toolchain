// TZ PIN — see the header of v2-mapping.test.ts for the full rationale.
// dateToLocalIso (v2-transform.ts) is REQUIRED to read LOCAL getters
// (getFullYear, getHours, ...) because decodeLongDatetime builds its Date
// with the local constructor `new Date(y, m, d, h, mi, 0)`. On a UTC host,
// local and UTC getters agree and this test would pass either way — pinning
// to a non-UTC, non-DST zone (Africa/Dar_es_Salaam, constant -180) is what
// makes the getter family observable. Node's test runner is process-per-file,
// so this cannot leak into other suites.
process.env.TZ = "Africa/Dar_es_Salaam";

import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpecimenRecpt } from "disalab";
import { TestDataHeader, HEADER_LENGTH } from "disalab";
import { toV2 } from "./v2-transform.js";
import { DEFAULT_SITE } from "./site-config.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";
import type { BlobOffsets } from "../config/blob-offsets.js";

// Asserts the OUTCOME (the offset), not the mechanism, so this suite cannot
// pass while the pin is silently ineffective.
test("TZ pin took effect", () => {
  assert.equal(new Date("2018-05-18").getTimezoneOffset(), -180);
});

const CONFIGURED_OFFSETS: BlobOffsets = {
  reviewerInitials: { start: 77, end: 80 },
  reviewedAt: { start: 21, kind: "long-datetime" },
};

const numericType = String.fromCharCode(1);

const makeItem = (code: string, value: string) => ({
  Code: code,
  Type: numericType,
  Value: value,
  RawValue: "",
  IsResulted: true,
  Description: null,
});

/**
 * Build an 80-byte TESTDATA_STATUS header with:
 *   - bytes 77-79 = reviewer initials "APB" (non-empty ⇒ reviewed)
 *   - bytes 21-26 = a long-datetime encoding of 2018-05-18 09:00 local
 *
 * decodeLongDate (compare/disa-datetime-candidates.ts) reads offset..offset+4
 * via Core.FromDisaDate: byte0=day, byte1=month, byte2=year%256, byte3=floor(year/256).
 * For 2018: 2018 = 226 + 7*256.
 * decodeLongTime reads offset+4..offset+6: byte0=minutes, byte1=hours.
 */
function buildHeader(): TestDataHeader {
  const buf = Buffer.alloc(HEADER_LENGTH, 0);
  // reviewer initials, bytes 77-79
  buf[77] = 65; // 'A'
  buf[78] = 80; // 'P'
  buf[79] = 66; // 'B'
  // long-datetime at offset 21: day, month, year%256, floor(year/256), minutes, hours
  buf[21] = 18; // day
  buf[22] = 5; // month
  buf[23] = 226; // year % 256  (2018 = 226 + 7*256)
  buf[24] = 7; // floor(year / 256)
  buf[25] = 0; // minutes
  buf[26] = 9; // hours
  return TestDataHeader.fromBytes(buf);
}

function specimenFixture(): SpecimenRecpt {
  return ({
    LabNumber: "TEST001",
    TestOrders: ["MRCSW"],
    TestResults: [
      {
        TESTCODE: "MRCSW",
        TESTINDEX: 1,
        DATESTAMP: null,
        HEADER: buildHeader(),
        ORDER: [makeItem("WETP", "1")],
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

test("toV2 with CONFIGURED offsets emits result_status F and a local-form authorised_at", () => {
  const payload = toV2(specimenFixture(), {
    prefix: "",
    site: DEFAULT_SITE,
    codebook: stubCodebook({ panels: { MRCSW: "MC&S" } }),
    blobOffsets: CONFIGURED_OFFSETS,
  });

  assert.equal(payload.lab_requests.length, 1);
  const req = payload.lab_requests[0]!;
  assert.equal(req.result_status, "F");
  // Local-form ISO — no offset, no milliseconds. Must FAIL if dateToLocalIso
  // switches to getUTC* getters (see the TZ-pin comment above).
  assert.equal(req.authorised_at, "2018-05-18T09:00:00");
});

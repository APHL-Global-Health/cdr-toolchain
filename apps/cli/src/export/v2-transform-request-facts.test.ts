// TZ PIN. See the header of v2-transform-review-status.test.ts. dateToLocalIso reads
// local getters, so a non-UTC zone is what makes analysis_at observable.
process.env.TZ = "Africa/Dar_es_Salaam";

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import type { SpecimenRecpt } from "disalab";
import { TestDataHeader, HEADER_LENGTH } from "disalab";
import { toV2 } from "./v2-transform.js";
import { DEFAULT_SITE } from "./site-config.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";
import { loadBlobOffsets, type BlobOffsets } from "../config/blob-offsets.js";
import {
  EMPTY_REQUEST_FACT_CONFIG,
  loadRequestFactConfig,
  type RequestFactConfig,
} from "../config/request-fact-config.js";

const REAL_CONFIG = resolve(import.meta.dirname, "../../../../config");
const TZ_OFFSETS = loadBlobOffsets("tanzania", REAL_CONFIG);
const TZ_FACTS = loadRequestFactConfig("tanzania", REAL_CONFIG);

const UNCONFIGURED_OFFSETS: BlobOffsets = {
  reviewerInitials: null, reviewedAt: null, analysisAt: null, analyzerCode: null, testerInitials: null,
};

test("TZ pin took effect", () => {
  assert.equal(new Date("2018-05-18").getTimezoneOffset(), -180);
});

const numericType = String.fromCharCode(1);
const codedType = String.fromCharCode(0);

const makeItem = (code: string, value: string, rawValue = "", type = numericType) => ({
  Code: code,
  Type: type,
  Value: value,
  RawValue: rawValue,
  IsResulted: true,
  Description: null,
});

function writeAscii(buf: Buffer, start: number, text: string): void {
  for (let i = 0; i < text.length; i++) buf[start + i] = text.charCodeAt(i);
}

/** Long datetime: day, month, year%256, floor(year/256), minutes, hours. */
function writeLongDatetime(buf: Buffer, start: number, y: number, mo: number, d: number, h: number, mi: number): void {
  buf[start] = d;
  buf[start + 1] = mo;
  buf[start + 2] = y % 256;
  buf[start + 3] = Math.floor(y / 256);
  buf[start + 4] = mi;
  buf[start + 5] = h;
}

/** Tanzania header layout: analysis at 15, reviewed at 21, analyser 56-61,
 *  tester 74-77, reviewer 77-80. */
function buildHeader(tester = "SMM", reviewer = "APB"): TestDataHeader {
  const buf = Buffer.alloc(HEADER_LENGTH, 0);
  writeLongDatetime(buf, 15, 2018, 5, 17, 14, 30);
  writeLongDatetime(buf, 21, 2018, 5, 18, 9, 0);
  writeAscii(buf, 56, "ALNK1");
  writeAscii(buf, 74, tester);
  writeAscii(buf, 77, reviewer);
  return TestDataHeader.fromBytes(buf);
}

/** Tanzania registration layout: request type byte 333 (8 = E), age years 414,
 *  age days 417-418 little-endian, newborn bit 2 at 409. */
function buildRegistration(newborn: boolean): string {
  const buf = Buffer.alloc(512, 0);
  buf[333] = 8;
  buf[414] = 3;
  buf.writeUInt16LE(1100, 417);
  if (newborn) buf[409] = 2;
  return buf.toString("latin1");
}

interface Panel { code: string; index: number; items: ReturnType<typeof makeItem>[] }

function specimen(over: Record<string, unknown> = {}, panels?: Panel[], orders?: string[]): SpecimenRecpt {
  const ps = panels ?? [{ code: "HIVVL", index: 1, items: [makeItem("HIVVL", "40")] }];
  return ({
    LabNumber: "TEST001",
    TestOrders: orders ?? ps.map((p) => p.code),
    TestResults: ps.map((p) => ({
      TESTCODE: p.code,
      TESTINDEX: p.index,
      DATESTAMP: null,
      HEADER: buildHeader(),
      ORDER: p.items,
    })),
    Facility: null,
    WardClinic: "PAED",
    WardClinicResolved: "Paediatric Ward",
    FolderNo: "F-123",
    LastName: null,
    MiddleName: null,
    FirstName: null,
    Sex: "F",
    Phone: null,
    Work: null,
    Mobile: null,
    Email: null,
    Address: null,
    ICD10: null,
    Therapy: null,
    TherapyText: "ART",
    ClinicalDiagnosis: null,
    ClinicalDiagnosisText: null,
    Specimen: null,
    Condition: null,
    TakenDateTime: null,
    CollectedDateTime: null,
    ReceivedInLabDateTime: "05/18/2018 09:00",
    RegisteredDateTime: null,
    CollectedBy: null,
    TakenBy: null,
    // The old tested_by source. It must never reach tested_by again.
    ReceivedInLabBy: "RCV",
    Priority: null,
    DoctorCode: null,
    Doctor: null,
    // 18 years before receipt. The blob says 3 years.
    DobAge: "05/18/2000",
    NID: null,
    RegisteredBy: "JKM",
    RegistrationBlob: buildRegistration(true),
    ...over,
  } as unknown) as SpecimenRecpt;
}

const CODEBOOK = stubCodebook({
  panels: { HIVVL: "HIV Viral Load", COL: "Collection", OTHP: "Other", BLNK: "Blank", ODD: "Odd" },
  panelSections: { HIVVL: "V", OTHP: "", ODD: "Q" },
  users: { SMM: "Sarah M. Mushi", APB: "Anna P. Bakari", JKM: "Joseph K. Mrema" },
});

function run(s: SpecimenRecpt, blobOffsets: BlobOffsets, factConfig: RequestFactConfig, codebook = CODEBOOK) {
  return toV2(s, { prefix: "", site: DEFAULT_SITE, codebook, blobOffsets, factConfig });
}

test("configured: header facts, names, section, blob age and request_facts", () => {
  const req = run(specimen(), TZ_OFFSETS, TZ_FACTS).lab_requests[0]!;
  assert.equal(req.analysis_at, "2018-05-17T14:30:00");
  assert.equal(req.tested_by, "Sarah M. Mushi");
  assert.equal(req.authorised_by, "Anna P. Bakari");
  assert.equal(req.section_code, "VR");
  assert.equal(req.age_years, 3, "the blob wins over the date of birth");
  assert.equal(req.age_days, 1100);
  assert.deepEqual(req.source_payload.request_facts, {
    registered_by: "Joseph K. Mrema",
    request_type: "E",
    analyzer_code: "ALNK1",
    point_of_care: "Paediatric Ward",
    attributes: [
      { code: "therapy", valueString: "ART" },
      { code: "ordering-notes", valueString: "F-123" },
      { code: "newborn", valueBoolean: true },
    ],
  });
});

test("initials with no USERDIC6 entry are sent as the initials", () => {
  const req = run(specimen({ RegisteredBy: "ZZZ" }), TZ_OFFSETS, TZ_FACTS, stubCodebook({
    panels: { HIVVL: "HIV Viral Load" },
    panelSections: { HIVVL: "V" },
  })).lab_requests[0]!;
  assert.equal(req.tested_by, "SMM");
  assert.equal(req.authorised_by, "APB");
  assert.equal((req.source_payload.request_facts as { registered_by?: string }).registered_by, "ZZZ");
});

test("a rejected panel carries the RJREA code and reason; its sibling carries neither", () => {
  const payload = run(
    specimen({}, [
      { code: "COL", index: 1, items: [makeItem("RJREA", "Spec contaminated with urine", "CONU", codedType)] },
      { code: "HIVVL", index: 1, items: [makeItem("HIVVL", "40")] },
    ]),
    TZ_OFFSETS,
    TZ_FACTS,
  );
  const byObr = new Map(payload.lab_requests.map((r) => [r.obr_set_id, r]));
  const rejected = byObr.get(1)!.source_payload.request_facts as Record<string, unknown>;
  const sibling = byObr.get(2)!.source_payload.request_facts as Record<string, unknown>;
  assert.equal(rejected.rejection_code, "CONU");
  assert.equal(rejected.rejection_reason, "Spec contaminated with urine");
  assert.equal("rejection_code" in sibling, false);
  assert.equal("rejection_reason" in sibling, false);
});

test("unconfigured: header facts null, date-of-birth age, only offset-free facts", () => {
  const req = run(specimen(), UNCONFIGURED_OFFSETS, EMPTY_REQUEST_FACT_CONFIG).lab_requests[0]!;
  assert.equal(req.analysis_at, null);
  assert.equal(req.tested_by, null);
  assert.equal(req.authorised_by, null);
  assert.equal(req.section_code, null);
  assert.equal(req.age_years, 18, "no registration offsets: the date of birth still gives the age");
  assert.equal(req.age_days, 6574);
  const facts = req.source_payload.request_facts as Record<string, unknown>;
  assert.equal("request_type" in facts, false);
  assert.equal("analyzer_code" in facts, false);
  assert.equal("attributes" in facts, false);
  assert.equal(facts.registered_by, "Joseph K. Mrema");
  assert.equal(facts.point_of_care, "Paediatric Ward");
});

test("point of care falls back to the raw ward code", () => {
  const req = run(specimen({ WardClinicResolved: null }), TZ_OFFSETS, TZ_FACTS).lab_requests[0]!;
  assert.equal((req.source_payload.request_facts as { point_of_care?: string }).point_of_care, "PAED");
});

test("section: blank maps through the \"\" key, else null; an unmapped letter is null", () => {
  const panels: Panel[] = [
    { code: "OTHP", index: 1, items: [makeItem("X1", "1")] },
    { code: "BLNK", index: 1, items: [makeItem("X2", "1")] },
    { code: "ODD", index: 1, items: [makeItem("X3", "1")] },
  ];
  const withBlank = run(specimen({}, panels), TZ_OFFSETS, TZ_FACTS).lab_requests;
  assert.equal(withBlank[0]!.section_code, "OTH", "blank section");
  assert.equal(withBlank[1]!.section_code, "OTH", "null section looks up the blank key too");
  assert.equal(withBlank[2]!.section_code, null, "unmapped letter");

  const noBlankKey: RequestFactConfig = {
    ...TZ_FACTS,
    sectionCodes: new Map([...TZ_FACTS.sectionCodes].filter(([k]) => k !== "")),
  };
  const without = run(specimen({}, panels), TZ_OFFSETS, noBlankKey).lab_requests;
  assert.equal(without[0]!.section_code, null);
  assert.equal(without[1]!.section_code, null);
});

test("newborn is absent from attributes when the bit is clear", () => {
  const req = run(specimen({ RegistrationBlob: buildRegistration(false) }), TZ_OFFSETS, TZ_FACTS).lab_requests[0]!;
  const attrs = (req.source_payload.request_facts as { attributes?: { code: string }[] }).attributes!;
  assert.deepEqual(attrs.map((a) => a.code), ["therapy", "ordering-notes"]);
});

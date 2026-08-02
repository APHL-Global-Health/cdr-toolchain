import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpecimenRecpt } from "disalab";
import { toV2 } from "./v2-transform.js";
import { DEFAULT_SITE } from "./site-config.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";
import type { BlobOffsets } from "../config/blob-offsets.js";

const UNCONFIGURED_OFFSETS: BlobOffsets = { reviewerInitials: null, reviewedAt: null };

/**
 * OBR cardinality fixtures. Fixture shape mirrors v2-transform-exclude.test.ts —
 * ORDER is supplied as a plain array (flattenDisa's Array.isArray branch), and
 * type byte char code 1 (Real) passes every structural filter.
 *
 * ⛔ These pin the measured rules in export/obr-sets.ts:
 *   obr_set_id = 1-based position in TestOrders[]  (99.95% vs v1, n=3,874)
 *   NOT TESTINDEX (93.6%).
 */
const numericType = String.fromCharCode(1);

const makeItem = (code: string, value: string) => ({
  Code: code,
  Type: numericType,
  Value: value,
  RawValue: "",
  IsResulted: true,
  Description: null,
});

interface FixtureOpts {
  TestOrders: string[];
  TestResults: unknown[];
}

function specimenFixture(o: FixtureOpts): SpecimenRecpt {
  return ({
    LabNumber: "TEST001",
    TestOrders: o.TestOrders,
    TestResults: o.TestResults,
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

const opts = () => ({
  prefix: "",
  site: DEFAULT_SITE,
  codebook: stubCodebook({
    panels: { COL: "Collection", RNAHF: "RNA HF", ROTEL: "Rotavirus", MRCSW: "MC&S", MICBM: "Ident", MSENS: "Sensitivity" },
  }),
  blobOffsets: UNCONFIGURED_OFFSETS,
});

test("a 2-panel lab emits 2 lab_requests with dense obr_set_ids", () => {
  const payload = toV2(
    specimenFixture({
      TestOrders: ["COL", "RNAHF"],
      TestResults: [
        { TESTCODE: "COL", TESTINDEX: 1, DATESTAMP: null, ORDER: [makeItem("COLST", "1")] },
        { TESTCODE: "RNAHF", TESTINDEX: 2, DATESTAMP: null, ORDER: [makeItem("HCBFL", "2")] },
      ],
    }),
    opts(),
  );
  assert.deepEqual(payload.lab_requests.map((r) => r.obr_set_id), [1, 2]);
  assert.deepEqual(payload.lab_requests.map((r) => r.panel_code?.concept_code), ["COL", "RNAHF"]);
});

test("an ordered-but-unresulted panel still emits a request, with no results", () => {
  // TDS0109482 — TestOrders ["ROTEL"], TestResults EMPTY, v1 has OBR 1 status I.
  // Today CDR emits NOTHING for this lab: the whole class was invisible to a
  // TestResults-sourced design.
  const payload = toV2(specimenFixture({ TestOrders: ["ROTEL"], TestResults: [] }), opts());
  assert.equal(payload.lab_requests.length, 1);
  assert.equal(payload.lab_requests[0]!.obr_set_id, 1);
  assert.equal(payload.lab_requests[0]!.panel_code?.concept_code, "ROTEL");
  assert.deepEqual(payload.lab_results, []);
});

test("TESTINDEX is not the obr_set_id — a gapped index still yields OBR 1", () => {
  // TDS0083491 — DISA HIVVL#2 -> v1 OBR 1. Emitting TESTINDEX here would emit 2.
  const payload = toV2(
    specimenFixture({
      TestOrders: ["COL"],
      TestResults: [{ TESTCODE: "COL", TESTINDEX: 2, DATESTAMP: null, ORDER: [makeItem("COLST", "1")] }],
    }),
    opts(),
  );
  assert.deepEqual(payload.lab_requests.map((r) => r.obr_set_id), [1]);
});

test("superseded iterations keep their ORDER but carry no results", () => {
  // TZDISATDS0047711 — v1: 5 OBR rows; results under OBR 3 (MRCSW) and 4 (MICBM)
  // only. OBR 1,2 are superseded MRCSW reruns: order present, ZERO results.
  // OBR 5 (MSENS) was ordered and never resulted.
  // ⚠ Both failure modes are SILENT: resurrecting results under OBR 1-2 invents
  // phantom result sets; dropping OBR 1-2 loses real orders.
  const payload = toV2(
    specimenFixture({
      TestOrders: ["MRCSW", "MRCSW", "MRCSW", "MICBM", "MSENS"],
      TestResults: [
        // #1 and #2 are superseded by #3 (same panelCode, later panelIndex)
        { TESTCODE: "MRCSW", TESTINDEX: 1, DATESTAMP: null, ORDER: [makeItem("WETP", "1")] },
        { TESTCODE: "MRCSW", TESTINDEX: 2, DATESTAMP: null, ORDER: [makeItem("WETP", "2")] },
        { TESTCODE: "MRCSW", TESTINDEX: 3, DATESTAMP: null, ORDER: [makeItem("WETP", "3")] },
        { TESTCODE: "MICBM", TESTINDEX: 4, DATESTAMP: null, ORDER: [makeItem("OXID", "4")] },
      ],
    }),
    opts(),
  );
  // all five ORDERS survive
  assert.deepEqual(payload.lab_requests.map((r) => r.obr_set_id), [1, 2, 3, 4, 5]);
  assert.deepEqual(
    payload.lab_requests.map((r) => r.panel_code?.concept_code),
    ["MRCSW", "MRCSW", "MRCSW", "MICBM", "MSENS"],
  );
  // results only under the surviving iteration (OBR 3) and MICBM (OBR 4)
  const withResults = [...new Set(payload.lab_results.map((r) => r.obr_set_id))].sort();
  assert.deepEqual(withResults, [3, 4]);
});

test("a +100 second slot does NOT create an extra request", () => {
  // TDS0012427 — orders [COL,RNAHF]; results COL#1, COL#101, RNAHF#2 -> v1 has 2 rows.
  const payload = toV2(
    specimenFixture({
      TestOrders: ["COL", "RNAHF"],
      TestResults: [
        { TESTCODE: "COL", TESTINDEX: 1, DATESTAMP: null, ORDER: [makeItem("COLST", "1")] },
        { TESTCODE: "COL", TESTINDEX: 101, DATESTAMP: null, ORDER: [makeItem("COLBY", "2")] },
        { TESTCODE: "RNAHF", TESTINDEX: 2, DATESTAMP: null, ORDER: [makeItem("HCBFL", "3")] },
      ],
    }),
    opts(),
  );
  assert.deepEqual(payload.lab_requests.map((r) => r.obr_set_id), [1, 2]);
  assert.deepEqual(payload.lab_requests.map((r) => r.panel_code?.concept_code), ["COL", "RNAHF"]);
});

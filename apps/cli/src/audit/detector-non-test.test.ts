import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, type AuditInputs } from "./detector.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";

function baseInput(over: Partial<AuditInputs>): AuditInputs {
  return {
    labNumber: "ZUL0800028", requestId: "ZUL0800028",
    specimenCode: null, orderedPanels: [], observations: [],
    supersededIterations: [], dobRaw: null, takenAtRaw: null,
    collectedAtRaw: null, receivedAtRaw: null, sex: "F",
    rejected: false, rejectionReason: null,
    documentationPanels: new Set(), ...over,
  };
}

test("specimen_missing suppressed when only documentation panels are ordered", () => {
  const cb = stubCodebook({ panels: { VIRAL: "VIRAL" }, questionnaire: ["ARTRS"] });
  const input = baseInput({
    orderedPanels: ["VIRAL"],
    observations: [{ panelCode: "VIRAL", panelIndex: 1, paramCode: "ARTRS", valueStr: "x", value: "x", type: "", rawValue: {} } as any],
    documentationPanels: new Set(["VIRAL"]),
  });
  const anomalies = detectAnomalies(input, cb);
  assert.equal(anomalies.some((a) => a.class === "specimen_missing"), false);
  assert.equal(anomalies.some((a) => a.class === "routed_as_form"), true);
  assert.equal(anomalies.filter((a) => a.class === "routed_as_form").length, 1);
});

test("specimen_missing still fires when a real test panel lacks a specimen", () => {
  const cb = stubCodebook({ panels: { VIRAL: "VIRAL", HIVVL: "HIVVL HIV Viral Load" } });
  const input = baseInput({
    orderedPanels: ["VIRAL", "HIVVL"],
    observations: [{ panelCode: "HIVVL", panelIndex: 1, paramCode: "HIVVC", valueStr: "LDL", value: "LDL", type: "", rawValue: {} } as any],
    documentationPanels: new Set(["VIRAL"]),
  });
  const anomalies = detectAnomalies(input, cb);
  assert.equal(anomalies.some((a) => a.class === "specimen_missing"), true);
});

test("documentation-only record with no observations emits a single routed_as_form", () => {
  const cb = stubCodebook({ panels: { VIRAL: "VIRAL" } });
  const input = baseInput({
    orderedPanels: ["VIRAL"],
    observations: [],
    documentationPanels: new Set(["VIRAL"]),
  });
  const anomalies = detectAnomalies(input, cb);
  const routed = anomalies.filter((a) => a.class === "routed_as_form");
  assert.equal(routed.length, 1);
  assert.equal(anomalies.some((a) => a.class === "specimen_missing"), false);
  assert.equal(anomalies.some((a) => a.class === "record_has_no_observations"), false);
});

test("documentation panel with no observations is not flagged as orphan", () => {
  const cb = stubCodebook({ panels: { VIRAL: "VIRAL" } });
  const input = baseInput({
    orderedPanels: ["VIRAL"],
    observations: [],
    documentationPanels: new Set(["VIRAL"]),
  });
  const anomalies = detectAnomalies(input, cb);
  assert.equal(anomalies.some((a) => a.class === "orphan_ordered_panel"), false);
  assert.equal(anomalies.filter((a) => a.class === "routed_as_form").length, 1);
});

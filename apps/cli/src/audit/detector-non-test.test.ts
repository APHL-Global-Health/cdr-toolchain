import { test } from "node:test";
import assert from "node:assert/strict";
import { detectAnomalies, type AuditInputs } from "./detector.js";
import { maxSeverity } from "./types.js";
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

test("panel_specimen_mismatch downgrades to warn when the mismatched panel has resulted observations", () => {
  const cb = stubCodebook({
    panels: { CSFM: "CSF: MICROSCOPY" },
    specimens: { B: "Blood" },
  });
  const input = baseInput({
    specimenCode: "B",
    orderedPanels: ["CSFM"],
    observations: [
      { panelCode: "CSFM", panelIndex: 1, paramCode: "APPF", valueStr: "Clear colourless fluid", value: "Clear colourless fluid", type: "", rawValue: {} } as any,
    ],
  });
  const anomalies = detectAnomalies(input, cb);
  const mismatch = anomalies.find((a) => a.class === "panel_specimen_mismatch");
  assert.ok(mismatch, "expected a panel_specimen_mismatch anomaly");
  assert.equal(mismatch.severity, "warn");
  assert.equal((mismatch.details as any).corroborated, true);
  assert.equal((mismatch.details as any).observation_count, 1);
});

test("panel_specimen_mismatch stays error when the mismatched panel has no observations", () => {
  const cb = stubCodebook({
    panels: { CSFM: "CSF: MICROSCOPY" },
    specimens: { B: "Blood" },
  });
  const input = baseInput({
    specimenCode: "B",
    orderedPanels: ["CSFM"],
    observations: [],
  });
  const anomalies = detectAnomalies(input, cb);
  const mismatch = anomalies.find((a) => a.class === "panel_specimen_mismatch");
  assert.ok(mismatch, "expected a panel_specimen_mismatch anomaly");
  assert.equal(mismatch.severity, "error");
  assert.equal((mismatch.details as any).corroborated, false);
});

test("multi-specimen order (blood specimen, resulted CSF panels) migrates: mismatches are warn, max severity not error", () => {
  const cb = stubCodebook({
    panels: {
      FBCP: "Full Blood Count & Platelets",
      CSFM: "CSF: MICROSCOPY",
      CSFCU: "CSF: CULTURE",
      CSFCH: "CSF: BIOCHEMISTRY",
    },
    specimens: { B: "Blood" },
  });
  const input = baseInput({
    specimenCode: "B",
    orderedPanels: ["FBCP", "CSFM", "CSFCU", "CSFCH"],
    observations: [
      { panelCode: "FBCP", panelIndex: 1, paramCode: "WCC", valueStr: "5", value: 5, type: "", rawValue: {} } as any,
      { panelCode: "CSFM", panelIndex: 1, paramCode: "APPF", valueStr: "Clear", value: "Clear", type: "", rawValue: {} } as any,
      { panelCode: "CSFCU", panelIndex: 1, paramCode: "REM", valueStr: "No growth", value: "No growth", type: "", rawValue: {} } as any,
      { panelCode: "CSFCH", panelIndex: 1, paramCode: "CGLU", valueStr: "3.5", value: 3.5, type: "", rawValue: {} } as any,
    ],
  });
  const anomalies = detectAnomalies(input, cb);
  const mismatches = anomalies.filter((a) => a.class === "panel_specimen_mismatch");
  assert.equal(mismatches.length, 3);
  assert.ok(mismatches.every((a) => a.severity === "warn"));
  assert.notEqual(maxSeverity(anomalies), "error");
});

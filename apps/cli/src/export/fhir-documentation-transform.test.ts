import { test } from "node:test";
import assert from "node:assert/strict";
import { documentationResources } from "./fhir-documentation-transform.js";

const docConfig = {
  panels: new Set(["VLID"]),
  params: new Set<string>(),
  forms: new Map([["VLID", "hiv_vl_documentation"]]),
};
const codebook = { paramEntry: (code: string) => ({ description: `desc-${code}` }) };

const baseCtx = {
  patientRef: "Patient/req1",
  basedOnRef: "ServiceRequest/req1-obr1",
  authored: "2026-01-01T00:00:00+02:00",
  docConfig,
  codebook,
};

test("builds a Questionnaire + QuestionnaireResponse for one documentation form", () => {
  // `type` is the raw 1-char DISA OrderItem.Type BYTE (see isNumericTypeChar:
  // charCode 1/2 = numeric), not a mnemonic letter — "T" here is any
  // non-numeric byte, "\x02" is the Int type code.
  const obs = [
    { panelCode: "VLID", paramCode: "VL_REASON", valueStr: "Routine", value: "Routine", type: "T" },
    { panelCode: "VLID", paramCode: "VL_COUNT", valueStr: "40", value: 40, type: "\x02" },
  ];
  const out = documentationResources(obs, baseCtx as never);

  const q = out.find((r) => r.resourceType === "Questionnaire") as Record<string, unknown>;
  assert.equal(q.url, "urn:openldr:form:hiv_vl_documentation");
  assert.equal(q.name, "hiv_vl_documentation");
  assert.equal(q.status, "active");

  const qr = out.find((r) => r.resourceType === "QuestionnaireResponse") as Record<string, unknown>;
  assert.equal(qr.status, "completed");
  assert.equal(qr.questionnaire, "urn:openldr:form:hiv_vl_documentation");
  assert.deepEqual(qr.subject, { reference: "Patient/req1" });
  assert.equal(qr.authored, "2026-01-01T00:00:00+02:00");
  assert.deepEqual(qr.basedOn, [{ reference: "ServiceRequest/req1-obr1" }]);

  const items = qr.item as { linkId: string; answer?: { valueString?: string; valueDecimal?: number }[] }[];
  assert.deepEqual(items.map((i) => i.linkId), ["VL_REASON", "VL_COUNT"]);
  assert.deepEqual(items[0]!.answer, [{ valueString: "Routine" }]);
  assert.deepEqual(items[1]!.answer, [{ valueDecimal: 40 }]);
});

test("omits basedOn for documentation-only records (null basedOnRef)", () => {
  const out = documentationResources(
    [{ panelCode: "VLID", paramCode: "VL_REASON", valueStr: "Routine", value: "Routine", type: "T" }],
    { ...baseCtx, basedOnRef: null } as never,
  );
  const qr = out.find((r) => r.resourceType === "QuestionnaireResponse") as Record<string, unknown>;
  assert.equal(qr.basedOn, undefined);
});

test("returns [] when there are no observations", () => {
  assert.deepEqual(documentationResources([], baseCtx as never), []);
});

test("emits one Questionnaire per distinct form_code, deduped", () => {
  const cfg = {
    panels: new Set(["VLID", "ARTID"]),
    params: new Set<string>(),
    forms: new Map([["VLID", "hiv_vl_documentation"], ["ARTID", "hiv_art_documentation"]]),
  };
  const obs = [
    { panelCode: "VLID", paramCode: "A", valueStr: "x", value: "x", type: "T" },
    { panelCode: "VLID", paramCode: "B", valueStr: "y", value: "y", type: "T" },
    { panelCode: "ARTID", paramCode: "C", valueStr: "z", value: "z", type: "T" },
  ];
  const out = documentationResources(obs, { ...baseCtx, docConfig: cfg } as never);
  const questionnaires = out.filter((r) => r.resourceType === "Questionnaire");
  const responses = out.filter((r) => r.resourceType === "QuestionnaireResponse");
  assert.equal(questionnaires.length, 2);
  assert.equal(responses.length, 2);
});

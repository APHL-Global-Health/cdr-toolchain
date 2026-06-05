import { test } from "node:test";
import assert from "node:assert/strict";
import { isDocumentationObs, splitObservations, EMPTY_DOC_CONFIG, type DocConfig } from "./non-test.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";

const docConfig: DocConfig = {
  panels: new Set(["VIRAL"]),
  params: new Set(["ARTNO"]),
  forms: new Map([["VIRAL", "hiv_vl_documentation"]]),
};

test("config panel makes an observation documentation", () => {
  const cb = stubCodebook();
  assert.equal(isDocumentationObs({ panelCode: "VIRAL", paramCode: "ARTRS" }, cb, docConfig), true);
});

test("config param makes an observation documentation", () => {
  const cb = stubCodebook();
  assert.equal(isDocumentationObs({ panelCode: "HIVVL", paramCode: "ARTNO" }, cb, docConfig), true);
});

test("questionnaire heuristic makes an observation documentation", () => {
  const cb = stubCodebook({ questionnaire: ["FEED"] });
  assert.equal(isDocumentationObs({ panelCode: "X", paramCode: "FEED" }, cb, EMPTY_DOC_CONFIG), true);
});

test("a plain test observation is not documentation", () => {
  const cb = stubCodebook();
  assert.equal(isDocumentationObs({ panelCode: "HIVVL", paramCode: "HIVVC" }, cb, docConfig), false);
});

test("splitObservations partitions test vs documentation", () => {
  const cb = stubCodebook();
  const obs = [
    { panelCode: "VIRAL", paramCode: "ARTRS" },
    { panelCode: "HIVVL", paramCode: "HIVVC" },
  ];
  const { test: t, documentation: d } = splitObservations(obs, cb, docConfig);
  assert.deepEqual(t, [{ panelCode: "HIVVL", paramCode: "HIVVC" }]);
  assert.deepEqual(d, [{ panelCode: "VIRAL", paramCode: "ARTRS" }]);
});

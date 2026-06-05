import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFormResponse } from "./forms-transform.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";

test("text observation becomes a text form response", () => {
  const cb = stubCodebook({ params: { ARTRS: { description: "Viral load reason" } } });
  const r = buildFormResponse(
    { panelCode: "VIRAL", paramCode: "ARTRS", valueStr: "Routine Monitoring", value: "Routine Monitoring", type: "", rawValue: { disa_type_code: 5, raw_value: "x" } },
    1,
    cb,
    "DEFAULT_RESULT",
  );
  assert.equal(r.value_type, "text");
  assert.equal(r.text_value, "Routine Monitoring");
  assert.equal(r.numeric_value, null);
  assert.equal(r.concept_code.concept_code, "ARTRS");
  assert.equal(r.concept_code.display_name, "Viral load reason");
  assert.equal(r.ordinal, 1);
});

test("numeric observation becomes a numeric form response", () => {
  const cb = stubCodebook({ params: { ARTNO: { description: "N ART" } } });
  const r = buildFormResponse(
    { panelCode: "VIRAL", paramCode: "ARTNO", valueStr: "504", value: 504, type: String.fromCharCode(1), rawValue: {} },
    2,
    cb,
    "DEFAULT_RESULT",
  );
  assert.equal(r.value_type, "numeric");
  assert.equal(r.numeric_value, 504);
  assert.equal(r.text_value, null);
});

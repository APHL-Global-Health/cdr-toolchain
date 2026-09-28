import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SITE, LAB_SYSTEM_ID, siteWithLab, buildLabConcept } from "./site-config.js";

test("DEFAULT_SITE carries no lab", () => {
  assert.equal(DEFAULT_SITE.testing_facility, null);
  assert.equal(DEFAULT_SITE.lab_system_id, LAB_SYSTEM_ID);
  assert.equal(buildLabConcept(DEFAULT_SITE), null);
});

test("siteWithLab builds a lab concept under the lab system", () => {
  const site = siteWithLab({ code: "TDS", name: "Dar DISA lab" });
  assert.deepEqual(buildLabConcept(site), {
    system_id: "DEFAULT_LAB", concept_code: "TDS", display_name: "Dar DISA lab",
    concept_class: "facility", datatype: "coded",
  });
});

test("a lab with no name displays its code", () => {
  assert.equal(buildLabConcept(siteWithLab({ code: "TDS", name: null }))?.display_name, "TDS");
});

test("siteWithLab leaves every other system id as DEFAULT_SITE has it", () => {
  const { testing_facility: _t, ...rest } = siteWithLab({ code: "TDS", name: null });
  const { testing_facility: _d, ...base } = DEFAULT_SITE;
  assert.deepEqual(rest, base);
});

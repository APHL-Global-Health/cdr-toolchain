import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadRequestFactConfig } from "./request-fact-config.js";

const REAL_CONFIG = resolve(import.meta.dirname, "../../../../config");

function dirWith(country: string | null, attributes: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "cdr-facts-"));
  if (country !== null) writeFileSync(join(dir, "tanzania.yaml"), country);
  if (attributes !== null) writeFileSync(join(dir, "request-attributes.yaml"), attributes);
  return dir;
}

const COUNTRY = `disa_registration_offsets:
  request_type: { offset: 333, values: { 0: D, 8: E } }
  age_years: { offset: 414 }
  age_days: { offset: 417 }
  newborn: { offset: 409, mask: 2 }
hl7_section_codes:
  V: VR
  "": OTH
`;
const ATTRS = `request_attributes:
  therapy: therapy
  folder_number: ordering-notes
  newborn: newborn
`;

test("loads registration offsets, section codes and attribute codes", () => {
  const dir = dirWith(COUNTRY, ATTRS);
  try {
    const c = loadRequestFactConfig("tanzania", dir);
    assert.equal(c.registration.requestType?.offset, 333);
    assert.equal(c.registration.requestType?.values.get(0), "D");
    assert.equal(c.registration.requestType?.values.get(8), "E");
    assert.deepEqual(c.registration.ageYears, { offset: 414 });
    assert.deepEqual(c.registration.ageDays, { offset: 417 });
    assert.deepEqual(c.registration.newborn, { offset: 409, mask: 2 });
    assert.equal(c.sectionCodes.get("V"), "VR");
    assert.equal(c.sectionCodes.get(""), "OTH");
    assert.deepEqual(c.attributeCodes, { therapy: "therapy", folderNumber: "ordering-notes", newborn: "newborn" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unknown country decodes nothing but still gets the shared attribute codes", () => {
  const dir = dirWith(null, ATTRS);
  try {
    const c = loadRequestFactConfig("mozambique", dir);
    assert.equal(c.registration.requestType, null);
    assert.equal(c.registration.ageYears, null);
    assert.equal(c.sectionCodes.size, 0);
    assert.equal(c.attributeCodes.therapy, "therapy");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no attribute file means no attribute is sent", () => {
  const dir = dirWith(COUNTRY, null);
  try {
    assert.deepEqual(loadRequestFactConfig("tanzania", dir).attributeCodes, { therapy: null, folderNumber: null, newborn: null });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects an attribute code outside lowercase-hyphen form", () => {
  const dir = dirWith(COUNTRY, "request_attributes:\n  therapy: Therapy Code\n");
  try {
    assert.throws(() => loadRequestFactConfig("tanzania", dir), /request_attributes/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects a request_type value key that is not a byte value", () => {
  const dir = dirWith("disa_registration_offsets:\n  request_type: { offset: 333, values: { abc: D } }\n", ATTRS);
  try {
    assert.throws(() => loadRequestFactConfig("tanzania", dir), /byte value/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the real config directory carries the Tanzania measurements", () => {
  const c = loadRequestFactConfig("tanzania", REAL_CONFIG);
  assert.equal(c.registration.requestType?.offset, 333);
  assert.equal(c.registration.requestType?.values.get(0), "D");
  assert.equal(c.registration.requestType?.values.get(8), "E");
  assert.deepEqual(c.registration.ageYears, { offset: 414 });
  assert.deepEqual(c.registration.ageDays, { offset: 417 });
  assert.deepEqual(c.registration.newborn, { offset: 409, mask: 2 });
  assert.equal(c.sectionCodes.get("V"), "VR");
  assert.equal(c.sectionCodes.get("HT"), "OTH");
  assert.equal(c.sectionCodes.get(""), "OTH");
  assert.deepEqual(c.attributeCodes, { therapy: "therapy", folderNumber: "ordering-notes", newborn: "newborn" });
});

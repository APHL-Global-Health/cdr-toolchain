import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCountryDocConfig } from "./country-config.js";

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "cdr-cfg-"));
  writeFileSync(
    join(dir, "zambia.yaml"),
    "documentation:\n  panels:\n    - VIRAL\n  forms:\n    VIRAL: hiv_vl_documentation\n",
  );
  return dir;
}

test("loads documentation panels and forms from yaml", () => {
  const dir = fixtureDir();
  try {
    const cfg = loadCountryDocConfig("zambia", dir);
    assert.equal(cfg.panels.has("VIRAL"), true);
    assert.equal(cfg.forms.get("VIRAL"), "hiv_vl_documentation");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undefined country yields empty config", () => {
  const cfg = loadCountryDocConfig(undefined, fixtureDir());
  assert.equal(cfg.panels.size, 0);
});

test("missing country file falls back to empty config", () => {
  const cfg = loadCountryDocConfig("nowhere", fixtureDir());
  assert.equal(cfg.panels.size, 0);
});

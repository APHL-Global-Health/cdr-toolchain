import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadParmdictOffsets } from "./parmdict-offsets.js";

const REAL_CONFIG = resolve(import.meta.dirname, "../../../../config");

function dirWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cdr-parmdict-"));
  writeFileSync(join(dir, "tanzania.yaml"), yaml);
  return dir;
}

const GOOD = `disa_parmdict_offsets: { high_limit: 103, low_limit: 107 }\n`;

test("loads the limit offsets from yaml", () => {
  const dir = dirWith(GOOD);
  try {
    assert.deepEqual(loadParmdictOffsets("tanzania", dir), { highLimit: 103, lowLimit: 107 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unknown country gives null", () => {
  const dir = dirWith(GOOD);
  try {
    assert.equal(loadParmdictOffsets("mozambique", dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("no country gives null", () => {
  assert.equal(loadParmdictOffsets(undefined), null);
});

test("a yaml with no block gives null", () => {
  const dir = dirWith("documentation:\n  panels:\n    - VIRAL\n");
  try {
    assert.equal(loadParmdictOffsets("tanzania", dir), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a non-integer offset is refused", () => {
  const dir = dirWith(`disa_parmdict_offsets: { high_limit: 103.5, low_limit: 107 }\n`);
  try {
    assert.throws(() => loadParmdictOffsets("tanzania", dir), (e: unknown) => (e as { code?: string }).code === "CONFIG_INVALID");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a block missing one offset is refused", () => {
  const dir = dirWith(`disa_parmdict_offsets: { high_limit: 103 }\n`);
  try {
    assert.throws(() => loadParmdictOffsets("tanzania", dir), (e: unknown) => (e as { code?: string }).code === "CONFIG_INVALID");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the real config/tanzania.yaml carries the measured offsets", () => {
  assert.deepEqual(loadParmdictOffsets("tanzania", REAL_CONFIG), { highLimit: 103, lowLimit: 107 });
});

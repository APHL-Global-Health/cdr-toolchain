import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestDataHeader, HEADER_LENGTH } from "disalab";
import { loadBlobOffsets, assertOffsetsPlausible } from "./blob-offsets.js";

function dirWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "cdr-offsets-"));
  writeFileSync(join(dir, "tanzania.yaml"), yaml);
  return dir;
}

const GOOD = `disa_blob_offsets:
  reviewer_initials: { start: 77, end: 80 }
  reviewed_at: { start: 21, kind: long-datetime }
`;

test("loads offsets from yaml", () => {
  const dir = dirWith(GOOD);
  try {
    const o = loadBlobOffsets("tanzania", dir);
    assert.equal(o.reviewerInitials!.start, 77);
    assert.equal(o.reviewerInitials!.end, 80);
    assert.equal(o.reviewedAt?.kind, "long-datetime");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("end is EXCLUSIVE, so end=80 is legal and addresses byte 79", () => {
  const dir = dirWith(GOOD);
  try {
    assert.equal(loadBlobOffsets("tanzania", dir).reviewerInitials!.end, 80);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects an end beyond the header, which would read result payload", () => {
  const dir = dirWith(`disa_blob_offsets:
  reviewer_initials: { start: 77, end: 81 }
`);
  try {
    assert.throws(() => loadBlobOffsets("tanzania", dir), /end/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("rejects start >= end", () => {
  const dir = dirWith(`disa_blob_offsets:
  reviewer_initials: { start: 80, end: 80 }
`);
  try {
    assert.throws(() => loadBlobOffsets("tanzania", dir), /start/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a country with no disa_blob_offsets block decodes NOTHING — no Tanzania fallback", () => {
  const dir = dirWith("documentation:\n  panels:\n    - VIRAL\n");
  try {
    const o = loadBlobOffsets("tanzania", dir);
    assert.equal(o.reviewedAt, null);
    // ⛔ The whole point: an unmeasured deployment must NOT inherit 77-80.
    assert.equal(o.reviewerInitials, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("an unknown country decodes nothing rather than inheriting Tanzania", () => {
  const dir = dirWith(GOOD);
  try {
    assert.equal(loadBlobOffsets("mozambique", dir).reviewerInitials, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- semantic self-check -------------------------------------------------

function header(mut: (b: Buffer) => void): TestDataHeader {
  const b = Buffer.alloc(HEADER_LENGTH, 0);
  mut(b);
  return TestDataHeader.fromBytes(b);
}

const OFFSETS = { reviewerInitials: { start: 77, end: 80 }, reviewedAt: null };

test("self-check passes on plausible printable initials", () => {
  const hs = Array.from({ length: 10 }, () => header((b) => { b[77] = 65; b[78] = 80; b[79] = 66; }));
  assert.doesNotThrow(() => assertOffsetsPlausible(hs, OFFSETS));
});

test("self-check REJECTS non-printable initials — the wrong-offset signature", () => {
  const hs = Array.from({ length: 10 }, () => header((b) => { b[77] = 0x01; b[78] = 0xff; b[79] = 0x7f; }));
  assert.throws(() => assertOffsetsPlausible(hs, OFFSETS), /printable/i);
});

test("self-check tolerates an all-zero sample — not-reviewed is legitimate", () => {
  const hs = Array.from({ length: 10 }, () => header(() => {}));
  assert.doesNotThrow(() => assertOffsetsPlausible(hs, OFFSETS));
});

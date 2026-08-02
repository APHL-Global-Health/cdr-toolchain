import { test } from "node:test";
import assert from "node:assert/strict";
import { TestDataHeader, HEADER_LENGTH } from "./testdata-header.js";
import { TESTDATA } from "./TESTDATA.js";

/** Build a TESTDATA_STATUS blob: 80-byte header + result payload. */
function blob(mutate: (b: Buffer) => void, payload = "PAYLOAD"): Buffer {
  const b = Buffer.alloc(HEADER_LENGTH + payload.length, 0);
  mutate(b);
  b.write(payload, HEADER_LENGTH, "latin1");
  return b;
}

/** The measured Tanzania slot. Passed EXPLICITLY — never baked into the header. */
const SLOT = { start: 77, end: 80 };

test("reviewer initials decode from bytes 77-79 (the observed APB case)", () => {
  const h = TestDataHeader.fromBytes(blob((b) => { b[77] = 65; b[78] = 80; b[79] = 66; }));
  assert.equal(h.initialsAt(SLOT), "APB");
});

test("an all-zero initials slot means NOT reviewed, decoding to null", () => {
  const h = TestDataHeader.fromBytes(blob(() => {}));
  assert.equal(h.initialsAt(SLOT), null);
});

test("a DIFFERENT slot reads different bytes — offsets are honoured per call", () => {
  // Proves the header does not bake in one layout: byte 10 carries "Z".
  const h = TestDataHeader.fromBytes(blob((b) => { b[10] = 90; b[77] = 65; }));
  assert.equal(h.initialsAt({ start: 10, end: 11 }), "Z");
  assert.equal(h.initialsAt(SLOT), "A");
});

test("raw stops at the header boundary and never reads result payload", () => {
  const h = TestDataHeader.fromBytes(blob(() => {}, "ZZZZZZZZ"));
  assert.equal(h.raw.length, HEADER_LENGTH);
});

test("byteAt exposes raw bytes so the Phase 1 search can read uint16LE at 23", () => {
  const h = TestDataHeader.fromBytes(blob((b) => { b.writeUInt16LE(2017, 23); }));
  assert.equal(h.byteAt(23) | (h.byteAt(24) << 8), 2017);
});

test("byteAt returns 0 past the end instead of NaN", () => {
  const h = TestDataHeader.fromBytes(Buffer.alloc(10, 0));
  assert.equal(h.byteAt(79), 0);
});

test("initials slot padded with spaces still reads as not-reviewed", () => {
  const h = TestDataHeader.fromBytes(blob((b) => { b[77] = 32; b[78] = 32; b[79] = 32; }));
  assert.equal(h.initialsAt(SLOT), null);
});

test("TESTDATA.HEADER is populated even without a server, and payload parsing is unchanged", async () => {
  const b = Buffer.alloc(HEADER_LENGTH + 4, 0);
  b[77] = 65; b[78] = 80; b[79] = 66;
  b.write("DATA", HEADER_LENGTH, "latin1");

  // No server ⇒ initialize() returns before OrderItem.Parse, but HEADER must
  // still be set: the header is a property of the bytes, not of the server.
  const t = new TESTDATA(null, "TDS0010012", "HIVVL", 1, b);
  await t.initialize(b);

  assert.equal(t.HEADER?.initialsAt({ start: 77, end: 80 }), "APB");
  assert.deepEqual(t.ORDER, []);
});

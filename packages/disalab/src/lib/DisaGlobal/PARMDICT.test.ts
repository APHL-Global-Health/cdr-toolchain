import { test } from "node:test";
import assert from "node:assert/strict";
import { PARMDICT } from "./PARMDICT.js";

test("Raw keeps the record bytes, including byte 0, so floats can be read", () => {
  const bytes = Buffer.alloc(260, 0);
  bytes.writeFloatLE(1e7, 103);
  bytes.writeFloatLE(20, 107);
  const p = PARMDICT.fromBytes(null, 1, bytes);
  for (let i = 0; i < 4; i++) {
    assert.equal(p.Raw.charCodeAt(103 + i), bytes[103 + i]);
    assert.equal(p.Raw.charCodeAt(107 + i), bytes[107 + i]);
  }
  assert.equal(p.Raw.charCodeAt(0), 0);
  assert.equal(p.Raw.length, 260);
});

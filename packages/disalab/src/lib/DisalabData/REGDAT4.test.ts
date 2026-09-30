import { test } from "node:test";
import assert from "node:assert/strict";
import { REGDAT4 } from "./REGDAT4.js";

function blob(): Buffer {
  const buf = Buffer.alloc(700, 0);
  buf.write("ABC", 135, "latin1"); // registering user initials
  buf[333] = 0;                    // request type byte: must survive as 0
  buf[409] = 2;
  buf[414] = 34;
  buf[417] = 0x82; buf[418] = 0x30; // 12418 little-endian
  return buf;
}

test("Raw keeps every byte, including 0", () => {
  const r = new REGDAT4("TDS0000001", blob());
  assert.equal(r.Raw.length, 700);
  assert.equal(r.Raw.charCodeAt(333), 0);
  assert.equal(r.Raw.charCodeAt(409), 2);
  assert.equal(r.Raw.charCodeAt(417) + 256 * r.Raw.charCodeAt(418), 12418);
});

test("ReceivedBy still decodes the registering user's initials", () => {
  assert.equal(new REGDAT4("TDS0000001", blob()).ReceivedBy, "ABC");
});

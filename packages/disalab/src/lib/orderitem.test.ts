import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderItem } from "./orderitem.js";

const ZERO5 = "\0\0\0\0\0";

test("an entered numeric zero is a result with value 0", () => {
  const item = new OrderItem(1, "HIVVM", ZERO5, 1, null, undefined, undefined, true);
  assert.equal(item.IsResulted, true);
  assert.equal(item.Value, 0);
});

test("a numeric zero that was not entered is not a result", () => {
  const item = new OrderItem(1, "HIVVM", ZERO5, 1, null, undefined, undefined, false);
  assert.equal(item.IsResulted, false);
});

test("a coded item with an empty value stays not resulted when entered is true", () => {
  const item = new OrderItem(3, "HIVVM", ZERO5, 3, null, undefined, undefined, true);
  assert.equal(item.IsResulted, false);
});

/** One 12-byte item: 5 code bytes, type, entered flag at byte 6, 5 value bytes. */
function item12(code: string, type: number, enteredByte: number, value: number[]): string {
  const bytes = Buffer.alloc(12, 0);
  bytes.write(code, 0, "latin1");
  bytes[5] = type;
  bytes[6] = enteredByte;
  value.forEach((v, i) => {
    bytes[7 + i] = v;
  });
  return bytes.toString("latin1");
}

test("Parse reads byte 6 as the entered flag", async () => {
  // Parse gets the item area only (TESTDATA.initialize cuts the 80-byte header
  // before calling it). One trailing NUL satisfies `startIndex + 12 < length`
  // for the second item.
  const data =
    item12("HIVVM", 1, 9, [0, 0, 0, 0, 0]) +
    item12("HIVTL", 1, 0, [0, 0, 0, 0, 0]) +
    "\0";
  // Empty test code skips the PARMDICT lookup, so no server is used.
  const order = await OrderItem.Parse("LAB1", "", 0, data, undefined as never);
  const items = order.ORDERS;
  const vm = items.find((i: OrderItem) => i.Code === "HIVVM")!;
  const tl = items.find((i: OrderItem) => i.Code === "HIVTL")!;
  assert.equal(vm.IsResulted, true);
  assert.equal(vm.Value, 0);
  assert.equal(tl.IsResulted, false);
});

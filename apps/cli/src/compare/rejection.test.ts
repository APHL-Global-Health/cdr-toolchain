import { test } from "node:test";
import assert from "node:assert/strict";
import type { SpecimenRecpt } from "disalab";
import { detectDisaRejection } from "./result-mapping.js";

/**
 * `Condition` is a SPECIMEN-QUALITY descriptor, not a rejection flag.
 *
 * Measured on 900 DISA/TDS labs (2026-07-17), its FULL value set is:
 *     empty  210
 *     'GOOD' 690        <- and nothing else. Not one other value.
 *
 * The old predicate was `condition !== null || reasons.size > 0 || memos.size > 0`,
 * so a specimen recorded as GOOD marked the request REJECTED. Measured effect on
 * a random 158-lab sample: CDR called 141 (89%) rejected; v1 recorded ONE.
 * That is not cosmetic — "rejected" means NO RESULT to downstream consumers and
 * it re-sources panel_code (v2-transform.ts:283-287).
 */
/** Shape per flattenDisa (result-mapping.ts:567-582): TestResults[].ORDER.ORDERS[]. */
function specimen(condition: string | null, orders: { Code: string; Value: string }[] = []): SpecimenRecpt {
  return {
    Condition: condition,
    TestResults:
      orders.length === 0
        ? []
        : [
            {
              TESTCODE: "COL",
              TESTINDEX: 1,
              DATESTAMP: null,
              ORDER: orders.map((o) => ({
                Code: o.Code,
                Value: o.Value,
                RawValue: o.Value,
                Type: " ",
                IsResulted: true,
              })),
            },
          ],
  } as unknown as SpecimenRecpt;
}

test("a GOOD specimen condition is NOT a rejection", () => {
  const r = detectDisaRejection(specimen("GOOD"));
  assert.equal(r.rejected, false);
  assert.equal(r.reason, null);
});

test("an absent condition is not a rejection either", () => {
  assert.equal(detectDisaRejection(specimen(null)).rejected, false);
  assert.equal(detectDisaRejection(specimen("  ")).rejected, false);
});

// The reason must come from the reject fields, never from Condition. With the old
// `reason = condition ?? ...` precedence, a genuinely rejected request reported its
// reason as "GOOD" — the real RJREA text was masked by the quality descriptor.
test("a real rejection reports the REJECT REASON, not the specimen condition", () => {
  const r = detectDisaRejection(
    specimen("GOOD", [{ Code: "RJREA", Value: "Unsuitable for testing" }]),
  );
  assert.equal(r.rejected, true);
  assert.equal(r.reason, "Unsuitable for testing");
});

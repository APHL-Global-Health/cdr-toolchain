import type { SpecimenRecpt } from "disalab";

/** Build the panel sequence the v1 Requests table expects: one entry per
 *  ORDERED panel in the order it was placed (TestOrders), even if no
 *  results were filed for it. This mirrors what real v1 contains —
 *  ordered-but-unfilled panels (e.g. MSENS that didn't get processed)
 *  still get a Requests row so the order history isn't lost. */
export function collectOrderedPanels(specimen: SpecimenRecpt): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of specimen.TestOrders) {
    const code = String(t ?? "").trim();
    if (code.length === 0) continue;
    if (seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

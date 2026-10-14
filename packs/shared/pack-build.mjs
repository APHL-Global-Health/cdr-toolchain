// Helpers shared by the packs' build.mjs scripts.

const clean = (v) => (v == null ? '' : String(v).trim());

export function csvCell(v) {
  const s = clean(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A header line, then one line per row in `cols` order. CRLF, with a final CRLF.
export const toCsv = (rows, cols) =>
  [cols.join(','), ...rows.map((r) => cols.map((h) => csvCell(r[h])).join(','))].join('\r\n') + '\r\n';

// Step summaries for manifest.payload.steps. These rules are copied from summarizeContentPack in
// CE's packages/marketplace/src/content-pack.ts. If one changes, change the other.
export function summarizeStep(step) {
  switch (step.kind) {
    case 'code-system':
    case 'value-set':
      return { kind: step.kind, label: step.resource.name ?? step.resource.url, count: 1 };
    case 'facility-register':
      // The same expression as CE's summarizeContentPack, so the signed step list matches pack.json.
      return { kind: step.kind, label: step.name, count: step.csv.split(/\r?\n/).slice(1).filter((l) => l.trim() !== '').length };
    case 'link-matching':
      return { kind: step.kind, label: step.registerUrl, count: 1 };
    case 'custom-queries':
      return { kind: step.kind, label: step.file.queries.map((q) => q.name).join(', '), count: step.file.queries.length };
    default:
      throw new Error(`unknown step kind ${step.kind}`);
  }
}

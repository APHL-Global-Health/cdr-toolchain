// One-shot generator for the classifier golden snapshot. Reads the already-
// committed COMMDICT[CONTEXT=50] fixture (no database needed) and classifies
// every row with the CURRENT classifier, so a future classifier change shows
// its full blast radius as a diff against this file.
//
//   cd apps/cli && node --import tsx scripts/dump-classify-golden.ts
//
// Regenerate deliberately and REVIEW the diff — this file is meant to catch
// accidental drift, not to be rubber-stamped back to green.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { classify, type OrganismCategory } from "../src/export/codebook.js";

interface Row {
  code: string;
  description: string;
}

const fixturePath = resolve(import.meta.dirname, "../src/export/__fixtures__/commdict-context50.json");
const rows = JSON.parse(readFileSync(fixturePath, "utf8")) as Row[];

const golden: { code: string; description: string; category: OrganismCategory }[] = rows
  .map((r) => ({ code: r.code, description: r.description, category: classify(r.description) }))
  .sort((a, b) => a.code.localeCompare(b.code));

const out = resolve(import.meta.dirname, "../src/export/__fixtures__/commdict-context50-golden.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(golden, null, 2)}\n`, "utf8");

const counts = golden.reduce<Record<string, number>>((acc, g) => {
  acc[g.category] = (acc[g.category] ?? 0) + 1;
  return acc;
}, {});
console.log(`wrote ${golden.length} rows -> ${out}`);
console.log(counts);
process.exit(0);

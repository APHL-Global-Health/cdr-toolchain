import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { classify, type OrganismCategory } from "./codebook.js";

interface Row { code: string; description: string }

const rows: Row[] = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "__fixtures__/commdict-context50.json"), "utf8"),
) as Row[];
const byCode = new Map(rows.map((r) => [r.code, r.description]));

function categoryOf(code: string): OrganismCategory {
  const d = byCode.get(code);
  assert.ok(d !== undefined, `fixture is missing code ${code}`);
  return classify(d);
}

test("the fixture is the dictionary we measured", () => {
  assert.equal(rows.length, 647, "regenerate the fixture if the dictionary changed");
});

test("gram-stain morphology is a bacterial finding, not a negative culture", () => {
  // The bug: NO_GROWTH_RE's bare `negative` matched "Gram negative bacilli", so
  // Gram-negatives — among the most important AMR pathogens — classified as
  // no-growth, and v2-transform.ts:394 then skipped them as AST hosts.
  assert.equal(categoryOf("GNB"), "bacteria");   // Gram negative bacilli
  assert.equal(categoryOf("GNC"), "bacteria");   // Gram negative cocci
  assert.equal(categoryOf("GNDC"), "bacteria");  // Gram negative diplococci
  assert.equal(categoryOf("ANGNC"), "bacteria"); // Anaerobic gram negative coccus
});

test("genuine no-growth results still classify as none", () => {
  assert.equal(categoryOf("NG"), "none");    // No growth
  assert.equal(categoryOf("NG48"), "none");  // No growth after 48 hours
  assert.equal(categoryOf("NBG"), "none");   // No bacterial growth
  assert.equal(categoryOf("GRW7"), "none");  // Nogrowth after 7days Icubation (one word!)
  assert.equal(categoryOf("NF"), "none");    // Normal flora isolated
  assert.equal(categoryOf("BC1"), "none");   // Aerobic culture - Negative
  assert.equal(categoryOf("BC3"), "none");   // Anaerobic cult - negative
});

test("no-growths with words between 'no' and 'growth' are caught", () => {
  // Previously missed: `no\s*growth` cannot match across an intervening word,
  // so these classified as bacteria — i.e. a negative culture became a pathogen.
  assert.equal(categoryOf("NFG"), "none");  // No fungal growth
  assert.equal(categoryOf("NSB"), "none");  // No Signf. bact. growth Repeat
});

test("the 16 missing fungal genera classify as fungus", () => {
  // TORGL is Torulopsis glabrata — the old name for Candida glabrata, a major
  // drug-resistant yeast, previously reported as a bacterium.
  for (const code of ["ABSID", "ACREM", "ALTER", "BIPOL", "CURVU", "EXOJE", "EXOPH",
                      "GEOCA", "GEOTR", "HANAN", "MADGR", "MADMY", "MALFU", "PHIAL",
                      "PHIRI", "PHIVE", "PICET", "RHIZO", "RHODT", "RHOGL", "RHOPI",
                      "RHORU", "SPOSC", "TORGL", "TORIN"]) {
    assert.equal(categoryOf(code), "fungus", `${code} = ${byCode.get(code)}`);
  }
});

test("fungi that already worked still work", () => {
  assert.equal(categoryOf("CANAL"), "fungus");  // Candida albicans
  assert.equal(categoryOf("ASPFU"), "fungus");  // Aspergillus fumigatus
});

test("no code in this dictionary is a parasite", () => {
  // Documents the measured finding (0 parasite codes) and fails loudly if a
  // future dictionary adds one — at which point Slice C needs a parasite code.
  const parasites = rows.filter((r) => classify(r.description) === "parasite");
  assert.deepEqual(parasites, [], "a parasite code appeared — see the classifier spec");
});

test("classification is exhaustive and total", () => {
  // Every row lands in exactly one known bucket; nothing throws.
  const valid = new Set<OrganismCategory>(["bacteria", "fungus", "parasite", "none"]);
  for (const r of rows) assert.ok(valid.has(classify(r.description)), `${r.code} = ${r.description}`);
});

test("every 'No ...' description is a negative finding, not a pathogen", () => {
  // Measured against real v1 data: NP alone occurs 321 times. Previously these
  // classified as `bacteria` — a negative culture reported to GLASS as a pathogen.
  for (const code of ["NBG", "NFG", "NG", "NG48", "NMRS", "NP", "NPB", "NSB", "NSSI"]) {
    assert.equal(categoryOf(code), "none", `${code} = ${byCode.get(code)}`);
  }
});

test("a leading 'No' needs a word boundary — Nocardia is a bacterium", () => {
  // The rule is ^no\b, not ^no. Without the boundary every Nocardia species
  // would silently become a negative culture.
  assert.equal(classify("Nocardia species"), "bacteria");
  assert.equal(classify("Nocardia asteroides"), "bacteria");
});

test("real pathogen-ID values from live v1 classify correctly", () => {
  // Straight from OpenLDRData.dbo.LabResults where LIMSObservationCode='ORGS'.
  assert.equal(classify("Vibrio cholera 01 Ogawa"), "bacteria");
  assert.equal(classify("Shigella flexneri"), "bacteria");
  assert.equal(classify("Salmonella typhi"), "bacteria");
  assert.equal(classify("Neisseria gonorrhoeae"), "bacteria");
  assert.equal(classify("Gram Negative"), "bacteria");   // coded GN — used in v1, absent from the fixture
  assert.equal(classify("No pathogens isolated"), "none");
});

test("classification matches the golden snapshot for all 647 codes", () => {
  // The harness used to assert ~40 hand-picked codes, which is exactly how four
  // no-growth codes (NP/NPB/NMRS/NSSI) hid in plain sight. This pins ALL of them:
  // any classifier change now shows its full blast radius as a diff.
  // Regenerate deliberately with scripts/dump-classify-golden.ts and REVIEW the diff.
  //
  // The hand-written assertions above stay: the golden is generated from the
  // code under test, so it can only detect drift, not wrongness — a golden
  // alone would happily enshrine a bug. The explicit assertions encode what we
  // independently know to be true (GNB is a bacterium; NP is a negative).
  const golden: { code: string; description: string; category: OrganismCategory }[] =
    JSON.parse(readFileSync(resolve(import.meta.dirname, "__fixtures__/commdict-context50-golden.json"), "utf8"));
  assert.equal(golden.length, rows.length, "golden is stale — regenerate it");
  const drift: string[] = [];
  for (const g of golden) {
    const actual = classify(g.description);
    if (actual !== g.category) drift.push(`${g.code} "${g.description}": golden=${g.category} actual=${actual}`);
  }
  assert.deepEqual(drift, [], `classification drifted from the golden snapshot:\n${drift.join("\n")}`);
});

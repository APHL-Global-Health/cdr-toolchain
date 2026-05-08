// Specimen-kind vocabulary used by the panel-vs-specimen mismatch detector.
// Lives in TS (under code review) rather than YAML — matches the project's
// dictionary-driven, no-per-country-config stance documented in
// CDR_TOOLCHAIN.md ("Why no country YAML?"). Tokens are matched
// case-insensitively after splitting the input on /[^a-z]+/.

export type SpecimenKind =
  | "urine"
  | "stool"
  | "blood"
  | "csf"
  | "sputum"
  | "swab"
  | "pus"
  | "tissue"
  | "genital"
  | "body_fluid"
  | "skin_hair_nail";

// Tokens that, when present in a description, mark it as that specimen
// kind. Tokens are matched case-insensitively against the description; any
// token-level overlap counts as a positive hit. Multi-word panel names
// like "MICROSCOPY : Urine" tokenise to find "urine"; "MICROBIOLOGY:
// PERICARDIAL FLUID" hits both "pericardial" and "fluid" (body_fluid).
const KIND_TOKENS: Record<SpecimenKind, readonly string[]> = {
  urine:   ["urine", "ua", "msu", "cscu"],
  stool:   ["stool", "faec", "feces", "rectal"],
  // Plasma / serum / whole-blood are all blood-derived — clinically the
  // same draw, so a "plasma" specimen against a "BLOOD CULTURE" panel is
  // not a mismatch. Keeping them in one kind avoids false positives.
  blood:   ["blood", "bcs", "bldcs", "bact", "bld", "plasma", "serum"],
  csf:     ["csf", "cerebrospinal", "spinal"],
  sputum:  ["sputum", "aspirate", "bal", "ett", "ngt", "bronchial"],
  // "swab" alone is a weak signal — many specimen sites use swabs (eye,
  // ear, nasal, throat). Keep wound here; eye/ear/nasal are intentionally
  // not their own kinds because no panel description distinguishes them.
  swab:    ["swab", "wound"],
  pus:     ["pus", "abscess"],
  tissue:  ["tissue", "biopsy", "bx"],
  genital: ["vaginal", "cervical", "urethral", "semen", "hvs", "evs", "vulval", "penile", "prepuce", "scrotal"],
  // Body fluids — pleural, pericardial, peritoneal, synovial, ascitic, etc.
  // Distinct from blood / csf — they're effusions from body cavities.
  body_fluid: ["pleural", "pericardial", "peritoneal", "synovial", "ascitic", "ascites", "amniotic", "fluid", "effusion"],
  // Skin / nail / hair — separate from "tissue" because they're often
  // listed as their own specimen category and don't pair with biopsy panels.
  skin_hair_nail: ["skin", "nail", "hair"],
};

// Compatibility overrides: even when (panelKinds, specimenKinds) are
// disjoint, treat the pair as acceptable. Add an entry only when real data
// proves a false positive — resist growing this list.
const KIND_COMPATIBLE: ReadonlyArray<readonly [SpecimenKind, SpecimenKind]> = [
  // Wound + pus/tissue: clinically the same workflow.
  ["swab", "pus"],
  ["swab", "tissue"],
  // Genital workflows are usually swabs.
  ["swab", "genital"],
];

const ALL_TOKENS: ReadonlyArray<{ kind: SpecimenKind; token: string }> = (() => {
  const out: { kind: SpecimenKind; token: string }[] = [];
  for (const k of Object.keys(KIND_TOKENS) as SpecimenKind[]) {
    for (const tok of KIND_TOKENS[k]) {
      out.push({ kind: k, token: tok });
    }
  }
  return out;
})();

const COMPAT_SET: ReadonlySet<string> = new Set(
  KIND_COMPATIBLE.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]),
);

/** Tokenise a description and return the set of specimen kinds that any
 *  vocabulary token matches. Empty input → empty set. */
export function extractKinds(text: string | null | undefined): Set<SpecimenKind> {
  const out = new Set<SpecimenKind>();
  if (text === null || text === undefined) return out;
  const lower = text.toLowerCase();
  if (lower.length === 0) return out;
  // Token-substring match: panel descriptions like "MICROSCOPY : Urine" or
  // "MICROBIOLOGY : RECTAL SWAB" need to find "urine" / "rectal" / "swab"
  // even when other punctuation separates them. Substring is safe here
  // because the vocabulary tokens are distinct enough not to collide
  // (e.g. "ua" in "urinalysis" is intentional; "ua" in "vaginal" — no).
  // For very short tokens (≤2 chars) require a word-boundary match to
  // avoid spurious hits like "ua" matching inside "vacuum".
  for (const { kind, token } of ALL_TOKENS) {
    if (token.length <= 2) {
      const re = new RegExp(`\\b${token}\\b`, "i");
      if (re.test(lower)) out.add(kind);
    } else {
      if (lower.includes(token)) out.add(kind);
    }
  }
  return out;
}

/** True when the (panelKinds, specimenKinds) pair has at least one
 *  overlap or one of the compatibility overrides applies. */
export function kindsCompatible(
  panelKinds: ReadonlySet<SpecimenKind>,
  specimenKinds: ReadonlySet<SpecimenKind>,
): boolean {
  for (const k of panelKinds) {
    if (specimenKinds.has(k)) return true;
  }
  for (const a of panelKinds) {
    for (const b of specimenKinds) {
      if (COMPAT_SET.has(`${a}|${b}`)) return true;
    }
  }
  return false;
}

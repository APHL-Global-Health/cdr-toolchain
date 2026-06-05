import type { Codebook, ParmEntry, PanelEntry } from "../export/codebook.js";

export interface StubOpts {
  /** Param codes to treat as questionnaire/metadata. */
  questionnaire?: string[];
  /** paramCode -> ParmEntry overrides. */
  params?: Record<string, Partial<ParmEntry>>;
  /** panelCode -> description. */
  panels?: Record<string, string>;
  /** specimenCode -> description. */
  specimens?: Record<string, string>;
  antibiotics?: string[];
  pathogenIdParams?: string[];
}

export function stubCodebook(opts: StubOpts = {}): Codebook {
  const q = new Set(opts.questionnaire ?? []);
  const abx = new Set(opts.antibiotics ?? []);
  const pid = new Set(opts.pathogenIdParams ?? []);
  return {
    isAntibiotic: (c) => abx.has(c),
    isTbAntibiotic: () => false,
    isPathogenIdParam: (c) => pid.has(c),
    isQuestionnaireParam: (c) => q.has(c),
    paramEntry: (c) => {
      const o = opts.params?.[c];
      if (o === undefined) return undefined;
      return { code: c, description: "", abbreviation: "", context: 0, units: "", reference: "", ...o };
    },
    panelEntry: (c) => {
      const d = opts.panels?.[c];
      if (d === undefined) return undefined;
      return { code: c, description: d, abbreviation: "", section: null } as PanelEntry;
    },
    specimenEntry: (c) => {
      const d = opts.specimens?.[c];
      if (d === undefined) return undefined;
      // CommEntry requires context in addition to code + description.
      return { context: 97, code: c, description: d };
    },
    organismEntry: () => undefined,
    organismCategory: () => "none",
    userEntry: () => undefined,
    stats: { parmRows: 0, testRows: 0, commOrganismRows: 0, commSpecimenRows: 0, userRows: 0 },
  };
}

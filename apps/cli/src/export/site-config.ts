// V2 concept-system identifiers. These are the literal strings v2's mapping
// engine recognises (per temp/default.schema.example.json). Don't substitute
// country-specific names — v2 wouldn't know how to map them.

export interface SiteConfig {
  facility_system_id: string;
  panel_system_id: string;
  specimen_system_id: string;
  /** Default for non-organism, non-antibiotic observations in lab_results. */
  observation_system_id: string;
  /** Used for both isolates[].organism_code AND any organism observation
   *  row that lands in lab_results (e.g. ORGS). */
  organism_system_id: string;
  /** Used for both susceptibility_tests[].antibiotic_code AND any antibiotic
   *  observation row that lands in lab_results (e.g. unknown_antibiotic_code
   *  per PRD §7 — an antibiotic param whose value isn't S/I/R). */
  antibiotic_system_id: string;
  default_guideline: string;
}

export const DEFAULT_SITE: SiteConfig = {
  facility_system_id: "DEFAULT_FAC",
  panel_system_id: "DEFAULT_TEST",
  specimen_system_id: "DEFAULT_SPEC",
  observation_system_id: "DEFAULT_RESULT",
  organism_system_id: "DEFAULT_ORG",
  antibiotic_system_id: "DEFAULT_ABX",
  default_guideline: "CLSI",
};

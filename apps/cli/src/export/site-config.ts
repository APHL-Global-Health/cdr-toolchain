// V2 concept-system identifiers. These are the literal strings v2's mapping
// engine recognises (per temp/default.schema.example.json). Don't substitute
// country-specific names — v2 wouldn't know how to map them.

export interface SiteConfig {
  facility_system_id: string;
  panel_system_id: string;
  specimen_system_id: string;
  /** Coding system for a specimen whose recorded value is known not to apply
   *  to every ordered panel — a DISA single-specimen-per-request collision
   *  (e.g. blood + CSF panels under one "Blood" specimen). Used in place of
   *  `specimen_system_id` when the audit raises a corroborated (warn-level)
   *  `panel_specimen_mismatch`, so the migrated record is queryable in v2 as
   *  an anomalous-specimen case. concept_code / display_name are unchanged —
   *  only the provenance namespace differs. v2 must have this coding system
   *  registered or it hard-rejects with UNKNOWN_CODING_SYSTEM. */
  specimen_anomaly_system_id: string;
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
  specimen_anomaly_system_id: "DEFAULT_SPEC_ANOMALY",
  observation_system_id: "DEFAULT_RESULT",
  organism_system_id: "DEFAULT_ORG",
  antibiotic_system_id: "DEFAULT_ABX",
  default_guideline: "CLSI",
};

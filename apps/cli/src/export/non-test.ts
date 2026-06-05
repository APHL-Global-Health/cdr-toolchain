import type { Codebook } from "./codebook.js";

/** Operator-asserted documentation classifiers for a country deployment. */
export interface DocConfig {
  /** Panel codes whose every observation is documentation. */
  panels: ReadonlySet<string>;
  /** Individual param codes that are documentation regardless of panel. */
  params: ReadonlySet<string>;
  /** panelCode -> logical form code, for the form-submission `form_code`. */
  forms: ReadonlyMap<string, string>;
}

export const EMPTY_DOC_CONFIG: DocConfig = Object.freeze({
  panels: new Set<string>(),
  params: new Set<string>(),
  forms: new Map<string, string>(),
});

export interface ObsLike { panelCode: string; paramCode: string; }

/**
 * An observation is documentation when its panel or param is config-flagged,
 * OR the existing PARMDICT-context heuristic classes the param as
 * questionnaire/metadata. Config is layered ON TOP of the heuristic.
 */
export function isDocumentationObs(o: ObsLike, cb: Codebook, doc: DocConfig): boolean {
  if (doc.panels.has(o.panelCode)) return true;
  if (doc.params.has(o.paramCode)) return true;
  return cb.isQuestionnaireParam(o.paramCode);
}

export interface RecordSplit<T extends ObsLike> {
  /** Real instrument/test observations. */
  test: T[];
  /** Documentation/questionnaire observations. */
  documentation: T[];
}

export function splitObservations<T extends ObsLike>(
  obs: readonly T[],
  cb: Codebook,
  doc: DocConfig,
): RecordSplit<T> {
  const test: T[] = [];
  const documentation: T[] = [];
  for (const o of obs) {
    if (isDocumentationObs(o, cb, doc)) documentation.push(o);
    else test.push(o);
  }
  return { test, documentation };
}

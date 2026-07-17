import type { V2LabRequest, V2LabResult, V2Payload } from "../export/types.js";
import type { OpenLdrV1LabResult, OpenLdrV1Request } from "../openldr.js";
import { V2_REQUEST_FIELDS, V2_RESULT_FIELDS, type V2FieldDef } from "./v2-mapping.js";
import { isEmpty } from "./comparators.js";
import { valueForOutput } from "./diff.js";

/**
 * Mirrors CompareStatus but names the LEFT side honestly. The shared
 * comparators are written for the DISA<->v1 gate and return `only_disa` when the
 * left side is populated and the right is empty; here the left side is the V2
 * export payload, so reporting `only_disa` would name the wrong system in the
 * findings. Translated once, at the boundary.
 */
export type V2CompareStatus = "match" | "mismatch" | "only_v2" | "only_v1";

export interface V2FieldRow {
  field: string;
  v1_column: string;
  status: V2CompareStatus;
  v2: unknown;
  openldr_v1: unknown;
  reason?: string;
}

export interface V2DiffSummary {
  total: number;
  match: number;
  mismatch: number;
  only_v2: number;
  only_v1: number;
}

export interface V2DiffResult {
  fields: V2FieldRow[];
  summary: V2DiffSummary;
}

function compareOne(def: V2FieldDef, p: V2LabRequest, v1: OpenLdrV1Request): V2FieldRow {
  const v2Value = def.getV2(p);
  const v1Value = def.getV1(v1);
  const raw = def.comparator(v2Value, v1Value);

  let status: V2CompareStatus = raw.status === "only_disa" ? "only_v2" : raw.status;
  let reason = raw.reason;

  // CONDITIONAL RULE — not a tolerance. Fires only when V2's value is empty and
  // the rule says empty is the CORRECT value for this v1 state (e.g. a result
  // that was never authorised has no authorisation time). Deliberately narrow:
  //  - only `only_v1` is eligible, so it can never turn a genuine MISMATCH green;
  //  - the V2 side must actually be empty, so it cannot forgive a wrong value.
  // Both guards matter: without them this is `allowDisaEmpty` wearing a lambda.
  if (
    status === "only_v1" &&
    def.emptyIsCorrectWhen !== undefined &&
    isEmpty(v2Value) &&
    def.emptyIsCorrectWhen(v1)
  ) {
    status = "match";
    reason = "empty is correct for this v1 state (conditional rule)";
  }

  const row: V2FieldRow = {
    field: def.field,
    v1_column: def.v1Column,
    status,
    v2: valueForOutput(v2Value),
    openldr_v1: valueForOutput(v1Value),
  };
  if (reason !== undefined) row.reason = reason;
  return row;
}

/**
 * Grade ONE lab_request against ONE v1 OBR row — the gate the toolchain has
 * never had. `diffRecord` (diff.ts) grades the decoder; this grades the export.
 *
 * ⚠ The caller MUST pair them on obr_set_id == OBRSetID. Grading a payload
 * against `fetchRequestByRequestId` (which returns v1's LOWEST OBRSetID,
 * openldr.ts:110) would compare every panel against v1's first OBR — the very
 * defect this slice fixes.
 */
export function diffV2Request(p: V2LabRequest, v1: OpenLdrV1Request): V2DiffResult {
  const fields: V2FieldRow[] = [];
  const summary: V2DiffSummary = { total: 0, match: 0, mismatch: 0, only_v2: 0, only_v1: 0 };

  for (const def of V2_REQUEST_FIELDS) {
    const row = compareOne(def, p, v1);
    summary.total++;
    summary[row.status]++;
    fields.push(row);
  }

  return { fields, summary };
}

export function isV2PerfectMatch(s: V2DiffSummary): boolean {
  return s.mismatch === 0 && s.only_v2 === 0 && s.only_v1 === 0;
}

// ===========================================================================
// RESULT LEVEL
// ===========================================================================

export interface V2ResultPair {
  panel_code: string;
  observation_code: string;
  fields: V2FieldRow[];
}

export interface V2FieldStats {
  match: number;
  mismatch: number;
  only_v2: number;
  only_v1: number;
}

export interface V2ResultDiffSummary {
  observations_v2: number;
  /** v1 observations considered — AFTER the documentation-panel exclusion. */
  observations_v1: number;
  paired: number;
  /** V2 observations with no v1 counterpart. */
  only_v2: number;
  /** v1 observations with no V2 counterpart. */
  only_v1: number;
  /**
   * v1 rows dropped from pairing because they sit under a documentation panel
   * the export routes to the forms feed instead.
   *
   * ⚠ REPORTED, never silently dropped. On DISA/TDS this is 235,845 of 643,855
   * rows (36.6%) — VLID 218,181 + EIDID 17,664, all questionnaire observations
   * ("Is the client pregnant?", "Drug Adherance"). Pairing them would score
   * 36.6% only_v1 and drown every real finding; hiding them would overstate
   * the gate's coverage. Counting them is the only honest option.
   */
  v1_results_documentation_excluded: number;
  per_field: Record<string, V2FieldStats>;
}

export interface V2ResultDiff {
  pairs: V2ResultPair[];
  summary: V2ResultDiffSummary;
}

export interface V2ResultDiffOpts {
  /**
   * The documentation panels the payload was built with. MUST be the same set
   * passed to `toV2`'s excludeObs (via config/<country>.yaml) — with no
   * --country it is EMPTY and toV2 excludes nothing, so the gate must exclude
   * nothing either. If these two drift apart the gate grades a payload that was
   * never built.
   */
  documentationPanels: ReadonlySet<string>;
}

const key = (panel: string, param: string) => `${panel.trim()}\t${param.trim()}`;

function groupByKey<T>(rows: readonly T[], k: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const bucket = m.get(k(r));
    if (bucket === undefined) m.set(k(r), [r]);
    else bucket.push(r);
  }
  return m;
}

/**
 * Grade the V2 export's observation stream against v1's LabResults.
 *
 * Pairing is on `(panel, observation)` — `(source_test_code,
 * observation_code.concept_code)` on the V2 side, `(LIMSPanelCode,
 * LIMSObservationCode)` on v1's. That is the same key `result-diff.ts:349` uses
 * for the DISA<->v1 gate. The plan's `(RequestID, OBRSetID, OBXSetID)` is not
 * buildable: V2LabResult has neither a request id nor an OBRSetID.
 */
export function diffV2Results(
  p: V2Payload,
  v1Rows: readonly OpenLdrV1LabResult[],
  opts: V2ResultDiffOpts,
): V2ResultDiff {
  const summary: V2ResultDiffSummary = {
    observations_v2: 0,
    observations_v1: 0,
    paired: 0,
    only_v2: 0,
    only_v1: 0,
    v1_results_documentation_excluded: 0,
    per_field: {},
  };
  for (const def of V2_RESULT_FIELDS) {
    summary.per_field[def.field] = { match: 0, mismatch: 0, only_v2: 0, only_v1: 0 };
  }

  // --- the documentation-panel scope rule (before anything is paired) ---
  const graded: OpenLdrV1LabResult[] = [];
  for (const r of v1Rows) {
    const panel = (r.LIMSPanelCode ?? "").trim();
    if (opts.documentationPanels.has(panel)) summary.v1_results_documentation_excluded++;
    else graded.push(r);
  }

  const v2Rows = p.lab_results ?? [];
  summary.observations_v2 = v2Rows.length;
  summary.observations_v1 = graded.length;

  const v2ByKey = groupByKey(v2Rows, (r) =>
    key(r.source_test_code ?? "", r.observation_code?.concept_code ?? ""),
  );
  const v1ByKey = groupByKey(graded, (r) =>
    key(r.LIMSPanelCode ?? "", r.LIMSObservationCode ?? ""),
  );

  const pairs: V2ResultPair[] = [];

  for (const [k, v2Bucket] of v2ByKey) {
    const v1Bucket = v1ByKey.get(k) ?? [];
    // Zip within the bucket. A bucket holds repeats of the same panel+param;
    // any overhang on either side is an unpaired observation, not a mismatch.
    const paired = Math.min(v2Bucket.length, v1Bucket.length);
    for (let i = 0; i < paired; i++) {
      pairs.push(compareResultPair(v2Bucket[i]!, v1Bucket[i]!, summary));
      summary.paired++;
    }
    summary.only_v2 += v2Bucket.length - paired;
    summary.only_v1 += Math.max(0, v1Bucket.length - paired);
  }

  // v1 observations whose panel+param never appears in the payload at all.
  for (const [k, v1Bucket] of v1ByKey) {
    if (!v2ByKey.has(k)) summary.only_v1 += v1Bucket.length;
  }

  return { pairs, summary };
}

function compareResultPair(
  v2: V2LabResult,
  v1: OpenLdrV1LabResult,
  summary: V2ResultDiffSummary,
): V2ResultPair {
  const fields: V2FieldRow[] = [];
  for (const def of V2_RESULT_FIELDS) {
    const v2Value = def.getV2(v2);
    const v1Value = def.getV1(v1);
    const raw = def.comparator(v2Value, v1Value);
    const status: V2CompareStatus = raw.status === "only_disa" ? "only_v2" : raw.status;

    summary.per_field[def.field]![status]++;

    const row: V2FieldRow = {
      field: def.field,
      v1_column: def.v1Column,
      status,
      v2: valueForOutput(v2Value),
      openldr_v1: valueForOutput(v1Value),
    };
    if (raw.reason !== undefined) row.reason = raw.reason;
    fields.push(row);
  }
  return {
    panel_code: (v2.source_test_code ?? "").trim(),
    observation_code: (v2.observation_code?.concept_code ?? "").trim(),
    fields,
  };
}

export function isV2ResultPerfectMatch(s: V2ResultDiffSummary): boolean {
  if (s.only_v2 > 0 || s.only_v1 > 0) return false;
  return Object.values(s.per_field).every((f) => f.mismatch === 0 && f.only_v2 === 0 && f.only_v1 === 0);
}

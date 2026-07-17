import type { V2Payload } from "../export/types.js";
import type { OpenLdrV1Request } from "../openldr.js";
import { V2_REQUEST_FIELDS, type V2FieldDef } from "./v2-mapping.js";
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

function compareOne(def: V2FieldDef, p: V2Payload, v1: OpenLdrV1Request): V2FieldRow {
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
 * Grade the V2 export payload against the v1 row — the gate the toolchain has
 * never had. `diffRecord` (diff.ts) grades the decoder; this grades the export.
 */
export function diffV2Request(p: V2Payload, v1: OpenLdrV1Request): V2DiffResult {
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

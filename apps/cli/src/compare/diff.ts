import type { SpecimenRecpt } from "disalab";
import type { OpenLdrV1Request } from "../openldr.js";
import { getRequestFields, type RequestFieldsOptions } from "./mapping.js";
import { isEmpty, type CompareStatus } from "./comparators.js";

export interface FieldRow {
  field: string;
  status: CompareStatus;
  disa: unknown;
  openldr_v1: unknown;
  reason?: string;
  note?: string;
}

export interface DiffSummary {
  total: number;
  match: number;
  mismatch: number;
  only_disa: number;
  only_v1: number;
}

export interface DiffResult {
  fields: FieldRow[];
  summary: DiffSummary;
}

export function valueForOutput(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return v;
}

export function diffRecord(
  disa: SpecimenRecpt,
  v1: OpenLdrV1Request,
  opts: RequestFieldsOptions,
): DiffResult {
  const fields: FieldRow[] = [];
  const summary: DiffSummary = {
    total: 0,
    match: 0,
    mismatch: 0,
    only_disa: 0,
    only_v1: 0,
  };

  const requestFields = getRequestFields(opts);
  for (const def of requestFields) {
    const disaRaw = def.getDisa(disa);
    const disaCandidates = Array.isArray(disaRaw) ? disaRaw : [disaRaw];
    const v1Raw = def.getV1(v1);
    const v1Candidates = Array.isArray(v1Raw) ? v1Raw : [v1Raw];

    // Try every DISA × v1 pair. The first match wins; otherwise the
    // primary pair (disaCandidates[0], v1Candidates[0]) is what we
    // report — matches the previous "first candidate is canonical"
    // behaviour for single-valued fields.
    let result = def.comparator(disaCandidates[0], v1Candidates[0]);
    let chosenDisa: unknown = disaCandidates[0];
    let chosenV1: unknown = v1Candidates[0];
    let matchedDisaFallback = false;
    let matchedV1Fallback = false;
    outer: for (let i = 0; i < disaCandidates.length; i++) {
      for (let j = 0; j < v1Candidates.length; j++) {
        if (i === 0 && j === 0) continue;
        const alt = def.comparator(disaCandidates[i], v1Candidates[j]);
        if (alt.status === "match") {
          result = alt;
          chosenDisa = disaCandidates[i];
          chosenV1 = v1Candidates[j];
          matchedDisaFallback = i > 0;
          matchedV1Fallback = j > 0;
          break outer;
        }
      }
      if (result.status === "match") break;
    }

    // Field-level escape hatch: when every DISA candidate is empty and the
    // field opts in, downgrade a final `only_v1` to a `match`. Used for
    // fields where v1 stores data DISA has no source for (e.g.
    // received_at — v2 can't reproduce what isn't there).
    if (
      def.allowDisaEmpty === true &&
      result.status === "only_v1" &&
      isEmpty(disaCandidates[0])
    ) {
      result = {
        status: "match",
        reason: "DISA has no source for this field; v1-only value not gated",
      };
    }

    summary.total++;
    summary[result.status]++;

    const row: FieldRow = {
      field: def.field,
      status: result.status,
      disa: valueForOutput(chosenDisa),
      openldr_v1: valueForOutput(chosenV1),
    };
    if (result.reason !== undefined) row.reason = result.reason;
    if (matchedDisaFallback || matchedV1Fallback) {
      const sides: string[] = [];
      if (matchedDisaFallback) sides.push("DISA");
      if (matchedV1Fallback) sides.push("v1");
      row.note = `matched via ${sides.join(" + ")} fallback candidate`;
    }
    fields.push(row);
  }

  return { fields, summary };
}

export function isPerfectMatch(s: DiffSummary): boolean {
  return s.mismatch === 0 && s.only_disa === 0 && s.only_v1 === 0;
}

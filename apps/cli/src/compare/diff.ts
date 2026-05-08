import type { SpecimenRecpt } from "disalab";
import type { OpenLdrV1Request } from "../openldr.js";
import { REQUEST_FIELDS } from "./mapping.js";
import type { CompareStatus } from "./comparators.js";

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

export function diffRecord(disa: SpecimenRecpt, v1: OpenLdrV1Request): DiffResult {
  const fields: FieldRow[] = [];
  const summary: DiffSummary = {
    total: 0,
    match: 0,
    mismatch: 0,
    only_disa: 0,
    only_v1: 0,
  };

  for (const def of REQUEST_FIELDS) {
    const disaRaw = def.getDisa(disa);
    const disaCandidates = Array.isArray(disaRaw) ? disaRaw : [disaRaw];
    const v1Val = def.getV1(v1);

    let result = def.comparator(disaCandidates[0], v1Val);
    let chosenDisa: unknown = disaCandidates[0];
    let matchedFallback = false;
    for (let i = 1; i < disaCandidates.length; i++) {
      if (result.status === "match") break;
      const alt = def.comparator(disaCandidates[i], v1Val);
      if (alt.status === "match") {
        result = alt;
        chosenDisa = disaCandidates[i];
        matchedFallback = true;
        break;
      }
    }

    summary.total++;
    summary[result.status]++;

    const row: FieldRow = {
      field: def.field,
      status: result.status,
      disa: valueForOutput(chosenDisa),
      openldr_v1: valueForOutput(v1Val),
    };
    if (result.reason !== undefined) row.reason = result.reason;
    if (matchedFallback) row.note = "matched via DISA fallback candidate";
    fields.push(row);
  }

  return { fields, summary };
}

export function isPerfectMatch(s: DiffSummary): boolean {
  return s.mismatch === 0 && s.only_disa === 0 && s.only_v1 === 0;
}

import type { SpecimenRecpt } from "disalab";
import type { OpenLdrV1LabResult } from "../openldr.js";
import {
  flattenDisa,
  flattenV1,
  parseInequality,
  parseNumber,
  RESULT_FIELDS,
  supersedePanelIterations,
  type DisaObs,
  type FlattenDisaOpts,
  type V1Obs,
  type ResultFieldDef,
} from "./result-mapping.js";
import { valueForOutput } from "./diff.js";
import type { CompareStatus } from "./comparators.js";

export interface ResultFieldRow {
  field: string;
  status: CompareStatus;
  disa: unknown;
  openldr_v1: unknown;
  reason?: string;
  note?: string;
}

export interface ObservationRow {
  panel_code: string;
  param_code: string;
  /** Which instance within the panel (0-based) — only non-zero when a (panel, param) pair repeats. */
  occurrence: number;
  status: CompareStatus;
  disa: DisaObsOutput | null;
  openldr_v1: V1ObsOutput | null;
  fields: ResultFieldRow[];
}

export interface ResultSummary {
  observations_total: number;
  observations_match: number;
  observations_mismatch: number;
  observations_only_disa: number;
  observations_only_v1: number;
  fields_total: number;
  fields_match: number;
  fields_mismatch: number;
  fields_only_disa: number;
  fields_only_v1: number;
}

export interface ResultDiff {
  observations: ObservationRow[];
  summary: ResultSummary;
}

export interface DisaObsOutput {
  panel_code: string;
  panel_index: number;
  order_index: number;
  param_code: string;
  param_desc: string | null;
  value: unknown;
  type: string;
  type_name: string;
  is_resulted: boolean;
}

const TYPE_NAMES: Record<number, string> = {
  0: "Extended",
  1: "Real/Integer",
  2: "Accounting",
  3: "Coded Comment",
  4: "Short Text",
  5: "Text",
  6: "Graphic",
  7: "Date",
  8: "Time",
  9: "Header",
  11: "Snomed",
  12: "ICD10",
};

function typeName(typeChar: string): string {
  if (typeChar.length === 0) return "unknown";
  const code = typeChar.charCodeAt(0);
  return TYPE_NAMES[code] ?? `code:${code}`;
}

export interface V1ObsOutput {
  panel_code: string;
  obr_set_id: number;
  obx_set_id: number;
  obx_sub_id: number;
  param_code: string;
  param_desc: string | null;
  rpt_result: string | null;
  coded_value: string | null;
  result_type: string | null;
  abnormal_flag: string | null;
  rpt_range: string | null;
  si_value: number | null;
  si_units: string | null;
}

function disaOut(o: DisaObs): DisaObsOutput {
  return {
    panel_code: o.panelCode,
    panel_index: o.panelIndex,
    order_index: o.orderIndex,
    param_code: o.paramCode,
    param_desc: o.paramDesc,
    value: typeof o.value === "number" ? o.value : String(o.value),
    type: o.type,
    type_name: typeName(o.type),
    is_resulted: o.isResulted,
  };
}

function v1Out(o: V1Obs): V1ObsOutput {
  return {
    panel_code: o.panelCode,
    obr_set_id: o.obrSetId,
    obx_set_id: o.obxSetId,
    obx_sub_id: o.obxSubId,
    param_code: o.paramCode,
    param_desc: o.paramDesc,
    rpt_result: o.rptResult,
    coded_value: o.codedValue,
    result_type: o.resultType,
    abnormal_flag: o.abnormalFlag,
    rpt_range: o.rptRange,
    si_value: o.siValue,
    si_units: o.siUnits,
  };
}

/** Group by a composite key. Preserves insertion order within each bucket. */
function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = m.get(k);
    if (bucket === undefined) m.set(k, [item]);
    else bucket.push(item);
  }
  return m;
}

function diffOneField(
  def: ResultFieldDef,
  disa: DisaObs | null,
  v1: V1Obs | null,
): ResultFieldRow {
  const disaVal = disa !== null ? def.getDisa(disa) : null;
  const v1Val = v1 !== null ? def.getV1(v1) : null;
  const r = def.comparator(disaVal, v1Val);
  const row: ResultFieldRow = {
    field: def.field,
    status: r.status,
    disa: valueForOutput(Array.isArray(disaVal) ? disaVal[0] : disaVal),
    openldr_v1: valueForOutput(Array.isArray(v1Val) ? v1Val[0] : v1Val),
  };
  if (r.reason !== undefined) row.reason = r.reason;
  return row;
}

function candidatesAllEmpty(candidates: unknown | unknown[]): boolean {
  const arr = Array.isArray(candidates) ? candidates : [candidates];
  for (const c of arr) {
    if (c === null || c === undefined) continue;
    if (typeof c === "string" && c.trim().length === 0) continue;
    return false;
  }
  return true;
}

function shouldSkipField(
  def: ResultFieldDef,
  disa: DisaObs | null,
  v1: V1Obs | null,
): boolean {
  if (def.skipWhenBothEmpty !== true) return false;
  const disaVal = disa !== null ? def.getDisa(disa) : null;
  const v1Val = v1 !== null ? def.getV1(v1) : null;
  const disaEmpty = candidatesAllEmpty(disaVal);
  const v1Empty = candidatesAllEmpty(v1Val);
  // Skip when both are empty (nothing to compare, no signal).
  if (disaEmpty && v1Empty) return true;
  // Also skip when DISA extracts nothing AND the DISA observation exists —
  // this means DISA's type doesn't match the field (e.g. DISA is a Date but
  // field is `text_value`). Surfacing v1's data as only_v1 would be noise:
  // the primary `result` field already handles cross-type matches.
  if (disaEmpty && disa !== null && v1 !== null) return true;
  return false;
}

function rollupStatus(fields: ResultFieldRow[]): CompareStatus {
  if (fields.some((f) => f.status === "mismatch")) return "mismatch";
  if (fields.some((f) => f.status === "only_disa")) return "only_disa";
  if (fields.some((f) => f.status === "only_v1")) return "only_v1";
  return "match";
}

/**
 * Align DISA and v1 observations and diff each aligned pair.
 *
 * Alignment strategy:
 *   1. Group both sides by (panelCode, paramCode).
 *   2. Sort each bucket: DISA by (panelIndex, orderIndex); v1 by (OBRSetID, OBXSetID, OBXSubID).
 *   3. Zip positionally. Leftovers on either side become only_disa / only_v1.
 *
 * This trades exact OBRSetID↔TESTINDEX alignment for simplicity. If a single
 * RequestID has multiple OBR sets carrying the same panel code, we pair the
 * Nth DISA panel instance with the Nth v1 OBR set by ordering, not by
 * identity. In practice DISA TESTINDEX and v1 OBRSetID move monotonically
 * together per panel, so positional alignment suffices for the fidelity check.
 */
export interface DiffResultsOpts extends FlattenDisaOpts {}

/**
 * Panels where DISA signals "HIV viral load below detection" via a resulted
 * SCOM/VCOM coded-comment (e.g. "TLINT" → "Taqman Log interpretation"). When
 * such a comment is present AND quantitative slots are empty, v1's migration
 * synthesizes below-detection reports (HIVVQ="< 40", HIVVM="< 20",
 * HIVTL="0.00", HIVTM="< 20"). We treat those only_v1 rows as expected synthesis, not
 * fidelity misses.
 */
function detectSynthesisPanels(disaObs: DisaObs[]): Set<string> {
  const panels = new Set<string>();
  for (const o of disaObs) {
    if (o.paramCode !== "SCOM" && o.paramCode !== "VCOM") continue;
    if (!o.isResulted) continue;
    const raw = o.rawValue.trim().toUpperCase();
    const decoded = String(o.value).trim().toLowerCase();
    if (raw === "TLINT" || decoded.startsWith("taqman log")) {
      panels.add(o.panelCode);
    }
  }
  return panels;
}

function isSynthesisedV1Obs(
  panelCode: string,
  paramCode: string,
  v: V1Obs,
  synthesisPanels: Set<string>,
): boolean {
  if (!synthesisPanels.has(panelCode)) return false;
  if (paramCode !== "HIVVQ" && paramCode !== "HIVVM" && paramCode !== "HIVTL" && paramCode !== "HIVTM") return false;
  const rpt = (v.rptResult ?? "").trim();
  if (rpt.length === 0) return false;
  if (parseInequality(rpt) !== null) return true;
  const n = parseNumber(rpt);
  if (n !== null && n === 0) return true;
  return false;
}

/**
 * Mirror of isSynthesisedV1Obs: when DISA stores a quantitative zero (or
 * other below-detection sentinel) on HIVVQ/HIVVM/HIVTL/HIVTM AND the panel has a
 * TLINT signal, v1 drops the row instead of migrating a zero result. Both
 * sides are expressing the same "below detection" fact — classify as match.
 */
function isSynthesisedDisaObs(
  panelCode: string,
  paramCode: string,
  d: DisaObs,
  synthesisPanels: Set<string>,
): boolean {
  if (!synthesisPanels.has(panelCode)) return false;
  if (paramCode !== "HIVVQ" && paramCode !== "HIVVM" && paramCode !== "HIVTL" && paramCode !== "HIVTM") return false;
  if (typeof d.value === "number") return d.value === 0;
  const n = parseNumber(d.value);
  return n !== null && n === 0;
}

export function diffResults(
  disa: SpecimenRecpt,
  v1Rows: OpenLdrV1LabResult[],
  opts: DiffResultsOpts = {},
): ResultDiff {
  // DISA reruns a panel by adding a higher TESTINDEX row; v1's migration
  // kept only the final iteration. Mirror that here so we don't pair v1's
  // single OBR set against DISA's preliminary panel run (which would surface
  // as a value mismatch + only_disa overhang on the final run).
  const disaObs = supersedePanelIterations(flattenDisa(disa, opts)).kept;
  const v1Obs = flattenV1(v1Rows);
  const synthesisPanels = detectSynthesisPanels(disaObs);

  const disaByKey = groupBy(disaObs, (o) => `${o.panelCode}\t${o.paramCode}`);
  const v1ByKey = groupBy(v1Obs, (o) => `${o.panelCode}\t${o.paramCode}`);

  for (const bucket of disaByKey.values()) {
    bucket.sort((a, b) =>
      a.panelIndex !== b.panelIndex ? a.panelIndex - b.panelIndex : a.orderIndex - b.orderIndex,
    );
  }
  for (const bucket of v1ByKey.values()) {
    bucket.sort((a, b) => {
      if (a.obrSetId !== b.obrSetId) return a.obrSetId - b.obrSetId;
      if (a.obxSetId !== b.obxSetId) return a.obxSetId - b.obxSetId;
      return a.obxSubId - b.obxSubId;
    });
  }

  const allKeys = new Set<string>([...disaByKey.keys(), ...v1ByKey.keys()]);
  const sortedKeys = Array.from(allKeys).sort();

  const observations: ObservationRow[] = [];
  const summary: ResultSummary = {
    observations_total: 0,
    observations_match: 0,
    observations_mismatch: 0,
    observations_only_disa: 0,
    observations_only_v1: 0,
    fields_total: 0,
    fields_match: 0,
    fields_mismatch: 0,
    fields_only_disa: 0,
    fields_only_v1: 0,
  };

  for (const key of sortedKeys) {
    const [panelCode, paramCode] = key.split("\t") as [string, string];
    const disaBucket = disaByKey.get(key) ?? [];
    const v1Bucket = v1ByKey.get(key) ?? [];
    const n = Math.max(disaBucket.length, v1Bucket.length);

    for (let i = 0; i < n; i++) {
      const d = disaBucket[i] ?? null;
      const v = v1Bucket[i] ?? null;

      // Below-detection synthesis, both directions: either v1 emits a
      // sentinel row (HIVVQ="< 40") that DISA has no quantitative slot for,
      // or DISA stores a quantitative zero that v1 drops. Both are expected
      // migration behavior when the panel has SCOM=TLINT.
      const isSynthesized =
        (d === null && v !== null && isSynthesisedV1Obs(panelCode, paramCode, v, synthesisPanels)) ||
        (v === null && d !== null && isSynthesisedDisaObs(panelCode, paramCode, d, synthesisPanels));

      const fields: ResultFieldRow[] = [];
      for (const def of RESULT_FIELDS) {
        if (shouldSkipField(def, d, v)) continue;
        if (d === null) {
          fields.push({
            field: def.field,
            status: isSynthesized ? "match" : "only_v1",
            disa: null,
            openldr_v1: valueForOutput(
              Array.isArray(def.getV1(v as V1Obs))
                ? (def.getV1(v as V1Obs) as unknown[])[0]
                : def.getV1(v as V1Obs),
            ),
            ...(isSynthesized ? { reason: "v1 below-detection synthesis from DISA SCOM" } : {}),
          });
        } else if (v === null) {
          fields.push({
            field: def.field,
            status: isSynthesized ? "match" : "only_disa",
            disa: valueForOutput(
              Array.isArray(def.getDisa(d)) ? (def.getDisa(d) as unknown[])[0] : def.getDisa(d),
            ),
            openldr_v1: null,
            ...(isSynthesized ? { reason: "DISA below-detection zero; v1 dropped per SCOM" } : {}),
          });
        } else {
          fields.push(diffOneField(def, d, v));
        }
      }

      const obsStatus: CompareStatus = isSynthesized
        ? "match"
        : d === null
          ? "only_v1"
          : v === null
            ? "only_disa"
            : rollupStatus(fields);

      observations.push({
        panel_code: panelCode,
        param_code: paramCode,
        occurrence: i,
        status: obsStatus,
        disa: d !== null ? disaOut(d) : null,
        openldr_v1: v !== null ? v1Out(v) : null,
        fields,
      });

      summary.observations_total++;
      summary[`observations_${obsStatus}` as const]++;
      for (const f of fields) {
        summary.fields_total++;
        summary[`fields_${f.status}` as const]++;
      }
    }
  }

  return { observations, summary };
}

/**
 * The per-obs fidelity gate. Treats `only_disa` as acceptable (DISA decoded
 * an observation v1's migration didn't carry — v2 will emit it faithfully
 * from DISA, so the asymmetry isn't a toolchain bug). Keeps `mismatch` and
 * `only_v1` strict: `mismatch` is a real disagreement on shared data, and
 * `only_v1` means DISA's decoder failed to extract data v1 has (e.g. the
 * TDS0010161 HIVDR five-obs gap), which IS a toolchain bug we want to keep
 * surfacing.
 *
 * Symmetric with the request-level gate: ward asymmetry is tolerated via
 * wardComparator, received_at-only-v1 via allowDisaEmpty.
 */
export function isResultPerfectMatch(s: ResultSummary): boolean {
  return (
    s.observations_mismatch === 0 &&
    s.observations_only_v1 === 0 &&
    s.fields_mismatch === 0 &&
    s.fields_only_v1 === 0
  );
}

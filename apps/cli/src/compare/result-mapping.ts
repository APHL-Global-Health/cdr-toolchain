import type { SpecimenRecpt } from "disalab";
import { Order, OrderItem } from "disalab";
import type { OpenLdrV1LabResult } from "../openldr.js";
import { stringCiLoose, type CompareResult } from "./comparators.js";

/** A DISA observation flattened out of `SpecimenRecpt.TestResults[i].ORDER.ORDERS[j]`. */
export interface DisaObs {
  panelCode: string;
  /** DISA TESTINDEX — distinguishes repeat orderings of the same panel. */
  panelIndex: number;
  /**
   * DISA TESTDATA.DATESTAMP — when the panel iteration was created. Used as
   * the primary supersession key (latest date wins); TESTINDEX is the
   * tiebreaker. Null when the row carried no timestamp.
   */
  datestamp: Date | null;
  /** Position of the OrderItem within its panel — used as a tie-breaker. */
  orderIndex: number;
  paramCode: string;
  paramDesc: string | null;
  value: string | number;
  /** String form of `value` suitable for comparison. Numbers get stringified without trailing zeros. */
  valueStr: string;
  /**
   * Raw code before COMMDICT/TXT1DATA decoding. For Coded Comment types, this
   * is the short code ("NONE", "YES") while `value` is the decoded description
   * ("No ART given to child"). v1 sometimes stores the code, so we include it
   * as an additional candidate.
   */
  rawValue: string;
  /** 1-char OrderItem.Type code. See `OrderItem.CovertToChar`. */
  type: string;
  isResulted: boolean;
}

/** A v1 `LabResults` row flattened after joining with its owning Request. */
export interface V1Obs {
  panelCode: string;
  obrSetId: number;
  obxSetId: number;
  obxSubId: number;
  paramCode: string;
  paramDesc: string | null;
  rptResult: string | null;
  codedValue: string | null;
  resultType: string | null;
  abnormalFlag: string | null;
  rptRange: string | null;
  siValue: number | null;
  siUnits: string | null;
}

/**
 * Per-observation fields to compare once a (DISA, v1) pair has been aligned.
 * Same candidate-array pattern as the Request-level `REQUEST_FIELDS`: `getDisa`
 * or `getV1` may return an array of candidates, and a match on ANY candidate
 * wins. Useful because v1 splits one DISA `OrderItem.Value` across several
 * columns depending on the observation type.
 */
export interface ResultFieldDef {
  field: string;
  comparator: (disa: unknown, v1: unknown) => CompareResult;
  getDisa: (o: DisaObs) => unknown | unknown[];
  getV1: (r: V1Obs) => unknown | unknown[];
  /**
   * When true, the field is omitted from the output (and not counted in the
   * rollup) if both sides extract only empty/nullish candidates. Use for
   * typed sub-fields like `numeric_value` that are only meaningful for some
   * observation types — suppressing them keeps the rollup proportional to
   * fields that actually have data to compare.
   */
  skipWhenBothEmpty?: boolean;
}

/**
 * True if a DISA OrderItem value is structurally empty — no characters, or
 * only whitespace / control bytes (incl. the 0x1e record separator that
 * appears in unresulted placeholder slots). v1's LabResults table drops
 * these rows entirely, so by default we filter them out to avoid false
 * "only_disa" noise.
 */
function isDisaValueEmpty(v: string | number): boolean {
  if (typeof v === "number") return !Number.isFinite(v);
  const s = String(v);
  if (s.length === 0) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 32 && c !== 0x7f) return false;
  }
  return true;
}

/**
 * Per-type structural-emptiness check. The plain `isDisaValueEmpty(Value)`
 * misses two cases:
 *
 *   - Coded observations (types 0/3/4/11/12) store the code in `RawValue`
 *     and the COMMDICT-decoded description in `Value`. When COMMDICT
 *     doesn't resolve, `Value` is empty but `RawValue` carries the real
 *     data (e.g. TPCON RawValue="CC", Value=""). v1 still migrates these
 *     as coded rows, so dropping them produces false `only_v1` diffs.
 *
 *   - Date (7) and Time (8) observations whose underlying bytes failed
 *     to decode end up with control-byte garbage in `Value` (e.g. TPT
 *     Value="#"). The garbage is not whitespace-only, so the base
 *     emptiness check keeps the obs and we emit a false `only_disa`
 *     against v1's correctly-dropped row. Treat any C0 control byte in
 *     a Date/Time value — or any shape that isn't `DD/MM/YYYY` (Date)
 *     or `HH[:MM[:SS]]` (Time) — as a decode failure / data-entry slip.
 */
function isObservationStructurallyEmpty(
  typeChar: string,
  value: string | number,
  rawValue: string,
): boolean {
  const t = typeChar.length > 0 ? typeChar.charCodeAt(0) : -1;
  const valueEmpty = isDisaValueEmpty(value);
  if (t === 7 || t === 8) {
    if (valueEmpty) return true;
    if (typeof value === "string") {
      for (let i = 0; i < value.length; i++) {
        if (value.charCodeAt(i) < 0x20) return true;
      }
      // Shape gate: disalab's Date decoder canonicalises to DD/MM/YYYY,
      // and Time values are HH, HH:MM, or HH:MM:SS. Anything else (e.g.
      // TPT Value="2" — operator typed a duration into a Time slot) is
      // a data-entry slip v1 drops, so we drop it too.
      const trimmed = value.trim();
      const shape = t === 7 ? /^\d{2}\/\d{2}\/\d{4}$/ : /^\d{2}(?::\d{2}(?::\d{2})?)?$/;
      if (!shape.test(trimmed)) return true;
    }
    return false;
  }
  if (t === 0 || t === 3 || t === 4 || t === 11 || t === 12) {
    return valueEmpty && isDisaValueEmpty(rawValue);
  }
  return valueEmpty;
}

/**
 * True for OrderItems whose narrative text was supposed to live in TXT1DATA
 * but wasn't — leaving only a stray 1-char HL7 status flag (commonly "F"
 * for "final") in the blob's 5-byte result slot. v1's migration drops these.
 * Applies to type 5 (Text) and type 6 (Graphic), which are the two types
 * that use TXT1DATA overflow rows.
 *
 * Discriminator: when TXT1DATA successfully resolved the row, `Value` was
 * transformed from `RawValue` (e.g. byte `\x0a` → "C" for an HIV subtype),
 * so `Value !== RawValue` — that's real data, keep it. When `Value` equals
 * `RawValue`, no lookup ran and the 1-char string is the residual status
 * flag we want to drop. Without this guard, single-letter codes like HIV
 * subtype "C" (HIV1S/H1SRT, TDS0010161) get dropped while v1 keeps them.
 */
function isStrayStatusFlag(
  typeChar: string,
  value: string | number,
  rawValue: string,
): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length > 1) return false;
  const t = typeChar.length > 0 ? typeChar.charCodeAt(0) : -1;
  if (t !== 5 && t !== 6) return false;
  return trimmed === rawValue.trim();
}

/**
 * True when DISA's value decoded (via COMMDICT) to "Information missing" —
 * DISA's explicit no-data-entered sentinel for coded parameters (code "888"
 * across CONTEXTs 131-137, all ART-regimen-related). v1 drops these rather
 * than migrating a placeholder row, so we drop them by default too.
 */
function isInformationMissingSentinel(value: string | number): boolean {
  if (typeof value !== "string") return false;
  return value.trim().toLowerCase() === "information missing";
}

function stringifyNum(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  // Trim trailing zeros so "5.0" and "5" compare equal downstream.
  const s = String(n);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

function disaValueStr(v: string | number): string {
  return typeof v === "number" ? stringifyNum(v) : String(v).trim();
}

function isNullishOrEmptyString(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  return false;
}

export function parseNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

interface Inequality {
  op: "<" | "<=" | ">" | ">=";
  bound: number;
}

/** Parse v1-style bounded results like "< 40" / ">= 10000000". */
export function parseInequality(v: unknown): Inequality | null {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(<=|>=|<|>)\s*(-?\d+(?:\.\d+)?)$/);
  if (m === null) return null;
  const bound = Number(m[2]);
  if (!Number.isFinite(bound)) return null;
  return { op: m[1] as Inequality["op"], bound };
}

function inequalitySatisfied(x: number, ineq: Inequality): boolean {
  switch (ineq.op) {
    case "<": return x < ineq.bound;
    case "<=": return x <= ineq.bound;
    case ">": return x > ineq.bound;
    case ">=": return x >= ineq.bound;
  }
}

/**
 * Match two numbers within a small relative or absolute tolerance. Tuned to
 * tolerate integer-vs-float precision drift (e.g. DISA 186619.671875 vs v1
 * "186620" — v1 rounded to int) while still flagging genuine disagreements
 * like 7.93 vs 4.53.
 */
function numbersMatch(a: number, b: number): boolean {
  if (a === b) return true;
  const abs = Math.abs(a - b);
  if (abs < 1e-6) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return abs < 1e-6;
  // Allow 0.5% relative drift (numeric precision).
  if (abs / scale < 5e-3) return true;
  // 2-decimal rounding (v1 often stores "0.50" for DISA's 0.4972...).
  if (Math.round(a * 100) === Math.round(b * 100)) return true;
  // Integer rounding for larger magnitudes (DISA 186619.67 vs v1 "186620").
  if (Math.round(a) === Math.round(b) && abs / scale < 0.1) return true;
  return false;
}

/**
 * Normalize a free-text value for string comparison. Maps backticks to
 * apostrophes: v1's migration sometimes wrote backticks where DISA has
 * literal apostrophes (e.g. "MNG'ONG'O" → "MNG`ONG`O"), so treat the two
 * as equivalent rather than flagging a phantom mismatch.
 */
function normalizeText(v: unknown): unknown {
  return typeof v === "string" ? v.replace(/`/g, "'") : v;
}

/**
 * Compare candidate arrays. Both sides may supply multiple candidates; any
 * non-empty × non-empty match wins. Empty candidates are filtered before the
 * cross product — otherwise an empty string on both sides would spuriously
 * match even when real non-empty candidates exist (e.g. DISA value "" vs v1
 * `LIMSCodedValue` ""). Numeric candidates are compared with a tolerance
 * (see `numbersMatch`) so DISA's float precision doesn't fight v1's rounded
 * integer formatting.
 */
function looseMultiCandidate(disa: unknown, v1: unknown): CompareResult {
  const disaRaw = Array.isArray(disa) ? disa : [disa];
  const v1Raw = Array.isArray(v1) ? v1 : [v1];
  const disaCandidates = disaRaw.filter((v) => !isNullishOrEmptyString(v));
  const v1Candidates = v1Raw.filter((v) => !isNullishOrEmptyString(v));

  if (disaCandidates.length === 0 && v1Candidates.length === 0) {
    return { status: "match" };
  }
  if (disaCandidates.length === 0) return { status: "only_v1" };
  if (v1Candidates.length === 0) return { status: "only_disa" };

  let last: CompareResult = { status: "mismatch", reason: "no candidate pair matched" };
  for (const d of disaCandidates) {
    const dNum = parseNumber(d);
    const dIneq = parseInequality(d);
    for (const v of v1Candidates) {
      const vNum = parseNumber(v);
      const vIneq = parseInequality(v);
      if (dNum !== null && vNum !== null && numbersMatch(dNum, vNum)) {
        return { status: "match", reason: "numeric match within tolerance" };
      }
      // Inequality vs number: v1 often reports sentinel values as "< 40" or
      // "> 10000000" while DISA stores the raw quantitation. Satisfaction of
      // the bound counts as a match.
      if (dNum !== null && vIneq !== null && inequalitySatisfied(dNum, vIneq)) {
        return { status: "match", reason: `DISA ${dNum} satisfies v1 bound ${vIneq.op}${vIneq.bound}` };
      }
      if (vNum !== null && dIneq !== null && inequalitySatisfied(vNum, dIneq)) {
        return { status: "match", reason: `v1 ${vNum} satisfies DISA bound ${dIneq.op}${dIneq.bound}` };
      }
      const r = stringCiLoose(normalizeText(d), normalizeText(v));
      if (r.status === "match") return r;
      last = r;
    }
  }
  return last;
}

export const RESULT_FIELDS: ResultFieldDef[] = [
  {
    // v1 spreads the observation value across three columns depending on the
    // observation type:
    //   - LIMSRptResult: human-readable text (decoded organism, comment, etc.)
    //   - LIMSCodedValue: short code (S/I/R, organism code like "ECO")
    //   - SIValue: numeric value for quantitative observations
    // DISA's OrderItem.Value is either a number (for Real/Integer types after
    // BitConverter) or a string (decoded via PARMDICT/COMMDICT for Coded
    // Comment types). Feed both as candidates and let any match win.
    field: "result",
    comparator: looseMultiCandidate,
    getDisa: (o) => {
      const candidates: unknown[] = [o.valueStr];
      // Include raw pre-decode code — v1 sometimes stores the COMMDICT code
      // (e.g. "NONE") instead of the description (e.g. "No ART given to child").
      if (o.rawValue.length > 0 && o.rawValue !== o.valueStr) candidates.push(o.rawValue);
      if (o.paramDesc !== null && o.paramDesc.length > 0) candidates.push(o.paramDesc);
      return candidates;
    },
    getV1: (r) => {
      const candidates: unknown[] = [];
      if (r.rptResult !== null) candidates.push(r.rptResult);
      if (r.codedValue !== null) candidates.push(r.codedValue);
      // v1's SIValue column frequently holds uninitialized-float garbage
      // (denormals near 0 or supernaturals > 1e12). Only trust plausible
      // magnitudes.
      if (isSiValuePlausible(r.siValue)) {
        candidates.push(stringifyNum(r.siValue as number));
      }
      return candidates.length > 0 ? candidates : [null];
    },
  },
  {
    field: "observation_desc",
    comparator: looseMultiCandidate,
    getDisa: (o) => {
      const candidates: unknown[] = [];
      if (o.paramDesc !== null) candidates.push(o.paramDesc);
      candidates.push(o.paramCode);
      return candidates;
    },
    getV1: (r) => {
      const candidates: unknown[] = [];
      if (r.paramDesc !== null) candidates.push(r.paramDesc);
      candidates.push(r.paramCode);
      return candidates;
    },
  },
  // --- Typed sub-fields (skipWhenBothEmpty) -----------------------------
  // These narrow the `result` match down by data type so the rollup can show
  // "did the numeric part match" vs "did the coded part match" separately.
  // Each is suppressed from output when neither side has data of that type
  // for this observation — otherwise 98% of rows would have meaningless
  // "N/A → match" entries inflating the totals.
  {
    // Numeric: DISA OrderItem.Value when it's a number (types 1/2) against v1.
    // v1 stores the number in SIValue for some rows but SIValue is often a
    // denormal-float artifact — when that's the case, fall back to parsing
    // rpt_result, which v1 populates with the integer-rounded string form.
    field: "numeric_value",
    comparator: looseMultiCandidate,
    skipWhenBothEmpty: true,
    getDisa: (o) => (typeof o.value === "number" ? [o.value] : [null]),
    getV1: (r) => {
      const candidates: unknown[] = [];
      if (isSiValuePlausible(r.siValue)) candidates.push(r.siValue as number);
      if (r.rptResult !== null) {
        const trimmed = r.rptResult.trim();
        if (trimmed.length > 0) {
          // Accept pure numbers AND inequality bounds — looseMultiCandidate's
          // inequality logic satisfies DISA's raw value against v1's bound
          // (e.g. DISA 10^9 vs v1 "> 10000000").
          if (parseNumber(trimmed) !== null || parseInequality(trimmed) !== null) {
            candidates.push(trimmed);
          }
        }
      }
      return candidates.length > 0 ? candidates : [null];
    },
  },
  {
    // Coded: v1.LIMSCodedValue is the short HL7 code (e.g. "ECO", "S", "NO").
    // DISA's OrderItem.Value for coded types has been rewritten to the
    // CommDict description by OrderItem.Parse — we don't have the raw code
    // preserved, so compare DISA's description against v1's rpt_result
    // (which v1 also stores as description). Skip when v1 has no coded_value
    // (numeric or text-only observations).
    field: "coded_value",
    comparator: looseMultiCandidate,
    skipWhenBothEmpty: true,
    getDisa: (o) => {
      const t = o.type.length > 0 ? o.type.charCodeAt(0) : -1;
      const isCodedType = t === 0 || t === 3 || t === 4 || t === 11 || t === 12;
      if (!isCodedType || typeof o.value !== "string") return [null];
      const candidates: unknown[] = [o.valueStr];
      if (o.rawValue.length > 0 && o.rawValue !== o.valueStr) candidates.push(o.rawValue);
      return candidates;
    },
    getV1: (r) => (r.codedValue !== null && r.codedValue.trim().length > 0 ? [r.rptResult, r.codedValue] : [null]),
  },
  {
    // Text narrative: DISA OrderItem.Value for Text/Graphic types (5/6)
    // after TXT1DATA lookup ↔ v1.LIMSRptResult. The stray-status-flag filter
    // already drops single-char placeholders, so anything left here is real
    // narrative. This field only fires when DISA's observation type is
    // actually Text/Graphic — for numeric or coded types, the numeric_value
    // and coded_value fields already cover the comparison.
    field: "text_value",
    comparator: looseMultiCandidate,
    skipWhenBothEmpty: true,
    getDisa: (o) => {
      const t = o.type.length > 0 ? o.type.charCodeAt(0) : -1;
      const isTextType = t === 5 || t === 6;
      if (!isTextType || typeof o.value !== "string") return [null];
      return [o.valueStr];
    },
    getV1: (r) => {
      // v1 has text-y rpt_result (not a pure number, not an inequality) AND
      // no coded_value. Pure-number strings belong to `numeric_value` instead;
      // the skipWhenBothEmpty rule then hides this field for numeric obs.
      if (r.rptResult === null) return [null];
      const trimmed = r.rptResult.trim();
      if (trimmed.length === 0) return [null];
      if (r.codedValue !== null && r.codedValue.trim().length > 0) return [null];
      // When v1 explicitly types the row as text (resultType "T"), trust it —
      // lot numbers and phone numbers parse as numbers but are still text.
      // Content-sniffing only applies when v1 didn't tell us the type.
      const resultType = r.resultType === null ? "" : r.resultType.trim().toUpperCase();
      if (resultType !== "T") {
        if (parseNumber(trimmed) !== null) return [null];
        if (parseInequality(trimmed) !== null) return [null];
      }
      return [r.rptResult];
    },
  },
];

export interface FlattenDisaOpts {
  /**
   * When false (default), drop OrderItems that are structurally empty —
   * `isResulted === false` OR `value` contains only whitespace/control bytes.
   * v1's LabResults table doesn't carry these, so including them would emit
   * spurious `only_disa` rows.
   */
  includeEmpty?: boolean;
}

/** One DISA panel iteration that was dropped in favour of a later run. */
export interface SupersededPanelIteration {
  panelCode: string;
  panelIndex: number;
  /** Highest panel_index seen for this panel — the iteration that survives. */
  supersededBy: number;
  /** Number of OrderItems dropped from this iteration. */
  observationCount: number;
}

export interface SupersedeResult {
  kept: DisaObs[];
  superseded: SupersededPanelIteration[];
}

/**
 * Per panel code, keep only OrderItems from the LATEST iteration. DISA
 * reruns a panel by adding a new TESTDATA row (preliminary + final, two-tech
 * verification, retrospective re-evaluation, etc.); OpenLDR v1's migration
 * discarded the earlier iterations, so the fidelity check and the v2 export
 * both need to mirror that "latest wins" behaviour.
 *
 * Ranking: latest `datestamp` wins; `panelIndex` is the tiebreaker (higher
 * wins when timestamps match or when one side has no datestamp). TESTINDEX
 * alone was the original heuristic but breaks on labs like TDS0010161 where
 * an OLDER iteration carries a HIGHER TESTINDEX (e.g. TESTINDEX=103 dated
 * 2013 vs TESTINDEX=4 dated 2018 — 103 is a retrospective re-evaluation,
 * not a newer rerun).
 *
 * Returns the filtered observations plus a per-superseded-iteration sidecar
 * that the audit subsystem turns into a `panel_iterations_superseded` anomaly.
 */
export function supersedePanelIterations(obs: DisaObs[]): SupersedeResult {
  interface IterKey {
    panelIndex: number;
    datestampMs: number | null;
  }
  // Higher datestampMs wins; null sorts as -Infinity so a dated iteration
  // always beats an undated one. Same datestamp (or both null) → higher
  // panelIndex wins.
  function isLater(a: IterKey, b: IterKey): boolean {
    const am = a.datestampMs ?? -Infinity;
    const bm = b.datestampMs ?? -Infinity;
    if (am !== bm) return am > bm;
    return a.panelIndex > b.panelIndex;
  }
  function sameIter(a: IterKey, b: IterKey): boolean {
    return a.panelIndex === b.panelIndex && a.datestampMs === b.datestampMs;
  }

  const winner = new Map<string, IterKey>();
  for (const o of obs) {
    const k: IterKey = {
      panelIndex: o.panelIndex,
      datestampMs: o.datestamp === null ? null : o.datestamp.getTime(),
    };
    const cur = winner.get(o.panelCode);
    if (cur === undefined || isLater(k, cur)) winner.set(o.panelCode, k);
  }

  const kept: DisaObs[] = [];
  // key: `${panelCode}\t${panelIndex}\t${datestampMs|null}` → count
  const droppedCounts = new Map<string, number>();
  // Track the panelIndex per dropped key for the sidecar output.
  const droppedPanelIndex = new Map<string, number>();
  for (const o of obs) {
    const w = winner.get(o.panelCode);
    const k: IterKey = {
      panelIndex: o.panelIndex,
      datestampMs: o.datestamp === null ? null : o.datestamp.getTime(),
    };
    if (w === undefined || sameIter(k, w)) {
      kept.push(o);
    } else {
      const key = `${o.panelCode}\t${k.panelIndex}\t${k.datestampMs ?? "null"}`;
      droppedCounts.set(key, (droppedCounts.get(key) ?? 0) + 1);
      droppedPanelIndex.set(key, k.panelIndex);
    }
  }

  const superseded: SupersededPanelIteration[] = [];
  for (const [key, count] of droppedCounts) {
    const firstTab = key.indexOf("\t");
    const panelCode = key.slice(0, firstTab);
    const panelIndex = droppedPanelIndex.get(key)!;
    superseded.push({
      panelCode,
      panelIndex,
      supersededBy: winner.get(panelCode)!.panelIndex,
      observationCount: count,
    });
  }
  superseded.sort((a, b) =>
    a.panelCode.localeCompare(b.panelCode) || a.panelIndex - b.panelIndex,
  );

  return { kept, superseded };
}

/** Coerce a TESTDATA.DATESTAMP cell into a Date or null. mssql returns
 *  DATETIME as a JS Date already; legacy callers may receive a string. */
function coerceDatestamp(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : new Date(t);
  }
  return null;
}

/** Flatten `SpecimenRecpt.TestResults` into one row per OrderItem. */
export function flattenDisa(s: SpecimenRecpt, opts: FlattenDisaOpts = {}): DisaObs[] {
  const includeEmpty = opts.includeEmpty === true;
  const out: DisaObs[] = [];
  for (const test of s.TestResults) {
    const panelCode = String(test.TESTCODE ?? "").trim();
    const rawIdx = test.TESTINDEX;
    const panelIndex = typeof rawIdx === "number" ? rawIdx : Number(rawIdx ?? 0);
    const datestamp = coerceDatestamp(test.DATESTAMP);
    const order = test.ORDER;
    const items: OrderItem[] = order instanceof Order
      ? (order.ORDERS as OrderItem[])
      : Array.isArray(order)
        ? (order as OrderItem[])
        : [];

    items.forEach((item, orderIndex) => {
      const paramCode = String(item.Code ?? "").trim();
      if (paramCode.length === 0) return;
      if (!includeEmpty) {
        if (isObservationStructurallyEmpty(item.Type, item.Value, item.RawValue ?? "")) return;
        // IsResulted is the decoder's own "this row has data" flag, but it
        // can be false for coded observations whose COMMDICT lookup failed
        // — RawValue still carries the code (e.g. TPCON RawValue="CC",
        // Value=""), and v1 migrates these rows. Trust RawValue as the
        // resulted signal for coded types.
        const typeCode = item.Type.length > 0 ? item.Type.charCodeAt(0) : -1;
        const isCodedType = typeCode === 0 || typeCode === 3 || typeCode === 4 || typeCode === 11 || typeCode === 12;
        const hasCodedFallback = isCodedType && (item.RawValue ?? "").trim().length > 0;
        if (!item.IsResulted && !hasCodedFallback) return;
        if (isStrayStatusFlag(item.Type, item.Value, item.RawValue ?? "")) return;
        if (isInformationMissingSentinel(item.Value)) return;
        // Rejection metadata — DISA's reason-for-test-rejection fields.
        // RJREA = Rejection Reason (coded); RJREM = Rejection Memo (text).
        // v1 doesn't carry rejection metadata, so exclude to match.
        if (paramCode === "RJREA" || paramCode === "RJREM") return;
      }
      out.push({
        panelCode,
        panelIndex: Number.isFinite(panelIndex) ? panelIndex : 0,
        datestamp,
        orderIndex,
        paramCode,
        paramDesc: item.Description ?? null,
        value: item.Value,
        valueStr: disaValueStr(item.Value),
        rawValue: item.RawValue ?? "",
        type: item.Type,
        isResulted: item.IsResulted,
      });
    });
  }
  return out;
}

/** A DISA specimen's rejection state. `rejected` is true when the sample was
 *  refused before/instead of testing; `reason` carries the raw reason text
 *  (presence-only — no code→description mapping is applied). */
export interface DisaRejection {
  rejected: boolean;
  reason: string | null;
}

/**
 * Detect whether a DISA specimen receipt represents a rejected request.
 *
 * A request counts as rejected when any panel holds `RJREA` (rejection reason)
 * or `RJREM` (rejection memo) metadata. These are stripped from the normal
 * observation stream (see `flattenDisa`), so we scan the raw stream —
 * `includeEmpty` keeps them — rather than re-deriving the order layout here.
 *
 * `reason` is the raw reason text for annotation: the RJREA reason, else the
 * RJREM memo.
 *
 * Rejected requests legitimately produce no observations (the sample was never
 * tested), so downstream code treats an empty observation set on a rejected
 * request as expected rather than a clinically-empty error.
 *
 * ⚠ CORRECTED 2026-07-17 — the previous version of this comment was the ROOT
 * CAUSE, and it was wrong twice:
 *
 *  1. It claimed a request counts as rejected when "the specimen carries a
 *     recorded `Condition` (e.g. 'Unsuitable for testing', 'Clotted')".
 *     **That is an ASSUMPTION about the field's contents, and it is false.**
 *     Measured across 900 DISA/TDS labs: `Condition` is `'GOOD'` (690) or empty
 *     (210) — **never a rejection reason.** So the predicate marked 89% of labs
 *     rejected because their specimen was GOOD, against v1's 0.6%.
 *  2. It described `reason` as "(Condition, else the RJREM memo, else the RJREA
 *     reason)" — but the code preferred RJREA over RJREM. The comment had its
 *     own precedence backwards.
 *
 * The lesson worth keeping: **an example value in a comment is not a
 * measurement.** "e.g. 'Clotted'" read as documentation and was invention.
 */
export function detectDisaRejection(s: SpecimenRecpt): DisaRejection {
  const trim = (v: unknown): string | null => {
    if (v === null || v === undefined) return null;
    const t = (typeof v === "string" ? v : String(v)).trim();
    return t.length > 0 ? t : null;
  };
  const condition = trim(s.Condition);
  // RJREA is the coded reject REASON ("Unsuitable for testing", "No test
  // requested", …) — the meaningful signal. RJREM is a free-text remark that
  // is frequently padding ("F"), so it is only a fallback for the reason
  // text. Collect distinct values across panels so a multi-panel rejection
  // lists each reason rather than arbitrarily picking one.
  const reasons = new Set<string>();
  const memos = new Set<string>();
  for (const o of flattenDisa(s, { includeEmpty: true })) {
    if (o.paramCode === "RJREA") {
      const v = trim(o.valueStr);
      if (v !== null) reasons.add(v);
    } else if (o.paramCode === "RJREM") {
      const v = trim(o.valueStr);
      if (v !== null) memos.add(v);
    }
  }
  // ⛔ `Condition` is deliberately NOT consulted — it is a SPECIMEN-QUALITY
  // descriptor, not a rejection flag. The old predicate was
  //     condition !== null || reasons.size > 0 || memos.size > 0
  // and the old reason was `condition ?? ...`. Both were wrong, measured:
  //
  //   Condition's FULL value set across 900 DISA/TDS labs (2026-07-17):
  //       empty  210
  //       'GOOD' 690      <- and NOTHING else. Not one other value.
  //
  // So `condition !== null` marked a request rejected BECAUSE THE SPECIMEN WAS
  // GOOD. On a random 158-lab sample the V2<->v1 gate caught it: CDR called 141
  // (89%) rejected while v1 recorded ONE. And `reason = condition ?? ...` meant
  // a genuinely rejected request reported its reason as "GOOD", masking the real
  // RJREA text. Not cosmetic: "rejected" means NO RESULT downstream, and it
  // re-sources panel_code (v2-transform.ts:283-287).
  //
  // ⚠ TDS is 1 site of 22. If another deployment records a real rejecting
  // condition here (e.g. "HAEMOLYSED"), this drops that signal — but such a
  // request should still carry RJREA, which IS the coded reject reason. Do not
  // re-add `condition` as a trigger without measuring its value set at that site
  // FIRST: that is exactly the assumption that produced this bug.
  const rejected = reasons.size > 0 || memos.size > 0;
  const reason =
    reasons.size > 0
      ? [...reasons].join("; ")
      : memos.size > 0
        ? [...memos].join("; ")
        : null;
  return { rejected, reason };
}

/**
 * True when a v1 LabResults row carries no actual observation value — all
 * three result-bearing columns (rpt_result, coded_value, SIValue) are empty
 * or zero. v1's migration sometimes emits placeholder rows for unfilled
 * slots (e.g. COL/TPT "Transportation Time" when DISA didn't capture it).
 * We drop them to match how flattenDisa drops unresulted DISA OrderItems.
 */
/**
 * v1's SIValue column is frequently uninitialized-float garbage — denormals
 * like 2.9e-310 or supernaturals like 1.5e+217. Only values within plausible
 * lab-result magnitude count as real data.
 */
function isSiValuePlausible(v: number | null): boolean {
  if (v === null) return false;
  if (!Number.isFinite(v)) return false;
  const abs = Math.abs(v);
  return abs >= 1e-6 && abs <= 1e12;
}

function isV1RowEmpty(r: OpenLdrV1LabResult): boolean {
  const rpt = r.LIMSRptResult === null ? "" : r.LIMSRptResult.trim();
  const coded = r.LIMSCodedValue === null ? "" : r.LIMSCodedValue.trim();
  // Empty rpt and coded: also-empty SIValue → treat as placeholder.
  if (rpt.length === 0 && coded.length === 0) {
    return !isSiValuePlausible(r.SIValue);
  }
  // "0.00"-shaped rpt with empty coded and no plausible SIValue: v1
  // placeholder for an unresulted slot (seen on bilirubin and similar
  // quantitative tests where the test wasn't actually run).
  if (coded.length === 0 && rpt.length > 0) {
    const n = Number(rpt);
    if (Number.isFinite(n) && n === 0 && !isSiValuePlausible(r.SIValue)) {
      return true;
    }
  }
  return false;
}

/** Flatten v1 `LabResults × Requests` rows, dropping structurally-empty rows. */
export function flattenV1(rows: OpenLdrV1LabResult[]): V1Obs[] {
  const out: V1Obs[] = [];
  for (const r of rows) {
    const panelCode = String(r.LIMSPanelCode ?? "").trim();
    const paramCode = String(r.LIMSObservationCode ?? "").trim();
    if (paramCode.length === 0) continue;
    if (isV1RowEmpty(r)) continue;
    out.push({
      panelCode,
      obrSetId: r.OBRSetID,
      obxSetId: r.OBXSetID,
      obxSubId: r.OBXSubID,
      paramCode,
      paramDesc: r.LIMSObservationDesc,
      rptResult: r.LIMSRptResult,
      codedValue: r.LIMSCodedValue,
      resultType: r.HL7ResultTypeCode,
      abnormalFlag: r.HL7AbnormalFlagCodes,
      rptRange: r.LIMSRptRange,
      siValue: r.SIValue,
      siUnits: r.SIUnits,
    });
  }
  return out;
}

// Result-format heuristics. High-precision / low-recall — only flag
// patterns we're confident are wrong, not every value that "looks weird".

const MICROSCOPY_PARAM_RE = /\bw\.?b\.?c|leuc|leuk|r\.?b\.?c|erythr|epith/i;

// Accepted microscopy patterns:
//   - count or range with optional units: "5", "5-10", "20/hpf", "<5", ">100"
//   - semi-quantitative descriptors with optional trailing word ("None Seen",
//     "Moderate", "Few Seen", "Plenty"). Multi-word phrases are OK as long
//     as they start with one of the expected leads.
//   - "+", "++", "+++", "++++"
const MICROSCOPY_COUNT_RE =
  /^\s*(?:\d+(?:\.\d+)?(?:\s*[-–]\s*\d+(?:\.\d+)?)?\s*\/?\s*(?:hpf|lpf|mm3|µl|ul)?|\+{1,4}|<\s*\d+|>\s*\d+|(?:nil|none|occ(?:asional)?|few|many|moderate|plenty|scanty|rare|abundant|positive|negative|seen|not\s+seen)(?:\s+\w+)*)\s*$/i;

/** True when the parameter description names a microscopy cell count
 *  (white/red blood cells, leucocytes, epithelial cells, etc.). */
export function isMicroscopyCountParam(paramDescription: string | null | undefined): boolean {
  if (paramDescription === null || paramDescription === undefined) return false;
  return MICROSCOPY_PARAM_RE.test(paramDescription);
}

/** True when a microscopy count value parses as a recognised pattern
 *  (count, range, /hpf, +/++/+++, semi-quantitative occ/few/many, "nil",
 *  or a bound like "< 5"). False on free-text gibberish. */
export function isValidMicroscopyCount(valueStr: string): boolean {
  return MICROSCOPY_COUNT_RE.test(valueStr);
}

/** OrderItem.Type bytes for "coded comment"-style observations: 0 (Coded),
 *  3 (Patient Type), 4 (Coded comment with code), 11/12 (Lookup variants).
 *  See OrderItem.CovertToChar in disalab. */
export function isCodedTypeChar(typeChar: string): boolean {
  if (typeChar.length === 0) return false;
  const c = typeChar.charCodeAt(0);
  return c === 0 || c === 3 || c === 4 || c === 11 || c === 12;
}

/** Numeric OrderItem.Type bytes: 1 (Real) and 2 (Integer). */
export function isNumericTypeChar(typeChar: string): boolean {
  if (typeChar.length === 0) return false;
  const c = typeChar.charCodeAt(0);
  return c === 1 || c === 2;
}

/** Detect units typed inline in a numeric value (e.g. "5 mg/dL" when
 *  PARMDICT already supplies the units field). True when the value
 *  contains alpha or percent that ISN'T part of scientific notation —
 *  the lone 'e' in "7.15e+22" is not an inline unit. */
export function hasInlineUnits(valueStr: string): boolean {
  // Strip a single leading-sign + scientific-notation pattern before
  // looking for unit-like characters. After stripping, any remaining
  // [a-z]/% means the operator typed units into the value.
  const stripped = valueStr.replace(/^[+-]?\d+(\.\d+)?(e[+-]?\d+)?/i, "");
  return /[a-z%]/i.test(stripped);
}

/** True when a finite numeric value is outside plausible lab-result
 *  magnitude. Mirrors the heuristic in result-mapping.ts:isSiValuePlausible
 *  — values below 1e-6 (excluding zero) or above 1e12 are almost always
 *  uninitialised-float garbage from a misdecoded DISA blob slot. */
export function isUnrealisticNumeric(value: string | number): boolean {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return false;
  const abs = Math.abs(n);
  if (abs === 0) return false;
  if (abs > 1e12) return true;
  if (abs < 1e-6) return true;
  return false;
}

/** "Invalid" is a known Tanzania COMMDICT typo at CONTEXT=79 (should be
 *  "Intermediate"). Other coded contexts shouldn't surface this string. */
export function isInvalidDecodedSentinel(valueStr: string): boolean {
  return /^\s*invalid\s*$/i.test(valueStr);
}

/** True when valueStr contains any non-printable control byte other than
 *  tab/LF/CR. Surfaces stray DISA record-separators (0x1e/0x1f) and other
 *  control bytes that survived flattenDisa's emptiness/stray-flag filters. */
export function containsControlChars(valueStr: string): boolean {
  for (let i = 0; i < valueStr.length; i++) {
    const c = valueStr.charCodeAt(i);
    if (c >= 32 && c !== 0x7f) continue;
    if (c === 9 || c === 10 || c === 13) continue;
    return true;
  }
  return false;
}

/** Indices + character codes of all control bytes (for diagnostic detail). */
export function listControlChars(valueStr: string): Array<{ index: number; code: number }> {
  const out: Array<{ index: number; code: number }> = [];
  for (let i = 0; i < valueStr.length; i++) {
    const c = valueStr.charCodeAt(i);
    if (c >= 32 && c !== 0x7f) continue;
    if (c === 9 || c === 10 || c === 13) continue;
    out.push({ index: i, code: c });
  }
  return out;
}

/** Replace every byte that's a C0 control (0x00-0x1F, except tab/LF/CR),
 *  DEL (0x7F), or a C1 control (0x80-0x9F) with `\xHH` notation. Keeps
 *  the result safe to feed into PDF renderers, terminal output, and JSON
 *  consumers that may not handle raw control codes well. */
export function escapeControlBytesForDisplay(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const isC0 = c < 32 && c !== 9 && c !== 10 && c !== 13;
    const isDelOrC1 = c === 0x7f || (c >= 0x80 && c <= 0x9f);
    if (isC0 || isDelOrC1) {
      out += "\\x" + c.toString(16).padStart(2, "0");
    } else {
      out += s[i];
    }
  }
  return out;
}

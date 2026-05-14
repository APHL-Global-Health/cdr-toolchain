import type { SpecimenRecpt } from "disalab";
import {
  flattenDisa,
  supersedePanelIterations,
  type DisaObs,
  type SupersededPanelIteration,
} from "../compare/result-mapping.js";
import type { Codebook } from "../export/codebook.js";
import { collectOrderedPanels } from "../export/panels.js";
import { extractKinds, kindsCompatible, type SpecimenKind } from "./specimen-vocab.js";
import {
  containsControlChars,
  escapeControlBytesForDisplay,
  hasInlineUnits,
  isCodedTypeChar,
  isInvalidDecodedSentinel,
  isMicroscopyCountParam,
  isNumericTypeChar,
  isUnrealisticNumeric,
  isValidMicroscopyCount,
  listControlChars,
} from "./result-formats.js";
import {
  maxSeverity,
  type Anomaly,
  type AuditReport,
} from "./types.js";

export interface AuditInputs {
  labNumber: string;
  requestId: string;
  specimenCode: string | null;
  /** Panel codes from TestOrders, in order, deduped. */
  orderedPanels: string[];
  /** Resulted observations across panels, after superseding earlier panel
   *  iterations (the same shape exported to v2). */
  observations: DisaObs[];
  /** Per-superseded-iteration sidecar: DISA panel reruns whose observations
   *  were dropped in favour of a later iteration. Empty when no panel was
   *  rerun. v1-source audits leave this empty (v1 already discarded reruns). */
  supersededIterations: SupersededPanelIteration[];
  /** Raw DISA DobAge field — "MM/DD/YYYY" or null. v1-source audits leave this null. */
  dobRaw: string | null;
  /** Raw DISA "MM/DD/YYYY HH:MM" datetimes; null when not captured. */
  takenAtRaw: string | null;
  collectedAtRaw: string | null;
  receivedAtRaw: string | null;
  /** DISA SEX field — "M" / "F" / blank when unknown. */
  sex: string | null;
}

const MICROSCOPY_PANEL_RE = /microscop|w\.?b\.?c|r\.?b\.?c/i;

function setIntersect<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function describePanel(cb: Codebook, code: string): string {
  return cb.panelEntry(code)?.description ?? "";
}

function describeSpecimen(cb: Codebook, code: string | null): string {
  if (code === null || code.length === 0) return "";
  return cb.specimenEntry(code)?.description ?? "";
}

function detectPanelSpecimenMismatch(input: AuditInputs, cb: Codebook): Anomaly[] {
  const out: Anomaly[] = [];
  const specimenDesc = describeSpecimen(cb, input.specimenCode);
  const specimenKinds = extractKinds(specimenDesc);
  const specimenIsMissing =
    input.specimenCode === null || input.specimenCode.length === 0 || specimenDesc.length === 0;

  // Specimen-missing fires UNCONDITIONALLY for any lab with at least one
  // ordered panel — v2's storage stage requires specimen_concept_id, and
  // our mapper can't generate one from a null specimen_code, so storage
  // always rejects regardless of which panel was ordered. We don't gate
  // this on the panel description tokenising to a known kind because
  // panels like CD4 / FBC / HIVVL imply a specimen kind clinically but
  // not lexically.
  if (specimenIsMissing && input.orderedPanels.length > 0) {
    const firstPanel = input.orderedPanels[0]!;
    const firstPanelDesc = describePanel(cb, firstPanel);
    out.push({
      class: "specimen_missing",
      severity: "error",
      message: `Lab has ${input.orderedPanels.length} ordered panel(s) but no specimen recorded. v2 storage will reject — fix the source data before re-attempting.`,
      panel_code: firstPanel,
      details: {
        ordered_panels: input.orderedPanels,
        first_panel_description: firstPanelDesc,
        specimen_code: input.specimenCode,
      },
    });
  }

  // Per-panel checks only when specimen IS recorded — we already flagged
  // the missing-specimen case above.
  if (specimenIsMissing) return out;

  for (const panelCode of input.orderedPanels) {
    const panelDesc = describePanel(cb, panelCode);
    const panelKinds = extractKinds(panelDesc);
    if (panelKinds.size === 0) continue;

    if (specimenKinds.size === 0) {
      out.push({
        class: "specimen_description_vague",
        severity: "info",
        message: `Panel "${panelDesc}" implies a specimen kind but specimen description "${specimenDesc}" is too vague to confirm.`,
        panel_code: panelCode,
        details: {
          panel_description: panelDesc,
          panel_kinds: [...panelKinds],
          specimen_code: input.specimenCode,
          specimen_description: specimenDesc,
        },
      });
      continue;
    }

    if (!kindsCompatible(panelKinds, specimenKinds)) {
      out.push({
        class: "panel_specimen_mismatch",
        severity: "error",
        message: `Panel "${panelDesc}" implies ${[...panelKinds].join("/")}, but specimen "${specimenDesc}" is ${[...specimenKinds].join("/")}.`,
        panel_code: panelCode,
        details: {
          panel_description: panelDesc,
          panel_kinds: [...panelKinds],
          specimen_code: input.specimenCode,
          specimen_description: specimenDesc,
          specimen_kinds: [...specimenKinds],
        },
      });
    }
  }
  return out;
}

/** Parse DISA's "MM/DD/YYYY[ HH:MM[:SS]]" into a UTC epoch ms. Falls back
 *  to ISO-8601 (when disalab returned a Date and we coerced to string).
 *  Returns null when the input matches neither shape. DISA timestamps are
 *  local time but for ordering / comparison we treat them as UTC. */
function parseDisaDate(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m !== null) {
    const [, mm, dd, yyyy, hh, mi, ss] = m;
    const t = Date.UTC(
      Number(yyyy),
      Number(mm) - 1,
      Number(dd),
      hh === undefined ? 0 : Number(hh),
      mi === undefined ? 0 : Number(mi),
      ss === undefined ? 0 : Number(ss),
    );
    return Number.isFinite(t) ? t : null;
  }
  const iso = Date.parse(trimmed);
  return Number.isFinite(iso) ? iso : null;
}

const ONE_DAY_MS = 86_400_000;

function detectPatientAnomalies(input: AuditInputs): Anomaly[] {
  const out: Anomaly[] = [];

  const dobMs = parseDisaDate(input.dobRaw);
  if (dobMs !== null) {
    const now = Date.now();
    if (dobMs - now > ONE_DAY_MS) {
      out.push({
        class: "dob_future_dated",
        severity: "error",
        message: `Patient DOB "${input.dobRaw}" is in the future.`,
        details: { dob_raw: input.dobRaw },
      });
    }

    // Compare DOB against the earliest specimen-event date that exists.
    // A DOB > specimen date means the patient was born after the sample
    // was collected — impossible. Use the earliest of taken/collected to
    // avoid false positives when one is missing or out-of-order.
    const eventCandidates = [
      parseDisaDate(input.takenAtRaw),
      parseDisaDate(input.collectedAtRaw),
      parseDisaDate(input.receivedAtRaw),
    ].filter((v): v is number => v !== null);
    if (eventCandidates.length > 0) {
      const earliestEvent = Math.min(...eventCandidates);
      if (dobMs - earliestEvent > ONE_DAY_MS) {
        out.push({
          class: "dob_after_specimen_date",
          severity: "error",
          message: `Patient DOB "${input.dobRaw}" is after the earliest specimen-event date.`,
          details: {
            dob_raw: input.dobRaw,
            taken_at_raw: input.takenAtRaw,
            collected_at_raw: input.collectedAtRaw,
            received_at_raw: input.receivedAtRaw,
          },
        });
      }
    }
  }

  // Allowed sex codes: M / F (standard), U (HL7 Unknown — also the
  // deployment's convention for unrecorded sex, e.g. anonymous PEP / VL),
  // I (HL7 Indeterminate). Blank passes through as "not recorded".
  // Anything else surfaces as a warn — operators can review.
  if (input.sex !== null) {
    const trimmed = input.sex.trim();
    if (trimmed.length > 0) {
      const upper = trimmed.toUpperCase();
      if (upper !== "M" && upper !== "F" && upper !== "U" && upper !== "I") {
        out.push({
          class: "sex_code_invalid",
          severity: "warn",
          message: `Sex code "${input.sex}" is not "M" / "F" / "U" / "I" / blank.`,
          details: { sex_raw: input.sex },
        });
      }
    }
  }

  return out;
}

function detectObservationWrongPanel(input: AuditInputs, cb: Codebook): Anomaly[] {
  const out: Anomaly[] = [];

  // (a) AST observations sitting inside a microscopy-described panel.
  const obsByPanel = new Map<string, DisaObs[]>();
  for (const o of input.observations) {
    const list = obsByPanel.get(o.panelCode);
    if (list === undefined) obsByPanel.set(o.panelCode, [o]);
    else list.push(o);
  }
  for (const [panelCode, panelObs] of obsByPanel) {
    const panelDesc = describePanel(cb, panelCode);
    if (!MICROSCOPY_PANEL_RE.test(panelDesc)) continue;
    const astCodes = panelObs
      .filter((o) => cb.isAntibiotic(o.paramCode))
      .map((o) => o.paramCode);
    if (astCodes.length === 0) continue;
    out.push({
      class: "observation_wrong_panel",
      severity: "error",
      message: `Microscopy panel "${panelDesc}" contains antibiotic-susceptibility observations.`,
      panel_code: panelCode,
      details: {
        panel_description: panelDesc,
        ast_param_codes: [...new Set(astCodes)],
      },
    });
  }

  // (b) Same observation code recorded under multiple panels with disjoint
  //     specimen kinds. Suggests data was filed against the wrong panel.
  const dupMap = new Map<string, Set<string>>();
  for (const o of input.observations) {
    const set = dupMap.get(o.paramCode);
    if (set === undefined) dupMap.set(o.paramCode, new Set([o.panelCode]));
    else set.add(o.panelCode);
  }
  for (const [paramCode, panels] of dupMap) {
    if (panels.size < 2) continue;
    const panelKindList: ReadonlySet<SpecimenKind>[] = [];
    for (const p of panels) {
      panelKindList.push(extractKinds(describePanel(cb, p)));
    }
    // Flag only when at least one pair is non-empty & disjoint — same-kind
    // duplicates (e.g. two microscopy panels both reporting WBC) are
    // legitimate and frequent.
    let disjointPair: [string, string] | null = null;
    const panelArr = [...panels];
    outer: for (let i = 0; i < panelArr.length; i++) {
      for (let j = i + 1; j < panelArr.length; j++) {
        const ki = panelKindList[i]!;
        const kj = panelKindList[j]!;
        if (ki.size === 0 || kj.size === 0) continue;
        if (!setIntersect(ki, kj)) {
          disjointPair = [panelArr[i]!, panelArr[j]!];
          break outer;
        }
      }
    }
    if (disjointPair === null) continue;
    out.push({
      class: "cross_panel_duplicate_observation",
      severity: "warn",
      message: `Observation "${paramCode}" reported under multiple panels with different specimen kinds.`,
      observation_code: paramCode,
      details: {
        panels: panelArr,
        first_disjoint_pair: disjointPair,
      },
    });
  }

  return out;
}

function detectOrphanPanels(input: AuditInputs, cb: Codebook): Anomaly[] {
  const resultedPanels = new Set<string>();
  for (const o of input.observations) resultedPanels.add(o.panelCode);

  const out: Anomaly[] = [];
  for (const panelCode of input.orderedPanels) {
    if (resultedPanels.has(panelCode)) continue;
    out.push({
      class: "orphan_ordered_panel",
      severity: "info",
      message: `Panel "${panelCode}" was ordered but has no observations.`,
      panel_code: panelCode,
      details: {
        panel_description: describePanel(cb, panelCode),
      },
    });
  }
  return out;
}

function detectResultFormatIssues(input: AuditInputs, cb: Codebook): Anomaly[] {
  const out: Anomaly[] = [];
  for (const o of input.observations) {
    if (o.valueStr.length === 0) continue;
    const param = cb.paramEntry(o.paramCode);

    if (containsControlChars(o.valueStr)) {
      const stray = listControlChars(o.valueStr);
      out.push({
        class: "result_contains_control_chars",
        severity: "warn",
        message: `Observation "${o.paramCode}" value contains stray control bytes (${stray.length} byte(s)).`,
        panel_code: o.panelCode,
        observation_code: o.paramCode,
        details: {
          // Escape control bytes for safe transit through downstream
          // consumers: JSON readers, terminals, PDF renderers all break
          // on raw 0x01-0x1F / 0x7F-0x9F bytes mid-string.
          value: escapeControlBytesForDisplay(o.valueStr),
          control_chars: stray.map((s) => ({ index: s.index, code: `0x${s.code.toString(16).padStart(2, "0")}` })),
        },
      });
    }

    if (
      isCodedTypeChar(o.type) &&
      !cb.isAntibiotic(o.paramCode) &&
      isInvalidDecodedSentinel(o.valueStr)
    ) {
      out.push({
        class: "result_format_invalid_decoded",
        severity: "warn",
        message: `Observation "${o.paramCode}" decoded as "Invalid" outside an AST context — likely a COMMDICT description typo.`,
        panel_code: o.panelCode,
        observation_code: o.paramCode,
        details: { value: o.valueStr, raw_value: o.rawValue },
      });
    }

    // Microscopy-count check: skip antibiotic params, whose names like
    // "Erythromycin" hit the description regex via "erythr".
    if (
      param !== undefined &&
      !cb.isAntibiotic(o.paramCode) &&
      isMicroscopyCountParam(param.description)
    ) {
      if (!isValidMicroscopyCount(o.valueStr)) {
        out.push({
          class: "result_format_microscopy_count",
          severity: "warn",
          message: `Microscopy count "${param.description}" has unexpected value "${o.valueStr}".`,
          panel_code: o.panelCode,
          observation_code: o.paramCode,
          details: {
            param_description: param.description,
            value: o.valueStr,
            param_units: param.units,
          },
        });
      }
    }

    if (isNumericTypeChar(o.type) && isUnrealisticNumeric(o.value)) {
      out.push({
        class: "result_unrealistic_numeric",
        severity: "warn",
        message: `Numeric observation "${o.paramCode}" has value ${o.valueStr} outside plausible range — likely uninitialised-float garbage from a misdecoded DISA blob slot.`,
        panel_code: o.panelCode,
        observation_code: o.paramCode,
        details: {
          value: o.valueStr,
          numeric_value: typeof o.value === "number" ? o.value : null,
          param_description: param?.description,
          param_units: param?.units,
        },
      });
      // Don't also fire units-inline for these — they're separate diagnoses.
      continue;
    }

    if (
      param !== undefined &&
      param.units.length > 0 &&
      isNumericTypeChar(o.type) &&
      hasInlineUnits(o.valueStr)
    ) {
      out.push({
        class: "result_format_units_inline",
        severity: "info",
        message: `Numeric observation "${o.paramCode}" has units typed inline; PARMDICT already supplies "${param.units}".`,
        panel_code: o.panelCode,
        observation_code: o.paramCode,
        details: { value: o.valueStr, dictionary_units: param.units },
      });
    }
  }
  return out;
}

function detectSupersededIterations(input: AuditInputs, cb: Codebook): Anomaly[] {
  const out: Anomaly[] = [];
  for (const s of input.supersededIterations) {
    out.push({
      class: "panel_iterations_superseded",
      severity: "info",
      message: `Panel "${s.panelCode}" iteration ${s.panelIndex} (${s.observationCount} observation${s.observationCount === 1 ? "" : "s"}) was superseded by iteration ${s.supersededBy}.`,
      panel_code: s.panelCode,
      panel_index: s.panelIndex,
      details: {
        superseded_by_panel_index: s.supersededBy,
        observation_count: s.observationCount,
        panel_description: describePanel(cb, s.panelCode),
      },
    });
  }
  return out;
}

export function detectAnomalies(input: AuditInputs, cb: Codebook): Anomaly[] {
  return [
    ...detectPanelSpecimenMismatch(input, cb),
    ...detectObservationWrongPanel(input, cb),
    ...detectOrphanPanels(input, cb),
    ...detectSupersededIterations(input, cb),
    ...detectResultFormatIssues(input, cb),
    ...detectPatientAnomalies(input),
  ];
}

function nullIfEmpty(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  // mssql can return DateTime columns as Date objects; coerce defensively
  // so the date-anomaly detector and others still see a parseable string.
  const s = typeof v === "string" ? v : String(v);
  const t = s.trim();
  return t.length === 0 ? null : t;
}

export function auditFromSpecimen(
  specimen: SpecimenRecpt,
  prefix: string,
  cb: Codebook,
): AuditReport {
  const start = Date.now();
  // Run the audit against the same observation set that gets posted to v2 —
  // earlier panel iterations were already dropped by the v2 transform, so
  // running result-format / wrong-panel checks against them would emit
  // anomalies for data v2 never sees. The dropped iterations get their own
  // structured anomaly via detectSupersededIterations.
  const { kept: observations, superseded } = supersedePanelIterations(flattenDisa(specimen));
  const orderedPanels = collectOrderedPanels(specimen);
  const labNumber = nullIfEmpty(specimen.LabNumber) ?? "";
  const specimenCode = nullIfEmpty(specimen.Specimen);
  const input: AuditInputs = {
    labNumber,
    requestId: prefix + labNumber,
    specimenCode,
    orderedPanels,
    observations,
    supersededIterations: superseded,
    dobRaw: nullIfEmpty(specimen.DobAge),
    takenAtRaw: nullIfEmpty(specimen.TakenDateTime),
    collectedAtRaw: nullIfEmpty(specimen.CollectedDateTime),
    receivedAtRaw: nullIfEmpty(specimen.ReceivedInLabDateTime),
    sex: nullIfEmpty(specimen.Sex),
  };
  const anomalies = detectAnomalies(input, cb);
  return {
    lab_number: input.labNumber,
    request_id: input.requestId,
    source: "disa",
    scanned_panels: orderedPanels.length,
    scanned_observations: observations.length,
    anomalies,
    max_severity: maxSeverity(anomalies),
    elapsed_ms: Date.now() - start,
  };
}

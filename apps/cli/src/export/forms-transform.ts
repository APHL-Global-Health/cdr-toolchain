import type { SpecimenRecpt } from "disalab";
import { flattenDisa, supersedePanelIterations } from "../compare/result-mapping.js";
import type { Codebook } from "./codebook.js";
import type { SiteConfig } from "./site-config.js";
import { buildFacilityConcept, buildPatient } from "./v2-transform.js";
import { splitObservations, type DocConfig } from "./non-test.js";
import type { FormResponse, FormSubmissionPayload } from "./forms-types.js";

/**
 * Input shape for buildFormResponse. Uses a separate interface rather than
 * Pick<DisaObs, ...> because rawValue is string on DisaObs but callers may
 * supply a pre-structured Record (e.g. tests, or callers that already built
 * the raw_result object). toFormSubmission wraps DisaObs.rawValue into a
 * Record before calling here.
 */
interface ObsInput {
  panelCode: string;
  paramCode: string;
  valueStr: string;
  value: string | number;
  type: string;
  rawValue: Record<string, unknown>;
}

/** Classify a single DISA observation's value slot for the forms payload. */
export function buildFormResponse(
  o: ObsInput,
  ordinal: number,
  cb: Codebook,
  systemId: string,
): FormResponse {
  const c = o.type.length > 0 ? o.type.charCodeAt(0) : -1;
  const isNumeric = c === 1 || c === 2;
  const isCoded = c === 0 || c === 3 || c === 4 || c === 11 || c === 12;
  const valueType: FormResponse["value_type"] = isNumeric ? "numeric" : isCoded ? "coded" : "text";
  const desc = cb.paramEntry(o.paramCode)?.description ?? null;
  return {
    concept_code: {
      system_id: systemId,
      concept_code: o.paramCode,
      display_name: desc !== null && desc.length > 0 ? desc : null,
      concept_class: "test",
      datatype: "coded",
    },
    value_type: valueType,
    numeric_value: valueType === "numeric" && typeof o.value === "number" ? o.value : null,
    text_value: valueType === "text" ? o.valueStr : null,
    coded_value: valueType === "coded" ? o.valueStr : null,
    ordinal,
    raw_value: o.rawValue,
  };
}

export interface ToFormOpts {
  prefix: string;
  site: SiteConfig;
  codebook: Codebook;
  docConfig: DocConfig;
  /** request_id of the test leg when this is a split record; null otherwise. */
  relatedRequestId: string | null;
}

/**
 * Build a form-submission payload from a specimen's documentation observations.
 * Returns null when the specimen carries no documentation observations.
 */
export function toFormSubmission(specimen: SpecimenRecpt, opts: ToFormOpts): FormSubmissionPayload | null {
  const obs = supersedePanelIterations(flattenDisa(specimen)).kept;
  const { documentation } = splitObservations(obs, opts.codebook, opts.docConfig);
  if (documentation.length === 0) return null;

  const labNo = String(specimen.LabNumber).trim();
  const externalRef = opts.prefix + labNo;
  const facility = specimen.Facility ?? null;
  const submittedAt =
    nzIso(specimen.ReceivedInLabDateTime) ?? nzIso(specimen.CollectedDateTime) ?? nzIso(specimen.TakenDateTime);
  const patient = buildPatient(specimen, submittedAt, externalRef);

  // form_code: first documentation panel with a configured form mapping wins.
  let formCode: string | null = null;
  for (const o of documentation) {
    const mapped = opts.docConfig.forms.get(o.panelCode);
    if (mapped !== undefined) { formCode = mapped; break; }
  }

  const responses = documentation.map((o, i) => {
    // DisaObs.rawValue is a string; wrap it into the structured Record shape
    // that FormResponse.raw_value expects (mirrors how v2-transform builds
    // raw_result: { disa_type_code, raw_value }).
    const rawValue: Record<string, unknown> = {
      disa_type_code: o.type.length > 0 ? o.type.charCodeAt(0) : null,
      ...(o.rawValue.length > 0 && o.rawValue !== o.valueStr ? { raw_value: o.rawValue } : {}),
    };
    return buildFormResponse(
      { panelCode: o.panelCode, paramCode: o.paramCode, valueStr: o.valueStr, value: o.value, type: o.type, rawValue },
      i + 1,
      opts.codebook,
      opts.site.observation_system_id,
    );
  });

  return {
    submission: {
      external_ref: externalRef,
      source_system: "disa",
      related_request_id: opts.relatedRequestId,
      form_code: formCode,
      patient,
      facility_code: buildFacilityConcept(facility, opts.site),
      submitted_at: submittedAt,
      responses,
    },
  };
}

/** DISA "MM/DD/YYYY[ HH:MM[:SS]]" -> ISO-ish string; pass through otherwise. */
function nzIso(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  if (t.length === 0) return null;
  const m = t.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m === null) return t;
  const [, mm, dd, yyyy, hh, mi, ss] = m;
  return hh === undefined ? `${yyyy}-${mm}-${dd}` : `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss ?? "00"}`;
}

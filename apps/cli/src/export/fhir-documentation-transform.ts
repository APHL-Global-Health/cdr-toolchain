import type { SpecimenRecpt } from "disalab";
import { flattenDisa, supersedePanelIterations } from "../compare/result-mapping.js";
import { splitObservations, type DocConfig } from "./non-test.js";
import { isNumericTypeChar } from "./v2-transform.js";
import { fhirId, fhirDateTime, fhirText } from "./fhir-primitives.js";
import type { Codebook } from "./codebook.js";
import type { V2Payload } from "./types.js";

export type FhirResource = Record<string, unknown>;

export interface DocObs {
  panelCode: string;
  paramCode: string;
  valueStr: string;
  value: string | number;
  type: string;
}

export interface DocResourceCtx {
  patientRef: string;
  /** ServiceRequest reference id for split records; null for documentation-only. */
  basedOnRef: string | null;
  /** FHIR-ready authored timestamp (already tz-stamped), or undefined to omit. */
  authored: string | undefined;
  docConfig: DocConfig;
  codebook: Pick<Codebook, "paramEntry">;
}

function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/** Map a documentation obs value to a single QuestionnaireResponse answer, or null. */
function answerFor(o: DocObs): Record<string, unknown> | null {
  if (isNumericTypeChar(o.type) && typeof o.value === "number") return { valueDecimal: o.value };
  const s = fhirText(o.valueStr);
  return s !== undefined ? { valueString: s } : null;
}

/** Pure: documentation observations -> [Questionnaire..., QuestionnaireResponse...]. */
export function documentationResources(obs: DocObs[], ctx: DocResourceCtx): FhirResource[] {
  if (obs.length === 0) return [];

  // form_code: configured mapping wins, else fall back to the panel code so
  // nothing is silently lost.
  const formCodeOf = (panelCode: string): string => ctx.docConfig.forms.get(panelCode) ?? panelCode;

  // Group obs by form_code, preserving order.
  const groups = new Map<string, DocObs[]>();
  for (const o of obs) {
    const fc = formCodeOf(o.panelCode);
    const list = groups.get(fc) ?? [];
    list.push(o);
    groups.set(fc, list);
  }

  const questionnaires: FhirResource[] = [];
  const responses: FhirResource[] = [];

  for (const [formCode, groupObs] of groups) {
    questionnaires.push(compact({
      resourceType: "Questionnaire",
      id: fhirId(formCode),                         // underscores -> hyphens
      url: `urn:openldr:form:${formCode}`,          // canonical keeps underscores
      name: formCode,
      status: "active",                             // CE-required
    }));

    const item = groupObs
      .filter((o) => fhirText(o.paramCode) !== undefined)
      .map((o) => {
        const ans = answerFor(o);
        const desc = ctx.codebook.paramEntry(o.paramCode)?.description ?? null;
        return compact({
          linkId: o.paramCode,
          text: fhirText(desc),
          answer: ans !== null ? [ans] : undefined,
        });
      });

    responses.push(compact({
      resourceType: "QuestionnaireResponse",
      id: fhirId(`${ctx.patientRef.split("/")[1]}-${formCode}`),
      status: "completed",                          // CE-required
      questionnaire: `urn:openldr:form:${formCode}`,
      subject: { reference: ctx.patientRef },
      authored: ctx.authored,
      basedOn: ctx.basedOnRef !== null ? [{ reference: ctx.basedOnRef }] : undefined,
      item,
    }));
  }

  return [...questionnaires, ...responses];
}

export interface ToDocOpts {
  prefix: string;
  codebook: Codebook;
  docConfig: DocConfig;
  tzOffset: string;
}

/**
 * Thin wrapper: extract documentation obs from the specimen, derive the same
 * patient/root ids `toFhir` derives from the payload (so both legs point at one
 * patient in CE), and build the FHIR. Returns [] when the specimen carries no
 * documentation observations.
 */
export function toDocumentationFhir(specimen: SpecimenRecpt, payload: V2Payload, opts: ToDocOpts): FhirResource[] {
  const first = payload.lab_requests[0];
  if (first === undefined) return []; // no order graph -> nothing to attach to

  const rootId = fhirId(first.request_id);
  if (rootId === undefined) return [];
  // toFhir: patientId = fhirId(patient_guid) ?? rootId (patient_guid = request_id).
  const patientId = fhirId(payload.patient.patient_guid) ?? rootId;
  const patientRef = `Patient/${patientId}`;
  // Link documentation to the specimen's first ordered panel (its ServiceRequest).
  const basedOnRef = `ServiceRequest/${rootId}-obr${first.obr_set_id}`;
  // Reuse the normalized order timestamps the payload already carries.
  const authored = fhirDateTime(first.received_at ?? first.collected_datetime ?? first.taken_datetime, opts.tzOffset);

  const allObs = supersedePanelIterations(flattenDisa(specimen)).kept as DocObs[];
  const { documentation } = splitObservations(allObs, opts.codebook, opts.docConfig);
  if (documentation.length === 0) return [];

  return documentationResources(documentation, {
    patientRef,
    basedOnRef,
    authored,
    docConfig: opts.docConfig,
    codebook: opts.codebook,
  });
}

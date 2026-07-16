// V2Payload -> FHIR R4 resources. Pure; no I/O.
//
// Derived by INVERTING openldr-v2's
// apps/openldr-minio/default-plugins/schema/hl7-fhir.schema.js, which maps
// FHIR -> the same canonical record toV2 emits. Anchors:
//   Patient <- hl7-fhir.schema.js:913-926
//   ServiceRequest/Specimen/DiagnosticReport <- hl7-fhir.schema.js:927-956
//   result_status <-> DiagnosticReport.status <- hl7-fhir.schema.js:300-314
import type { V2Payload, V2Patient, V2ConceptCode, V2LabRequest, V2LabResult } from "./types.js";
import { fhirId, fhirDateTime, fhirText } from "./fhir-primitives.js";

export type FhirResource = Record<string, unknown>;

export interface ToFhirOptions {
  /** UTC offset for DISA's unzoned local timestamps, e.g. "+02:00". Required:
   *  DISA stores local wall-clock and assuming UTC would shift Moz/Zambia
   *  (UTC+2) timestamps 2h earlier with no error. */
  tzOffset: string;
}

/** V2 sex (M/F/U/I) -> FHIR administrative-gender. */
function toGender(sex: string | null): string | undefined {
  switch ((sex ?? "").trim().toUpperCase()) {
    case "M": return "male";
    case "F": return "female";
    case "U": return "unknown";
    case "I": return "other"; // HL7 Indeterminate has no FHIR equivalent
    default: return undefined;
  }
}

/** Drop undefined values so we never emit `"field": undefined`. */
function compact<T extends Record<string, unknown>>(o: T): T {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

function patientResource(
  p: V2Patient, id: string | undefined, opts: ToFhirOptions,
): FhirResource {
  const given = [fhirText(p.firstname), fhirText(p.middlename)].filter(
    (v): v is string => v !== undefined,
  );
  const name = compact({
    family: fhirText(p.surname),
    ...(given.length > 0 ? { given } : {}),
  });

  const identifier: Record<string, unknown>[] = [];
  const folder = fhirText(p.folder_no);
  if (folder !== undefined) identifier.push({ system: "urn:openldr:folder-no", value: folder });
  const nid = fhirText(p.national_id);
  if (nid !== undefined) {
    identifier.push({
      system: "urn:openldr:national-id",
      value: nid,
      type: { coding: [{ system: "http://terminology.hl7.org/CodeSystem/v2-0203", code: "NI" }] },
    });
  }

  const telecom: Record<string, unknown>[] = [];
  const phone = fhirText(p.phone);
  if (phone !== undefined) telecom.push({ system: "phone", value: phone });
  const email = fhirText(p.email);
  if (email !== undefined) telecom.push({ system: "email", value: email });

  return compact({
    resourceType: "Patient",
    id,
    ...(identifier.length > 0 ? { identifier } : {}),
    ...(Object.keys(name).length > 0 ? { name: [name] } : {}),
    gender: toGender(p.sex),
    birthDate: fhirDateTime(p.date_of_birth, opts.tzOffset),
    ...(telecom.length > 0 ? { telecom } : {}),
  });
}

/** V2 system_id -> a code system URI. DISA-native systems have no public URI,
 *  so they become urn:openldr:* — mirrors how hl7-fhir.schema.js keeps
 *  source_system_url alongside the concept (:37-47). */
function systemUri(systemId: string | undefined): string | undefined {
  const s = fhirText(systemId ?? null);
  return s === undefined ? undefined : `urn:openldr:${s.toLowerCase()}`;
}

function toCodeableConcept(c: V2ConceptCode | null): Record<string, unknown> | undefined {
  if (c === null) return undefined;
  const code = fhirText(c.concept_code);
  if (code === undefined) return undefined;
  return compact({
    coding: [compact({ system: systemUri(c.system_id), code, display: fhirText(c.display_name) })],
    text: fhirText(c.display_name),
  });
}

/** hl7-fhir.schema.js:300-314 maps FHIR status -> F/P/C/X/R/I. Inverted here.
 *  Never returns undefined: CE requires DiagnosticReport.status. */
function toReportStatus(rs: string | null): string {
  switch ((rs ?? "").trim().toUpperCase()) {
    case "F": return "final";
    case "P": return "preliminary";
    case "C": return "corrected";
    case "X": return "cancelled";
    case "R": return "registered";
    case "I": return "registered";
    default: return "unknown";
  }
}

/** CE requires DiagnosticReport.code, but DISA can leave the panel absent.
 *  data-absent-reason says "we don't know" honestly rather than inventing one. */
const UNKNOWN_CODE = {
  coding: [{ system: "http://terminology.hl7.org/CodeSystem/data-absent-reason", code: "unknown" }],
  text: "unknown",
};

function requestResources(
  lr: V2LabRequest, patientRef: string, rootId: string, opts: ToFhirOptions,
): FhirResource[] {
  const out: FhirResource[] = [];
  const panel = toCodeableConcept(lr.panel_code) ?? UNKNOWN_CODE;

  out.push(compact({
    resourceType: "ServiceRequest",
    id: rootId,
    status: "completed",     // CE-required
    intent: "order",         // CE-required
    subject: { reference: patientRef },
    code: panel,
    ...(fhirText(lr.clinical_info) !== undefined
      ? { note: [{ text: fhirText(lr.clinical_info) }] } : {}),
    ...(fhirText(lr.requesting_doctor) !== undefined
      ? { requester: { display: fhirText(lr.requesting_doctor) } } : {}),
  }));

  const specimenId = fhirId(`${rootId}-spec`);
  const collection = compact({ collectedDateTime: fhirDateTime(lr.collected_datetime, opts.tzOffset) });
  out.push(compact({
    resourceType: "Specimen",
    id: specimenId,
    subject: { reference: patientRef },
    type: toCodeableConcept(lr.specimen_code),
    receivedTime: fhirDateTime(lr.received_at, opts.tzOffset),
    ...(Object.keys(collection).length > 0 ? { collection } : {}),
  }));

  out.push(compact({
    resourceType: "DiagnosticReport",
    id: rootId,
    status: toReportStatus(lr.result_status),  // CE-required
    code: panel,                               // CE-required
    subject: { reference: patientRef },
    ...(specimenId !== undefined ? { specimen: [{ reference: `Specimen/${specimenId}` }] } : {}),
    effectiveDateTime: fhirDateTime(lr.taken_datetime ?? lr.collected_datetime, opts.tzOffset),
    issued: fhirDateTime(lr.authorised_at, opts.tzOffset),
    basedOn: [{ reference: `ServiceRequest/${rootId}` }],
    ...(fhirText(lr.testing_facility_code?.display_name ?? null) !== undefined
      ? { performer: [{ display: fhirText(lr.testing_facility_code!.display_name) }] } : {}),
  }));

  return out;
}

/** "4.0-11.0" -> {low,high}; anything else -> {text}. Never returns undefined
 *  for a non-empty input, so a range is preserved either way. */
function toReferenceRange(
  range: string | null, unit: string | undefined,
): Record<string, unknown> | undefined {
  const t = fhirText(range);
  if (t === undefined) return undefined;
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)\s*$/.exec(t);
  if (m !== null) {
    return {
      low: compact({ value: Number(m[1]), unit }),
      high: compact({ value: Number(m[2]), unit }),
    };
  }
  return { text: t };
}

function observationResource(
  r: V2LabResult, patientRef: string, rootId: string, index: number, opts: ToFhirOptions,
): FhirResource {
  const unit = fhirText(r.numeric_units) ?? fhirText(r.rpt_units);

  // value[x] — at most one. Order inverts hl7-fhir.schema.js:324-334.
  let value: Record<string, unknown> = {};
  if (r.numeric_value !== null) {
    value = { valueQuantity: compact({ value: r.numeric_value, unit }) };
  } else if (fhirText(r.coded_value) !== undefined) {
    value = {
      valueCodeableConcept: compact({
        coding: [compact({ code: fhirText(r.coded_value), display: fhirText(r.result_value) })],
        text: fhirText(r.result_value),
      }),
    };
  } else {
    const s = fhirText(r.result_value) ?? fhirText(r.text_value);
    if (s !== undefined) value = { valueString: s };
  }

  const flag = fhirText(r.abnormal_flag);
  const refRange = toReferenceRange(r.rpt_range, unit);

  return compact({
    resourceType: "Observation",
    id: fhirId(`${rootId}-obs-${index}`),
    status: "final",  // CE-required
    code: toCodeableConcept(r.observation_code) ?? UNKNOWN_CODE,
    subject: { reference: patientRef },
    effectiveDateTime: fhirDateTime(r.result_timestamp, opts.tzOffset),
    ...value,
    // The v2 reference nulls these on its FHIR path (:802-805) but populates
    // them on its v2 path (:192-194) — going FHIR-ward we map rather than drop.
    ...(flag !== undefined
      ? { interpretation: [{ coding: [{ system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation", code: flag }] }] }
      : {}),
    ...(refRange !== undefined ? { referenceRange: [refRange] } : {}),
  });
}

export function toFhir(payload: V2Payload, opts: ToFhirOptions): FhirResource[] {
  const rootId = fhirId(payload.lab_request.request_id);
  if (rootId === undefined) {
    throw new Error(
      `request_id ${JSON.stringify(payload.lab_request.request_id)} sanitises to an empty FHIR id`,
    );
  }
  // toV2 sets patient_guid = request_id (v2-transform.ts:197) because DISA has
  // no patient identity — so there is no cross-visit patient dedup.
  const patientId = fhirId(payload.patient.patient_guid) ?? rootId;
  const patientRef = `Patient/${patientId}`;

  const observations = payload.lab_results.map((r, i) =>
    observationResource(r, patientRef, rootId, i + 1, opts),
  );

  const out = [
    patientResource(payload.patient, patientId, opts),
    ...requestResources(payload.lab_request, patientRef, rootId, opts),
    ...observations,
  ];

  const dr = out.find((res) => res.resourceType === "DiagnosticReport");
  if (dr !== undefined && observations.length > 0) {
    dr.result = observations.map((o) => ({ reference: `Observation/${o.id as string}` }));
  }
  return out;
}

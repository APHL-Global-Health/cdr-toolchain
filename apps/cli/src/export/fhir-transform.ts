// V2Payload -> FHIR R4 resources. Pure; no I/O.
//
// Derived by INVERTING openldr-v2's
// apps/openldr-minio/default-plugins/schema/hl7-fhir.schema.js, which maps
// FHIR -> the same canonical record toV2 emits. Anchors:
//   Patient <- hl7-fhir.schema.js:913-926
//   ServiceRequest/Specimen/DiagnosticReport <- hl7-fhir.schema.js:927-956
//   result_status <-> DiagnosticReport.status <- hl7-fhir.schema.js:300-314
import type {
  V2Payload, V2Patient, V2ConceptCode, V2LabRequest, V2LabResult, V2Isolate, V2SusceptibilityTest,
} from "./types.js";
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
    case "I": return "partial";  // :309 maps "partial" -> I; this is its inverse
    default: return "unknown";
  }
}

/** A cancelled result means the ORDER was revoked — ServiceRequest has no
 *  "cancelled". Anything else: this mapper only runs over resulted records,
 *  so the order is definitionally complete. */
function toRequestStatus(rs: string | null): string {
  return (rs ?? "").trim().toUpperCase() === "X" ? "revoked" : "completed";
}

/** Interpretation coding system — carries lab abnormal_flag (H/L/...) as well
 *  as susceptibility S/I/R; both are ObservationInterpretation values. */
const INTERPRETATION_SYSTEM = "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation";

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
    // Must not contradict the co-located DiagnosticReport.status.
    status: toRequestStatus(lr.result_status),  // CE-required
    intent: "order",                            // CE-required
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
      ? { interpretation: [{ coding: [{ system: INTERPRETATION_SYSTEM, code: flag }] }] }
      : {}),
    ...(refRange !== undefined ? { referenceRange: [refRange] } : {}),
  });
}

/** Susceptibility (AST) Observation. toV2 gives isolates directly with a
 *  source_test_code, so there is no separate culture wrapper to synthesise —
 *  this is the leaf of a 2-tier isolate -> AST tree (hl7-fhir.schema.js:496-518
 *  is 3-tier: culture -> isolate -> AST). */
function astResource(
  s: V2SusceptibilityTest, patientRef: string, rootId: string, index: number,
): FhirResource {
  // An unknown test_method asserts no measurement type — mirrors how the
  // sibling `method` field omits itself rather than guessing "Zone diameter".
  const component =
    s.result_numeric !== null
      ? [compact({
          ...(s.test_method !== null
            ? { code: { text: s.test_method === "MIC" ? "MIC" : "Zone diameter" } }
            : {}),
          valueQuantity: compact({ value: s.result_numeric }),
        })]
      : undefined;

  return compact({
    resourceType: "Observation",
    id: fhirId(`${rootId}-ast-${index}`),
    status: "final",  // CE-required
    code: toCodeableConcept(s.antibiotic_code) ?? UNKNOWN_CODE,
    subject: { reference: patientRef },
    // S/I/R is an interpretation, not a value — inverts hl7-fhir.schema.js:528-553.
    ...(s.susceptibility_value !== null
      ? { interpretation: [{ coding: [{ system: INTERPRETATION_SYSTEM, code: s.susceptibility_value }] }] }
      : {}),
    ...(fhirText(s.result_raw) !== undefined ? { valueString: fhirText(s.result_raw) } : {}),
    ...(s.test_method !== null ? { method: { text: s.test_method } } : {}),
    ...(component !== undefined ? { component } : {}),
    ...(fhirText(s.guideline) !== undefined ? { note: [{ text: fhirText(s.guideline) }] } : {}),
  });
}

/** Isolate Observation — the culture-level organism finding. */
function isolateResource(
  iso: V2Isolate, patientRef: string, rootId: string,
): FhirResource {
  return compact({
    resourceType: "Observation",
    id: fhirId(`${rootId}-iso-${iso.isolate_index}`),
    status: "final",  // CE-required
    code: { text: fhirText(iso.source_test_code) ?? "Isolate" },
    subject: { reference: patientRef },
    valueCodeableConcept: toCodeableConcept(iso.organism_code) ?? UNKNOWN_CODE,
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
  // isolate_index is V2's join key between isolates and their ASTs. Duplicates
  // would collide on CE's (resource_type, id) upsert: the survivor would be the
  // LAST written, but hasMember would have been linked to the FIRST — silently
  // orphaning an AST. Upstream (v2-transform.ts:526) assigns i+1 per request so
  // this cannot happen today; we refuse rather than rely on that staying true.
  const byIndex = new Map<number, FhirResource>();
  for (const iso of payload.isolates) {
    if (byIndex.has(iso.isolate_index)) {
      throw new Error(
        `duplicate isolate_index ${iso.isolate_index} in ${payload.lab_request.request_id} — cannot map isolates unambiguously`,
      );
    }
    byIndex.set(iso.isolate_index, isolateResource(iso, patientRef, rootId));
  }
  const isolates = [...byIndex.values()];

  const asts = payload.susceptibility_tests.map((s, i) =>
    astResource(s, patientRef, rootId, i + 1),
  );

  // Hang each AST off its isolate. An AST whose isolate_index matches nothing
  // (or is null) is still emitted — unlinked, never silently dropped.
  payload.susceptibility_tests.forEach((s, i) => {
    const host = s.isolate_index === null ? undefined : byIndex.get(s.isolate_index);
    if (host === undefined) return;
    const members = (host.hasMember as { reference: string }[] | undefined) ?? [];
    members.push({ reference: `Observation/${asts[i]!.id as string}` });
    host.hasMember = members;
  });

  const out = [
    patientResource(payload.patient, patientId, opts),
    ...requestResources(payload.lab_request, patientRef, rootId, opts),
    ...observations,
    ...isolates,
    ...asts,
  ];

  const dr = out.find((res) => res.resourceType === "DiagnosticReport");
  // The report indexes lab-result Observations and isolates, but NOT ASTs —
  // those are reachable via their isolate's hasMember (2-tier tree).
  const indexed = [...observations, ...isolates];
  if (dr !== undefined && indexed.length > 0) {
    dr.result = indexed.map((o) => ({ reference: `Observation/${o.id as string}` }));
  }
  return out;
}

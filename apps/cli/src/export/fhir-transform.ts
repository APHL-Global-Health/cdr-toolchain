// V2Payload -> FHIR R4 resources. Pure; no I/O.
//
// Derived by INVERTING openldr-v2's
// apps/openldr-minio/default-plugins/schema/hl7-fhir.schema.js, which maps
// FHIR -> the same canonical record toV2 emits. Anchors:
//   Patient <- hl7-fhir.schema.js:913-926
import type { V2Payload, V2Patient } from "./types.js";
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
  return [patientResource(payload.patient, patientId, opts)];
}

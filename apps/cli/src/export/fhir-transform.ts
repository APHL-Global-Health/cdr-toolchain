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

/** DISA/HL7 priority -> FHIR request-priority. Measured over 3.4M v1 rows the
 *  source emits exactly R/U/S, so this mapping is total; anything else is
 *  omitted rather than guessed. */
function toPriority(p: string | null): string | undefined {
  switch ((p ?? "").trim().toUpperCase()) {
    case "R": return "routine";
    case "U": return "urgent";
    case "S": return "stat";
    default: return undefined;
  }
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

/**
 * The COLLECTION time — R4's `effective[x]` is "the physiologically relevant
 * time … usually either the time of the procedure or **of specimen collection**"
 * (https://hl7.org/fhir/R4/observation-definitions.html). ONE rule, shared by
 * DiagnosticReport and Observation, so the two cannot drift.
 *
 * ⛔ THE ORDER IS `collected ?? taken` AND IT IS MEASURED, not chosen. This file
 * previously used `taken ?? collected` — INVERTED — and the design for the
 * timestamps slice told us to copy that expression to the Observation. Graded
 * against v1's SpecimenDateTime (the oracle) on a random spread sample (147 labs
 * with a v1 counterpart), 2026-07-17:
 *
 *   collected ?? taken   100.0%   <- this
 *   taken ?? collected    93.9%   <- what the design said to copy
 *   collected alone       52.4%   (so the fallback is load-bearing, not padding)
 *
 * The 6.1pp gap is real: on the 9 labs where BOTH are present and DIFFER,
 * `collected` is the one v1 means, every time. `taken` is never WRONG, only
 * ABSENT — which is exactly why the fallback must stay.
 *
 * ⚠ Those rates are only true because disalab's RTKNIDX5.TAKENDATE cast was
 * fixed (Core.DateOnlyIso). Before that, `taken` was a raw Date.toString() on
 * 92.5% of labs, fhirDateTime returned undefined, and this key vanished
 * silently. Both halves are required: the expression alone scores 52.4%.
 */
function collectionTime(lr: V2LabRequest): string | null {
  return lr.collected_datetime ?? lr.taken_datetime;
}

/**
 * The Specimen is SPECIMEN-level — one per lab, not per OBR. DISA records one
 * specimen per request (which is why a panel/specimen mismatch is an audit
 * anomaly, not a second Specimen). Built once, outside the per-OBR loop:
 * emitting it inside would produce N resources sharing one id, and CE's
 * (resource_type, id) upsert would silently keep only the last.
 */
function specimenResource(
  lr: V2LabRequest, patientRef: string, specimenId: string | undefined, opts: ToFhirOptions,
): FhirResource {
  const collection = compact({ collectedDateTime: fhirDateTime(lr.collected_datetime, opts.tzOffset) });
  return compact({
    resourceType: "Specimen",
    id: specimenId,
    subject: { reference: patientRef },
    type: toCodeableConcept(lr.specimen_code),
    receivedTime: fhirDateTime(lr.received_at, opts.tzOffset),
    ...(Object.keys(collection).length > 0 ? { collection } : {}),
  });
}

/**
 * One OBR = one ServiceRequest + one DiagnosticReport.
 *
 * OBR is the ORDER, so ServiceRequest + DiagnosticReport is the idiomatic
 * mapping, not a workaround.
 *
 * ⚠ The report is emitted even when the OBR has NO results — an
 * ordered-but-unresulted panel (v1 status 'I') or a superseded iteration (v1
 * keeps the order row with zero results). The spec's first draft said report
 * "for the surviving iterations only", but that sentence was written without
 * reading this file: `no DiagnosticReport.result key when there are no results`
 * (fhir-transform.test.ts) already pins the opposite as a DELIBERATE decision —
 * the report is emitted, and `result` is simply omitted. Its `status` carries
 * the truth (partial / registered / cancelled), so an empty report asserts
 * nothing false, and keeping it preserves behaviour for single-panel labs.
 *
 * ⚠ FHIR has no native OBR set-id field; `identifier` carries it, matching the
 * existing urn:openldr:request-id / folder-no / national-id pattern.
 */
function requestResources(
  lr: V2LabRequest, patientRef: string, obrId: string, specimenId: string | undefined,
  opts: ToFhirOptions,
): FhirResource[] {
  const out: FhirResource[] = [];
  const panel = toCodeableConcept(lr.panel_code) ?? UNKNOWN_CODE;
  const identifier = [
    ...(fhirText(lr.request_id) !== undefined
      ? [{ system: "urn:openldr:request-id", value: fhirText(lr.request_id) }] : []),
    { system: "urn:openldr:obr-set-id", value: String(lr.obr_set_id) },
  ];

  out.push(compact({
    resourceType: "ServiceRequest",
    id: obrId,
    // Must not contradict the co-located DiagnosticReport.status.
    status: toRequestStatus(lr.result_status),  // CE-required
    intent: "order",                            // CE-required
    subject: { reference: patientRef },
    code: panel,
    identifier,
    priority: toPriority(lr.priority),
    authoredOn: fhirDateTime(lr.registered_at, opts.tzOffset),
    ...(fhirText(lr.clinical_info) !== undefined
      ? { note: [{ text: fhirText(lr.clinical_info) }] } : {}),
    ...(fhirText(lr.requesting_doctor) !== undefined
      ? { requester: { display: fhirText(lr.requesting_doctor) } } : {}),
  }));

  out.push(compact({
    resourceType: "DiagnosticReport",
    id: obrId,
    status: toReportStatus(lr.result_status),  // CE-required
    code: panel,                               // CE-required
    subject: { reference: patientRef },
    identifier,
    ...(specimenId !== undefined ? { specimen: [{ reference: `Specimen/${specimenId}` }] } : {}),
    effectiveDateTime: fhirDateTime(collectionTime(lr), opts.tzOffset),
    issued: fhirDateTime(lr.authorised_at, opts.tzOffset),
    basedOn: [{ reference: `ServiceRequest/${obrId}` }],
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
  r: V2LabResult, patientRef: string, rootId: string, obrId: string, specimenId: string | undefined,
  collectionIso: string | null,
  index: number, opts: ToFhirOptions,
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
    // Hangs off ITS OWN OBR's order, not a lab-wide one — that linkage is the
    // whole point of the slice. FHIR has no OBX set-id field either, so
    // obx_set_id rides on identifier alongside it (spec §5.3).
    identifier: [{ system: "urn:openldr:obx-set-id", value: String(r.obx_set_id) }],
    basedOn: [{ reference: `ServiceRequest/${obrId}` }],
    ...(specimenId !== undefined ? { specimen: { reference: `Specimen/${specimenId}` } } : {}),
    // ⛔ THE BUG THIS SLICE EXISTS TO FIX. This read `r.result_timestamp` — the
    // RESULT time in the COLLECTION field, the same semantic mismatch this
    // workstream has been chasing everywhere else, in our own code. R4:
    // effective[x] is "the physiologically relevant time … usually … of specimen
    // collection". And result_timestamp is a hardcoded null (v2-transform.ts:501)
    // ⇒ fhirDateTime(null) ⇒ undefined ⇒ compact() dropped the key ⇒ 0 of 135
    // ingested CE Observations carried ANY time, which is why q-amr-resistance
    // and q-amr-facility-summary return ZERO rows for any range, silently.
    //
    // ⚠ Date-only stays date-only ("2013-09-20"): fhirDateTime passes it through
    // unzoned, and CE's DATETIME_RE accepts it. Never stamp midnight.
    effectiveDateTime: fhirDateTime(collectionIso, opts.tzOffset),
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
  s: V2SusceptibilityTest, patientRef: string, rootId: string, obrId: string,
  specimenId: string | undefined,
  collectionIso: string | null,
  index: number,
  opts: ToFhirOptions,
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
    basedOn: [{ reference: `ServiceRequest/${obrId}` }],
    ...(specimenId !== undefined ? { specimen: { reference: `Specimen/${specimenId}` } } : {}),
    // ⛔ THE AMR ZERO-ROW BUG LIVED HERE, and the design never looked. An AST
    // Observation had NO time at all — the field was simply absent, not stubbed.
    // CE projects `result_timestamp: str(r['effectiveDateTime'])`, so every AST
    // row landed with a NULL timestamp, and q-amr-resistance /
    // q-amr-facility-summary filter on `abnormal_flag in ('S','I','R')` — which
    // is EXACTLY the AST rows. Fixing only observationResource (which the design
    // pointed at) left all 31 flagged rows timeless and the queries still at
    // ZERO. Caught by the live re-ingest, not by any test.
    //
    // Same collection time as every other observation off this specimen: R4's
    // effective[x] is the physiologically relevant time, and an AST run on an
    // isolate from this specimen was collected when the specimen was.
    effectiveDateTime: fhirDateTime(collectionIso, opts.tzOffset),
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

/** Isolate Observation — the culture-level organism finding.
 *
 *  Coded LOINC 634-6 "Bacteria identified": CE derives AMR reporting from
 *  lab_results by convention (reporting/src/amr/query.ts:13-15), matching
 *  observation_code = '634-6' for organisms. source_test_code is preserved
 *  as a second coding so nothing is lost, but LOINC comes first — CE's
 *  codeable() reads coding[0] only. */
function isolateResource(
  iso: V2Isolate, patientRef: string, rootId: string, obrId: string,
  specimenId: string | undefined,
  collectionIso: string | null,
  opts: ToFhirOptions,
): FhirResource {
  return compact({
    resourceType: "Observation",
    id: fhirId(`${rootId}-iso-${iso.isolate_index}`),
    // isolate ids stay keyed on rootId (isolate_index is lab-unique), but the
    // ORDER it hangs from is its own OBR's.
    status: "final",  // CE-required
    code: compact({
      coding: [
        { system: "http://loinc.org", code: "634-6", display: "Bacteria identified" },
        ...(fhirText(iso.source_test_code) !== undefined
          ? [{ system: "urn:openldr:default_test", code: fhirText(iso.source_test_code) }] : []),
      ],
      text: "Bacteria identified",
    }),
    subject: { reference: patientRef },
    basedOn: [{ reference: `ServiceRequest/${obrId}` }],
    ...(specimenId !== undefined ? { specimen: { reference: `Specimen/${specimenId}` } } : {}),
    // Same rule as the AST and lab-result Observations — one collection time per
    // specimen. An isolate with no time is invisible to every dated AMR report.
    effectiveDateTime: fhirDateTime(collectionIso, opts.tzOffset),
    valueCodeableConcept: toCodeableConcept(iso.organism_code) ?? UNKNOWN_CODE,
  });
}

export function toFhir(payload: V2Payload, opts: ToFhirOptions): FhirResource[] {
  // Every lab_request of a lab shares one request_id — they differ by
  // obr_set_id — so any of them yields the same rootId.
  const first = payload.lab_requests[0];
  if (first === undefined) {
    throw new Error("payload has no lab_requests — cannot derive a FHIR resource graph");
  }
  const rootId = fhirId(first.request_id);
  if (rootId === undefined) {
    throw new Error(
      `request_id ${JSON.stringify(first.request_id)} sanitises to an empty FHIR id`,
    );
  }
  // ⚠ The ONLY place an OBR-scoped id is derived — everything referencing a
  // ServiceRequest goes through this, so the logic cannot drift (the property
  // the previous single-rootId derivation had, preserved).
  const obrId = (obrSetId: number): string => `${rootId}-obr${obrSetId}`;
  // toV2 sets patient_guid = request_id (v2-transform.ts:197) because DISA has
  // no patient identity — so there is no cross-visit patient dedup.
  const patientId = fhirId(payload.patient.patient_guid) ?? rootId;
  const patientRef = `Patient/${patientId}`;
  // Derived once here and threaded through every builder (requestResources,
  // observationResource, isolateResource, astResource) so the id-derivation
  // logic lives in exactly one place and cannot drift.
  const specimenId = fhirId(`${rootId}-spec`);

  const observations = payload.lab_results.map((r, i) =>
    // Collection time is SPECIMEN-level (read off the SpecimenRecpt, not the
    // panel), so it is identical across OBRs — `first` serves for every result.
    observationResource(r, patientRef, rootId, obrId(r.obr_set_id), specimenId, collectionTime(first), i + 1, opts),
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
        `duplicate isolate_index ${iso.isolate_index} in ${first.request_id} — cannot map isolates unambiguously`,
      );
    }
    byIndex.set(iso.isolate_index, isolateResource(iso, patientRef, rootId, obrId(iso.obr_set_id), specimenId, collectionTime(first), opts));
  }
  const isolates = [...byIndex.values()];

  const asts = payload.susceptibility_tests.map((s, i) =>
    astResource(s, patientRef, rootId, obrId(s.obr_set_id), specimenId, collectionTime(first), i + 1, opts),
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
    specimenResource(first, patientRef, specimenId, opts),
    ...payload.lab_requests.flatMap((lr) =>
      requestResources(lr, patientRef, obrId(lr.obr_set_id), specimenId, opts),
    ),
    ...observations,
    ...isolates,
    ...asts,
  ];

  // Each report indexes the lab-result Observations and isolates of ITS OWN OBR,
  // but NOT ASTs — those are reachable via their isolate's hasMember (2-tier
  // tree). Previously one report indexed every observation in the lab; with N
  // reports that would file another panel's results under this one.
  const indexedByObr = new Map<number, FhirResource[]>();
  const indexObs = (obr: number, res: FhirResource): void => {
    const arr = indexedByObr.get(obr) ?? [];
    arr.push(res);
    indexedByObr.set(obr, arr);
  };
  payload.lab_results.forEach((r, i) => indexObs(r.obr_set_id, observations[i]!));
  payload.isolates.forEach((iso) => {
    const res = byIndex.get(iso.isolate_index);
    if (res !== undefined) indexObs(iso.obr_set_id, res);
  });

  for (const res of out) {
    if (res.resourceType !== "DiagnosticReport") continue;
    const obr = Number(
      (res.identifier as { system: string; value: string }[]).find(
        (i) => i.system === "urn:openldr:obr-set-id",
      )!.value,
    );
    const indexed = indexedByObr.get(obr) ?? [];
    if (indexed.length > 0) {
      res.result = indexed.map((o) => ({ reference: `Observation/${o.id as string}` }));
    }
  }
  return out;
}

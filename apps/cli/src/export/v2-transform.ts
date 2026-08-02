import type { Facility, SpecimenRecpt } from "disalab";
import {
  detectDisaRejection,
  flattenDisa,
  parseNumber,
  supersedePanelIterations,
  type DisaObs,
  type DisaRejection,
} from "../compare/result-mapping.js";
import type { AuditReport } from "../audit/types.js";
import { deriveObrSets, linkObsToObr, type ObrSet } from "./obr-sets.js";
import { buildStatusByObr, type ObrStatus } from "./review-status.js";
import type { Codebook } from "./codebook.js";
import type { SiteConfig } from "./site-config.js";
import type { BlobOffsets } from "../config/blob-offsets.js";
import type {
  V2ConceptCode,
  V2DataQuality,
  V2Isolate,
  V2LabRequest,
  V2LabResult,
  V2Patient,
  V2Payload,
  V2SusceptibilityTest,
} from "./types.js";

// ---------- helpers ---------------------------------------------------------

function nz(s: unknown): string | null {
  if (s === null || s === undefined) return null;
  // mssql / disalab can return Date or numeric values for fields typed as
  // string in the disalab interface. Coerce defensively so downstream
  // helpers (.trim, regex matches) don't blow up mid-export.
  const str = typeof s === "string" ? s : String(s);
  const t = str.trim();
  return t.length > 0 ? t : null;
}

/**
 * DISA stores datetimes pre-formatted as "MM/DD/YYYY HH:MM" (or "MM/DD/YYYY"
 * for date-only values). Pass through to a YYYY-MM-DDTHH:MM:SS string so the
 * v2 payload at least looks ISO-shaped. No timezone — DISA stores local
 * time; v2 is responsible for tz interpretation per deployment (PRD §5.1).
 */
function disaToIso(s: string | null | undefined): string | null {
  const trimmed = nz(s);
  if (trimmed === null) return null;
  const dateTime = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dateTime === null) return trimmed; // pass through anything we don't recognise
  const [, mm, dd, yyyy, hh, mi, ss] = dateTime;
  if (hh === undefined) return `${yyyy}-${mm}-${dd}`;
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss ?? "00"}`;
}

/**
 * ⛔ Do NOT use Date#toISOString() here. Every other datetime on the payload is
 * emitted by disaToIso as LOCAL-form ISO with no offset and no milliseconds
 * (`2018-05-18T09:00:00`, above). toISOString() would emit `...T06:00:00.000Z`
 * on a UTC+3 host — a silent whole-timezone shift that the gate's comparator
 * reads as a mismatch, or worse, as a plausible wrong time.
 *
 * Uses LOCAL getters deliberately: decodeLongDatetime (compare/disa-datetime-
 * candidates.ts) builds its Date with `new Date(y, m, d, h, mi, 0)` — the local
 * constructor — so the wall-clock time is carried in the local components.
 */
function dateToLocalIso(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
         `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** True if the OrderItem.Type byte indicates a numeric slot (1=Real, 2=Int). */
export function isNumericTypeChar(typeChar: string): boolean {
  if (typeChar.length === 0) return false;
  const c = typeChar.charCodeAt(0);
  return c === 1 || c === 2;
}

/** True if the OrderItem.Type byte indicates a coded slot (0/3/4/11/12). */
export function isCodedTypeChar(typeChar: string): boolean {
  if (typeChar.length === 0) return false;
  const c = typeChar.charCodeAt(0);
  return c === 0 || c === 3 || c === 4 || c === 11 || c === 12;
}

/** True if the OrderItem.Type byte indicates a free-text slot (5/6). */
function isTextTypeChar(typeChar: string): boolean {
  if (typeChar.length === 0) return false;
  const c = typeChar.charCodeAt(0);
  return c === 5 || c === 6;
}

function v2ResultTypeFromDisaType(typeChar: string): string | null {
  if (isNumericTypeChar(typeChar)) return "NM";
  if (isCodedTypeChar(typeChar)) return "CE";
  if (isTextTypeChar(typeChar)) return "TX";
  if (typeChar.length === 0) return null;
  const c = typeChar.charCodeAt(0);
  if (c === 7) return "DT";
  if (c === 8) return "TM";
  return null;
}

/**
 * Parse DISA's DobAge field (`MM/DD/YYYY` for a real DOB) to ISO date.
 * Some rows store an age string instead — we only convert recognisable
 * dates, leaving garbage as null so callers can fall back to age fields.
 */
function dobToIso(raw: string | null | undefined): string | null {
  const trimmed = nz(raw);
  if (trimmed === null) return null;
  const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m === null) return null;
  return `${m[3]}-${m[1]}-${m[2]}`;
}

/** Year delta between two ISO-shaped dates, or null if either is unparseable. */
function ageYearsBetween(birthIso: string | null, refIso: string | null): number | null {
  if (birthIso === null || refIso === null) return null;
  const b = new Date(birthIso);
  const r = new Date(refIso);
  if (Number.isNaN(b.getTime()) || Number.isNaN(r.getTime())) return null;
  let years = r.getFullYear() - b.getFullYear();
  const monthDelta = r.getMonth() - b.getMonth();
  if (monthDelta < 0 || (monthDelta === 0 && r.getDate() < b.getDate())) years -= 1;
  return years >= 0 ? years : null;
}

function ageDaysBetween(birthIso: string | null, refIso: string | null): number | null {
  if (birthIso === null || refIso === null) return null;
  const b = Date.parse(birthIso);
  const r = Date.parse(refIso);
  if (Number.isNaN(b) || Number.isNaN(r) || r < b) return null;
  return Math.floor((r - b) / 86_400_000);
}

// ---------- concept-code wrappers ------------------------------------------

function paramConcept(
  paramCode: string,
  paramDesc: string | null,
  systemId: string,
  conceptClass: string,
): V2ConceptCode {
  return {
    system_id: systemId,
    concept_code: paramCode,
    display_name: paramDesc,
    concept_class: conceptClass,
    datatype: "coded",
  };
}

/** Pick the v2 system_id for a lab_results observation by classifying its
 *  param: organism (DEFAULT_ORG) > antibiotic (DEFAULT_ABX) > result
 *  (DEFAULT_RESULT). Lets the same row carry the right mapping table. */
function observationSystemId(paramCode: string, codebook: Codebook, site: SiteConfig): string {
  if (codebook.isPathogenIdParam(paramCode)) return site.organism_system_id;
  if (codebook.isAntibiotic(paramCode)) return site.antibiotic_system_id;
  return site.observation_system_id;
}

// ---------- facility concept blocks ----------------------------------------

/** Pull whatever address/region fields the LOCNDIC4-resolved Facility object
 *  carries into a properties block; drop empty values. Returns undefined when
 *  there's nothing to attach so the JSON omits the key entirely. */
function facilityProperties(f: Facility): Record<string, unknown> | undefined {
  const props: Record<string, unknown> = {};
  const region = nz(f.Region);
  if (region !== null) props.region = region;
  const district = nz(f.District);
  if (district !== null) props.district = district;
  const postal = nz(f.PostalAddress);
  if (postal !== null) props.postal_address = postal;
  const street = nz(f.Street);
  if (street !== null) props.street = street;
  return Object.keys(props).length > 0 ? props : undefined;
}

/** Build the `facility_code` / `testing_facility_code` block from the
 *  SpecimenRecpt.Facility (LOCNDIC4-resolved). Returns null when DISA didn't
 *  carry a facility code at all.
 *
 *  When LOCNDIC4 has no row for the facility code, SpecimenRecpt.Fetch
 *  constructs a Facility with the code only and empty strings for every
 *  other field. v2's storage validator rejects payloads where
 *  facility_code.display_name is null AND there's no properties block —
 *  fall back to the code itself as display_name so the validator passes.
 *  The originating lab uses the code as a human handle anyway; this also
 *  surfaces the unresolved code clearly so it's easy to spot in v2 for
 *  LOCNDIC4 backfill. */
export function buildFacilityConcept(facility: Facility | null, site: SiteConfig): V2ConceptCode | null {
  if (facility === null) return null;
  const code = nz(facility.Code);
  if (code === null) return null;
  const concept: V2ConceptCode = {
    system_id: site.facility_system_id,
    concept_code: code,
    display_name: nz(facility.FacilityName) ?? code,
    concept_class: "facility",
    datatype: "coded",
  };
  const props = facilityProperties(facility);
  if (props !== undefined) concept.properties = props;
  return concept;
}

// ---------- patient ---------------------------------------------------------

export function buildPatient(s: SpecimenRecpt, refIso: string | null, requestId: string): V2Patient {
  const dob = dobToIso(s.DobAge);
  return {
    // DISA has no native patient GUID — use the request_id so the value is
    // always non-null (storage layer requires it as VARCHAR(255) NOT NULL).
    // This means no cross-visit dedup downstream; that's accepted.
    patient_guid: requestId,
    firstname: nz(s.FirstName),
    middlename: nz(s.MiddleName),
    surname: nz(s.LastName),
    sex: nz(s.Sex),
    folder_no: nz(s.FolderNo),
    date_of_birth: dob,
    phone: nz(s.Phone) ?? nz(s.Mobile),
    email: nz(s.Email),
    national_id: nz(s.NID),
    patient_data: {
      ...(dob === null && nz(s.DobAge) !== null ? { dob_or_age_raw: nz(s.DobAge) } : {}),
      ...(nz(s.Work) !== null ? { work_phone: nz(s.Work) } : {}),
      ...(nz(s.Address) !== null ? { address: nz(s.Address) } : {}),
      ...(refIso !== null && dob !== null ? { age_years_at_received: ageYearsBetween(dob, refIso) } : {}),
    },
  };
}

// ---------- panel selection ------------------------------------------------
//
// ⛔ REMOVED: PanelGroup / groupByPanel / isInfoOnlyPanel / selectPrimaryPanel.
//
// They existed to pick ONE "primary" panel per lab, because a lab could only
// carry one panel_code. That is precisely the defect this slice fixes: a lab
// now emits one lab_request PER ORDERED PANEL (obr-sets.ts), each naming its
// own panel, so there is no primary to select and nothing to deprioritise.
//
// `isInfoOnlyPanel` deprioritised questionnaire panels (e.g. VLID accompanying
// HIVVL) when choosing that single winner. v1 gives VLID its OWN OBR row
// (measured: TDS0073356 -> OBR 1 HIVVL, OBR 2 VLID), so ranking panels against
// each other was always an artifact of the one-panel limit, never a rule about
// the data. Documentation OBSERVATIONS are still excluded via opts.excludeObs
// (the forms feed) — that is a separate, still-correct mechanism.

// ---------- lab_request ----------------------------------------------------

function buildLabRequest(
  s: SpecimenRecpt,
  obr: ObrSet,
  prefix: string,
  site: SiteConfig,
  codebook: Codebook,
  rejection: DisaRejection,
  specimenAnomalous: boolean,
  reviewStatus: ObrStatus | null,
): V2LabRequest {
  const requestId = prefix + s.LabNumber.trim();
  const facility = s.Facility ?? null;
  const facilityCode = nz(facility?.Code);
  // WARDDICT-resolved description (set by WardDictResolver upstream in
  // export* / compare* commands). undefined when the lookup missed or
  // wasn't run — source_payload.ward is then omitted entirely.
  const wardDescription = s.WardClinicResolved ?? null;

  // Each OBR names its own panel: it IS an ordered panel (obr-sets.ts). This
  // dissolves the old `orderedFallback`, which only fired when
  // `primary === null && rejection.rejected` and took just TestOrders[0] — so a
  // rejected multi-panel lab lost every panel but the first, and an
  // observation-less NON-rejected lab lost its panel_code entirely and would
  // fail to migrate (v2 rejects a request with null panel_code AND no results).
  const panelSourceCode: string | null = obr.panelCode.length > 0 ? obr.panelCode : null;
  const panel = panelSourceCode === null ? undefined : codebook.panelEntry(panelSourceCode);
  const panelCode: V2ConceptCode | null = panelSourceCode === null
    ? null
    : {
        system_id: site.panel_system_id,
        concept_code: panelSourceCode,
        display_name: panel?.description ?? null,
        concept_class: "panel",
        datatype: "coded",
      };

  const specimenTrimmed = nz(s.Specimen);
  const specimenCode: V2ConceptCode | null = specimenTrimmed === null
    ? null
    : {
        // When the audit corroborated a panel/specimen mismatch (a DISA
        // single-specimen-per-request collision), tag the provenance namespace
        // so the recorded-but-incomplete specimen is queryable in v2. The
        // concept_code and display_name stay exactly as recorded — we never
        // invent a specimen we don't have.
        system_id: specimenAnomalous ? site.specimen_anomaly_system_id : site.specimen_system_id,
        concept_code: specimenTrimmed,
        display_name: codebook.specimenEntry(specimenTrimmed)?.description ?? null,
        concept_class: "specimen",
        datatype: "coded",
      };

  const facilityConcept = buildFacilityConcept(facility, site);
  // ⛔ KNOWN DEFECT — the comment that used to sit here was FALSE, and it is what
  // made this look intentional. It claimed: "DISA doesn't carry a separate
  // requesting-facility code distinct from the testing lab ... Emit the same
  // concept for both; v2 consumers can infer requesting == testing from the
  // equality." The relationship is BACKWARDS.
  //
  // DISA's Facility IS the REQUESTING clinic. The TESTING lab is the DISA
  // *deployment* itself — one instance is one lab — which is why nothing on
  // SpecimenRecpt carries it and SiteConfig has no slot for it.
  //
  // v1 proves both exist and are distinct (measured 2026-07-17, TDS):
  //   TestingFacilityCode 'TDS' on 172,092 rows (98.8%) — ONE constant, the lab
  //   distinct requesting facilities (LIMSFacilityCode): 3,349
  // i.e. ONE lab serving 3,349 clinics. Emitting facilityConcept for BOTH puts
  // one of those 3,349 clinics in the testing_facility_code slot. The V2<->v1
  // gate reports it 195/195 mismatch (docs .../2026-07-17-mapping-gate-findings.md §3.3).
  //
  // NOT FIXED HERE: that slice adds `testing_facility_code` to SiteConfig, since
  // the lab is a property of the deployment, not of a record.
  // ⚠ Do NOT derive it from LabNumber.slice(0,3) — 'TDS' being the LabNo prefix
  // is an undocumented coincidence of this site's numbering, and CDR must also
  // run in Zambia and Mozambique.
  //
  // (The `~`-splitting history in the old comment is real and still worth
  // heeding: deriving a facility by splitting WardClinic produced ward codes
  // mislabelled as facilities — Moz "SAAJS". That is why requesting stays
  // sourced from Facility.Code.)
  const requestingFacilityConcept = facilityConcept;

  const sectionCode = panel?.section ?? null;

  return {
    request_id: requestId,
    obr_set_id: obr.obr_set_id,
    facility_code: facilityConcept,
    panel_code: panelCode,
    specimen_code: specimenCode,
    taken_datetime: disaToIso(s.TakenDateTime),
    collected_datetime: disaToIso(s.CollectedDateTime),
    received_at: disaToIso(s.ReceivedInLabDateTime) ?? disaToIso(s.RegisteredDateTime),
    registered_at: disaToIso(s.RegisteredDateTime),
    analysis_at: null,   // disalab doesn't expose analysis_at on SpecimenRecpt
    authorised_at: reviewStatus?.authorisedAt ? dateToLocalIso(reviewStatus.authorisedAt) : null,
    clinical_info: nz(s.ClinicalDiagnosisText) ?? nz(s.ClinicalDiagnosis),
    icd10_codes: nz(s.ICD10),
    therapy: nz(s.TherapyText) ?? nz(s.Therapy),
    priority: nz(s.Priority),
    age_years: null, // populated below if we can compute
    age_days: null,
    sex: nz(s.Sex),
    patient_class: null, // not surfaced on SpecimenRecpt
    section_code: sectionCode,
    // Per-OBR result status decoded from the TESTDATA_STATUS header, with the
    // existing rejection signal taking precedence. See export/review-status.ts
    // and docs/superpowers/specs/2026-08-02-disa-result-status-blob-decode-design.md.
    // `A` is NOT derivable (624 rows in 3.4M) and is an accepted gap.
    result_status: reviewStatus?.status ?? (rejection.rejected ? "X" : null),
    // requesting_facility_code mirrors testing_facility_code — see the
    // comment where facilityConcept is reused for requestingFacilityConcept
    // above. DISA's data model doesn't distinguish them.
    requesting_facility_code: requestingFacilityConcept,
    testing_facility_code: facilityConcept,
    requesting_doctor: nz(s.Doctor) ?? nz(s.DoctorCode),
    tested_by: nz(s.ReceivedInLabBy) ?? nz(s.TakenBy) ?? nz(s.CollectedBy),
    authorised_by: null,
    source_payload: {
      // Raw DISA ward code, preserved even when we have a resolved name —
      // downstream consumers may want to round-trip the original key.
      ward_clinic_raw: nz(s.WardClinic),
      // Resolved human description from WARDDICT when available; absent
      // when the (LOCATION, WARD) pair wasn't in the dictionary.
      ...(wardDescription !== null ? { ward: wardDescription } : {}),
      test_orders: s.TestOrders.map((t) => String(t).trim()).filter((t) => t.length > 0),
    },
  };
}

// ---------- lab_results ----------------------------------------------------

/** S/I/R sentinel — DISA stores the raw single-char in OrderItem.RawValue,
 *  while OrderItem.Value carries the COMMDICT-decoded long form
 *  ("Susceptible" / "Resistant" / "Intermediate" / sometimes "Invalid").
 *  Match against the raw code so deployments that decode differently still
 *  classify correctly. */
function susceptibilitySIR(o: DisaObs): "S" | "I" | "R" | null {
  const code = o.rawValue.trim().toUpperCase();
  if (code === "S" || code === "I" || code === "R") return code;
  return null;
}

/** Find the isolate produced from THIS specific ORGS observation. Isolates
 *  are 1:1 with growth-positive ORGS rows, indexed in (panelIndex, orderIndex)
 *  order — so an exact match on those two coordinates resolves it. */
function findIsolateForOrgs(o: DisaObs, isolates: V2Isolate[]): number | null {
  for (const iso of isolates) {
    const raw = iso.raw_result as { panel_index?: number; order_index?: number };
    if (raw.panel_index === o.panelIndex && raw.order_index === o.orderIndex) {
      return iso.isolate_index;
    }
  }
  return null;
}

/** Pick the growth-positive isolate whose panelIndex is closest to this AST
 *  row (PRD §5.4 nearest-OBR heuristic). Returns null when there are no
 *  growth-positive isolates in the request. */
function nearestGrowthPositiveIsolate(panelIndex: number, isolates: V2Isolate[]): number | null {
  const candidates = isolates.filter((iso) => iso.organism_type !== "none");
  if (candidates.length === 0) return null;
  let best = candidates[0]!;
  let bestDelta = Math.abs((best.raw_result as { panel_index: number }).panel_index - panelIndex);
  for (const iso of candidates) {
    const pi = (iso.raw_result as { panel_index: number }).panel_index;
    const delta = Math.abs(pi - panelIndex);
    if (delta < bestDelta || (delta === bestDelta && pi < (best.raw_result as { panel_index: number }).panel_index)) {
      best = iso;
      bestDelta = delta;
    }
  }
  return best.isolate_index;
}

function buildLabResults(
  obs: DisaObs[],
  codebook: Codebook,
  site: SiteConfig,
  isolates: V2Isolate[],
  obrOf: (panelCode: string, panelIndex: number) => number | null,
): V2LabResult[] {
  // flattenDisa returns rows in source iteration order. Sort defensively so
  // obx_set_id increments deterministically: by (panelIndex, panelCode,
  // orderIndex). Same panel + same panelIndex stays grouped → counter resets
  // when that pair changes.
  const sorted = [...obs].sort((a, b) => {
    if (a.panelIndex !== b.panelIndex) return a.panelIndex - b.panelIndex;
    if (a.panelCode !== b.panelCode) return a.panelCode.localeCompare(b.panelCode);
    return a.orderIndex - b.orderIndex;
  });

  const out: V2LabResult[] = [];
  let prevPanelKey = "";
  let obxSetId = 0;
  for (const o of sorted) {
    // An observation whose panel was never ordered has no OBR to hang from.
    // v1 has no row for it either (v1-transform.ts:366 skips the same case).
    // Dropping is correct; defaulting to 1 would file it under an unrelated
    // panel and arrive as a successful ingest.
    const obrSetId = obrOf(o.panelCode, o.panelIndex);
    if (obrSetId === null) continue;

    const panelKey = `${o.panelCode}#${o.panelIndex}`;
    if (panelKey !== prevPanelKey) {
      obxSetId = 0;
      prevPanelKey = panelKey;
    }
    obxSetId += 1;
    // No filtering — lab_results is the universal observation stream. ORGS
    // and S/I/R rows ALSO appear in isolates / susceptibility_tests as
    // richer AMR-specific views, with isolate_index here tying them back.

    const isNumeric = isNumericTypeChar(o.type);
    const isCoded = isCodedTypeChar(o.type);
    const isText = isTextTypeChar(o.type);

    let numericValue: number | null = null;
    if (isNumeric) {
      numericValue = typeof o.value === "number" ? o.value : parseNumber(o.value);
    } else if (typeof o.value === "string") {
      numericValue = parseNumber(o.value);
    }

    let codedValue: string | null = null;
    if (isCoded) {
      codedValue = nz(o.rawValue) ?? (typeof o.value === "string" ? nz(o.value) : null);
    }

    let textValue: string | null = null;
    if (isText) {
      textValue = typeof o.value === "string" ? nz(o.value) : null;
    }

    // isolate_index linkage:
    //  - ORGS rows: 1:1 with the isolate produced by this exact observation
    //  - AST rows (antibiotic + S/I/R): nearest growth-positive isolate
    //  - everything else: null
    let isolateIndex: number | null = null;
    if (o.paramCode === "ORGS") {
      isolateIndex = findIsolateForOrgs(o, isolates);
    } else if (codebook.isAntibiotic(o.paramCode) && susceptibilitySIR(o) !== null) {
      isolateIndex = nearestGrowthPositiveIsolate(o.panelIndex, isolates);
    }

    const parm = codebook.paramEntry(o.paramCode);
    out.push({
      source_test_code: o.panelCode,
      obr_set_id: obrSetId,
      obx_set_id: obxSetId,
      obx_sub_id: 0,
      observation_code: paramConcept(
        o.paramCode,
        o.paramDesc ?? parm?.description ?? null,
        observationSystemId(o.paramCode, codebook, site),
        "test",
      ),
      result_value: nz(o.valueStr),
      result_type: v2ResultTypeFromDisaType(o.type),
      numeric_value: numericValue,
      coded_value: codedValue,
      text_value: textValue,
      numeric_units: nz(parm?.units ?? null),
      abnormal_flag: null,
      rpt_units: nz(parm?.units ?? null),
      rpt_flag: null,
      rpt_range: nz(parm?.reference ?? null),
      result_timestamp: null,
      isolate_index: isolateIndex,
      is_resulted: true,
      raw_result: {
        disa_type_code: o.type.length > 0 ? o.type.charCodeAt(0) : null,
        ...(o.rawValue.length > 0 && o.rawValue !== o.valueStr ? { raw_value: o.rawValue } : {}),
      },
    });
  }
  return out;
}

// ---------- isolates -------------------------------------------------------

function buildIsolates(
  obs: DisaObs[],
  codebook: Codebook,
  site: SiteConfig,
  request: V2LabRequest,
  birthIso: string | null,
  obrOf: (panelCode: string, panelIndex: number) => number | null,
): V2Isolate[] {
  // An isolate whose panel was never ordered has no OBR to hang from — the same
  // case buildLabResults drops. Filter BEFORE assigning isolate_index so the
  // index stays dense and the AST join key (isolate_index) cannot skew.
  // ⚠ Never default it to OBR 1: that files the isolate under an unrelated
  // panel, and its own lab_results were dropped anyway.
  const orgs = obs.filter(
    (o) => o.paramCode === "ORGS" && o.valueStr.length > 0 && obrOf(o.panelCode, o.panelIndex) !== null,
  );
  // Order isolates by (panelIndex, orderIndex) so isolate_index is stable.
  orgs.sort((a, b) => (a.panelIndex - b.panelIndex) || (a.orderIndex - b.orderIndex));

  const ageDays = ageDaysBetween(birthIso, request.received_at ?? request.collected_datetime ?? request.taken_datetime);
  const wardRaw = (request.source_payload as { ward?: string | null }).ward ?? null;

  return orgs.map((o, i) => {
    const code = nz(o.rawValue) ?? o.valueStr;
    const display = typeof o.value === "string" ? nz(o.value) : null;
    const commEntry = codebook.organismEntry(code);
    return {
      isolate_index: i + 1,
      // Non-null by construction: `orgs` is pre-filtered to linkable rows
      // above, so the index assignment stays dense and the AST join key holds.
      obr_set_id: obrOf(o.panelCode, o.panelIndex)!,
      source_test_code: o.panelCode,
      organism_code: {
        system_id: site.organism_system_id,
        concept_code: code,
        display_name: display ?? commEntry?.description ?? null,
        concept_class: "organism",
        datatype: "coded",
      },
      organism_type: codebook.organismCategory(code),
      isolate_number: String(i + 1),
      serotype: null,
      patient_age_days: ageDays,
      patient_sex: request.sex,
      ward: wardRaw,
      ward_type: null,
      origin: null,
      beta_lactamase: null,
      esbl: null,
      carbapenemase: null,
      mrsa_screen: null,
      inducible_clinda: null,
      custom_fields: null,
      raw_result: {
        panel_index: o.panelIndex,
        order_index: o.orderIndex,
      },
    };
  });
}

// ---------- susceptibility_tests -------------------------------------------

function inferTestMethod(units: string): "DISK" | "MIC" | null {
  const u = units.toLowerCase();
  if (u.length === 0) return "DISK"; // PRD §5.4: most common in DISA
  if (u.includes("mm")) return "DISK";
  if (u.includes("mg") || u.includes("ug") || u.includes("µg")) return "MIC";
  return "DISK";
}

function buildSusceptibilityTests(
  obs: DisaObs[],
  codebook: Codebook,
  site: SiteConfig,
  isolates: V2Isolate[],
  defaultGuideline: string,
  obrOf: (panelCode: string, panelIndex: number) => number | null,
): V2SusceptibilityTest[] {
  // Same rule as isolates: an AST under a never-ordered panel has no OBR.
  const ast = obs.filter(
    (o) =>
      codebook.isAntibiotic(o.paramCode) &&
      susceptibilitySIR(o) !== null &&
      obrOf(o.panelCode, o.panelIndex) !== null,
  );

  return ast.map((o) => {
    const parm = codebook.paramEntry(o.paramCode);
    const units = parm?.units ?? "";
    const testMethod = inferTestMethod(units);
    const numeric = typeof o.value === "number" ? o.value : parseNumber(o.value);
    const sir = susceptibilitySIR(o)!; // ast filter guarantees non-null
    return {
      isolate_index: nearestGrowthPositiveIsolate(o.panelIndex, isolates),
      // Non-null by construction — `ast` is pre-filtered to linkable rows above.
      obr_set_id: obrOf(o.panelCode, o.panelIndex)!,
      source_test_code: o.panelCode,
      antibiotic_code: {
        system_id: site.antibiotic_system_id,
        concept_code: o.paramCode,
        display_name: parm?.description ?? null,
        concept_class: "antibiotic",
        datatype: "coded",
      },
      test_method: testMethod,
      disk_potency: null,
      result_raw: o.valueStr,
      result_numeric: numeric,
      susceptibility_value: sir,
      quantitative_value: numeric === null ? null : String(numeric),
      guideline: defaultGuideline,
      guideline_version: null,
      raw_result: {
        units,
        panel_index: o.panelIndex,
        decoded_value: o.valueStr,
      },
    };
  });
}

// ---------- top-level ------------------------------------------------------

export interface ToV2Opts {
  prefix: string;
  site: SiteConfig;
  codebook: Codebook;
  /** Optional audit report from the audit subsystem. When present and
   *  non-empty, an annotated `data_quality` block is added to the payload.
   *  Pass `null` (or omit) to suppress the annotation entirely. */
  auditReport?: AuditReport | null;
  /** When set, observations matching this predicate are dropped before
   *  building lab_results / isolates / panel selection — used to route
   *  documentation observations to the forms feed instead. */
  excludeObs?: (o: DisaObs) => boolean;
  /** Measured per-deployment TESTDATA_STATUS blob offsets, loaded ONCE at
   *  startup via loadBlobOffsets(country) — never call that inside toV2,
   *  which runs per specimen and would do file I/O in a hot loop. */
  blobOffsets: BlobOffsets;
}

function buildDataQualityBlock(report: AuditReport): V2DataQuality | null {
  if (report.anomalies.length === 0 || report.max_severity === null) return null;
  return {
    max_severity: report.max_severity,
    audited_at: new Date().toISOString(),
    anomalies: report.anomalies.map((a) => ({
      class: a.class,
      severity: a.severity,
      message: a.message,
      ...(a.panel_code !== undefined ? { panel_code: a.panel_code } : {}),
      ...(a.panel_index !== undefined ? { panel_index: a.panel_index } : {}),
      ...(a.observation_code !== undefined ? { observation_code: a.observation_code } : {}),
      details: a.details,
    })),
  };
}

/** True when the audit raised a corroborated (warn-level)
 *  `panel_specimen_mismatch` — the migrating case where the recorded specimen
 *  is kept but known not to apply to every ordered panel. Drives the
 *  specimen-anomaly provenance namespace. Error-level (uncorroborated)
 *  mismatches quarantine and never reach the emit path, so they're excluded. */
function hasCorroboratedSpecimenMismatch(report?: AuditReport | null): boolean {
  if (!report) return false;
  return report.anomalies.some(
    (a) => a.class === "panel_specimen_mismatch" && a.severity === "warn",
  );
}

export function toV2(specimen: SpecimenRecpt, opts: ToV2Opts): V2Payload {
  // DISA's preliminary panel runs (lower TESTINDEX) are superseded by later
  // reruns of the same panel — v1 dropped them, so v2 mirrors that to keep
  // a single canonical observation per (panelCode, paramCode). The audit
  // surfaces the dropped iterations via `panel_iterations_superseded`.
  const keptAll = supersedePanelIterations(flattenDisa(specimen)).kept;
  const obs = opts.excludeObs ? keptAll.filter((o) => !opts.excludeObs!(o)) : keptAll;
  const rejection = detectDisaRejection(specimen);
  const specimenAnomalous = hasCorroboratedSpecimenMismatch(opts.auditReport);

  // ⛔ The OBR grain comes from TestOrders POSITION, not TESTINDEX (obr-sets.ts;
  // 99.95% vs v1 at n=3,874 against TESTINDEX's 93.6%). Ordered-but-unresulted
  // panels are included: they have zero TestResults and still get a v1 row.
  const obrSets = deriveObrSets(specimen.TestOrders);
  // ⛔ The linker MUST see EVERY panel iteration, not the surviving observations.
  // Rule P ranks the i-th distinct base(TESTINDEX) of a code onto its i-th
  // order, so the rank is only correct against the COMPLETE iteration set.
  // Two filters run before this point and both shift the rank:
  //   - supersedePanelIterations drops MRCSW#1,#2 in favour of #3, so MRCSW's
  //     surviving base is {3} and rank 1 would map it to OBR 1 instead of 3;
  //   - flattenDisa drops RJREA/RJREM padding, so a rejection-only iteration
  //     yields ZERO observations and disappears from the rank entirely.
  // TestResults is the iteration list itself, so it is immune to both.
  const iterations = specimen.TestResults.map((t) => ({
    panelCode: String(t.TESTCODE ?? "").trim(),
    panelIndex: Number(t.TESTINDEX ?? 0),
  }));
  const obrOf = linkObsToObr(obrSets, iterations);

  // Observation count per OBR drives the `I` (interim) branch: an ordered
  // panel with zero kept observations is exactly v1's "request but no
  // results" case (compare-batch.ts:60-65).
  const obsCountByObr = new Map<number, number>();
  for (const o of obs) {
    const id = obrOf(o.panelCode, o.panelIndex);
    if (id === null) continue;
    obsCountByObr.set(id, (obsCountByObr.get(id) ?? 0) + 1);
  }
  const statusByObr = buildStatusByObr({
    iterations: specimen.TestResults.map((t) => ({
      panelCode: String(t.TESTCODE ?? "").trim(),
      panelIndex: Number(t.TESTINDEX ?? 0),
      datestamp: t.DATESTAMP instanceof Date ? t.DATESTAMP : null,
      header: t.HEADER,
    })),
    obrOf,
    obsCountByObr,
    rejected: rejection.rejected,
    offsets: opts.blobOffsets,
  });

  const labRequests = obrSets.map((obr) =>
    buildLabRequest(
      specimen, obr, opts.prefix, opts.site, opts.codebook, rejection, specimenAnomalous,
      statusByObr.get(obr.obr_set_id) ?? null,
    ),
  );

  // Every OBR carries the same specimen-level timings (they are read off the
  // SpecimenRecpt, not the panel), so any request serves as the patient's
  // reference date. A lab with no ordered panels has no request at all — fall
  // back to the specimen so the patient is still emitted.
  // ⚠ Measured: labs with EMPTY TestOrders are 0 of 3,874. If one ever appears
  // it emits no requests, and the gate will show it as unpaired rather than
  // silently green.
  const refRequest = labRequests[0] ?? null;
  const patientRef =
    refRequest?.received_at ??
    refRequest?.collected_datetime ??
    refRequest?.taken_datetime ??
    disaToIso(specimen.ReceivedInLabDateTime) ??
    disaToIso(specimen.RegisteredDateTime);
  const patient = buildPatient(specimen, patientRef, opts.prefix + specimen.LabNumber.trim());
  // Order matters: isolates first so lab_results can attach isolate_index
  // and AST tests can resolve the nearest-isolate linkage.
  // buildIsolates reads only specimen-level fields off the request (timings,
  // ward, sex), which are identical across OBRs — so the first one serves.
  const isolates =
    refRequest === null
      ? []
      : buildIsolates(obs, opts.codebook, opts.site, refRequest, patient.date_of_birth, obrOf);
  const labResults = buildLabResults(obs, opts.codebook, opts.site, isolates, obrOf);
  const susceptibilityTests = buildSusceptibilityTests(obs, opts.codebook, opts.site, isolates, opts.site.default_guideline, obrOf);

  if (patient.date_of_birth !== null) {
    for (const r of labRequests) {
      if (r.received_at === null) continue;
      r.age_years = ageYearsBetween(patient.date_of_birth, r.received_at);
      r.age_days = ageDaysBetween(patient.date_of_birth, r.received_at);
    }
  }

  const dataQuality = opts.auditReport ? buildDataQualityBlock(opts.auditReport) : null;

  return {
    patient,
    lab_requests: labRequests,
    lab_results: labResults,
    isolates,
    susceptibility_tests: susceptibilityTests,
    ...(dataQuality !== null ? { data_quality: dataQuality } : {}),
  };
}

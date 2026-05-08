import type { Facility, SpecimenRecpt } from "disalab";
import { flattenDisa, parseNumber, type DisaObs } from "../compare/result-mapping.js";
import { splitPointOfCare } from "../openldr.js";
import type { AuditReport } from "../audit/types.js";
import type { Codebook } from "./codebook.js";
import type { SiteConfig } from "./site-config.js";
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

/** True if the OrderItem.Type byte indicates a numeric slot (1=Real, 2=Int). */
function isNumericTypeChar(typeChar: string): boolean {
  if (typeChar.length === 0) return false;
  const c = typeChar.charCodeAt(0);
  return c === 1 || c === 2;
}

/** True if the OrderItem.Type byte indicates a coded slot (0/3/4/11/12). */
function isCodedTypeChar(typeChar: string): boolean {
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
 *  carry a facility code at all. */
function buildFacilityConcept(facility: Facility | null, site: SiteConfig): V2ConceptCode | null {
  if (facility === null) return null;
  const code = nz(facility.Code);
  if (code === null) return null;
  const concept: V2ConceptCode = {
    system_id: site.facility_system_id,
    concept_code: code,
    display_name: nz(facility.FacilityName),
    concept_class: "facility",
    datatype: "coded",
  };
  const props = facilityProperties(facility);
  if (props !== undefined) concept.properties = props;
  return concept;
}

/** Build `requesting_facility_code` from the parsed WardClinic facility
 *  segment. DISA doesn't carry a separate code for the requesting facility
 *  in most deployments — only a name — so concept_code mirrors display_name.
 *  Returns null when DISA has no requesting-facility info. */
function buildRequestingFacilityConcept(
  facilityName: string | null,
  site: SiteConfig,
): V2ConceptCode | null {
  if (facilityName === null) return null;
  return {
    system_id: site.facility_system_id,
    concept_code: facilityName,
    display_name: facilityName,
    concept_class: "facility",
    datatype: "coded",
  };
}

// ---------- patient ---------------------------------------------------------

function buildPatient(s: SpecimenRecpt, refIso: string | null, requestId: string): V2Patient {
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

interface PanelGroup {
  panelCode: string;
  panelIndex: number;
  observations: DisaObs[];
}

function groupByPanel(obs: DisaObs[]): PanelGroup[] {
  const map = new Map<string, PanelGroup>();
  for (const o of obs) {
    const key = `${o.panelCode}#${o.panelIndex}`;
    let g = map.get(key);
    if (g === undefined) {
      g = { panelCode: o.panelCode, panelIndex: o.panelIndex, observations: [] };
      map.set(key, g);
    }
    g.observations.push(o);
  }
  return [...map.values()].sort((a, b) => a.panelIndex - b.panelIndex);
}

/**
 * A panel is "info-only" when EVERY observation under it resolves to a
 * questionnaire / metadata PARMDICT context. PRD §5.1 wants these
 * deprioritised (e.g. VLID accompanying HIVVL) when picking the primary
 * lab_request.panel_code.
 */
function isInfoOnlyPanel(group: PanelGroup, codebook: Codebook): boolean {
  if (group.observations.length === 0) return false;
  for (const obs of group.observations) {
    if (!codebook.isQuestionnaireParam(obs.paramCode)) return false;
  }
  return true;
}

function selectPrimaryPanel(groups: PanelGroup[], codebook: Codebook): PanelGroup | null {
  if (groups.length === 0) return null;
  const real = groups.filter((g) => !isInfoOnlyPanel(g, codebook));
  const pool = real.length > 0 ? real : groups;
  return pool.reduce((best, cur) => (cur.panelIndex < best.panelIndex ? cur : best));
}

// ---------- lab_request ----------------------------------------------------

function buildLabRequest(
  s: SpecimenRecpt,
  primary: PanelGroup | null,
  prefix: string,
  site: SiteConfig,
  codebook: Codebook,
): V2LabRequest {
  const requestId = prefix + s.LabNumber.trim();
  const facility = s.Facility ?? null;
  const facilityCode = nz(facility?.Code);
  const wardClinicSplit = splitPointOfCare(s.WardClinic);

  const panel = primary === null ? undefined : codebook.panelEntry(primary.panelCode);
  const panelCode: V2ConceptCode | null = primary === null
    ? null
    : {
        system_id: site.panel_system_id,
        concept_code: primary.panelCode,
        display_name: panel?.description ?? null,
        concept_class: "panel",
        datatype: "coded",
      };

  const specimenTrimmed = nz(s.Specimen);
  const specimenCode: V2ConceptCode | null = specimenTrimmed === null
    ? null
    : {
        system_id: site.specimen_system_id,
        concept_code: specimenTrimmed,
        display_name: codebook.specimenEntry(specimenTrimmed)?.description ?? null,
        concept_class: "specimen",
        datatype: "coded",
      };

  const facilityConcept = buildFacilityConcept(facility, site);
  const requestingFacilityConcept = buildRequestingFacilityConcept(wardClinicSplit.facilityName, site);

  const sectionCode = panel?.section ?? null;

  return {
    request_id: requestId,
    facility_code: facilityConcept,
    panel_code: panelCode,
    specimen_code: specimenCode,
    taken_datetime: disaToIso(s.TakenDateTime),
    collected_datetime: disaToIso(s.CollectedDateTime),
    received_at: disaToIso(s.ReceivedInLabDateTime),
    registered_at: null, // disalab doesn't surface a registered_at distinct from received
    analysis_at: null,   // disalab doesn't expose analysis_at on SpecimenRecpt
    authorised_at: null, // ditto authorised_at
    clinical_info: nz(s.ClinicalDiagnosisText) ?? nz(s.ClinicalDiagnosis),
    icd10_codes: nz(s.ICD10),
    therapy: nz(s.TherapyText) ?? nz(s.Therapy),
    priority: nz(s.Priority),
    age_years: null, // populated below if we can compute
    age_days: null,
    sex: nz(s.Sex),
    patient_class: null, // not surfaced on SpecimenRecpt
    section_code: sectionCode,
    result_status: null, // not surfaced on SpecimenRecpt; v1 carries via HL7ResultStatusCode
    // requesting_facility_code = the parsed WardClinic facility segment, or
    // null when DISA didn't capture one (don't synthesise from the lab — v2
    // would lose the signal that requesting/testing were actually the same).
    requesting_facility_code: requestingFacilityConcept,
    testing_facility_code: facilityConcept,
    requesting_doctor: nz(s.Doctor) ?? nz(s.DoctorCode),
    tested_by: nz(s.ReceivedInLabBy) ?? nz(s.TakenBy) ?? nz(s.CollectedBy),
    authorised_by: null,
    source_payload: {
      ward_clinic_raw: nz(s.WardClinic),
      ...(wardClinicSplit.ward !== null ? { ward: wardClinicSplit.ward } : {}),
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
): V2Isolate[] {
  const orgs = obs.filter((o) => o.paramCode === "ORGS" && o.valueStr.length > 0);
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
): V2SusceptibilityTest[] {
  const ast = obs.filter((o) => codebook.isAntibiotic(o.paramCode) && susceptibilitySIR(o) !== null);

  return ast.map((o) => {
    const parm = codebook.paramEntry(o.paramCode);
    const units = parm?.units ?? "";
    const testMethod = inferTestMethod(units);
    const numeric = typeof o.value === "number" ? o.value : parseNumber(o.value);
    const sir = susceptibilitySIR(o)!; // ast filter guarantees non-null
    return {
      isolate_index: nearestGrowthPositiveIsolate(o.panelIndex, isolates),
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

export function toV2(specimen: SpecimenRecpt, opts: ToV2Opts): V2Payload {
  const obs = flattenDisa(specimen);
  const groups = groupByPanel(obs);
  const primary = selectPrimaryPanel(groups, opts.codebook);
  const labRequest = buildLabRequest(specimen, primary, opts.prefix, opts.site, opts.codebook);
  const patient = buildPatient(specimen, labRequest.received_at ?? labRequest.collected_datetime ?? labRequest.taken_datetime, labRequest.request_id);
  // Order matters: isolates first so lab_results can attach isolate_index
  // and AST tests can resolve the nearest-isolate linkage.
  const isolates = buildIsolates(obs, opts.codebook, opts.site, labRequest, patient.date_of_birth);
  const labResults = buildLabResults(obs, opts.codebook, opts.site, isolates);
  const susceptibilityTests = buildSusceptibilityTests(obs, opts.codebook, opts.site, isolates, opts.site.default_guideline);

  if (patient.date_of_birth !== null && labRequest.received_at !== null) {
    labRequest.age_years = ageYearsBetween(patient.date_of_birth, labRequest.received_at);
    labRequest.age_days = ageDaysBetween(patient.date_of_birth, labRequest.received_at);
  }

  const dataQuality = opts.auditReport ? buildDataQualityBlock(opts.auditReport) : null;

  return {
    patient,
    lab_request: labRequest,
    lab_results: labResults,
    isolates,
    susceptibility_tests: susceptibilityTests,
    ...(dataQuality !== null ? { data_quality: dataQuality } : {}),
  };
}

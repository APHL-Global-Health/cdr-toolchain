import type { AUDTDATA, SpecimenRecpt } from "disalab";
import { flattenDisa, supersedePanelIterations } from "../compare/result-mapping.js";
import type { Codebook } from "./codebook.js";
import { collectOrderedPanels } from "./panels.js";
import type { V1LabResult, V1Payload, V1Request } from "./types.js";

/** DISA datetime "MM/DD/YYYY HH:MM" → ISO-8601 with milliseconds + Z, e.g.
 *  "2018-04-14T19:00:00.000Z". This matches what real v1 produces when its
 *  SQL `datetime` columns are JSON.stringified (the Date object's default
 *  serialization). DISA stores local time without TZ; we treat the wall
 *  time as UTC to keep the output bit-for-bit comparable to v1's. */
function disaToIso(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  const trimmed = s.trim();
  if (trimmed.length === 0) return null;
  const m = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (m === null) return trimmed;
  const [, mm, dd, yyyy, hh, mi, ss] = m;
  const time = hh === undefined ? "00:00:00" : `${hh}:${mi}:${ss ?? "00"}`;
  return `${yyyy}-${mm}-${dd}T${time}.000Z`;
}

/** v1 stores trimmed strings; DISA right-pads varchars. Use "" for absence
 *  rather than null to match the SQL convention captured in the table. */
function s(value: string | null | undefined): string {
  if (value === null || value === undefined) return "";
  return value.trim();
}

/** Translate DISA's TESTDICT.SECTION (single char) to v1's HL7SectionCode
 *  (multi-char). M → MB (microbiology), V → VR (virology), blank → OTH.
 *  Other letters pass through unchanged so unfamiliar deployments still
 *  carry the signal. */
function sectionToHL7(section: string | null): string {
  if (section === null) return "OTH";
  const t = section.trim().toUpperCase();
  if (t.length === 0) return "OTH";
  if (t === "M") return "MB";
  if (t === "V") return "VR";
  if (t === "C") return "CH"; // chemistry
  if (t === "H") return "HM"; // haematology
  if (t === "S") return "SR"; // serology
  return t;
}

/** v1 `HL7ResultTypeCode` uses non-standard single/double-char codes
 *  observed in the real OpenLDRData rows for TZDISA: R = coded result,
 *  C = comment / text narrative, NM = numeric, DT = date, TM = time.
 *  v1 chose this convention for its own reasons (it's NOT HL7 v2's CE/CK/TX). */
function v1ResultTypeFromDisaType(typeChar: string): string {
  if (typeChar.length === 0) return "";
  const c = typeChar.charCodeAt(0);
  if (c === 1 || c === 2) return "NM";
  if (c === 0 || c === 3 || c === 4 || c === 11 || c === 12) return "R";
  if (c === 5 || c === 6) return "C"; // v1 stores Text/Graphic as comment-type
  if (c === 7) return "DT";
  if (c === 8) return "TM";
  return "";
}

/** v1 sets OBXSubID=1 on Text/Graphic (comment) rows but 0 elsewhere. The
 *  real v1 LabResults table uses this to distinguish first-line of multi-
 *  line text overflow; subsequent overflow lines would increment further. */
function v1ObxSubIdForType(typeChar: string): number {
  if (typeChar.length === 0) return 0;
  const c = typeChar.charCodeAt(0);
  return c === 5 || c === 6 ? 1 : 0;
}

/** Compute years between two ISO-shaped dates; returns 0 when either side
 *  is null or unparseable (matches v1 which stores 0, not NULL). */
function ageYearsBetween(birthIso: string | null, refIso: string | null): number {
  if (birthIso === null || refIso === null) return 0;
  const b = new Date(birthIso);
  const r = new Date(refIso);
  if (Number.isNaN(b.getTime()) || Number.isNaN(r.getTime())) return 0;
  let years = r.getFullYear() - b.getFullYear();
  const md = r.getMonth() - b.getMonth();
  if (md < 0 || (md === 0 && r.getDate() < b.getDate())) years -= 1;
  return years >= 0 ? years : 0;
}

function ageDaysBetween(birthIso: string | null, refIso: string | null): number {
  if (birthIso === null || refIso === null) return 0;
  const b = Date.parse(birthIso);
  const r = Date.parse(refIso);
  if (Number.isNaN(b) || Number.isNaN(r) || r < b) return 0;
  return Math.floor((r - b) / 86_400_000);
}

function dobToIso(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m === null) return null;
  return `${m[3]}-${m[1]}-${m[2]}T00:00:00.000Z`;
}

/** Lab abbreviation prefix — derive from the OpenLDR labno prefix shape.
 *  TZDISA prefix → request_id "TZDISATDS0114466" → testing_facility "TDS"
 *  is the lab abbreviation immediately following "TZDISA". This matches
 *  the convention seen in real v1 rows. Returns "" if we can't infer. */
function inferTestingFacilityCode(labNumber: string): string {
  // DISA lab numbers commonly prefix with a 3-letter lab abbreviation
  // (TDS = Tanzania DISA Service, etc.). Take the leading alpha run.
  const m = labNumber.trim().match(/^([A-Z]{2,5})/);
  return m === null ? "" : m[1]!;
}

// ---------- audit-trail extraction -----------------------------------------

/** v1 stores Registered/Tested/Authorised people + dates that DISA hides
 *  inside its audit log (AUDTDATA). The codes follow a stable convention:
 *    WS100 — registration insert    → RegisteredBy + RegisteredDateTime
 *    WL101 — results insert          → TestedBy + AnalysisDateTime
 *    WA500 — print/review            → AuthorisedBy + AuthorisedDateTime
 *  We pick the FIRST occurrence of each because v1's Requests row carries
 *  a single value per request even though the panel may be re-edited later. */
/** Per-panel slice of audit facts. WL101 ("PANEL: (idx) insert results")
 *  and WA500 ("PANEL: (idx)Prt X Rvw USR") fire per panel — when a panel
 *  has no results entered (e.g. an ordered MSENS that was never filled)
 *  no events fire and v1 leaves Analysis/Authorised null for that OBR. */
interface PanelAuditFacts {
  analysisAt: string | null;
  testedBy: string;
  authorisedAt: string | null;
  authorisedBy: string;
}

interface AuditFacts {
  /** Request-level — first WS100 wins. Same value populated on every OBR. */
  registeredAt: string | null;
  registeredBy: string;
  /** Per-panel — keyed by panel code (uppercase, trimmed). */
  perPanel: Map<string, PanelAuditFacts>;
}

/** v1 stores Analysis/Authorised dates truncated to the whole minute
 *  (seconds dropped). Match that — the AUDTDATA timestamps have ms
 *  precision but v1's downstream consumer rounds them. */
function truncateToMinute(iso: string | null): string | null {
  if (iso === null) return null;
  // "2018-04-20T11:55:37.080Z" -> "2018-04-20T11:55:00.000Z"
  return iso.replace(/T(\d{2}):(\d{2}):\d{2}(?:\.\d+)?Z$/, "T$1:$2:00.000Z");
}

/** Parse "PANEL: (idx)..." prefix from an audit `_Auditdata` line and
 *  return the panel code. Returns null when the line doesn't follow the
 *  per-panel convention (some events are request-wide). */
function panelCodeFromAuditData(data: string): string | null {
  const m = data.match(/^([A-Z][A-Z0-9]*)\s*:\s*\(/i);
  return m === null ? null : m[1]!.toUpperCase();
}

/** AUDTDATA.AUDDateTime is returned by mssql as a JS Date. Normalise it to
 *  the same ISO format the rest of the v1 export uses ("…T….000Z") so
 *  output is comparable byte-for-byte with what real v1 produces. */
function isoFromAuditDate(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString();
  }
  const parsed = new Date(String(v));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function extractAuditFacts(rows: AUDTDATA[]): AuditFacts {
  const facts: AuditFacts = {
    registeredAt: null,
    registeredBy: "",
    perPanel: new Map(),
  };
  // AUDTDATA returns events in DB order — sort by AUDDateTime ascending so
  // "first" is reliable even if the storage order shifts.
  const sorted = [...rows].sort((a, b) => {
    const ad = a.AUDDateTime instanceof Date ? a.AUDDateTime.getTime() : new Date(String(a.AUDDateTime ?? "")).getTime();
    const bd = b.AUDDateTime instanceof Date ? b.AUDDateTime.getTime() : new Date(String(b.AUDDateTime ?? "")).getTime();
    return ad - bd;
  });
  for (const r of sorted) {
    const u = r as unknown as { AUDDateTime: unknown; _AuditCode: string; _AuditUser: string; _Auditdata: string };
    const code = String(u._AuditCode ?? "").trim();
    const at = isoFromAuditDate(u.AUDDateTime);
    const user = String(u._AuditUser ?? "").trim();

    if (code === "WS100" && facts.registeredAt === null) {
      facts.registeredAt = at;
      facts.registeredBy = user;
      continue;
    }

    if (code === "WL101" || code === "WA500") {
      const panel = panelCodeFromAuditData(String(u._Auditdata ?? ""));
      if (panel === null) continue;
      const slot = facts.perPanel.get(panel) ?? { analysisAt: null, testedBy: "", authorisedAt: null, authorisedBy: "" };
      if (code === "WL101" && slot.analysisAt === null) {
        slot.analysisAt = truncateToMinute(at);
        slot.testedBy = user;
      } else if (code === "WA500" && slot.authorisedAt === null) {
        slot.authorisedAt = truncateToMinute(at);
        slot.authorisedBy = user;
      }
      facts.perPanel.set(panel, slot);
    }
  }
  return facts;
}

// ---------- top-level ------------------------------------------------------

export interface ToV1Opts {
  prefix: string;
  codebook: Codebook;
  /** AUDTDATA rows for this lab, fetched alongside the specimen. The
   *  transform extracts Registered/Analysis/Authorised dates+users from
   *  here. Pass an empty array if the audit trail is unavailable; the
   *  v1 fields will degrade to null/"" rather than failing. */
  auditRows: AUDTDATA[];
}

export function toV1(specimen: SpecimenRecpt, opts: ToV1Opts): V1Payload {
  const audit = extractAuditFacts(opts.auditRows);
  // Resolve user codes to full names via USERDIC6. RegisteredBy in real v1
  // sometimes stores raw initials (e.g. "SBS") and other times the full
  // name — we always emit the description (full name) when available since
  // it carries more signal; downstream callers can recover the code from
  // the audit trail if they need it.
  const resolveUser = (code: string): string => {
    if (code.length === 0) return "";
    return opts.codebook.userEntry(code)?.description ?? code;
  };
  const requestId = opts.prefix + specimen.LabNumber.trim();
  const facility = specimen.Facility ?? null;
  const facilityCode = s(facility?.Code);
  const facilityName = s(facility?.FacilityName);

  const taken = disaToIso(specimen.TakenDateTime);
  const collected = disaToIso(specimen.CollectedDateTime);
  const received = disaToIso(specimen.ReceivedInLabDateTime);
  const specimenDt = collected ?? taken; // v1 SpecimenDateTime collapses these

  const dobIso = dobToIso(specimen.DobAge);
  // Real v1 calculates age against the SpecimenDateTime (not the receipt
  // date), which gives a slightly smaller AgeInDays value when the specimen
  // sat in transit before reaching the lab. Match that.
  const refIso = specimenDt ?? received;
  const ageYears = ageYearsBetween(dobIso, refIso);
  const ageDays = ageDaysBetween(dobIso, refIso);

  const specimenCode = s(specimen.Specimen);
  const specimenDesc = s(opts.codebook.specimenEntry(specimenCode)?.description);

  const orderedPanels = collectOrderedPanels(specimen);
  const testingFacilityCode = inferTestingFacilityCode(specimen.LabNumber);

  const requests: V1Request[] = orderedPanels.map((panelCode, i) => {
    const panelEntry = opts.codebook.panelEntry(panelCode);
    const panelAudit = audit.perPanel.get(panelCode.toUpperCase()) ?? null;
    return {
      DateTimeStamp: null,
      Versionstamp: null,
      LIMSDateTimeStamp: null,
      LIMSVersionstamp: null,
      RequestID: requestId,
      OBRSetID: i + 1,
      LOINCPanelCode: "",
      LIMSPanelCode: panelCode,
      LIMSPanelDesc: s(panelEntry?.description),
      HL7PriorityCode: s(specimen.Priority),
      SpecimenDateTime: specimenDt,
      RegisteredDateTime: audit.registeredAt,
      ReceivedDateTime: received,
      // Per-panel audit dates: only populated when the panel actually had
      // results entered / was reviewed. Ordered-but-unfilled panels (e.g.
      // an MSENS that was never processed) get null here, matching v1.
      AnalysisDateTime: panelAudit?.analysisAt ?? null,
      AuthorisedDateTime: panelAudit?.authorisedAt ?? null,
      AdmitAttendDateTime: null,
      CollectionVolume: 0,
      RequestingFacilityCode: facilityCode.length > 0 ? `DISA${facilityCode}` : "",
      ReceivingFacilityCode: testingFacilityCode,
      LIMSPointOfCareDesc: facilityName,
      // Confirmed deployment-wide constant: 100% of the 35,126 DISA-vendor
      // rows in the OpenLDRData.Requests table have RequestTypeCode='D'
      // (Diagnostic). Hardcoded here; promote to SiteConfig if a
      // non-Tanzanian deployment ever uses something else.
      RequestTypeCode: "D",
      ICD10ClinicalInfoCodes: s(specimen.ICD10),
      // Real v1 wraps DISA's clinical-diagnosis token in [brackets] when
      // populating ClinicalInfo (e.g. "[DD]"). Preserve that convention.
      ClinicalInfo: ((): string => {
        const ci = s(specimen.ClinicalDiagnosisText) || s(specimen.ClinicalDiagnosis);
        if (ci.length === 0) return "";
        return ci.startsWith("[") ? ci : `[${ci}]`;
      })(),
      HL7SpecimenSourceCode: "",
      LIMSSpecimenSourceCode: specimenCode,
      LIMSSpecimenSourceDesc: specimenDesc,
      HL7SpecimenSiteCode: "",
      LIMSSpecimenSiteCode: "",
      LIMSSpecimenSiteDesc: "",
      WorkUnits: 0,
      CostUnits: 0,
      HL7SectionCode: sectionToHL7(panelEntry?.section ?? null),
      HL7ResultStatusCode: "F", // assume Final unless we discover otherwise
      // Audit-trail people. RegisteredBy keeps raw initials (matches what
      // real v1 has for Tanzania data: e.g. "SBS"); TestedBy / AuthorisedBy
      // resolve to USERDIC6 full names ("Neema Saul", "Salum Nyanga"),
      // pulled per panel so unfilled panels get "" rather than borrowing
      // another panel's reviewer.
      RegisteredBy: audit.registeredBy.length > 0 ? audit.registeredBy : s(specimen.ReceivedInLabBy),
      TestedBy: resolveUser(panelAudit?.testedBy ?? "") || s(specimen.TakenBy) || s(specimen.CollectedBy),
      AuthorisedBy: resolveUser(panelAudit?.authorisedBy ?? ""),
      OrderingNotes: s(specimen.FolderNo),
      EncryptedPatientID: "",
      AgeInYears: ageYears,
      AgeInDays: ageDays,
      HL7SexCode: s(specimen.Sex) || " ",
      HL7EthnicGroupCode: "",
      Deceased: false,
      Newborn: ageDays > 0 && ageDays < 28,
      HL7PatientClassCode: "",
      AttendingDoctor: s(specimen.Doctor) || s(specimen.DoctorCode),
      TestingFacilityCode: testingFacilityCode,
      ReferringRequestID: "",
      Therapy: s(specimen.TherapyText) || s(specimen.Therapy),
      LIMSAnalyzerCode: "",
      TargetTimeDays: 0,
      TargetTimeMins: 0,
      LIMSRejectionCode: "",
      LIMSRejectionDesc: "",
      LIMSFacilityCode: facilityCode,
      Repeated: 0,
      LIMSPreReg_RegistrationDateTime: null,
      LIMSPreReg_ReceivedDateTime: null,
      LIMSPreReg_RegistrationFacilityCode: "",
      LIMSVendorCode: "DISA",
    };
  });

  // LabResults: drive iteration off flattenDisa so we inherit the same
  // resulted-only filter, stray-status-flag filter, "Information missing"
  // sentinel filter, and rejection-metadata filter that the v2 path uses.
  // supersedePanelIterations then drops preliminary panel reruns so a v1
  // emit matches what v1's own historical migration produced. Group
  // resulting rows by panelCode to assign OBRSetID + per-panel OBXSetID.
  const obs = supersedePanelIterations(flattenDisa(specimen)).kept;
  const obrIndexByPanel = new Map<string, number>();
  orderedPanels.forEach((panelCode, i) => obrIndexByPanel.set(panelCode, i + 1));

  // Stable sort: (OBRSetID by panel order) → (panelIndex if same panel) →
  // (orderIndex). Panels not in TestOrders fall back to a high OBRSetID.
  const sorted = [...obs].sort((a, b) => {
    const aObr = obrIndexByPanel.get(a.panelCode) ?? 9999;
    const bObr = obrIndexByPanel.get(b.panelCode) ?? 9999;
    if (aObr !== bObr) return aObr - bObr;
    if (a.panelIndex !== b.panelIndex) return a.panelIndex - b.panelIndex;
    return a.orderIndex - b.orderIndex;
  });

  const labResults: V1LabResult[] = [];
  let prevObr = -1;
  let obxSetId = 0;
  for (const o of sorted) {
    const obrSetId = obrIndexByPanel.get(o.panelCode);
    if (obrSetId === undefined) continue; // observation from a panel not in TestOrders — skip
    if (obrSetId !== prevObr) {
      obxSetId = 0;
      prevObr = obrSetId;
    }
    obxSetId += 1;

    const parm = opts.codebook.paramEntry(o.paramCode);
    const isNumericRow = typeof o.value === "number" && Number.isFinite(o.value);
    const typeChar = o.type.length > 0 ? o.type.charCodeAt(0) : -1;
    // v1 leaves LIMSCodedValue blank for text/comment rows — the rawValue
    // there is just the HL7 status flag (commonly "F"), not a coded result.
    const codedValue = (typeChar === 5 || typeChar === 6) ? "" : o.rawValue.trim();

    labResults.push({
      DateTimeStamp: null,
      Versionstamp: null,
      LIMSDateTimeStamp: null,
      LIMSVersionStamp: null,
      RequestID: requestId,
      OBRSetID: obrSetId,
      OBXSetID: obxSetId,
      OBXSubID: v1ObxSubIdForType(o.type),
      LOINCCode: "",
      HL7ResultTypeCode: v1ResultTypeFromDisaType(o.type),
      SIValue: isNumericRow ? (o.value as number) : 0,
      SIUnits: s(parm?.units),
      SILoRange: 0,
      SIHiRange: 0,
      HL7AbnormalFlagCodes: "",
      DateTimeValue: null,
      CodedValue: "",
      ResultSemiquantitive: 0,
      Note: false,
      LIMSObservationCode: o.paramCode,
      LIMSObservationDesc: s(o.paramDesc ?? parm?.description),
      LIMSRptResult: o.valueStr,
      LIMSRptUnits: s(parm?.units),
      LIMSRptFlag: "",
      LIMSRptRange: s(parm?.reference),
      LIMSCodedValue: codedValue,
      WorkUnits: 0,
      CostUnits: 0,
    });
  }

  return { requests, lab_results: labResults };
}

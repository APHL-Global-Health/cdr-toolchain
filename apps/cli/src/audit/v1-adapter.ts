import type { DisaObs } from "../compare/result-mapping.js";
import type { Codebook } from "../export/codebook.js";
import type { OpenLdrV1LabResult, OpenLdrV1Request } from "../openldr.js";
import { fetchAllRequestsByRequestId, fetchLabResultsByRequestId } from "../openldr.js";
import { detectAnomalies, type AuditInputs } from "./detector.js";
import { maxSeverity, type AuditReport } from "./types.js";

/** v1's HL7ResultTypeCode → an approximate DISA OrderItem.Type byte for
 *  detector classifiers. v1's codes are non-standard ("R"=coded, "C"=text,
 *  "NM"=numeric, "DT"=date, "TM"=time) per CDR_TOOLCHAIN.md; map them
 *  back to OrderItem.Type byte values that result-formats.ts expects. */
function hl7TypeToDisaType(hl7: string | null): string {
  if (hl7 === null) return "";
  const t = hl7.trim().toUpperCase();
  if (t === "NM") return String.fromCharCode(1);  // numeric
  if (t === "R") return String.fromCharCode(0);   // coded
  if (t === "C") return String.fromCharCode(5);   // text/comment
  if (t === "DT") return String.fromCharCode(7);  // date
  if (t === "TM") return String.fromCharCode(8);  // time
  return "";
}

function projectV1Observation(lr: OpenLdrV1LabResult): DisaObs {
  // Choose the best available value: prefer free-text rpt_result, fall
  // back to coded value, then to numeric SIValue. Matches the candidate
  // ordering result-mapping uses in flattenV1.
  const rpt = lr.LIMSRptResult ?? "";
  const coded = lr.LIMSCodedValue ?? "";
  const valueStr = rpt.length > 0 ? rpt : coded.length > 0 ? coded : (lr.SIValue !== null ? String(lr.SIValue) : "");
  // For unrealistic-numeric checks the detector reads o.value (number)
  // when type is numeric. Mirror that here.
  const isNumeric = (lr.HL7ResultTypeCode ?? "").trim().toUpperCase() === "NM";
  const numericValue = isNumeric && lr.SIValue !== null && Number.isFinite(lr.SIValue) ? lr.SIValue : null;

  return {
    panelCode: (lr.LIMSPanelCode ?? "").trim(),
    panelIndex: lr.OBRSetID,
    // v1 LabResults rows don't carry per-OBR datestamps; the audit-vs-v1
    // path doesn't drive supersession from this projection (it only reuses
    // DisaObs for the structural-validation detectors), so null is fine.
    datestamp: null,
    orderIndex: lr.OBXSetID,
    paramCode: (lr.LIMSObservationCode ?? "").trim(),
    paramDesc: lr.LIMSObservationDesc,
    value: numericValue !== null ? numericValue : valueStr,
    valueStr,
    rawValue: coded,
    type: hl7TypeToDisaType(lr.HL7ResultTypeCode),
    isResulted: true,
  };
}

function isoFromDate(d: Date | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  if (!(d instanceof Date)) {
    // mssql sometimes hands back string ISO when the column is read as
    // varchar — accept both shapes defensively.
    const parsed = Date.parse(String(d));
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/** Project v1 Requests + LabResults rows into AuditInputs and run the
 *  same detector. Caller supplies the Codebook (loaded from DISA — v1
 *  uses the same codes since it's a DISA mirror). */
export async function auditFromV1(
  requestId: string,
  openldrCs: string,
  databaseName: string,
  cb: Codebook,
): Promise<{ report: AuditReport | null; reason: "ok" | "no_request" }> {
  const start = Date.now();
  const requests = await fetchAllRequestsByRequestId(requestId, openldrCs, databaseName);
  if (requests.length === 0) {
    return { report: null, reason: "no_request" };
  }
  const labResults = await fetchLabResultsByRequestId(requestId, openldrCs, databaseName);
  const head = requests[0]!;

  // Specimen is denormalised across every Requests row for one RequestID,
  // so row 0 is authoritative.
  const specimenCode = (head.LIMSSpecimenSourceCode ?? "").trim();
  const orderedPanels: string[] = [];
  const seen = new Set<string>();
  for (const r of requests) {
    const code = (r.LIMSPanelCode ?? "").trim();
    if (code.length === 0 || seen.has(code)) continue;
    seen.add(code);
    orderedPanels.push(code);
  }

  const observations = labResults.map(projectV1Observation);

  // v1 doesn't preserve raw DOB — only AgeInYears/AgeInDays. Skip the
  // DOB anomaly checks by passing nulls. SpecimenDateTime stands in for
  // both takenAt and collectedAt (v1 collapses the two). v1 already
  // discarded preliminary panel reruns during its own migration, so the
  // supersededIterations sidecar is always empty in the v1-source path.
  const input: AuditInputs = {
    labNumber: requestId,
    requestId,
    specimenCode: specimenCode.length > 0 ? specimenCode : null,
    orderedPanels,
    observations,
    supersededIterations: [],
    dobRaw: null,
    takenAtRaw: isoFromDate(head.SpecimenDateTime),
    collectedAtRaw: isoFromDate(head.SpecimenDateTime),
    receivedAtRaw: isoFromDate(head.ReceivedDateTime),
    sex: head.HL7SexCode,
    // v1 marks rejected requests with HL7ResultStatusCode='X' (results cannot
    // be obtained — sample rejected). Such requests carry no LabResults by
    // design, so an empty observation set is expected, not an error.
    rejected: (head.HL7ResultStatusCode ?? "").trim().toUpperCase() === "X",
    rejectionReason: null,
    documentationPanels: new Set(),
  };

  const anomalies = detectAnomalies(input, cb);
  return {
    report: {
      lab_number: requestId,
      request_id: requestId,
      source: "openldr",
      scanned_panels: orderedPanels.length,
      scanned_observations: observations.length,
      anomalies,
      max_severity: maxSeverity(anomalies),
      elapsed_ms: Date.now() - start,
    },
    reason: "ok",
  };
}

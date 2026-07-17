import mssql from "mssql";
import { getPool } from "disalab";
import { CliError } from "./errors.js";
import { closePool } from "./db.js";

export interface OpenLdrV1Request {
  RequestID: string;
  RequestingFacilityCode: string | null;
  TestingFacilityCode: string | null;
  LIMSPointOfCareDesc: string | null;
  LIMSPanelCode: string | null;
  LIMSPanelDesc: string | null;
  LIMSSpecimenSourceCode: string | null;
  LIMSSpecimenSourceDesc: string | null;
  SpecimenDateTime: Date | null;
  ReceivedDateTime: Date | null;
  RegisteredDateTime: Date | null;
  AnalysisDateTime: Date | null;
  AuthorisedDateTime: Date | null;
  ClinicalInfo: string | null;
  ICD10ClinicalInfoCodes: string | null;
  Therapy: string | null;
  HL7PriorityCode: string | null;
  HL7SexCode: string | null;
  HL7PatientClassCode: string | null;
  HL7SectionCode: string | null;
  HL7ResultStatusCode: string | null;
  AgeInYears: number | null;
  AgeInDays: number | null;
  AttendingDoctor: string | null;
  TestedBy: string | null;
  AuthorisedBy: string | null;
  /**
   * HL7 OBR set id. **v1's grain is (RequestID, OBRSetID) — ONE ROW PER ORDERED
   * PANEL.** Measured on TDS: 76,002 of 174,261 rows are OBRSetID > 1 (43.6%),
   * and 60,140 of 98,259 requests (61.2%) carry 2+ distinct LIMSPanelCodes.
   * ⚠ `fetchRequestByRequestId` returns the LOWEST OBRSetID row (see below), so
   * this is always the FIRST OBR — a fact that was implicit until now.
   */
  OBRSetID: number | null;
  /** ⚠ NOT a duplicate of HL7PriorityCode — measured, they are orthogonal:
   *  D x R 154,888 / E x R 19,260 / D x U 87 / E x U 14 / D x S 12. */
  RequestTypeCode: string | null;
  /** ⚠ The SAME facility as RequestingFacilityCode, WITHOUT v1's "DISA" prefix —
   *  measured: RequestingFacilityCode 'DISA0JJAA' vs LIMSFacilityCode '0JJAA'. */
  LIMSFacilityCode: string | null;
  RegisteredBy: string | null;
  /** ⚠ NOT free text — measured, the values are numeric codes ('17', '18',
   *  '2421', '06050100'). Meaning undocumented. */
  OrderingNotes: string | null;
  LIMSAnalyzerCode: string | null;
  LIMSVendorCode: string | null;
  CollectionVolume: number | null;
  LIMSRejectionCode: string | null;
  LIMSRejectionDesc: string | null;
  /**
   * All non-null LIMSPanelCode values across every OBR-set row for this
   * RequestID, deduplicated. v1 may split DISA's parent panel into several
   * OBR rows (one per sub-test) so the parent panel code can sit on any
   * OBRSetID, not just OBR=1. The request-level comparator treats these
   * as candidates so a match on any row counts. Populated by
   * fetchRequestByRequestId; absent from rows returned by
   * fetchAllRequestsByRequestId (each of those rows represents one OBR).
   */
  allPanelCodes: string[];
}

/**
 * A LabResults row joined with its owning Request so the panel code is available
 * alongside the observation. Matches the `ResultsWithPanel` CTE in
 * `temp/script.sql`.
 */
export interface OpenLdrV1LabResult {
  RequestID: string;
  OBRSetID: number;
  OBXSetID: number;
  OBXSubID: number;
  LIMSPanelCode: string | null;
  LIMSPanelDesc: string | null;
  LIMSObservationCode: string | null;
  LIMSObservationDesc: string | null;
  LIMSRptResult: string | null;
  LIMSCodedValue: string | null;
  HL7ResultTypeCode: string | null;
  HL7AbnormalFlagCodes: string | null;
  LIMSRptRange: string | null;
  SIValue: number | null;
  SIUnits: string | null;
}

const REQUEST_COLUMNS = `
  [RequestID],
  [RequestingFacilityCode], [TestingFacilityCode], [LIMSPointOfCareDesc],
  [LIMSPanelCode], [LIMSPanelDesc],
  [LIMSSpecimenSourceCode], [LIMSSpecimenSourceDesc],
  [SpecimenDateTime], [ReceivedDateTime], [RegisteredDateTime],
  [AnalysisDateTime], [AuthorisedDateTime],
  [ClinicalInfo], [ICD10ClinicalInfoCodes], [Therapy],
  [HL7PriorityCode], [HL7SexCode], [HL7PatientClassCode],
  [HL7SectionCode], [HL7ResultStatusCode],
  [AgeInYears], [AgeInDays],
  [AttendingDoctor], [TestedBy], [AuthorisedBy],
  [OBRSetID], [RequestTypeCode], [LIMSFacilityCode],
  [RegisteredBy], [OrderingNotes], [LIMSAnalyzerCode], [LIMSVendorCode],
  [CollectionVolume], [LIMSRejectionCode], [LIMSRejectionDesc]
`;
// ⚠ EncryptedPatientID is deliberately ABSENT: PHI, and not_carried
// (v1-coverage.ts). The gate prints values into diff rows and into committed
// findings docs, so coverage is not a licence to widen a PHI blast radius.
// The other 19 not_carried columns are likewise never selected.

function quoteIdent(name: string): string {
  // SQL Server: escape closing brackets in identifiers
  return `[${name.replace(/]/g, "]]")}]`;
}

export function buildRequestSql(databaseName: string): string {
  // Fetch every OBR-set row per request so we can (a) treat the lowest
  // OBRSetID as the canonical request-level row, matching the convention
  // in temp/script.sql, and (b) collect the full panel-code set across
  // sibling OBR rows for the request-level comparator.
  const fqTable = `${quoteIdent(databaseName)}.[dbo].[Requests]`;
  return `
    SELECT ${REQUEST_COLUMNS}
    FROM ${fqTable}
    WHERE [RequestID] = @requestId
    ORDER BY [OBRSetID]
  `.trim();
}

export async function fetchRequestByRequestId(
  requestId: string,
  connectionString: string,
  databaseName: string,
): Promise<OpenLdrV1Request | null> {
  try {
    const pool = await getPool(connectionString);
    const result = await pool
      .request()
      .input("requestId", mssql.NVarChar, requestId)
      .query(buildRequestSql(databaseName));
    const rows = result.recordset as OpenLdrV1Request[];
    if (rows.length === 0) return null;
    const first = rows[0]!;
    const seen = new Set<string>();
    const allPanelCodes: string[] = [];
    for (const r of rows) {
      const code = r.LIMSPanelCode;
      if (code === null || code === undefined) continue;
      const trimmed = String(code).trim();
      if (trimmed.length === 0 || seen.has(trimmed)) continue;
      seen.add(trimmed);
      allPanelCodes.push(trimmed);
    }
    first.allPanelCodes = allPanelCodes;
    return first;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_QUERY_FAILED", `OpenLDR v1 query failed: ${message}`);
  } finally {
    // Important: explicitly close the global pool so a subsequent connect() to a
    // different URI doesn't silently reuse this one.
    await closePool();
  }
}

export function buildAllRequestsSql(databaseName: string): string {
  // All OBR-set rows for the request — one row per ordered panel. The audit
  // path needs every panel; compare paths used TOP 1 because they only
  // resolved request-level fields.
  const fqTable = `${quoteIdent(databaseName)}.[dbo].[Requests]`;
  return `
    SELECT ${REQUEST_COLUMNS}
    FROM ${fqTable}
    WHERE [RequestID] = @requestId
    ORDER BY [OBRSetID]
  `.trim();
}

export async function fetchAllRequestsByRequestId(
  requestId: string,
  connectionString: string,
  databaseName: string,
): Promise<OpenLdrV1Request[]> {
  try {
    const pool = await getPool(connectionString);
    const result = await pool
      .request()
      .input("requestId", mssql.NVarChar, requestId)
      .query(buildAllRequestsSql(databaseName));
    // Each row represents one OBR, so per-row allPanelCodes is just that
    // row's own code. fetchRequestByRequestId is the place that aggregates
    // across rows.
    return (result.recordset as OpenLdrV1Request[]).map((r) => {
      const code = typeof r.LIMSPanelCode === "string" ? r.LIMSPanelCode.trim() : "";
      r.allPanelCodes = code.length > 0 ? [code] : [];
      return r;
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_QUERY_FAILED", `OpenLDR v1 query failed: ${message}`);
  } finally {
    await closePool();
  }
}

/** Page-able RequestID list for audit-batch when --source openldr.
 *  Mirrors REGDAT4.LabNumbers' shape: WHERE clause optional, OFFSET/FETCH
 *  appended. Distinct because Requests has one row per OBR but we want
 *  one entry per request. */
export function buildRequestIdsSql(databaseName: string, where: string, offset: number, limit: number): string {
  const fqTable = `${quoteIdent(databaseName)}.[dbo].[Requests]`;
  const trimmed = where.trim().replace(/^WHERE\s+/i, "");
  const userClause = trimmed.length > 0 ? `WHERE ${trimmed}` : "";
  return `
    SELECT DISTINCT [RequestID]
    FROM ${fqTable}
    ${userClause}
    ORDER BY [RequestID]
    OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY
  `.trim();
}

export async function fetchOpenldrRequestIds(
  where: string,
  offset: number,
  limit: number,
  connectionString: string,
  databaseName: string,
): Promise<string[]> {
  try {
    const pool = await getPool(connectionString);
    const result = await pool
      .request()
      .query(buildRequestIdsSql(databaseName, where, offset, limit));
    return result.recordset.map((r) => String((r as { RequestID: string }).RequestID));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_QUERY_FAILED", `OpenLDR v1 RequestID list failed: ${message}`);
  } finally {
    await closePool();
  }
}

const LAB_RESULT_COLUMNS = `
  lr.[RequestID], lr.[OBRSetID], lr.[OBXSetID], lr.[OBXSubID],
  req.[LIMSPanelCode], req.[LIMSPanelDesc],
  lr.[LIMSObservationCode], lr.[LIMSObservationDesc],
  lr.[LIMSRptResult], lr.[LIMSCodedValue],
  lr.[HL7ResultTypeCode], lr.[HL7AbnormalFlagCodes],
  lr.[LIMSRptRange], lr.[SIValue], lr.[SIUnits]
`;

export function buildLabResultsSql(databaseName: string): string {
  const resultsTable = `${quoteIdent(databaseName)}.[dbo].[LabResults]`;
  const requestsTable = `${quoteIdent(databaseName)}.[dbo].[Requests]`;
  return `
    SELECT ${LAB_RESULT_COLUMNS}
    FROM ${resultsTable} lr
    JOIN ${requestsTable} req
      ON req.[RequestID] = lr.[RequestID]
     AND req.[OBRSetID]  = lr.[OBRSetID]
    WHERE lr.[RequestID] = @requestId
    ORDER BY lr.[OBRSetID], lr.[OBXSetID], lr.[OBXSubID]
  `.trim();
}

export async function fetchLabResultsByRequestId(
  requestId: string,
  connectionString: string,
  databaseName: string,
): Promise<OpenLdrV1LabResult[]> {
  try {
    const pool = await getPool(connectionString);
    const result = await pool
      .request()
      .input("requestId", mssql.NVarChar, requestId)
      .query(buildLabResultsSql(databaseName));
    return result.recordset as OpenLdrV1LabResult[];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CliError("DB_QUERY_FAILED", `OpenLDR v1 LabResults query failed: ${message}`);
  } finally {
    await closePool();
  }
}

/**
 * PointOfCareDesc ordering convention.
 *
 * - `facility_ward` (Tanzania default): `facility~ward`, up to 2 segments.
 * - `district_facility_ward` (Mozambique): `province district~facility~ward`,
 *   up to 3 segments. The column is varchar(50) so the trailing ward (and
 *   occasionally the facility) is frequently truncated mid-word — examples
 *   in the wild include "…CS Mavalane~Consulta de Cri" and "…CS 1 De Maio
 *   (Maputo)~Tube". 2-segment rows (`district~facility`, no ward) also occur.
 *
 * Default stays `facility_ward` so Tanzania behaviour is unchanged when the
 * env var is unset.
 */
export type PocFormat = "facility_ward" | "district_facility_ward";

/**
 * Strip CHAR(6) (a Disa-specific bell-like delimiter, see temp/script.sql line 53)
 * and split a tilde-delimited PointOfCareDesc into its semantic parts.
 *
 * Returns `{ district, facilityName, ward }`. `district` is always `null`
 * under `facility_ward` since Tanzania's column has no district slot.
 *
 * When the input contains MORE tildes than the format expects (e.g. a facility
 * name with an embedded "~"), any extra segments are joined back into the
 * trailing field (`ward` for both formats) so we don't silently drop data.
 * When there is no `~`, the whole value is treated as the facility — both
 * conventions degrade gracefully to a single-name fallback.
 *
 * 50-char truncation in the source is opaque here — we just parse whatever
 * arrived. Comparator-level truncation tolerance is the caller's job.
 */
export function splitPointOfCare(
  raw: string | null | undefined,
  format: PocFormat = "facility_ward",
): { district: string | null; facilityName: string | null; ward: string | null } {
  const empty = { district: null, facilityName: null, ward: null };
  if (raw === null || raw === undefined) return empty;
  const cleaned = raw.replace(/\x06/g, "");
  if (cleaned.trim().length === 0) return empty;

  const parts = cleaned.split("~").map((s) => s.trim());

  // Single segment → treat as facility for both conventions.
  if (parts.length === 1) {
    return { district: null, facilityName: parts[0]!.length > 0 ? parts[0]! : null, ward: null };
  }

  if (format === "district_facility_ward") {
    // [district][facility][ward + any extra ~ segments rejoined].
    const district = parts[0]!.length > 0 ? parts[0]! : null;
    const facility = parts[1]!.length > 0 ? parts[1]! : null;
    let ward: string | null = null;
    if (parts.length >= 3) {
      const wardJoined = parts.slice(2).join("~").trim();
      ward = wardJoined.length > 0 ? wardJoined : null;
    }
    return { district, facilityName: facility, ward };
  }

  // facility_ward: [facility][ward + any extra ~ segments rejoined].
  const facility = parts[0]!.length > 0 ? parts[0]! : null;
  const wardJoined = parts.slice(1).join("~").trim();
  return { district: null, facilityName: facility, ward: wardJoined.length > 0 ? wardJoined : null };
}

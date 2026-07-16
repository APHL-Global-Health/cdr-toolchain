import type { AUDTDATA } from "disalab";

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
export interface PanelAuditFacts {
  analysisAt: string | null;
  testedBy: string;
  authorisedAt: string | null;
  authorisedBy: string;
}

export interface AuditFacts {
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

export function extractAuditFacts(rows: AUDTDATA[]): AuditFacts {
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

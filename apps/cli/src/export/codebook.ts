import mssql from "mssql";
import { COMMDICT, PARMDICT, TESTDICT } from "disalab";
import type { DisaServer } from "disalab";

// PARMDICT.CONTEXT values discovered by inspecting the live DisaGlobal
// dictionary on a Tanzania deployment. These are DISA-product-level
// constants (not country-specific): the same CONTEXT numbers carry the
// same semantics across deployments because PARMDICT ships with DISA.
export const CTX_GENERIC_ANTIBIOTIC = 79;
export const CTX_TB_ANTIBIOTIC = 60;
export const CTX_PATHOGEN_ID_PARAM = 50;
// Specimen / sample-type codes (e.g. PUSR=Rectal Swab, BLOOD, CSF) live in
// COMMDICT under CONTEXT=97. SpecimenRecpt.Specimen carries the bare code;
// the description has to be looked up.
export const CTX_SPECIMEN = 97;

// Questionnaire / metadata observation contexts. Panels whose observations
// live exclusively in these contexts (VLID, EIDID, …) are the "info-only"
// panels PRD §5.1 wants deprioritised when picking lab_request.panel_code.
const QUESTIONNAIRE_CONTEXTS: ReadonlySet<number> = new Set([
  77, // QINTE / HIVPC interpretation flags
  88, // FEED (child feeding)
  101, // ARV pregnancy / breastfeeding / TB-status questions
  102, // ARVRT (reason for HVL testing)
  108, // ARVDA (drug adherence)
  110, // ARVA1 / ARVP1 / DRUGC/M/P (regimen lines)
  112, // DBSC (reason for PCR testing)
  131, 132, 133, 134, 135, 136, 137, // ART regimen variants per PRD memory
  150, // ARVP (currently pregnant)
  155, // Individual ARV drugs (ABACA, EFAVI, …)
]);

// Organism description heuristics applied to COMMDICT[CONTEXT=50] entries
// to bucket each organism code into v2's organism_type enum. Order matters:
// "no growth" / "normal flora" must be checked before bacteria default.
const NO_GROWTH_RE = /\b(no\s*(growth|bacterial|pathogen|organism)|normal\s*flora|sterile|negative)\b/i;
const FUNGUS_RE = /\b(candida|cryptoc|aspergillus|fusarium|trichoph|microsporum|histoplasm|mucor|yeast|fungi|mould|mold)\b/i;
const PARASITE_RE = /\b(plasmodi|trypanos|leishman|schistos|filari|giardia|entamoeba|cryptosporid|toxoplasm|trichomon|ascaris|strongyl|hookworm|hymenolep|taenia|necator|enterobi)\b/i;

export type OrganismCategory = "bacteria" | "fungus" | "parasite" | "none";

export interface ParmEntry {
  code: string;
  description: string;
  abbreviation: string;
  context: number;
  units: string;
  reference: string;
}

export interface CommEntry {
  context: number;
  code: string;
  description: string;
}

export interface PanelEntry {
  code: string;
  description: string;
  abbreviation: string;
  /** TESTDICT.SECTION — single-char section code ("M" = microbiology, etc.).
   *  Often blank or whitespace-padded; the codebook trims it. */
  section: string | null;
}

export interface UserEntry {
  /** USERDIC6.CODE / LOGIN — the staff initials used everywhere internally. */
  code: string;
  /** USERDIC6.DESCRIPTION — preferred full name. May fall back to CODE if blank. */
  description: string;
}

export interface Codebook {
  isAntibiotic(paramCode: string): boolean;
  isTbAntibiotic(paramCode: string): boolean;
  isPathogenIdParam(paramCode: string): boolean;
  isQuestionnaireParam(paramCode: string): boolean;
  paramEntry(paramCode: string): ParmEntry | undefined;
  panelEntry(panelCode: string): PanelEntry | undefined;
  specimenEntry(specimenCode: string): CommEntry | undefined;
  organismEntry(codedValue: string): CommEntry | undefined;
  organismCategory(codedValue: string): OrganismCategory;
  /** Resolve staff initials (NSN, SKN, …) to a full name via USERDIC6. */
  userEntry(userCode: string): UserEntry | undefined;
  /** Stats for diagnostics — not used by the transform itself. */
  stats: {
    parmRows: number;
    testRows: number;
    commOrganismRows: number;
    commSpecimenRows: number;
    userRows: number;
  };
}

export async function loadCodebook(server: DisaServer): Promise<Codebook> {
  // PARMDICT has no SQL CODE column (CODE is decoded from the blob).
  // PARMDICT.ACTIVE is whitespace for active rows (not "Y"), so any active
  // filter would silently drop everything — pull the lot. ~1.5k rows; one
  // full scan per command run is acceptable.
  const allParm = await PARMDICT.All("", server);

  const parmByCode = new Map<string, ParmEntry>();
  for (const p of allParm) {
    const code = p.CODE.trim();
    if (code.length === 0) continue;
    // First-write-wins: PARMDICT can have stale duplicate rows for the same
    // code under different contexts; the active-row filter usually leaves
    // one, but be defensive.
    if (parmByCode.has(code)) continue;
    parmByCode.set(code, {
      code,
      description: p.DESCRIPTION.trim(),
      abbreviation: p.ABBREVIATION.trim(),
      context: p.CONTEXT,
      units: p.UNITS.trim(),
      reference: p.REFERENCE.trim(),
    });
  }

  // Panels (MRCSW, MICBM, …) live in TESTDICT, not PARMDICT. CODE +
  // DESCRIPTION are real SQL columns so this is a cheap full-table pull
  // (≈few hundred rows).
  const testRows = await TESTDICT.All("", server);
  const panelByCode = new Map<string, PanelEntry>();
  for (const t of testRows) {
    const code = (t.CODE ?? "").trim();
    if (code.length === 0) continue;
    if (panelByCode.has(code)) continue;
    const section = t.SECTION === null || t.SECTION === undefined ? null : String(t.SECTION).trim();
    panelByCode.set(code, {
      code,
      description: (t.DESCRIPTION ?? "").trim(),
      abbreviation: (t.ABBREV ?? "").trim(),
      section: section !== null && section.length > 0 ? section : null,
    });
  }

  // Organism codes (CONTEXT=50) and specimen codes (CONTEXT=97) both live in
  // COMMDICT. Pull both slices with one query. ACTIVE filter omitted — same
  // whitespace-vs-"Y" caveat as PARMDICT.
  const commRows = await COMMDICT.All(
    `WHERE [CONTEXT] IN (${CTX_PATHOGEN_ID_PARAM}, ${CTX_SPECIMEN})`,
    server,
  );
  const commByCode = new Map<string, CommEntry>();
  const specimenByCode = new Map<string, CommEntry>();
  for (const c of commRows) {
    const code = String(c.CODE ?? "").trim();
    if (code.length === 0) continue;
    const entry: CommEntry = {
      context: Number(c.CONTEXT),
      code,
      description: String(c.DESCRIPTION ?? "").trim(),
    };
    if (entry.context === CTX_PATHOGEN_ID_PARAM) {
      if (!commByCode.has(code)) commByCode.set(code, entry);
    } else if (entry.context === CTX_SPECIMEN) {
      if (!specimenByCode.has(code)) specimenByCode.set(code, entry);
    }
  }

  // USERDIC6 lives in DisalabDict (not DisaGlobal) and isn't surfaced by
  // disalab as a class — query it directly. Small table (~hundreds of rows
  // per deployment), one full pull per command.
  const userByCode = new Map<string, UserEntry>();
  try {
    const pool = await mssql.connect(server.config.database.connection_string);
    const result = await pool.request().query(`SELECT [CODE], [LOGIN], [DESCRIPTION] FROM [DisalabDict].[dbo].[USERDIC6]`);
    for (const row of result.recordset as Array<{ CODE?: string; LOGIN?: string; DESCRIPTION?: string }>) {
      const code = String(row.CODE ?? "").trim();
      if (code.length === 0) continue;
      if (userByCode.has(code)) continue;
      const desc = String(row.DESCRIPTION ?? "").trim();
      userByCode.set(code, { code, description: desc.length > 0 ? desc : code });
    }
  } catch {
    // USERDIC6 may not exist on every deployment — degrade gracefully and
    // let the transform fall back to raw user codes.
  }

  function classify(desc: string): OrganismCategory {
    if (desc.length === 0) return "bacteria";
    if (NO_GROWTH_RE.test(desc)) return "none";
    if (FUNGUS_RE.test(desc)) return "fungus";
    if (PARASITE_RE.test(desc)) return "parasite";
    return "bacteria";
  }

  return {
    isAntibiotic(paramCode) {
      const e = parmByCode.get(paramCode);
      return e !== undefined && (e.context === CTX_GENERIC_ANTIBIOTIC || e.context === CTX_TB_ANTIBIOTIC);
    },
    isTbAntibiotic(paramCode) {
      return parmByCode.get(paramCode)?.context === CTX_TB_ANTIBIOTIC;
    },
    isPathogenIdParam(paramCode) {
      return parmByCode.get(paramCode)?.context === CTX_PATHOGEN_ID_PARAM;
    },
    isQuestionnaireParam(paramCode) {
      const ctx = parmByCode.get(paramCode)?.context;
      return ctx !== undefined && QUESTIONNAIRE_CONTEXTS.has(ctx);
    },
    paramEntry(paramCode) {
      return parmByCode.get(paramCode);
    },
    panelEntry(panelCode) {
      return panelByCode.get(panelCode);
    },
    specimenEntry(specimenCode) {
      return specimenByCode.get(specimenCode);
    },
    organismEntry(codedValue) {
      return commByCode.get(codedValue);
    },
    userEntry(userCode) {
      return userByCode.get(userCode.trim());
    },
    organismCategory(codedValue) {
      const e = commByCode.get(codedValue);
      // Some no-growth codes (NBG, NF, NG, …) won't be in the dictionary on
      // every deployment — fall back to the code itself when no entry exists.
      const desc = e?.description ?? "";
      const fromDesc = classify(desc);
      if (fromDesc !== "bacteria") return fromDesc;
      // Code-shape heuristic for the codes themselves (covers cases where
      // the description says "Vibrio cholera" but a sibling code is "NBG").
      if (/^(NBG|NF|NG|NFLO|NORGS|NOR)$/i.test(codedValue)) return "none";
      return fromDesc;
    },
    stats: {
      parmRows: allParm.length,
      testRows: testRows.length,
      commOrganismRows: commByCode.size,
      commSpecimenRows: specimenByCode.size,
      userRows: userByCode.size,
    },
  };
}

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AUDTDATA, SpecimenRecpt } from "disalab";
import { deriveResultStatus, toV2 } from "./v2-transform.js";
import { extractAuditFacts, type AuditFacts } from "./audit-facts.js";
import { DEFAULT_SITE } from "./site-config.js";
import { stubCodebook } from "../test-helpers/stub-codebook.js";

/**
 * Build an AuditFacts fixture directly (no need to round-trip AUDTDATA rows
 * through extractAuditFacts for the deriveResultStatus table tests below —
 * that plumbing is covered separately by the analysis_at/authorised_at
 * end-to-end test further down).
 */
function factsFrom(
  panels: Record<string, { analysisAt?: string | null; authorisedAt?: string | null }>,
): AuditFacts {
  const perPanel = new Map<string, { analysisAt: string | null; testedBy: string; authorisedAt: string | null; authorisedBy: string }>();
  for (const [code, v] of Object.entries(panels)) {
    perPanel.set(code, {
      analysisAt: v.analysisAt ?? null,
      testedBy: "",
      authorisedAt: v.authorisedAt ?? null,
      authorisedBy: "",
    });
  }
  return { registeredAt: null, registeredBy: "", perPanel };
}

// ---------- deriveResultStatus: HL7 table 0123, precedence X > I > A > R > F ----------

test("rejected wins over everything else, even fully authorised panels", () => {
  const facts = factsFrom({
    PANELA: { analysisAt: "2024-01-01T00:00:00.000Z", authorisedAt: "2024-01-02T00:00:00.000Z" },
  });
  assert.equal(deriveResultStatus(["PANELA"], facts, true), "X");
});

test("no ordered panel has a WL101 -> I (nothing resulted)", () => {
  const facts = factsFrom({});
  assert.equal(deriveResultStatus(["PANELA", "PANELB"], facts, false), "I");
});

test("1 of 2 ordered panels resulted -> A", () => {
  const facts = factsFrom({
    PANELA: { analysisAt: "2024-01-01T00:00:00.000Z" },
  });
  assert.equal(deriveResultStatus(["PANELA", "PANELB"], facts, false), "A");
});

test("both panels resulted, only 1 authorised -> R", () => {
  const facts = factsFrom({
    PANELA: { analysisAt: "2024-01-01T00:00:00.000Z", authorisedAt: "2024-01-02T00:00:00.000Z" },
    PANELB: { analysisAt: "2024-01-01T00:00:00.000Z" },
  });
  assert.equal(deriveResultStatus(["PANELA", "PANELB"], facts, false), "R");
});

test("both panels resulted and authorised -> F", () => {
  const facts = factsFrom({
    PANELA: { analysisAt: "2024-01-01T00:00:00.000Z", authorisedAt: "2024-01-02T00:00:00.000Z" },
    PANELB: { analysisAt: "2024-01-01T00:00:00.000Z", authorisedAt: "2024-01-03T00:00:00.000Z" },
  });
  assert.equal(deriveResultStatus(["PANELA", "PANELB"], facts, false), "F");
});

test("no ordered panels at all -> null (unknown, not guessed)", () => {
  const facts = factsFrom({});
  assert.equal(deriveResultStatus([], facts, false), null);
});

test("empty auditRows + not rejected + panels ordered -> I", () => {
  const facts = extractAuditFacts([]);
  assert.equal(deriveResultStatus(["PANELA"], facts, false), "I");
});

// ---------- analysis_at / authorised_at wiring through toV2 ----------------

function auditRow(code: string, at: string, user: string, data: string): AUDTDATA {
  return {
    AUDDateTime: new Date(at),
    _AuditCode: code,
    _AuditUser: user,
    _Auditdata: data,
  } as unknown as AUDTDATA;
}

function specimenFixture(): SpecimenRecpt {
  return ({
    LabNumber: "TEST002",
    TestOrders: ["PANELA", "PANELB"],
    TestResults: [],
    Facility: null,
    WardClinic: null,
    WardClinicResolved: null,
    FolderNo: null,
    LastName: null,
    MiddleName: null,
    FirstName: null,
    Sex: null,
    Phone: null,
    Work: null,
    Mobile: null,
    Email: null,
    Address: null,
    ICD10: null,
    Therapy: null,
    TherapyText: null,
    ClinicalDiagnosis: null,
    ClinicalDiagnosisText: null,
    Specimen: null,
    Condition: null,
    TakenDateTime: null,
    CollectedDateTime: null,
    ReceivedInLabDateTime: null,
    RegisteredDateTime: null,
    CollectedBy: null,
    TakenBy: null,
    ReceivedInLabBy: null,
    Priority: null,
    DoctorCode: null,
    Doctor: null,
    DobAge: null,
    NID: null,
  } as unknown) as SpecimenRecpt;
}

test("analysis_at is the EARLIEST WL101 and authorised_at the LATEST WA500 across panels", () => {
  const cb = stubCodebook({ panels: { PANELA: "Panel A", PANELB: "Panel B" } });
  const auditRows: AUDTDATA[] = [
    auditRow("WL101", "2024-01-05T10:00:00.000Z", "USR1", "PANELA: (1) insert results"),
    auditRow("WL101", "2024-01-03T09:00:00.000Z", "USR2", "PANELB: (2) insert results"), // earliest
    auditRow("WA500", "2024-01-06T11:00:00.000Z", "USR3", "PANELA: (1)Prt X Rvw USR"),
    auditRow("WA500", "2024-01-08T12:00:00.000Z", "USR4", "PANELB: (2)Prt X Rvw USR"), // latest
  ];
  const payload = toV2(specimenFixture(), {
    prefix: "",
    site: DEFAULT_SITE,
    codebook: cb,
    auditRows,
  });
  assert.equal(payload.lab_request.analysis_at, "2024-01-03T09:00:00.000Z");
  assert.equal(payload.lab_request.authorised_at, "2024-01-08T12:00:00.000Z");
  assert.equal(payload.lab_request.authorised_by, "USR4");
  assert.equal(payload.lab_request.result_status, "F");
});

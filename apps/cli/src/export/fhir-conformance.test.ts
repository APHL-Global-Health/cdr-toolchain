// R4 conformance gate over the mapper's output, run through the OFFICIAL HL7
// FHIR Validator (via fhir-validator-js — a test-only devDependency that
// self-provisions its own JRE + validator JAR and never ships).
//
// Why this exists: CE's own zod schemas are `.passthrough()` with nearly
// every field optional — {"resourceType":"Specimen"} validates and persists
// there. CE cannot catch mapping bugs, so conformance has to be checked here,
// against the mapper's own output, in this repo.
//
// Gated behind FHIR_CONFORMANCE=1: the first run downloads ~100-200MB (JRE +
// validator JAR) and starts a local Java server, so it must never run as part
// of the default `pnpm test`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { toFhir } from "./fhir-transform.js";
import { basePayload } from "./fhir-transform.test.js";
import type { V2LabResult, V2Isolate, V2SusceptibilityTest } from "./types.js";

const RUN = process.env.FHIR_CONFORMANCE === "1";
const TZ = { tzOffset: "+02:00" };

function labResult(over: Partial<V2LabResult> = {}): V2LabResult {
  return {
    source_test_code: "CULT", obx_set_id: 1, obx_sub_id: 0,
    observation_code: {
      concept_code: "WBC", display_name: "White Blood Cell Count",
      concept_class: "test", datatype: "numeric", system_id: "DEFAULT_TEST",
    },
    result_value: "15.2", result_type: "NM", numeric_value: 15.2,
    coded_value: null, text_value: null, numeric_units: "x10^9/L",
    abnormal_flag: null, rpt_units: null, rpt_flag: null, rpt_range: null,
    result_timestamp: null, isolate_index: null, is_resulted: true,
    raw_result: {}, ...over,
  };
}

function isolate(over: Partial<V2Isolate> = {}): V2Isolate {
  return {
    isolate_index: 1, source_test_code: "CULT",
    organism_code: {
      concept_code: "ECO", display_name: "Escherichia coli",
      concept_class: "organism", datatype: "coded",
    },
    organism_type: "bacteria", isolate_number: "1", serotype: null,
    patient_age_days: null, patient_sex: "F", ward: null, ward_type: null,
    origin: null, beta_lactamase: null, esbl: null, carbapenemase: null,
    mrsa_screen: null, inducible_clinda: null, custom_fields: null,
    raw_result: {}, ...over,
  };
}

function ast(over: Partial<V2SusceptibilityTest> = {}): V2SusceptibilityTest {
  return {
    isolate_index: 1, source_test_code: "SENS",
    antibiotic_code: {
      concept_code: "AMP", display_name: "Ampicillin",
      concept_class: "antibiotic", datatype: "coded",
    },
    test_method: "DISK", disk_potency: null, result_raw: "R",
    result_numeric: null, susceptibility_value: "R", quantitative_value: null,
    guideline: "CLSI", guideline_version: null, raw_result: {}, ...over,
  };
}

// A rich payload — panel, specimen, dates, two lab results (one numeric with
// units + abnormal_flag + rpt_range, one coded), an isolate, and an AST — so
// the micro hasMember tree is actually exercised. The v2 reference example
// ships no hasMember tree, so this is the only conformance cover it gets.
function richPayload() {
  return basePayload({
    lab_request: {
      request_id: "CONF-2024-00001",
      facility_code: null,
      panel_code: {
        concept_code: "CULT", display_name: "Blood Culture",
        concept_class: "panel", datatype: "coded", system_id: "DEFAULT_TEST",
      },
      specimen_code: {
        concept_code: "BLD", display_name: "Blood",
        concept_class: "specimen", datatype: "coded", system_id: "DEFAULT_SPEC",
      },
      taken_datetime: "2024-07-20T08:00:00",
      collected_datetime: "2024-07-20T08:30:00",
      received_at: "2024-07-20T09:00:00",
      registered_at: "2024-07-20T09:15:00",
      analysis_at: "2024-07-20T10:00:00",
      authorised_at: "2024-07-20T14:00:00",
      clinical_info: "suspected sepsis",
      icd10_codes: null, therapy: null, priority: null,
      age_years: 34, age_days: null, sex: "F", patient_class: null,
      section_code: null, result_status: "F", requesting_facility_code: null,
      testing_facility_code: {
        concept_code: "LAB1", display_name: "Central Reference Lab",
        concept_class: "facility", datatype: "coded", system_id: "DEFAULT_FAC",
      },
      requesting_doctor: "Dr Mwakasege", tested_by: null,
      authorised_by: null, source_payload: {},
    },
    lab_results: [
      labResult({
        obx_set_id: 1,
        observation_code: {
          concept_code: "WBC", display_name: "White Blood Cell Count",
          concept_class: "test", datatype: "numeric", system_id: "DEFAULT_TEST",
        },
        numeric_value: 15.2, numeric_units: "x10^9/L",
        abnormal_flag: "H", rpt_range: "4.0-11.0",
        result_timestamp: "2024-07-20T10:05:00",
      }),
      labResult({
        obx_set_id: 2,
        observation_code: {
          concept_code: "GRAM", display_name: "Gram Stain",
          concept_class: "test", datatype: "coded", system_id: "DEFAULT_TEST",
        },
        result_type: "CE", numeric_value: null, numeric_units: null,
        coded_value: "GNR", result_value: "Gram-negative rods",
        result_timestamp: "2024-07-20T10:10:00",
      }),
    ],
    isolates: [isolate()],
    susceptibility_tests: [ast()],
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let validator: any;

before(async () => {
  if (!RUN) return;
  // fhir-validator-js ships no type declarations (test-only devDependency).
  // @ts-expect-error no .d.ts for this module
  const createValidatorInstance = (await import("fhir-validator-js")).default;
  // txServer: "n/a" disables terminology validation (validator.js:25 maps it to
  // null). Deliberate, and NOT a way of dodging failures: our concept codes are
  // DISA-native (urn:openldr:*) with no public code system, so there is nothing
  // on any terminology server to resolve them against. Left on, the validator
  // reaches for tx.fhir.org, times out, and reports the timeout as CODEINVALID
  // on every coding — noise that would drown any real structural finding (and
  // it took 12 minutes). Structure, cardinality and invariants are still fully
  // checked; only code-system lookups are skipped.
  validator = await createValidatorInstance({ sv: "4.0.1", igs: [], locale: "en", txServer: "n/a" });
}, { timeout: 600_000 });

after(() => {
  if (!RUN) return;
  validator?.shutdown();
});

test(
  "toFhir output is R4-conformant per the official HL7 validator",
  { skip: !RUN && "set FHIR_CONFORMANCE=1 to run (downloads a JRE + validator JAR)" },
  async () => {
    const resources = toFhir(richPayload(), TZ);
    assert.ok(resources.length >= 6, `expected a rich resource set, got ${resources.length}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcomes: any[] = await validator.validate(resources);
    assert.equal(
      outcomes.length,
      resources.length,
      `expected one outcome per resource (${resources.length}), got ${outcomes.length}`,
    );

    const failures: string[] = [];
    for (let i = 0; i < resources.length; i++) {
      const resource = resources[i]!;
      const outcome = outcomes[i];
      const issues: any[] = outcome?.messages ?? outcome?.issues ?? [];
      const badIssues = issues.filter((iss) => {
        const level = String(iss.level ?? iss.severity ?? "").toLowerCase();
        return level === "error" || level === "fatal";
      });
      if (badIssues.length > 0) {
        failures.push(
          `${resource.resourceType as string}/${resource.id as string}:\n` +
            badIssues.map((iss) => `  - ${JSON.stringify(iss)}`).join("\n"),
        );
      }
    }

    console.log(`FHIR conformance: validated ${resources.length} resources.`);

    assert.equal(
      failures.length,
      0,
      `${failures.length} resource(s) failed R4 conformance:\n${failures.join("\n")}`,
    );
  },
);

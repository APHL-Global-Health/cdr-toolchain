import type { V2ConceptCode, V2Patient } from "./types.js";

export interface FormResponse {
  concept_code: V2ConceptCode;
  value_type: "numeric" | "text" | "coded";
  numeric_value: number | null;
  text_value: string | null;
  coded_value: string | null;
  ordinal: number;
  raw_value: Record<string, unknown>;
}

export interface FormSubmission {
  external_ref: string;
  source_system: "disa";
  related_request_id: string | null;
  form_code: string | null;
  patient: V2Patient;
  facility_code: V2ConceptCode | null;
  submitted_at: string | null;
  responses: FormResponse[];
}

export interface FormSubmissionPayload {
  submission: FormSubmission;
}

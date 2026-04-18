import { describe, it, expect } from "vitest";
import {
  createDiagnosisSchema,
  updateDiagnosisSchema,
  diagnosisStatusSchema,
  createAllergySchema,
  updateAllergySchema,
  allergySeveritySchema,
  allergyVerificationStatusSchema,
  patientAllergyStatusSchema,
} from "../clinical-data.js";

// ─── Diagnosis Validators ──────────────────────────────────────

describe("createDiagnosisSchema", () => {
  const validDiagnosis = {
    patient_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    icd10_code: "C50.9",
    description: "Breast cancer, unspecified",
    status: "active" as const,
  };

  it("accepts valid diagnosis with required fields", () => {
    const result = createDiagnosisSchema.safeParse(validDiagnosis);
    expect(result.success).toBe(true);
  });

  it("accepts valid diagnosis with all optional fields", () => {
    const result = createDiagnosisSchema.safeParse({
      ...validDiagnosis,
      onset_date: "2024-01-15",
      snomed_code: "254837009",
    });
    expect(result.success).toBe(true);
  });

  it("defaults status to active", () => {
    const { status, ...withoutStatus } = validDiagnosis;
    const result = createDiagnosisSchema.safeParse(withoutStatus);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
    }
  });

  it("rejects missing patient_id", () => {
    const { patient_id, ...rest } = validDiagnosis;
    const result = createDiagnosisSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects invalid patient_id (not UUID)", () => {
    const result = createDiagnosisSchema.safeParse({
      ...validDiagnosis,
      patient_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid ICD-10 code", () => {
    const invalidCodes = ["abc", "123", "C5", "c50.9"];
    for (const code of invalidCodes) {
      const result = createDiagnosisSchema.safeParse({
        ...validDiagnosis,
        icd10_code: code,
      });
      expect(result.success, `Expected "${code}" to fail`).toBe(false);
    }
  });

  it("accepts valid ICD-10 codes", () => {
    const validCodes = ["C50", "A01", "C50.9", "C50.911"];
    for (const code of validCodes) {
      const result = createDiagnosisSchema.safeParse({
        ...validDiagnosis,
        icd10_code: code,
      });
      expect(result.success, `Expected "${code}" to pass`).toBe(true);
    }
  });

  it("rejects empty description", () => {
    const result = createDiagnosisSchema.safeParse({
      ...validDiagnosis,
      description: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects description exceeding 2000 chars", () => {
    const result = createDiagnosisSchema.safeParse({
      ...validDiagnosis,
      description: "X".repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid onset_date format", () => {
    const result = createDiagnosisSchema.safeParse({
      ...validDiagnosis,
      onset_date: "01/15/2024",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid diagnosis statuses", () => {
    for (const status of ["active", "chronic", "resolved"]) {
      const result = diagnosisStatusSchema.safeParse(status);
      expect(result.success, `Expected status "${status}" to pass`).toBe(true);
    }
  });

  it("rejects invalid diagnosis status", () => {
    const result = diagnosisStatusSchema.safeParse("pending");
    expect(result.success).toBe(false);
  });
});

describe("updateDiagnosisSchema", () => {
  it("accepts partial update with status only", () => {
    const result = updateDiagnosisSchema.safeParse({ status: "resolved" });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with description only", () => {
    const result = updateDiagnosisSchema.safeParse({ description: "Updated description" });
    expect(result.success).toBe(true);
  });

  it("accepts empty object (no updates)", () => {
    const result = updateDiagnosisSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects invalid status value", () => {
    const result = updateDiagnosisSchema.safeParse({ status: "invalid" });
    expect(result.success).toBe(false);
  });
});

// ─── Allergy Validators ────────────────────────────────────────

describe("createAllergySchema", () => {
  const validAllergy = {
    patient_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    allergen: "Penicillin",
    reaction: "Hives and swelling",
    severity: "moderate" as const,
  };

  it("accepts valid allergy with all required fields", () => {
    const result = createAllergySchema.safeParse(validAllergy);
    expect(result.success).toBe(true);
  });

  it("rejects missing allergen", () => {
    const { allergen, ...rest } = validAllergy;
    const result = createAllergySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects empty allergen", () => {
    const result = createAllergySchema.safeParse({
      ...validAllergy,
      allergen: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects allergen exceeding 200 chars", () => {
    const result = createAllergySchema.safeParse({
      ...validAllergy,
      allergen: "A".repeat(201),
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing reaction", () => {
    const { reaction, ...rest } = validAllergy;
    const result = createAllergySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("rejects reaction exceeding 500 chars", () => {
    const result = createAllergySchema.safeParse({
      ...validAllergy,
      reaction: "R".repeat(501),
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing severity", () => {
    const { severity, ...rest } = validAllergy;
    const result = createAllergySchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it("accepts all valid severity levels", () => {
    for (const severity of ["mild", "moderate", "severe", "critical"]) {
      const result = allergySeveritySchema.safeParse(severity);
      expect(result.success, `Expected severity "${severity}" to pass`).toBe(true);
    }
  });

  it("rejects invalid severity value", () => {
    const result = allergySeveritySchema.safeParse("extreme");
    expect(result.success).toBe(false);
  });

  it("rejects invalid patient_id", () => {
    const result = createAllergySchema.safeParse({
      ...validAllergy,
      patient_id: "not-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("defaults verification_status to unconfirmed", () => {
    const result = createAllergySchema.safeParse(validAllergy);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verification_status).toBe("unconfirmed");
    }
  });

  it("accepts explicit verification_status", () => {
    const result = createAllergySchema.safeParse({
      ...validAllergy,
      verification_status: "confirmed",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.verification_status).toBe("confirmed");
    }
  });

  it("rejects invalid verification_status", () => {
    const result = createAllergySchema.safeParse({
      ...validAllergy,
      verification_status: "invalid",
    });
    expect(result.success).toBe(false);
  });
});

describe("updateAllergySchema", () => {
  it("accepts partial update with severity only", () => {
    const result = updateAllergySchema.safeParse({ severity: "severe" });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with reaction only", () => {
    const result = updateAllergySchema.safeParse({ reaction: "Updated reaction" });
    expect(result.success).toBe(true);
  });

  it("accepts partial update with verification_status only", () => {
    const result = updateAllergySchema.safeParse({ verification_status: "confirmed" });
    expect(result.success).toBe(true);
  });

  it("accepts empty object (no updates)", () => {
    const result = updateAllergySchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it("rejects invalid severity value", () => {
    const result = updateAllergySchema.safeParse({ severity: "invalid" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid verification_status value", () => {
    const result = updateAllergySchema.safeParse({ verification_status: "maybe" });
    expect(result.success).toBe(false);
  });
});

// ─── Allergy Verification Status ──────────────────────────────

describe("allergyVerificationStatusSchema", () => {
  it("accepts all valid verification statuses", () => {
    for (const status of ["confirmed", "unconfirmed", "entered_in_error", "refuted"]) {
      const result = allergyVerificationStatusSchema.safeParse(status);
      expect(result.success, `Expected verification status "${status}" to pass`).toBe(true);
    }
  });

  it("rejects invalid verification status", () => {
    const result = allergyVerificationStatusSchema.safeParse("pending");
    expect(result.success).toBe(false);
  });
});

// ─── Patient Allergy Status ───────────────────────────────────

describe("patientAllergyStatusSchema", () => {
  it("accepts all valid patient allergy statuses", () => {
    for (const status of ["nkda", "unknown", "has_allergies"]) {
      const result = patientAllergyStatusSchema.safeParse(status);
      expect(result.success, `Expected allergy status "${status}" to pass`).toBe(true);
    }
  });

  it("rejects invalid patient allergy status", () => {
    const result = patientAllergyStatusSchema.safeParse("none");
    expect(result.success).toBe(false);
  });
});

// ─── Allergy Override Schema (issue #233) ─────────────────────

import {
  allergyOverrideReasonSchema,
  overrideAllergyFlagSchema,
} from "../clinical-data.js";

const VALID_FLAG_ID = "11111111-1111-4111-8111-111111111111";
const VALID_ALLERGY_ID = "22222222-2222-4222-8222-222222222222";
const VALID_JUSTIFICATION =
  "Patient tolerated amoxicillin twice since the penicillin allergy was documented in 2018.";

describe("allergyOverrideReasonSchema", () => {
  it("accepts all six structured override reasons", () => {
    for (const reason of [
      "mild_reaction_ok",
      "patient_tolerated_previously",
      "benefit_exceeds_risk",
      "desensitized",
      "misdiagnosed_allergy",
      "other",
    ]) {
      const result = allergyOverrideReasonSchema.safeParse(reason);
      expect(result.success, `Expected reason "${reason}" to pass`).toBe(true);
    }
  });

  it("rejects unrecognised reason values", () => {
    expect(allergyOverrideReasonSchema.safeParse("clinician_judgment").success).toBe(false);
    expect(allergyOverrideReasonSchema.safeParse("").success).toBe(false);
    expect(allergyOverrideReasonSchema.safeParse(null).success).toBe(false);
  });
});

describe("overrideAllergyFlagSchema", () => {
  const base = {
    flag_id: VALID_FLAG_ID,
    allergy_id: VALID_ALLERGY_ID,
    override_reason: "patient_tolerated_previously" as const,
    clinical_justification: VALID_JUSTIFICATION,
  };

  it("accepts a fully-populated override", () => {
    const result = overrideAllergyFlagSchema.safeParse(base);
    expect(result.success).toBe(true);
  });

  it("accepts an override without allergy_id (contraindication-only)", () => {
    const { allergy_id: _ignored, ...withoutAllergy } = base;
    const result = overrideAllergyFlagSchema.safeParse(withoutAllergy);
    expect(result.success).toBe(true);
  });

  it("rejects empty clinical_justification", () => {
    const result = overrideAllergyFlagSchema.safeParse({
      ...base,
      clinical_justification: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects whitespace-only clinical_justification", () => {
    const result = overrideAllergyFlagSchema.safeParse({
      ...base,
      clinical_justification: "         ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects justification shorter than 10 characters", () => {
    const result = overrideAllergyFlagSchema.safeParse({
      ...base,
      clinical_justification: "ok",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-UUID flag_id", () => {
    const result = overrideAllergyFlagSchema.safeParse({
      ...base,
      flag_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects unrecognised override_reason", () => {
    const result = overrideAllergyFlagSchema.safeParse({
      ...base,
      override_reason: "clinician_felt_like_it",
    });
    expect(result.success).toBe(false);
  });

  it("rejects justification exceeding max length", () => {
    const result = overrideAllergyFlagSchema.safeParse({
      ...base,
      clinical_justification: "x".repeat(2001),
    });
    expect(result.success).toBe(false);
  });
});

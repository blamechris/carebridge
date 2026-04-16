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

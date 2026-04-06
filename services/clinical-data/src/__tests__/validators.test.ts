import { describe, it, expect } from "vitest";
import {
  createVitalSchema,
  vitalTypeSchema,
  icd10CodeSchema,
  createLabPanelSchema,
} from "@carebridge/validators";

const VALID_UUID = "11111111-1111-1111-1111-111111111111";

describe("createVitalSchema", () => {
  const validVital = {
    patient_id: VALID_UUID,
    recorded_at: "2026-03-15T10:30:00.000Z",
    type: "heart_rate",
    value_primary: 72,
    unit: "bpm",
  };

  it("accepts valid vital data", () => {
    const result = createVitalSchema.safeParse(validVital);
    expect(result.success).toBe(true);
  });

  it("accepts vital with optional fields", () => {
    const result = createVitalSchema.safeParse({
      ...validVital,
      value_secondary: 60,
      notes: "Resting heart rate",
      provider_id: VALID_UUID,
      encounter_id: VALID_UUID,
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = createVitalSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects invalid patient_id format", () => {
    const result = createVitalSchema.safeParse({
      ...validVital,
      patient_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

describe("vitalTypeSchema", () => {
  it("accepts valid vital types", () => {
    const validTypes = [
      "blood_pressure", "heart_rate", "o2_sat", "temperature",
      "weight", "respiratory_rate", "pain_level", "blood_glucose",
    ];
    for (const type of validTypes) {
      expect(vitalTypeSchema.safeParse(type).success).toBe(true);
    }
  });

  it("rejects invalid vital type", () => {
    const result = vitalTypeSchema.safeParse("invalid_type");
    expect(result.success).toBe(false);
  });

  it("rejects empty string", () => {
    const result = vitalTypeSchema.safeParse("");
    expect(result.success).toBe(false);
  });
});

describe("LOINC format (test_code in lab results)", () => {
  const makeLabInput = (testCode: string) => ({
    patient_id: VALID_UUID,
    panel_name: "CBC",
    results: [
      {
        test_name: "WBC",
        test_code: testCode,
        value: 7.5,
        unit: "10^3/uL",
      },
    ],
  });

  it("accepts valid LOINC code 8867-4", () => {
    const result = createLabPanelSchema.safeParse(makeLabInput("8867-4"));
    expect(result.success).toBe(true);
  });

  it("accepts valid LOINC code 6690-2", () => {
    const result = createLabPanelSchema.safeParse(makeLabInput("6690-2"));
    expect(result.success).toBe(true);
  });

  it("accepts valid LOINC code 789-8", () => {
    const result = createLabPanelSchema.safeParse(makeLabInput("789-8"));
    expect(result.success).toBe(true);
  });

  it("rejects invalid LOINC code 'abc'", () => {
    const result = createLabPanelSchema.safeParse(makeLabInput("abc"));
    expect(result.success).toBe(false);
  });

  it("rejects empty string as LOINC code", () => {
    const result = createLabPanelSchema.safeParse(makeLabInput(""));
    expect(result.success).toBe(false);
  });
});

describe("icd10CodeSchema", () => {
  it("accepts valid ICD-10 code C50.911", () => {
    const result = icd10CodeSchema.safeParse("C50.911");
    expect(result.success).toBe(true);
  });

  it("accepts valid ICD-10 code without decimal (A01)", () => {
    const result = icd10CodeSchema.safeParse("A01");
    expect(result.success).toBe(true);
  });

  it("accepts valid ICD-10 code with single digit after dot (I26.9)", () => {
    const result = icd10CodeSchema.safeParse("I26.9");
    expect(result.success).toBe(true);
  });

  it("rejects invalid ICD-10 code '123'", () => {
    const result = icd10CodeSchema.safeParse("123");
    expect(result.success).toBe(false);
  });

  it("rejects lowercase ICD-10 code", () => {
    const result = icd10CodeSchema.safeParse("c50.911");
    expect(result.success).toBe(false);
  });

  it("rejects empty string", () => {
    const result = icd10CodeSchema.safeParse("");
    expect(result.success).toBe(false);
  });
});

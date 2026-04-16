import { describe, it, expect } from "vitest";
import {
  icd10CodeSchema,
  createVitalSchema,
  vitalTypeSchema,
  createMedicationSchema,
  medRouteSchema,
  medStatusSchema,
  createLabPanelSchema,
  createProcedureSchema,
} from "../clinical-data.js";

// ─── ICD-10-CM codes ────────────────────────────────────────────

describe("icd10CodeSchema", () => {
  it("validates standard ICD-10 codes", () => {
    const validCodes = ["C50", "A01", "Z00", "C50.9", "C50.91", "C50.911", "A01.1234"];
    for (const code of validCodes) {
      expect(icd10CodeSchema.safeParse(code).success, `Expected "${code}" to pass`).toBe(true);
    }
  });

  it("rejects invalid ICD-10 codes", () => {
    const invalidCodes = ["abc", "123", "C5", "C5012", "c50.9", "C50.", "C50.12345"];
    for (const code of invalidCodes) {
      expect(icd10CodeSchema.safeParse(code).success, `Expected "${code}" to fail`).toBe(false);
    }
  });
});

// ─── Vitals ─────────────────────────────────────────────────────

describe("createVitalSchema", () => {
  const validVital = {
    patient_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    recorded_at: "2024-01-15T10:30:00Z",
    type: "heart_rate" as const,
    value_primary: 72,
    unit: "bpm",
  };

  it("accepts valid vital data", () => {
    const result = createVitalSchema.safeParse(validVital);
    expect(result.success).toBe(true);
  });

  it("accepts vital with all optional fields", () => {
    const result = createVitalSchema.safeParse({
      ...validVital,
      value_secondary: 80,
      notes: "Resting heart rate",
      provider_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      encounter_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    const result = createVitalSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects invalid patient_id (not UUID)", () => {
    const result = createVitalSchema.safeParse({
      ...validVital,
      patient_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid recorded_at (not ISO datetime)", () => {
    const result = createVitalSchema.safeParse({
      ...validVital,
      recorded_at: "2024-01-15",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid vital type", () => {
    const result = createVitalSchema.safeParse({
      ...validVital,
      type: "invalid_type",
    });
    expect(result.success).toBe(false);
  });

  it("accepts all valid vital types", () => {
    const types = [
      "blood_pressure", "heart_rate", "o2_sat", "temperature",
      "weight", "respiratory_rate", "pain_level", "blood_glucose",
    ];
    for (const type of types) {
      const result = vitalTypeSchema.safeParse(type);
      expect(result.success, `Expected vital type "${type}" to pass`).toBe(true);
    }
  });
});

// ─── Medications ────────────────────────────────────────────────

describe("createMedicationSchema", () => {
  const validMed = {
    patient_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    name: "Warfarin",
  };

  it("accepts valid medication with minimal fields", () => {
    const result = createMedicationSchema.safeParse(validMed);
    expect(result.success).toBe(true);
  });

  it("defaults status to 'active'", () => {
    const result = createMedicationSchema.safeParse(validMed);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("active");
    }
  });

  it("accepts all valid routes", () => {
    const routes = ["oral", "IV", "IM", "subcutaneous", "topical", "inhaled", "rectal", "other"];
    for (const route of routes) {
      const result = medRouteSchema.safeParse(route);
      expect(result.success, `Expected route "${route}" to pass`).toBe(true);
    }
  });

  it("accepts all valid statuses", () => {
    for (const status of ["active", "discontinued", "completed", "held"]) {
      const result = medStatusSchema.safeParse(status);
      expect(result.success, `Expected status "${status}" to pass`).toBe(true);
    }
  });

  it("accepts 'held' status on create payload (unblocks ONCO-ANTICOAG-HELD rule)", () => {
    const result = createMedicationSchema.safeParse({
      patient_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      name: "Enoxaparin",
      status: "held",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("held");
    }
  });

  it("rejects unknown status values", () => {
    const result = medStatusSchema.safeParse("paused");
    expect(result.success).toBe(false);
  });

  it("rejects negative dose_amount", () => {
    const result = createMedicationSchema.safeParse({
      ...validMed,
      dose_amount: -5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects zero dose_amount", () => {
    const result = createMedicationSchema.safeParse({
      ...validMed,
      dose_amount: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ─── Lab Panels ─────────────────────────────────────────────────

describe("createLabPanelSchema", () => {
  const validPanel = {
    patient_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    panel_name: "CBC",
    results: [
      {
        test_name: "WBC",
        test_code: "6690-2",
        value: 7.5,
        unit: "10^3/uL",
      },
    ],
  };

  it("accepts valid lab panel with results", () => {
    const result = createLabPanelSchema.safeParse(validPanel);
    expect(result.success).toBe(true);
  });

  it("requires at least one result", () => {
    const result = createLabPanelSchema.safeParse({
      ...validPanel,
      results: [],
    });
    expect(result.success).toBe(false);
  });

  it("validates test_code as LOINC format (digits-digit)", () => {
    const validCodes = ["6690-2", "8867-4", "1-1", "12345-6"];
    for (const code of validCodes) {
      const result = createLabPanelSchema.safeParse({
        ...validPanel,
        results: [{ ...validPanel.results[0], test_code: code }],
      });
      expect(result.success, `Expected LOINC "${code}" to pass`).toBe(true);
    }
  });

  it("rejects invalid LOINC codes", () => {
    const invalidCodes = ["abc", "6690", "6690-", "6690-22", "A123-4"];
    for (const code of invalidCodes) {
      const result = createLabPanelSchema.safeParse({
        ...validPanel,
        results: [{ ...validPanel.results[0], test_code: code }],
      });
      expect(result.success, `Expected LOINC "${code}" to fail`).toBe(false);
    }
  });

  it("requires test_code on each result", () => {
    const result = createLabPanelSchema.safeParse({
      ...validPanel,
      results: [
        {
          test_name: "WBC",
          value: 7.5,
          unit: "10^3/uL",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional reference ranges and flags", () => {
    const result = createLabPanelSchema.safeParse({
      ...validPanel,
      results: [
        {
          ...validPanel.results[0],
          reference_low: 4.5,
          reference_high: 11.0,
          flag: "H",
          notes: "Elevated",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("validates flag enum values", () => {
    for (const flag of ["H", "L", "critical"]) {
      const result = createLabPanelSchema.safeParse({
        ...validPanel,
        results: [{ ...validPanel.results[0], flag }],
      });
      expect(result.success, `Expected flag "${flag}" to pass`).toBe(true);
    }

    const result = createLabPanelSchema.safeParse({
      ...validPanel,
      results: [{ ...validPanel.results[0], flag: "invalid" }],
    });
    expect(result.success).toBe(false);
  });
});

// ─── Procedures ─────────────────────────────────────────────────

describe("createProcedureSchema", () => {
  it("accepts valid procedure with ICD-10 codes", () => {
    const result = createProcedureSchema.safeParse({
      patient_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      name: "Port placement",
      icd10_codes: ["C50.911", "Z45.2"],
    });
    expect(result.success).toBe(true);
  });

  it("rejects procedure with invalid ICD-10 codes in array", () => {
    const result = createProcedureSchema.safeParse({
      patient_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      name: "Port placement",
      icd10_codes: ["C50.911", "abc"],
    });
    expect(result.success).toBe(false);
  });

  it("defaults status to 'scheduled'", () => {
    const result = createProcedureSchema.safeParse({
      patient_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      name: "Port placement",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.status).toBe("scheduled");
    }
  });
});

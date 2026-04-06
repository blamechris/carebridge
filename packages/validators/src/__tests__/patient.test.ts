import { describe, it, expect } from "vitest";
import { createPatientSchema, updatePatientSchema } from "../patient.js";

describe("createPatientSchema", () => {
  it("accepts valid patient data with all fields", () => {
    const input = {
      name: "Jane Doe",
      date_of_birth: "1990-05-15",
      biological_sex: "female" as const,
      diagnosis: "Breast cancer stage II",
      notes: "Follow-up in 2 weeks",
      mrn: "MRN-001234",
      insurance_id: "INS-9876",
      emergency_contact_name: "John Doe",
      emergency_contact_phone: "+1-555-0100",
      primary_provider_id: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    };

    const result = createPatientSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it("accepts valid patient data with only required fields", () => {
    const result = createPatientSchema.safeParse({ name: "John Smith" });
    expect(result.success).toBe(true);
  });

  it("rejects missing name (required field)", () => {
    const result = createPatientSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects empty name string", () => {
    const result = createPatientSchema.safeParse({ name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name exceeding 200 characters", () => {
    const result = createPatientSchema.safeParse({ name: "A".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("requires date_of_birth in YYYY-MM-DD format, not datetime", () => {
    const validDate = createPatientSchema.safeParse({
      name: "Test",
      date_of_birth: "1990-05-15",
    });
    expect(validDate.success).toBe(true);

    const datetimeFormat = createPatientSchema.safeParse({
      name: "Test",
      date_of_birth: "1990-05-15T00:00:00Z",
    });
    expect(datetimeFormat.success).toBe(false);
  });

  it("rejects invalid date format for date_of_birth", () => {
    const badFormats = ["05/15/1990", "1990-5-15", "not-a-date", "19900515"];
    for (const dob of badFormats) {
      const result = createPatientSchema.safeParse({
        name: "Test",
        date_of_birth: dob,
      });
      expect(result.success, `Expected "${dob}" to fail`).toBe(false);
    }
  });

  it("rejects invalid biological_sex value", () => {
    const result = createPatientSchema.safeParse({
      name: "Test",
      biological_sex: "other",
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid biological_sex values", () => {
    for (const sex of ["male", "female", "unknown"]) {
      const result = createPatientSchema.safeParse({
        name: "Test",
        biological_sex: sex,
      });
      expect(result.success, `Expected "${sex}" to pass`).toBe(true);
    }
  });

  it("rejects invalid UUID for primary_provider_id", () => {
    const result = createPatientSchema.safeParse({
      name: "Test",
      primary_provider_id: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("enforces max length on diagnosis (2000 chars)", () => {
    const result = createPatientSchema.safeParse({
      name: "Test",
      diagnosis: "X".repeat(2001),
    });
    expect(result.success).toBe(false);
  });

  it("enforces max length on notes (5000 chars)", () => {
    const result = createPatientSchema.safeParse({
      name: "Test",
      notes: "X".repeat(5001),
    });
    expect(result.success).toBe(false);
  });
});

describe("updatePatientSchema", () => {
  it("accepts partial updates (all fields optional)", () => {
    const result = updatePatientSchema.safeParse({ diagnosis: "Updated dx" });
    expect(result.success).toBe(true);
  });

  it("accepts empty object (no updates)", () => {
    const result = updatePatientSchema.safeParse({});
    expect(result.success).toBe(true);
  });
});

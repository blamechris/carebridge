import { describe, it, expect } from "vitest";
import {
  getDiagnosisEducation,
  getMedicationEducation,
  DIAGNOSIS_EDUCATION_TABLE,
  MEDICATION_EDUCATION_TABLE,
  type EducationContent,
} from "../patient-education.js";

describe("getDiagnosisEducation (#328)", () => {
  it("returns the E11 card for a type-2 diabetes ICD-10 match", () => {
    const e = getDiagnosisEducation("E11.9", "Type 2 diabetes mellitus");
    expect(e?.title).toMatch(/Type 2 Diabetes/);
    expect(e?.when_to_contact_provider.length).toBeGreaterThan(0);
  });

  it("matches the longest prefix first (E11.9 → E11, not E)", () => {
    const e = getDiagnosisEducation("E11.9", null);
    expect(e?.title).toMatch(/Type 2/);
    const e1 = getDiagnosisEducation("E10.65", null);
    expect(e1?.title).toMatch(/Type 1/);
  });

  it("falls back to description keywords when ICD-10 is absent", () => {
    expect(getDiagnosisEducation(null, "Essential hypertension")?.title).toMatch(/High Blood Pressure/);
    expect(getDiagnosisEducation(null, "Atrial fibrillation")?.title).toMatch(/Atrial Fibrillation/);
    expect(getDiagnosisEducation(null, "Congestive heart failure")?.title).toMatch(/Heart Failure/);
    expect(getDiagnosisEducation(null, "Mild asthma")?.title).toMatch(/Asthma/);
  });

  it("returns null for diagnoses we don't have content for", () => {
    expect(getDiagnosisEducation("Z99.0", "Some niche status")).toBeNull();
    expect(getDiagnosisEducation(null, "morgellons")).toBeNull();
    expect(getDiagnosisEducation(null, null)).toBeNull();
  });

  it("is case-insensitive on ICD-10", () => {
    expect(getDiagnosisEducation("e11", null)?.title).toMatch(/Type 2/);
    expect(getDiagnosisEducation("i48", null)?.title).toMatch(/Atrial/);
  });
});

describe("getMedicationEducation (#328)", () => {
  it("returns the warfarin card for the generic name", () => {
    expect(getMedicationEducation("warfarin")?.title).toMatch(/Warfarin/);
  });

  it("resolves brand → generic via alias map", () => {
    expect(getMedicationEducation("Coumadin")?.title).toMatch(/Warfarin/);
    expect(getMedicationEducation("Eliquis")?.title).toMatch(/Apixaban/);
    expect(getMedicationEducation("Lipitor")?.title).toMatch(/Atorvastatin/);
    expect(getMedicationEducation("Zoloft")?.title).toMatch(/Sertraline/);
    expect(getMedicationEducation("Synthroid")?.title).toMatch(/Levothyroxine/);
  });

  it("strips strength suffix ('lisinopril 10mg' → lisinopril)", () => {
    expect(getMedicationEducation("Lisinopril 10mg")?.title).toMatch(/Lisinopril/);
  });

  it("returns null for unknown drugs", () => {
    expect(getMedicationEducation("zolbidopride")).toBeNull();
    expect(getMedicationEducation(null)).toBeNull();
    expect(getMedicationEducation("")).toBeNull();
  });
});

describe("content invariants (#328)", () => {
  const allEntries: Array<[string, EducationContent]> = [
    ...Object.entries(DIAGNOSIS_EDUCATION_TABLE),
    ...Object.entries(MEDICATION_EDUCATION_TABLE),
  ];

  it("every entry has title, summary, self_care, and when_to_contact_provider", () => {
    for (const [key, c] of allEntries) {
      expect(c.title, `entry ${key}`).toMatch(/\S/);
      expect(c.summary, `entry ${key}`).toMatch(/\S/);
      expect(c.self_care.length, `entry ${key}`).toBeGreaterThan(0);
      expect(c.when_to_contact_provider.length, `entry ${key}`).toBeGreaterThan(0);
    }
  });

  it("summaries stay short (under 500 chars) so a patient sees the full text at a glance", () => {
    for (const [key, c] of allEntries) {
      expect(c.summary.length, `entry ${key}`).toBeLessThanOrEqual(500);
    }
  });

  it("self_care and when_to_contact_provider items stay short and bullet-sized", () => {
    for (const [key, c] of allEntries) {
      for (const item of c.self_care) {
        expect(item.length, `self_care in ${key}: "${item}"`).toBeLessThanOrEqual(300);
      }
      for (const item of c.when_to_contact_provider) {
        expect(item.length, `contact in ${key}: "${item}"`).toBeLessThanOrEqual(300);
      }
    }
  });

  it("covers the most common adult chronic conditions", () => {
    for (const prefix of ["E11", "I10", "I48", "I50", "J45", "J44", "N18", "F32"]) {
      expect(DIAGNOSIS_EDUCATION_TABLE[prefix]).toBeDefined();
    }
  });

  it("covers the most common outpatient medications", () => {
    for (const drug of [
      "warfarin",
      "apixaban",
      "metformin",
      "lisinopril",
      "atorvastatin",
      "aspirin",
    ]) {
      expect(MEDICATION_EDUCATION_TABLE[drug]).toBeDefined();
    }
  });
});

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

  it("covers the #948 batch (CAD, stroke, lipids, thyroid, GERD, OA, migraine)", () => {
    expect(getDiagnosisEducation("I25.10", null)?.title).toMatch(/Coronary Artery/);
    expect(getDiagnosisEducation("I63.9", null)?.title).toMatch(/Stroke/);
    expect(getDiagnosisEducation("E78.5", null)?.title).toMatch(/Cholesterol/);
    expect(getDiagnosisEducation("E03.9", null)?.title).toMatch(/Underactive Thyroid/);
    expect(getDiagnosisEducation("K21.9", null)?.title).toMatch(/Acid Reflux/);
    expect(getDiagnosisEducation("M17.11", null)?.title).toMatch(/Knee Osteoarthritis/);
    expect(getDiagnosisEducation("M19.90", null)?.title).toMatch(/Osteoarthritis/);
    expect(getDiagnosisEducation("G43.909", null)?.title).toMatch(/Migraine/);
  });

  it("#948 entries also resolve via description keyword fallback", () => {
    expect(getDiagnosisEducation(null, "Coronary artery disease")?.title).toMatch(/Coronary Artery/);
    expect(getDiagnosisEducation(null, "History of ischemic stroke")?.title).toMatch(/Stroke/);
    expect(getDiagnosisEducation(null, "Mixed hyperlipidemia")?.title).toMatch(/Cholesterol/);
    expect(getDiagnosisEducation(null, "Hypothyroidism")?.title).toMatch(/Underactive Thyroid/);
    expect(getDiagnosisEducation(null, "GERD")?.title).toMatch(/Acid Reflux/);
    expect(getDiagnosisEducation(null, "Knee osteoarthritis")?.title).toMatch(/Knee Osteoarthritis/);
    expect(getDiagnosisEducation(null, "Osteoarthritis of the hand")?.title).toMatch(/Osteoarthritis/);
    expect(getDiagnosisEducation(null, "Chronic migraine")?.title).toMatch(/Migraine/);
  });

  it("does not mis-route non-ischemic stroke or non-GERD reflux to the #948 cards", () => {
    // `heat stroke` (T67.0) and `sun stroke` are environmental heat illness, not ischemic stroke.
    // The I63 keyword fallback must not catch them via a bare `\bstroke\b`.
    expect(getDiagnosisEducation(null, "Heat stroke")).toBeNull();
    expect(getDiagnosisEducation(null, "Sun stroke")).toBeNull();
    // `vesicoureteral reflux` (N13.7) and `laryngopharyngeal reflux` (R49.x / J38.x) are not GERD.
    // The K21 keyword fallback must not catch them via a bare `\breflux\b`.
    expect(getDiagnosisEducation(null, "Vesicoureteral reflux")).toBeNull();
    expect(getDiagnosisEducation(null, "Laryngopharyngeal reflux")).toBeNull();
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
    for (const prefix of [
      "E03",
      "E11",
      "E78",
      "F32",
      "G43",
      "I10",
      "I25",
      "I48",
      "I50",
      "I63",
      "J44",
      "J45",
      "K21",
      "M17",
      "M19",
      "N18",
    ]) {
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

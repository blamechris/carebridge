/**
 * Iodine vs iodinated-contrast disambiguation (issue #934).
 *
 * Charted "iodine allergy" is usually topical Betadine irritation or the
 * shellfish-iodine folk belief, not an IV radiocontrast reaction. The
 * cross-reactivity table splits the two so:
 *  - "iodinated contrast" allergen → contrast med → critical (default)
 *  - "iodine" / "Betadine" allergen → contrast med → warning (advisory)
 */
import { describe, it, expect } from "vitest";
import { checkAllergyMedication } from "./allergy-medication.js";
import type { PatientContext } from "./cross-specialty.js";

function ctxWithAllergyAndMed(
  allergen: string,
  med: string,
  severity: "severe" | "moderate" | "mild" = "severe",
): PatientContext {
  return {
    active_diagnoses: [],
    active_diagnosis_codes: [],
    active_medications: [med],
    new_symptoms: [],
    care_team_specialties: [],
    allergies: [
      {
        id: "00000000-0000-4000-8000-000000000001",
        allergen,
        severity,
        reaction: "rash",
      },
    ],
  };
}

describe("iodine vs iodinated-contrast disambiguation (#934)", () => {
  it("iodinated contrast allergy + iohexol prescription → critical", () => {
    const ctx = ctxWithAllergyAndMed(
      "Iodinated contrast",
      "Iohexol 350 mg/mL IV",
      "severe",
    );
    const flags = checkAllergyMedication(ctx);
    // Direct alias match (iohexol is in the "iodinated contrast" alias list)
    // yields an ALLERGY-MED-DIRECT rule_id at critical severity for a
    // severe charted allergy.
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]!.severity).toBe("critical");
  });

  it("bare 'iodine' allergy + iohexol prescription → warning (not critical)", () => {
    const ctx = ctxWithAllergyAndMed("Iodine", "Iohexol 350 mg/mL IV", "severe");
    const flags = checkAllergyMedication(ctx);
    const advisoryFlag = flags.find((f) =>
      f.rule_id.includes("iodine-contrast-advisory"),
    );
    expect(advisoryFlag).toBeDefined();
    expect(advisoryFlag!.severity).toBe("warning");
  });

  it("'Betadine' allergy + iohexol → warning advisory (topical ≠ IV)", () => {
    const ctx = ctxWithAllergyAndMed("Betadine", "Iohexol 350 mg/mL IV", "severe");
    const flags = checkAllergyMedication(ctx);
    const advisoryFlag = flags.find((f) =>
      f.rule_id.includes("iodine-contrast-advisory"),
    );
    expect(advisoryFlag).toBeDefined();
    expect(advisoryFlag!.severity).toBe("warning");
  });

  it("'Povidone-iodine' allergy + iopamidol → warning advisory", () => {
    const ctx = ctxWithAllergyAndMed(
      "Povidone-iodine",
      "Iopamidol 300 IV",
      "moderate",
    );
    const flags = checkAllergyMedication(ctx);
    const advisoryFlag = flags.find((f) =>
      f.rule_id.includes("iodine-contrast-advisory"),
    );
    expect(advisoryFlag).toBeDefined();
    expect(advisoryFlag!.severity).toBe("warning");
  });

  it("iodine allergy + oral (non-contrast) medication → no contrast flag", () => {
    const ctx = ctxWithAllergyAndMed("Iodine", "Amoxicillin 500 mg PO", "severe");
    const flags = checkAllergyMedication(ctx);
    const contrastFlag = flags.find(
      (f) =>
        f.rule_id.includes("iodinated-contrast") ||
        f.rule_id.includes("iodine-contrast-advisory"),
    );
    expect(contrastFlag).toBeUndefined();
  });
});

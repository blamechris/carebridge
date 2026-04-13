import { describe, it, expect, vi } from "vitest";

// Mock the workspace dependencies before importing the rules
vi.mock("@carebridge/shared-types", () => ({
  COMMON_LAB_TESTS: {
    Potassium: { unit: "mEq/L", typical_low: 3.5, typical_high: 5.0 },
    Troponin: { unit: "ng/mL", typical_low: 0, typical_high: 0.04 },
    WBC: { unit: "K/uL", typical_low: 4.5, typical_high: 11.0 },
  },
}));

vi.mock("@carebridge/medical-logic", () => ({
  VITAL_DANGER_ZONES: {
    heart_rate: { min: 20, max: 300, criticalLow: 40, criticalHigh: 200 },
    o2_sat: { min: 50, max: 100, criticalLow: 85 },
    temperature: { min: 85, max: 115, criticalLow: 95, criticalHigh: 104 },
    blood_pressure: { min: 60, max: 250, criticalLow: 70, criticalHigh: 180 },
    blood_glucose: { min: 10, max: 800, criticalLow: 54, criticalHigh: 400 },
  },
  isCriticalVital: (type: string, value: number) => {
    const zones: Record<string, { criticalLow?: number; criticalHigh?: number }> = {
      heart_rate: { criticalLow: 40, criticalHigh: 200 },
      o2_sat: { criticalLow: 85 },
      temperature: { criticalLow: 95, criticalHigh: 104 },
      blood_pressure: { criticalLow: 70, criticalHigh: 180 },
      blood_glucose: { criticalLow: 54, criticalHigh: 400 },
    };
    const zone = zones[type];
    if (!zone) return false;
    if (zone.criticalLow !== undefined && value <= zone.criticalLow) return true;
    if (zone.criticalHigh !== undefined && value >= zone.criticalHigh) return true;
    return false;
  },
}));

import { checkCriticalValues } from "../rules/critical-values.js";
import { checkCrossSpecialtyPatterns, type PatientContext } from "../rules/cross-specialty.js";
import { checkDrugInteractions } from "../rules/drug-interactions.js";

describe("checkCriticalValues", () => {
  it("flags critically high heart rate", () => {
    const flags = checkCriticalValues({
      id: "evt-1",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "heart_rate", value_primary: 210, unit: "bpm" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.category).toBe("critical-value");
    expect(flags[0]!.rule_id).toBe("CRITICAL-VITAL-HEART_RATE");
  });

  it("flags critically low O2 saturation", () => {
    const flags = checkCriticalValues({
      id: "evt-2",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "o2_sat", value_primary: 80, unit: "%" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.summary).toContain("low");
  });

  it("returns empty for normal vital values", () => {
    const flags = checkCriticalValues({
      id: "evt-3",
      type: "vital.created",
      patient_id: "p-1",
      data: { type: "heart_rate", value_primary: 72, unit: "bpm" },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(0);
  });

  it("flags critical lab results with explicit critical flag", () => {
    const flags = checkCriticalValues({
      id: "evt-4",
      type: "lab.resulted",
      patient_id: "p-1",
      data: {
        results: [
          {
            test_name: "Potassium",
            value: 7.2,
            unit: "mEq/L",
            reference_low: 3.5,
            reference_high: 5.0,
            flag: "critical",
          },
        ],
      },
      timestamp: new Date().toISOString(),
    });

    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("critical");
    expect(flags[0]!.rule_id).toBe("CRITICAL-LAB-POTASSIUM");
  });
});

describe("checkCrossSpecialtyPatterns", () => {
  it("flags DVT scenario: cancer + VTE + headache → stroke risk (ONCO-VTE-NEURO-001)", () => {
    const ctx: PatientContext = {
      active_diagnoses: [
        "Pancreatic adenocarcinoma",
        "Deep vein thrombosis, right lower extremity",
      ],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: ["Enoxaparin 40mg SQ daily"],
      new_symptoms: ["New onset severe headache"],
      care_team_specialties: ["hematology", "oncology"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const dvtFlag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(dvtFlag).toBeDefined();
    expect(dvtFlag!.severity).toBe("critical");
    expect(dvtFlag!.category).toBe("cross-specialty");
    expect(dvtFlag!.notify_specialties).toContain("neurology");
  });

  it("does not flag when only cancer + VTE but no neuro symptom", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Lung cancer", "DVT"],
      active_diagnosis_codes: ["C34.90", "I82.401"],
      active_medications: [],
      new_symptoms: ["nausea"],
      care_team_specialties: ["oncology"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const dvtFlag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(dvtFlag).toBeUndefined();
  });

  it("returns empty for benign patient context", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Seasonal allergies"],
      active_diagnosis_codes: ["J30.1"],
      active_medications: ["Cetirizine 10mg"],
      new_symptoms: ["runny nose"],
      care_team_specialties: ["primary_care"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    expect(flags).toHaveLength(0);
  });

  it("flags anticoagulant + bleeding symptom (ANTICOAG-BLEED-001)", () => {
    const ctx: PatientContext = {
      active_diagnoses: [],
      active_diagnosis_codes: [],
      active_medications: ["Warfarin 5mg daily"],
      new_symptoms: ["blood in stool"],
      care_team_specialties: ["primary_care"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const bleedFlag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(bleedFlag).toBeDefined();
    expect(bleedFlag!.severity).toBe("critical");
  });
});


  it("flags anticoagulant held in VTE patient (ONCO-ANTICOAG-HELD-001)", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Deep vein thrombosis, left lower extremity"],
      active_diagnosis_codes: ["I82.402"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: ["hematology"],
      trigger_event: {
        id: "evt-held-1",
        type: "medication.updated",
        patient_id: "p-1",
        data: { name: "Enoxaparin 40mg", status: "held" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const heldFlag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(heldFlag).toBeDefined();
    expect(heldFlag!.severity).toBe("critical");
    expect(heldFlag!.category).toBe("medication-safety");
  });

  it("does not flag non-anticoagulant held in VTE patient", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Deep vein thrombosis"],
      active_diagnosis_codes: ["I82.401"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: [],
      trigger_event: {
        id: "evt-held-2",
        type: "medication.updated",
        patient_id: "p-1",
        data: { name: "Metformin 500mg", status: "held" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const heldFlag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(heldFlag).toBeUndefined();
  });

  it("does not flag anticoagulant held without VTE diagnosis", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Hypertension"],
      active_diagnosis_codes: ["I10"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: [],
      trigger_event: {
        id: "evt-held-3",
        type: "medication.updated",
        patient_id: "p-1",
        data: { name: "Warfarin 5mg", status: "discontinued" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const heldFlag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(heldFlag).toBeUndefined();
  });

  it("includes anticoag modifier in ONCO-VTE-NEURO-001 suggested action", () => {
    const ctxWithAnticoag: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "DVT"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: ["Enoxaparin 40mg SQ daily"],
      new_symptoms: ["severe headache"],
      care_team_specialties: [],
    };

    const flags = checkCrossSpecialtyPatterns(ctxWithAnticoag);
    const dvtFlag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(dvtFlag).toBeDefined();
    expect(dvtFlag!.suggested_action).toContain("hemorrhagic risk");

    const ctxNoAnticoag: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "DVT"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: [],
      new_symptoms: ["severe headache"],
      care_team_specialties: [],
    };

    const flags2 = checkCrossSpecialtyPatterns(ctxNoAnticoag);
    const dvtFlag2 = flags2.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(dvtFlag2).toBeDefined();
    expect(dvtFlag2!.suggested_action).toContain("NOT on anticoagulation");
  });
describe("checkDrugInteractions", () => {
  it("flags warfarin + NSAID interaction", () => {
    const flags = checkDrugInteractions(["Warfarin 5mg", "Ibuprofen 400mg"]);

    expect(flags.length).toBeGreaterThanOrEqual(1);
    const interaction = flags.find((f) => f.rule_id === "DI-WARFARIN-NSAID");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
  });

  it("flags SSRI + MAOI as contraindicated", () => {
    const flags = checkDrugInteractions(["Fluoxetine 20mg", "Phenelzine 15mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-SSRI-MAOI");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
  });

  it("returns empty for non-interacting medications", () => {
    const flags = checkDrugInteractions([
      "Acetaminophen 500mg",
      "Omeprazole 20mg",
      "Metformin 500mg",
    ]);

    expect(flags).toHaveLength(0);
  });

  it("does not flag the same medication against itself", () => {
    const flags = checkDrugInteractions(["Warfarin 5mg"]);

    const warfarinNsaid = flags.find((f) => f.rule_id === "DI-WARFARIN-NSAID");
    expect(warfarinNsaid).toBeUndefined();
  });

  it("flags clarithromycin + simvastatin as CRITICAL (contraindicated)", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Simvastatin 40mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
    expect(interaction!.summary).toContain("rhabdomyolysis");
  });

  it("flags clarithromycin + lovastatin as CRITICAL (contraindicated)", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Lovastatin 20mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
  });

  it("flags erythromycin + simvastatin as CRITICAL", () => {
    const flags = checkDrugInteractions(["Erythromycin 250mg", "Simvastatin 20mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
  });

  it("flags erythromycin + lovastatin as CRITICAL", () => {
    const flags = checkDrugInteractions(["Erythromycin 250mg", "Lovastatin 20mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("critical");
  });

  it("flags clarithromycin + atorvastatin as WARNING (dose reduction needed)", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Atorvastatin 40mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-WARNING");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("warning");
    expect(interaction!.summary).toContain("dose reduction");
  });

  it("flags erythromycin + atorvastatin as WARNING", () => {
    const flags = checkDrugInteractions(["Erythromycin 250mg", "Atorvastatin 20mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-WARNING");
    expect(interaction).toBeDefined();
    expect(interaction!.severity).toBe("warning");
  });

  it("does NOT flag azithromycin + simvastatin (azithromycin is safe — minimal CYP3A4 inhibition)", () => {
    const flags = checkDrugInteractions(["Azithromycin 250mg", "Simvastatin 40mg"]);

    const critical = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    const warning = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-WARNING");
    expect(critical).toBeUndefined();
    expect(warning).toBeUndefined();
  });

  it("does NOT flag clarithromycin + pravastatin (pravastatin not CYP3A4-metabolized)", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Pravastatin 40mg"]);

    const critical = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    const warning = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-WARNING");
    expect(critical).toBeUndefined();
    expect(warning).toBeUndefined();
  });

  it("does NOT flag clarithromycin + rosuvastatin (rosuvastatin not CYP3A4-metabolized)", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Rosuvastatin 10mg"]);

    const critical = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    const warning = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-WARNING");
    expect(critical).toBeUndefined();
    expect(warning).toBeUndefined();
  });

  it("notifies cardiology and infectious_disease for macrolide-statin interactions", () => {
    const flags = checkDrugInteractions(["Clarithromycin 500mg", "Simvastatin 40mg"]);

    const interaction = flags.find((f) => f.rule_id === "DI-MACROLIDE-STATIN-CRITICAL");
    expect(interaction!.notify_specialties).toContain("cardiology");
    expect(interaction!.notify_specialties).toContain("infectious_disease");
  });
});

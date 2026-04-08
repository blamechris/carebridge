import { describe, it, expect, vi } from "vitest";

// No external dependencies to mock for cross-specialty rules —
// they are pure functions that only need PatientContext.

import {
  checkCrossSpecialtyPatterns,
  type PatientContext,
} from "../rules/cross-specialty.js";

describe("CHEMO-FEVER-001 — ANC-aware behavior", () => {
  const baseCtx = (overrides: Partial<PatientContext> = {}): PatientContext => ({
    active_diagnoses: ["Breast cancer"],
    active_diagnosis_codes: ["C50.9"],
    active_medications: ["Cisplatin"],
    new_symptoms: ["fever"],
    care_team_specialties: ["oncology"],
    ...overrides,
  });

  it("fires CRITICAL when ANC < 1500 (febrile neutropenia)", () => {
    const ctx = baseCtx({ recent_labs: [{ name: "ANC", value: 800 }] });
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "CHEMO-FEVER-001",
    );
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
  });

  it("fires only WARNING when ANC is unknown (no recent labs)", () => {
    const ctx = baseCtx({ recent_labs: [] });
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "CHEMO-FEVER-001",
    );
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
  });

  it("does NOT fire when ANC is normal (>= 1500)", () => {
    const ctx = baseCtx({ recent_labs: [{ name: "ANC", value: 3200 }] });
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "CHEMO-FEVER-001",
    );
    expect(flag).toBeUndefined();
  });
});

describe("ONCO-VTE-NEURO-001 — Cancer + VTE + neurological symptom", () => {
  it("fires for cancer + VTE + neurological symptom", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Pancreatic adenocarcinoma", "Deep vein thrombosis"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: [],
      new_symptoms: ["New onset severe headache"],
      care_team_specialties: ["oncology", "hematology"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");

    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
    expect(flag!.category).toBe("cross-specialty");
    expect(flag!.notify_specialties).toContain("neurology");
    expect(flag!.notify_specialties).toContain("hematology");
  });

  it("does NOT fire without VTE diagnosis", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Pancreatic adenocarcinoma"],
      active_diagnosis_codes: ["C25.9"],
      active_medications: [],
      new_symptoms: ["severe headache"],
      care_team_specialties: ["oncology"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire without cancer diagnosis", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Deep vein thrombosis"],
      active_diagnosis_codes: ["I82.401"],
      active_medications: [],
      new_symptoms: ["severe headache"],
      care_team_specialties: ["hematology"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire without neurological symptom", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Lung cancer", "DVT"],
      active_diagnosis_codes: ["C34.90", "I82.401"],
      active_medications: [],
      new_symptoms: ["nausea"],
      care_team_specialties: ["oncology"],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeUndefined();
  });

  it("includes hemorrhagic risk note when patient is on anticoagulant", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "DVT"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: ["Enoxaparin 40mg SQ daily"],
      new_symptoms: ["severe headache"],
      care_team_specialties: [],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeDefined();
    expect(flag!.suggested_action).toContain("hemorrhagic risk");
  });

  it("includes NOT on anticoagulation note when patient is NOT on anticoagulant", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "DVT"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: [],
      new_symptoms: ["severe headache"],
      care_team_specialties: [],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeDefined();
    expect(flag!.suggested_action).toContain("NOT on anticoagulation");
  });
});

describe("ONCO-ANTICOAG-HELD-001 — Anticoagulant held/discontinued with active VTE", () => {
  it("fires for anticoagulant held + active VTE (by ICD-10 code)", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Deep vein thrombosis, left lower extremity"],
      active_diagnosis_codes: ["I82.402"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: ["hematology"],
      trigger_event: {
        id: "evt-1",
        type: "medication.updated",
        patient_id: "p-1",
        data: { name: "Enoxaparin 40mg", status: "held" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
    expect(flag!.category).toBe("medication-safety");
  });

  it("fires for anticoagulant discontinued + active VTE (by description)", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Pulmonary embolism"],
      active_diagnosis_codes: ["I26.99"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: [],
      trigger_event: {
        id: "evt-2",
        type: "medication.updated",
        patient_id: "p-1",
        data: { name: "Warfarin 5mg", status: "discontinued" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(flag).toBeDefined();
  });

  it("does NOT fire for non-anticoagulant medication held", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Deep vein thrombosis"],
      active_diagnosis_codes: ["I82.401"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: [],
      trigger_event: {
        id: "evt-3",
        type: "medication.updated",
        patient_id: "p-1",
        data: { name: "Metformin 500mg", status: "held" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire without active VTE diagnosis", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Hypertension"],
      active_diagnosis_codes: ["I10"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: [],
      trigger_event: {
        id: "evt-4",
        type: "medication.updated",
        patient_id: "p-1",
        data: { name: "Warfarin 5mg", status: "held" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire for non-medication event type", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Deep vein thrombosis"],
      active_diagnosis_codes: ["I82.401"],
      active_medications: [],
      new_symptoms: [],
      care_team_specialties: [],
      trigger_event: {
        id: "evt-5",
        type: "vital.created",
        patient_id: "p-1",
        data: { name: "Enoxaparin 40mg", status: "held" },
        timestamp: new Date().toISOString(),
      },
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-ANTICOAG-HELD-001");
    expect(flag).toBeUndefined();
  });
});

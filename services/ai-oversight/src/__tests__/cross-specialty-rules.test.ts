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

describe("OBSTETRIC-TERATOGEN-X-001 — Pregnancy + Category X teratogen", () => {
  const pregnantCtx = (meds: string[], overrides: Partial<PatientContext> = {}): PatientContext => ({
    active_diagnoses: ["Pregnancy, first trimester"],
    active_diagnosis_codes: ["Z34.01"],
    active_medications: meds,
    new_symptoms: [],
    care_team_specialties: ["obstetrics"],
    ...overrides,
  });

  it.each([
    ["isotretinoin"],
    ["warfarin"],
    ["methotrexate"],
    ["thalidomide"],
    ["misoprostol"],
    ["finasteride"],
    ["dutasteride"],
  ])("fires CRITICAL for Category X drug: %s", (drug) => {
    const flags = checkCrossSpecialtyPatterns(pregnantCtx([drug]));
    const flag = flags.find((f) => f.rule_id === "OBSTETRIC-TERATOGEN-X-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
    expect(flag!.category).toBe("medication-safety");
    expect(flag!.notify_specialties).toContain("obstetrics");
  });

  it("fires when pregnancy detected by ICD-10 O-code", () => {
    const ctx = pregnantCtx(["Warfarin 5mg"], {
      active_diagnoses: ["Supervision of normal pregnancy"],
      active_diagnosis_codes: ["O09.91"],
    });
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "OBSTETRIC-TERATOGEN-X-001",
    );
    expect(flag).toBeDefined();
  });

  it("fires when pregnancy detected by description only (no ICD code)", () => {
    const ctx = pregnantCtx(["Isotretinoin 20mg"], {
      active_diagnoses: ["Pregnant, 12 weeks gestational age"],
      active_diagnosis_codes: [""],
    });
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "OBSTETRIC-TERATOGEN-X-001",
    );
    expect(flag).toBeDefined();
  });

  it("does NOT fire without pregnancy diagnosis", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Acne vulgaris"],
      active_diagnosis_codes: ["L70.0"],
      active_medications: ["isotretinoin"],
      new_symptoms: [],
      care_team_specialties: [],
    };
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "OBSTETRIC-TERATOGEN-X-001",
    );
    expect(flag).toBeUndefined();
  });

  it("does NOT fire without teratogenic medication", () => {
    const flags = checkCrossSpecialtyPatterns(pregnantCtx(["acetaminophen"]));
    const flag = flags.find((f) => f.rule_id === "OBSTETRIC-TERATOGEN-X-001");
    expect(flag).toBeUndefined();
  });
});

describe("OBSTETRIC-TERATOGEN-D-001 — Pregnancy + Category D teratogen", () => {
  const pregnantCtx = (meds: string[], overrides: Partial<PatientContext> = {}): PatientContext => ({
    active_diagnoses: ["Pregnancy, second trimester"],
    active_diagnosis_codes: ["Z34.02"],
    active_medications: meds,
    new_symptoms: [],
    care_team_specialties: ["obstetrics"],
    ...overrides,
  });

  it.each([
    ["valproic acid"],
    ["carbamazepine"],
    ["phenytoin"],
    ["lithium"],
    ["tetracycline"],
    ["doxycycline"],
  ])("fires WARNING for Category D drug: %s", (drug) => {
    const flags = checkCrossSpecialtyPatterns(pregnantCtx([drug]));
    const flag = flags.find((f) => f.rule_id === "OBSTETRIC-TERATOGEN-D-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.category).toBe("medication-safety");
    expect(flag!.notify_specialties).toContain("obstetrics");
  });

  it("fires when pregnancy detected by Z33 code", () => {
    const ctx = pregnantCtx(["Lithium 300mg"], {
      active_diagnoses: ["Pregnant state, incidental"],
      active_diagnosis_codes: ["Z33.1"],
    });
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "OBSTETRIC-TERATOGEN-D-001",
    );
    expect(flag).toBeDefined();
  });

  it("does NOT fire without pregnancy diagnosis", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Bipolar disorder"],
      active_diagnosis_codes: ["F31.9"],
      active_medications: ["lithium"],
      new_symptoms: [],
      care_team_specialties: ["psychiatry"],
    };
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "OBSTETRIC-TERATOGEN-D-001",
    );
    expect(flag).toBeUndefined();
  });

  it("does NOT fire without Category D medication", () => {
    const flags = checkCrossSpecialtyPatterns(pregnantCtx(["acetaminophen"]));
    const flag = flags.find((f) => f.rule_id === "OBSTETRIC-TERATOGEN-D-001");
    expect(flag).toBeUndefined();
  });

  it("fires both X and D rules when patient has drugs from both categories", () => {
    const flags = checkCrossSpecialtyPatterns(
      pregnantCtx(["warfarin", "valproic acid"]),
    );
    const xFlag = flags.find((f) => f.rule_id === "OBSTETRIC-TERATOGEN-X-001");
    const dFlag = flags.find((f) => f.rule_id === "OBSTETRIC-TERATOGEN-D-001");
    expect(xFlag).toBeDefined();
    expect(xFlag!.severity).toBe("critical");
    expect(dFlag).toBeDefined();
    expect(dFlag!.severity).toBe("warning");
  });
});

describe("ANTICOAG-BLEED-001 — severity stratification", () => {
  const anticoagCtx = (
    symptoms: string[],
    overrides: Partial<PatientContext> = {},
  ): PatientContext => ({
    active_diagnoses: ["Atrial fibrillation"],
    active_diagnosis_codes: ["I48.91"],
    active_medications: ["Warfarin 5mg"],
    new_symptoms: symptoms,
    care_team_specialties: ["hematology"],
    ...overrides,
  });

  // --- CRITICAL severity: frank hemorrhage ---

  it.each([
    ["GI hemorrhage"],
    ["hematemesis"],
    ["melena"],
    ["hematochezia"],
    ["hemoptysis"],
    ["intracranial bleed"],
    ["GI bleed"],
    ["retroperitoneal hemorrhage"],
    ["blood in stool"],
  ])("fires CRITICAL for major hemorrhage term: %s", (symptom) => {
    const flags = checkCrossSpecialtyPatterns(anticoagCtx([symptom]));
    const flag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
  });

  // --- WARNING severity: moderate bleeding ---

  it.each([
    ["hematuria"],
    ["blood in urine"],
    ["nosebleed"],
    ["post-procedural bleeding"],
    ["bleeding from wound site"],
  ])("fires WARNING for moderate bleeding term: %s", (symptom) => {
    const flags = checkCrossSpecialtyPatterns(anticoagCtx([symptom]));
    const flag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
  });

  // --- SUPPRESSED: minor bruising with normal/unknown INR ---

  it.each([
    ["minor bruising on arm"],
    ["bruising at injection site"],
    ["petechiae"],
    ["ecchymosis"],
    ["minor skin bleeding"],
  ])("does NOT fire for minor bleeding with normal INR: %s", (symptom) => {
    const flags = checkCrossSpecialtyPatterns(
      anticoagCtx([symptom], { recent_labs: [{ name: "INR", value: 2.5 }] }),
    );
    const flag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire for minor bruising when INR is unknown", () => {
    const flags = checkCrossSpecialtyPatterns(
      anticoagCtx(["bruising on forearm"], { recent_labs: [] }),
    );
    const flag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(flag).toBeUndefined();
  });

  // --- Minor bleeding escalated when INR > 5.0 ---

  it("fires WARNING for minor bruising when INR > 5.0", () => {
    const flags = checkCrossSpecialtyPatterns(
      anticoagCtx(["bruising on forearm"], {
        recent_labs: [{ name: "INR", value: 6.2 }],
      }),
    );
    const flag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
  });

  it("fires WARNING for petechiae when INR > 5.0", () => {
    const flags = checkCrossSpecialtyPatterns(
      anticoagCtx(["petechiae on lower extremities"], {
        recent_labs: [{ name: "INR", value: 7.0 }],
      }),
    );
    const flag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
  });

  // --- Does NOT fire without anticoagulant ---

  it("does NOT fire without anticoagulant medication", () => {
    const flags = checkCrossSpecialtyPatterns(
      anticoagCtx(["hematemesis"], { active_medications: ["Metformin 500mg"] }),
    );
    const flag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(flag).toBeUndefined();
  });

  // --- Does NOT fire without bleeding symptom ---

  it("does NOT fire without bleeding symptom", () => {
    const flags = checkCrossSpecialtyPatterns(anticoagCtx(["headache"]));
    const flag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(flag).toBeUndefined();
  });

  // --- Mixed symptoms: critical overrides moderate ---

  it("fires CRITICAL when both critical and minor symptoms present", () => {
    const flags = checkCrossSpecialtyPatterns(
      anticoagCtx(["bruising on arm", "hematemesis"]),
    );
    const flag = flags.find((f) => f.rule_id === "ANTICOAG-BLEED-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
  });
});

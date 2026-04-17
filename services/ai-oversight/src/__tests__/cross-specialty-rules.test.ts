import { describe, it, expect, vi } from "vitest";

// No external dependencies to mock for cross-specialty rules —
// they are pure functions that only need PatientContext.

import {
  checkCrossSpecialtyPatterns,
  type PatientContext,
} from "../rules/cross-specialty.js";

describe("CHEMO-FEVER-001 / CHEMO-NEUTRO-FEVER-001 — ANC-aware rules", () => {
  const baseCtx = (overrides: Partial<PatientContext> = {}): PatientContext => ({
    active_diagnoses: ["Breast cancer"],
    active_diagnosis_codes: ["C50.9"],
    active_medications: ["Cisplatin"],
    new_symptoms: ["fever"],
    care_team_specialties: ["oncology"],
    ...overrides,
  });

  it("fires CHEMO-NEUTRO-FEVER-001 (critical) when ANC < 1500 — and suppresses the warning rule", () => {
    const ctx = baseCtx({ recent_labs: [{ name: "ANC", value: 800 }] });
    const flags = checkCrossSpecialtyPatterns(ctx);

    const critical = flags.find((f) => f.rule_id === "CHEMO-NEUTRO-FEVER-001");
    expect(critical).toBeDefined();
    expect(critical!.severity).toBe("critical");

    // CHEMO-FEVER-001 must NOT fire once febrile neutropenia is confirmed —
    // the critical rule owns that case; the warning rule only prompts a CBC.
    expect(flags.find((f) => f.rule_id === "CHEMO-FEVER-001")).toBeUndefined();
  });

  it("adds a severe-neutropenia addendum when ANC < 500", () => {
    const ctx = baseCtx({ recent_labs: [{ name: "ANC", value: 200 }] });
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "CHEMO-NEUTRO-FEVER-001",
    );
    expect(flag).toBeDefined();
    expect(flag!.suggested_action).toMatch(/Severe neutropenia \(ANC < 500\)/);
    expect(flag!.suggested_action).toMatch(/reverse isolation/);
  });

  it("omits the severe-neutropenia addendum when 500 <= ANC < 1500", () => {
    const ctx = baseCtx({ recent_labs: [{ name: "ANC", value: 1200 }] });
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "CHEMO-NEUTRO-FEVER-001",
    );
    expect(flag).toBeDefined();
    expect(flag!.suggested_action).not.toMatch(/Severe neutropenia/);
  });

  it("fires CHEMO-FEVER-001 (warning) when ANC is unknown", () => {
    const ctx = baseCtx({ recent_labs: [] });
    const flags = checkCrossSpecialtyPatterns(ctx);

    const warning = flags.find((f) => f.rule_id === "CHEMO-FEVER-001");
    expect(warning).toBeDefined();
    expect(warning!.severity).toBe("warning");

    // Critical rule must NOT fire without confirmed ANC data.
    expect(
      flags.find((f) => f.rule_id === "CHEMO-NEUTRO-FEVER-001"),
    ).toBeUndefined();
  });

  it("fires neither rule when ANC is normal (>= 1500)", () => {
    const ctx = baseCtx({ recent_labs: [{ name: "ANC", value: 3200 }] });
    const flags = checkCrossSpecialtyPatterns(ctx);

    expect(flags.find((f) => f.rule_id === "CHEMO-FEVER-001")).toBeUndefined();
    expect(
      flags.find((f) => f.rule_id === "CHEMO-NEUTRO-FEVER-001"),
    ).toBeUndefined();
  });

  it("CHEMO-NEUTRO-FEVER-001 notifies emergency as well as oncology/infectious_disease", () => {
    const ctx = baseCtx({ recent_labs: [{ name: "ANC", value: 800 }] });
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "CHEMO-NEUTRO-FEVER-001",
    );
    expect(flag).toBeDefined();
    expect(flag!.notify_specialties).toEqual(
      expect.arrayContaining(["oncology", "infectious_disease", "emergency"]),
    );
  });

  it("does not fire either rule when patient is not on chemo", () => {
    const ctx = baseCtx({
      active_medications: ["Lisinopril"],
      recent_labs: [{ name: "ANC", value: 800 }],
    });
    const flags = checkCrossSpecialtyPatterns(ctx);
    expect(flags.find((f) => f.rule_id === "CHEMO-FEVER-001")).toBeUndefined();
    expect(
      flags.find((f) => f.rule_id === "CHEMO-NEUTRO-FEVER-001"),
    ).toBeUndefined();
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

  // --- Recency gate (issue #215) ---
  //
  // When structured diagnosis detail is provided, the rule must treat stale /
  // resolved DVTs as non-qualifying. Without this gate, cancer patients with
  // a years-old resolved DVT still listed in their chart trigger unnecessary
  // CT head / CT angiography with IV contrast whenever they present with any
  // common neurological complaint (e.g. tension headache).

  it("does NOT fire when the VTE is resolved years ago (status=resolved)", () => {
    // Fixed reference date to avoid wall-clock dependency
    const referenceDate = "2025-06-15T12:00:00.000Z";
    const refDate = new Date(referenceDate);
    const sixYearsAgo = new Date(refDate);
    sixYearsAgo.setFullYear(refDate.getFullYear() - 6);
    const fiveYearsAgo = new Date(refDate);
    fiveYearsAgo.setFullYear(refDate.getFullYear() - 5);

    const ctx: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "Deep vein thrombosis"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: [],
      new_symptoms: ["tension headache"],
      care_team_specialties: ["oncology"],
      event_timestamp: referenceDate,
      active_diagnoses_detail: [
        {
          description: "Pancreatic cancer",
          icd10_code: "C25.9",
          status: "active",
          onset_date: null,
          resolved_date: null,
        },
        {
          description: "Deep vein thrombosis",
          icd10_code: "I82.401",
          status: "resolved",
          onset_date: sixYearsAgo.toISOString(),
          resolved_date: fiveYearsAgo.toISOString(),
        },
      ],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire when VTE onset is >6 months ago and patient is off anticoagulation", () => {
    const referenceDate = "2025-06-15T12:00:00.000Z";
    const refDate = new Date(referenceDate);
    const twoYearsAgo = new Date(refDate);
    twoYearsAgo.setFullYear(refDate.getFullYear() - 2);

    const ctx: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "History of DVT"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: [], // off anticoagulation
      new_symptoms: ["headache"],
      care_team_specialties: ["oncology"],
      event_timestamp: referenceDate,
      active_diagnoses_detail: [
        {
          description: "Pancreatic cancer",
          icd10_code: "C25.9",
          status: "active",
          onset_date: null,
          resolved_date: null,
        },
        {
          description: "History of DVT",
          icd10_code: "I82.401",
          status: "active", // still listed as active in the problem list
          onset_date: twoYearsAgo.toISOString(),
          resolved_date: null,
        },
      ],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeUndefined();
  });

  it("fires when VTE onset is recent (<6 months) even without anticoagulation", () => {
    const referenceDate = "2025-06-15T12:00:00.000Z";
    const refDate = new Date(referenceDate);
    const threeMonthsAgo = new Date(refDate);
    threeMonthsAgo.setMonth(refDate.getMonth() - 3);

    const ctx: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "Deep vein thrombosis"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: [],
      new_symptoms: ["new onset severe headache"],
      care_team_specialties: ["oncology"],
      event_timestamp: referenceDate,
      active_diagnoses_detail: [
        {
          description: "Pancreatic cancer",
          icd10_code: "C25.9",
          status: "active",
          onset_date: null,
          resolved_date: null,
        },
        {
          description: "Deep vein thrombosis",
          icd10_code: "I82.401",
          status: "active",
          onset_date: threeMonthsAgo.toISOString(),
          resolved_date: null,
        },
      ],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
  });

  it("fires when VTE onset is old but patient is on active anticoagulation (proxy for active disease)", () => {
    const referenceDate = "2025-06-15T12:00:00.000Z";
    const refDate = new Date(referenceDate);
    const twoYearsAgo = new Date(refDate);
    twoYearsAgo.setFullYear(refDate.getFullYear() - 2);

    const ctx: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "Chronic DVT"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: ["Apixaban 5mg BID"], // still anticoagulated
      new_symptoms: ["new headache"],
      care_team_specialties: ["oncology", "hematology"],
      event_timestamp: referenceDate,
      active_diagnoses_detail: [
        {
          description: "Pancreatic cancer",
          icd10_code: "C25.9",
          status: "active",
          onset_date: null,
          resolved_date: null,
        },
        {
          description: "Chronic DVT",
          icd10_code: "I82.401",
          status: "active",
          onset_date: twoYearsAgo.toISOString(),
          resolved_date: null,
        },
      ],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeDefined();
  });

  it("does NOT fire when VTE onset is 2 years ago, resolved 18 months ago (wasActiveAt + isActiveVTEDiagnosis combined)", () => {
    // Integration test: verifies that the wasActiveAt pre-filter (which
    // excludes resolved diagnoses) and the isActiveVTEDiagnosis recency gate
    // (which requires onset < 6 months or active anticoagulation) work
    // together. A patient with cancer, a long-resolved VTE, and a headache
    // must NOT trigger ONCO-VTE-NEURO-001. See issue #588.
    const referenceDate = "2025-06-15T12:00:00.000Z";
    const refDate = new Date(referenceDate);
    const twoYearsAgo = new Date(refDate);
    twoYearsAgo.setFullYear(refDate.getFullYear() - 2);
    const eighteenMonthsAgo = new Date(refDate);
    eighteenMonthsAgo.setMonth(refDate.getMonth() - 18);

    const ctx: PatientContext = {
      active_diagnoses: ["Breast cancer", "Deep vein thrombosis"],
      active_diagnosis_codes: ["C50.9", "I82.401"],
      active_medications: [],
      new_symptoms: ["headache"],
      care_team_specialties: ["oncology"],
      event_timestamp: referenceDate,
      active_diagnoses_detail: [
        {
          description: "Breast cancer",
          icd10_code: "C50.9",
          status: "active",
          onset_date: null,
          resolved_date: null,
        },
        {
          description: "Deep vein thrombosis",
          icd10_code: "I82.401",
          status: "resolved",
          onset_date: twoYearsAgo.toISOString(),
          resolved_date: eighteenMonthsAgo.toISOString(),
        },
      ],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire when VTE has a resolved_date in the past even if status string is 'active'", () => {
    // EHR data is messy: some problem lists leave status='active' even after
    // the diagnosis is resolved. A non-null resolved_date wins.
    const referenceDate = "2025-06-15T12:00:00.000Z";
    const refDate = new Date(referenceDate);
    const oneYearAgo = new Date(refDate);
    oneYearAgo.setFullYear(refDate.getFullYear() - 1);
    const eighteenMonthsAgo = new Date(refDate);
    eighteenMonthsAgo.setMonth(refDate.getMonth() - 18);

    const ctx: PatientContext = {
      active_diagnoses: ["Pancreatic cancer", "Deep vein thrombosis"],
      active_diagnosis_codes: ["C25.9", "I82.401"],
      active_medications: [],
      new_symptoms: ["headache"],
      care_team_specialties: ["oncology"],
      event_timestamp: referenceDate,
      active_diagnoses_detail: [
        {
          description: "Pancreatic cancer",
          icd10_code: "C25.9",
          status: "active",
          onset_date: null,
          resolved_date: null,
        },
        {
          description: "Deep vein thrombosis",
          icd10_code: "I82.401",
          status: "active",
          onset_date: eighteenMonthsAgo.toISOString(),
          resolved_date: oneYearAgo.toISOString(),
        },
      ],
    };

    const flags = checkCrossSpecialtyPatterns(ctx);
    const flag = flags.find((f) => f.rule_id === "ONCO-VTE-NEURO-001");
    expect(flag).toBeUndefined();
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

describe("RENAL-NSAID-DIURETIC-ACE-001 — Triple whammy AKI", () => {
  const tripleCtx = (
    meds: string[],
    overrides: Partial<PatientContext> = {},
  ): PatientContext => ({
    active_diagnoses: ["Hypertension"],
    active_diagnosis_codes: ["I10"],
    active_medications: meds,
    new_symptoms: [],
    care_team_specialties: ["primary_care"],
    ...overrides,
  });

  it.each([
    ["ibuprofen", "furosemide", "lisinopril"],
    ["Naproxen 500mg BID", "Bumetanide 1mg", "Losartan 50mg"],
    ["Meloxicam 15mg", "Torsemide 10mg", "enalapril"],
    ["Diclofenac", "Hydrochlorothiazide 25mg", "valsartan"],
    ["Celecoxib 200mg", "Chlorthalidone 25mg", "ramipril 10mg"],
  ])(
    "fires WARNING when all three drug classes co-active: %s + %s + %s",
    (nsaid, diuretic, acearb) => {
      const flags = checkCrossSpecialtyPatterns(
        tripleCtx([nsaid, diuretic, acearb]),
      );
      const flag = flags.find(
        (f) => f.rule_id === "RENAL-NSAID-DIURETIC-ACE-001",
      );
      expect(flag).toBeDefined();
      expect(flag!.severity).toBe("warning");
      expect(flag!.category).toBe("cross-specialty");
      expect(flag!.notify_specialties).toContain("nephrology");
    },
  );

  it("does NOT fire with only two of the three drug classes (NSAID + diuretic, no ACE/ARB)", () => {
    const flags = checkCrossSpecialtyPatterns(
      tripleCtx(["ibuprofen", "furosemide"]),
    );
    const flag = flags.find(
      (f) => f.rule_id === "RENAL-NSAID-DIURETIC-ACE-001",
    );
    expect(flag).toBeUndefined();
  });

  it("does NOT fire with only two of the three drug classes (diuretic + ACE/ARB, no NSAID)", () => {
    const flags = checkCrossSpecialtyPatterns(
      tripleCtx(["furosemide", "lisinopril"]),
    );
    const flag = flags.find(
      (f) => f.rule_id === "RENAL-NSAID-DIURETIC-ACE-001",
    );
    expect(flag).toBeUndefined();
  });

  it("does NOT fire with only two of the three drug classes (NSAID + ACE/ARB, no diuretic)", () => {
    const flags = checkCrossSpecialtyPatterns(
      tripleCtx(["naproxen", "lisinopril"]),
    );
    const flag = flags.find(
      (f) => f.rule_id === "RENAL-NSAID-DIURETIC-ACE-001",
    );
    expect(flag).toBeUndefined();
  });

  it("does NOT fire with no relevant drugs", () => {
    const flags = checkCrossSpecialtyPatterns(
      tripleCtx(["Metformin 500mg", "Atorvastatin 20mg"]),
    );
    const flag = flags.find(
      (f) => f.rule_id === "RENAL-NSAID-DIURETIC-ACE-001",
    );
    expect(flag).toBeUndefined();
  });
});

describe("HEPATIC-HEPATOTOXIN-001 — Hepatic disease + hepatotoxic medication", () => {
  const hepaticCtx = (
    meds: string[],
    overrides: Partial<PatientContext> = {},
  ): PatientContext => ({
    active_diagnoses: ["Cirrhosis of liver"],
    active_diagnosis_codes: ["K74.60"],
    active_medications: meds,
    new_symptoms: [],
    care_team_specialties: ["gastroenterology"],
    ...overrides,
  });

  it.each([
    ["acetaminophen 1000mg QID"],
    ["Tylenol 1g four times daily"],
    ["paracetamol 4g/day"],
    ["acetaminophen 1000mg TID"],
    ["Tylenol 1g three times daily"],
    ["paracetamol 1000mg q8h"],
    ["acetaminophen 1g 3x/day"],
    ["acetaminophen 1g 3x daily"],
    ["Tylenol 1000mg 4x daily"],
    ["APAP 1000mg 3 times daily"],
    ["methotrexate 15mg weekly"],
    ["isoniazid 300mg daily"],
    ["amiodarone 200mg daily"],
    ["valproic acid 500mg BID"],
    ["Depakote 1000mg"],
    ["atorvastatin 80mg daily"],
    ["rosuvastatin 40mg"],
    ["simvastatin 80mg"],
  ])("fires WARNING for hepatotoxic medication: %s", (drug) => {
    const flags = checkCrossSpecialtyPatterns(hepaticCtx([drug]));
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.category).toBe("cross-specialty");
    expect(flag!.notify_specialties).toContain("hepatology");
    expect(flag!.notify_specialties).toContain("gastroenterology");
  });

  it.each([
    ["Hepatitis C, chronic", "K75.9"],
    ["Alcoholic liver disease", "K70.9"],
    ["Hepatic failure, acute", "K72.00"],
    ["Non-alcoholic steatohepatitis (NASH)", "K75.81"],
    ["Chronic hepatitis B", "B18.1"],
  ])(
    "fires for hepatic diagnosis variant: %s (%s)",
    (diagnosis, code) => {
      const ctx = hepaticCtx(["isoniazid"], {
        active_diagnoses: [diagnosis],
        active_diagnosis_codes: [code],
      });
      const flag = checkCrossSpecialtyPatterns(ctx).find(
        (f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001",
      );
      expect(flag).toBeDefined();
    },
  );

  it("does NOT fire for low-dose acetaminophen (< 3g/day)", () => {
    const flags = checkCrossSpecialtyPatterns(
      hepaticCtx(["acetaminophen 500mg PRN"]),
    );
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire for sub-threshold TID acetaminophen (500mg × 3 = 1.5g/day < 3g)", () => {
    const flags = checkCrossSpecialtyPatterns(
      hepaticCtx(["acetaminophen 500mg TID"]),
    );
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire for low-dose statin (atorvastatin 10mg)", () => {
    const flags = checkCrossSpecialtyPatterns(
      hepaticCtx(["atorvastatin 10mg daily"]),
    );
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeUndefined();
  });

  // --- Fluvastatin / Pitavastatin high-dose thresholds ---

  it("fires WARNING for fluvastatin at high dose (>= 40mg)", () => {
    const flags = checkCrossSpecialtyPatterns(hepaticCtx(["fluvastatin 40mg daily"]));
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.notify_specialties).toContain("hepatology");
    expect(flag!.notify_specialties).toContain("gastroenterology");
  });

  it("fires WARNING for fluvastatin at 80mg (Lescol XL)", () => {
    const flags = checkCrossSpecialtyPatterns(hepaticCtx(["Lescol XL 80mg"]));
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.notify_specialties).toContain("hepatology");
    expect(flag!.notify_specialties).toContain("gastroenterology");
  });

  it("does NOT fire for low-dose fluvastatin (< 40mg)", () => {
    const flags = checkCrossSpecialtyPatterns(hepaticCtx(["fluvastatin 20mg daily"]));
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeUndefined();
  });

  it("fires WARNING for pitavastatin at high dose (>= 4mg)", () => {
    const flags = checkCrossSpecialtyPatterns(hepaticCtx(["pitavastatin 4mg daily"]));
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.notify_specialties).toContain("hepatology");
    expect(flag!.notify_specialties).toContain("gastroenterology");
  });

  it("fires WARNING for pitavastatin via brand name (Livalo 4mg)", () => {
    const flags = checkCrossSpecialtyPatterns(hepaticCtx(["Livalo 4mg"]));
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.notify_specialties).toContain("hepatology");
    expect(flag!.notify_specialties).toContain("gastroenterology");
  });

  it("does NOT fire for low-dose pitavastatin (< 4mg)", () => {
    const flags = checkCrossSpecialtyPatterns(hepaticCtx(["pitavastatin 2mg daily"]));
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire without hepatic diagnosis", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Hypertension"],
      active_diagnosis_codes: ["I10"],
      active_medications: ["isoniazid 300mg"],
      new_symptoms: [],
      care_team_specialties: [],
    };
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001",
    );
    expect(flag).toBeUndefined();
  });

  it("does NOT fire without hepatotoxic medication", () => {
    const flags = checkCrossSpecialtyPatterns(
      hepaticCtx(["lisinopril 10mg", "metformin 500mg"]),
    );
    const flag = flags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001");
    expect(flag).toBeUndefined();
  });
});

describe("RENAL-AMINOGLYCOSIDE-001 — Renal impairment + aminoglycoside", () => {
  const renalCtx = (
    meds: string[],
    overrides: Partial<PatientContext> = {},
  ): PatientContext => ({
    active_diagnoses: ["Chronic kidney disease, stage 3"],
    active_diagnosis_codes: ["N18.30"],
    active_medications: meds,
    new_symptoms: [],
    care_team_specialties: ["nephrology"],
    ...overrides,
  });

  it.each([
    ["gentamicin 80mg IV q8h"],
    ["tobramycin 120mg"],
    ["amikacin 500mg IV"],
    ["streptomycin 1g IM"],
    ["neomycin 500mg PO q6h"],
    ["kanamycin 15mg/kg IV"],
    ["paromomycin 500mg PO TID"],
    ["plazomicin 15mg/kg IV q24h"],
    ["Garamycin"],
    ["Nebcin"],
    ["TOBI 300mg inhaled"],
    ["Amikin 500mg IV"],
    ["Zemdri 15mg/kg IV"],
  ])("fires WARNING for aminoglycoside: %s", (drug) => {
    const flags = checkCrossSpecialtyPatterns(renalCtx([drug]));
    const flag = flags.find((f) => f.rule_id === "RENAL-AMINOGLYCOSIDE-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.category).toBe("cross-specialty");
    expect(flag!.notify_specialties).toContain("nephrology");
    expect(flag!.notify_specialties).toContain("infectious_disease");
  });

  it.each([
    ["Chronic kidney disease, stage 4", "N18.4"],
    ["End-stage renal disease", "N18.6"],
    ["Acute kidney injury", "N17.9"],
    ["Renal insufficiency", "N28.9"],
    ["Reduced eGFR (< 60)", "R94.4"],
  ])("fires for renal impairment variant: %s (%s)", (diagnosis, code) => {
    const ctx = renalCtx(["gentamicin"], {
      active_diagnoses: [diagnosis],
      active_diagnosis_codes: [code],
    });
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "RENAL-AMINOGLYCOSIDE-001",
    );
    expect(flag).toBeDefined();
  });

  it("does NOT fire without aminoglycoside", () => {
    const flags = checkCrossSpecialtyPatterns(
      renalCtx(["cefepime 1g IV q8h", "vancomycin 1g IV"]),
    );
    const flag = flags.find((f) => f.rule_id === "RENAL-AMINOGLYCOSIDE-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire without renal impairment", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Pseudomonas pneumonia"],
      active_diagnosis_codes: ["J15.1"],
      active_medications: ["tobramycin 120mg IV q8h"],
      new_symptoms: [],
      care_team_specialties: ["infectious_disease"],
    };
    const flag = checkCrossSpecialtyPatterns(ctx).find(
      (f) => f.rule_id === "RENAL-AMINOGLYCOSIDE-001",
    );
    expect(flag).toBeUndefined();
  });
});

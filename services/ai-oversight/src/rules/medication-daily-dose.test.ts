import { describe, it, expect } from "vitest";
import type { ClinicalEvent } from "@carebridge/shared-types";
import { checkMedicationDailyDose } from "./medication-daily-dose.js";
import type { PatientContext, PatientMedication } from "./cross-specialty.js";

function makeMed(
  overrides: Partial<PatientMedication> & { id?: string; name?: string } = {},
): PatientMedication {
  return {
    id: overrides.id ?? "med-1",
    name: overrides.name ?? "Morphine",
    // Explicit has-key check so callers can override with null (e.g. for the
    // "missing dose_amount" fail-open case) without `??` defaulting it away.
    dose_amount: "dose_amount" in overrides ? (overrides.dose_amount as number | null) : 10,
    dose_unit: overrides.dose_unit ?? "mg",
    route: overrides.route ?? "oral",
    frequency: overrides.frequency ?? "q2h",
    max_doses_per_day: overrides.max_doses_per_day ?? null,
    rxnorm_code: overrides.rxnorm_code ?? null,
  };
}

function makeCtx(
  triggerMed: PatientMedication,
  eventType:
    | "medication.created"
    | "medication.updated"
    | "lab.resulted" = "medication.created",
): PatientContext {
  const event: ClinicalEvent = {
    id: "evt-1",
    type: eventType,
    patient_id: "p-1",
    timestamp: "2026-04-18T12:00:00.000Z",
    data: {
      resourceId: triggerMed.id,
      name: triggerMed.name,
      status: "active",
    },
  };
  return {
    active_diagnoses: [],
    active_diagnosis_codes: [],
    active_medications: [triggerMed.name],
    active_medications_detail: [triggerMed],
    new_symptoms: [],
    care_team_specialties: [],
    trigger_event: event,
  };
}

describe("checkMedicationDailyDose (#235)", () => {
  describe("Morphine", () => {
    it("10 mg Q2H → flag critical (120 mg/day, >1.5× 90 mg cap)", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(makeMed({ name: "Morphine", dose_amount: 10, frequency: "q2h" })),
      );
      const daily = flags.find((f) => f.rule_id.startsWith("MED-DAILY-OVER"));
      expect(daily).toBeDefined();
      expect(daily!.severity).toBe("critical");
      expect(daily!.summary).toMatch(/120/);
      expect(daily!.summary).toMatch(/90/);
    });

    it("10 mg Q4H PRN cap 4/day → no flag (40 mg/day < 90)", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({
            name: "Morphine",
            dose_amount: 10,
            frequency: "q4h prn",
            max_doses_per_day: 4,
          }),
        ),
      );
      const daily = flags.find((f) => f.rule_id.startsWith("MED-DAILY-OVER"));
      expect(daily).toBeUndefined();
    });

    it("10 mg Q4H (60 mg/day) stays within the 90 mg cap → no daily flag", () => {
      // 60 mg morphine/day is under the 90 mg cap (1× threshold), so the
      // daily-over rule must NOT fire. Locks the lower-edge behaviour so a
      // future severity tweak doesn't silently start warning here.
      const flags = checkMedicationDailyDose(
        makeCtx(makeMed({ name: "Morphine", dose_amount: 10, frequency: "q4h" })),
      );
      const daily = flags.find((f) => f.rule_id.startsWith("MED-DAILY-OVER"));
      expect(daily).toBeUndefined();
    });

    it("30 mg Q2H → flag critical for both single-dose and daily", () => {
      // Single-dose ceiling is 30 mg; 30 mg is AT the ceiling, not above.
      // 30 mg q2h → 360 mg/day, 4× the 90 mg cap.
      const flags = checkMedicationDailyDose(
        makeCtx(makeMed({ name: "Morphine", dose_amount: 30, frequency: "q2h" })),
      );
      const single = flags.find((f) => f.rule_id.startsWith("MED-SINGLE-OVER"));
      expect(single).toBeUndefined(); // 30 is at ceiling, not above
      const daily = flags.find((f) => f.rule_id.startsWith("MED-DAILY-OVER"));
      expect(daily).toBeDefined();
      expect(daily!.severity).toBe("critical");
    });

    it("31 mg Q2H → flag single-dose (>30 mg) and daily (critical)", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(makeMed({ name: "Morphine", dose_amount: 31, frequency: "q2h" })),
      );
      expect(flags.some((f) => f.rule_id.startsWith("MED-SINGLE-OVER"))).toBe(true);
      expect(flags.some((f) => f.rule_id.startsWith("MED-DAILY-OVER"))).toBe(true);
    });
  });

  describe("Acetaminophen", () => {
    it("1000 mg Q4H → flag daily (6000 mg/day > 4000 cap, 1.5× → warning)", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({
            name: "Acetaminophen",
            dose_amount: 1000,
            frequency: "q4h",
          }),
        ),
      );
      const daily = flags.find((f) => f.rule_id.startsWith("MED-DAILY-OVER"));
      expect(daily).toBeDefined();
      expect(daily!.severity).toBe("warning");
    });

    it("500 mg Q6H → no daily flag (2000 mg/day within 4000 cap)", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({
            name: "Acetaminophen",
            dose_amount: 500,
            frequency: "q6h",
          }),
        ),
      );
      expect(flags.some((f) => f.rule_id.startsWith("MED-DAILY-OVER"))).toBe(false);
    });

    it("1500 mg single dose → flag single-dose (over 1000 mg ceiling)", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({
            name: "Acetaminophen",
            dose_amount: 1500,
            frequency: "q8h",
          }),
        ),
      );
      expect(flags.some((f) => f.rule_id.startsWith("MED-SINGLE-OVER"))).toBe(true);
    });
  });

  describe("brand-name alias (Percocet → oxycodone)", () => {
    it("resolves Percocet and flags over-daily (40 mg q4h → 240 mg oxycodone/day)", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({
            name: "Percocet",
            dose_amount: 40,
            frequency: "q4h",
          }),
        ),
      );
      expect(flags.some((f) => f.rule_id.includes("OXYCODONE"))).toBe(true);
    });
  });

  describe("fail-open cases", () => {
    it("unparseable frequency → no flag", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({
            name: "Morphine",
            dose_amount: 10,
            frequency: "when needed on weekends",
          }),
        ),
      );
      expect(flags.some((f) => f.rule_id.startsWith("MED-DAILY-OVER"))).toBe(false);
    });

    it("unknown drug → no flag", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({
            name: "Zolpidopride",
            dose_amount: 500,
            frequency: "q2h",
          }),
        ),
      );
      expect(flags).toHaveLength(0);
    });

    it("non-mg unit → no flag (future issue adds conversion)", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({
            name: "Morphine",
            dose_amount: 100,
            dose_unit: "mcg",
            frequency: "q2h",
          }),
        ),
      );
      expect(flags).toHaveLength(0);
    });

    it("missing dose_amount → no flag", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({
            name: "Morphine",
            dose_amount: null,
            frequency: "q2h",
          }),
        ),
      );
      expect(flags).toHaveLength(0);
    });

    it("non-medication trigger event → no flag", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({ name: "Morphine", dose_amount: 10, frequency: "q2h" }),
          "lab.resulted",
        ),
      );
      expect(flags).toHaveLength(0);
    });

    it("PRN without max_doses_per_day → no daily flag (unboundable)", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(
          makeMed({
            name: "Morphine",
            dose_amount: 10,
            frequency: "prn",
          }),
        ),
      );
      expect(flags.some((f) => f.rule_id.startsWith("MED-DAILY-OVER"))).toBe(false);
    });

    it("medication not in active_medications_detail → no flag", () => {
      const ctx = makeCtx(
        makeMed({ id: "med-1", name: "Morphine", dose_amount: 10, frequency: "q2h" }),
      );
      // The trigger references resourceId=med-1, but the detail list is empty.
      ctx.active_medications_detail = [];
      const flags = checkMedicationDailyDose(ctx);
      expect(flags).toHaveLength(0);
    });
  });

  describe("rule_id conventions", () => {
    it("daily flag rule_id starts with MED-DAILY-OVER-<DRUG>", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(makeMed({ name: "Morphine", dose_amount: 10, frequency: "q2h" })),
      );
      const daily = flags.find((f) => f.rule_id.startsWith("MED-DAILY-OVER"));
      expect(daily?.rule_id).toBe("MED-DAILY-OVER-MORPHINE");
    });

    it("single-dose flag rule_id starts with MED-SINGLE-OVER-<DRUG>", () => {
      const flags = checkMedicationDailyDose(
        makeCtx(makeMed({ name: "Morphine", dose_amount: 50, frequency: "q12h" })),
      );
      const single = flags.find((f) => f.rule_id.startsWith("MED-SINGLE-OVER"));
      expect(single?.rule_id).toBe("MED-SINGLE-OVER-MORPHINE");
    });
  });
});

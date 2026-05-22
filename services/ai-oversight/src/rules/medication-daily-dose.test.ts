import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { ClinicalEvent } from "@carebridge/shared-types";
import {
  checkMedicationDailyDose,
  resolveRatio,
  OPIOID_CRITICAL_RATIO_DEFAULT,
} from "./medication-daily-dose.js";
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

  describe("resolveRatio — deployment override (#968)", () => {
    const envKey = "TEST_RATIO_OVERRIDE_968";
    afterEach(() => {
      delete process.env[envKey];
    });

    it("returns default when env var is unset", () => {
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("returns default when env var is empty string", () => {
      process.env[envKey] = "";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("parses a valid numeric override", () => {
      process.env[envKey] = "1.5";
      expect(resolveRatio(envKey, 1.2)).toBe(1.5);
    });

    it("parses an integer override", () => {
      process.env[envKey] = "2";
      expect(resolveRatio(envKey, 1.2)).toBe(2);
    });

    it("falls back when env value is non-numeric", () => {
      process.env[envKey] = "tomato";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("falls back when env value is exactly 1.0 (collapsed warning band)", () => {
      process.env[envKey] = "1.0";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("falls back when env value is ≤ 1.0", () => {
      process.env[envKey] = "0.8";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("falls back when env value is negative", () => {
      process.env[envKey] = "-1.5";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("falls back on Infinity", () => {
      process.env[envKey] = "Infinity";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("falls back on partial-numeric '2.0x' (#1043)", () => {
      process.env[envKey] = "2.0x";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("falls back on locale-typo '2,0' (#1043)", () => {
      process.env[envKey] = "2,0";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("falls back on scientific notation '1e2' (#1043)", () => {
      // Scientific notation is unusual for a human-set ratio and is a
      // common copy-paste artifact from spreadsheets. Reject it.
      process.env[envKey] = "1e2";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("falls back on explicit-positive prefix '+1.5' (#1043)", () => {
      process.env[envKey] = "+1.5";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("falls back on leading-dot '.5' (#1043)", () => {
      process.env[envKey] = ".5";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("accepts whitespace-padded valid values (trimmed)", () => {
      process.env[envKey] = "  1.5  ";
      expect(resolveRatio(envKey, 1.2)).toBe(1.5);
    });

    it("falls back on > MAX_RATIO_OVERRIDE (likely decimal-point typo) (#1033)", () => {
      // 120 is intended as 1.20 — silently accepting would effectively
      // disable critical escalation. Upper bound is 10.
      process.env[envKey] = "120";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("falls back on 100 (above the 10 upper bound) (#1033)", () => {
      process.env[envKey] = "100";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });

    it("accepts boundary value of exactly 10 (#1033)", () => {
      process.env[envKey] = "10";
      expect(resolveRatio(envKey, 1.2)).toBe(10);
    });

    it("falls back on 10.5 (just above bound) (#1033)", () => {
      process.env[envKey] = "10.5";
      expect(resolveRatio(envKey, 1.2)).toBe(1.2);
    });
  });

  describe("override rationale surfacing (#968)", () => {
    // The constants are resolved at module-load time, so to test the
    // override-note rendering we have to reload the module with the env
    // var pre-set. vi.resetModules + dynamic import keeps the override
    // contained to this test.
    let prev: string | undefined;
    beforeEach(() => {
      prev = process.env.OPIOID_CRITICAL_RATIO;
    });
    afterEach(() => {
      if (prev === undefined) delete process.env.OPIOID_CRITICAL_RATIO;
      else process.env.OPIOID_CRITICAL_RATIO = prev;
      vi.resetModules();
    });

    it("includes 'deployment override' note in flag rationale when overridden", async () => {
      process.env.OPIOID_CRITICAL_RATIO = "2.0";
      vi.resetModules();
      const fresh = await import("./medication-daily-dose.js");
      // 10 mg morphine q2h = 120 mg/day, 1.33× the 90 mg cap. Under default
      // 1.2× this would be critical; under override 2.0× it stays warning.
      // The rationale should mention the active override either way.
      const flags = fresh.checkMedicationDailyDose(
        makeCtx(makeMed({ name: "Morphine", dose_amount: 10, frequency: "q2h" })),
      );
      const daily = flags.find((f) => f.rule_id?.startsWith("MED-DAILY-OVER"));
      expect(daily).toBeDefined();
      expect(daily!.rationale).toMatch(/deployment override/);
      expect(daily!.rationale).toMatch(/2(\.0)?×/);
      expect(daily!.rationale).toMatch(
        new RegExp(`${OPIOID_CRITICAL_RATIO_DEFAULT}×`),
      );
      // Opioid path correctly credits CDC as the default-source authority.
      expect(daily!.rationale).toMatch(/CDC default/);
    });

    it("non-opioid override note credits cumulative-harm default (NOT CDC) (#1042)", async () => {
      process.env.NON_OPIOID_CRITICAL_RATIO = "1.5";
      vi.resetModules();
      const fresh = await import("./medication-daily-dose.js");
      // Acetaminophen 1000 mg q4h = 6000 mg/day, 1.5× the 4000 mg cap.
      // At the override ratio of 1.5 this stays in the critical band; the
      // rationale must mention the override but must NOT credit CDC for
      // the non-opioid default (CDC's 90 MME guideline is opioid-only).
      const flags = fresh.checkMedicationDailyDose(
        makeCtx(makeMed({ name: "Acetaminophen", dose_amount: 1000, frequency: "q4h" })),
      );
      const daily = flags.find((f) => f.rule_id?.startsWith("MED-DAILY-OVER"));
      expect(daily).toBeDefined();
      expect(daily!.rationale).toMatch(/deployment override/);
      expect(daily!.rationale).toMatch(/cumulative-harm default/);
      // The 'CDC default' string must NOT appear in non-opioid rationale.
      expect(daily!.rationale).not.toMatch(/CDC default/);
      // Reset for subsequent tests in this describe block.
      delete process.env.NON_OPIOID_CRITICAL_RATIO;
    });

    it("omits the override note when running at the default ratio", () => {
      // Module-load default path — no env override.
      const flags = checkMedicationDailyDose(
        makeCtx(makeMed({ name: "Morphine", dose_amount: 10, frequency: "q2h" })),
      );
      const daily = flags.find((f) => f.rule_id?.startsWith("MED-DAILY-OVER"));
      expect(daily).toBeDefined();
      expect(daily!.rationale).not.toMatch(/deployment override/);
    });
  });

  describe("cumulative APAP across combo opioids + plain acetaminophen (#926)", () => {
    function multiMedCtx(meds: PatientMedication[]): PatientContext {
      const triggerEvent: ClinicalEvent = {
        id: "evt-apap-1",
        type: "medication.created",
        patient_id: "p-1",
        timestamp: "2026-04-18T12:00:00.000Z",
        data: {
          resourceId: meds[0]!.id,
          name: meds[0]!.name,
          status: "active",
        },
      };
      return {
        active_diagnoses: [],
        active_diagnosis_codes: [],
        active_medications: meds.map((m) => m.name),
        active_medications_detail: meds,
        new_symptoms: [],
        care_team_specialties: [],
        trigger_event: triggerEvent,
      };
    }

    it("Norco 5/325 q6h + Tylenol 650 mg TID → flags APAP cumulative", () => {
      // Norco: 4 doses/day × 325 mg APAP = 1300 mg APAP/day
      // Tylenol 650 mg TID: 3 × 650 = 1950 mg APAP/day
      // Combined: ~3250 mg/day — at the 4000 cap (under, no flag)
      // Bump Norco to Q4H (6 doses × 325 = 1950) → 1950 + 1950 = 3900 mg/day, still under
      // Use Q3H to push it over: 8 × 325 = 2600 + 1950 = 4550 mg/day → flags
      const meds: PatientMedication[] = [
        {
          id: "m-norco",
          name: "Norco",
          dose_amount: 5, // mg hydrocodone — opioid component
          dose_unit: "mg",
          route: "oral",
          frequency: "q3h",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
        {
          id: "m-tylenol",
          name: "Tylenol",
          dose_amount: 650,
          dose_unit: "mg",
          route: "oral",
          frequency: "tid",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
      ];
      const flags = checkMedicationDailyDose(multiMedCtx(meds));
      const apap = flags.find((f) => f.rule_id === "MED-DAILY-OVER-APAP-COMBO");
      expect(apap).toBeDefined();
      expect(apap!.summary).toMatch(/APAP/);
      expect(apap!.summary).toMatch(/4000 mg\/day/);
    });

    it("Percocet 10/325 q6h alone (single med) → no APAP combo flag (single-med per-drug flag covers it)", () => {
      // Percocet 5 mg oxy × 4/day = under oxycodone cap; 325 × 4 = 1300 mg APAP — under
      // Even at q4h: 6 × 325 = 1950 mg APAP/day — still under 4000
      const meds: PatientMedication[] = [
        {
          id: "m-perc",
          name: "Percocet",
          dose_amount: 5,
          dose_unit: "mg",
          route: "oral",
          frequency: "q6h",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
      ];
      const flags = checkMedicationDailyDose(multiMedCtx(meds));
      const apap = flags.find((f) => f.rule_id === "MED-DAILY-OVER-APAP-COMBO");
      expect(apap).toBeUndefined();
    });

    it("plain Tylenol alone over-cap → no APAP combo flag (per-drug rule already fires)", () => {
      // 1500 mg Q4H = 9000 mg/day. The per-drug MED-DAILY-OVER-ACETAMINOPHEN
      // already fires for this — emitting the combo flag would duplicate.
      const meds: PatientMedication[] = [
        {
          id: "m-tylenol",
          name: "Acetaminophen",
          dose_amount: 1500,
          dose_unit: "mg",
          route: "oral",
          frequency: "q4h",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
      ];
      const flags = checkMedicationDailyDose(multiMedCtx(meds));
      const perDrug = flags.find((f) => f.rule_id?.startsWith("MED-DAILY-OVER-ACETAMINOPHEN"));
      expect(perDrug).toBeDefined();
      const apap = flags.find((f) => f.rule_id === "MED-DAILY-OVER-APAP-COMBO");
      expect(apap).toBeUndefined();
    });

    it("Vicodin q4h + Tylenol 1000 q6h → cumulative APAP flags", () => {
      // Vicodin 300 mg APAP × 6/day = 1800 mg
      // Tylenol 1000 mg × 4/day = 4000 mg
      // Total: 5800 mg/day — clearly flags critical (>2× cap? 5800/4000 = 1.45× → warning, not critical)
      const meds: PatientMedication[] = [
        {
          id: "m-vic",
          name: "Vicodin",
          dose_amount: 5,
          dose_unit: "mg",
          route: "oral",
          frequency: "q4h",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
        {
          id: "m-tylenol",
          name: "Acetaminophen",
          dose_amount: 1000,
          dose_unit: "mg",
          route: "oral",
          frequency: "q6h",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
      ];
      const flags = checkMedicationDailyDose(multiMedCtx(meds));
      const apap = flags.find((f) => f.rule_id === "MED-DAILY-OVER-APAP-COMBO");
      expect(apap).toBeDefined();
      expect(apap!.severity).toBe("warning"); // 1.45×, under critical 2× threshold
      expect(apap!.rationale).toMatch(/Vicodin/);
      expect(apap!.rationale).toMatch(/Acetaminophen/);
    });

    it("critical severity at ≥2× APAP cap (≥8000 mg/day)", () => {
      const meds: PatientMedication[] = [
        {
          id: "m-perc",
          name: "Percocet",
          dose_amount: 5,
          dose_unit: "mg",
          route: "oral",
          frequency: "q2h",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
        {
          id: "m-tylenol",
          name: "Tylenol",
          dose_amount: 1000,
          dose_unit: "mg",
          route: "oral",
          frequency: "q3h",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
      ];
      // Percocet: 325 × 12 = 3900; Tylenol: 1000 × 8 = 8000; total 11900 mg
      const flags = checkMedicationDailyDose(multiMedCtx(meds));
      const apap = flags.find((f) => f.rule_id === "MED-DAILY-OVER-APAP-COMBO");
      expect(apap).toBeDefined();
      expect(apap!.severity).toBe("critical");
    });

    it("fail-open: unparseable frequency on combo opioid drops it from sum", () => {
      const meds: PatientMedication[] = [
        {
          id: "m-norco",
          name: "Norco",
          dose_amount: 5,
          dose_unit: "mg",
          route: "oral",
          frequency: "when patient asks",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
        {
          id: "m-tylenol",
          name: "Tylenol",
          dose_amount: 1000,
          dose_unit: "mg",
          route: "oral",
          frequency: "q4h",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
      ];
      // Norco drops out; Tylenol: 1000 × 6 = 6000 mg/day → that fires
      // the per-drug ACETAMINOPHEN flag but NOT the combo flag (single
      // med after Norco dropped, so dedup against per-drug kicks in).
      const flags = checkMedicationDailyDose(multiMedCtx(meds));
      const apap = flags.find((f) => f.rule_id === "MED-DAILY-OVER-APAP-COMBO");
      expect(apap).toBeUndefined();
    });

    it("non-APAP combo medication (oxycodone IR) does NOT contribute to APAP sum", () => {
      // Plain oxycodone is opioid-only, no APAP component. Should be
      // excluded from the APAP rollup entirely.
      const meds: PatientMedication[] = [
        {
          id: "m-oxy",
          name: "Oxycodone",
          dose_amount: 10,
          dose_unit: "mg",
          route: "oral",
          frequency: "q4h",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
        {
          id: "m-tylenol",
          name: "Tylenol",
          dose_amount: 500,
          dose_unit: "mg",
          route: "oral",
          frequency: "q6h",
          max_doses_per_day: null,
          rxnorm_code: null,
        },
      ];
      // Tylenol alone: 500 × 4 = 2000 mg/day, under cap. Oxycodone doesn't
      // contribute. Result: no APAP flag.
      const flags = checkMedicationDailyDose(multiMedCtx(meds));
      const apap = flags.find((f) => f.rule_id === "MED-DAILY-OVER-APAP-COMBO");
      expect(apap).toBeUndefined();
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

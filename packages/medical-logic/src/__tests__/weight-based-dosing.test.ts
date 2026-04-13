import { describe, it, expect } from "vitest";
import { checkWeightBasedDosing } from "../weight-based-dosing.js";

// ─── No matching drug ──────────────────────────────────────────

describe("checkWeightBasedDosing — unrecognized drug", () => {
  it("returns no alerts for a drug without weight-based rules", () => {
    const alerts = checkWeightBasedDosing({
      medicationName: "Amoxicillin",
      doseMg: 500,
      weightKg: 70,
    });
    expect(alerts).toHaveLength(0);
  });
});

// ─── Missing weight ────────────────────────────────────────────

describe("checkWeightBasedDosing — missing weight", () => {
  it("returns INFO when weight is undefined", () => {
    const alerts = checkWeightBasedDosing({
      medicationName: "Acetaminophen",
      doseMg: 1000,
      weightKg: undefined,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("INFO");
    expect(alerts[0].message).toContain("weight not documented");
    expect(alerts[0].ruleId).toBe("DOSE-WT-APAP-001");
  });

  it("returns INFO when weight is null", () => {
    const alerts = checkWeightBasedDosing({
      medicationName: "Vancomycin",
      doseMg: 1000,
      weightKg: null,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("INFO");
  });
});

// ─── Invalid weight ────────────────────────────────────────────

describe("checkWeightBasedDosing — invalid weight", () => {
  it("returns WARNING for zero weight", () => {
    const alerts = checkWeightBasedDosing({
      medicationName: "Gentamicin",
      doseMg: 200,
      weightKg: 0,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("WARNING");
    expect(alerts[0].message).toContain("Invalid patient weight");
  });

  it("returns WARNING for negative weight", () => {
    const alerts = checkWeightBasedDosing({
      medicationName: "Gentamicin",
      doseMg: 200,
      weightKg: -5,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("WARNING");
  });
});

// ─── Acetaminophen (daily max) ─────────────────────────────────

describe("checkWeightBasedDosing — Acetaminophen", () => {
  it("returns no alerts for safe dose within weight-based and absolute limits", () => {
    // 70 kg patient: max 75 * 70 = 5250 mg/day (capped at 4000 absolute)
    // 500 mg x 4 = 2000 mg/day — well under both limits
    const alerts = checkWeightBasedDosing({
      medicationName: "Acetaminophen",
      doseMg: 500,
      dosesPerDay: 4,
      weightKg: 70,
    });
    expect(alerts).toHaveLength(0);
  });

  it("flags daily total exceeding absolute 4 g/day ceiling", () => {
    // 1500 mg x 4 = 6000 mg/day — exceeds 4000 absolute
    const alerts = checkWeightBasedDosing({
      medicationName: "Tylenol",
      doseMg: 1500,
      dosesPerDay: 4,
      weightKg: 100,
    });
    expect(alerts.some((a) => a.severity === "WARNING" && a.message.includes("absolute maximum"))).toBe(true);
  });

  it("flags weight-based excess for small patient", () => {
    // 40 kg patient: max 75 * 40 = 3000 mg/day
    // 1000 mg x 4 = 4000 mg/day — exceeds weight limit
    // Also exceeds absolute 4000 mg ceiling (need > 4000 for that check)
    const alerts = checkWeightBasedDosing({
      medicationName: "Paracetamol",
      doseMg: 1000,
      dosesPerDay: 4,
      weightKg: 40,
    });
    expect(alerts.some((a) => a.message.includes("weight-based maximum"))).toBe(true);
  });

  it("flags both weight-based and absolute excess when daily total exceeds both", () => {
    // 40 kg patient: max 75 * 40 = 3000 mg/day, absolute 4000
    // 1500 mg x 4 = 6000 mg/day — exceeds both
    const alerts = checkWeightBasedDosing({
      medicationName: "Paracetamol",
      doseMg: 1500,
      dosesPerDay: 4,
      weightKg: 40,
    });
    expect(alerts.some((a) => a.message.includes("weight-based maximum"))).toBe(true);
    expect(alerts.some((a) => a.message.includes("absolute maximum"))).toBe(true);
  });

  it("defaults to 1 dose/day when dosesPerDay is omitted", () => {
    // 70 kg patient, 1000 mg single dose, no dosesPerDay
    // daily = 1000 mg, well under 4000 and 5250
    const alerts = checkWeightBasedDosing({
      medicationName: "Acetaminophen",
      doseMg: 1000,
      weightKg: 70,
    });
    expect(alerts).toHaveLength(0);
  });

  it("matches case-insensitively", () => {
    const alerts = checkWeightBasedDosing({
      medicationName: "ACETAMINOPHEN",
      doseMg: 1000,
      dosesPerDay: 6,
      weightKg: 50,
    });
    // 6000 mg/day for 50 kg patient (120 mg/kg/day > 75) and > 4000 absolute
    expect(alerts.length).toBeGreaterThan(0);
  });
});

// ─── Ibuprofen (daily max) ─────────────────────────────────────

describe("checkWeightBasedDosing — Ibuprofen", () => {
  it("returns no alerts for safe daily ibuprofen dose", () => {
    // 70 kg: max 40 * 70 = 2800 mg/day
    // 400 mg x 3 = 1200 — safe
    const alerts = checkWeightBasedDosing({
      medicationName: "Ibuprofen",
      doseMg: 400,
      dosesPerDay: 3,
      weightKg: 70,
    });
    expect(alerts).toHaveLength(0);
  });

  it("flags high ibuprofen dose for small patient", () => {
    // 30 kg: max 40 * 30 = 1200 mg/day
    // 600 mg x 3 = 1800 — exceeds
    const alerts = checkWeightBasedDosing({
      medicationName: "Advil",
      doseMg: 600,
      dosesPerDay: 3,
      weightKg: 30,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("WARNING");
    expect(alerts[0].ruleId).toBe("DOSE-WT-IBU-001");
  });
});

// ─── Vancomycin (per-dose) ─────────────────────────────────────

describe("checkWeightBasedDosing — Vancomycin", () => {
  it("returns no alerts for typical vancomycin dose", () => {
    // 70 kg: max 20 * 70 = 1400 mg per dose
    const alerts = checkWeightBasedDosing({
      medicationName: "Vancomycin",
      doseMg: 1000,
      weightKg: 70,
    });
    expect(alerts).toHaveLength(0);
  });

  it("flags excessive vancomycin per-dose", () => {
    // 60 kg: max 20 * 60 = 1200 mg per dose; giving 1500 exceeds
    const alerts = checkWeightBasedDosing({
      medicationName: "Vancomycin",
      doseMg: 1500,
      weightKg: 60,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("WARNING");
    expect(alerts[0].message).toContain("mg/kg");
    expect(alerts[0].ruleId).toBe("DOSE-WT-VANC-001");
  });
});

// ─── Gentamicin (per-dose) ─────────────────────────────────────

describe("checkWeightBasedDosing — Gentamicin", () => {
  it("returns no alerts for typical gentamicin dose", () => {
    // 80 kg: max 7 * 80 = 560 mg per dose
    const alerts = checkWeightBasedDosing({
      medicationName: "Gentamicin",
      doseMg: 400,
      weightKg: 80,
    });
    expect(alerts).toHaveLength(0);
  });

  it("flags excessive gentamicin dose", () => {
    // 50 kg: max 7 * 50 = 350; giving 500 exceeds
    const alerts = checkWeightBasedDosing({
      medicationName: "Gentamicin",
      doseMg: 500,
      weightKg: 50,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe("WARNING");
    expect(alerts[0].ruleId).toBe("DOSE-WT-GENT-001");
  });
});

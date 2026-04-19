import { describe, it, expect } from "vitest";

// Contraindication rules (single-drug + condition interactions) live in
// their own module (issue #904). These were previously part of
// cross-specialty-rules.test.ts; the behavior and assertions are unchanged —
// only the entry point (checkContraindications) and file location differ.

import { checkContraindications } from "../rules/contraindications.js";
import {
  checkCrossSpecialtyPatterns,
  type PatientContext,
} from "../rules/cross-specialty.js";

describe("CROSS-ACE-ARB-PREG-001 — Pregnancy + ACE-I/ARB (teratogenic, all trimesters)", () => {
  const pregnantCtx = (
    meds: string[],
    overrides: Partial<PatientContext> = {},
  ): PatientContext => ({
    active_diagnoses: ["Pregnancy, second trimester"],
    active_diagnosis_codes: ["Z34.02"],
    active_medications: meds,
    new_symptoms: [],
    care_team_specialties: ["obstetrics"],
    ...overrides,
  });

  it.each([
    ["lisinopril 10mg daily"],
    ["enalapril 5mg BID"],
    ["ramipril"],
    ["captopril"],
    ["benazepril 20mg"],
    ["quinapril"],
    ["fosinopril"],
    ["perindopril"],
    ["trandolapril"],
    ["moexipril"],
  ])("fires CRITICAL for ACE inhibitor: %s", (drug) => {
    const flags = checkContraindications(pregnantCtx([drug]));
    const flag = flags.find((f) => f.rule_id === "CROSS-ACE-ARB-PREG-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
    expect(flag!.category).toBe("medication-safety");
    expect(flag!.notify_specialties).toContain("obstetrics");
  });

  it.each([
    ["losartan 50mg"],
    ["valsartan 80mg"],
    ["irbesartan 150mg"],
    ["candesartan"],
    ["olmesartan"],
    ["telmisartan 40mg"],
    ["azilsartan"],
    ["eprosartan"],
  ])("fires CRITICAL for ARB: %s", (drug) => {
    const flags = checkContraindications(pregnantCtx([drug]));
    const flag = flags.find((f) => f.rule_id === "CROSS-ACE-ARB-PREG-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
  });

  it.each([
    ["Cozaar 50mg", "losartan brand name"],
    ["Diovan 80mg", "valsartan brand name"],
    ["Benicar", "olmesartan brand name"],
    ["Micardis", "telmisartan brand name"],
    ["Vasotec", "enalapril brand name"],
    ["Altace", "ramipril brand name"],
    ["Lotensin", "benazepril brand name"],
    ["Capoten", "captopril brand name"],
  ])("fires CRITICAL for brand name: %s (%s)", (drug) => {
    const flags = checkContraindications(pregnantCtx([drug]));
    const flag = flags.find((f) => f.rule_id === "CROSS-ACE-ARB-PREG-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
  });

  it("fires when pregnancy detected by ICD-10 Z33 code", () => {
    const ctx = pregnantCtx(["Lisinopril 10mg"], {
      active_diagnoses: ["Pregnant state, incidental"],
      active_diagnosis_codes: ["Z33.1"],
    });
    const flag = checkContraindications(ctx).find(
      (f) => f.rule_id === "CROSS-ACE-ARB-PREG-001",
    );
    expect(flag).toBeDefined();
  });

  it("fires when pregnancy detected by ICD-10 O-code", () => {
    const ctx = pregnantCtx(["Losartan 50mg"], {
      active_diagnoses: ["Supervision of normal pregnancy"],
      active_diagnosis_codes: ["O09.91"],
    });
    const flag = checkContraindications(ctx).find(
      (f) => f.rule_id === "CROSS-ACE-ARB-PREG-001",
    );
    expect(flag).toBeDefined();
  });

  it("fires when pregnancy detected by description only (no ICD code)", () => {
    const ctx = pregnantCtx(["Enalapril 10mg"], {
      active_diagnoses: ["Pregnant, 22 weeks gestational age"],
      active_diagnosis_codes: [""],
    });
    const flag = checkContraindications(ctx).find(
      (f) => f.rule_id === "CROSS-ACE-ARB-PREG-001",
    );
    expect(flag).toBeDefined();
  });

  it("notifies both obstetrics and cardiology", () => {
    const flags = checkContraindications(pregnantCtx(["lisinopril"]));
    const flag = flags.find((f) => f.rule_id === "CROSS-ACE-ARB-PREG-001");
    expect(flag).toBeDefined();
    expect(flag!.notify_specialties).toEqual(
      expect.arrayContaining(["obstetrics", "cardiology"]),
    );
  });

  it("does NOT fire without pregnancy diagnosis", () => {
    const ctx: PatientContext = {
      active_diagnoses: ["Hypertension"],
      active_diagnosis_codes: ["I10"],
      active_medications: ["lisinopril 10mg"],
      new_symptoms: [],
      care_team_specialties: ["primary_care"],
    };
    const flag = checkContraindications(ctx).find(
      (f) => f.rule_id === "CROSS-ACE-ARB-PREG-001",
    );
    expect(flag).toBeUndefined();
  });

  it("does NOT fire for pregnant patient without ACE/ARB (pregnancy-safe antihypertensive)", () => {
    const flags = checkContraindications(
      pregnantCtx(["labetalol 200mg BID", "methyldopa 250mg"]),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-ACE-ARB-PREG-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire for pregnant patient on acetaminophen only", () => {
    const flags = checkContraindications(pregnantCtx(["acetaminophen 500mg"]));
    const flag = flags.find((f) => f.rule_id === "CROSS-ACE-ARB-PREG-001");
    expect(flag).toBeUndefined();
  });
});

describe("CROSS-METFORMIN-GFR-001 — Metformin + eGFR < 30 (contraindicated, lactic acidosis risk)", () => {
  const metforminCtx = (
    meds: string[],
    egfr: number | null,
    overrides: Partial<PatientContext> = {},
  ): PatientContext => ({
    active_diagnoses: ["Type 2 diabetes mellitus"],
    active_diagnosis_codes: ["E11.9"],
    active_medications: meds,
    new_symptoms: [],
    care_team_specialties: [],
    recent_labs:
      egfr === null
        ? []
        : [{ name: "eGFR", value: egfr, unit: "mL/min/1.73m²" }],
    ...overrides,
  });

  it("fires CRITICAL when metformin active and eGFR < 30 (positive case)", () => {
    const flags = checkContraindications(
      metforminCtx(["Metformin 500mg BID"], 25),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
    expect(flag!.category).toBe("cross-specialty");
    expect(flag!.notify_specialties).toContain("nephrology");
    expect(flag!.notify_specialties).toContain("endocrinology");
  });

  it("does NOT fire when eGFR >= 45 (no dose adjustment concern for this rule)", () => {
    const flags = checkContraindications(
      metforminCtx(["Metformin 1000mg BID"], 45),
    );
    expect(
      flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001"),
    ).toBeUndefined();
  });

  it("does NOT fire at eGFR exactly 30 (threshold is strict < 30, matches FDA labeling)", () => {
    const flags = checkContraindications(
      metforminCtx(["Metformin 500mg BID"], 30),
    );
    expect(
      flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001"),
    ).toBeUndefined();
  });

  it("fires at eGFR = 29 (just below threshold)", () => {
    const flags = checkContraindications(
      metforminCtx(["Metformin 500mg BID"], 29),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
  });

  it("does NOT fire when patient is not on metformin", () => {
    const flags = checkContraindications(
      metforminCtx(["Lisinopril 10mg", "Amlodipine 5mg"], 20),
    );
    expect(
      flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001"),
    ).toBeUndefined();
  });

  it("does NOT fire when eGFR is unknown (no lab value)", () => {
    const flags = checkContraindications(
      metforminCtx(["Metformin 500mg"], null),
    );
    expect(
      flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001"),
    ).toBeUndefined();
  });

  it("detects eGFR under the alternative lab name 'GFR'", () => {
    const flags = checkContraindications(
      metforminCtx(["Metformin 500mg"], null, {
        recent_labs: [{ name: "GFR", value: 20, unit: "mL/min/1.73m²" }],
      }),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001");
    expect(flag).toBeDefined();
  });

  it("detects eGFR under the alternative lab name 'Estimated GFR'", () => {
    const flags = checkContraindications(
      metforminCtx(["Metformin 500mg"], null, {
        recent_labs: [{ name: "Estimated GFR", value: 18, unit: "mL/min/1.73m²" }],
      }),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001");
    expect(flag).toBeDefined();
  });

  it("fires for branded metformin combo (e.g. Janumet)", () => {
    const flags = checkContraindications(
      metforminCtx(["Janumet 50-1000mg"], 22),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001");
    expect(flag).toBeDefined();
  });

  it("fires for Glucophage brand (generic metformin)", () => {
    const flags = checkContraindications(
      metforminCtx(["Glucophage 1000mg"], 25),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001");
    expect(flag).toBeDefined();
  });

  // Issue #873 — eGFR lab-name regex boundary cases. The pattern must accept
  // the canonical aliases ("GFR", "eGFR", "Estimated GFR", case-insensitive
  // with optional whitespace) while rejecting distinct labs that merely
  // embed "GFR" as a substring (e.g. "Pre-GFR Calc", "GFR Calculator").
  describe("eGFR lab-name alias matching (issue #873 boundary cases)", () => {
    it("matches lowercase 'egfr'", () => {
      const flags = checkContraindications(
        metforminCtx(["Metformin 500mg"], null, {
          recent_labs: [{ name: "egfr", value: 20, unit: "mL/min/1.73m²" }],
        }),
      );
      expect(
        flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001"),
      ).toBeDefined();
    });

    it("matches 'Estimated  GFR' with extra whitespace between words", () => {
      const flags = checkContraindications(
        metforminCtx(["Metformin 500mg"], null, {
          recent_labs: [{ name: "Estimated  GFR", value: 20, unit: "mL/min/1.73m²" }],
        }),
      );
      expect(
        flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001"),
      ).toBeDefined();
    });

    it("tolerates surrounding whitespace on the lab name", () => {
      const flags = checkContraindications(
        metforminCtx(["Metformin 500mg"], null, {
          recent_labs: [{ name: "  eGFR  ", value: 20, unit: "mL/min/1.73m²" }],
        }),
      );
      expect(
        flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001"),
      ).toBeDefined();
    });

    it("does NOT match 'Pre-GFR Calc' (distinct lab that merely contains GFR)", () => {
      const flags = checkContraindications(
        metforminCtx(["Metformin 500mg"], null, {
          recent_labs: [{ name: "Pre-GFR Calc", value: 20, unit: "mL/min/1.73m²" }],
        }),
      );
      expect(
        flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001"),
      ).toBeUndefined();
    });

    it("does NOT match 'GFR Calculator'", () => {
      const flags = checkContraindications(
        metforminCtx(["Metformin 500mg"], null, {
          recent_labs: [{ name: "GFR Calculator", value: 20, unit: "mL/min/1.73m²" }],
        }),
      );
      expect(
        flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001"),
      ).toBeUndefined();
    });

    it("does NOT match 'Pre-GFR'", () => {
      const flags = checkContraindications(
        metforminCtx(["Metformin 500mg"], null, {
          recent_labs: [{ name: "Pre-GFR", value: 20, unit: "mL/min/1.73m²" }],
        }),
      );
      expect(
        flags.find((f) => f.rule_id === "CROSS-METFORMIN-GFR-001"),
      ).toBeUndefined();
    });
  });
});

describe("CROSS-NSAID-CHF-001 — NSAID in heart failure", () => {
  const chfCtx = (
    meds: string[],
    diagnoses: string[] = ["Congestive heart failure"],
    codes: string[] = ["I50.9"],
  ): PatientContext => ({
    active_diagnoses: diagnoses,
    active_diagnosis_codes: codes,
    active_medications: meds,
    new_symptoms: [],
    care_team_specialties: ["cardiology"],
  });

  it("fires (warning) for NSAID in patient with CHF by ICD-10", () => {
    const flags = checkContraindications(chfCtx(["Ibuprofen 400mg TID"]));
    const flag = flags.find((f) => f.rule_id === "CROSS-NSAID-CHF-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.category).toBe("cross-specialty");
    expect(flag!.notify_specialties).toContain("cardiology");
    expect(flag!.suggested_action).toMatch(/acetaminophen/i);
  });

  it("fires (warning) for NSAID in patient with CHF by description alone", () => {
    const flags = checkContraindications(
      chfCtx(["Naproxen 500mg BID"], ["Heart failure, unspecified"], [""]),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-NSAID-CHF-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
  });

  it("fires for various NSAID brand names", () => {
    const meds = [
      "Advil 200mg",
      "Motrin 600mg",
      "Aleve 220mg",
      "Voltaren gel",
      "Celebrex 200mg",
      "Ketorolac IV",
      "Meloxicam 15mg",
    ];
    for (const med of meds) {
      const flags = checkContraindications(chfCtx([med]));
      const flag = flags.find((f) => f.rule_id === "CROSS-NSAID-CHF-001");
      expect(flag, `expected fire for ${med}`).toBeDefined();
    }
  });

  it("escalates to critical when CHF description is NYHA class III or IV", () => {
    const flags = checkContraindications(
      chfCtx(
        ["Ibuprofen 400mg"],
        ["Heart failure, NYHA class III, decompensated"],
        ["I50.9"],
      ),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-NSAID-CHF-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
    expect(flag!.suggested_action).toMatch(/Advanced \/ decompensated HF/i);
  });

  it("escalates to critical when diagnosis mentions EF <30%", () => {
    const flags = checkContraindications(
      chfCtx(
        ["Ibuprofen 400mg"],
        ["Systolic heart failure with ejection fraction of 22%"],
        ["I50.22"],
      ),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-NSAID-CHF-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("critical");
  });

  it("does NOT fire without an NSAID", () => {
    const flags = checkContraindications(
      chfCtx(["Lisinopril 10mg", "Metoprolol 50mg"]),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-NSAID-CHF-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire without a CHF diagnosis", () => {
    const flags = checkContraindications(
      chfCtx(["Ibuprofen 400mg"], ["Osteoarthritis"], ["M19.90"]),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-NSAID-CHF-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire for aspirin — not in NSAID_PATTERN match set", () => {
    // Low-dose aspirin is cardioprotective and not an NSAID per this rule's
    // pattern; should not misfire as a CHF contraindication.
    const flags = checkContraindications(
      chfCtx(["Aspirin 81mg daily"]),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-NSAID-CHF-001");
    expect(flag).toBeUndefined();
  });

  it("matches CHF via I11.0 hypertensive heart disease code", () => {
    const flags = checkContraindications(
      chfCtx(
        ["Ibuprofen 400mg"],
        ["Hypertensive heart disease with heart failure"],
        ["I11.0"],
      ),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-NSAID-CHF-001");
    expect(flag).toBeDefined();
  });

  it("boundary: warning (not critical) for compensated CHF without severity cues", () => {
    const flags = checkContraindications(
      chfCtx(
        ["Ibuprofen 400mg"],
        ["Chronic systolic heart failure, stable"],
        ["I50.22"],
      ),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-NSAID-CHF-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
  });
});

// ─── CROSS-STATIN-HEPATIC-001 — statin + severe hepatic impairment (#237) ──

describe("CROSS-STATIN-HEPATIC-001 — statin in severe hepatic impairment", () => {
  const hepCtx = (
    meds: string[],
    diagnoses: string[],
    codes: string[] = [],
  ): PatientContext => ({
    active_diagnoses: diagnoses,
    active_diagnosis_codes: codes,
    active_medications: meds,
    new_symptoms: [],
    care_team_specialties: ["hepatology"],
  });

  it("fires for any-dose statin + hepatic failure (ICD-10 K72)", () => {
    const flags = checkContraindications(
      hepCtx(["Atorvastatin 10mg"], ["Acute hepatic failure"], ["K72.00"]),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-STATIN-HEPATIC-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.category).toBe("cross-specialty");
    expect(flag!.notify_specialties).toContain("hepatology");
  });

  it("fires for statin + decompensated cirrhosis by description", () => {
    const flags = checkContraindications(
      hepCtx(
        ["Rosuvastatin 5mg"],
        ["Decompensated cirrhosis with ascites"],
        [""],
      ),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-STATIN-HEPATIC-001");
    expect(flag).toBeDefined();
  });

  it("fires for statin + Child-Pugh C cirrhosis description", () => {
    const flags = checkContraindications(
      hepCtx(["Simvastatin 20mg"], ["Child-Pugh C cirrhosis"], [""]),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-STATIN-HEPATIC-001");
    expect(flag).toBeDefined();
  });

  it("fires for statin + AST >3x ULN description (transaminase elevation)", () => {
    const flags = checkContraindications(
      hepCtx(
        ["Pravastatin 40mg"],
        ["Drug-induced hepatitis, AST >3x ULN"],
        [""],
      ),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-STATIN-HEPATIC-001");
    expect(flag).toBeDefined();
  });

  it("fires for various statin names (low dose)", () => {
    const statins = [
      "Lipitor 10mg",
      "Crestor 5mg",
      "Zocor 10mg",
      "Pravachol 20mg",
      "Lovastatin 20mg",
      "Pitavastatin 1mg",
    ];
    for (const statin of statins) {
      const flags = checkContraindications(
        hepCtx([statin], ["Acute liver failure"], ["K72.00"]),
      );
      const flag = flags.find((f) => f.rule_id === "CROSS-STATIN-HEPATIC-001");
      expect(flag, `expected fire for ${statin}`).toBeDefined();
    }
  });

  it("does NOT fire for statin + mild chronic hepatitis (no severe cues)", () => {
    // Baseline chronic hepatitis without explicit severe descriptors — a
    // stable chronic-hepatitis-B carrier on a low-dose statin should not
    // trip this particular rule (a broader HEPATIC-HEPATOTOXIN-001 would
    // catch high-dose statins in that scenario; see cross-specialty.ts).
    const flags = checkContraindications(
      hepCtx(["Atorvastatin 10mg"], ["Chronic hepatitis B"], ["B18.1"]),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-STATIN-HEPATIC-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire for statin + healthy patient (no hepatic diagnosis)", () => {
    const flags = checkContraindications(
      hepCtx(["Atorvastatin 80mg"], ["Hyperlipidemia"], ["E78.5"]),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-STATIN-HEPATIC-001");
    expect(flag).toBeUndefined();
  });

  it("does NOT fire without a statin (severe hepatic disease alone is not enough)", () => {
    const flags = checkContraindications(
      hepCtx(
        ["Lactulose", "Rifaximin"],
        ["Decompensated cirrhosis"],
        [""],
      ),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-STATIN-HEPATIC-001");
    expect(flag).toBeUndefined();
  });

  it("suggested action names non-hepatic alternatives (bile acid sequestrant, ezetimibe)", () => {
    const flags = checkContraindications(
      hepCtx(["Atorvastatin 10mg"], ["Acute hepatic failure"], ["K72.00"]),
    );
    const flag = flags.find((f) => f.rule_id === "CROSS-STATIN-HEPATIC-001");
    expect(flag).toBeDefined();
    expect(flag!.suggested_action).toMatch(/ezetimibe|bile.?acid/i);
  });

  it("fires alongside HEPATIC-HEPATOTOXIN-001 for high-dose statin + severe hepatic disease", () => {
    // Both rules have legitimate, non-duplicative messaging: hepatotoxin rule
    // explains the broad hepatotoxin category; statin-hepatic rule gives the
    // any-dose-severe specialised guidance. Reviewer sees both. Issue #904
    // split these across two modules; the composition invariant still holds.
    const ctx = hepCtx(
      ["Atorvastatin 80mg"],
      ["Acute hepatic failure"],
      ["K72.00"],
    );
    const contraindicationFlags = checkContraindications(ctx);
    const crossSpecialtyFlags = checkCrossSpecialtyPatterns(ctx);
    expect(
      contraindicationFlags.find((f) => f.rule_id === "CROSS-STATIN-HEPATIC-001"),
    ).toBeDefined();
    expect(
      crossSpecialtyFlags.find((f) => f.rule_id === "HEPATIC-HEPATOTOXIN-001"),
    ).toBeDefined();
  });
});

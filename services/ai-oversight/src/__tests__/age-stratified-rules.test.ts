/**
 * Unit tests for age-stratified safety rules (issue #236).
 *
 * Each rule is exercised for:
 *   - positive: the rule fires when preconditions are met.
 *   - negative (wrong drug): a different medication in the same class boundary
 *     does not trigger the rule.
 *   - negative (wrong age): an in-range med with an out-of-band age does NOT
 *     fire — confirms the age gate.
 *   - boundary: exactly at the age cutoff (65 for Beers, 18 for pediatric,
 *     8 for tetracycline).
 *   - missing-context: unknown age (null / undefined) must not fire.
 *
 * These rules are pure — no DB mocks required.
 */

import { describe, it, expect } from "vitest";

import {
  checkAgeStratifiedRules,
} from "../rules/age-stratified.js";
import type { PatientContext } from "../rules/cross-specialty.js";

/** Build a context with sensible defaults. Callers override as needed. */
function ctxWith(overrides: Partial<PatientContext> = {}): PatientContext {
  return {
    active_diagnoses: [],
    active_diagnosis_codes: [],
    active_medications: [],
    new_symptoms: [],
    care_team_specialties: [],
    age_years: null,
    ...overrides,
  };
}

// ─── GERI-BENZO-001 — benzodiazepine in elderly (Beers) ───────────────

describe("GERI-BENZO-001 — benzodiazepine in elderly", () => {
  it("fires (warning) for a 72-year-old on diazepam", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 72, active_medications: ["Diazepam 5mg PO BID"] }),
    );
    const flag = flags.find((f) => f.rule_id === "GERI-BENZO-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.category).toBe("medication-safety");
    expect(flag!.notify_specialties).toContain("geriatrics");
    expect(flag!.suggested_action).toMatch(/taper/i);
  });

  it("fires across the benzodiazepine class (lorazepam, alprazolam, clonazepam, temazepam)", () => {
    for (const med of [
      "Lorazepam 0.5mg",
      "Alprazolam 0.25mg",
      "Clonazepam 1mg",
      "Temazepam 15mg",
      "Oxazepam 10mg",
      "Midazolam IV",
    ]) {
      const flags = checkAgeStratifiedRules(
        ctxWith({ age_years: 78, active_medications: [med] }),
      );
      expect(
        flags.find((f) => f.rule_id === "GERI-BENZO-001"),
        `expected fire for ${med}`,
      ).toBeDefined();
    }
  });

  it("does NOT fire for a non-benzodiazepine anxiolytic (buspirone)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 80, active_medications: ["Buspirone 10mg TID"] }),
    );
    expect(flags.find((f) => f.rule_id === "GERI-BENZO-001")).toBeUndefined();
  });

  it("does NOT fire for a 40-year-old (wrong age band)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 40, active_medications: ["Diazepam 5mg"] }),
    );
    expect(flags.find((f) => f.rule_id === "GERI-BENZO-001")).toBeUndefined();
  });

  it("fires exactly at age 65 boundary", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 65, active_medications: ["Alprazolam 0.25mg"] }),
    );
    expect(flags.find((f) => f.rule_id === "GERI-BENZO-001")).toBeDefined();
  });

  it("does NOT fire at age 64.9 (just under boundary)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 64.9, active_medications: ["Alprazolam 0.25mg"] }),
    );
    expect(flags.find((f) => f.rule_id === "GERI-BENZO-001")).toBeUndefined();
  });

  it("fails closed when age is unknown (null)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: null, active_medications: ["Diazepam 5mg"] }),
    );
    expect(flags.find((f) => f.rule_id === "GERI-BENZO-001")).toBeUndefined();
  });

  it("fails closed when age is undefined", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: undefined, active_medications: ["Diazepam 5mg"] }),
    );
    expect(flags.find((f) => f.rule_id === "GERI-BENZO-001")).toBeUndefined();
  });
});

// ─── GERI-ANTIHIST-001 — first-gen antihistamine in elderly ───────────

describe("GERI-ANTIHIST-001 — first-gen antihistamine in elderly", () => {
  it("fires for 70-year-old on diphenhydramine", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 70,
        active_medications: ["Diphenhydramine 25mg PO qHS"],
      }),
    );
    const flag = flags.find((f) => f.rule_id === "GERI-ANTIHIST-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.suggested_action).toMatch(/loratadine|cetirizine|fexofenadine/i);
  });

  it("fires across first-gen antihistamines (hydroxyzine, promethazine, chlorpheniramine)", () => {
    for (const med of [
      "Hydroxyzine 25mg",
      "Promethazine 12.5mg",
      "Chlorpheniramine 4mg",
      "Meclizine 25mg",
    ]) {
      const flags = checkAgeStratifiedRules(
        ctxWith({ age_years: 75, active_medications: [med] }),
      );
      expect(
        flags.find((f) => f.rule_id === "GERI-ANTIHIST-001"),
        `expected fire for ${med}`,
      ).toBeDefined();
    }
  });

  it("does NOT fire for second-gen antihistamines (loratadine, cetirizine, fexofenadine)", () => {
    for (const med of ["Loratadine 10mg", "Cetirizine 10mg", "Fexofenadine 180mg"]) {
      const flags = checkAgeStratifiedRules(
        ctxWith({ age_years: 75, active_medications: [med] }),
      );
      expect(
        flags.find((f) => f.rule_id === "GERI-ANTIHIST-001"),
        `must not fire for ${med}`,
      ).toBeUndefined();
    }
  });

  it("does NOT fire for a 30-year-old on diphenhydramine (age gate)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 30, active_medications: ["Diphenhydramine 25mg"] }),
    );
    expect(flags.find((f) => f.rule_id === "GERI-ANTIHIST-001")).toBeUndefined();
  });

  it("fails closed when age is unknown", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: null, active_medications: ["Diphenhydramine 25mg"] }),
    );
    expect(flags.find((f) => f.rule_id === "GERI-ANTIHIST-001")).toBeUndefined();
  });
});

// ─── GERI-NSAID-CHRONIC-001 — chronic NSAID use in elderly ────────────

describe("GERI-NSAID-CHRONIC-001 — chronic NSAID in elderly", () => {
  it("fires for 68-year-old on ibuprofen", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 68, active_medications: ["Ibuprofen 600mg TID"] }),
    );
    const flag = flags.find((f) => f.rule_id === "GERI-NSAID-CHRONIC-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.suggested_action).toMatch(/acetaminophen/i);
  });

  it("fires across NSAID class (naproxen, celecoxib, meloxicam, diclofenac)", () => {
    for (const med of [
      "Naproxen 500mg",
      "Celecoxib 200mg",
      "Meloxicam 15mg",
      "Diclofenac 50mg",
      "Ketorolac IV",
    ]) {
      const flags = checkAgeStratifiedRules(
        ctxWith({ age_years: 72, active_medications: [med] }),
      );
      expect(
        flags.find((f) => f.rule_id === "GERI-NSAID-CHRONIC-001"),
        `expected fire for ${med}`,
      ).toBeDefined();
    }
  });

  it("does NOT fire for 40-year-old on NSAID (age gate)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 40, active_medications: ["Naproxen 500mg"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "GERI-NSAID-CHRONIC-001"),
    ).toBeUndefined();
  });

  it("does NOT fire for elderly on acetaminophen (not an NSAID)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 80,
        active_medications: ["Acetaminophen 500mg"],
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "GERI-NSAID-CHRONIC-001"),
    ).toBeUndefined();
  });
});

// ─── GERI-ANTICHOL-DEMENTIA-001 — anticholinergic in dementia ─────────

describe("GERI-ANTICHOL-DEMENTIA-001 — anticholinergic + dementia", () => {
  it("fires for 78-year-old with Alzheimer's on oxybutynin", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 78,
        active_diagnoses: ["Alzheimer disease with behavioral disturbance"],
        active_diagnosis_codes: ["G30.9"],
        active_medications: ["Oxybutynin 5mg BID"],
      }),
    );
    const flag = flags.find((f) => f.rule_id === "GERI-ANTICHOL-DEMENTIA-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.suggested_action).toMatch(/mirabegron/i);
  });

  it("matches dementia by ICD-10 family (F01 vascular dementia)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 82,
        active_diagnoses: ["Vascular dementia"],
        active_diagnosis_codes: ["F01.50"],
        active_medications: ["Amitriptyline 25mg"],
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "GERI-ANTICHOL-DEMENTIA-001"),
    ).toBeDefined();
  });

  it("does NOT fire for anticholinergic in elderly WITHOUT dementia", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 70,
        active_diagnoses: ["Urinary incontinence"],
        active_diagnosis_codes: ["N39.41"],
        active_medications: ["Oxybutynin 5mg"],
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "GERI-ANTICHOL-DEMENTIA-001"),
    ).toBeUndefined();
  });

  it("does NOT fire for dementia + non-anticholinergic (e.g. donepezil)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 80,
        active_diagnoses: ["Alzheimer disease"],
        active_diagnosis_codes: ["G30.9"],
        active_medications: ["Donepezil 10mg"],
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "GERI-ANTICHOL-DEMENTIA-001"),
    ).toBeUndefined();
  });

  it("does NOT fire for dementia patient under 65 (age gate still applies)", () => {
    // Early-onset dementia in a 58-year-old is medically plausible but this
    // rule is framed as a Beers-elderly rule; the cognitive-harm mechanism
    // is the same but this particular rule's population scope is >= 65.
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 58,
        active_diagnoses: ["Early-onset Alzheimer disease"],
        active_diagnosis_codes: ["G30.0"],
        active_medications: ["Oxybutynin 5mg"],
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "GERI-ANTICHOL-DEMENTIA-001"),
    ).toBeUndefined();
  });

  it("fails closed when age is unknown even with dementia + anticholinergic", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: null,
        active_diagnoses: ["Alzheimer disease"],
        active_diagnosis_codes: ["G30.9"],
        active_medications: ["Oxybutynin 5mg"],
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "GERI-ANTICHOL-DEMENTIA-001"),
    ).toBeUndefined();
  });
});

// ─── PEDI-FLUOROQUINOLONE-001 — fluoroquinolone in pediatric ──────────

describe("PEDI-FLUOROQUINOLONE-001 — fluoroquinolone in pediatric", () => {
  it("fires for a 10-year-old on ciprofloxacin", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 10, active_medications: ["Ciprofloxacin 250mg BID"] }),
    );
    const flag = flags.find((f) => f.rule_id === "PEDI-FLUOROQUINOLONE-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.notify_specialties).toContain("pediatrics");
    expect(flag!.suggested_action).toMatch(/alternative/i);
  });

  it("fires across the fluoroquinolone class", () => {
    for (const med of [
      "Levofloxacin 250mg",
      "Moxifloxacin 400mg",
      "Ofloxacin",
      "Delafloxacin",
    ]) {
      const flags = checkAgeStratifiedRules(
        ctxWith({ age_years: 14, active_medications: [med] }),
      );
      expect(
        flags.find((f) => f.rule_id === "PEDI-FLUOROQUINOLONE-001"),
        `expected fire for ${med}`,
      ).toBeDefined();
    }
  });

  it("does NOT fire for a non-fluoroquinolone antibiotic (amoxicillin)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 10, active_medications: ["Amoxicillin 500mg"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-FLUOROQUINOLONE-001"),
    ).toBeUndefined();
  });

  it("does NOT fire for a 40-year-old on ciprofloxacin (adult ok)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 40, active_medications: ["Ciprofloxacin 500mg"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-FLUOROQUINOLONE-001"),
    ).toBeUndefined();
  });

  it("fires at age 17.9 (just under 18 boundary)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 17.9, active_medications: ["Ciprofloxacin 500mg"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-FLUOROQUINOLONE-001"),
    ).toBeDefined();
  });

  it("does NOT fire at age 18 exactly (boundary exclusive)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 18, active_medications: ["Ciprofloxacin 500mg"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-FLUOROQUINOLONE-001"),
    ).toBeUndefined();
  });

  it("fails closed when age is unknown", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: null, active_medications: ["Ciprofloxacin 500mg"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-FLUOROQUINOLONE-001"),
    ).toBeUndefined();
  });
});

// ─── PEDI-ASPIRIN-VIRAL-001 — aspirin in pediatric viral illness ──────

describe("PEDI-ASPIRIN-VIRAL-001 — aspirin + viral illness (Reye's)", () => {
  it("fires for 8-year-old with influenza on aspirin", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 8,
        active_diagnoses: ["Influenza A"],
        active_diagnosis_codes: ["J10.1"],
        active_medications: ["Aspirin 81mg"],
      }),
    );
    const flag = flags.find((f) => f.rule_id === "PEDI-ASPIRIN-VIRAL-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.suggested_action).toMatch(/acetaminophen|ibuprofen/i);
    expect(flag!.rationale).toMatch(/Reye/i);
  });

  it("matches viral illnesses broadly (varicella, COVID, mononucleosis)", () => {
    for (const dx of [
      "Varicella (chickenpox)",
      "COVID-19 infection",
      "Infectious mononucleosis",
      "Viral gastroenteritis",
      "Respiratory syncytial virus bronchiolitis",
    ]) {
      const flags = checkAgeStratifiedRules(
        ctxWith({
          age_years: 12,
          active_diagnoses: [dx],
          active_diagnosis_codes: [""],
          active_medications: ["Aspirin 325mg"],
        }),
      );
      expect(
        flags.find((f) => f.rule_id === "PEDI-ASPIRIN-VIRAL-001"),
        `expected fire for ${dx}`,
      ).toBeDefined();
    }
  });

  it("does NOT fire for pediatric aspirin without a viral illness (e.g. Kawasaki alone)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 5,
        active_diagnoses: ["Kawasaki disease"],
        active_diagnosis_codes: ["M30.3"],
        active_medications: ["Aspirin 81mg"],
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-ASPIRIN-VIRAL-001"),
    ).toBeUndefined();
  });

  it("does NOT fire for adult with influenza on aspirin", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 45,
        active_diagnoses: ["Influenza"],
        active_diagnosis_codes: ["J10.1"],
        active_medications: ["Aspirin 325mg"],
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-ASPIRIN-VIRAL-001"),
    ).toBeUndefined();
  });

  it("does NOT fire for pediatric viral illness + acetaminophen (no aspirin)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 10,
        active_diagnoses: ["Influenza"],
        active_diagnosis_codes: ["J10.1"],
        active_medications: ["Acetaminophen 160mg/5mL"],
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-ASPIRIN-VIRAL-001"),
    ).toBeUndefined();
  });

  it("fires with Kawasaki + concurrent viral illness (documents risk)", () => {
    // A Kawasaki patient on aspirin who develops a viral illness must have
    // the exposure surfaced — cardiology oversight of aspirin during viral
    // intercurrent illness is explicit in the suggested action.
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 4,
        active_diagnoses: ["Kawasaki disease", "Influenza A"],
        active_diagnosis_codes: ["M30.3", "J10.1"],
        active_medications: ["Aspirin 81mg daily"],
      }),
    );
    const flag = flags.find((f) => f.rule_id === "PEDI-ASPIRIN-VIRAL-001");
    expect(flag).toBeDefined();
    expect(flag!.suggested_action).toMatch(/cardiology/i);
  });

  it("fails closed when age is unknown", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: null,
        active_diagnoses: ["Influenza"],
        active_diagnosis_codes: ["J10.1"],
        active_medications: ["Aspirin 325mg"],
      }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-ASPIRIN-VIRAL-001"),
    ).toBeUndefined();
  });
});

// ─── PEDI-TETRACYCLINE-001 — tetracycline in pediatric under 8 ────────

describe("PEDI-TETRACYCLINE-001 — tetracycline in children < 8", () => {
  it("fires for 5-year-old on doxycycline", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 5,
        active_medications: ["Doxycycline 100mg PO BID"],
      }),
    );
    const flag = flags.find((f) => f.rule_id === "PEDI-TETRACYCLINE-001");
    expect(flag).toBeDefined();
    expect(flag!.severity).toBe("warning");
    expect(flag!.notify_specialties).toContain("pediatrics");
    expect(flag!.suggested_action).toMatch(/amoxicillin|cephalosporin|azithromycin/i);
  });

  it("fires across tetracycline class", () => {
    for (const med of [
      "Tetracycline 250mg",
      "Minocycline 100mg",
      "Demeclocycline",
      "Tigecycline",
    ]) {
      const flags = checkAgeStratifiedRules(
        ctxWith({ age_years: 6, active_medications: [med] }),
      );
      expect(
        flags.find((f) => f.rule_id === "PEDI-TETRACYCLINE-001"),
        `expected fire for ${med}`,
      ).toBeDefined();
    }
  });

  it("does NOT fire at age 8 exactly (boundary exclusive)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 8, active_medications: ["Doxycycline 100mg"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-TETRACYCLINE-001"),
    ).toBeUndefined();
  });

  it("fires at age 7.9 (just under boundary)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 7.9, active_medications: ["Doxycycline 100mg"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-TETRACYCLINE-001"),
    ).toBeDefined();
  });

  it("does NOT fire for a 12-year-old (teen — outside dental-development window)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 12, active_medications: ["Doxycycline 100mg"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-TETRACYCLINE-001"),
    ).toBeUndefined();
  });

  it("does NOT fire for a 5-year-old on amoxicillin (not a tetracycline)", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: 5, active_medications: ["Amoxicillin 400mg/5mL"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-TETRACYCLINE-001"),
    ).toBeUndefined();
  });

  it("fails closed when age is unknown", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({ age_years: null, active_medications: ["Doxycycline 100mg"] }),
    );
    expect(
      flags.find((f) => f.rule_id === "PEDI-TETRACYCLINE-001"),
    ).toBeUndefined();
  });
});

// ─── Cross-rule parity / sanity ───────────────────────────────────────

describe("age-stratified rules — cross-rule behaviour", () => {
  it("returns empty array when patient has no meds (regardless of age)", () => {
    expect(
      checkAgeStratifiedRules(
        ctxWith({ age_years: 75, active_medications: [] }),
      ),
    ).toEqual([]);
    expect(
      checkAgeStratifiedRules(ctxWith({ age_years: 5, active_medications: [] })),
    ).toEqual([]);
  });

  it("returns empty array when age is null — all rules are age-gated", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: null,
        active_diagnoses: ["Influenza", "Alzheimer disease"],
        active_medications: [
          "Diazepam 5mg",
          "Diphenhydramine 25mg",
          "Ibuprofen 600mg",
          "Oxybutynin 5mg",
          "Ciprofloxacin 500mg",
          "Aspirin 325mg",
          "Doxycycline 100mg",
        ],
      }),
    );
    expect(flags).toEqual([]);
  });

  it("an elderly patient on multiple Beers-problem drugs fires all applicable rules independently", () => {
    const flags = checkAgeStratifiedRules(
      ctxWith({
        age_years: 82,
        active_diagnoses: ["Alzheimer disease"],
        active_diagnosis_codes: ["G30.9"],
        active_medications: [
          "Lorazepam 0.5mg",
          "Diphenhydramine 25mg",
          "Naproxen 500mg",
          "Oxybutynin 5mg",
        ],
      }),
    );
    const ids = flags.map((f) => f.rule_id).sort();
    expect(ids).toContain("GERI-BENZO-001");
    expect(ids).toContain("GERI-ANTIHIST-001");
    expect(ids).toContain("GERI-NSAID-CHRONIC-001");
    expect(ids).toContain("GERI-ANTICHOL-DEMENTIA-001");
  });
});

import { describe, it, expect } from "vitest";
import { checkAllergyMedication } from "./allergy-medication.js";
import type { PatientContext } from "./cross-specialty.js";

function makeContext(
  allergies: PatientContext["allergies"],
  medications: string[],
): PatientContext {
  return {
    active_diagnoses: [],
    active_diagnosis_codes: [],
    active_medications: medications,
    new_symptoms: [],
    care_team_specialties: [],
    allergies,
  };
}

describe("allergy-medication rule IDs", () => {
  it("produces unique rule IDs across all flags in a single invocation", () => {
    const ctx = makeContext(
      [
        { allergen: "Penicillin", severity: "severe", reaction: "anaphylaxis" },
        { allergen: "Sulfa", severity: "moderate", reaction: "rash" },
        { allergen: "Ibuprofen", severity: "mild", reaction: "hives" },
      ],
      [
        "Amoxicillin 500mg",
        "Cefazolin 1g",
        "Sulfamethoxazole 800mg",
        "Naproxen 500mg",
      ],
    );

    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);

    const ruleIds = flags.map((f) => f.rule_id);
    const uniqueIds = new Set(ruleIds);
    expect(uniqueIds.size).toBe(ruleIds.length);
  });

  it("produces deterministic IDs across repeated calls", () => {
    const ctx = makeContext(
      [{ allergen: "Penicillin", severity: "severe", reaction: "anaphylaxis" }],
      ["Amoxicillin 500mg"],
    );

    const first = checkAllergyMedication(ctx);
    const second = checkAllergyMedication(ctx);

    expect(first.length).toBeGreaterThan(0);
    expect(first.map((f) => f.rule_id)).toEqual(second.map((f) => f.rule_id));
  });

  it("generates distinct IDs for direct vs cross-reactivity matches", () => {
    // Penicillin allergy with a penicillin drug (direct) vs cephalosporin (cross)
    const ctx = makeContext(
      [{ allergen: "Penicillin", severity: "severe", reaction: "anaphylaxis" }],
      ["Penicillin V 500mg", "Cefazolin 1g"],
    );

    const flags = checkAllergyMedication(ctx);
    const ruleIds = flags.map((f) => f.rule_id);
    const uniqueIds = new Set(ruleIds);
    expect(uniqueIds.size).toBe(ruleIds.length);
  });

  it("returns no flags when no allergies are present", () => {
    const ctx = makeContext([], ["Amoxicillin 500mg"]);
    expect(checkAllergyMedication(ctx)).toHaveLength(0);
  });
});

describe("allergy-medication allergen normalization (#232)", () => {
  // Before #232, shorthand allergens never matched generic prescriptions
  // because the direct-match compare only looked at `allergen.toLowerCase()`
  // and the CROSS_REACTIVITY_MAP's allergen regex. PCN, Lovenox, ASA, APAP
  // slipped through. These cases lock the fix in.

  it("PCN allergy flags an amoxicillin prescription (direct class match)", () => {
    const ctx = makeContext(
      [{ allergen: "PCN", severity: "severe", reaction: "anaphylaxis" }],
      ["Amoxicillin 500mg PO q8h"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]!.summary).toMatch(/amoxicillin/i);
  });

  it("PCN allergy flags a cefazolin prescription via penicillin-cephalosporin cross-reactivity", () => {
    const ctx = makeContext(
      [{ allergen: "PCN", severity: "severe", reaction: "anaphylaxis" }],
      ["Cefazolin 1g IV"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
    const summary = flags.map((f) => f.summary).join(" ");
    expect(summary).toMatch(/cross.?react|cefazolin/i);
  });

  it("Lovenox allergy flags an enoxaparin prescription", () => {
    const ctx = makeContext(
      [{ allergen: "Lovenox", severity: "severe", reaction: "HIT" }],
      ["Enoxaparin 40mg SQ daily"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
  });

  it("Sulfa allergy flags a sulfamethoxazole prescription", () => {
    const ctx = makeContext(
      [{ allergen: "Sulfa", severity: "moderate", reaction: "rash" }],
      ["Sulfamethoxazole-trimethoprim 800/160mg"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
  });

  it("ASA allergy flags ibuprofen via NSAID class (AERD coverage)", () => {
    const ctx = makeContext(
      [{ allergen: "ASA", severity: "moderate", reaction: "bronchospasm" }],
      ["Ibuprofen 400mg PO q6h"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
    expect(flags[0]!.summary.toLowerCase()).toContain("ibuprofen");
  });

  it("APAP allergy flags a Tylenol prescription", () => {
    const ctx = makeContext(
      [{ allergen: "APAP", severity: "mild", reaction: "itch" }],
      ["Tylenol 500mg PO q6h PRN"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
  });

  it("ACE-I shorthand flags a lisinopril prescription", () => {
    const ctx = makeContext(
      [{ allergen: "ACE-I", severity: "moderate", reaction: "angioedema" }],
      ["Lisinopril 10mg PO daily"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
  });

  it("Vancomycin allergy flags a teicoplanin Rx via glycopeptide cross-reactivity (#1018)", () => {
    // Sentinel for the glycopeptide class. Vancomycin → teicoplanin is
    // the most clinically common scenario; FDA Dalvance PI § 5.2 warns
    // about the shared backbone driving cross-allergenic hypersensitivity.
    const ctx = makeContext(
      [{ allergen: "Vancomycin", severity: "severe", reaction: "DRESS / red-man syndrome" }],
      ["Teicoplanin 400mg IV daily"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
    const summary = flags.map((f) => f.summary).join(" ");
    expect(summary).toMatch(/cross.?react|glycopeptide|teicoplanin/i);
  });

  it("Vancomycin allergy flags a dalbavancin Rx (second-generation lipoglycopeptide)", () => {
    // Covers the lipoglycopeptide sub-class — dalbavancin / oritavancin /
    // telavancin all share the glycopeptide backbone and the same
    // cross-allergenic class per FDA labelling.
    const ctx = makeContext(
      [{ allergen: "Vancomycin", severity: "severe", reaction: "anaphylaxis" }],
      ["Dalbavancin 1500mg IV"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
  });

  it("unknown allergen keeps existing behavior (pass-through)", () => {
    // Salmon isn't in our synonym table; no cross-reactive med should trip
    // the allergy-med rule spuriously.
    const ctx = makeContext(
      [{ allergen: "Salmon", severity: "severe", reaction: "anaphylaxis" }],
      ["Amoxicillin 500mg"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags).toHaveLength(0);
  });

  it("PCN allergy does NOT false-positive on pentoxifylline (substring collision)", () => {
    // Before the alias-set fix the "pen" alias under penicillin caused
    // substring hits on "pentoxifylline" and over-flagged an unrelated
    // medication. "pen" is now excluded; aliases shorter than 4 chars
    // that remain (pcn, pnc, asa, etc.) go through a word-boundary check.
    const ctx = makeContext(
      [{ allergen: "PCN", severity: "severe", reaction: "anaphylaxis" }],
      ["Pentoxifylline 400mg TID"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags).toHaveLength(0);
  });

  // ── Issue #994: 4-letter abbreviation substring false-positives ────────
  //
  // ALLERGEN_SYNONYMS includes 4-letter abbreviations (amox, ampi, apap,
  // lmwh, acei). The original direct-match path applied word-boundary
  // checks only for aliases with length < 4, so the 4-char abbreviations
  // hit via substring match anywhere in the medication name. This caused
  // unrelated drugs whose names happened to contain those 4 chars to
  // produce a false-positive allergy flag at order time.
  //
  // The fix tightens the boundary check to length <= 4 so every known
  // 4-letter abbreviation uses word-boundary matching, while genuine
  // class-level matches still work via the longer canonical alias
  // (e.g. PCN → penicillin → "amoxicillin" full string).

  it("PCN allergy does NOT false-positive on amoxapine via the 'amox' alias (#994)", () => {
    // Amoxapine is a tetracyclic antidepressant. Pre-#994 the 4-letter
    // alias "amox" hit it via substring match against the PCN canonical
    // class. Now the word-boundary check rejects the match — "amox" is
    // not a separate token inside "amoxapine".
    const ctx = makeContext(
      [{ allergen: "PCN", severity: "severe", reaction: "anaphylaxis" }],
      ["Amoxapine 50mg PO BID"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags).toHaveLength(0);
  });

  it("PCN allergy DOES still flag amoxicillin (regression guard for #994 fix)", () => {
    // The fix must not break the legitimate match. Amoxicillin is in the
    // alias set as a full canonical name (length 11), so the substring
    // path still catches it regardless of the boundary tightening.
    const ctx = makeContext(
      [{ allergen: "PCN", severity: "severe", reaction: "anaphylaxis" }],
      ["Amoxicillin 500mg PO q8h"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags.length).toBeGreaterThan(0);
  });

  it("Penicillin allergy does NOT false-positive on ampyra via the 'ampi' alias (#994)", () => {
    // Ampyra (dalfampridine) is an MS treatment. The 4-letter alias
    // "ampi" under penicillin would have matched substring-wise.
    const ctx = makeContext(
      [
        {
          allergen: "Penicillin",
          severity: "moderate",
          reaction: "rash",
        },
      ],
      ["Ampyra 10mg PO BID"],
    );
    const flags = checkAllergyMedication(ctx);
    expect(flags).toHaveLength(0);
  });
});

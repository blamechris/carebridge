import { describe, it, expect } from "vitest";
import {
  ALLERGEN_SYNONYMS,
  normalizeAllergen,
  expandAllergenAliases,
} from "../allergen-synonyms.js";

describe("normalizeAllergen (#232)", () => {
  it("resolves PCN → penicillin", () => {
    expect(normalizeAllergen("PCN")).toBe("penicillin");
    expect(normalizeAllergen("pcn")).toBe("penicillin");
  });

  it("resolves brand Lovenox → heparin class", () => {
    expect(normalizeAllergen("Lovenox")).toBe("heparin");
  });

  it("resolves Coumadin → warfarin", () => {
    expect(normalizeAllergen("Coumadin")).toBe("warfarin");
  });

  it("resolves Sulfa → sulfonamide", () => {
    expect(normalizeAllergen("Sulfa")).toBe("sulfonamide");
    expect(normalizeAllergen("sulfa drugs")).toBe("sulfonamide");
  });

  it("resolves Tylenol → acetaminophen", () => {
    expect(normalizeAllergen("Tylenol")).toBe("acetaminophen");
    expect(normalizeAllergen("APAP")).toBe("acetaminophen");
  });

  it("resolves Advil / Motrin / NSAIDs → nsaid", () => {
    expect(normalizeAllergen("Motrin")).toBe("nsaid");
    expect(normalizeAllergen("Advil")).toBe("nsaid");
    expect(normalizeAllergen("NSAIDs")).toBe("nsaid");
    expect(normalizeAllergen("ASA")).toBe("nsaid"); // ASA hits nsaid before aspirin
  });

  it("resolves ACE-I shorthand", () => {
    expect(normalizeAllergen("ACE-I")).toBe("ace inhibitor");
    expect(normalizeAllergen("ACEI")).toBe("ace inhibitor");
  });

  it("resolves opioid brand names to the class", () => {
    expect(normalizeAllergen("Vicodin")).toBe("opioid");
    expect(normalizeAllergen("Percocet")).toBe("opioid");
    expect(normalizeAllergen("Norco")).toBe("opioid");
  });

  it("returns the trimmed/lowercased input for unknown allergens", () => {
    expect(normalizeAllergen("  Salmon  ")).toBe("salmon");
    expect(normalizeAllergen("zolbidopride")).toBe("zolbidopride");
  });

  it("is case-insensitive and whitespace-tolerant", () => {
    expect(normalizeAllergen("  pcn  ")).toBe("penicillin");
    expect(normalizeAllergen("PENICILLIN")).toBe("penicillin");
  });
});

describe("expandAllergenAliases (#232)", () => {
  it("PCN → includes penicillin plus amoxicillin/ampicillin so the cross-reactivity rule catches prescriptions for those", () => {
    const aliases = expandAllergenAliases("PCN");
    expect(aliases).toContain("pcn");
    expect(aliases).toContain("penicillin");
    expect(aliases).toContain("amoxicillin");
    expect(aliases).toContain("ampicillin");
    expect(aliases).toContain("augmentin");
  });

  it("Lovenox expands to enoxaparin and heparin", () => {
    const aliases = expandAllergenAliases("Lovenox");
    expect(aliases).toContain("lovenox");
    expect(aliases).toContain("enoxaparin");
    expect(aliases).toContain("heparin");
  });

  it("unknown allergen returns single-element list", () => {
    expect(expandAllergenAliases("salmon")).toEqual(["salmon"]);
  });

  it("deduplicates when the input already equals the canonical", () => {
    const aliases = expandAllergenAliases("penicillin");
    const counts = aliases.filter((a) => a === "penicillin").length;
    expect(counts).toBe(1);
  });
});

describe("ALLERGEN_SYNONYMS data sanity", () => {
  it("covers the core allergen classes named in issue #232", () => {
    for (const canonical of [
      "penicillin",
      "sulfonamide",
      "nsaid",
      "opioid",
      "heparin",
      "warfarin",
      "acetaminophen",
    ]) {
      expect(ALLERGEN_SYNONYMS[canonical]).toBeDefined();
      expect(ALLERGEN_SYNONYMS[canonical]!.length).toBeGreaterThan(1);
    }
  });

  it("aspirin/ASA folds into nsaid so cross-reactivity with ibuprofen still fires", () => {
    // Clinical reality (AERD): aspirin allergy implies risk for all NSAIDs.
    // We deliberately do NOT keep a separate `aspirin` canonical.
    expect(ALLERGEN_SYNONYMS.aspirin).toBeUndefined();
    expect(normalizeAllergen("ASA")).toBe("nsaid");
    expect(normalizeAllergen("aspirin")).toBe("nsaid");
    const aliases = expandAllergenAliases("ASA");
    expect(aliases).toContain("ibuprofen");
    expect(aliases).toContain("naproxen");
  });

  it("every alias resolves to a known canonical", () => {
    for (const aliases of Object.values(ALLERGEN_SYNONYMS)) {
      for (const alias of aliases) {
        // Case-insensitive roundtrip
        const canonical = normalizeAllergen(alias);
        expect(canonical).toMatch(/.+/);
      }
    }
  });

  it("aliases contain lowercase only (the reverse index lowercases on lookup)", () => {
    for (const [canonical, aliases] of Object.entries(ALLERGEN_SYNONYMS)) {
      expect(canonical, `canonical '${canonical}'`).toBe(canonical.toLowerCase());
      for (const alias of aliases) {
        expect(alias, `alias '${alias}' in ${canonical}`).toBe(alias.toLowerCase());
      }
    }
  });
});

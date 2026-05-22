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

  it("resolves vancomycin shorthand / brand / Red Man entries", () => {
    expect(normalizeAllergen("Vanco")).toBe("vancomycin");
    expect(normalizeAllergen("Vancocin")).toBe("vancomycin");
    expect(normalizeAllergen("Red Man")).toBe("vancomycin");
    expect(normalizeAllergen("Red Man Syndrome")).toBe("vancomycin");
    expect(normalizeAllergen("teicoplanin")).toBe("vancomycin");
  });

  it("resolves lipoglycopeptide class members to vancomycin (#973)", () => {
    expect(normalizeAllergen("dalbavancin")).toBe("vancomycin");
    expect(normalizeAllergen("Dalvance")).toBe("vancomycin");
    expect(normalizeAllergen("oritavancin")).toBe("vancomycin");
    expect(normalizeAllergen("Orbactiv")).toBe("vancomycin");
    expect(normalizeAllergen("telavancin")).toBe("vancomycin");
    expect(normalizeAllergen("Vibativ")).toBe("vancomycin");
    expect(normalizeAllergen("lipoglycopeptide")).toBe("vancomycin");
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

  it("expands vancomycin aliases so the direct-match path reaches brand/shorthand meds", () => {
    // The ai-oversight allergy-medication rule (Strategy 1) iterates
    // expandAllergenAliases() and substring-tests each against the
    // candidate medication name. Asserting the expanded set directly
    // locks in the contract the consumer relies on, not just the
    // normalize-to-canonical reduction.
    const vancoAliases = expandAllergenAliases("Vanco");
    expect(vancoAliases).toContain("vancomycin");
    expect(vancoAliases).toContain("vancocin");
    expect(vancoAliases).toContain("teicoplanin");

    const redManAliases = expandAllergenAliases("Red Man Syndrome");
    expect(redManAliases).toContain("vancomycin");
    expect(redManAliases).toContain("vancocin");
  });

  it("'glycopeptide' chart entry expands to the full lipoglycopeptide class (#973)", () => {
    // Strategy 1 in services/ai-oversight/src/rules/allergy-medication.ts
    // iterates the expanded alias list and substring-tests against each
    // active medication. A charted "glycopeptide" allergy must therefore
    // expand to dalbavancin / oritavancin / telavancin so an Rx for any
    // of those triggers a direct-match flag without depending on the
    // (separately gated) class-level cross-reactivity map.
    const aliases = expandAllergenAliases("glycopeptide");
    expect(aliases).toContain("vancomycin");
    expect(aliases).toContain("teicoplanin");
    expect(aliases).toContain("dalbavancin");
    expect(aliases).toContain("oritavancin");
    expect(aliases).toContain("telavancin");
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

  describe("iodine vs iodinated-contrast canonicals (#934)", () => {
    // PR #961 split `iodine` out from `iodinated contrast` so an "allergic
    // to iodine" chart note doesn't trigger a critical contrast-CT flag.
    // These assertions guard against accidental re-merging at the synonym
    // layer.

    it("Betadine resolves to iodine, not iodinated contrast", () => {
      expect(normalizeAllergen("Betadine")).toBe("iodine");
      expect(normalizeAllergen("povidone-iodine")).toBe("iodine");
      expect(normalizeAllergen("povidone iodine")).toBe("iodine");
    });

    it("'iodine' free-text resolves to iodine, never to iodinated contrast", () => {
      expect(normalizeAllergen("Iodine")).toBe("iodine");
      expect(normalizeAllergen("Iodine")).not.toBe("iodinated contrast");
      expect(normalizeAllergen("elemental iodine")).toBe("iodine");
    });

    it("expandAllergenAliases('Betadine') contains iodine aliases but not contrast aliases", () => {
      const aliases = expandAllergenAliases("Betadine");
      expect(aliases).toContain("iodine");
      expect(aliases).toContain("povidone-iodine");
      // Contrast-specific allergens must NOT bleed in.
      expect(aliases).not.toContain("iohexol");
      expect(aliases).not.toContain("omnipaque");
      expect(aliases).not.toContain("iodinated contrast");
    });

    it("iodinated-contrast aliases stay in their own canonical", () => {
      expect(normalizeAllergen("iohexol")).toBe("iodinated contrast");
      expect(normalizeAllergen("Omnipaque")).toBe("iodinated contrast");
      const contrastAliases = expandAllergenAliases("iohexol");
      // Reciprocally: contrast aliases must NOT pull in elemental iodine /
      // topical Betadine forms.
      expect(contrastAliases).not.toContain("betadine");
      expect(contrastAliases).not.toContain("povidone-iodine");
      expect(contrastAliases).not.toContain("elemental iodine");
    });

    it("bare 'povidone' token resolves to iodine (#1024)", () => {
      // The synonym table lists bare `povidone` separately from
      // `povidone-iodine` / `povidone iodine` because some chart entries
      // record just "povidone". Pinning so a future cleanup pass that
      // mistakes it for a duplicate alias doesn't silently drop coverage.
      expect(normalizeAllergen("povidone")).toBe("iodine");
      const aliases = expandAllergenAliases("povidone");
      expect(aliases).toContain("iodine");
      expect(aliases).toContain("betadine");
      expect(aliases).toContain("povidone-iodine");
      expect(aliases).not.toContain("iohexol");
      expect(aliases).not.toContain("omnipaque");
    });

    it("bare 'iodinated' / 'contrast' / 'radiocontrast' tokens resolve to iodinated contrast (#1030)", () => {
      // After PR #1012 narrowed the iodinated-contrast allergenPattern,
      // single-word chart entries lost their fallback. These aliases
      // restore Strategy-2 coverage: a charted "iodinated" expands into
      // the full canonical group via allergenBlob.
      expect(normalizeAllergen("iodinated")).toBe("iodinated contrast");
      expect(normalizeAllergen("Contrast")).toBe("iodinated contrast");
      expect(normalizeAllergen("radiocontrast")).toBe("iodinated contrast");
      const aliases = expandAllergenAliases("iodinated");
      expect(aliases).toContain("iodinated contrast");
      expect(aliases).toContain("iohexol");
      // Reciprocally: must NOT cross into the iodine (Betadine) canonical.
      expect(aliases).not.toContain("betadine");
      expect(aliases).not.toContain("povidone-iodine");
    });
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

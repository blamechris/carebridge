import { describe, it, expect } from "vitest";
import { DRUG_CLASS_CROSS_REACTIONS } from "@carebridge/ai-prompts";
import { CROSS_REACTIVITY_MAP } from "../rules/allergy-medication.js";

/**
 * Symmetry check: LLM prompt anchors (DRUG_CLASS_CROSS_REACTIONS) and
 * deterministic rule map (CROSS_REACTIVITY_MAP) must cover the same
 * drug classes.  A drift between the two means the LLM might flag
 * something the rules miss (or vice-versa).
 *
 * The two maps use slightly different naming conventions (e.g. "sulfa"
 * vs "sulfonamide"), so we normalise via CANONICAL_NAME before comparing.
 * When adding a new class to either map, add a canonical entry here so
 * the test stays green.
 */

/** Canonical lowercase name used for comparison. */
const CANONICAL_NAME: Record<string, string> = {
  // LLM anchor names → canonical
  penicillin: "penicillin",
  sulfa: "sulfonamide",
  aspirin: "nsaid",
  // Rule map names → canonical (identity or mapped)
  sulfonamide: "sulfonamide",
  nsaid: "nsaid",
  cephalosporin: "cephalosporin",
  "penicillin-cephalosporin-cross": "penicillin-cephalosporin-cross",
  opioid: "opioid",
  fluoroquinolone: "fluoroquinolone",
  "ace inhibitor": "ace-inhibitor",
  statin: "statin",
  macrolide: "macrolide",
  tetracycline: "tetracycline",
  benzodiazepine: "benzodiazepine",
  "iodinated contrast": "iodinated-contrast",
  latex: "latex",
  // Iodine-to-contrast advisory (warning-severity cross-reactivity for
  // charted bare "iodine" / Betadine) — same canonical class as true
  // iodinated contrast, just a separate rule entry with a severity
  // override. See #934 for the split rationale.
  "iodine-contrast-advisory": "iodinated-contrast",
  // Shared (both maps use these directly)
  "ace-inhibitor": "ace-inhibitor",
  "iodinated-contrast": "iodinated-contrast",
};

function canonicalise(name: string): string {
  const lower = name.toLowerCase();
  return CANONICAL_NAME[lower] ?? lower;
}

describe("DRUG_CLASS_CROSS_REACTIONS <-> CROSS_REACTIVITY_MAP symmetry", () => {
  const llmCanonical = new Set(
    DRUG_CLASS_CROSS_REACTIONS.map((r) => canonicalise(r.class)),
  );

  const ruleCanonical = new Set(
    CROSS_REACTIVITY_MAP.map((m) => canonicalise(m.class)),
  );

  it("every LLM anchor class has a canonical mapping", () => {
    const unmapped = DRUG_CLASS_CROSS_REACTIONS
      .map((r) => r.class.toLowerCase())
      .filter((c) => !(c in CANONICAL_NAME));
    if (unmapped.length > 0) {
      console.log("LLM classes without canonical mapping — add them to CANONICAL_NAME:", unmapped);
    }
    expect(unmapped).toEqual([]);
  });

  it("every deterministic rule class has a canonical mapping", () => {
    const unmapped = CROSS_REACTIVITY_MAP
      .map((m) => m.class.toLowerCase())
      .filter((c) => !(c in CANONICAL_NAME));
    if (unmapped.length > 0) {
      console.log("Rule classes without canonical mapping — add them to CANONICAL_NAME:", unmapped);
    }
    expect(unmapped).toEqual([]);
  });

  it("every LLM anchor class (canonical) exists in deterministic rules", () => {
    const missingInRules = [...llmCanonical].filter((c) => !ruleCanonical.has(c));
    if (missingInRules.length > 0) {
      console.log(
        "Canonical classes in LLM anchors but missing from CROSS_REACTIVITY_MAP:",
        missingInRules,
      );
    }
    expect(missingInRules).toEqual([]);
  });

  it("every deterministic rule class (canonical) exists in LLM anchors", () => {
    const missingInLLM = [...ruleCanonical].filter((c) => !llmCanonical.has(c));
    if (missingInLLM.length > 0) {
      console.log(
        "Canonical classes in CROSS_REACTIVITY_MAP but missing from LLM anchors:",
        missingInLLM,
      );
    }
    expect(missingInLLM).toEqual([]);
  });
});

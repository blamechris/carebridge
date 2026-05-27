/**
 * Canonical allergen-medication cross-reactivity table.
 *
 * Issue #986: prior to this module the table was duplicated between the
 * order-time allergy check (services/clinical-data) and the post-write
 * AI oversight rule (services/ai-oversight). The two copies drifted —
 * the writer was silently missing entries (iodine/contrast, latex) that
 * the AI rule had, so contrast/latex orders cleared the writer's check
 * and only got flagged AFTER the row was written. Sentinel-event class
 * misses (intra-procedural anaphylaxis).
 *
 * Both writer and rule now import this single source of truth.
 *
 * Naming
 * ------
 * The `class` field is the canonical drug-class slug used by the
 * cross-reactivity-sync test (services/ai-oversight/src/__tests__/
 * cross-reactivity-sync.test.ts) to verify symmetry with the LLM prompt
 * anchors in @carebridge/ai-prompts. Adding a new entry here requires a
 * matching anchor on the LLM side (or a CANONICAL_NAME mapping in the
 * sync test) — see feedback_cross_reactivity_sync_canonical.md.
 */

import type { FlagSeverity } from "@carebridge/shared-types";

/**
 * Shared iodinated-contrast medication pattern. Used by both the true
 * iodinated-contrast cross-reactivity entry and the iodine-contrast
 * advisory entry (#977). Keeping a single source prevents the two from
 * drifting when a new contrast agent is added.
 */
const CONTRAST_MED_REGEX =
  /contrast|iodinated|iohexol|iopamidol|iodixanol|ioversol|optiray|omnipaque|visipaque/i;

export interface CrossReactivityEntry {
  allergenPattern: RegExp;
  medicationPattern: RegExp;
  /** Canonical class slug; matched against LLM anchors by the sync test. */
  class: string;
  /**
   * Optional severity override. When present, AI rule consumers emit the
   * cross-reactivity flag at this severity regardless of the charted
   * allergy severity. Writer consumers ignore this field (they raise a
   * hard block on any conflict).
   */
  severityOverride?: FlagSeverity;
}

export const CROSS_REACTIVITY_MAP: readonly CrossReactivityEntry[] = [
  {
    allergenPattern: /penicillin|amoxicillin|ampicillin/i,
    medicationPattern: /penicillin|amoxicillin|ampicillin|augmentin|amoxil|piperacillin|nafcillin|oxacillin|dicloxacillin/i,
    class: "penicillin",
  },
  {
    allergenPattern: /cephalosporin|cefazolin|ceftriaxone|cephalexin/i,
    medicationPattern: /cefazolin|ceftriaxone|cephalexin|cefepime|cefuroxime|ceftazidime|cefdinir|cefpodoxime|cefotaxime/i,
    class: "cephalosporin",
  },
  {
    // Penicillin↔cephalosporin cross-reactivity (~2% risk).
    allergenPattern: /penicillin|amoxicillin|ampicillin/i,
    medicationPattern: /cefazolin|ceftriaxone|cephalexin|cefepime|cefuroxime/i,
    class: "penicillin-cephalosporin-cross",
  },
  {
    allergenPattern: /sulfa|sulfamethoxazole|bactrim|septra|trimethoprim/i,
    medicationPattern: /sulfamethoxazole|bactrim|septra|sulfasalazine|sulfadiazine|dapsone/i,
    class: "sulfonamide",
  },
  {
    allergenPattern: /nsaid|ibuprofen|naproxen|aspirin/i,
    medicationPattern: /ibuprofen|naproxen|diclofenac|celecoxib|indomethacin|ketorolac|meloxicam|piroxicam|aspirin/i,
    class: "NSAID",
  },
  {
    allergenPattern: /codeine|morphine|opioid/i,
    medicationPattern: /codeine|morphine|hydrocodone|oxycodone|fentanyl|tramadol|hydromorphone|meperidine/i,
    class: "opioid",
  },
  {
    allergenPattern: /fluoroquinolone|ciprofloxacin|levofloxacin/i,
    medicationPattern: /ciprofloxacin|levofloxacin|moxifloxacin|norfloxacin|ofloxacin/i,
    class: "fluoroquinolone",
  },
  {
    allergenPattern: /ace inhibitor|lisinopril|enalapril/i,
    medicationPattern: /lisinopril|enalapril|ramipril|captopril|benazepril|fosinopril|quinapril|perindopril/i,
    class: "ACE inhibitor",
  },
  {
    allergenPattern: /statin|atorvastatin|simvastatin/i,
    medicationPattern: /atorvastatin|simvastatin|rosuvastatin|pravastatin|lovastatin|fluvastatin|pitavastatin/i,
    class: "statin",
  },
  {
    allergenPattern: /macrolide|azithromycin|erythromycin|clarithromycin/i,
    medicationPattern: /azithromycin|erythromycin|clarithromycin|fidaxomicin/i,
    class: "macrolide",
  },
  {
    allergenPattern: /tetracycline|doxycycline|minocycline/i,
    medicationPattern: /tetracycline|doxycycline|minocycline|tigecycline/i,
    class: "tetracycline",
  },
  {
    allergenPattern: /benzodiazepine|diazepam|lorazepam|alprazolam/i,
    medicationPattern: /diazepam|lorazepam|alprazolam|clonazepam|midazolam|temazepam|triazolam/i,
    class: "benzodiazepine",
  },
  {
    // True iodinated-contrast allergy (IV radiocontrast). Default severity
    // path (critical for severe/moderate charted allergies). Bare "iodine"
    // gets the next entry at warning severity.
    //
    // The allergenPattern matches just the canonical / multi-word forms
    // because the rule consumer (services/ai-oversight/src/rules/
    // allergy-medication.ts) tests against `allergenBlob`, which is
    // `expandAllergenAliases(allergy.allergen).join(" ")`. Any allergy
    // that normalises to the "iodinated contrast" canonical contributes
    // "iodinated contrast", "iv contrast", and "contrast dye" to the blob
    // (see packages/medical-logic/src/allergen-synonyms.ts), so a bare
    // /contrast|iohexol|.../ enumeration here would be redundant.
    allergenPattern: /iodinated\s+contrast|iv\s+contrast|contrast\s+dye/i,
    medicationPattern: CONTRAST_MED_REGEX,
    class: "iodinated contrast",
  },
  {
    // Charted "iodine" / Betadine / povidone-iodine — usually a topical
    // skin-prep reaction, not a true IV contrast allergy. Still surface
    // the combination but at warning severity (rule consumers honour
    // severityOverride; writer ignores it and raises a hard block, which
    // is the safer order-time default).
    allergenPattern: /\b(iodine|betadine|povidone[-\s]?iodine)\b/i,
    medicationPattern: CONTRAST_MED_REGEX,
    class: "iodine contrast advisory",
    severityOverride: "warning",
  },
  {
    allergenPattern: /latex/i,
    medicationPattern: /latex/i,
    class: "latex",
  },
  {
    // Glycopeptide cross-reactivity (#1018). Vancomycin, teicoplanin,
    // and the second-generation lipoglycopeptides (dalbavancin,
    // oritavancin, telavancin) share a glycopeptide backbone and a
    // documented cross-allergenic class — see FDA Dalvance PI § 5.2.
    // The allergenPattern also accepts the bare class name "glycopeptide"
    // so allergies charted by class still hit. Symmetry with the LLM
    // anchor in @carebridge/ai-prompts is enforced by
    // services/ai-oversight/src/__tests__/cross-reactivity-sync.test.ts.
    allergenPattern: /vancomycin|teicoplanin|dalbavancin|oritavancin|telavancin|glycopeptide/i,
    medicationPattern: /vancomycin|teicoplanin|dalbavancin|oritavancin|telavancin/i,
    class: "glycopeptide",
  },
];

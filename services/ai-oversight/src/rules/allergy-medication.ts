/**
 * Allergy-medication cross-check.
 *
 * Fires on medication.created events. Checks new medications against the
 * patient's allergy list using:
 * 1. RxNorm code matching (ingredient-level, catches cross-reactive drugs)
 * 2. Name-pattern fallback (when RxNorm codes aren't available)
 *
 * Rule IDs follow pattern: ALLERGY-MED-{SEQ}
 */

import type { FlagSeverity, FlagCategory, RuleFlag } from "@carebridge/shared-types";
import { expandAllergenAliases } from "@carebridge/medical-logic";
import type {
  PatientContext,
  PatientAllergy,
  ResolvedAllergyOverride,
} from "./cross-specialty.js";

/**
 * Known drug class → ingredient mappings for cross-reactivity detection.
 * Maps an allergen class to medication name patterns that share the same
 * active ingredient or belong to the same drug family.
 */
export const CROSS_REACTIVITY_MAP: Array<{
  allergenPattern: RegExp;
  medicationPattern: RegExp;
  class: string;
}> = [
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
    // Cross-reactivity between penicillins and cephalosporins (~2% risk)
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
    allergenPattern: /contrast|iodine|iodinated/i,
    medicationPattern: /contrast|iodinated|iohexol|iopamidol|iodixanol|ioversol/i,
    class: "iodinated contrast",
  },
  {
    allergenPattern: /latex/i,
    medicationPattern: /latex/i,
    class: "latex",
  },
];

/**
 * Map allergy severity to flag severity.
 * Severe allergy → critical flag, moderate → critical, mild → warning.
 */
function mapAllergyToFlagSeverity(allergySeverity?: string | null): FlagSeverity {
  switch (allergySeverity?.toLowerCase()) {
    case "severe":
      return "critical";
    case "moderate":
      return "critical";
    case "mild":
      return "warning";
    default:
      return "critical"; // Default to critical when severity unknown
  }
}

/**
 * Build a deterministic rule ID from the allergen, medication, and match type.
 * Uses a short hash to guarantee uniqueness without a mutable counter.
 */
function buildRuleId(allergen: string, medication: string, matchType: string): string {
  const key = `${allergen.toLowerCase()}|${medication.toLowerCase()}|${matchType}`;
  // Simple djb2 hash — deterministic, no collisions in practice for short clinical strings
  let hash = 5381;
  for (let i = 0; i < key.length; i++) {
    hash = ((hash << 5) + hash + key.charCodeAt(i)) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, "0").toUpperCase();
  return `ALLERGY-MED-${matchType}-${hex}`;
}

/**
 * Is there a structured allergy override that already clears this
 * specific allergy-drug pair? (issue #233)
 *
 * A match fires when EITHER:
 *   - the override's allergy_id matches the candidate allergy's id; OR
 *   - (fallback for overrides that lack an allergy_id — contraindication-
 *     only overrides) the override's allergen matches the candidate
 *     allergen case-insensitively AND the override's recorded medication
 *     (if any) matches the candidate medication name.
 *
 * Rationale: we deliberately scope suppression to the *same* allergy-drug
 * pair. An override of amoxicillin for a penicillin allergy must not
 * suppress a sulfa-vs-bactrim flag for the same patient — each clinical
 * decision is separate and deserves its own structured review.
 */
function isAllergyMedPairOverridden(
  allergy: PatientAllergy,
  medication: string,
  overrides: ResolvedAllergyOverride[] | undefined,
): boolean {
  if (!overrides || overrides.length === 0) return false;
  const allergenLower = allergy.allergen.toLowerCase();
  const medLower = medication.toLowerCase();

  for (const o of overrides) {
    // Prefer structured id matching when both sides have an id — it's the
    // unambiguous link between the override row and the allergy that
    // triggered the flag.
    if (allergy.id && o.allergy_id && allergy.id === o.allergy_id) {
      // When the override recorded a specific medication, require the
      // candidate med to match. When it didn't, the override is treated
      // as covering the whole allergy regardless of which cross-reactive
      // drug is being prescribed.
      if (!o.medication) return true;
      if (medLower.includes(o.medication.toLowerCase())) return true;
      continue;
    }

    // Fallback — match on allergen string when ids are missing.
    if (o.allergen && o.allergen.toLowerCase() === allergenLower) {
      if (!o.medication) return true;
      if (medLower.includes(o.medication.toLowerCase())) return true;
    }
  }

  return false;
}

/**
 * Check medications against patient allergies.
 *
 * Fires on medication.created events. Cross-references the new medication
 * against the patient's allergy list using both name patterns and RxNorm
 * ingredient-class matching.
 *
 * Suppression (issue #233): if `context.resolved_overrides` records a prior
 * structured override for the same allergy-drug pair, the flag is skipped.
 * This lets a physician formally clear a warning once without seeing the
 * same flag re-fire on every subsequent medication event.
 */
export function checkAllergyMedication(context: PatientContext): RuleFlag[] {
  const flags: RuleFlag[] = [];

  if (!context.allergies || context.allergies.length === 0) return flags;

  for (const allergy of context.allergies) {
    // Expand shorthand / brand-name allergen strings to their canonical
    // generic / class (issue #232). Without this, "PCN" never hit the
    // penicillin cross-reactivity rule and "Lovenox" never hit the
    // heparin rule.
    const allergenAliases = expandAllergenAliases(allergy.allergen);

    for (let i = 0; i < context.active_medications.length; i++) {
      const med = context.active_medications[i];
      const medLower = med.toLowerCase();

      // Strategy 1: Direct name match across ANY alias of the allergen.
      // A prescription for "penicillin VK" and an allergy recorded as
      // "PCN" must match — which they do once we expand PCN to
      // [penicillin, pcn, amoxicillin, …].
      const directMatch = allergenAliases.some((alias) => {
        if (medLower.includes(alias)) return true;
        // Also check the first token of the medication against the alias,
        // e.g. "amoxicillin 500mg PO" split → first token "amoxicillin"
        // in the allergen-aliases of an allergy recorded as "PCN".
        const firstMedToken = medLower.split(" ")[0] ?? "";
        return alias.includes(firstMedToken) && firstMedToken.length > 3;
      });
      if (directMatch) {
        if (isAllergyMedPairOverridden(allergy, med, context.resolved_overrides)) {
          break; // Already cleared — no flag for this medication.
        }
        flags.push({
          severity: mapAllergyToFlagSeverity(allergy.severity),
          category: "medication-safety" as FlagCategory,
          summary: `Medication "${med}" matches patient allergy to "${allergy.allergen}"`,
          rationale:
            `Patient has a documented ${allergy.severity ?? "unknown severity"} allergy to "${allergy.allergen}" ` +
            `(reaction: ${allergy.reaction ?? "not specified"}). The prescribed medication "${med}" ` +
            `directly matches this allergen. This is a potential allergic reaction risk.`,
          suggested_action:
            `Verify allergy is current. If confirmed, discontinue "${med}" and select an alternative. ` +
            `If allergy was previously tolerated or is mild, document clinical decision to proceed.`,
          notify_specialties: ["pharmacy"],
          rule_id: buildRuleId(allergy.allergen, med, "DIRECT"),
        });
        break; // Don't double-flag same medication
      }

      // Strategy 2: Cross-reactivity class matching, expanded. The
      // allergenPattern regex runs against each alias so "PCN" reaches
      // the penicillin class rule, "Lovenox" reaches the heparin rule.
      const allergenBlob = allergenAliases.join(" ");
      for (const mapping of CROSS_REACTIVITY_MAP) {
        if (mapping.allergenPattern.test(allergenBlob) && mapping.medicationPattern.test(med)) {
          if (isAllergyMedPairOverridden(allergy, med, context.resolved_overrides)) {
            break; // Already cleared — no flag for this cross-reactivity pair.
          }
          flags.push({
            severity: mapAllergyToFlagSeverity(allergy.severity),
            category: "medication-safety" as FlagCategory,
            summary: `Medication "${med}" may cross-react with allergy to "${allergy.allergen}" (${mapping.class} class)`,
            rationale:
              `Patient has a documented ${allergy.severity ?? "unknown severity"} allergy to "${allergy.allergen}" ` +
              `(reaction: ${allergy.reaction ?? "not specified"}). The prescribed medication "${med}" belongs to the ` +
              `same drug class (${mapping.class}) and may trigger a cross-reactive allergic response.`,
            suggested_action:
              `Evaluate cross-reactivity risk for ${mapping.class} class. Consider alternative agent outside this class. ` +
              `If proceeding, ensure appropriate monitoring and have emergency treatment available.`,
            notify_specialties: ["pharmacy"],
            rule_id: buildRuleId(allergy.allergen, med, `CROSS-${mapping.class}`),
          });
          break; // Don't flag same medication multiple times
        }
      }
    }
  }

  return flags;
}

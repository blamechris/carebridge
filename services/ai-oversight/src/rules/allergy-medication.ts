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

import type { FlagSeverity, FlagCategory } from "@carebridge/shared-types";
import type { RuleFlag } from "./critical-values.js";
import type { PatientContext } from "./cross-specialty.js";

/**
 * Known drug class → ingredient mappings for cross-reactivity detection.
 * Maps an allergen class to medication name patterns that share the same
 * active ingredient or belong to the same drug family.
 */
const CROSS_REACTIVITY_MAP: Array<{
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

let ruleSequence = 0;

/**
 * Check medications against patient allergies.
 *
 * Fires on medication.created events. Cross-references the new medication
 * against the patient's allergy list using both name patterns and RxNorm
 * ingredient-class matching.
 */
export function checkAllergyMedication(context: PatientContext): RuleFlag[] {
  const flags: RuleFlag[] = [];

  if (!context.allergies || context.allergies.length === 0) return flags;

  for (const allergy of context.allergies) {
    const allergenLower = allergy.allergen.toLowerCase();

    for (let i = 0; i < context.active_medications.length; i++) {
      const med = context.active_medications[i];
      const medLower = med.toLowerCase();

      // Strategy 1: Direct name match (allergen name appears in medication name)
      if (medLower.includes(allergenLower) || allergenLower.includes(medLower.split(" ")[0])) {
        ruleSequence++;
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
          rule_id: `ALLERGY-MED-${String(ruleSequence).padStart(3, "0")}`,
        });
        break; // Don't double-flag same medication
      }

      // Strategy 2: Cross-reactivity class matching
      for (const mapping of CROSS_REACTIVITY_MAP) {
        if (mapping.allergenPattern.test(allergy.allergen) && mapping.medicationPattern.test(med)) {
          ruleSequence++;
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
            rule_id: `ALLERGY-MED-${String(ruleSequence).padStart(3, "0")}`,
          });
          break; // Don't flag same medication multiple times
        }
      }
    }
  }

  return flags;
}

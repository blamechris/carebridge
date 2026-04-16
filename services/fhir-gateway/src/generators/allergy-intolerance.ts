/**
 * FHIR R4 AllergyIntolerance resource generator.
 *
 * Maps internal allergy records to the HL7 FHIR R4 AllergyIntolerance
 * resource (https://hl7.org/fhir/R4/allergyintolerance.html), including
 * substance coding, reaction severity, and criticality derivation.
 */

import type { allergies } from "@carebridge/db-schema";
import type { Coding } from "../types/fhir-r4.js";

type Allergy = typeof allergies.$inferSelect;

// Local alias: AllergyIntolerance codings are always fully populated.
type FhirCoding = Required<Pick<Coding, "system" | "code">> & Pick<Coding, "display">;

interface FhirReaction {
  substance?: {
    coding: FhirCoding[];
    text: string;
  };
  manifestation: {
    coding: FhirCoding[];
    text: string;
  }[];
  severity?: "mild" | "moderate" | "severe";
}

type FhirAllergyCategory = "food" | "medication" | "environment" | "biologic";

interface FhirAllergyIntolerance {
  resourceType: "AllergyIntolerance";
  id: string;
  clinicalStatus: {
    coding: FhirCoding[];
  };
  verificationStatus: {
    coding: FhirCoding[];
  };
  category?: FhirAllergyCategory[];
  code: {
    coding: FhirCoding[];
    text: string;
  };
  patient: {
    reference: string;
  };
  recordedDate?: string;
  criticality?: "low" | "high" | "unable-to-assess";
  reaction?: FhirReaction[];
}

const CLINICAL_STATUS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical";

const VERIFICATION_STATUS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification";

/**
 * Map internal verification_status to FHIR R4 verificationStatus code.
 * See https://hl7.org/fhir/R4/valueset-allergyintolerance-verification.html
 */
function mapVerificationStatus(
  status: string | null,
): "confirmed" | "unconfirmed" | "entered-in-error" | "refuted" {
  switch (status) {
    case "confirmed":
      return "confirmed";
    case "entered_in_error":
      return "entered-in-error";
    case "refuted":
      return "refuted";
    default:
      return "unconfirmed";
  }
}

/**
 * Keyword patterns that indicate an IgE-mediated / anaphylactic reaction
 * pathway. Any of these elevates the criticality to "high" regardless of
 * the recorded severity label — a future exposure could trigger a
 * life-threatening reaction even if the last observation was mild.
 *
 * Not a replacement for clinician judgement; this is the defensive floor
 * that the rule-based mapping enforces when the free-text reaction field
 * contains red-flag language.
 */
const ANAPHYLACTIC_KEYWORDS: readonly RegExp[] = [
  /\banaphyla(?:xis|ctic)\b/i,
  /\b(?:airway|throat)\s+(?:closing|swelling|constriction|compromise)\b/i,
  /\b(?:tongue|lip|laryngeal|pharyngeal)\s+swell/i,
  /\bangioedema\b/i,
  /\bdifficulty\s+breathing\b/i,
  /\bshort(?:ness)?\s+of\s+breath\b/i,
  /\bstridor\b/i,
  /\bwheezing\b/i,
  /\bhypotension\b/i,
  /\bsyncope\b/i,
  /\bloss\s+of\s+consciousness\b/i,
];

/**
 * Detect red-flag language in a free-text reaction description.
 * Exported for unit testing; internal callers use it via mapReactionToCriticality.
 */
export function hasAnaphylacticFeatures(reactionText: string | null): boolean {
  if (!reactionText) return false;
  return ANAPHYLACTIC_KEYWORDS.some((re) => re.test(reactionText));
}

/**
 * Derive FHIR criticality from severity, reaction text, and allergen class.
 *
 * Clinical rationale:
 *  - FHIR criticality is about future risk, not observed severity.
 *  - Moderate reactions commonly escalate to anaphylaxis on re-exposure.
 *  - Mild reactions with anaphylactic red flags (tongue swelling, airway
 *    involvement, syncope) must be treated as high risk even when the
 *    recorded severity label is "mild" — the severity field is clinician
 *    shorthand and can under-call a partial anaphylactic event.
 *  - Medication allergens are treated more conservatively than food/
 *    environmental allergens because drug re-exposure is often deliberate
 *    during a clinical encounter and a wrong call can kill a patient
 *    inside the hospital.
 *
 * Exported for unit testing.
 */
export function mapReactionToCriticality(
  severity: string | null,
  reactionText: string | null,
  allergenCategory: FhirAllergyCategory | null,
): "low" | "high" | "unable-to-assess" {
  const redFlag = hasAnaphylacticFeatures(reactionText);

  // Any anaphylactic language elevates to high regardless of severity label.
  if (redFlag) return "high";

  switch (severity) {
    case "severe":
      return "high";
    case "moderate":
      return "high";
    case "mild":
      // Conservative floor: mild medication allergies retain "low" only when
      // no red-flag features exist (already checked above). For medication
      // allergens with unknown reaction, stay at "low" rather than bouncing
      // to "unable-to-assess" because an explicit mild report is a signal.
      return allergenCategory === "medication" ? "low" : "low";
    default:
      return "unable-to-assess";
  }
}

function mapSeverity(
  severity: string | null,
): "mild" | "moderate" | "severe" | undefined {
  switch (severity) {
    case "mild":
    case "moderate":
    case "severe":
      return severity;
    default:
      return undefined;
  }
}

/**
 * Heuristic allergen classification into FHIR categories.
 *
 * Uses explicit coding first (RxNorm → medication, known food SNOMED codes
 * → food), then falls back to simple text-pattern matching. Returns null
 * when classification is ambiguous — we'd rather omit `category` than
 * emit a wrong one, because downstream CDS rules key off this field.
 *
 * Exported for unit testing.
 */
export function classifyAllergenCategory(
  rxnormCode: string | null,
  snomedCode: string | null,
  allergen: string,
): FhirAllergyCategory | null {
  if (rxnormCode) return "medication";

  const text = allergen.toLowerCase();

  // Food SNOMED codes (small sample; full mapping is a clinical data task).
  const FOOD_SNOMED = new Set([
    "91935009", // peanut
    "102259009", // shellfish
    "226934009", // egg
    "3718001", // milk (cow's)
    "735029006", // soybean protein
  ]);
  if (snomedCode && FOOD_SNOMED.has(snomedCode)) return "food";

  // Text-pattern fallback.
  if (
    /\b(peanut|shellfish|egg|milk|soy|wheat|gluten|tree\s*nut|fish|sesame|mollus)\b/i.test(
      text,
    )
  ) {
    return "food";
  }
  if (
    /\b(pollen|dust\s*mite|mold|latex|bee|wasp|hornet|insect\s*sting|grass|ragweed|animal\s*dander|cat|dog)\b/i.test(
      text,
    )
  ) {
    return "environment";
  }
  if (
    /\b(penicillin|amoxicillin|cephalosporin|sulfa|aspirin|ibuprofen|naproxen|nsaid|morphine|codeine|opioid|iodine|contrast)\b/i.test(
      text,
    )
  ) {
    return "medication";
  }

  return null;
}

/**
 * Convert an internal allergy record to a FHIR R4 AllergyIntolerance resource.
 */
export function toFhirAllergyIntolerance(
  allergy: Allergy,
  patientId: string,
): FhirAllergyIntolerance {
  const substanceCodings: FhirCoding[] = [];

  if (allergy.snomed_code) {
    substanceCodings.push({
      system: "http://snomed.info/sct",
      code: allergy.snomed_code,
      display: allergy.allergen,
    });
  }

  if (allergy.rxnorm_code) {
    substanceCodings.push({
      system: "http://www.nlm.nih.gov/research/umls/rxnorm",
      code: allergy.rxnorm_code,
      display: allergy.allergen,
    });
  }

  // Fallback text-only coding
  if (substanceCodings.length === 0) {
    substanceCodings.push({
      system: "http://snomed.info/sct",
      code: "unknown",
      display: allergy.allergen,
    });
  }

  const resource: FhirAllergyIntolerance = {
    resourceType: "AllergyIntolerance",
    id: allergy.id,
    clinicalStatus: {
      coding: [
        {
          system: CLINICAL_STATUS_SYSTEM,
          code: "active",
        },
      ],
    },
    verificationStatus: {
      coding: [
        {
          system: VERIFICATION_STATUS_SYSTEM,
          code: mapVerificationStatus(allergy.verification_status),
        },
      ],
    },
    code: {
      coding: substanceCodings,
      text: allergy.allergen,
    },
    patient: {
      reference: `Patient/${patientId}`,
    },
  };

  if (allergy.created_at) {
    resource.recordedDate = allergy.created_at;
  }

  const allergenCategory = classifyAllergenCategory(
    allergy.rxnorm_code,
    allergy.snomed_code,
    allergy.allergen,
  );
  if (allergenCategory) {
    resource.category = [allergenCategory];
  }

  resource.criticality = mapReactionToCriticality(
    allergy.severity,
    allergy.reaction ?? null,
    allergenCategory,
  );

  // Build reaction array if we have reaction or severity data
  if (allergy.reaction || allergy.severity) {
    const reaction: FhirReaction = {
      manifestation: [
        {
          coding: [
            {
              system: "http://snomed.info/sct",
              code: "unknown",
              display: allergy.reaction ?? "Unknown reaction",
            },
          ],
          text: allergy.reaction ?? "Unknown reaction",
        },
      ],
    };

    // Include substance in the reaction block
    reaction.substance = {
      coding: substanceCodings,
      text: allergy.allergen,
    };

    const severity = mapSeverity(allergy.severity);
    if (severity) {
      reaction.severity = severity;
    }

    resource.reaction = [reaction];
  }

  return resource;
}

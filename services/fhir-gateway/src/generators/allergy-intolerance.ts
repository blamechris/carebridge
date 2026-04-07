/**
 * FHIR R4 AllergyIntolerance resource generator.
 *
 * Maps internal allergy records to the HL7 FHIR R4 AllergyIntolerance
 * resource (https://hl7.org/fhir/R4/allergyintolerance.html), including
 * substance coding, reaction severity, and criticality derivation.
 */

import type { allergies } from "@carebridge/db-schema";
import type { Coding, Reference } from "../types/fhir-r4.js";

type Allergy = typeof allergies.$inferSelect;

interface FhirReaction {
  substance?: {
    coding: Coding[];
    text: string;
  };
  manifestation: {
    coding: Coding[];
    text: string;
  }[];
  severity?: "mild" | "moderate" | "severe";
}

interface FhirAllergyIntolerance {
  resourceType: "AllergyIntolerance";
  id: string;
  clinicalStatus: {
    coding: Coding[];
  };
  verificationStatus: {
    coding: Coding[];
  };
  code: {
    coding: Coding[];
    text: string;
  };
  patient: Reference;
  recordedDate?: string;
  criticality?: "low" | "high" | "unable-to-assess";
  reaction?: FhirReaction[];
}

const CLINICAL_STATUS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical";

const VERIFICATION_STATUS_SYSTEM =
  "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification";

function mapSeverityToCriticality(
  severity: string | null,
): "low" | "high" | "unable-to-assess" {
  // Clinical rationale: FHIR criticality represents the risk of a future
  // life-threatening reaction, not the observed severity. Moderate reactions
  // can escalate unpredictably to anaphylaxis, so we conservatively map
  // moderate -> "high" to prompt clinician caution on subsequent exposures.
  switch (severity) {
    case "mild":
      return "low";
    case "moderate":
    case "severe":
      return "high";
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
 * Convert an internal allergy record to a FHIR R4 AllergyIntolerance resource.
 */
export function toFhirAllergyIntolerance(
  allergy: Allergy,
  patientId: string,
): FhirAllergyIntolerance {
  const substanceCodings: Coding[] = [];

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
          code: "confirmed",
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

  resource.criticality = mapSeverityToCriticality(allergy.severity);

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

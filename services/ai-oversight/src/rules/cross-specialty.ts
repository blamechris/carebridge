/**
 * Deterministic cross-specialty pattern rules.
 *
 * This is the rule layer that catches the DVT scenario: a cancer patient
 * with VTE history presenting with new neurological symptoms. Each rule
 * encodes a known dangerous multi-specialty pattern that individual
 * specialists might miss because they only see their piece.
 */

import type { FlagSeverity, FlagCategory } from "@carebridge/shared-types";
import type { RuleFlag } from "./critical-values.js";

export interface PatientContext {
  active_diagnoses: string[];
  active_medications: string[];
  new_symptoms: string[];
  care_team_specialties: string[];
}

interface CrossSpecialtyRule {
  id: string;
  name: string;
  check: (ctx: PatientContext) => boolean;
  severity: FlagSeverity;
  category: FlagCategory;
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

const CROSS_SPECIALTY_RULES: CrossSpecialtyRule[] = [
  {
    id: "ONCO-VTE-NEURO-001",
    name: "Cancer + VTE + neurological symptom",
    check: (ctx: PatientContext) => {
      const hasCancer = ctx.active_diagnoses.some((d) =>
        /cancer|malignant|carcinoma|lymphoma|leukemia|tumor|neoplasm/i.test(d),
      );
      const hasVTE = ctx.active_diagnoses.some((d) =>
        /dvt|deep vein thrombosis|pulmonary embolism|vte|thrombosis|clot/i.test(d),
      );
      const hasNeuroSymptom = ctx.new_symptoms.some((s) =>
        /headache|vision change|weakness|numbness|confusion|speech difficulty|dizziness|syncope/i.test(s),
      );
      return hasCancer && hasVTE && hasNeuroSymptom;
    },
    severity: "critical" as const,
    category: "cross-specialty" as const,
    summary:
      "Cancer patient with VTE history presents with new neurological symptom — elevated stroke risk",
    rationale:
      "Cancer-associated hypercoagulable state with established VTE history indicates elevated risk " +
      "for cerebral thrombotic events. New neurological symptoms require urgent evaluation to rule out " +
      "stroke or cerebral venous sinus thrombosis. Note: IVC filters protect against PE but do NOT " +
      "mitigate arterial or cerebral thrombotic risk.",
    suggested_action:
      "Urgent neurological evaluation recommended. Consider CT head / CT angiography to rule out acute cerebral event.",
    notify_specialties: ["neurology", "hematology"],
  },
  {
    id: "ANTICOAG-BLEED-001",
    name: "Anticoagulant + bleeding symptom",
    check: (ctx: PatientContext) => {
      const onAnticoag = ctx.active_medications.some((m) =>
        /warfarin|coumadin|heparin|enoxaparin|lovenox|rivaroxaban|xarelto|apixaban|eliquis/i.test(m),
      );
      const hasBleedingSymptom = ctx.new_symptoms.some((s) =>
        /bleeding|blood in stool|blood in urine|hemoptysis|bruising|nosebleed|melena|hematuria|hematemesis/i.test(s),
      );
      return onAnticoag && hasBleedingSymptom;
    },
    severity: "critical" as const,
    category: "cross-specialty" as const,
    summary: "Patient on anticoagulation therapy presents with bleeding symptoms",
    rationale:
      "Patients on anticoagulation therapy with new bleeding symptoms require immediate evaluation. " +
      "Bleeding may indicate supratherapeutic anticoagulation, occult pathology, or drug interaction.",
    suggested_action:
      "Check INR/coagulation studies urgently. Evaluate source of bleeding. Consider holding anticoagulation pending evaluation.",
    notify_specialties: ["hematology"],
  },
  {
    id: "CHEMO-NEUTRO-FEVER-001",
    name: "Chemotherapy + neutropenia + fever",
    check: (ctx: PatientContext) => {
      const onChemo = ctx.active_medications.some((m) =>
        /chemo|capecitabine|xeloda|cisplatin|carboplatin|doxorubicin|cyclophosphamide|paclitaxel|docetaxel|methotrexate|5-fu|fluorouracil/i.test(m),
      );
      const hasFever = ctx.new_symptoms.some((s) =>
        /fever|febrile|temperature|chills/i.test(s),
      );
      return onChemo && hasFever;
    },
    severity: "critical" as const,
    category: "cross-specialty" as const,
    summary:
      "Chemotherapy patient presenting with fever — evaluate for febrile neutropenia",
    rationale:
      "Febrile neutropenia is a medical emergency in chemotherapy patients. Even if neutrophil count " +
      "is not yet available, fever in a patient on myelosuppressive therapy warrants immediate evaluation " +
      "including CBC with differential and blood cultures.",
    suggested_action:
      "Obtain CBC with differential, blood cultures x2, and initiate empiric broad-spectrum antibiotics per institutional protocol if ANC < 500 or expected to decline.",
    notify_specialties: ["oncology", "infectious_disease"],
  },
  {
    id: "RENAL-NSAID-001",
    name: "Renal impairment + NSAID use",
    check: (ctx: PatientContext) => {
      const hasRenalIssue = ctx.active_diagnoses.some((d) =>
        /chronic kidney|ckd|renal failure|renal insufficiency|nephropathy|dialysis/i.test(d),
      );
      const onNSAID = ctx.active_medications.some((m) =>
        /ibuprofen|advil|motrin|naproxen|aleve|diclofenac|voltaren|celecoxib|celebrex|indomethacin|ketorolac|toradol|meloxicam/i.test(m),
      );
      return hasRenalIssue && onNSAID;
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary: "Patient with renal impairment is prescribed an NSAID — risk of acute kidney injury",
    rationale:
      "NSAIDs reduce renal blood flow by inhibiting prostaglandin synthesis. In patients with existing " +
      "renal impairment, this can precipitate acute kidney injury or worsen chronic kidney disease. " +
      "Alternative analgesics should be considered.",
    suggested_action:
      "Review NSAID necessity. Consider switching to acetaminophen or other renal-safe analgesic. Monitor creatinine and GFR.",
    notify_specialties: ["nephrology"],
  },
  {
    id: "CARDIAC-FLUID-001",
    name: "Heart failure + signs of fluid overload",
    check: (ctx: PatientContext) => {
      const hasHF = ctx.active_diagnoses.some((d) =>
        /heart failure|chf|cardiomyopathy|reduced ejection/i.test(d),
      );
      const hasFluidSymptom = ctx.new_symptoms.some((s) =>
        /edema|swelling|weight gain|shortness of breath|dyspnea|orthopnea|paroxysmal nocturnal/i.test(s),
      );
      return hasHF && hasFluidSymptom;
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Heart failure patient presenting with symptoms suggestive of fluid overload",
    rationale:
      "New symptoms of edema, weight gain, or worsening dyspnea in a heart failure patient may indicate " +
      "decompensation. Early intervention with diuretic adjustment can prevent hospitalization.",
    suggested_action:
      "Assess volume status. Check daily weight trend, BNP, and renal function. Consider diuretic adjustment.",
    notify_specialties: ["cardiology"],
  },
  {
    id: "DIABETES-STEROID-001",
    name: "Diabetes + new corticosteroid",
    check: (ctx: PatientContext) => {
      const hasDiabetes = ctx.active_diagnoses.some((d) =>
        /diabetes|dm type|dm2|dm1|diabetic|hyperglycemia/i.test(d),
      );
      const onSteroid = ctx.active_medications.some((m) =>
        /prednisone|prednisolone|methylprednisolone|dexamethasone|hydrocortisone|cortisone|triamcinolone/i.test(m),
      );
      return hasDiabetes && onSteroid;
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Diabetic patient on corticosteroid therapy — monitor for hyperglycemic crisis",
    rationale:
      "Corticosteroids significantly increase blood glucose levels, particularly in diabetic patients. " +
      "This can lead to hyperglycemic crisis (DKA or HHS) if insulin or oral hypoglycemic regimen " +
      "is not adjusted accordingly.",
    suggested_action:
      "Increase glucose monitoring frequency. Consider prophylactic insulin dose adjustment. Review steroid taper plan.",
    notify_specialties: ["endocrinology"],
  },
];

export function checkCrossSpecialtyPatterns(
  patientContext: PatientContext,
): RuleFlag[] {
  const flags: RuleFlag[] = [];

  for (const rule of CROSS_SPECIALTY_RULES) {
    if (rule.check(patientContext)) {
      flags.push({
        severity: rule.severity,
        category: rule.category,
        summary: rule.summary,
        rationale: rule.rationale,
        suggested_action: rule.suggested_action,
        notify_specialties: rule.notify_specialties,
        rule_id: rule.id,
      });
    }
  }

  return flags;
}

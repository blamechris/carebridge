/**
 * Deterministic cross-specialty pattern rules.
 *
 * This is the rule layer that catches the DVT scenario: a cancer patient
 * with VTE history presenting with new neurological symptoms. Each rule
 * encodes a known dangerous multi-specialty pattern that individual
 * specialists might miss because they only see their piece.
 */

import type { FlagSeverity, FlagCategory, ClinicalEvent } from "@carebridge/shared-types";
import type { RuleFlag } from "./critical-values.js";

export interface PatientAllergy {
  allergen: string;
  rxnorm_code?: string | null;
  severity?: string | null; // mild, moderate, severe
  reaction?: string | null;
}

export interface PatientContext {
  active_diagnoses: string[];
  /** ICD-10 codes for active diagnoses (parallel to active_diagnoses). */
  active_diagnosis_codes: string[];
  active_medications: string[];
  /** RxNorm codes for active medications (parallel to active_medications). */
  active_medication_rxnorm_codes?: (string | null)[];
  new_symptoms: string[];
  care_team_specialties: string[];
  /** Patient allergies for cross-checking against medications. */
  allergies?: PatientAllergy[];
  /** The triggering clinical event, used by medication-status rules. */
  trigger_event?: ClinicalEvent;
  /** Recent lab values, used by ANC-aware rules. */
  recent_labs?: Array<{ name: string; value: number }>;
}

/** Anticoagulant name pattern shared across rules. */
const ANTICOAGULANT_PATTERN =
  /warfarin|coumadin|heparin|enoxaparin|lovenox|rivaroxaban|xarelto|apixaban|eliquis|dabigatran|pradaxa|edoxaban|savaysa|fondaparinux|arixtra/i;

/** ICD-10 pattern for active VTE / DVT / PE diagnoses. */
const VTE_ICD10_PATTERN = /^(I26|I80|I82)\./;

interface CrossSpecialtyRule {
  id: string;
  name: string;
  check: (ctx: PatientContext) => boolean;
  severity: FlagSeverity;
  category: FlagCategory;
  summary: string;
  rationale: string;
  suggested_action: string;
  /** Optional dynamic builder that overrides suggested_action when present. */
  buildSuggestedAction?: (ctx: PatientContext) => string;
  /** Optional dynamic severity builder. */
  buildSeverity?: (ctx: PatientContext) => FlagSeverity;
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
    buildSuggestedAction: (ctx: PatientContext) => {
      const onAnticoag = ctx.active_medications.some((m) =>
        ANTICOAGULANT_PATTERN.test(m),
      );
      const base =
        "Urgent neurological evaluation recommended. Consider CT head / CT angiography to rule out acute cerebral event.";
      if (onAnticoag) {
        return (
          base +
          " Note: patient is on anticoagulation — assess hemorrhagic risk before neuroimaging contrast and interventions."
        );
      }
      return (
        base +
        " Note: patient is NOT on anticoagulation despite active VTE — assess thrombotic risk and anticoagulation candidacy."
      );
    },
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
    id: "ONCO-ANTICOAG-HELD-001",
    name: "Anticoagulant held/discontinued in patient with active VTE",
    check: (ctx: PatientContext) => {
      const event = ctx.trigger_event;
      if (!event) return false;

      // Only fires on medication.updated events
      if (event.type !== "medication.updated") return false;

      // Check if the medication is an anticoagulant
      const medName = (event.data.name as string) ?? "";
      if (!ANTICOAGULANT_PATTERN.test(medName)) return false;

      // Check if status transitioned to held or discontinued
      const newStatus = (event.data.status as string) ?? "";
      if (!/^(held|discontinued)$/i.test(newStatus)) return false;

      // Check if patient has active VTE/DVT/PE by ICD-10 code or description
      const hasVTEByCode = ctx.active_diagnosis_codes.some((code) =>
        VTE_ICD10_PATTERN.test(code),
      );
      const hasVTEByDescription = ctx.active_diagnoses.some((d) =>
        /dvt|deep vein thrombosis|pulmonary embolism|vte|venous thromboembolism|thrombosis/i.test(d),
      );

      return hasVTEByCode || hasVTEByDescription;
    },
    severity: "critical" as const,
    category: "medication-safety" as const,
    summary:
      "Anticoagulant held or discontinued in patient with active VTE — elevated thrombotic risk",
    rationale:
      "Holding or discontinuing anticoagulation in a patient with an active venous thromboembolism " +
      "(DVT/PE) significantly increases the risk of clot propagation, recurrent PE, or new thrombotic events. " +
      "Cancer patients with VTE are at particularly high risk due to the underlying hypercoagulable state.",
    suggested_action:
      "Urgent: anticoagulation held in patient with active VTE. Assess thrombotic risk and document clinical reasoning. " +
      "If held for a procedure, ensure bridging anticoagulation plan is in place. " +
      "If discontinued due to bleeding, consider IVC filter placement and hematology consultation.",
    notify_specialties: ["hematology", "oncology"],
  },
  {
    id: "CHEMO-FEVER-001",
    name: "Chemotherapy patient with fever (ANC-aware)",
    check: (ctx: PatientContext) => {
      const onChemo = ctx.active_medications.some((m) =>
        /chemo|capecitabine|xeloda|cisplatin|carboplatin|doxorubicin|cyclophosphamide|paclitaxel|docetaxel|methotrexate|5-fu|fluorouracil/i.test(m),
      );
      const hasFever = ctx.new_symptoms.some((s) =>
        /fever|febrile|temperature|chills/i.test(s),
      );
      if (!onChemo || !hasFever) return false;
      const anc = ctx.recent_labs?.find((l) => /\bANC\b/i.test(l.name))?.value;
      // If we have a recent ANC and it's normal, suppress the flag —
      // avoids the false-confidence alert that the previous version produced.
      if (anc !== undefined && anc >= 1500) return false;
      return true;
    },
    buildSeverity: (ctx: PatientContext) => {
      const anc = ctx.recent_labs?.find((l) => /\bANC\b/i.test(l.name))?.value;
      // ANC < 1500 → confirmed febrile neutropenia → critical.
      // ANC unknown → warning so clinicians review without alert fatigue.
      return anc !== undefined && anc < 1500 ? "critical" : "warning";
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Chemotherapy patient presenting with fever — evaluate for febrile neutropenia and infection",
    rationale:
      "Obtain CBC with differential urgently. If ANC < 1500, treat as febrile neutropenia per protocol. " +
      "Consider broad-spectrum antibiotics while awaiting results.",
    suggested_action:
      "Obtain CBC with differential urgently. If ANC < 1500, treat as febrile neutropenia per protocol. Consider broad-spectrum antibiotics while awaiting results.",
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
        severity: rule.buildSeverity ? rule.buildSeverity(patientContext) : rule.severity,
        category: rule.category,
        summary: rule.summary,
        rationale: rule.rationale,
        suggested_action: rule.buildSuggestedAction
          ? rule.buildSuggestedAction(patientContext)
          : rule.suggested_action,
        notify_specialties: rule.notify_specialties,
        rule_id: rule.id,
      });
    }
  }

  return flags;
}

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

/**
 * Structured diagnosis record used by rules that need to reason about the
 * recency or resolution status of a specific condition (e.g. the
 * ONCO-VTE-NEURO-001 recency gate — see issue #215). When present, the rule
 * layer uses this in preference to the flat `active_diagnoses` string list.
 */
export interface PatientDiagnosis {
  description: string;
  icd10_code: string | null;
  /** Problem-list status string: active, resolved, chronic, etc. */
  status: string | null;
  /** ISO 8601 date of onset; null if unknown. */
  onset_date: string | null;
  /** ISO 8601 date of resolution; null if still active. */
  resolved_date: string | null;
}

export interface PatientContext {
  active_diagnoses: string[];
  /** ICD-10 codes for active diagnoses (parallel to active_diagnoses). */
  active_diagnosis_codes: string[];
  /**
   * Optional structured diagnosis list. Populated by
   * `buildPatientContextForRules`. Carries recency metadata
   * (onset_date / resolved_date / status) so individual rules can apply
   * recency gates without round-tripping to the database.
   */
  active_diagnoses_detail?: PatientDiagnosis[];
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

/** ICD-10 pattern for pregnancy-related diagnoses (Z33, Z34, O00-O9A). */
const PREGNANCY_ICD10_PATTERN = /^(Z3[34]|O[0-9][0-9A]|O9A)\b/;

/** Pregnancy description pattern. */
const PREGNANCY_DESCRIPTION_PATTERN =
  /pregnan|gestational|gravid|obstetric|prenatal|antepartum|trimester/i;

/** FDA Category X teratogenic drugs — high risk of fetal harm, contraindicated in pregnancy. */
const CATEGORY_X_TERATOGEN_PATTERN =
  /isotretinoin|accutane|warfarin|coumadin|methotrexate|trexall|thalidomide|thalomid|misoprostol|cytotec|finasteride|propecia|proscar|dutasteride|avodart/i;

/** FDA Category D teratogenic drugs — evidence of fetal risk, use only if benefit outweighs risk. */
const CATEGORY_D_TERATOGEN_PATTERN =
  /valproic acid|depakote|depakene|carbamazepine|tegretol|phenytoin|dilantin|lithium|lithobid|eskalith|tetracycline|doxycycline|vibramycin/i;

/** Anticoagulant name pattern shared across rules. */
const ANTICOAGULANT_PATTERN =
  /warfarin|coumadin|heparin|enoxaparin|lovenox|rivaroxaban|xarelto|apixaban|eliquis|dabigatran|pradaxa|edoxaban|savaysa|fondaparinux|arixtra/i;

/**
 * Chemotherapy agent name pattern. Shared by CHEMO-FEVER-001 and
 * CHEMO-NEUTRO-FEVER-001 so both rules classify the same set of regimens.
 */
const CHEMO_MED_PATTERN =
  /chemo|capecitabine|xeloda|cisplatin|carboplatin|doxorubicin|cyclophosphamide|paclitaxel|docetaxel|methotrexate|5-fu|fluorouracil/i;

/** Fever-symptom pattern shared across CHEMO-* rules. */
const FEVER_SYMPTOM_PATTERN = /fever|febrile|temperature|chills/i;

/** ICD-10 pattern for active VTE / DVT / PE diagnoses. */
const VTE_ICD10_PATTERN = /^(I26|I80|I82)\./;

/** Text pattern matching VTE / DVT / PE descriptions. */
const VTE_DESCRIPTION_PATTERN =
  /dvt|deep vein thrombosis|pulmonary embolism|vte|venous thromboembolism|thrombosis|clot/i;

/**
 * Recency window (months) for treating a VTE diagnosis as "clinically active"
 * for stroke-risk stratification in the absence of ongoing anticoagulation.
 *
 * Rationale: most cancer-associated VTEs are treated for 3–6 months per CHEST
 * and ASCO guidance; beyond 6 months without active anticoagulation the acute
 * pro-thrombotic contribution of that specific clot has largely resolved.
 * Patients with persistent VTE risk should either remain on anticoagulation
 * (handled by the anticoag branch below) or have a newer VTE episode.
 */
const VTE_RECENCY_WINDOW_MONTHS = 6;

/**
 * Is this diagnosis record a clinically active VTE for ONCO-VTE-NEURO-001?
 *
 * Returns true only when:
 *   1. The diagnosis actually matches VTE (by ICD-10 or description); AND
 *   2. It is NOT explicitly resolved (status !== "resolved" and no
 *      resolved_date in the past); AND
 *   3. Either the onset is within the recency window OR the patient is on
 *      active anticoagulation (used as a proxy for active treatment of this
 *      VTE at the caller site).
 *
 * Unknown onset dates are treated permissively when on anticoagulation but
 * require an onset date to trigger on recency alone, to avoid firing on stale
 * EHR problem-list entries that have no date at all.
 */
function isActiveVTEDiagnosis(
  dx: PatientDiagnosis,
  onAnticoag: boolean,
  now: Date = new Date(),
): boolean {
  const matchesVTE =
    (dx.icd10_code !== null && VTE_ICD10_PATTERN.test(dx.icd10_code)) ||
    VTE_DESCRIPTION_PATTERN.test(dx.description);
  if (!matchesVTE) return false;

  // Hard exclude: resolved diagnoses. A resolved DVT never qualifies, even if
  // the EHR problem list mistakenly left status="active".
  if (dx.status && /^resolved$/i.test(dx.status)) return false;
  if (dx.resolved_date) {
    const resolved = new Date(dx.resolved_date);
    if (!Number.isNaN(resolved.getTime()) && resolved <= now) return false;
  }

  // Active anticoagulation is an accepted proxy for ongoing VTE treatment,
  // which keeps the stroke-risk stratification relevant regardless of age.
  if (onAnticoag) return true;

  // No anticoagulation → require a fresh onset date within the recency window.
  if (!dx.onset_date) return false;
  const onset = new Date(dx.onset_date);
  if (Number.isNaN(onset.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - VTE_RECENCY_WINDOW_MONTHS);
  return onset >= cutoff;
}

/**
 * ANTICOAG-BLEED severity stratification patterns.
 *
 * CRITICAL: frank hemorrhage terms that require immediate evaluation.
 * WARNING: moderate bleeding that warrants prompt but not emergent review.
 * MINOR: bruising / petechiae — expected in anticoagulated patients with
 *        therapeutic INR. Suppressed unless INR > 5.0.
 */
const ANTICOAG_BLEED_CRITICAL_PATTERN =
  /hemorrhage|haemorrhage|hematemesis|melena|hematochezia|hemoptysis|intracranial bleed|gi bleed|gastrointestinal bleed|retroperitoneal|blood in stool/i;

const ANTICOAG_BLEED_WARNING_PATTERN =
  /hematuria|blood in urine|epistaxis.*packing|post.?procedural bleeding|nosebleed/i;

const ANTICOAG_BLEED_MINOR_PATTERN =
  /bruis|petechiae|ecchymosis|minor.*bleeding/i;

/**
 * Classify a single symptom string into a bleeding severity tier.
 * Minor is checked first so "minor skin bleeding" is not escalated by
 * a generic "bleeding" match in the warning tier.
 */
function classifySymptomBleedingTier(symptom: string): "critical" | "warning" | "minor" | null {
  if (ANTICOAG_BLEED_CRITICAL_PATTERN.test(symptom)) return "critical";
  if (ANTICOAG_BLEED_MINOR_PATTERN.test(symptom)) return "minor";
  if (ANTICOAG_BLEED_WARNING_PATTERN.test(symptom)) return "warning";
  // Generic "bleeding" without minor qualifier → warning
  if (/bleeding/i.test(symptom)) return "warning";
  return null;
}

/**
 * Return the highest bleeding severity tier across all symptoms.
 */
function classifyBleedingSeverity(symptoms: string[]): "critical" | "warning" | "minor" | null {
  let highest: "critical" | "warning" | "minor" | null = null;
  for (const s of symptoms) {
    const tier = classifySymptomBleedingTier(s);
    if (tier === "critical") return "critical";
    if (tier === "warning") highest = "warning";
    if (tier === "minor" && highest === null) highest = "minor";
  }
  return highest;
}

/** Matches any bleeding-related symptom across all severity tiers. */
const ANTICOAG_BLEED_ANY_PATTERN =
  /hemorrhage|haemorrhage|hematemesis|melena|hematochezia|hemoptysis|intracranial bleed|gi bleed|gastrointestinal bleed|retroperitoneal|blood in stool|hematuria|blood in urine|epistaxis|nosebleed|post.?procedural bleeding|bleeding|bruis|petechiae|ecchymosis/i;

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
      const hasNeuroSymptom = ctx.new_symptoms.some((s) =>
        /headache|vision change|weakness|numbness|confusion|speech difficulty|dizziness|syncope/i.test(s),
      );
      if (!hasCancer || !hasNeuroSymptom) return false;

      // Recency gate (issue #215): a years-old resolved DVT must not trigger
      // urgent neuroimaging. When structured diagnosis detail is available,
      // require the VTE to be either recently onset (within
      // VTE_RECENCY_WINDOW_MONTHS) or covered by active anticoagulation
      // (proxy for ongoing VTE treatment). Fall back to the legacy
      // description-based match only when no structured detail is provided,
      // preserving behavior for callers that have not yet been upgraded.
      const onAnticoag = ctx.active_medications.some((m) =>
        ANTICOAGULANT_PATTERN.test(m),
      );

      if (ctx.active_diagnoses_detail && ctx.active_diagnoses_detail.length > 0) {
        return ctx.active_diagnoses_detail.some((dx) =>
          isActiveVTEDiagnosis(dx, onAnticoag),
        );
      }

      const hasVTE = ctx.active_diagnoses.some((d) =>
        VTE_DESCRIPTION_PATTERN.test(d),
      );
      return hasVTE;
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
      if (!onAnticoag) return false;

      const hasAnyBleedingSymptom = ctx.new_symptoms.some((s) =>
        ANTICOAG_BLEED_ANY_PATTERN.test(s),
      );
      if (!hasAnyBleedingSymptom) return false;

      // Classify each symptom. Minor pattern is checked first so that
      // "minor skin bleeding" is not escalated by a generic "bleeding" match.
      const tier = classifyBleedingSeverity(ctx.new_symptoms);
      if (tier === "critical" || tier === "warning") return true;

      // Only minor bleeding — suppress unless INR is significantly elevated
      // (> 5.0), since minor bruising is expected in 20-40% of
      // anticoagulated patients with therapeutic INR.
      const inr = ctx.recent_labs?.find((l) => /\bINR\b/i.test(l.name))?.value;
      return inr !== undefined && inr > 5.0;
    },
    buildSeverity: (ctx: PatientContext) => {
      const tier = classifyBleedingSeverity(ctx.new_symptoms);
      if (tier === "critical") return "critical";
      // Both "warning" and "minor" (INR > 5.0) map to warning severity
      return "warning";
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
    name: "Chemotherapy patient with fever (ANC unknown)",
    check: (ctx: PatientContext) => {
      const onChemo = ctx.active_medications.some((m) =>
        CHEMO_MED_PATTERN.test(m),
      );
      const hasFever = ctx.new_symptoms.some((s) =>
        FEVER_SYMPTOM_PATTERN.test(s),
      );
      if (!onChemo || !hasFever) return false;
      const anc = ctx.recent_labs?.find((l) => /\bANC\b/i.test(l.name))?.value;
      // ANC >= 1500 → normal neutrophil count, suppress (avoid alert fatigue).
      // ANC <  1500 → confirmed febrile neutropenia, owned by CHEMO-NEUTRO-FEVER-001.
      // ANC unknown  → fire this warning to prompt an urgent CBC.
      if (anc !== undefined) return false;
      return true;
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Chemotherapy patient presenting with fever — obtain CBC urgently to rule out febrile neutropenia",
    rationale:
      "Recent ANC is unknown. In a chemotherapy patient, any fever must be treated as potential " +
      "febrile neutropenia until a current ANC confirms otherwise — delayed antibiotics in true " +
      "febrile neutropenia double 30-day mortality.",
    suggested_action:
      "Obtain CBC with differential STAT. If ANC < 1500, escalate to febrile-neutropenia protocol " +
      "and start broad-spectrum antibiotics within 60 minutes of fever onset.",
    notify_specialties: ["oncology", "infectious_disease"],
  },
  {
    id: "CHEMO-NEUTRO-FEVER-001",
    name: "Confirmed febrile neutropenia (chemo + fever + ANC < 1500)",
    check: (ctx: PatientContext) => {
      const onChemo = ctx.active_medications.some((m) =>
        CHEMO_MED_PATTERN.test(m),
      );
      const hasFever = ctx.new_symptoms.some((s) =>
        FEVER_SYMPTOM_PATTERN.test(s),
      );
      if (!onChemo || !hasFever) return false;
      const anc = ctx.recent_labs?.find((l) => /\bANC\b/i.test(l.name))?.value;
      // Only fire when ANC is known AND below the febrile-neutropenia threshold.
      return anc !== undefined && anc < 1500;
    },
    buildSuggestedAction: (ctx: PatientContext) => {
      const anc = ctx.recent_labs?.find((l) => /\bANC\b/i.test(l.name))?.value;
      const base =
        "ED-level emergency: confirmed febrile neutropenia. Start broad-spectrum IV antibiotics " +
        "(e.g. cefepime or piperacillin-tazobactam) within 60 minutes of fever onset. Blood and " +
        "urine cultures before antibiotics if no delay. Admit for inpatient management.";
      // Severe neutropenia (ANC < 500) carries the highest sepsis/mortality risk.
      // The base regimen already provides anti-pseudomonal coverage; severe
      // neutropenia warrants additional layers rather than redundant coverage.
      if (anc !== undefined && anc < 500) {
        return (
          base +
          " Severe neutropenia (ANC < 500): confirm the empiric regimen provides " +
          "anti-pseudomonal coverage; add empiric anti-MRSA (e.g. vancomycin) if " +
          "catheter infection, skin/soft tissue involvement, pneumonia, or " +
          "hemodynamic instability suspected. Consider G-CSF and recommend " +
          "reverse isolation."
        );
      }
      return base;
    },
    severity: "critical" as const,
    category: "cross-specialty" as const,
    summary:
      "Febrile neutropenia confirmed — ED-level emergency, antibiotics within 60 minutes",
    rationale:
      "Chemotherapy + fever + ANC < 1500 meets the IDSA definition of febrile neutropenia. " +
      "Infection-related mortality rises sharply for every hour antibiotics are delayed; this is " +
      "one of the few oncology emergencies where time-to-antibiotic is a direct mortality driver.",
    suggested_action:
      "Start broad-spectrum IV antibiotics within 60 minutes of fever onset. Cultures before antibiotics if no delay. Admit.",
    notify_specialties: ["oncology", "infectious_disease", "emergency"],
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
  {
    id: "OBSTETRIC-TERATOGEN-X-001",
    name: "Pregnancy + FDA Category X teratogenic medication",
    check: (ctx: PatientContext) => {
      const isPregnant =
        ctx.active_diagnosis_codes.some((code) =>
          PREGNANCY_ICD10_PATTERN.test(code),
        ) ||
        ctx.active_diagnoses.some((d) =>
          PREGNANCY_DESCRIPTION_PATTERN.test(d),
        );
      const onCategoryX = ctx.active_medications.some((m) =>
        CATEGORY_X_TERATOGEN_PATTERN.test(m),
      );
      return isPregnant && onCategoryX;
    },
    severity: "critical" as const,
    category: "medication-safety" as const,
    summary:
      "Pregnant patient on FDA Category X teratogenic medication — contraindicated, high risk of fetal harm",
    rationale:
      "FDA Pregnancy Category X: studies in animals or humans have demonstrated fetal abnormalities " +
      "and/or there is positive evidence of human fetal risk. The risk of use in pregnant patients " +
      "clearly outweighs any possible benefit. Category X drugs include isotretinoin (severe craniofacial, " +
      "cardiac, and CNS defects), warfarin (fetal warfarin syndrome, CNS abnormalities), methotrexate " +
      "(spontaneous abortion, craniofacial defects), thalidomide (phocomelia), misoprostol (uterine " +
      "contractions, fetal death), and finasteride/dutasteride (abnormal external genitalia in male fetus).",
    suggested_action:
      "IMMEDIATE medication review required. Discontinue Category X medication and switch to a pregnancy-safe " +
      "alternative. Consult obstetrics and maternal-fetal medicine. Assess fetal exposure duration and " +
      "consider teratology counseling.",
    notify_specialties: ["obstetrics", "pharmacology"],
  },
  {
    id: "OBSTETRIC-TERATOGEN-D-001",
    name: "Pregnancy + FDA Category D teratogenic medication",
    check: (ctx: PatientContext) => {
      const isPregnant =
        ctx.active_diagnosis_codes.some((code) =>
          PREGNANCY_ICD10_PATTERN.test(code),
        ) ||
        ctx.active_diagnoses.some((d) =>
          PREGNANCY_DESCRIPTION_PATTERN.test(d),
        );
      const onCategoryD = ctx.active_medications.some((m) =>
        CATEGORY_D_TERATOGEN_PATTERN.test(m),
      );
      return isPregnant && onCategoryD;
    },
    severity: "warning" as const,
    category: "medication-safety" as const,
    summary:
      "Pregnant patient on FDA Category D medication — evidence of fetal risk, review benefit vs. risk",
    rationale:
      "FDA Pregnancy Category D: there is positive evidence of human fetal risk based on adverse reaction " +
      "data, but potential benefits may warrant use in pregnant patients despite the risk. Category D drugs " +
      "include valproic acid (neural tube defects, cognitive impairment), carbamazepine (neural tube defects, " +
      "craniofacial abnormalities), phenytoin (fetal hydantoin syndrome), lithium (Ebstein's cardiac anomaly), " +
      "tetracycline (permanent tooth discoloration, bone growth inhibition), and doxycycline (same class risks).",
    suggested_action:
      "Urgent medication review. Evaluate whether benefit outweighs fetal risk. Consider switching to a " +
      "pregnancy-safe alternative. Consult obstetrics and relevant specialty. If continued, ensure informed " +
      "consent and enhanced fetal monitoring.",
    notify_specialties: ["obstetrics", "pharmacology"],
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

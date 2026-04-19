/**
 * Deterministic cross-specialty pattern rules.
 *
 * This is the rule layer that catches the DVT scenario: a cancer patient
 * with VTE history presenting with new neurological symptoms. Each rule
 * encodes a known dangerous multi-specialty pattern that individual
 * specialists might miss because they only see their piece.
 */

import type { FlagSeverity, FlagCategory, ClinicalEvent, RuleFlag } from "@carebridge/shared-types";
import { parseFrequencyText, estimateDailyDose } from "@carebridge/medical-logic";
import { QTC_PATTERN } from "./drug-interactions.js";
import { METFORMIN_PATTERN, NSAID_PATTERN } from "./shared-drug-patterns.js";
import { getRecentPotassium, getRecentEGFR } from "./lab-units.js";

export interface PatientAllergy {
  allergen: string;
  /**
   * Optional stable identifier for the allergy row. Used by the allergy
   * override suppression logic (issue #233) to match a triggered flag back
   * to a permanent override record, so the rule layer can suppress repeat
   * flags for an allergy-drug pair the clinician has already cleared.
   */
  id?: string | null;
  rxnorm_code?: string | null;
  severity?: string | null; // mild, moderate, severe
  reaction?: string | null;
}

/**
 * Structured allergy override record surfaced into the rule context so
 * `checkAllergyMedication` can suppress flags for an allergy-drug pair a
 * clinician has already formally cleared via the `allergies.override`
 * procedure. See issue #233.
 *
 * A flag is suppressed iff:
 *   - the override references the same allergy_id as the candidate flag's
 *     source allergy; OR
 *   - (allergy_id absent on either side) the override's allergen-class
 *     matches the candidate medication pattern.
 *
 * Suppression is ONLY applied to allergy-medication flags; cross-specialty
 * and drug-interaction rules are unaffected by this field.
 */
export interface ResolvedAllergyOverride {
  /** Nullable when the original flag was a cross-reactivity contraindication. */
  allergy_id: string | null;
  /** The allergen name as recorded on the override (may be absent on contraindication-only overrides). */
  allergen?: string | null;
  /** Optional drug / drug-class name recorded on the overridden medication. */
  medication?: string | null;
  override_reason: string;
  overridden_at: string;
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

/**
 * Structured medication row consumed by dose/frequency-aware rules
 * (issue #235). Carries the fields needed to compute an implied daily
 * cumulative dose: id for cross-referencing `trigger_event.data.resourceId`,
 * dose_amount + dose_unit + frequency for the estimate, and route so
 * future route-specific caps can fold in.
 */
export interface PatientMedication {
  id: string;
  name: string;
  dose_amount: number | null;
  dose_unit: string | null;
  route: string | null;
  frequency: string | null;
  /** Optional PRN / hard-cap dose count per 24 h (not yet stored in DB). */
  max_doses_per_day?: number | null;
  rxnorm_code: string | null;
  /**
   * ISO 8601 prescription start date. Populated from `medications.started_at`
   * when available. Absent when the writer never recorded a start date —
   * rules should fail-open (don't rely on duration) in that case.
   */
  started_at?: string | null;
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
  /**
   * Optional structured medication list (#235). Populated by
   * `buildPatientContextForRules` with dose_amount / dose_unit / frequency so
   * rules can compute implied daily cumulative doses and compare against
   * per-drug caps (see `medication-daily-dose.ts`). Parallel to
   * `active_medications` — the flat name array remains the canonical input
   * for older rules that only need name matching.
   */
  active_medications_detail?: PatientMedication[];
  new_symptoms: string[];
  care_team_specialties: string[];
  /** Patient allergies for cross-checking against medications. */
  allergies?: PatientAllergy[];
  /**
   * Previously granted allergy / contraindication overrides (issue #233).
   * Populated by `buildPatientContextForRules` from the allergy_overrides
   * table. When present, `checkAllergyMedication` uses these to suppress
   * flags for allergy-drug pairs already formally cleared by a clinician.
   */
  resolved_overrides?: ResolvedAllergyOverride[];
  /** The triggering clinical event, used by medication-status rules. */
  trigger_event?: ClinicalEvent;
  /**
   * Recent lab values, used by ANC-aware rules and other threshold
   * comparisons. Each entry carries a `unit` string (issue #856) so rules
   * that compare against analyte-specific thresholds can verify the value
   * is in the expected unit before firing. An empty `unit` means the
   * source record had no recorded unit — downstream unit-aware helpers
   * treat this as unknown and fail closed.
   */
  recent_labs?: Array<{ name: string; value: number; unit: string }>;
  /**
   * ISO 8601 event timestamp. Time-sensitive rules (e.g. VTE recency gate)
   * use this instead of wall-clock time so the evaluation is anchored to the
   * triggering event, not to when the worker happens to process it.
   */
  event_timestamp?: string;
  /**
   * Patient age in fractional years at the time of the triggering event.
   * Populated by `buildPatientContextForRules` when the patient row carries
   * a usable date_of_birth. `null` or `undefined` means the patient's age is
   * unknown — age-gated rules (Beers criteria for elderly, pediatric
   * contraindications, etc.) must fail closed and NOT fire in that case to
   * avoid false positives on demographically unverified records. Issue #236.
   */
  age_years?: number | null;
}

/**
 * ICD-10 pattern for pregnancy-related diagnoses (Z33, Z34, O00-O9A).
 * Exported for reuse by contraindication rules that share the same
 * pregnancy gate (see `contraindications.ts`, issue #904).
 */
export const PREGNANCY_ICD10_PATTERN = /^(Z3[34]|O[0-9][0-9A]|O9A)\b/;

/**
 * Pregnancy description pattern. Exported for reuse by contraindication
 * rules that share the same pregnancy gate.
 */
export const PREGNANCY_DESCRIPTION_PATTERN =
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
  referenceDate?: Date,
): boolean {
  const now = referenceDate ?? new Date();
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
 * Triple-whammy AKI patterns: NSAID + loop/thiazide diuretic + ACE-I/ARB.
 * Each of the three arms must match independently for the rule to fire.
 * Celecoxib is a COX-2 but still confers AKI risk in this triad. The NSAID
 * pattern itself lives in `shared-drug-patterns.ts` (issue #903) and is
 * consumed by the triple-whammy rule, CROSS-NSAID-CHF-001, and the Beers
 * chronic-NSAID rule in age-stratified.ts.
 */

const LOOP_THIAZIDE_DIURETIC_PATTERN =
  /furosemide|lasix|bumetanide|bumex|torsemide|demadex|ethacrynic|edecrin|hydrochlorothiazide|hctz|chlorthalidone|thalitone|indapamide|lozol|metolazone|zaroxolyn|chlorothiazide|diuril/i;

/**
 * ACE inhibitor / ARB name pattern. Exported for reuse by the
 * `CROSS-ACE-ARB-PREG-001` contraindication rule in `contraindications.ts`
 * (issue #904); stays defined here because the triple-whammy AKI rule
 * (RENAL-NSAID-DIURETIC-ACE-001) is the primary in-file consumer.
 */
export const ACE_ARB_PATTERN =
  /lisinopril|enalapril|vasotec|captopril|capoten|ramipril|altace|benazepril|lotensin|quinapril|accupril|fosinopril|monopril|perindopril|aceon|trandolapril|mavik|moexipril|univasc|losartan|cozaar|valsartan|diovan|irbesartan|avapro|candesartan|atacand|olmesartan|benicar|telmisartan|micardis|azilsartan|edarbi|eprosartan|teveten/i;

/**
 * Hepatic disease diagnosis patterns.
 * ICD-10: K70 (alcoholic liver disease), K71 (toxic liver disease),
 * K72 (hepatic failure), K73 (chronic hepatitis), K74 (fibrosis/cirrhosis),
 * K75 (inflammatory liver disease incl. NASH), K76 (other liver disease),
 * B15-B19 (viral hepatitis).
 */
const HEPATIC_DISEASE_ICD10_PATTERN = /^(K7[0-6]|B1[5-9])(\.|$)/;

const HEPATIC_DISEASE_DESCRIPTION_PATTERN =
  /cirrhosis|hepatic failure|liver failure|hepatitis|hepatic impairment|hepatic insufficiency|chronic liver disease|alcoholic liver|steatohepatitis|nash|nafld|liver disease|portal hypertension|esophageal varices|ascites.*liver/i;

/**
 * Hepatotoxic medications. Acetaminophen and statins require high-dose matching —
 * see dose-aware helpers below. Other drugs are always flagged in hepatic disease.
 */
const HEPATOTOXIN_ALWAYS_PATTERN =
  /methotrexate|trexall|isoniazid|laniazid|amiodarone|cordarone|pacerone|valproic acid|valproate|depakote|depakene|divalproex/i;

/**
 * Acetaminophen match. Dose threshold for hepatic-impairment risk is ≥ 3 g/day.
 * We rely on the medication string containing an explicit dose cue indicating
 * ≥ 3g/day (1g QID, 4g/day, 1000mg q6h, etc.) since structured dose data is
 * not available in the rule's PatientContext input.
 */
const ACETAMINOPHEN_PATTERN = /acetaminophen|tylenol|paracetamol|apap/i;

/** Matches explicit high daily dose cues for acetaminophen (≥ 3g/day). */
const ACETAMINOPHEN_HIGH_DOSE_PATTERN =
  /\b(3|3\.\d+|4|4\.\d+|5)\s*g(?:\/day|\s*\/\s*d|\s*daily|\b)|\b(3000|4000|5000)\s*mg(?:\/day)?|\b1\s*g(?:ram)?\b.*\b(?:qid|q6h|q\s*6|four times|4x(?:\/day|\s*daily)|4 times|tid|q8h|q\s*8|three times|3x(?:\/day|\s*daily)|3 times)|\b1000\s*mg\b.*\b(?:qid|q6h|q\s*6|four times|4x(?:\/day|\s*daily)|4 times|tid|q8h|q\s*8|three times|3x(?:\/day|\s*daily)|3 times)/i;

/**
 * Statin medication match. High-dose cutoffs vary per statin (see helper).
 * Exported for reuse by the `CROSS-STATIN-HEPATIC-001` contraindication rule
 * in `contraindications.ts` (issue #904); stays defined here because the
 * `isHepatotoxicMedication` helper (HEPATIC-HEPATOTOXIN-001) is the primary
 * in-file consumer.
 */
export const STATIN_PATTERN =
  /atorvastatin|lipitor|rosuvastatin|crestor|simvastatin|zocor|pravastatin|pravachol|lovastatin|mevacor|fluvastatin|lescol|pitavastatin|livalo/i;

/**
 * Match a statin at hepatotoxicity-relevant high dose. Thresholds (per day):
 * atorvastatin ≥ 40 mg, rosuvastatin ≥ 20 mg, simvastatin ≥ 40 mg,
 * pravastatin ≥ 40 mg, lovastatin ≥ 40 mg.
 */
function isHighDoseStatin(med: string): boolean {
  const m = med.toLowerCase();
  const doseMatch = m.match(/(\d+(?:\.\d+)?)\s*mg/);
  if (!doseMatch) return false;
  const dose = Number(doseMatch[1]);
  if (!Number.isFinite(dose)) return false;
  if (/atorvastatin|lipitor/.test(m)) return dose >= 40;
  if (/rosuvastatin|crestor/.test(m)) return dose >= 20;
  if (/simvastatin|zocor/.test(m)) return dose >= 40;
  if (/pravastatin|pravachol/.test(m)) return dose >= 40;
  if (/lovastatin|mevacor/.test(m)) return dose >= 40;
  if (/fluvastatin|lescol/.test(m)) return dose >= 40;
  if (/pitavastatin|livalo/.test(m)) return dose >= 4;
  return false;
}

/** True if the medication string is a hepatotoxin relevant for this rule. */
function isHepatotoxicMedication(med: string): boolean {
  if (HEPATOTOXIN_ALWAYS_PATTERN.test(med)) return true;
  if (ACETAMINOPHEN_PATTERN.test(med) && ACETAMINOPHEN_HIGH_DOSE_PATTERN.test(med))
    return true;
  if (STATIN_PATTERN.test(med) && isHighDoseStatin(med)) return true;
  return false;
}

/**
 * Renal impairment / reduced eGFR diagnosis patterns.
 * ICD-10: N17 (acute kidney failure), N18 (CKD), N19 (unspecified kidney
 * failure), N28 (other renal disorders incl. insufficiency),
 * R94.4 (abnormal kidney function studies / reduced eGFR).
 */
const RENAL_IMPAIRMENT_ICD10_PATTERN = /^(N1[789]|N28|R94\.4)(\.|$)/;

const RENAL_IMPAIRMENT_DESCRIPTION_PATTERN =
  /chronic kidney|\bckd\b|renal failure|renal insufficiency|nephropathy|dialysis|acute kidney injury|\baki\b|end.?stage renal|\besrd\b|reduced egfr|low egfr|decreased egfr|impaired renal/i;

/** Aminoglycoside antibiotics — nephrotoxic and ototoxic, especially in CKD. */
const AMINOGLYCOSIDE_PATTERN =
  /gentamicin|garamycin|tobramycin|nebcin|tobi|amikacin|amikin|streptomycin|neomycin|kanamycin|paromomycin|plazomicin|zemdri/i;

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

/**
 * Thiazide diuretic name pattern. Distinct from LOOP_THIAZIDE_DIURETIC_PATTERN
 * (which also includes loop diuretics for the triple-whammy rule) — this list
 * is thiazide-only because only thiazides have the chronic-hypokalemia
 * exacerbation profile targeted by CROSS-THIAZIDE-HYPOK-001. Loop diuretics
 * cause hypokalemia too but have different kinetics and monitoring needs.
 */
const THIAZIDE_PATTERN =
  /hydrochlorothiazide|hctz|chlorthalidone|thalitone|indapamide|lozol|metolazone|zaroxolyn|chlorothiazide|diuril/i;

interface CrossSpecialtyRule {
  id: string;
  name: string;
  check: (ctx: PatientContext) => boolean;
  severity: FlagSeverity;
  category: FlagCategory;
  summary: string;
  rationale: string;
  /**
   * Static suggested action. Optional: rules that always compute a dynamic
   * suggestion via `buildSuggestedAction` should omit it rather than carry a
   * static string that can never be read (issue #866). Exactly one of
   * `suggested_action` or `buildSuggestedAction` must be present.
   */
  suggested_action?: string;
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
        const refDate = ctx.event_timestamp
          ? new Date(ctx.event_timestamp)
          : undefined;
        return ctx.active_diagnoses_detail.some((dx) =>
          isActiveVTEDiagnosis(dx, onAnticoag, refDate),
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
    name: "Chemotherapy + fever screening trigger (ANC-stratified severity)",
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
    buildSeverity: (ctx: PatientContext) => {
      const anc = ctx.recent_labs?.find((l) => /\bANC\b/i.test(l.name))?.value;
      // ANC <= 500: severe neutropenia — true febrile neutropenia emergency.
      // ANC > 500 (but < 1500): mild neutropenia — fever source is likely
      // non-neutropenic (e.g. UTI, cellulitis); downgrade to "info" to avoid
      // unnecessary escalation (issue #214).
      if (anc !== undefined && anc > 500) return "info";
      return "critical";
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
      // ANC > 500: mild neutropenia — likely non-neutropenic fever source.
      if (anc !== undefined && anc > 500) {
        return (
          "ANC > 500: fever in this chemotherapy patient is likely from a non-neutropenic source. " +
          "Evaluate for infectious etiology (UTI, cellulitis, pneumonia). Standard fever workup; " +
          "febrile neutropenia protocol not indicated at current ANC. Continue to monitor ANC trend."
        );
      }
      return base;
    },
    severity: "critical" as const,
    category: "cross-specialty" as const,
    summary:
      "Chemotherapy patient with fever and low ANC — severity stratified by neutropenia depth",
    rationale:
      "Chemotherapy + fever + ANC < 1500 meets the IDSA definition of febrile neutropenia. " +
      "However, ANC > 500 carries substantially lower sepsis risk than ANC <= 500 (severe " +
      "neutropenia). When ANC > 500, the fever source is more likely non-neutropenic (e.g. UTI, " +
      "cellulitis) and aggressive escalation causes unnecessary harm — ICU diversion, broad-spectrum " +
      "antibiotic exposure, and alert fatigue. Severity is stratified: critical when ANC <= 500, " +
      "info when ANC > 500.",
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
    id: "RENAL-NSAID-DIURETIC-ACE-001",
    name: "Triple whammy AKI — NSAID + loop/thiazide diuretic + ACE-I/ARB",
    check: (ctx: PatientContext) => {
      const onNSAID = ctx.active_medications.some((m) => NSAID_PATTERN.test(m));
      const onDiuretic = ctx.active_medications.some((m) =>
        LOOP_THIAZIDE_DIURETIC_PATTERN.test(m),
      );
      const onACEARB = ctx.active_medications.some((m) => ACE_ARB_PATTERN.test(m));
      return onNSAID && onDiuretic && onACEARB;
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Triple whammy: NSAID + diuretic + ACE-I/ARB — elevated risk of acute kidney injury",
    rationale:
      "Concurrent use of an NSAID, a loop or thiazide diuretic, and an ACE-inhibitor or ARB — the " +
      '"triple whammy" — produces a synergistic reduction in renal perfusion. NSAIDs constrict the ' +
      "afferent arteriole, ACE-Is/ARBs dilate the efferent arteriole, and diuretics reduce effective " +
      "circulating volume. This triad is a leading avoidable cause of acute kidney injury, with a " +
      "reported 30-day AKI hazard ratio of 1.3–1.8 even in patients with baseline-normal renal function, " +
      "and substantially higher in the elderly or volume-depleted.",
    suggested_action:
      "Review necessity of the NSAID — consider acetaminophen or topical NSAID as safer analgesic. " +
      "If all three must be continued, hold the NSAID during acute illness or dehydration, ensure " +
      "adequate hydration, and obtain a baseline creatinine with follow-up within 5–7 days.",
    notify_specialties: ["nephrology"],
  },
  {
    id: "HEPATIC-HEPATOTOXIN-001",
    name: "Active hepatic disease + hepatotoxic medication",
    check: (ctx: PatientContext) => {
      const hasHepaticDisease =
        ctx.active_diagnosis_codes.some((code) =>
          HEPATIC_DISEASE_ICD10_PATTERN.test(code),
        ) ||
        ctx.active_diagnoses.some((d) =>
          HEPATIC_DISEASE_DESCRIPTION_PATTERN.test(d),
        );
      if (!hasHepaticDisease) return false;
      return ctx.active_medications.some((m) => isHepatotoxicMedication(m));
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Patient with active hepatic disease is on a hepatotoxic medication — risk of decompensation",
    rationale:
      "Patients with cirrhosis, hepatitis, or hepatic failure have reduced metabolic reserve and are " +
      "highly susceptible to drug-induced liver injury. High-risk agents include acetaminophen at ≥ 3 g/day " +
      "(glutathione depletion, even therapeutic doses can precipitate failure), methotrexate (fibrosis), " +
      "isoniazid (idiosyncratic hepatitis, 0.5–1% incidence rising sharply with underlying liver disease), " +
      "amiodarone (phospholipidosis and steatohepatitis), valproate (microvesicular steatosis and " +
      "hyperammonemia), and high-dose statins (transaminitis; rarely acute liver injury).",
    suggested_action:
      "Review medication necessity and consider an alternative without hepatic metabolism. If continued, " +
      "obtain baseline LFTs (AST/ALT/bilirubin/INR), document indication, cap acetaminophen at < 2 g/day, " +
      "and schedule LFT recheck within 2–4 weeks. Consult hepatology for Child-Pugh B/C cirrhosis.",
    notify_specialties: ["hepatology", "gastroenterology"],
  },
  {
    id: "RENAL-AMINOGLYCOSIDE-001",
    name: "Renal impairment + aminoglycoside antibiotic",
    check: (ctx: PatientContext) => {
      const hasRenalImpairment =
        ctx.active_diagnosis_codes.some((code) =>
          RENAL_IMPAIRMENT_ICD10_PATTERN.test(code),
        ) ||
        ctx.active_diagnoses.some((d) =>
          RENAL_IMPAIRMENT_DESCRIPTION_PATTERN.test(d),
        );
      if (!hasRenalImpairment) return false;
      return ctx.active_medications.some((m) => AMINOGLYCOSIDE_PATTERN.test(m));
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Renal-impaired patient on aminoglycoside — risk of acute tubular necrosis and ototoxicity",
    rationale:
      "Aminoglycosides (gentamicin, tobramycin, amikacin, streptomycin) are renally excreted and " +
      "accumulate in proximal tubular cells, producing dose- and duration-dependent nephrotoxicity. " +
      "Incidence of AKI rises from ~10% in normal renal function to 30–50% in pre-existing CKD, often " +
      "with irreversible ototoxicity or vestibulotoxicity. Risk compounds with concurrent loop diuretics, " +
      "vancomycin, contrast, or advanced age.",
    suggested_action:
      "Reassess antibiotic selection — consider an equally effective non-nephrotoxic agent if available. " +
      "If aminoglycoside must be used, dose by lean body weight with extended-interval dosing, target " +
      "trough < 1 mcg/mL (gentamicin/tobramycin) or < 5 mcg/mL (amikacin), monitor creatinine daily and " +
      "audiometry if duration > 5 days, and minimize total exposure. Nephrology consultation recommended.",
    notify_specialties: ["nephrology", "infectious_disease"],
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
  {
    // CROSS-QT-HYPOK-001 — Co-occurrence of any QT-prolonging agent with
    // hypokalemia (K+ < 3.5 mEq/L) sharply elevates risk of torsades de
    // pointes. CredibleMeds and FDA QT-prolongation labeling flag hypokalemia
    // as a key modifier. Neither DI-QTC-COMBO (requires two QT drugs) nor
    // the individual critical-values potassium rule (no drug context) covers
    // this clinically important combination. Severity follows potassium depth:
    // K+ < 3.0 is critical (aligned with critical-values.ts), K+ 3.0–3.4 is
    // warning.
    id: "CROSS-QT-HYPOK-001",
    name: "QT-prolonging drug + hypokalemia (torsades risk)",
    check: (ctx: PatientContext) => {
      const onQTDrug = ctx.active_medications.some((m) => QTC_PATTERN.test(m));
      if (!onQTDrug) return false;
      // Unit-aware potassium lookup (#856). Refuses to match labs whose
      // unit is not numerically equivalent to mEq/L (i.e. mmol/L). A K+
      // value recorded in mg/dL or with no unit would cause the rule to
      // skip rather than silently compare against the 3.5 mEq/L threshold.
      const k = getRecentPotassium(ctx)?.value;
      if (k === undefined) return false;
      return k < 3.5;
    },
    buildSeverity: (ctx: PatientContext) => {
      const k = getRecentPotassium(ctx)?.value;
      // Severe hypokalemia (K+ < 3.0) compounds torsades risk and is
      // independently critical per critical-values.ts. Escalate accordingly.
      if (k !== undefined && k < 3.0) return "critical";
      return "warning";
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Patient on QT-prolonging medication with hypokalemia (K+ < 3.5) — elevated risk of torsades de pointes",
    rationale:
      "Hypokalemia prolongs ventricular repolarization by reducing the outward IKr current, independently " +
      "increasing QT interval. When combined with a QT-prolonging drug (class I/III antiarrhythmics, " +
      "antipsychotics, macrolides, fluoroquinolones, ondansetron, methadone, citalopram/escitalopram, " +
      "or other agents on the CredibleMeds QTDrugs list), the additive effect markedly elevates the risk " +
      "of torsades de pointes, a polymorphic ventricular tachycardia that can degenerate to ventricular " +
      "fibrillation. Risk compounds further with hypomagnesemia, bradycardia, female sex, heart failure, " +
      "and hepatic/renal impairment.",
    // suggested_action is intentionally omitted — buildSuggestedAction always
    // wins when present, so a static property would be dead code (issue #866).
    buildSuggestedAction: (ctx: PatientContext) => {
      const k = getRecentPotassium(ctx)?.value;
      const base =
        "Replete potassium to > 4.0 mEq/L. Check magnesium concurrently and repeat if low (hypomagnesemia " +
        "impairs potassium correction and independently prolongs QT). Obtain baseline ECG and calculate " +
        "QTc — if > 500 ms or > 60 ms above baseline, hold the QT-prolonging agent and consult cardiology. " +
        "Continuous telemetry until electrolytes corrected.";
      if (k !== undefined && k < 3.0) {
        return (
          base +
          " Severe hypokalemia (K+ < 3.0): initiate IV potassium replacement with continuous telemetry " +
          "monitoring and hold the QT-prolonging agent pending electrolyte correction and ECG review."
        );
      }
      return base;
    },
    notify_specialties: ["cardiology"],
  },
  {
    // CROSS-THIAZIDE-HYPOK-001 — Thiazide diuretics induce potassium wasting
    // at the distal convoluted tubule. Starting or continuing a thiazide in a
    // patient who already has hypokalemia worsens the electrolyte deficit and
    // increases the risk of cardiac arrhythmia, muscle weakness, and
    // rhabdomyolysis. Loop diuretics also cause hypokalemia but have
    // different kinetics, so this rule intentionally only matches thiazides.
    //
    // Overlap with CROSS-QT-HYPOK-001 is deliberate: the two rules address
    // different mechanisms (electrolyte worsening vs. torsades risk) and
    // generate different actions (hold thiazide / replace K+ vs. QTc
    // monitoring and cardiology review). Firing both gives the reviewer a
    // complete picture.
    //
    // Note (#878): the downstream `consolidateRuleFlags` step in
    // review-service.ts suppresses the redundant CRITICAL-LAB-POTASSIUM
    // critical-value flag when either CROSS-QT-HYPOK-001 or
    // CROSS-THIAZIDE-HYPOK-001 fires, since all three would describe the
    // same underlying severe-hypokalemia signal. This does NOT dedup the
    // two cross-specialty rules against each other — only the generic
    // lab-level critical flag.
    //
    // Units: K+ in mEq/L (numerically equivalent to mmol/L). Severity mirrors
    // CROSS-QT-HYPOK-001: warning at K+ 3.0–3.4, critical when K+ < 3.0.
    id: "CROSS-THIAZIDE-HYPOK-001",
    name: "Thiazide diuretic + hypokalemia (electrolyte worsening)",
    check: (ctx: PatientContext) => {
      const onThiazide = ctx.active_medications.some((m) =>
        THIAZIDE_PATTERN.test(m),
      );
      if (!onThiazide) return false;
      // Unit-aware potassium lookup (#856). Fails closed if the recorded
      // K+ unit is not numerically equivalent to mEq/L, rather than
      // silently comparing a wrong-unit value against the 3.5 mEq/L
      // threshold.
      const k = getRecentPotassium(ctx)?.value;
      if (k === undefined) return false;
      return k < 3.5;
    },
    buildSeverity: (ctx: PatientContext) => {
      const k = getRecentPotassium(ctx)?.value;
      // Severe hypokalemia (K+ < 3.0) is independently critical per
      // critical-values.ts and mirrors the escalation pattern used by
      // CROSS-QT-HYPOK-001.
      if (k !== undefined && k < 3.0) return "critical";
      return "warning";
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Patient on thiazide diuretic with hypokalemia (K+ < 3.5) — elevated arrhythmia risk",
    rationale:
      "Thiazide diuretics (hydrochlorothiazide, chlorthalidone, indapamide, metolazone) increase urinary " +
      "potassium excretion by delivering more sodium to the cortical collecting duct and stimulating " +
      "aldosterone-mediated potassium secretion. Continuing a thiazide in an already hypokalemic patient " +
      "exacerbates the deficit and raises the risk of ventricular arrhythmia, muscle weakness, leg cramps, " +
      "rhabdomyolysis, and worsened glucose tolerance. Risk compounds with concurrent QT-prolonging drugs, " +
      "heart failure, and hypomagnesemia.",
    // suggested_action is intentionally omitted — buildSuggestedAction always
    // wins when present, so a static property would be dead code (issue #866).
    buildSuggestedAction: (ctx: PatientContext) => {
      const k = getRecentPotassium(ctx)?.value;
      const base =
        "Replete potassium toward > 4.0 mEq/L. Consider holding the thiazide until K+ is corrected, or " +
        "switching to a potassium-sparing regimen (ACE-I/ARB + aldosterone antagonist, or adding amiloride). " +
        "Check serum magnesium concurrently and replete if low. Review other contributors (low dietary K+, " +
        "concurrent corticosteroid, GI losses). Recheck electrolytes within 1–2 weeks.";
      if (k !== undefined && k < 3.0) {
        return (
          base +
          " Severe hypokalemia (K+ < 3.0): hold the thiazide, initiate urgent potassium replacement, " +
          "obtain ECG to assess for arrhythmogenic changes, and consider continuous telemetry until " +
          "electrolytes are corrected."
        );
      }
      return base;
    },
    notify_specialties: ["nephrology", "cardiology"],
  },

  // ── #263: Additional high-risk cross-specialty patterns ─────────

  {
    // CROSS-STEROID-PCP-001 — Chronic high-dose corticosteroid therapy
    // without Pneumocystis jirovecii prophylaxis. Clinical consensus
    // (IDSA, ATS) recommends PCP prophylaxis for prednisone ≥ 20 mg/day
    // for ≥ 4 weeks; without it, PCP mortality in a first episode is
    // 20–40%. This rule fires when a patient's active medication list
    // contains a chronic systemic corticosteroid but no prophylaxis
    // agent (TMP-SMX, dapsone, atovaquone, or aerosolised pentamidine).
    //
    // Fail-open posture: we use `active_medications_detail` when
    // available (issue #235) so the rule can check dose_amount against
    // the 20 mg/day threshold; without dose detail we fall back to a
    // weaker name-only match and note the uncertainty in the rationale.
    id: "CROSS-STEROID-PCP-001",
    name: "Chronic high-dose corticosteroid without PCP prophylaxis",
    check: (ctx: PatientContext) => {
      // Only systemic corticosteroids drive the CD4+ T-cell suppression
      // that raises PCP risk. Creams, eye drops, and intranasal sprays
      // with hydrocortisone / triamcinolone / betamethasone have minimal
      // systemic exposure and should not trigger prophylaxis warnings.
      const CORTICOSTEROID_PATTERN =
        /prednisone|prednisolone|methylprednisolone|medrol|solu-medrol|dexamethasone|decadron|hydrocortisone|solu-cortef|betamethasone|triamcinolone/i;
      const TOPICAL_ROUTE_PATTERN =
        /topical|ophthalmic|otic|intranasal|inhaled|inhalation|cream|ointment|gel|drops|spray/i;
      const PCP_PROPHYLAXIS_PATTERN =
        /trimethoprim.?sulfamethoxazole|bactrim|septra|tmp.?smx|dapsone|atovaquone|mepron|pentamidine|nebupent/i;

      const steroidMed = ctx.active_medications.find((m) =>
        CORTICOSTEROID_PATTERN.test(m),
      );
      if (!steroidMed) return false;

      // Prefer structured detail (#235) so we can (a) filter topical /
      // inhaled / intranasal formulations out of the systemic-exposure
      // cohort and (b) compute an implied daily prednisone-equivalent
      // by multiplying dose_amount × parsed frequency (a scheduled
      // 10 mg BID prescription is 20 mg/day, meeting the threshold).
      if (ctx.active_medications_detail) {
        const systemicSteroidDetail = ctx.active_medications_detail.find(
          (m) => {
            if (!CORTICOSTEROID_PATTERN.test(m.name)) return false;
            const route = m.route?.toLowerCase() ?? "";
            if (TOPICAL_ROUTE_PATTERN.test(route)) return false;
            // Inhaled/nasal/topical strings sometimes appear in name not
            // route — e.g., "Flonase (triamcinolone intranasal)". Drop
            // those too.
            if (TOPICAL_ROUTE_PATTERN.test(m.name)) return false;
            return true;
          },
        );
        if (!systemicSteroidDetail) return false;

        if (
          systemicSteroidDetail.dose_amount != null &&
          systemicSteroidDetail.dose_unit?.toLowerCase() === "mg"
        ) {
          // Prednisone-equivalent potency factors (Lexicomp / UpToDate):
          // methylprednisolone 1.25, dexamethasone 6.67, hydrocortisone
          // 0.25, betamethasone 6.67, triamcinolone 1.25.
          let perDoseEquiv = systemicSteroidDetail.dose_amount;
          const nameLower = systemicSteroidDetail.name.toLowerCase();
          if (/methylprednisolone|medrol|triamcinolone/.test(nameLower)) {
            perDoseEquiv *= 1.25;
          } else if (/dexamethasone|decadron|betamethasone/.test(nameLower)) {
            perDoseEquiv *= 6.67;
          } else if (/hydrocortisone|solu-cortef/.test(nameLower)) {
            perDoseEquiv *= 0.25;
          }

          // dose_amount is per-dose; multiply by doses-per-day from the
          // parsed frequency to get the daily load. Unparseable or
          // PRN-only prescriptions keep the old behaviour (treat the
          // per-dose amount as the daily estimate) so chronic-suppressed
          // PRN tapers still flag, but tight interpretation would miss
          // "prednisone 10 mg BID" today.
          const freq = parseFrequencyText(systemicSteroidDetail.frequency);
          const dailyEquiv =
            estimateDailyDose(
              perDoseEquiv,
              freq,
              systemicSteroidDetail.max_doses_per_day ?? null,
            ) ?? perDoseEquiv;

          if (dailyEquiv < 20) return false;
        }

        // Duration gate (#940). IDSA/ATS require prednisone-equivalent
        // >= 20 mg/day for >= 4 weeks before PCP prophylaxis is indicated.
        // Short bursts (5–7 day tapers for asthma exacerbation, poison ivy,
        // acute gout, COPD flare, etc.) routinely use 40–60 mg prednisone
        // and would otherwise trip this rule with no real prophylaxis
        // indication. Suppress fire when started_at is known and shows the
        // course started < 28 days ago; fail-open (keep firing) when the
        // writer didn't record a start date, so chronic steroid courses
        // without start-date metadata still surface.
        const startedAt = systemicSteroidDetail.started_at;
        if (startedAt) {
          const startedMs = Date.parse(startedAt);
          if (Number.isFinite(startedMs)) {
            const daysSinceStart = (Date.now() - startedMs) / 86_400_000;
            if (daysSinceStart < 28) return false;
          }
        }
      }

      const onProphylaxis = ctx.active_medications.some((m) =>
        PCP_PROPHYLAXIS_PATTERN.test(m),
      );
      return !onProphylaxis;
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Patient on chronic corticosteroid without documented PCP (Pneumocystis jirovecii) prophylaxis",
    rationale:
      "Sustained corticosteroid exposure at prednisone-equivalent doses >= 20 mg/day for >= 4 weeks " +
      "causes CD4+ T-cell-mediated immunosuppression that raises PCP risk 20-fold over baseline. " +
      "First-episode PCP in a previously healthy steroid-exposed patient carries 20–40% mortality; " +
      "first-line prophylaxis (TMP-SMX 80/400 mg daily or 160/800 mg MWF) reduces incidence by ~85%.",
    suggested_action:
      "Confirm steroid duration and daily dose. If prednisone-equivalent >= 20 mg/day for >= 4 weeks is " +
      "anticipated, start PCP prophylaxis: TMP-SMX single-strength daily is first-line. Alternatives for " +
      "sulfa-intolerant patients include dapsone 100 mg daily (check G6PD first), atovaquone 1500 mg daily " +
      "with food, or aerosolised pentamidine 300 mg monthly.",
    notify_specialties: ["infectious_disease", "pharmacy"],
  },

  {
    // CROSS-ANTICOAG-NSAID-GIBLEED-001 — Anticoagulant + NSAID in a
    // patient with a documented prior GI bleed is the highest-risk
    // combination for recurrent upper-GI haemorrhage (HR 5–10 vs.
    // anticoagulant alone). Aspirin counts as an NSAID here despite
    // common cardiac-prophylaxis dosing — low-dose aspirin still raises
    // GI bleed risk in warfarin/DOAC-treated patients.
    id: "CROSS-ANTICOAG-NSAID-GIBLEED-001",
    name: "Anticoagulant + NSAID with prior GI bleed history",
    check: (ctx: PatientContext) => {
      const GI_BLEED_HISTORY_PATTERN =
        /gi bleed|gastrointestinal bleed|peptic ulcer|hematemesis|melena|upper gi|lower gi|diverticular bleed|angiodysplasia|variceal/i;
      // Deliberately include aspirin here (not part of NSAID_PATTERN because
      // other NSAID rules care about prostaglandin / renal-profile risks
      // where aspirin kinetics differ). For GI-bleed risk in
      // anticoagulated patients, low-dose aspirin still carries the
      // synergistic bleed-risk of an NSAID.
      const NSAID_OR_ASPIRIN =
        /aspirin|bayer|ecotrin|bufferin|acetylsalicylic|ibuprofen|advil|motrin|naproxen|aleve|diclofenac|voltaren|celecoxib|celebrex|indomethacin|ketorolac|toradol|meloxicam|piroxicam|nabumetone|etodolac|sulindac|ketoprofen/i;
      const onAnticoag = ctx.active_medications.some((m) =>
        ANTICOAGULANT_PATTERN.test(m),
      );
      if (!onAnticoag) return false;
      const onNSAID = ctx.active_medications.some((m) =>
        NSAID_OR_ASPIRIN.test(m),
      );
      if (!onNSAID) return false;
      const hasGIBleedHistory = ctx.active_diagnoses.some((d) =>
        GI_BLEED_HISTORY_PATTERN.test(d),
      );
      return hasGIBleedHistory;
    },
    severity: "critical" as const,
    category: "cross-specialty" as const,
    summary:
      "Anticoagulant + NSAID in a patient with prior GI bleed — very high rebleed risk",
    rationale:
      "The combination of systemic anticoagulation and NSAID / aspirin doubles the absolute risk of " +
      "upper-GI bleeding compared to either agent alone, and in a patient with a documented prior GI " +
      "bleed the annual recurrence risk approaches 10–15%. NSAIDs impair mucosal prostaglandin " +
      "synthesis while anticoagulants prevent haemostasis once bleeding begins, so the mechanisms are " +
      "synergistic rather than additive.",
    suggested_action:
      "Discontinue the NSAID / aspirin wherever possible. If continued NSAID therapy is clinically " +
      "required (rheumatological indication without alternatives), add a proton-pump inhibitor (e.g. " +
      "omeprazole 20 mg daily), confirm H. pylori status and treat if positive, and reassess the " +
      "anticoagulation indication. For cardiovascular secondary prevention, consider whether clopidogrel " +
      "alone (no NSAID) or warfarin alone (no antiplatelet) achieves the target risk reduction.",
    notify_specialties: ["gastroenterology", "pharmacy", "cardiology"],
  },

  {
    // CROSS-IMMUNOSUPPRESSED-FEVER-001 — Patient on systemic
    // immunosuppression presenting with a febrile symptom. Because the
    // usual inflammatory response is blunted, the threshold for a septic
    // workup is far lower than in immunocompetent patients — febrile
    // neutropenia is an oncology emergency, and a TNF-α-treated patient
    // with a low-grade fever may be harbouring an atypical infection
    // (TB reactivation, invasive fungal, disseminated herpes).
    //
    // Overlap note: CHEMO-NEUTRO-FEVER-001 and CHEMO-FEVER-001 cover the
    // chemotherapy case specifically. This rule covers the *other*
    // immunosuppressants (biologics, DMARDs, calcineurin inhibitors,
    // mycophenolate, high-dose steroid) that those rules don't reach.
    id: "CROSS-IMMUNOSUPPRESSED-FEVER-001",
    name: "Immunosuppressant + fever symptom (non-chemo)",
    check: (ctx: PatientContext) => {
      const IMMUNOSUPPRESSANT_PATTERN =
        /methotrexate|trexall|otrexup|azathioprine|imuran|mycophenolate|cellcept|myfortic|cyclosporine|sandimmune|neoral|tacrolimus|prograf|sirolimus|rapamune|everolimus|afinitor|adalimumab|humira|infliximab|remicade|etanercept|enbrel|certolizumab|cimzia|golimumab|simponi|rituximab|rituxan|tocilizumab|actemra|abatacept|orencia|ustekinumab|stelara|secukinumab|cosentyx|vedolizumab|entyvio|natalizumab|tysabri/i;
      const onImmunosuppressant = ctx.active_medications.some((m) =>
        IMMUNOSUPPRESSANT_PATTERN.test(m),
      );
      if (!onImmunosuppressant) return false;
      // Only treat non-chemo immunosuppression here. The CHEMO-* rules
      // already cover chemo-induced neutropenic fever with more specific
      // workup guidance. Gated on BOTH an active cancer diagnosis AND
      // a chemo medication — methotrexate is in both CHEMO_MED_PATTERN
      // and IMMUNOSUPPRESSANT_PATTERN because it's used in oncology and
      // rheumatology; a non-oncology RA patient on methotrexate would
      // incorrectly be excluded if we looked only at the drug list.
      const CANCER_DIAGNOSIS_PATTERN =
        /cancer|malignant|carcinoma|lymphoma|leukemia|tumor|neoplasm|sarcoma|myeloma/i;
      const hasCancerDx = ctx.active_diagnoses.some((d) =>
        CANCER_DIAGNOSIS_PATTERN.test(d),
      );
      const onChemo = ctx.active_medications.some((m) => CHEMO_MED_PATTERN.test(m));
      if (hasCancerDx && onChemo) return false;
      return ctx.new_symptoms.some((s) => FEVER_SYMPTOM_PATTERN.test(s));
    },
    severity: "warning" as const,
    category: "cross-specialty" as const,
    summary:
      "Patient on systemic immunosuppressant presenting with fever — atypical infection workup indicated",
    rationale:
      "Biologics (TNF-α blockers, IL-6 inhibitors, B-cell depleters), calcineurin inhibitors, " +
      "mycophenolate, and high-dose DMARDs blunt the usual febrile response to infection. A fever " +
      "in this population can represent latent TB reactivation, invasive fungal disease (aspergillus, " +
      "cryptococcus, histoplasmosis in endemic regions), opportunistic CMV / HSV, or an early " +
      "bacterial bloodstream infection that would be afebrile in a healthy host. The threshold for " +
      "cultures, chest imaging, and empirical antimicrobials is therefore much lower than in " +
      "immunocompetent patients.",
    suggested_action:
      "Send blood cultures × 2, urinalysis with culture, CBC with differential, CRP / procalcitonin, " +
      "LDH, and lactate. Image the chest (CXR, consider CT if a biologic is involved — atypical " +
      "presentations are common). In patients on TNF-α blockers, review TB screening history and " +
      "consider interferon-gamma release assay. Hold the immunosuppressant until a source is " +
      "identified unless actively treating a rheumatological flare. Consult infectious disease for " +
      "any patient who remains febrile beyond 24 h or appears unwell.",
    notify_specialties: ["infectious_disease", "rheumatology"],
  },
];

export function checkCrossSpecialtyPatterns(
  patientContext: PatientContext,
): RuleFlag[] {
  const flags: RuleFlag[] = [];

  for (const rule of CROSS_SPECIALTY_RULES) {
    if (rule.check(patientContext)) {
      // Rule authors must supply either a static `suggested_action` or a
      // `buildSuggestedAction` builder (issue #866). The builder always wins.
      const suggestedAction = rule.buildSuggestedAction
        ? rule.buildSuggestedAction(patientContext)
        : rule.suggested_action;
      if (suggestedAction === undefined) {
        throw new Error(
          `Cross-specialty rule ${rule.id} is missing both suggested_action and buildSuggestedAction`,
        );
      }
      flags.push({
        severity: rule.buildSeverity ? rule.buildSeverity(patientContext) : rule.severity,
        category: rule.category,
        summary: rule.summary,
        rationale: rule.rationale,
        suggested_action: suggestedAction,
        notify_specialties: rule.notify_specialties,
        rule_id: rule.id,
      });
    }
  }

  return flags;
}

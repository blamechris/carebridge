/**
 * Phase B4: deterministic rules fired by a `checkin.submitted` clinical
 * event.
 *
 * The Phase B1 check-in service has already done two things by the time
 * we get here:
 *
 *   1. Computed `red_flag_hits` against the template's declarative
 *      red_flag metadata (boolean / threshold / values). That list is
 *      the "this answer is per se concerning" signal and it's already
 *      on the event payload.
 *
 *   2. Carried `target_condition`, `template_slug`, and the hit list so
 *      this rule file can reason about them without re-decrypting the
 *      responses.
 *
 * What this rule family adds on top is *cross-specialty* reasoning —
 * the same job the note-correlation family does for signed notes, but
 * rooted in patient-voice data. The difference between "oncology weekly
 * says fever" and "oncology weekly says fever AND patient has active
 * cancer diagnosis + is on chemotherapy" is the difference between a
 * generic reminder and a CHEMO-FEVER-001-level escalation.
 *
 * Rules implemented:
 *
 *   CHECKIN-NEURO-ONCO-VTE-001    — oncology-weekly check-in with a
 *     new neuro symptom hit, patient has active cancer + active VTE
 *     (matches the DVT scenario from the patient-voice side).
 *
 *   CHECKIN-CHEMO-FEVER-001       — oncology-weekly check-in reports
 *     fever, patient is on chemotherapy. Immunocompromised-fever
 *     pathway.
 *
 *   CHECKIN-CHF-DECOMP-001        — cardiac-weekly check-in with
 *     weight gain ≥ 3 lbs + dyspnea-at-rest in a patient with an
 *     active heart failure diagnosis.
 *
 *   CHECKIN-POSTOP-INFECTION-001  — post-discharge check-in reports a
 *     moderate/severe wound problem AND fever. Classic surgical-site
 *     infection trigger.
 *
 *   CHECKIN-SEVERE-SYMPTOM-001    — any check-in submission whose red
 *     flag list is non-empty for two or more consecutive days. This is
 *     the catch-all "patient keeps reporting the same red flag and
 *     nobody has acted on it" safety net.
 *
 * All rules are pure functions of `CheckInRuleContext`. The caller
 * (review-service) is responsible for loading the context — the rule
 * functions themselves touch no DB / network and are trivially unit
 * tested.
 */

import type { FlagSeverity, FlagCategory } from "@carebridge/shared-types";
import type { RuleFlag } from "./critical-values.js";

// ─── Context types ───────────────────────────────────────────────

/**
 * Minimal summary of a single prior check-in — just enough for the
 * streak / decompensation checks. The caller loads this from the
 * check_ins table; we explicitly do NOT pass raw responses because the
 * rule engine must never open the PHI envelope to do its job.
 */
export interface PriorCheckInSummary {
  id: string;
  template_slug: string;
  template_version: number;
  target_condition: string;
  red_flag_hits: string[];
  submitted_at: string;
}

/**
 * The check-in submission the `checkin.submitted` event points at,
 * joined with the snapshot fields from its template.
 */
export interface CurrentCheckIn {
  id: string;
  template_slug: string;
  template_version: number;
  target_condition: string;
  red_flag_hits: string[];
  submitted_at: string;
  submitted_by_relationship: string;
}

/**
 * Context assembled by review-service for the B4 rule pass.
 * Deliberately shaped like `PatientContext` / `NoteCorrelationContext`
 * so the three rule families compose.
 */
export interface CheckInRuleContext {
  current: CurrentCheckIn;
  /** Active diagnoses for the patient (descriptions, freeform). */
  active_diagnoses: string[];
  /** ICD-10 codes for active diagnoses, parallel to active_diagnoses. */
  active_diagnosis_codes: string[];
  /** Active medication names (status = "active"). */
  active_medications: string[];
  /**
   * Prior check-ins for this patient, newest first. The caller bounds
   * this (default 14 days / max 50 rows); empty list is fine.
   */
  prior_checkins: PriorCheckInSummary[];
  /** Evaluation clock — explicit so tests are deterministic. */
  now: Date;
}

// ─── Shared predicates ───────────────────────────────────────────

const CANCER_PATTERN =
  /cancer|malignant|carcinoma|lymphoma|leukemia|tumor|neoplasm/i;

const VTE_PATTERN =
  /dvt|deep vein thrombosis|pulmonary embolism|\bvte\b|thrombosis|clot/i;

const CHEMO_PATTERN =
  /cisplatin|carboplatin|oxaliplatin|doxorubicin|cyclophosphamide|paclitaxel|docetaxel|5[- ]?fu|fluorouracil|capecitabine|gemcitabine|etoposide|irinotecan|vincristine|methotrexate|pemetrexed|bevacizumab|trastuzumab|rituximab|pembrolizumab|nivolumab/i;

const HEART_FAILURE_PATTERN =
  /heart failure|\bchf\b|\bhfref\b|\bhfpef\b|cardiomyopathy|cardiac decompensation/i;

function hasCancer(ctx: CheckInRuleContext): boolean {
  return ctx.active_diagnoses.some((d) => CANCER_PATTERN.test(d));
}

function hasVTE(ctx: CheckInRuleContext): boolean {
  return ctx.active_diagnoses.some((d) => VTE_PATTERN.test(d));
}

function onChemotherapy(ctx: CheckInRuleContext): boolean {
  return ctx.active_medications.some((m) => CHEMO_PATTERN.test(m));
}

function hasHeartFailure(ctx: CheckInRuleContext): boolean {
  return ctx.active_diagnoses.some((d) => HEART_FAILURE_PATTERN.test(d));
}

/**
 * Does a check-in hit list contain any of the given question ids?
 * Safe against missing ids.
 */
function hitsAny(hits: string[], ids: readonly string[]): boolean {
  return hits.some((h) => ids.includes(h));
}

// ─── Rule declarations ───────────────────────────────────────────

interface CheckInRule {
  id: string;
  name: string;
  check: (ctx: CheckInRuleContext) => boolean;
  severity: FlagSeverity;
  category: FlagCategory;
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

/**
 * Question ids the oncology-weekly template uses for new neurological
 * symptoms. Kept in the rule file (not the template) so rule changes
 * don't require template edits. Must stay in sync with
 * `tooling/seed/checkin-templates.ts`.
 */
const ONCOLOGY_NEURO_QUESTION_IDS = [
  "new_neuro_symptoms",
  "severe_headache",
  "vision_change",
] as const;

/** Question ids the oncology-weekly template uses for fever / chills. */
const ONCOLOGY_FEVER_QUESTION_IDS = ["fever", "chills_or_rigors"] as const;

/** Cardiac-weekly decompensation signal ids. */
const CARDIAC_WEIGHT_ID = "weight_gain_lbs";
const CARDIAC_DYSPNEA_IDS = [
  "dyspnea_at_rest",
  "orthopnea",
  "paroxysmal_nocturnal_dyspnea",
] as const;

/** Post-discharge infection signal ids. */
const POSTOP_WOUND_ID = "wound_problem";
const POSTOP_FEVER_ID = "fever";

const CHECKIN_RULES: CheckInRule[] = [
  {
    id: "CHECKIN-NEURO-ONCO-VTE-001",
    name: "Patient-voice neuro symptom in a cancer + VTE patient",
    check: (ctx) =>
      ctx.current.target_condition === "oncology" &&
      ctx.current.template_slug === "oncology-weekly" &&
      hitsAny(ctx.current.red_flag_hits, ONCOLOGY_NEURO_QUESTION_IDS) &&
      hasCancer(ctx) &&
      hasVTE(ctx),
    severity: "critical",
    category: "cross-specialty",
    summary:
      "Cancer patient with VTE reports new neurological symptom on weekly check-in — elevated cerebral thrombotic risk",
    rationale:
      "Patient with active cancer and established VTE diagnosis self-reported new neurological symptoms on the oncology weekly check-in. " +
      "Cancer-associated hypercoagulable state with prior VTE indicates elevated risk for cerebral thrombotic events. " +
      "Patient-voice reporting on this signal shortens time-to-recognition relative to next scheduled visit — act before the ED.",
    suggested_action:
      "Contact patient today for targeted neuro evaluation; consider urgent CT head / CT angiography to rule out acute cerebral event. " +
      "Review anticoagulation status.",
    notify_specialties: ["Oncology", "Neurology", "Emergency"],
  },

  {
    id: "CHECKIN-CHEMO-FEVER-001",
    name: "Self-reported fever on chemotherapy",
    check: (ctx) =>
      ctx.current.target_condition === "oncology" &&
      ctx.current.template_slug === "oncology-weekly" &&
      hitsAny(ctx.current.red_flag_hits, ONCOLOGY_FEVER_QUESTION_IDS) &&
      onChemotherapy(ctx),
    severity: "critical",
    category: "cross-specialty",
    summary:
      "Patient on chemotherapy self-reports fever or rigors — possible neutropenic fever",
    rationale:
      "Patient on active chemotherapy reported a temperature ≥ 100.4°F or shaking chills on the oncology weekly check-in. " +
      "Immunocompromised fever may represent neutropenic sepsis and requires immediate ANC + cultures before empiric antibiotics. " +
      "Do not wait for the next scheduled lab.",
    suggested_action:
      "Contact patient now; instruct to present to ED or infusion center for immediate CBC with differential, blood cultures, and empiric broad-spectrum antibiotics within 60 minutes per institutional neutropenic fever protocol.",
    notify_specialties: ["Oncology", "Infectious Disease", "Emergency"],
  },

  {
    id: "CHECKIN-CHF-DECOMP-001",
    name: "Cardiac weekly check-in reports weight gain + dyspnea",
    check: (ctx) =>
      ctx.current.target_condition === "cardiac" &&
      ctx.current.template_slug === "cardiac-weekly" &&
      ctx.current.red_flag_hits.includes(CARDIAC_WEIGHT_ID) &&
      hitsAny(ctx.current.red_flag_hits, CARDIAC_DYSPNEA_IDS) &&
      hasHeartFailure(ctx),
    severity: "warning",
    category: "trend-concern",
    summary:
      "Possible heart failure decompensation — weight gain with new dyspnea on patient self-report",
    rationale:
      "Patient with active heart failure reported ≥ 3 lbs weight gain over 3 days combined with new dyspnea, orthopnea, or PND on the cardiac weekly check-in. " +
      "This is the classic early decompensation triad and is actionable with an outpatient diuretic adjustment.",
    suggested_action:
      "Contact patient within 24h. Review home weights and medication adherence; consider diuretic dose adjustment or in-office assessment before ED presentation is required.",
    notify_specialties: ["Cardiology", "Primary Care"],
  },

  {
    id: "CHECKIN-POSTOP-INFECTION-001",
    name: "Post-discharge wound concern with fever",
    check: (ctx) =>
      ctx.current.target_condition === "post_discharge" &&
      ctx.current.template_slug === "post-discharge-red-flags" &&
      ctx.current.red_flag_hits.includes(POSTOP_WOUND_ID) &&
      ctx.current.red_flag_hits.includes(POSTOP_FEVER_ID),
    severity: "warning",
    category: "care-gap",
    summary:
      "Post-discharge patient reports moderate-to-severe wound problem with fever — possible surgical site infection",
    rationale:
      "Patient in the post-discharge window reported a worsening wound (moderate or severe) together with a temperature ≥ 100.4°F on the red-flag check-in. " +
      "This combination is the dominant early presentation of surgical site infection and is the leading preventable cause of 30-day readmission.",
    suggested_action:
      "Contact patient today for wound assessment; consider same-day clinic visit, wound culture, and empiric antibiotic coverage pending eval.",
    notify_specialties: ["Surgery", "Primary Care"],
  },

  {
    id: "CHECKIN-SEVERE-SYMPTOM-001",
    name: "Consecutive red-flag submissions with no action",
    check: (ctx) => {
      if (ctx.current.red_flag_hits.length === 0) return false;
      // Look for at least one prior submission in the previous 48h that
      // also had red flag hits. This is the "keeps reporting the same
      // problem" safety net so no single rule gap lets a persistent
      // patient-voice red flag fall through.
      const nowMs = ctx.now.getTime();
      const windowStart = nowMs - 48 * 60 * 60 * 1000;
      const currentMs = new Date(ctx.current.submitted_at).getTime();
      if (Number.isNaN(currentMs)) return false;
      return ctx.prior_checkins.some((p) => {
        if (p.id === ctx.current.id) return false;
        const priorMs = new Date(p.submitted_at).getTime();
        if (Number.isNaN(priorMs)) return false;
        if (priorMs >= currentMs) return false;
        if (priorMs < windowStart) return false;
        return p.red_flag_hits.length > 0;
      });
    },
    severity: "info",
    category: "care-gap",
    summary:
      "Patient has reported check-in red flags on two consecutive submissions within 48 hours",
    rationale:
      "Patient-reported red flags persisted across two submissions in the last 48 hours. " +
      "Persistent patient-voice concerns in this window correlate strongly with preventable escalations — this flag is the catch-all safety net for clinician review.",
    suggested_action:
      "Review the patient's check-in history in the clinician portal and make contact before the next scheduled visit.",
    notify_specialties: [],
  },
];

// ─── Rule engine entry point ─────────────────────────────────────

/**
 * Run all check-in red-flag rules against a single submission.
 *
 * Returns the flags to create. No side-effects.
 */
export function checkCheckInRedFlags(ctx: CheckInRuleContext): RuleFlag[] {
  const flags: RuleFlag[] = [];
  for (const rule of CHECKIN_RULES) {
    if (rule.check(ctx)) {
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

// Re-export the constant lists for unit tests and the review-service
// integration hook to reference without duplicating strings.
export const __TEST__ = {
  ONCOLOGY_NEURO_QUESTION_IDS,
  ONCOLOGY_FEVER_QUESTION_IDS,
  CARDIAC_WEIGHT_ID,
  CARDIAC_DYSPNEA_IDS,
  POSTOP_WOUND_ID,
  POSTOP_FEVER_ID,
};

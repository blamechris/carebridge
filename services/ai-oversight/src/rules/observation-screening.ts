/**
 * Patient observation screening rules.
 *
 * Screens patient-reported observations (symptom journal) for urgent clinical
 * signals using deterministic keyword matching. This ensures critical symptoms
 * like "worst headache of my life" are flagged even when the LLM layer is
 * unavailable or delayed.
 *
 * Uses observation-specific keyword patterns (critical and warning tiers)
 * targeting the observation `description` field. Only fires on
 * `patient.observation` events.
 */

import type { FlagSeverity, FlagCategory, ClinicalEvent } from "@carebridge/shared-types";
import type { RuleFlag } from "./critical-values.js";

interface ObservationKeywordPattern {
  id: string;
  pattern: RegExp;
  severity: FlagSeverity;
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

/**
 * Critical keyword patterns — symptoms that demand immediate clinical review.
 */
const CRITICAL_PATTERNS: ObservationKeywordPattern[] = [
  {
    id: "OBS-CHEST-PAIN",
    pattern: /chest\s*pain|chest\s*tightness|chest\s*pressure|angina/i,
    severity: "critical",
    summary: "Patient reports chest pain/pressure in symptom journal",
    rationale:
      "Patient described chest pain or pressure symptoms in a symptom observation. " +
      "This could indicate acute coronary syndrome, pulmonary embolism, or other " +
      "cardiac emergency requiring immediate evaluation.",
    suggested_action:
      "Contact patient immediately. If symptoms are active, advise calling 911. " +
      "Assess onset, duration, severity, and associated symptoms.",
    notify_specialties: ["cardiology"],
  },
  {
    id: "OBS-BREATHING",
    pattern: /can'?t\s*breathe|difficulty\s*breathing|short(ness)?\s*(of)?\s*breath|severe\s*sob|gasping/i,
    severity: "critical",
    summary: "Patient reports difficulty breathing in symptom journal",
    rationale:
      "Patient described respiratory distress in a symptom observation. This could indicate " +
      "pulmonary embolism, CHF exacerbation, severe asthma attack, or other respiratory emergency.",
    suggested_action:
      "Contact patient immediately. If active respiratory distress, advise calling 911. " +
      "Assess oxygen saturation if available, onset, and progression.",
    notify_specialties: ["pulmonology"],
  },
  {
    id: "OBS-SEVERE-HEADACHE",
    pattern: /worst\s*headache|thunderclap\s*headache|sudden\s*severe\s*headache|worst\s*head\s*pain/i,
    severity: "critical",
    summary: "Patient reports sudden severe headache in symptom journal",
    rationale:
      "Patient described a sudden severe or 'worst ever' headache. This pattern is concerning for " +
      "subarachnoid hemorrhage, cerebral venous thrombosis, or other intracranial emergency. " +
      "Particularly dangerous in patients with DVT/VTE history or anticoagulation.",
    suggested_action:
      "Contact patient immediately. Consider emergent CT/CTA. If patient is on anticoagulation " +
      "or has VTE history, this is a neurovascular emergency until proven otherwise.",
    notify_specialties: ["neurology"],
  },
  {
    id: "OBS-STROKE-SYMPTOMS",
    pattern: /face\s*droop|arm\s*weakness|slurred\s*speech|sudden\s*numbness|sudden\s*confusion|vision\s*loss|can'?t\s*move\s*(my\s*)?(arm|leg)\b/i,
    severity: "critical",
    summary: "Patient describes possible stroke symptoms in symptom journal",
    rationale:
      "Patient described symptoms consistent with acute stroke (FAST criteria: face droop, " +
      "arm weakness, speech difficulty). Time-sensitive — every minute matters for thrombolysis eligibility.",
    suggested_action:
      "IMMEDIATE: If symptoms are current, advise calling 911 immediately. " +
      "Document last known well time. Do not delay for further assessment.",
    notify_specialties: ["neurology"],
  },
  {
    id: "OBS-SUICIDAL",
    pattern: /suicid|want\s*to\s*die|kill\s*myself|end\s*(my|it)\s*(life|all)|don'?t\s*want\s*to\s*live|no\s*reason\s*to\s*live/i,
    severity: "critical",
    summary: "Patient expresses suicidal ideation in symptom journal",
    rationale:
      "Patient's observation contains language suggesting suicidal ideation. This requires " +
      "immediate clinical assessment and safety planning regardless of other conditions.",
    suggested_action:
      "IMMEDIATE: Contact patient by phone. Assess imminent risk. If unable to reach, " +
      "consider welfare check. Involve behavioral health crisis team. Document safety plan.",
    notify_specialties: ["psychiatry"],
  },
  {
    id: "OBS-ALLERGIC-REACTION",
    pattern: /swelling\s*(of\s*)?(my\s*)?(face|throat|tongue|lips)|anaphyla|throat\s*(closing|swelling|tight)|hives\s*all\s*over|can'?t\s*swallow/i,
    severity: "critical",
    summary: "Patient describes possible anaphylaxis/allergic reaction in symptom journal",
    rationale:
      "Patient described symptoms consistent with severe allergic reaction or anaphylaxis. " +
      "This is a medical emergency requiring immediate intervention.",
    suggested_action:
      "IMMEDIATE: If symptoms are active, advise calling 911 and using epinephrine auto-injector if available. " +
      "Review current medications for potential culprit.",
    notify_specialties: [],
  },
];

/**
 * High-severity keyword patterns — urgent but not immediately life-threatening.
 */
const HIGH_PATTERNS: ObservationKeywordPattern[] = [
  {
    id: "OBS-BLEEDING",
    pattern: /blood\s*in\s*(stool|urine|vomit)|coughing\s*(up\s*)?blood|bleeding\s*(a\s*lot|heavily|won'?t\s*stop)|hemoptysis|hematuria|melena|hematemesis/i,
    severity: "critical",
    summary: "Patient reports significant bleeding in symptom journal",
    rationale:
      "Patient described significant bleeding symptoms. This is particularly dangerous in patients " +
      "on anticoagulants, post-procedure, or with known bleeding disorders.",
    suggested_action:
      "Contact patient to assess volume and duration. Check current medications for anticoagulants. " +
      "Consider ED referral if hemodynamically significant.",
    notify_specialties: ["hematology"],
  },
  {
    id: "OBS-SEVERE-PAIN",
    pattern: /severe\s*pain|excruciating|unbearable\s*pain|10\s*out\s*of\s*10|10\/10\s*pain/i,
    severity: "warning",
    summary: "Patient reports severe pain in symptom journal",
    rationale:
      "Patient described severe or excruciating pain. Uncontrolled severe pain warrants " +
      "prompt clinical reassessment of diagnosis and pain management plan.",
    suggested_action:
      "Contact patient to assess pain location, quality, and associated symptoms. " +
      "Consider whether current analgesic regimen is adequate.",
    notify_specialties: [],
  },
  {
    id: "OBS-FAINTING",
    pattern: /faint(ed|ing)|passed?\s*out|lost?\s*consciousness|syncop/i,
    severity: "warning",
    summary: "Patient reports fainting/syncope in symptom journal",
    rationale:
      "Patient described syncope or near-syncope. This may indicate cardiac arrhythmia, " +
      "orthostatic hypotension, vasovagal episode, or neurological event.",
    suggested_action:
      "Contact patient to assess circumstances, frequency, and associated symptoms. " +
      "Consider cardiac workup and medication review.",
    notify_specialties: ["cardiology"],
  },
  {
    id: "OBS-SEIZURE",
    pattern: /seizure|convuls|shaking\s*uncontrollably|epilep/i,
    severity: "warning",
    summary: "Patient reports seizure activity in symptom journal",
    rationale:
      "Patient described seizure or convulsion activity. New-onset seizures require " +
      "urgent neurological evaluation to rule out structural or metabolic causes.",
    suggested_action:
      "Contact patient urgently. Assess whether seizure is new-onset or breakthrough. " +
      "Consider neuroimaging if new-onset. Review medications for seizure threshold effects.",
    notify_specialties: ["neurology"],
  },
  {
    id: "OBS-HIGH-FEVER",
    pattern: /high\s*fever|temperature\s*(of\s*)?(10[3-9]|1[1-9]\d)|fever\s*(won'?t|doesn'?t|not)\s*(go\s*down|break|respond)/i,
    severity: "warning",
    summary: "Patient reports high or persistent fever in symptom journal",
    rationale:
      "Patient reported high or unresponsive fever. In immunocompromised patients " +
      "(chemotherapy, transplant, HIV), this can indicate febrile neutropenia or serious infection.",
    suggested_action:
      "Check patient's medication list for chemotherapy/immunosuppressants. " +
      "If immunocompromised, treat as potential febrile neutropenia — advise ED evaluation.",
    notify_specialties: ["oncology", "infectious_disease"],
  },
];

const ALL_PATTERNS = [...CRITICAL_PATTERNS, ...HIGH_PATTERNS];

/**
 * Screen a patient observation for urgent symptoms.
 *
 * Checks the observation description text against urgent keyword patterns
 * and returns clinical flags for any matches.
 */
export function screenPatientObservation(event: ClinicalEvent): RuleFlag[] {
  const flags: RuleFlag[] = [];

  const description = (event.data.observation_description as string) ?? "";

  if (!description) return flags;

  for (const entry of ALL_PATTERNS) {
    if (entry.pattern.test(description)) {
      flags.push({
        severity: entry.severity,
        category: "patient-reported",
        summary: entry.summary,
        rationale: entry.rationale,
        suggested_action: entry.suggested_action,
        notify_specialties: entry.notify_specialties,
        rule_id: entry.id,
      });
    }
  }

  return flags;
}

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

import type { FlagCategory, ClinicalEvent, RuleFlag } from "@carebridge/shared-types";
import {
  SHARED_CRITICAL_PATTERNS,
  materializePattern,
  type ScreeningPattern,
} from "./screening-patterns.js";

const OBS_PREFIX = "OBS";
const OBS_SOURCE = "in symptom journal";

// ── Observation-specific patterns (not shared with message screening) ──

const OBSERVATION_ONLY_PATTERNS: ScreeningPattern[] = [
  {
    ruleIdBase: "SEVERE-PAIN",
    pattern: /severe\s*pain|excruciating|unbearable\s*pain|10\s*out\s*of\s*10|10\/10\s*pain/i,
    severity: "warning",
    summary: "Patient reports severe pain {source}",
    rationale:
      "Patient described severe or excruciating pain. Uncontrolled severe pain warrants " +
      "prompt clinical reassessment of diagnosis and pain management plan.",
    suggested_action:
      "Contact patient to assess pain location, quality, and associated symptoms. " +
      "Consider whether current analgesic regimen is adequate.",
    notify_specialties: [],
  },
  {
    ruleIdBase: "FAINTING",
    pattern: /faint(ed|ing)|passed?\s*out|lost?\s*consciousness|syncop/i,
    severity: "warning",
    summary: "Patient reports fainting/syncope {source}",
    rationale:
      "Patient described syncope or near-syncope. This may indicate cardiac arrhythmia, " +
      "orthostatic hypotension, vasovagal episode, or neurological event.",
    suggested_action:
      "Contact patient to assess circumstances, frequency, and associated symptoms. " +
      "Consider cardiac workup and medication review.",
    notify_specialties: ["cardiology"],
  },
  {
    ruleIdBase: "SEIZURE",
    pattern: /seizure|convuls|shaking\s*uncontrollably|epilep/i,
    severity: "warning",
    summary: "Patient reports seizure activity {source}",
    rationale:
      "Patient described seizure or convulsion activity. New-onset seizures require " +
      "urgent neurological evaluation to rule out structural or metabolic causes.",
    suggested_action:
      "Contact patient urgently. Assess whether seizure is new-onset or breakthrough. " +
      "Consider neuroimaging if new-onset. Review medications for seizure threshold effects.",
    notify_specialties: ["neurology"],
  },
  {
    ruleIdBase: "HIGH-FEVER",
    pattern: /high\s*fever|temperature\s*(of\s*)?(10[3-9]|1[1-9]\d)|fever\s*(won'?t|doesn'?t|not)\s*(go\s*down|break|respond)/i,
    severity: "warning",
    summary: "Patient reports high or persistent fever {source}",
    rationale:
      "Patient reported high or unresponsive fever. In immunocompromised patients " +
      "(chemotherapy, transplant, HIV), this can indicate febrile neutropenia or serious infection.",
    suggested_action:
      "Check patient's medication list for chemotherapy/immunosuppressants. " +
      "If immunocompromised, treat as potential febrile neutropenia — advise ED evaluation.",
    notify_specialties: ["oncology", "infectious_disease"],
  },
];

const ALL_OBSERVATION_PATTERNS: ScreeningPattern[] = [
  ...SHARED_CRITICAL_PATTERNS,
  ...OBSERVATION_ONLY_PATTERNS,
];

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

  for (const p of ALL_OBSERVATION_PATTERNS) {
    if (p.pattern.test(description)) {
      const { rule_id, summary } = materializePattern(p, OBS_PREFIX, OBS_SOURCE);
      flags.push({
        severity: p.severity,
        category: "patient-reported" as FlagCategory,
        summary,
        rationale: p.rationale,
        suggested_action: p.suggested_action,
        notify_specialties: p.notify_specialties,
        rule_id,
      });
    }
  }

  return flags;
}

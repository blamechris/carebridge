/**
 * Patient message screening rules.
 *
 * Screens patient-sent messages for urgent clinical signals that shouldn't
 * wait for a provider to read them. This is a deterministic keyword-based
 * first pass — the LLM review layer catches subtler descriptions.
 *
 * Only fires on patient-originated messages (not provider messages).
 * Does NOT auto-reply to patients — only creates flags for clinical review.
 */

import type { FlagCategory, ClinicalEvent, RuleFlag } from "@carebridge/shared-types";
import {
  SHARED_CRITICAL_PATTERNS,
  materializePattern,
  type ScreeningPattern,
} from "./screening-patterns.js";

const MSG_PREFIX = "MSG";
const MSG_SOURCE = "in message";

// ── Message-specific patterns (not shared with observation screening) ──

const MESSAGE_ONLY_PATTERNS: ScreeningPattern[] = [
  {
    ruleIdBase: "FEVER-CHEMO",
    pattern: /fever|temperature\s*(of\s*)?(10[1-9]|1[1-9]\d)|chills/i,
    severity: "warning",
    summary: "Patient reports fever/chills {source}",
    rationale:
      "Patient reports fever or chills. In immunocompromised patients (chemotherapy, transplant, " +
      "HIV), fever can indicate febrile neutropenia or serious infection requiring emergent evaluation.",
    suggested_action:
      "Check patient's medication list for chemotherapy/immunosuppressants. " +
      "If immunocompromised, treat as potential febrile neutropenia — advise ED evaluation. " +
      "Otherwise, assess for infection source.",
    notify_specialties: ["oncology", "infectious_disease"],
  },
  {
    ruleIdBase: "FALL",
    pattern: /fell\s*(down|over)|had\s*a\s*fall|tripped\s*and\s*fell|lost\s*(my\s*)?balance\s*and\s*fell/i,
    severity: "warning",
    summary: "Patient reports fall {source}",
    rationale:
      "Patient reports a fall. This is particularly concerning in patients on anticoagulants " +
      "(risk of intracranial hemorrhage) or with osteoporosis (fracture risk).",
    suggested_action:
      "Assess for head injury, especially if on anticoagulants. Check for fracture symptoms. " +
      "Consider head CT if patient is on anticoagulants and hit their head.",
    notify_specialties: [],
  },
  {
    ruleIdBase: "NEW-WEAKNESS",
    pattern: /new\s*weakness|sudden\s*weakness|legs?\s*(gave|giving)\s*out|can'?t\s*stand|collapsed/i,
    severity: "warning",
    summary: "Patient reports new weakness or collapse {source}",
    rationale:
      "Patient describes new onset weakness or collapse. This could indicate neurological event, " +
      "cardiac arrhythmia, severe anemia, or medication side effect.",
    suggested_action:
      "Contact patient to assess onset, distribution, and associated symptoms. " +
      "Consider neurological evaluation if focal weakness.",
    notify_specialties: ["neurology"],
  },
];

const ALL_MESSAGE_PATTERNS: ScreeningPattern[] = [
  ...SHARED_CRITICAL_PATTERNS,
  ...MESSAGE_ONLY_PATTERNS,
];

/**
 * Screen a patient message for urgent symptoms.
 *
 * Only processes patient-originated messages (sender_role === "patient").
 * Checks the message text against urgent keyword patterns.
 */
export function screenPatientMessage(event: ClinicalEvent): RuleFlag[] {
  const flags: RuleFlag[] = [];

  // Only screen patient-sent messages
  if (event.data.sender_role !== "patient") return flags;

  // The BullMQ event payload intentionally omits message text (PHI-free).
  // The review service reads the body from the DB and passes it here via
  // an enriched event with data.message_text set to the DB-fetched content.
  const messageText = (event.data.message_text as string) ?? "";

  if (!messageText) return flags;

  for (const p of ALL_MESSAGE_PATTERNS) {
    if (p.pattern.test(messageText)) {
      const { rule_id, summary } = materializePattern(p, MSG_PREFIX, MSG_SOURCE);
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

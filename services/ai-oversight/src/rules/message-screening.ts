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

import type { FlagSeverity, FlagCategory, ClinicalEvent } from "@carebridge/shared-types";
import type { RuleFlag } from "./critical-values.js";

interface UrgentKeywordPattern {
  id: string;
  pattern: RegExp;
  severity: FlagSeverity;
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

/**
 * Urgent symptom keywords that should trigger immediate flags.
 * Patterns match against the message text (case-insensitive).
 */
const URGENT_PATTERNS: UrgentKeywordPattern[] = [
  {
    id: "MSG-CHEST-PAIN",
    pattern: /chest\s*pain|chest\s*tightness|chest\s*pressure|angina/i,
    severity: "critical",
    summary: "Patient reports chest pain/pressure in message",
    rationale:
      "Patient described chest pain or pressure symptoms in a secure message. " +
      "This could indicate acute coronary syndrome, pulmonary embolism, or other " +
      "cardiac emergency requiring immediate evaluation.",
    suggested_action:
      "Contact patient immediately. If symptoms are active, advise calling 911. " +
      "Assess onset, duration, severity, and associated symptoms.",
    notify_specialties: ["cardiology"],
  },
  {
    id: "MSG-BREATHING",
    pattern: /can'?t\s*breathe|difficulty\s*breathing|short(ness)?\s*(of)?\s*breath|severe\s*sob|gasping/i,
    severity: "critical",
    summary: "Patient reports difficulty breathing in message",
    rationale:
      "Patient described respiratory distress in a secure message. This could indicate " +
      "pulmonary embolism, CHF exacerbation, severe asthma attack, or other respiratory emergency.",
    suggested_action:
      "Contact patient immediately. If active respiratory distress, advise calling 911. " +
      "Assess oxygen saturation if available, onset, and progression.",
    notify_specialties: ["pulmonology"],
  },
  {
    id: "MSG-SEVERE-HEADACHE",
    pattern: /worst\s*headache|thunderclap\s*headache|sudden\s*severe\s*headache|worst\s*head\s*pain/i,
    severity: "critical",
    summary: "Patient reports sudden severe headache in message",
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
    id: "MSG-BLEEDING",
    pattern: /bleeding\s*(a\s*lot|heavily|won'?t\s*stop|profuse)|blood\s*in\s*(stool|urine|vomit)|coughing\s*(up\s*)?blood|hemoptysis|hematuria|melena|hematemesis/i,
    severity: "critical",
    summary: "Patient reports significant bleeding in message",
    rationale:
      "Patient described significant bleeding symptoms. This is particularly dangerous in patients " +
      "on anticoagulants, post-procedure, or with known bleeding disorders.",
    suggested_action:
      "Contact patient immediately. Check current medications for anticoagulants. " +
      "Assess volume, duration, and hemodynamic stability. Consider ED referral.",
    notify_specialties: ["hematology"],
  },
  {
    id: "MSG-STROKE-SYMPTOMS",
    pattern: /face\s*droop|arm\s*weakness|slurred\s*speech|sudden\s*numbness|sudden\s*confusion|vision\s*loss|can'?t\s*move\s*(my|arm|leg)/i,
    severity: "critical",
    summary: "Patient describes possible stroke symptoms in message",
    rationale:
      "Patient described symptoms consistent with acute stroke (FAST criteria: face droop, " +
      "arm weakness, speech difficulty). Time-sensitive — every minute matters for thrombolysis eligibility.",
    suggested_action:
      "IMMEDIATE: If symptoms are current, advise calling 911 immediately. " +
      "Document last known well time. Do not delay for further assessment.",
    notify_specialties: ["neurology"],
  },
  {
    id: "MSG-SUICIDAL",
    pattern: /suicid|want\s*to\s*die|kill\s*myself|end\s*(my|it)\s*(life|all)|don'?t\s*want\s*to\s*live|no\s*reason\s*to\s*live/i,
    severity: "critical",
    summary: "Patient expresses suicidal ideation in message",
    rationale:
      "Patient's message contains language suggesting suicidal ideation. This requires " +
      "immediate clinical assessment and safety planning regardless of other conditions.",
    suggested_action:
      "IMMEDIATE: Contact patient by phone. Assess imminent risk. If unable to reach, " +
      "consider welfare check. Involve behavioral health crisis team. Document safety plan.",
    notify_specialties: ["psychiatry"],
  },
  {
    id: "MSG-ALLERGIC-REACTION",
    pattern: /swelling\s*(of\s*)?(my\s*)?(face|throat|tongue|lips)|anaphyla|throat\s*(closing|swelling|tight)|hives\s*all\s*over|can'?t\s*swallow/i,
    severity: "critical",
    summary: "Patient describes possible anaphylaxis/allergic reaction in message",
    rationale:
      "Patient described symptoms consistent with severe allergic reaction or anaphylaxis. " +
      "This is a medical emergency requiring immediate intervention.",
    suggested_action:
      "IMMEDIATE: If symptoms are active, advise calling 911 and using epinephrine auto-injector if available. " +
      "Review current medications for potential culprit.",
    notify_specialties: [],
  },
  {
    id: "MSG-FEVER-CHEMO",
    pattern: /fever|temperature\s*(of\s*)?(10[1-9]|1[1-9]\d)|chills/i,
    severity: "warning",
    summary: "Patient reports fever/chills in message",
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
    id: "MSG-FALL",
    pattern: /fell\s*(down|over)|had\s*a\s*fall|tripped\s*and\s*fell|lost\s*(my\s*)?balance\s*and\s*fell/i,
    severity: "warning",
    summary: "Patient reports fall in message",
    rationale:
      "Patient reports a fall. This is particularly concerning in patients on anticoagulants " +
      "(risk of intracranial hemorrhage) or with osteoporosis (fracture risk).",
    suggested_action:
      "Assess for head injury, especially if on anticoagulants. Check for fracture symptoms. " +
      "Consider head CT if patient is on anticoagulants and hit their head.",
    notify_specialties: [],
  },
  {
    id: "MSG-NEW-WEAKNESS",
    pattern: /new\s*weakness|sudden\s*weakness|legs?\s*(gave|giving)\s*out|can'?t\s*stand|collapsed/i,
    severity: "warning",
    summary: "Patient reports new weakness or collapse in message",
    rationale:
      "Patient describes new onset weakness or collapse. This could indicate neurological event, " +
      "cardiac arrhythmia, severe anemia, or medication side effect.",
    suggested_action:
      "Contact patient to assess onset, distribution, and associated symptoms. " +
      "Consider neurological evaluation if focal weakness.",
    notify_specialties: ["neurology"],
  },
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

  // Get message text — the event carries the message_id, but for keyword
  // screening we need the text. The messaging service should include a
  // sanitized excerpt in the event data for screening purposes.
  const messageText = (event.data.message_text as string) ?? "";

  if (!messageText) return flags;

  for (const pattern of URGENT_PATTERNS) {
    if (pattern.pattern.test(messageText)) {
      flags.push({
        severity: pattern.severity,
        category: "patient-reported" as FlagCategory,
        summary: pattern.summary,
        rationale: pattern.rationale,
        suggested_action: pattern.suggested_action,
        notify_specialties: pattern.notify_specialties,
        rule_id: pattern.id,
      });
    }
  }

  return flags;
}

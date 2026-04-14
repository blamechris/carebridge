/**
 * Shared keyword patterns for patient screening rules.
 *
 * Both message-screening and observation-screening need to detect the same
 * urgent clinical signals (chest pain, stroke symptoms, suicidal ideation, etc.).
 * This module is the single source of truth for those patterns so they cannot
 * drift independently.
 *
 * Each entry defines the regex, default severity, clinical metadata, and a
 * `ruleIdBase` that the consuming module prefixes with its own context
 * (e.g. "MSG-" or "OBS-").
 */

import type { FlagSeverity } from "@carebridge/shared-types";

export interface ScreeningPattern {
  /** Base identifier — consumers prepend a context prefix (MSG- / OBS-). */
  ruleIdBase: string;
  /** Case-insensitive regex matched against free-text input. */
  pattern: RegExp;
  /** Default severity when the pattern fires. */
  severity: FlagSeverity;
  /** One-line clinical summary template. Use `{source}` as a placeholder
   *  that consumers replace with context (e.g. "in message" / "in symptom journal"). */
  summary: string;
  rationale: string;
  suggested_action: string;
  notify_specialties: string[];
}

// ── Critical patterns — immediately life-threatening ──────────────────

export const SHARED_CRITICAL_PATTERNS: ScreeningPattern[] = [
  {
    ruleIdBase: "CHEST-PAIN",
    pattern: /chest\s*pain|chest\s*tightness|chest\s*pressure|angina/i,
    severity: "critical",
    summary: "Patient reports chest pain/pressure {source}",
    rationale:
      "Patient described chest pain or pressure symptoms. " +
      "This could indicate acute coronary syndrome, pulmonary embolism, or other " +
      "cardiac emergency requiring immediate evaluation.",
    suggested_action:
      "Contact patient immediately. If symptoms are active, advise calling 911. " +
      "Assess onset, duration, severity, and associated symptoms.",
    notify_specialties: ["cardiology"],
  },
  {
    ruleIdBase: "BREATHING",
    pattern: /can'?t\s*breathe|difficulty\s*breathing|short(ness)?\s*(of)?\s*breath|severe\s*sob|gasping/i,
    severity: "critical",
    summary: "Patient reports difficulty breathing {source}",
    rationale:
      "Patient described respiratory distress. This could indicate " +
      "pulmonary embolism, CHF exacerbation, severe asthma attack, or other respiratory emergency.",
    suggested_action:
      "Contact patient immediately. If active respiratory distress, advise calling 911. " +
      "Assess oxygen saturation if available, onset, and progression.",
    notify_specialties: ["pulmonology"],
  },
  {
    ruleIdBase: "SEVERE-HEADACHE",
    pattern: /worst\s*headache|thunderclap\s*headache|sudden\s*severe\s*headache|worst\s*head\s*pain/i,
    severity: "critical",
    summary: "Patient reports sudden severe headache {source}",
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
    ruleIdBase: "STROKE-SYMPTOMS",
    pattern: /face\s*droop|arm\s*weakness|slurred\s*speech|sudden\s*numbness|sudden\s*confusion|vision\s*loss|can'?t\s*move\s*(my\s*)?(arm|leg|hand|foot|side)\b/i,
    severity: "critical",
    summary: "Patient describes possible stroke symptoms {source}",
    rationale:
      "Patient described symptoms consistent with acute stroke (FAST criteria: face droop, " +
      "arm weakness, speech difficulty). Time-sensitive — every minute matters for thrombolysis eligibility.",
    suggested_action:
      "IMMEDIATE: If symptoms are current, advise calling 911 immediately. " +
      "Document last known well time. Do not delay for further assessment.",
    notify_specialties: ["neurology"],
  },
  {
    ruleIdBase: "SUICIDAL",
    pattern: /suicid|want\s*to\s*die|kill\s*myself|end\s*(my|it)\s*(life|all)|don'?t\s*want\s*to\s*live|no\s*reason\s*to\s*live/i,
    severity: "critical",
    summary: "Patient expresses suicidal ideation {source}",
    rationale:
      "Patient's text contains language suggesting suicidal ideation. This requires " +
      "immediate clinical assessment and safety planning regardless of other conditions.",
    suggested_action:
      "IMMEDIATE: Contact patient by phone. Assess imminent risk. If unable to reach, " +
      "consider welfare check. Involve behavioral health crisis team. Document safety plan.",
    notify_specialties: ["psychiatry"],
  },
  {
    ruleIdBase: "ALLERGIC-REACTION",
    pattern: /swelling\s*(of\s*)?(my\s*)?(face|throat|tongue|lips)|anaphyla|throat\s*(closing|swelling|tight)|hives\s*all\s*over|can'?t\s*swallow/i,
    severity: "critical",
    summary: "Patient describes possible anaphylaxis/allergic reaction {source}",
    rationale:
      "Patient described symptoms consistent with severe allergic reaction or anaphylaxis. " +
      "This is a medical emergency requiring immediate intervention.",
    suggested_action:
      "IMMEDIATE: If symptoms are active, advise calling 911 and using epinephrine auto-injector if available. " +
      "Review current medications for potential culprit.",
    notify_specialties: [],
  },
  {
    ruleIdBase: "BLEEDING",
    pattern: /bleeding\s*(a\s*lot|heavily|won'?t\s*stop|profuse)|blood\s*in\s*(stool|urine|vomit)|coughing\s*(up\s*)?blood|hemoptysis|hematuria|melena|hematemesis/i,
    severity: "critical",
    summary: "Patient reports significant bleeding {source}",
    rationale:
      "Patient described significant bleeding symptoms. This is particularly dangerous in patients " +
      "on anticoagulants, post-procedure, or with known bleeding disorders.",
    suggested_action:
      "Contact patient to assess volume and duration. Check current medications for anticoagulants. " +
      "Consider ED referral if hemodynamically significant.",
    notify_specialties: ["hematology"],
  },
];

/**
 * Build a concrete rule ID and summary from a shared pattern definition.
 *
 * @param p       - shared pattern entry
 * @param prefix  - context prefix, e.g. "MSG" or "OBS"
 * @param source  - human-readable source label, e.g. "in message" or "in symptom journal"
 */
export function materializePattern(
  p: ScreeningPattern,
  prefix: string,
  source: string,
): { rule_id: string; summary: string } {
  return {
    rule_id: `${prefix}-${p.ruleIdBase}`,
    summary: p.summary.replace("{source}", source),
  };
}

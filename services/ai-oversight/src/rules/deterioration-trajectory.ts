/**
 * DETERIORATION-TRAJECTORY-001 — the founding rule of CareBridge.
 *
 * In memory of Lisa Bowen, whose hospital course was the founding case
 * for this rule family. The pattern this rule catches — care coordination
 * failure across multiple admissions, soft signals never aggregated, and
 * discharge decisions made before unresolved concerns were addressed — is
 * the pattern that killed her. We could not save her. We can try to make
 * the next family's story end differently.
 *
 * Umbrella rule that runs the cross-specialty deterioration sub-detectors
 * (see packages/medical-logic/src/deterioration-patterns.ts) and emits a
 * single composite flag when ≥1 sub-rule fires.
 *
 * The founding context for this rule is in MISSION.md. The product
 * motivation: surface cross-specialty deterioration patterns that tired
 * or siloed clinicians miss, especially during inpatient stays and
 * discharge decisions. The failure class is care coordination — no
 * single specialty owns the trajectory; each sees their slice.
 *
 * Triggers:
 *   - new admission for a patient with prior CareBridge data
 *   - shift change (≥ 8h since last evaluation)
 *   - discharge decision (note template == "discharge", or discharge
 *     order placed, or manual flag)
 *
 * The orchestrator decides when to call this rule based on the above
 * triggers; this module only encodes "given the context, did the
 * deterioration pattern fire?"
 *
 * Status: scaffolding milestone (2026-05). Initial sub-rule set:
 *   - READMISSION-TRAJECTORY (1st priority — most aligned with founding case)
 *   - DISCHARGE-READINESS (2nd priority)
 *   - CROSS-SPECIALTY-SYMPTOM-ORPHAN (3rd priority)
 *
 * Future sub-rules tracked in MISSION.md:
 *   - WARNING-SIGN-AGGREGATOR (SIRS / qSOFA / MEWS)
 *   - COPY-FORWARD-DRIFT
 *   - CONSULT-LOOP-OPEN (standalone, fires at shift change)
 *
 * Clinical threshold calibration is pending per LAUNCH-CHECKLIST.md.
 * Current thresholds are intentionally conservative — the goal at this
 * milestone is to prove the scaffolding wires correctly, not to ship
 * production-grade clinical content.
 */

import type { RuleFlag, FlagSeverity } from "@carebridge/shared-types";
import {
  detectReadmissionTrajectory,
  detectDischargeReadinessRisk,
  detectCrossSpecialtySymptomOrphan,
  type PatternResult,
} from "@carebridge/medical-logic";
import type { PatientContext } from "./cross-specialty.js";

export const DETERIORATION_TRAJECTORY_RULE_ID = "DETERIORATION-TRAJECTORY-001";

interface SubRuleHit {
  rule: string;
  result: PatternResult;
}

/**
 * Severity escalation policy: the umbrella inherits the highest severity
 * implied by any fired sub-rule. Sub-rules are weighted as follows for
 * the scaffolding milestone:
 *
 *   - READMISSION-TRAJECTORY (rising creatinine / falling Hgb etc):
 *     - warning baseline
 *     - critical if ≥3 admissions in window AND ≥2 worsening labs
 *
 *   - DISCHARGE-READINESS:
 *     - warning baseline
 *     - critical if discharge imminent AND (open consult + worsening lab)
 *
 *   - CROSS-SPECIALTY-SYMPTOM-ORPHAN:
 *     - warning baseline (no critical path at this milestone — the
 *       absence of workup alone is not by itself a critical signal
 *       without other context)
 */
function severityFor(hits: SubRuleHit[]): FlagSeverity {
  for (const hit of hits) {
    if (hit.rule === "READMISSION-TRAJECTORY") {
      const admissions = hit.result.details?.admissions_in_window;
      const worsening = hit.result.details?.worsening_labs;
      if (
        typeof admissions === "number" &&
        admissions >= 2 &&
        Array.isArray(worsening) &&
        worsening.length >= 2
      ) {
        return "critical";
      }
    }
    if (hit.rule === "DISCHARGE-READINESS") {
      const details = hit.result.details ?? {};
      const hasOpenConsult = Array.isArray(details.open_consults) && details.open_consults.length > 0;
      const hasWorseningLab = Array.isArray(details.worsening_labs_in_current) && details.worsening_labs_in_current.length > 0;
      if (hasOpenConsult && hasWorseningLab) return "critical";
    }
  }
  return "warning";
}

function notifySpecialtiesFor(hits: SubRuleHit[], ctx: PatientContext): string[] {
  const result = new Set<string>();
  // Always include the attending — they own the trajectory.
  if (ctx.current_encounter?.attending_specialty) {
    result.add(ctx.current_encounter.attending_specialty);
  }
  // Care-team specialties that already exist.
  for (const s of ctx.care_team_specialties ?? []) result.add(s);
  // Specialties that documented orphan symptoms — they should know.
  for (const hit of hits) {
    if (hit.rule === "CROSS-SPECIALTY-SYMPTOM-ORPHAN") {
      const orphaned = hit.result.details?.orphaned_symptoms as
        | Array<{ specialties: string[] }>
        | undefined;
      for (const o of orphaned ?? []) {
        for (const s of o.specialties) result.add(s);
      }
    }
  }
  // Hospitalist is the default owner of the trajectory; include if absent.
  if (result.size === 0) result.add("hospitalist");
  return Array.from(result);
}

function buildSummary(hits: SubRuleHit[]): string {
  return (
    `Possible deterioration trajectory (${hits.length} sub-pattern${hits.length === 1 ? "" : "s"} fired): ` +
    hits.map((h) => h.rule).join(", ")
  );
}

function buildRationale(hits: SubRuleHit[]): string {
  const lines = ["The following cross-specialty deterioration patterns fired:"];
  for (const hit of hits) {
    lines.push(`• ${hit.rule}: ${hit.result.summary ?? "(no summary)"}`);
  }
  lines.push(
    "",
    "These patterns surface from looking across notes/admissions/specialties together. " +
      "Each pattern individually is a soft signal; together they suggest deterioration " +
      "that may not be apparent from any single specialty's note.",
    "",
    "Reference: MISSION.md § First rule: DETERIORATION-TRAJECTORY-001.",
  );
  return lines.join("\n");
}

function buildSuggestedAction(hits: SubRuleHit[]): string {
  const actions: string[] = [];
  for (const hit of hits) {
    if (hit.rule === "READMISSION-TRAJECTORY") {
      actions.push(
        "Compare current labs/vitals against prior discharge values. Consider whether the current admission's problem list captures the deteriorating trend across admissions.",
      );
    }
    if (hit.rule === "DISCHARGE-READINESS") {
      actions.push(
        "Re-evaluate discharge timing. Confirm consult loops are closed and trending labs have stabilized or are addressed in the discharge plan.",
      );
    }
    if (hit.rule === "CROSS-SPECIALTY-SYMPTOM-ORPHAN") {
      actions.push(
        "Decide which specialty owns the workup for each cross-specialty symptom listed. Document the plan in a single note rather than relying on parallel specialty notes.",
      );
    }
  }
  if (actions.length === 0) {
    return "Review the deterioration patterns listed in the rationale.";
  }
  return actions.join(" ");
}

/**
 * Run the deterioration umbrella against a patient context. Returns a
 * single RuleFlag if any sub-pattern fired, otherwise null.
 *
 * The orchestrator decides when to invoke this rule (admission with
 * priors, shift change, discharge signal). This function does NOT gate
 * on those triggers itself — that's the orchestrator's responsibility,
 * because the rule may be invoked manually (e.g. for testing or for the
 * bridge view).
 */
export function checkDeteriorationTrajectory(ctx: PatientContext): RuleFlag | null {
  const hits: SubRuleHit[] = [];

  // 1. READMISSION-TRAJECTORY
  if (
    ctx.prior_encounters &&
    ctx.current_encounter &&
    ctx.prior_encounters.length > 0
  ) {
    const r = detectReadmissionTrajectory({
      prior_encounters: ctx.prior_encounters,
      current_encounter: ctx.current_encounter,
      lab_trends: ctx.lab_trends,
      vital_trends: ctx.vital_trends,
    });
    if (r.fired) hits.push({ rule: "READMISSION-TRAJECTORY", result: r });
  }

  // 2. DISCHARGE-READINESS
  if (ctx.discharge_signal?.is_discharge_imminent) {
    const r = detectDischargeReadinessRisk({
      discharge_signal: ctx.discharge_signal,
      consult_requests: ctx.consult_requests,
      lab_trends: ctx.lab_trends,
      recent_symptoms: ctx.new_symptoms,
      current_encounter_id: ctx.current_encounter?.encounter_id,
    });
    if (r.fired) hits.push({ rule: "DISCHARGE-READINESS", result: r });
  }

  // 3. CROSS-SPECIALTY-SYMPTOM-ORPHAN
  if (ctx.symptom_observations && ctx.symptom_observations.length > 0) {
    const r = detectCrossSpecialtySymptomOrphan({
      symptom_observations: ctx.symptom_observations,
    });
    if (r.fired) hits.push({ rule: "CROSS-SPECIALTY-SYMPTOM-ORPHAN", result: r });
  }

  if (hits.length === 0) return null;

  return {
    severity: severityFor(hits),
    category: "trend-concern",
    summary: buildSummary(hits),
    rationale: buildRationale(hits),
    suggested_action: buildSuggestedAction(hits),
    notify_specialties: notifySpecialtiesFor(hits, ctx),
    rule_id: DETERIORATION_TRAJECTORY_RULE_ID,
    metadata: {
      sub_rules_fired: hits.map((h) => h.rule),
      sub_rule_details: Object.fromEntries(
        hits.map((h) => [h.rule, h.result.details ?? {}]),
      ),
    },
  };
}

/**
 * Drug class cross-reaction anchors used in the clinical review prompt.
 *
 * These concrete examples give the LLM retrieval anchors so it reliably
 * flags allergy–medication cross-reactions.  Any change to this list MUST
 * go through the sign-off process documented in docs/ai-prompt-editing.md.
 */

export interface DrugClassCrossReaction {
  /** Allergy class (e.g. "penicillin") */
  class: string;
  /** Examples of drugs or sub-classes that cross-react */
  examples: string[];
}

export const DRUG_CLASS_CROSS_REACTIONS: readonly DrugClassCrossReaction[] = [
  { class: "penicillin", examples: ["amoxicillin", "ampicillin", "piperacillin"] },
  { class: "sulfa", examples: ["sulfonamide antibiotics"] },
  { class: "aspirin", examples: ["other NSAIDs"] },
] as const;

/**
 * Render the cross-reaction list into a prompt-friendly string.
 * Example output:
 *   penicillin allergy cross-reacts with amoxicillin, ampicillin, piperacillin;
 *   sulfa allergy cross-reacts with sulfonamide antibiotics; ...
 */
export function renderDrugClassAnchors(): string {
  return DRUG_CLASS_CROSS_REACTIONS.map(
    (r) => `${r.class} allergy cross-reacts with ${r.examples.join(", ")}`,
  ).join("; ");
}

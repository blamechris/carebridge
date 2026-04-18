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
  { class: "cephalosporin", examples: ["cefazolin", "ceftriaxone", "cephalexin", "cefepime"] },
  { class: "penicillin-cephalosporin-cross", examples: ["penicillin → cephalosporin (~2% cross-reactivity)"] },
  { class: "sulfa", examples: ["sulfonamide antibiotics", "sulfamethoxazole", "bactrim"] },
  { class: "aspirin", examples: ["other NSAIDs", "ibuprofen", "naproxen", "celecoxib"] },
  { class: "opioid", examples: ["codeine", "morphine", "hydrocodone", "oxycodone", "fentanyl"] },
  { class: "fluoroquinolone", examples: ["ciprofloxacin", "levofloxacin", "moxifloxacin"] },
  { class: "ACE inhibitor", examples: ["lisinopril", "enalapril", "ramipril", "captopril"] },
  { class: "statin", examples: ["atorvastatin", "simvastatin", "rosuvastatin", "pravastatin"] },
  { class: "macrolide", examples: ["azithromycin", "erythromycin", "clarithromycin"] },
  { class: "tetracycline", examples: ["doxycycline", "minocycline", "tigecycline"] },
  { class: "benzodiazepine", examples: ["diazepam", "lorazepam", "alprazolam", "clonazepam"] },
  { class: "iodinated contrast", examples: ["iohexol", "iopamidol", "iodixanol"] },
  { class: "latex", examples: ["natural rubber latex"] },
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

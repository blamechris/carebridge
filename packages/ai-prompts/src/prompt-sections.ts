/**
 * Shared section marker constants used by the clinical review prompt
 * builder and the token budget truncation engine.
 *
 * Keeping these in one place prevents drift between the two modules
 * and makes it easy to rename or reorder sections.
 */

export const PROMPT_SECTIONS = {
  DEMOGRAPHICS: "Demographics",
  DIAGNOSES: "Active Diagnoses",
  ALLERGIES: "Allergies",
  MEDICATIONS: "Active Medications",
  VITALS: "Latest Vitals",
  LABS: "Recent Lab Results",
  CARE_TEAM: "Care Team",
  FLAGS: "Recent Open Flags",
  // Phase A3 — temporal context window
  TIMELINE: "30-Day Event Timeline",
  CLUSTERS: "Temporal Clusters",
  GAPS: "Detected Care Gaps",
  TRIGGERING_EVENT: "TRIGGERING EVENT",
} as const;

export type PromptSectionKey = keyof typeof PROMPT_SECTIONS;
export type PromptSectionLabel = (typeof PROMPT_SECTIONS)[PromptSectionKey];

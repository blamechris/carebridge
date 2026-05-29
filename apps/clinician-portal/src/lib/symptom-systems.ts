/**
 * Body-system grouping for the SOAP Subjective checkboxes.
 *
 * Issue #1306 — clinicians scan by body system, so the New Symptoms grid
 * and the Review of Systems grid both render as collapsible sections
 * grouped by body system instead of one flat checkbox flow.
 *
 * Two inputs feed grouping:
 *
 *   1. New Symptoms options are raw lowercase strings (e.g. "headache",
 *      "chest pain"). They have no prefix, so we look them up in the
 *      curated SYMPTOM_SYSTEM_MAP below. Anything unmapped falls back
 *      to "Other" so the UI never silently drops an option.
 *
 *   2. Review of Systems options come from the shared template as
 *      "<system-key>: <symptom>" pairs (e.g. "constitutional: fever").
 *      We split on the first colon and map the prefix through
 *      ROS_PREFIX_TO_SYSTEM to a canonical title-cased body system.
 *
 * BODY_SYSTEM_ORDER pins the render order. Per the design, the five
 * "common" systems lead in a clinically motivated order, then anything
 * else falls back to alphabetical (handled by the caller, not here).
 */

export type BodySystem =
  | "Neurological"
  | "Cardiovascular"
  | "Respiratory"
  | "Gastrointestinal"
  | "Constitutional"
  | "Eyes"
  | "ENT"
  | "Genitourinary"
  | "Musculoskeletal"
  | "Skin"
  | "Psychiatric"
  | "Endocrine"
  | "Hematologic"
  | "Allergic/Immunologic"
  | "Other";

/**
 * Canonical render order for body-system sections.
 * The first five are the design-pinned "lead" order; remaining systems
 * sort alphabetically after these via the consumer.
 */
export const BODY_SYSTEM_ORDER: BodySystem[] = [
  "Neurological",
  "Cardiovascular",
  "Respiratory",
  "Gastrointestinal",
  "Constitutional",
];

/**
 * Lookup of a New Symptoms label to its body system. Mirrors the
 * groupings hard-coded in services/clinical-notes/src/templates/soap.ts
 * so the UI grouping stays in lockstep with the template's intent.
 */
export const SYMPTOM_SYSTEM_MAP: Record<string, BodySystem> = {
  // Neurological
  headache: "Neurological",
  dizziness: "Neurological",
  numbness: "Neurological",
  tingling: "Neurological",
  "vision changes": "Neurological",
  "speech difficulty": "Neurological",
  confusion: "Neurological",
  syncope: "Neurological",
  seizure: "Neurological",
  // Cardiovascular
  "chest pain": "Cardiovascular",
  palpitations: "Cardiovascular",
  edema: "Cardiovascular",
  // Respiratory
  cough: "Respiratory",
  "shortness of breath": "Respiratory",
  wheezing: "Respiratory",
  // Gastrointestinal
  nausea: "Gastrointestinal",
  vomiting: "Gastrointestinal",
  diarrhea: "Gastrointestinal",
  "abdominal pain": "Gastrointestinal",
  // Constitutional
  fever: "Constitutional",
  fatigue: "Constitutional",
  "weight loss": "Constitutional",
  "night sweats": "Constitutional",
};

/**
 * Canonical title-cased body system per ROS prefix. Aligns with the
 * ROS_SYSTEMS keys in @carebridge/shared-types/notes.ts.
 */
export const ROS_PREFIX_TO_SYSTEM: Record<string, BodySystem> = {
  constitutional: "Constitutional",
  eyes: "Eyes",
  ent: "ENT",
  cardiovascular: "Cardiovascular",
  respiratory: "Respiratory",
  gi: "Gastrointestinal",
  gastrointestinal: "Gastrointestinal",
  genitourinary: "Genitourinary",
  gu: "Genitourinary",
  ms: "Musculoskeletal",
  musculoskeletal: "Musculoskeletal",
  skin: "Skin",
  neuro: "Neurological",
  neurological: "Neurological",
  psych: "Psychiatric",
  psychiatric: "Psychiatric",
  endocrine: "Endocrine",
  heme: "Hematologic",
  hematologic: "Hematologic",
  allergic_immunologic: "Allergic/Immunologic",
  "allergic/immunologic": "Allergic/Immunologic",
};

/**
 * Look up the body system for a New Symptoms label. Unknown labels
 * fall back to "Other" so the UI surfaces them in their own section
 * rather than dropping the checkbox.
 */
export function getSymptomSystem(label: string): BodySystem {
  return SYMPTOM_SYSTEM_MAP[label] ?? "Other";
}

/**
 * Parse a ROS option (e.g. "constitutional: fever") into its body
 * system + bare symptom label. Returns "Other" for options that do
 * not match the "<prefix>: <suffix>" shape, so unprefixed strings
 * still appear (in an "Other" section) instead of being lost.
 */
export function parseROSOption(option: string): {
  system: BodySystem;
  symptom: string;
} {
  const colon = option.indexOf(":");
  if (colon === -1) {
    return { system: "Other", symptom: option.trim() };
  }
  const prefix = option.slice(0, colon).trim().toLowerCase();
  const symptom = option.slice(colon + 1).trim();
  const system = ROS_PREFIX_TO_SYSTEM[prefix] ?? "Other";
  return { system, symptom };
}

/**
 * Sort a set of body systems with the canonical leaders first and the
 * remainder alphabetical. Used to render section headers in the order
 * the design requires.
 */
export function sortBodySystems(systems: BodySystem[]): BodySystem[] {
  const present = new Set(systems);
  const lead = BODY_SYSTEM_ORDER.filter((s) => present.has(s));
  const rest = systems
    .filter((s) => !BODY_SYSTEM_ORDER.includes(s))
    .sort((a, b) => a.localeCompare(b));
  // De-dupe while preserving the lead-first ordering.
  const seen = new Set<BodySystem>();
  const out: BodySystem[] = [];
  for (const s of [...lead, ...rest]) {
    if (!seen.has(s)) {
      seen.add(s);
      out.push(s);
    }
  }
  return out;
}

/**
 * Phase B1 — check-in template seed library.
 *
 * Four launch templates, each carrying a declarative `red_flag` on the
 * questions that the Phase B4 rule engine cares about. Templates are
 * immutable once published; bumping a question set means inserting a
 * new row with the same `slug` and an incremented `version` — historical
 * submissions keep rendering against the version they were written for.
 *
 * The templates exist to do three things:
 *
 *   1. Catch the same patterns the deterministic clinical rules catch,
 *      but from the *patient voice* — e.g., oncology weekly primes
 *      CHEMO-FEVER-001 and ONCO-VTE-NEURO-001 by surfacing
 *      patient-reported fever + neuro symptoms before the next lab.
 *
 *   2. Give clinicians a structured, queryable record of patient-
 *      reported symptoms between visits. The free-text daily-diary
 *      slot is low-signal on its own, but the AI oversight engine
 *      can correlate it with structured data.
 *
 *   3. Provide a honest "red_flag present → escalate to clinician"
 *      path so families can fill these out on behalf of an incapacitated
 *      patient without waiting for a clinician to notice.
 *
 * target_condition drives template-to-patient routing in the portal
 * AND scoping in the B4 rule family. The four values here are the
 * initial vocabulary — add new ones only alongside a new rule.
 */

import type { CheckInQuestion } from "@carebridge/db-schema";
import { checkInTemplates, getDb } from "@carebridge/db-schema";
import crypto from "node:crypto";

interface SeedTemplate {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: number;
  target_condition: string;
  frequency: string;
  questions: CheckInQuestion[];
}

/**
 * Post-discharge red-flag check-in.
 *
 * Highest-value window for catching preventable readmissions. Fires the
 * first 14 days after any discharge. Diagnosis-agnostic — discharge
 * diagnosis is stored on the check-in submission so the rule engine can
 * apply condition-specific logic when it has one.
 */
const postDischargeTemplate: SeedTemplate = {
  id: crypto.randomUUID(),
  slug: "post-discharge-red-flags",
  name: "Post-Discharge Red Flag Check",
  description:
    "Quick daily check for the two weeks after hospital discharge. " +
    "The questions are focused on the symptoms most often missed " +
    "during the transition home.",
  version: 1,
  target_condition: "post_discharge",
  frequency: "daily",
  questions: [
    {
      id: "fever",
      prompt: "Have you had a temperature of 100.4°F (38°C) or higher?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "new_or_worse_pain",
      prompt: "Is your pain worse than when you left the hospital?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "wound_problem",
      prompt:
        "If you have a surgical wound or incision, is there new redness, swelling, or drainage?",
      type: "select",
      required: false,
      options: [
        { value: "none", label: "No wound / no problem" },
        { value: "mild", label: "A little redness, no drainage" },
        { value: "moderate", label: "Redness spreading OR new drainage" },
        { value: "severe", label: "Hot, very painful, or pus" },
      ],
      red_flag: { kind: "values", values: ["moderate", "severe"] },
    },
    {
      id: "breathing",
      prompt: "Are you short of breath at rest or when doing simple activities?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "bleeding",
      prompt:
        "Have you noticed new bleeding (nose, gums, stool, urine, or unusual bruising)?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "meds_taken",
      prompt: "Have you taken all your discharge medications as prescribed?",
      type: "boolean",
      required: true,
    },
    {
      id: "notes",
      prompt: "Anything else you want the care team to know? (optional)",
      type: "text",
      required: false,
    },
  ],
};

/**
 * Oncology weekly check-in.
 *
 * Designed specifically to surface the inputs Phase B4 needs for the
 * CHEMO-FEVER-001 and ONCO-VTE-NEURO-001 rules. Run weekly during
 * active treatment; cadence can be changed by a clinician at assign
 * time.
 */
const oncologyWeeklyTemplate: SeedTemplate = {
  id: crypto.randomUUID(),
  slug: "oncology-weekly",
  name: "Oncology Weekly Check-In",
  description:
    "Weekly check for patients in active cancer treatment. Focuses on " +
    "the symptoms most associated with chemo toxicity, infection risk, " +
    "and cancer-associated thrombotic events.",
  version: 1,
  target_condition: "oncology",
  frequency: "weekly",
  questions: [
    {
      id: "fever",
      prompt: "Have you had a temperature of 100.4°F (38°C) or higher this week?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "chills_or_rigors",
      prompt: "Have you had shaking chills (rigors) this week?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "new_neuro_symptoms",
      prompt:
        "Have you had any new headaches, vision changes, weakness, numbness, confusion, or trouble speaking?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "new_bleeding",
      prompt:
        "Have you had any unusual bleeding or new bruising that didn't come from an injury?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "leg_swelling_or_pain",
      prompt:
        "Do you have new swelling or pain in one leg, or new calf tenderness?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "fatigue_level",
      prompt:
        "How tired do you feel this week? (0 = normal energy, 10 = can't get out of bed)",
      type: "scale",
      required: true,
      red_flag: { kind: "threshold", gte: 8 },
    },
    {
      id: "pain_level",
      prompt:
        "How bad is your worst pain right now? (0 = none, 10 = worst imaginable)",
      type: "scale",
      required: true,
      red_flag: { kind: "threshold", gte: 8 },
    },
    {
      id: "nausea_vomiting",
      prompt: "Are you unable to keep food or fluids down?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "notes",
      prompt: "Anything else you want your oncology team to know?",
      type: "text",
      required: false,
    },
  ],
};

/**
 * Cardiac weekly check-in.
 *
 * Targets CHF decompensation — daily weight, dyspnea, orthopnea, and
 * edema. The red-flag thresholds are pre-wired for the Phase B4 rule
 * family; clinicians can request a new template version with tightened
 * thresholds per patient later without breaking historical rows.
 */
const cardiacWeeklyTemplate: SeedTemplate = {
  id: crypto.randomUUID(),
  slug: "cardiac-weekly",
  name: "Heart Failure Weekly Check-In",
  description:
    "Weekly surveillance for heart failure decompensation. Tracks daily " +
    "weight, breathlessness, and swelling — the three earliest signs a " +
    "medication adjustment may be needed.",
  version: 1,
  target_condition: "cardiac",
  frequency: "weekly",
  questions: [
    {
      id: "weight_gain_lbs",
      prompt:
        "How much weight have you gained in the last 3 days? (in pounds — enter 0 if none)",
      type: "number",
      required: true,
      red_flag: { kind: "threshold", gte: 3 },
    },
    {
      id: "dyspnea_at_rest",
      prompt: "Are you short of breath while sitting still?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "orthopnea",
      prompt:
        "Do you need more pillows than usual to breathe comfortably at night?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "paroxysmal_nocturnal_dyspnea",
      prompt:
        "Have you woken up at night gasping for breath or having to sit up to breathe?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "leg_swelling",
      prompt: "How swollen are your ankles / legs today?",
      type: "select",
      required: true,
      options: [
        { value: "none", label: "Not swollen" },
        { value: "mild", label: "A little swollen, same as usual" },
        { value: "moderate", label: "More swollen than usual" },
        { value: "severe", label: "Much more swollen, shoes don't fit" },
      ],
      red_flag: { kind: "values", values: ["moderate", "severe"] },
    },
    {
      id: "chest_pain",
      prompt: "Have you had chest pain or pressure this week?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "dizzy_or_lightheaded",
      prompt:
        "Have you felt dizzy or lightheaded, especially when standing up?",
      type: "boolean",
      required: true,
      red_flag: { kind: "bool", when: true },
    },
    {
      id: "meds_taken",
      prompt: "Have you taken all your heart medications as prescribed?",
      type: "boolean",
      required: true,
    },
    {
      id: "notes",
      prompt: "Anything else your cardiology team should know?",
      type: "text",
      required: false,
    },
  ],
};

/**
 * Daily symptom diary.
 *
 * Low signal-to-noise on its own, but its value is correlation: a
 * patient-reported pain-10 on the same day as a critical lab is a
 * different clinical story than either signal alone, and the daily
 * diary is what gives the AI oversight engine a time-aligned
 * patient-voice channel.
 */
const dailyDiaryTemplate: SeedTemplate = {
  id: crypto.randomUUID(),
  slug: "daily-symptom-diary",
  name: "Daily Symptom Diary",
  description:
    "A short daily check-in that anyone can fill out. Helps your care " +
    "team see trends and catch problems early.",
  version: 1,
  target_condition: "general",
  frequency: "daily",
  questions: [
    {
      id: "pain",
      prompt:
        "How bad is your worst pain right now? (0 = none, 10 = worst imaginable)",
      type: "scale",
      required: true,
      red_flag: { kind: "threshold", gte: 8 },
    },
    {
      id: "energy",
      prompt:
        "How is your energy today? (0 = normal, 10 = can't get out of bed)",
      type: "scale",
      required: true,
      red_flag: { kind: "threshold", gte: 8 },
    },
    {
      id: "mood",
      prompt:
        "How is your mood today? (0 = same as usual, 10 = very low / hopeless)",
      type: "scale",
      required: true,
      red_flag: { kind: "threshold", gte: 8 },
    },
    {
      id: "appetite",
      prompt: "Are you eating and drinking normally?",
      type: "boolean",
      required: true,
    },
    {
      id: "new_symptoms",
      prompt:
        "Any new symptoms today? (fever, bleeding, breathing trouble, severe headache, chest pain, etc.)",
      type: "multi",
      required: false,
      options: [
        { value: "fever", label: "Fever ≥ 100.4°F" },
        { value: "bleeding", label: "New bleeding or bruising" },
        { value: "shortness_of_breath", label: "Shortness of breath" },
        { value: "severe_headache", label: "Severe headache" },
        { value: "chest_pain", label: "Chest pain or pressure" },
        { value: "leg_swelling", label: "New leg swelling or calf pain" },
        { value: "confusion", label: "Confusion or trouble speaking" },
      ],
      red_flag: {
        kind: "values",
        values: [
          "fever",
          "bleeding",
          "shortness_of_breath",
          "severe_headache",
          "chest_pain",
          "leg_swelling",
          "confusion",
        ],
      },
    },
    {
      id: "notes",
      prompt: "Anything else? (optional, free text)",
      type: "text",
      required: false,
    },
  ],
};

export const CHECKIN_TEMPLATE_SEEDS: SeedTemplate[] = [
  postDischargeTemplate,
  oncologyWeeklyTemplate,
  cardiacWeeklyTemplate,
  dailyDiaryTemplate,
];

/**
 * Idempotent insert: for each seed template, insert the row if no row
 * with its slug+version already exists. Deliberately does not update
 * existing rows — templates are immutable once published.
 */
export async function seedCheckInTemplates(
  db: ReturnType<typeof getDb>,
  timestamp: string,
): Promise<void> {
  const existing = await db
    .select({
      slug: checkInTemplates.slug,
      version: checkInTemplates.version,
    })
    .from(checkInTemplates);
  const existingKeys = new Set(
    existing.map((row) => `${row.slug}:${row.version}`),
  );

  for (const template of CHECKIN_TEMPLATE_SEEDS) {
    const key = `${template.slug}:${template.version}`;
    if (existingKeys.has(key)) {
      console.log(
        `[seed] check-in template ${key} already present, skipping`,
      );
      continue;
    }
    await db.insert(checkInTemplates).values({
      id: template.id,
      slug: template.slug,
      name: template.name,
      description: template.description,
      version: template.version,
      questions: JSON.stringify(template.questions),
      target_condition: template.target_condition,
      frequency: template.frequency,
      published_at: timestamp,
      retired_at: null,
      created_at: timestamp,
    });
    console.log(
      `[seed] inserted check-in template ${template.slug} v${template.version}`,
    );
  }
}

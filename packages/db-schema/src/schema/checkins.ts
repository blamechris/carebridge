/**
 * Phase B1 — Patient & family check-ins.
 *
 * Check-ins are structured, template-driven symptom surveys that patients
 * (or authorised family members) fill out from the patient portal. They
 * are one of the two patient-voice inputs to the AI oversight engine —
 * the other being the clinical note stream from providers — and they
 * fire a `checkin.submitted` ClinicalEvent so the review worker can
 * evaluate red-flag rules against the responses + the patient's full
 * clinical context.
 *
 * Design notes:
 *
 *  - **Templates are versioned.** A check-in submission stores
 *    `template_id` + `template_version`, so editing a template (adding
 *    a question, rewording one) never invalidates or retroactively
 *    changes historical submissions. The rule engine and UI render
 *    historical submissions against the version they were captured
 *    under.
 *
 *  - **Responses are encrypted at rest.** The `responses` JSONB column
 *    uses the same `encryptedJsonb` pattern as `clinical_notes.sections`
 *    because it contains patient-reported PHI (symptom descriptions,
 *    medication adherence, etc.).
 *
 *  - **Submitter attribution.** `submitted_by_user_id` is the user who
 *    filled out the form — for self-submissions this equals the
 *    patient's user id; for family-submitted check-ins it's the family
 *    member's user id. `submitted_by_relationship` records the
 *    relationship ("self", "spouse", "adult_child", "healthcare_poa")
 *    so clinicians reviewing the check-in know whose voice they're
 *    reading. Any mutation that touches a check-in is audited through
 *    the existing audit pipeline.
 *
 *  - **Scope of the check-in / rules interaction.** The `template`
 *    row's `target_condition` column is used by the review worker as
 *    a coarse filter when evaluating Phase B4 red-flag rules — e.g.,
 *    the oncology weekly template carries `target_condition="oncology"`
 *    so the rule engine can short-circuit cardiac check-in rules for
 *    a cancer patient without walking every template.
 */

import { pgTable, text, integer, index } from "drizzle-orm/pg-core";
import { encryptedJsonb } from "../encryption.js";
import { patients } from "./patients.js";
import { users } from "./auth.js";

const encryptedResponses = encryptedJsonb<unknown>();

/**
 * A check-in question as rendered in the patient portal. The shape is
 * intentionally minimal — templates are authored in `tooling/seed/` and
 * loaded into the DB, not edited via UI.
 *
 * `type` drives the form renderer:
 *   - `boolean`   → yes/no toggle, answer stored as boolean
 *   - `scale`     → 0–10 slider (for pain, fatigue, etc.)
 *   - `number`    → free numeric (weight, temperature)
 *   - `select`    → single choice from `options`
 *   - `multi`     → multi-select from `options`
 *   - `text`      → short free text (sanitised upstream on submit)
 *
 * `red_flag` is the pre-computed trigger that Phase B4 rules consult:
 * the presence of a red-flag answer is what fires the review worker.
 */
export interface CheckInQuestion {
  id: string;
  prompt: string;
  type: "boolean" | "scale" | "number" | "select" | "multi" | "text";
  required?: boolean;
  options?: { value: string; label: string }[];
  /**
   * When set, the response matches a red flag. For boolean: `true`
   * means "yes is the red flag"; for scale/number: `{ gte: 8 }` etc.;
   * for select/multi: `{ values: ["shortness_of_breath"] }`.
   * The exact matching rules are implemented in the Phase B4 rule
   * module (`checkin-redflags.ts`) — this is just the declarative
   * hint the rule engine reads.
   */
  red_flag?:
    | { kind: "bool"; when: boolean }
    | { kind: "threshold"; gte?: number; lte?: number }
    | { kind: "values"; values: string[] };
}

/**
 * Library of check-in templates. Versioned so templates can evolve
 * without orphaning historical submissions. A template is "active" in
 * the UI when `published_at` is set and `retired_at` is null.
 *
 * Seeded via `tooling/seed/checkin-templates.ts`.
 */
export const checkInTemplates = pgTable(
  "check_in_templates",
  {
    id: text("id").primaryKey(),
    /** Stable slug used by the UI and rules — e.g. "oncology-weekly". */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    /**
     * Monotonic integer version per slug. `slug + version` is globally
     * unique; bumping version creates a new row.
     */
    version: integer("version").notNull().default(1),
    /**
     * Questions JSON — an array of {@link CheckInQuestion}. Stored as a
     * plain JSONB column because templates contain no PHI (they're
     * literally "do you have chest pain?" not anyone's answer).
     */
    questions: text("questions").notNull(), // JSON string of CheckInQuestion[]
    /**
     * Target clinical population. Used by the review worker to short-
     * circuit rule evaluation and by the UI to route patients to the
     * right template ("oncology", "cardiac", "post_discharge", "general").
     */
    target_condition: text("target_condition").notNull(),
    /**
     * Suggested cadence — "daily", "weekly", "post_discharge_day_1",
     * "ad_hoc". Not enforced by the backend; clinicians use it as a
     * default assignment hint in the portal.
     */
    frequency: text("frequency").notNull(),
    published_at: text("published_at"),
    retired_at: text("retired_at"),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_checkin_templates_slug_version").on(table.slug, table.version),
    index("idx_checkin_templates_target").on(table.target_condition),
  ],
);

/**
 * A single patient check-in submission. One row per completed survey.
 * Immutable after insert — corrections happen by submitting a new row
 * referencing the same template, not by editing.
 */
export const checkIns = pgTable(
  "check_ins",
  {
    id: text("id").primaryKey(),
    patient_id: text("patient_id")
      .notNull()
      .references(() => patients.id),
    template_id: text("template_id")
      .notNull()
      .references(() => checkInTemplates.id),
    /**
     * Snapshot of the template version this submission was rendered
     * against, so rule evaluation and historical rendering always
     * reflect the questions the patient actually saw.
     */
    template_version: integer("template_version").notNull(),
    /** User who actually typed the answers (self OR family member). */
    submitted_by_user_id: text("submitted_by_user_id")
      .notNull()
      .references(() => users.id),
    /**
     * Relationship of submitter to patient. "self" for patient-entered;
     * "spouse" / "adult_child" / "parent" / "healthcare_poa" / "other"
     * for family-entered. Matches the Phase B3 family_relationships
     * taxonomy so the attribution shows up consistently in audit logs.
     */
    submitted_by_relationship: text("submitted_by_relationship").notNull(),
    /**
     * Answers keyed by question id, encrypted at rest. Shape is
     * `{ [questionId: string]: boolean | number | string | string[] }`,
     * mirroring the template's declared question types. We store this
     * as encrypted JSON because it contains patient-reported PHI.
     */
    responses: encryptedResponses("responses").notNull(),
    /**
     * Pre-computed list of question ids whose answers matched a
     * red_flag rule on the template. The review worker reads this
     * directly; the rule engine can also re-evaluate from `responses`
     * if needed (defence-in-depth against stale red_flag_hits columns
     * after template edits).
     */
    red_flag_hits: text("red_flag_hits").notNull().default("[]"), // JSON string of string[]
    submitted_at: text("submitted_at").notNull(),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    index("idx_check_ins_patient").on(table.patient_id, table.submitted_at),
    index("idx_check_ins_template").on(table.template_id, table.template_version),
    index("idx_check_ins_submitter").on(table.submitted_by_user_id),
  ],
);

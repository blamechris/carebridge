import { pgTable, text, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { patients, allergies } from "./patients.js";
import { clinicalFlags } from "./ai-flags.js";
import { users } from "./auth.js";

/**
 * Structured allergy-override audit trail (issue #233).
 *
 * Prior to this table, clinicians overriding an allergy or contraindication
 * warning had to dismiss the resulting clinical_flag with a free-text
 * `dismiss_reason`. Free text is insufficient for HIPAA quality review —
 * auditors can't aggregate by reason, the rule layer can't recognise that
 * a specific allergy-drug pair has already been cleared, and there's no
 * guarantee the clinician provided a meaningful rationale at all.
 *
 * Every row is a permanent record. Deletion is NOT a supported operation.
 * Re-overriding the same flag inserts a new row with an updated timestamp
 * so the override history is fully reconstructible.
 *
 * Related:
 *  - migration 0037_allergy_overrides.sql — schema + reason CHECK constraint
 *  - services/ai-oversight/src/rules/allergy-medication.ts — suppresses
 *    flags for allergy-drug pairs with an existing override
 *  - services/api-gateway/src/routers/patient-records.ts — `allergies.override`
 *    procedure that inserts override + audit row + flag dismissal in one tx
 */
export const allergyOverrides = pgTable(
  "allergy_overrides",
  {
    id: text("id").primaryKey(),
    patient_id: text("patient_id")
      .notNull()
      .references(() => patients.id),
    // Nullable for contraindication overrides where the trigger was a
    // drug-class cross-check without a specific patient_allergies row.
    allergy_id: text("allergy_id").references(() => allergies.id),
    flag_id: text("flag_id")
      .notNull()
      .references(() => clinicalFlags.id),
    overridden_by: text("overridden_by")
      .notNull()
      .references(() => users.id),
    // Constrained by CHECK in 0037_allergy_overrides.sql to one of:
    //   mild_reaction_ok | patient_tolerated_previously | benefit_exceeds_risk
    //   desensitized | misdiagnosed_allergy | other
    override_reason: text("override_reason").notNull(),
    clinical_justification: text("clinical_justification").notNull(),
    overridden_at: text("overridden_at")
      .notNull()
      .$defaultFn(() => new Date().toISOString()),
  },
  (table) => [
    index("idx_allergy_overrides_patient").on(
      table.patient_id,
      table.overridden_at,
    ),
    // Partial index: most queries filter to rows with a specific allergy,
    // and contraindication-only overrides (allergy_id NULL) don't benefit.
    index("idx_allergy_overrides_allergy")
      .on(table.allergy_id)
      .where(sql`allergy_id IS NOT NULL`),
    index("idx_allergy_overrides_flag").on(table.flag_id),
  ],
);

/** Allowed `override_reason` enum values (mirrors the DB CHECK constraint). */
export const ALLERGY_OVERRIDE_REASONS = [
  "mild_reaction_ok",
  "patient_tolerated_previously",
  "benefit_exceeds_risk",
  "desensitized",
  "misdiagnosed_allergy",
  "other",
] as const;

export type AllergyOverrideReason = (typeof ALLERGY_OVERRIDE_REASONS)[number];

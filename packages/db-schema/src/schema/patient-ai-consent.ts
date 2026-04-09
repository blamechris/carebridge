/**
 * Phase D P1 — patient consent for AI processing.
 *
 * Tracks per-patient opt-in for LLM-based clinical review. Deterministic
 * rule evaluation does NOT require a consent row — rules run on data
 * that a patient has already agreed to share with their care team. The
 * LLM path DOES require an explicit, unrevoked consent because it
 * transmits derived clinical context to an external processor (Anthropic).
 *
 * Lifecycle:
 *   - A row is inserted when the patient (or an authorized proxy)
 *     affirmatively opts in to AI-assisted oversight from the patient
 *     portal or during intake.
 *   - `granted_at` records the moment of opt-in.
 *   - `revoked_at` is null while consent is active. Revocation is a
 *     state transition, not a delete — the historical grant remains
 *     auditable.
 *   - A patient may have multiple rows over time (grant → revoke → grant).
 *     Active consent is the row where `revoked_at IS NULL` with the
 *     most recent `granted_at`.
 *
 * The `scope` column lets us narrow what categories the consent covers.
 * Phase D P1 ships with a single scope (`llm_review`) but the column is
 * present so Phase B (check-ins) and Phase A note extraction can layer
 * additional scopes without a migration.
 *
 * Versioning: `policy_version` stores the ID of the consent-language
 * document the patient agreed to (e.g. "ai-consent-v1.0"). When the
 * policy text changes, existing consents stay scoped to the version
 * they were granted under and the review worker can check whether a
 * grant still covers the current policy.
 */

import { pgTable, text, index } from "drizzle-orm/pg-core";
import { patients } from "./patients.js";
import { users } from "./auth.js";

export type AiConsentScope =
  | "llm_review"
  | "note_extraction"
  | "checkin_review";

export const patientAiConsent = pgTable(
  "patient_ai_consent",
  {
    id: text("id").primaryKey(),
    patient_id: text("patient_id")
      .notNull()
      .references(() => patients.id),
    /**
     * What this grant covers. A patient can have one row per scope active
     * at any time — e.g. they might allow LLM review but not note
     * extraction while deciding. See {@link AiConsentScope}.
     */
    scope: text("scope").notNull(),
    /**
     * ID of the consent document / policy version the patient agreed to.
     * Stored as opaque text so future policy rewrites don't require a
     * schema change.
     */
    policy_version: text("policy_version").notNull(),
    /**
     * User who captured the consent. For patient-initiated consent this
     * is the patient's own user id. For proxy-captured consent (incapacitated
     * adult, minor, etc.) this is the proxying user — the same model as
     * Phase B family access.
     */
    granted_by_user_id: text("granted_by_user_id")
      .notNull()
      .references(() => users.id),
    /**
     * Relationship of the grantor to the patient. "self" for patient-
     * initiated; "healthcare_poa", "parent", "guardian", "attending_physician"
     * for proxy-captured.
     */
    granted_by_relationship: text("granted_by_relationship").notNull(),
    granted_at: text("granted_at").notNull(),
    /**
     * Null while the grant is active. Populated on revocation; the row
     * is never deleted.
     */
    revoked_at: text("revoked_at"),
    /**
     * User who revoked the grant. Null while active.
     */
    revoked_by_user_id: text("revoked_by_user_id"),
    revocation_reason: text("revocation_reason"),
    created_at: text("created_at").notNull(),
  },
  (table) => [
    // Primary lookup: "does this patient currently consent to this scope?"
    // Queried on every review job's LLM gate, so the composite index
    // covers the happy path without touching the rest of the row.
    index("idx_patient_ai_consent_active").on(
      table.patient_id,
      table.scope,
      table.revoked_at,
      table.granted_at,
    ),
  ],
);

/**
 * Family access schema.
 *
 * Patients can invite family members / caregivers to view a subset of
 * their health information. Each invitation creates a pending invite;
 * once accepted the invite transitions into an active relationship.
 *
 * Ownership invariant: only the patient who granted access (or an admin)
 * may revoke a relationship or cancel a pending invite.
 *
 * Data integrity constraints (see issue #311):
 *  - CHECK on `relationship_type` and `status` to enforce enum-like values
 *  - Partial UNIQUE index on (patient_id, caregiver_id) WHERE status='active'
 *    prevents duplicate active relationships
 *  - `access_scopes` stored as JSONB array of individual permission tokens,
 *    queryable via Postgres jsonb operators and validated by CHECK
 *  - Foreign keys use ON DELETE CASCADE so that removing a user or patient
 *    does not leave orphaned relationship / invite rows
 */

import { pgTable, text, jsonb, index, uniqueIndex, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { users } from "./auth.js";

/**
 * Permitted relationship-type values. Mirrored in the CHECK constraint.
 */
export const FAMILY_RELATIONSHIP_TYPES = [
  "spouse",
  "parent",
  "child",
  "sibling",
  "healthcare_poa",
  "other",
] as const;
export type FamilyRelationshipType = (typeof FAMILY_RELATIONSHIP_TYPES)[number];

/**
 * Permitted status values for active relationships.
 */
export const FAMILY_RELATIONSHIP_STATUSES = ["active", "revoked"] as const;
export type FamilyRelationshipStatus =
  (typeof FAMILY_RELATIONSHIP_STATUSES)[number];

/**
 * Permitted status values for pending invites.
 */
export const FAMILY_INVITE_STATUSES = [
  "pending",
  "accepted",
  "cancelled",
  "expired",
] as const;
export type FamilyInviteStatus = (typeof FAMILY_INVITE_STATUSES)[number];

/**
 * Permitted access-scope tokens. Stored as JSONB array so relationships can
 * carry multiple granular scopes and be queried at the database level.
 */
export const FAMILY_ACCESS_SCOPES = [
  "read_only",
  "view_summary",
  "view_appointments",
  "view_medications",
  "view_labs",
  "view_notes",
  "view_and_message",
] as const;
export type FamilyAccessScope = (typeof FAMILY_ACCESS_SCOPES)[number];

/**
 * Active family-access relationships.
 *
 * `patient_id` is the user who granted access.
 * `caregiver_id` is the user who received access.
 */
export const familyRelationships = pgTable(
  "family_relationships",
  {
    id: text("id").primaryKey(),
    patient_id: text("patient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    caregiver_id: text("caregiver_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    relationship_type: text("relationship_type").notNull(),
    status: text("status").notNull().default("active"),
    access_scopes: jsonb("access_scopes")
      .$type<FamilyAccessScope[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    granted_at: text("granted_at").notNull(),
    revoked_at: text("revoked_at"),
    revoked_by: text("revoked_by"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_family_rel_patient").on(table.patient_id),
    index("idx_family_rel_caregiver").on(table.caregiver_id),
    index("idx_family_rel_status").on(table.status),
    // Only one active relationship per (patient, caregiver) pair.
    // Revoked rows are retained for audit and excluded from the uniqueness check.
    uniqueIndex("idx_family_rel_active_unique")
      .on(table.patient_id, table.caregiver_id)
      .where(sql`status = 'active'`),
    check(
      "family_rel_relationship_type_check",
      sql`relationship_type IN ('spouse','parent','child','sibling','healthcare_poa','other')`,
    ),
    check(
      "family_rel_status_check",
      sql`status IN ('active','revoked')`,
    ),
    check(
      "family_rel_access_scopes_is_array",
      sql`jsonb_typeof(access_scopes) = 'array'`,
    ),
  ],
);

/**
 * Pending family-access invitations.
 *
 * `patient_id` is the user who sent the invite.
 * `invitee_email` is the email address of the person being invited.
 */
export const familyInvites = pgTable(
  "family_invites",
  {
    id: text("id").primaryKey(),
    patient_id: text("patient_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    invitee_email: text("invitee_email").notNull(),
    relationship_type: text("relationship_type").notNull(),
    status: text("status").notNull().default("pending"),
    access_scopes: jsonb("access_scopes")
      .$type<FamilyAccessScope[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    token: text("token").notNull().unique(),
    expires_at: text("expires_at").notNull(),
    cancelled_at: text("cancelled_at"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    index("idx_family_invite_patient").on(table.patient_id),
    index("idx_family_invite_email").on(table.invitee_email),
    index("idx_family_invite_status").on(table.status),
    index("idx_family_invite_token").on(table.token),
    check(
      "family_invite_relationship_type_check",
      sql`relationship_type IN ('spouse','parent','child','sibling','healthcare_poa','other')`,
    ),
    check(
      "family_invite_status_check",
      sql`status IN ('pending','accepted','cancelled','expired')`,
    ),
    check(
      "family_invite_access_scopes_is_array",
      sql`jsonb_typeof(access_scopes) = 'array'`,
    ),
  ],
);

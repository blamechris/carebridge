/**
 * Family access schema.
 *
 * Patients can invite family members / caregivers to view a subset of
 * their health information. Each invitation creates a pending invite;
 * once accepted the invite transitions into an active relationship.
 *
 * Ownership invariant: only the patient who granted access (or an admin)
 * may revoke a relationship or cancel a pending invite.
 */

import { sql } from "drizzle-orm";
import { pgTable, text, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./auth.js";

/**
 * Active family-access relationships.
 *
 * `patient_id` is the user who granted access.
 * `caregiver_id` is the user who received access.
 */
export const familyRelationships = pgTable("family_relationships", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => users.id),
  caregiver_id: text("caregiver_id").notNull().references(() => users.id),
  relationship_type: text("relationship_type").notNull(), // spouse, parent, child, sibling, other
  status: text("status").notNull().default("active"), // active, revoked
  granted_at: text("granted_at").notNull(),
  revoked_at: text("revoked_at"),
  revoked_by: text("revoked_by"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => [
  index("idx_family_rel_patient").on(table.patient_id),
  index("idx_family_rel_caregiver").on(table.caregiver_id),
  index("idx_family_rel_status").on(table.status),
  // Partial unique index: one active relationship per (patient, caregiver).
  // See issue #308 and migration 0026_family_access_dedup.sql.
  uniqueIndex("idx_family_rel_active_unique")
    .on(table.patient_id, table.caregiver_id)
    .where(sql`revoked_at IS NULL`),
]);

/**
 * Pending family-access invitations.
 *
 * `patient_id` is the user who sent the invite.
 * `invitee_email` is the email address of the person being invited.
 */
export const familyInvites = pgTable("family_invites", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => users.id),
  invitee_email: text("invitee_email").notNull(),
  relationship_type: text("relationship_type").notNull(),
  status: text("status").notNull().default("pending"), // pending, accepted, cancelled, expired
  token: text("token").notNull().unique(),
  expires_at: text("expires_at").notNull(),
  cancelled_at: text("cancelled_at"),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => [
  index("idx_family_invite_patient").on(table.patient_id),
  index("idx_family_invite_email").on(table.invitee_email),
  index("idx_family_invite_status").on(table.status),
  index("idx_family_invite_token").on(table.token),
]);

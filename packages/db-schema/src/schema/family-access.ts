import crypto from "node:crypto";
import { pgTable, text, boolean, index } from "drizzle-orm/pg-core";
import { patients } from "./patients.js";
import { users } from "./auth.js";

/**
 * Active family-caregiver relationships. A row here means the
 * patient (or, in Phase B3 proxy cases, an authorized clinician)
 * has granted a family user scoped access to the patient's data.
 *
 * Access is revocable at any time by the patient or by any attending
 * clinician on the care team.
 */
export const familyRelationships = pgTable("family_relationships", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  family_user_id: text("family_user_id").notNull().references(() => users.id),
  /** Relationship taxonomy — matches checkInRelationshipSchema. */
  relationship: text("relationship").notNull(), // spouse, adult_child, parent, healthcare_poa, other
  /**
   * Comma-separated access scopes the patient granted. Each scope is
   * independently revocable; an empty string means all scopes revoked
   * (functionally equivalent to revoking the relationship).
   */
  access_scopes: text("access_scopes").notNull(), // view_summary,view_appointments,submit_checkins,view_checkins_history,view_flags
  consented_at: text("consented_at").notNull(),
  revoked_at: text("revoked_at"), // null = active
  revoked_by: text("revoked_by"), // user_id of whoever revoked; null if active
  created_at: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("idx_family_rel_patient").on(table.patient_id, table.revoked_at),
  index("idx_family_rel_user").on(table.family_user_id, table.revoked_at),
]);

/**
 * Pending invitations sent by a patient to a family member.
 *
 * The flow is:
 *   1. Patient enters family member email + selects relationship + scopes
 *   2. System creates a `family_invites` row with a signed token
 *   3. Family member receives email with invite link
 *   4. Family member clicks link → consent landing page
 *   5. On consent: system creates user (if needed) + family_relationship row
 *   6. Invite row is marked accepted
 *
 * Invites expire after 7 days. The patient can cancel a pending invite.
 */
export const familyInvites = pgTable("family_invites", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  /** The patient user_id who initiated the invite. */
  invited_by: text("invited_by").notNull().references(() => users.id),
  /** Email of the family member being invited. */
  invitee_email: text("invitee_email").notNull(),
  relationship: text("relationship").notNull(),
  access_scopes: text("access_scopes").notNull(),
  /** Opaque signed token embedded in the invite link. */
  token: text("token").notNull().unique(),
  status: text("status").notNull().default("pending"), // pending, accepted, cancelled, expired
  expires_at: text("expires_at").notNull(),
  accepted_at: text("accepted_at"),
  cancelled_at: text("cancelled_at"),
  created_at: text("created_at").notNull().$defaultFn(() => new Date().toISOString()),
}, (table) => [
  index("idx_family_invite_patient").on(table.patient_id, table.status),
  index("idx_family_invite_token").on(table.token),
]);

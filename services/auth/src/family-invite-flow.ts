/**
 * Family access service layer.
 *
 * Provides invite, accept, revoke, and cancel operations for patient-to-
 * caregiver family access relationships.
 *
 * SECURITY: Every mutation validates ownership — the caller must be the
 * patient who created the relationship/invite, the affected caregiver,
 * or an admin. See issue #305.
 *
 * DATA INTEGRITY (issue #308):
 *   - createFamilyInvite rejects self-invites (patient email === invitee email).
 *   - createFamilyInvite and acceptFamilyInvite both reject creating a
 *     second active relationship for the same (patient, caregiver) pair.
 *   - acceptFamilyInvite runs inside a database transaction with
 *     SELECT ... FOR UPDATE on the invite row to close the concurrent-
 *     accept race window.
 */

import { TRPCError } from "@trpc/server";
import {
  getDb,
  familyRelationships,
  familyInvites,
  auditLog,
  users,
} from "@carebridge/db-schema";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ---- Invite creation ----

/**
 * Create a pending family access invite for the given patient.
 *
 * Rejects:
 *   - self-invites (patient's own email)
 *   - invitees who already hold an active relationship with this patient
 */
export async function createFamilyInvite(
  patientId: string,
  inviteeEmail: string,
  relationshipType: string,
): Promise<{ id: string; token: string; expires_at: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS).toISOString();
  const normalizedInvitee = normalizeEmail(inviteeEmail);

  // --- Self-invite prevention (issue #308) -------------------------------
  const [patient] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, patientId))
    .limit(1);

  if (!patient) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Patient not found." });
  }

  if (normalizeEmail(patient.email) === normalizedInvitee) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "You cannot send a family access invite to yourself.",
    });
  }

  // --- Duplicate-relationship prevention (issue #308) --------------------
  // If the invitee already has a user account AND an active relationship
  // with this patient, reject. (If the invitee has no account yet, the
  // duplicate check is re-applied at accept time inside the transaction.)
  const [existingCaregiver] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normalizedInvitee))
    .limit(1);

  if (existingCaregiver) {
    const [existingRel] = await db
      .select({ id: familyRelationships.id })
      .from(familyRelationships)
      .where(
        and(
          eq(familyRelationships.patient_id, patientId),
          eq(familyRelationships.caregiver_id, existingCaregiver.id),
          eq(familyRelationships.status, "active"),
        ),
      )
      .limit(1);

    if (existingRel) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "An active family access relationship already exists for this caregiver.",
      });
    }
  }

  await db.insert(familyInvites).values({
    id,
    patient_id: patientId,
    invitee_email: normalizedInvitee,
    relationship_type: relationshipType,
    status: "pending",
    token,
    expires_at: expiresAt,
    created_at: now,
    updated_at: now,
  });

  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: patientId,
    action: "family_invite_created",
    resource_type: "family_invite",
    resource_id: id,
    details: JSON.stringify({
      invitee_email: normalizedInvitee,
      relationship_type: relationshipType,
    }),
    timestamp: now,
  });

  return { id, token, expires_at: expiresAt };
}

// ---- Accept invite ----

/**
 * Accept a pending family access invite.
 *
 * Wrapped in a database transaction so that two concurrent accepts with
 * the same token cannot both succeed:
 *   1. The invite row is locked with SELECT ... FOR UPDATE.
 *   2. Status and expiry are validated under the lock.
 *   3. The existing-relationship duplicate check runs under the lock.
 *   4. The relationship is inserted and the invite is marked accepted
 *      atomically.
 *
 * A partial unique index on family_relationships (patient_id, caregiver_id)
 * WHERE revoked_at IS NULL provides a database-level backstop (migration
 * 0026_family_access_dedup.sql).
 */
export async function acceptFamilyInvite(
  inviteToken: string,
  caregiverId: string,
): Promise<{ relationship_id: string }> {
  const db = getDb();
  const now = new Date().toISOString();

  return db.transaction(async (tx) => {
    // Lock the invite row so concurrent accepts serialize through here.
    const [invite] = await tx
      .select()
      .from(familyInvites)
      .where(
        and(
          eq(familyInvites.token, inviteToken),
          eq(familyInvites.status, "pending"),
        ),
      )
      .for("update")
      .limit(1);

    if (!invite) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Invalid or expired invite.",
      });
    }

    if (new Date(invite.expires_at) < new Date()) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "This invite has expired.",
      });
    }

    // A patient must never be able to accept their own invite as the
    // caregiver (defense-in-depth beyond the create-time self-invite check).
    if (invite.patient_id === caregiverId) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "You cannot accept your own family access invite.",
      });
    }

    // Duplicate-relationship check inside the transaction so two
    // concurrent invites can't both create active rows.
    const [existingRel] = await tx
      .select({ id: familyRelationships.id })
      .from(familyRelationships)
      .where(
        and(
          eq(familyRelationships.patient_id, invite.patient_id),
          eq(familyRelationships.caregiver_id, caregiverId),
          eq(familyRelationships.status, "active"),
        ),
      )
      .limit(1);

    if (existingRel) {
      throw new TRPCError({
        code: "CONFLICT",
        message:
          "An active family access relationship already exists for this caregiver.",
      });
    }

    // Transition invite to accepted.
    await tx
      .update(familyInvites)
      .set({ status: "accepted", updated_at: now })
      .where(eq(familyInvites.id, invite.id));

    // Create the active relationship. If a concurrent transaction somehow
    // slipped past the check above, the partial unique index will make
    // this INSERT fail and the transaction rolls back.
    const relId = crypto.randomUUID();
    try {
      await tx.insert(familyRelationships).values({
        id: relId,
        patient_id: invite.patient_id,
        caregiver_id: caregiverId,
        relationship_type: invite.relationship_type,
        status: "active",
        granted_at: now,
        created_at: now,
        updated_at: now,
      });
    } catch (err) {
      // Database-level unique-violation backstop.
      if (isUniqueViolation(err)) {
        throw new TRPCError({
          code: "CONFLICT",
          message:
            "An active family access relationship already exists for this caregiver.",
        });
      }
      throw err;
    }

    await tx.insert(auditLog).values({
      id: crypto.randomUUID(),
      user_id: caregiverId,
      action: "family_invite_accepted",
      resource_type: "family_relationship",
      resource_id: relId,
      details: JSON.stringify({
        invite_id: invite.id,
        patient_id: invite.patient_id,
      }),
      timestamp: now,
    });

    return { relationship_id: relId };
  });
}

function isUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  // Postgres unique_violation SQLSTATE.
  return code === "23505";
}

// ---- Revoke relationship ----

/**
 * Revoke a family access relationship.
 *
 * Ownership check: the caller must be the patient who granted access,
 * the caregiver whose access is being revoked, or an admin.
 * Throws FORBIDDEN if the caller does not own the relationship.
 */
export async function revokeFamilyAccess(
  relationshipId: string,
  callerId: string,
  callerRole: string,
): Promise<void> {
  const db = getDb();

  const [rel] = await db
    .select()
    .from(familyRelationships)
    .where(eq(familyRelationships.id, relationshipId))
    .limit(1);

  if (!rel) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Relationship not found." });
  }

  if (rel.status === "revoked") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Relationship is already revoked." });
  }

  // Ownership validation (issue #305)
  const isOwner = rel.patient_id === callerId;
  const isCaregiver = rel.caregiver_id === callerId;
  const isAdmin = callerRole === "admin";

  if (!isOwner && !isCaregiver && !isAdmin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have permission to revoke this relationship.",
    });
  }

  const now = new Date().toISOString();
  await db
    .update(familyRelationships)
    .set({ status: "revoked", revoked_at: now, revoked_by: callerId, updated_at: now })
    .where(eq(familyRelationships.id, relationshipId));

  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: callerId,
    action: "family_access_revoked",
    resource_type: "family_relationship",
    resource_id: relationshipId,
    details: JSON.stringify({
      patient_id: rel.patient_id,
      caregiver_id: rel.caregiver_id,
    }),
    timestamp: now,
  });
}

// ---- Cancel invite ----

/**
 * Cancel a pending family access invite.
 *
 * Ownership check: only the patient who created the invite (or an admin)
 * may cancel it. Throws FORBIDDEN otherwise.
 */
export async function cancelFamilyInvite(
  inviteId: string,
  callerId: string,
  callerRole: string,
): Promise<void> {
  const db = getDb();

  const [invite] = await db
    .select()
    .from(familyInvites)
    .where(eq(familyInvites.id, inviteId))
    .limit(1);

  if (!invite) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invite not found." });
  }

  if (invite.status !== "pending") {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invite is not pending." });
  }

  // Ownership validation (issue #305)
  const isOwner = invite.patient_id === callerId;
  const isAdmin = callerRole === "admin";

  if (!isOwner && !isAdmin) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "You do not have permission to cancel this invite.",
    });
  }

  const now = new Date().toISOString();
  await db
    .update(familyInvites)
    .set({ status: "cancelled", cancelled_at: now, updated_at: now })
    .where(eq(familyInvites.id, inviteId));

  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: callerId,
    action: "family_invite_cancelled",
    resource_type: "family_invite",
    resource_id: inviteId,
    details: JSON.stringify({ patient_id: invite.patient_id }),
    timestamp: now,
  });
}

// ---- List helpers ----

export async function listFamilyRelationships(patientId: string) {
  const db = getDb();
  return db
    .select()
    .from(familyRelationships)
    .where(
      and(
        eq(familyRelationships.patient_id, patientId),
        eq(familyRelationships.status, "active"),
      ),
    );
}

export async function listFamilyInvites(patientId: string) {
  const db = getDb();
  return db
    .select()
    .from(familyInvites)
    .where(
      and(
        eq(familyInvites.patient_id, patientId),
        eq(familyInvites.status, "pending"),
      ),
    );
}

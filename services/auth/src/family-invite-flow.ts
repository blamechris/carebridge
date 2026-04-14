/**
 * Family access service layer.
 *
 * Provides invite, accept, revoke, and cancel operations for patient-to-
 * caregiver family access relationships.
 *
 * SECURITY: Every mutation validates ownership — the caller must be the
 * patient who created the relationship/invite, the affected caregiver,
 * or an admin. See issue #305.
 */

import { TRPCError } from "@trpc/server";
import {
  getDb,
  familyRelationships,
  familyInvites,
  auditLog,
} from "@carebridge/db-schema";
import { eq, and } from "drizzle-orm";
import crypto from "node:crypto";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ---- Invite creation ----

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

  await db.insert(familyInvites).values({
    id,
    patient_id: patientId,
    invitee_email: inviteeEmail,
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
    details: JSON.stringify({ invitee_email: inviteeEmail, relationship_type: relationshipType }),
    timestamp: now,
  });

  return { id, token, expires_at: expiresAt };
}

// ---- Accept invite ----

export async function acceptFamilyInvite(
  inviteToken: string,
  caregiverId: string,
): Promise<{ relationship_id: string }> {
  const db = getDb();
  const now = new Date().toISOString();

  const [invite] = await db
    .select()
    .from(familyInvites)
    .where(and(eq(familyInvites.token, inviteToken), eq(familyInvites.status, "pending")))
    .limit(1);

  if (!invite) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired invite." });
  }

  if (new Date(invite.expires_at) < new Date()) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "This invite has expired." });
  }

  // Transition invite to accepted
  await db
    .update(familyInvites)
    .set({ status: "accepted", updated_at: now })
    .where(eq(familyInvites.id, invite.id));

  // Create the active relationship
  const relId = crypto.randomUUID();
  await db.insert(familyRelationships).values({
    id: relId,
    patient_id: invite.patient_id,
    caregiver_id: caregiverId,
    relationship_type: invite.relationship_type,
    status: "active",
    granted_at: now,
    created_at: now,
    updated_at: now,
  });

  return { relationship_id: relId };
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

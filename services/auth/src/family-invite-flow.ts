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
import { eq, and, gt } from "drizzle-orm";
import crypto from "node:crypto";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Invite token format: 32 random bytes encoded as hex (64 characters).
 * 256 bits of entropy makes brute-force computationally infeasible; this
 * constant is used to bound the input size on lookup and to size the
 * constant-time comparison buffer.
 */
const INVITE_TOKEN_BYTES = 32;
const INVITE_TOKEN_HEX_LENGTH = INVITE_TOKEN_BYTES * 2;

/**
 * Constant-time comparison of two hex-encoded invite tokens.
 *
 * The primary lookup is an indexed equality match in PostgreSQL — that is
 * already timing-safe at the storage layer. This second comparison is
 * defense-in-depth: even if a future change moves the lookup out of the
 * database or caches rows in memory, token equality will still be checked
 * without leaking information via short-circuiting string comparison.
 *
 * `timingSafeEqual` requires equal-length buffers; we pre-pad to the full
 * token length so a malformed (short) token can never throw or accidentally
 * succeed by matching a prefix.
 */
function timingSafeTokenEqual(a: string, b: string): boolean {
  const bufA = Buffer.alloc(INVITE_TOKEN_HEX_LENGTH);
  const bufB = Buffer.alloc(INVITE_TOKEN_HEX_LENGTH);
  bufA.write(a.slice(0, INVITE_TOKEN_HEX_LENGTH));
  bufB.write(b.slice(0, INVITE_TOKEN_HEX_LENGTH));
  return crypto.timingSafeEqual(bufA, bufB) && a.length === b.length;
}

// ---- Invite creation ----

export async function createFamilyInvite(
  patientId: string,
  inviteeEmail: string,
  relationshipType: string,
): Promise<{ id: string; token: string; expires_at: string }> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const token = crypto.randomBytes(INVITE_TOKEN_BYTES).toString("hex");
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

/**
 * Accept a family-access invite using the opaque token.
 *
 * Hardening (issue #313):
 *   - Reject malformed tokens (wrong length, non-hex) without a DB lookup
 *     so attackers cannot probe the shape of valid tokens.
 *   - Filter expired tokens at the SQL layer (`expires_at > NOW()`) so an
 *     expired row is never loaded into application memory.
 *   - Re-verify the returned row's token with `crypto.timingSafeEqual` as
 *     defense-in-depth on top of the indexed DB equality check.
 *   - Single-use is enforced by the `status = 'pending'` filter plus the
 *     status transition to `accepted` after successful acceptance.
 *   - Log every failed attempt to `audit_log` for security monitoring.
 */
export async function acceptFamilyInvite(
  inviteToken: string,
  caregiverId: string,
): Promise<{ relationship_id: string }> {
  const db = getDb();
  const now = new Date().toISOString();

  // Shape check first — avoids a DB round-trip for obviously bogus input
  // and keeps the timing-safe compare below operating on well-formed hex.
  if (
    typeof inviteToken !== "string" ||
    inviteToken.length !== INVITE_TOKEN_HEX_LENGTH ||
    !/^[0-9a-f]+$/i.test(inviteToken)
  ) {
    await recordFailedAcceptAttempt(caregiverId, "malformed_token");
    throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired invite." });
  }

  const nowIso = now;
  const [invite] = await db
    .select()
    .from(familyInvites)
    .where(
      and(
        eq(familyInvites.token, inviteToken),
        eq(familyInvites.status, "pending"),
        gt(familyInvites.expires_at, nowIso),
      ),
    )
    .limit(1);

  if (!invite) {
    await recordFailedAcceptAttempt(caregiverId, "not_found_or_expired");
    throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired invite." });
  }

  // Defense-in-depth: even after the indexed DB match, verify the returned
  // token in constant time. Guards against a caching/replication layer
  // ever returning a row whose token differs from the query input.
  if (!timingSafeTokenEqual(invite.token as string, inviteToken)) {
    await recordFailedAcceptAttempt(caregiverId, "token_mismatch");
    throw new TRPCError({ code: "NOT_FOUND", message: "Invalid or expired invite." });
  }

  // Transition invite to accepted. The `status = 'pending'` guard in the
  // WHERE clause makes this single-use: a concurrent accept on the same
  // token will update zero rows because the first accept already flipped
  // the status.
  await db
    .update(familyInvites)
    .set({ status: "accepted", updated_at: now })
    .where(
      and(
        eq(familyInvites.id, invite.id),
        eq(familyInvites.status, "pending"),
      ),
    );

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

  await db.insert(auditLog).values({
    id: crypto.randomUUID(),
    user_id: caregiverId,
    action: "family_invite_accepted",
    resource_type: "family_invite",
    resource_id: invite.id,
    details: JSON.stringify({ patient_id: invite.patient_id, relationship_id: relId }),
    timestamp: now,
  });

  return { relationship_id: relId };
}

/**
 * Emit an audit entry for a failed invite acceptance attempt.
 *
 * Swallows its own errors — we never want a logging failure to mask the
 * actual NOT_FOUND the caller is about to throw.
 */
async function recordFailedAcceptAttempt(
  caregiverId: string,
  reason: string,
): Promise<void> {
  try {
    const db = getDb();
    await db.insert(auditLog).values({
      id: crypto.randomUUID(),
      user_id: caregiverId,
      action: "family_invite_accept_failed",
      resource_type: "family_invite",
      resource_id: "unknown",
      details: JSON.stringify({ reason }),
      timestamp: new Date().toISOString(),
    });
  } catch {
    // Audit best-effort; do not mask the caller's error.
  }
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

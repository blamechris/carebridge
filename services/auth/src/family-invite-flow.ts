/**
 * Phase B3 — patient-initiated family caregiver invitation flow.
 *
 * This module handles the complete lifecycle:
 *   1. Patient creates an invite (token generated, invite row inserted)
 *   2. Family member accepts the invite (user created if needed,
 *      family_relationship row inserted, invite marked accepted)
 *   3. Patient or clinician revokes access (relationship revoked_at set)
 *   4. List active relationships + pending invites for a patient
 *
 * The clinician-assisted proxy path (B3 proxy) is NOT implemented here
 * and is blocked on legal/privacy policy sign-off. See
 * `docs/family-access-proxy-policy.md` for the draft policy.
 */

import crypto from "node:crypto";
import {
  getDb,
  users,
  familyRelationships,
  familyInvites,
} from "@carebridge/db-schema";
import { eq, and, isNull } from "drizzle-orm";
import { hashPassword } from "./password.js";

// ── Types ────────────────────────────────────────────────────────

export interface CreateInviteParams {
  patient_id: string;
  invited_by_user_id: string;
  invitee_email: string;
  relationship: string;
  access_scopes: string[];
}

export interface AcceptInviteParams {
  token: string;
  /** Required if the invitee doesn't already have a user account. */
  name?: string;
  /** Required if the invitee doesn't already have a user account. */
  password?: string;
}

export class InviteNotFoundError extends Error {
  name = "InviteNotFoundError" as const;
}

export class InviteExpiredError extends Error {
  name = "InviteExpiredError" as const;
}

export class InviteAlreadyAcceptedError extends Error {
  name = "InviteAlreadyAcceptedError" as const;
}

export class AccountRequiredError extends Error {
  name = "AccountRequiredError" as const;
  constructor() {
    super("Name and password are required to create a new caregiver account");
  }
}

// ── Constants ────────────────────────────────────────────────────

/** Invites expire after 7 days. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// ── Service functions ────────────────────────────────────────────

/**
 * Create a new family invite. Returns the invite id and token.
 */
export async function createFamilyInvite(
  params: CreateInviteParams,
): Promise<{ id: string; token: string; expires_at: string }> {
  const db = getDb();
  const now = new Date();
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  const id = crypto.randomUUID();

  await db.insert(familyInvites).values({
    id,
    patient_id: params.patient_id,
    invited_by: params.invited_by_user_id,
    invitee_email: params.invitee_email,
    relationship: params.relationship,
    access_scopes: params.access_scopes.join(","),
    token,
    status: "pending",
    expires_at: expiresAt,
    created_at: now.toISOString(),
  });

  return { id, token, expires_at: expiresAt };
}

/**
 * Accept a family invite. Creates the user account if needed and
 * establishes the family_relationship.
 */
export async function acceptFamilyInvite(
  params: AcceptInviteParams,
): Promise<{ relationship_id: string; user_id: string }> {
  const db = getDb();
  const now = new Date().toISOString();

  // 1. Load the invite by token.
  const [invite] = await db
    .select()
    .from(familyInvites)
    .where(eq(familyInvites.token, params.token))
    .limit(1);

  if (!invite) {
    throw new InviteNotFoundError("Invite not found");
  }

  if (invite.status === "accepted") {
    throw new InviteAlreadyAcceptedError("Invite has already been accepted");
  }

  if (invite.status === "cancelled") {
    throw new InviteNotFoundError("Invite has been cancelled");
  }

  if (new Date(invite.expires_at) < new Date()) {
    // Mark expired for bookkeeping
    await db
      .update(familyInvites)
      .set({ status: "expired" })
      .where(eq(familyInvites.id, invite.id));
    throw new InviteExpiredError("Invite has expired");
  }

  // 2. Find or create the family user account.
  let familyUserId: string;

  const [existingUser] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, invite.invitee_email))
    .limit(1);

  if (existingUser) {
    familyUserId = existingUser.id;
  } else {
    // New user — name and password are required.
    if (!params.name || !params.password) {
      throw new AccountRequiredError();
    }

    familyUserId = crypto.randomUUID();
    await db.insert(users).values({
      id: familyUserId,
      email: invite.invitee_email,
      password_hash: await hashPassword(params.password),
      name: params.name,
      role: "family_caregiver",
      is_active: true,
      created_at: now,
      updated_at: now,
    });
  }

  // 3. Create the family_relationship row.
  const relationshipId = crypto.randomUUID();
  await db.insert(familyRelationships).values({
    id: relationshipId,
    patient_id: invite.patient_id,
    family_user_id: familyUserId,
    relationship: invite.relationship,
    access_scopes: invite.access_scopes,
    consented_at: now,
    created_at: now,
  });

  // 4. Mark the invite as accepted.
  await db
    .update(familyInvites)
    .set({ status: "accepted", accepted_at: now })
    .where(eq(familyInvites.id, invite.id));

  return { relationship_id: relationshipId, user_id: familyUserId };
}

/**
 * Revoke a family relationship.
 */
export async function revokeFamilyAccess(
  relationshipId: string,
  revokedByUserId: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(familyRelationships)
    .set({
      revoked_at: new Date().toISOString(),
      revoked_by: revokedByUserId,
    })
    .where(eq(familyRelationships.id, relationshipId));
}

/**
 * Cancel a pending invite.
 */
export async function cancelFamilyInvite(
  inviteId: string,
): Promise<void> {
  const db = getDb();
  await db
    .update(familyInvites)
    .set({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .where(eq(familyInvites.id, inviteId));
}

/**
 * List active family relationships for a patient.
 */
export async function listFamilyRelationships(
  patientId: string,
): Promise<Array<{
  id: string;
  family_user_id: string;
  family_user_name: string;
  family_user_email: string;
  relationship: string;
  access_scopes: string[];
  consented_at: string;
}>> {
  const db = getDb();
  const rows = await db
    .select({
      id: familyRelationships.id,
      family_user_id: familyRelationships.family_user_id,
      relationship: familyRelationships.relationship,
      access_scopes: familyRelationships.access_scopes,
      consented_at: familyRelationships.consented_at,
      family_user_name: users.name,
      family_user_email: users.email,
    })
    .from(familyRelationships)
    .innerJoin(users, eq(familyRelationships.family_user_id, users.id))
    .where(
      and(
        eq(familyRelationships.patient_id, patientId),
        isNull(familyRelationships.revoked_at),
      ),
    );

  return rows.map((r) => ({
    id: r.id,
    family_user_id: r.family_user_id,
    family_user_name: r.family_user_name,
    family_user_email: r.family_user_email,
    relationship: r.relationship,
    access_scopes: r.access_scopes.split(",").filter(Boolean),
    consented_at: r.consented_at,
  }));
}

/**
 * List pending invites for a patient.
 */
export async function listPendingInvites(
  patientId: string,
): Promise<Array<{
  id: string;
  invitee_email: string;
  relationship: string;
  access_scopes: string[];
  expires_at: string;
  created_at: string;
}>> {
  const db = getDb();
  const rows = await db
    .select()
    .from(familyInvites)
    .where(
      and(
        eq(familyInvites.patient_id, patientId),
        eq(familyInvites.status, "pending"),
      ),
    );

  const now = new Date();
  return rows
    .filter((r) => new Date(r.expires_at) > now)
    .map((r) => ({
      id: r.id,
      invitee_email: r.invitee_email,
      relationship: r.relationship,
      access_scopes: r.access_scopes.split(",").filter(Boolean),
      expires_at: r.expires_at,
      created_at: r.created_at,
    }));
}

/**
 * Look up the family relationship for a user + patient pair.
 * Used by the api-gateway RBAC layer to determine if a family_caregiver
 * user has access to a specific patient and what scopes they hold.
 */
export async function getFamilyRelationship(
  familyUserId: string,
  patientId: string,
): Promise<{
  relationship: string;
  access_scopes: string[];
} | null> {
  const db = getDb();
  const [row] = await db
    .select({
      relationship: familyRelationships.relationship,
      access_scopes: familyRelationships.access_scopes,
    })
    .from(familyRelationships)
    .where(
      and(
        eq(familyRelationships.family_user_id, familyUserId),
        eq(familyRelationships.patient_id, patientId),
        isNull(familyRelationships.revoked_at),
      ),
    )
    .limit(1);

  if (!row) return null;

  return {
    relationship: row.relationship,
    access_scopes: row.access_scopes.split(",").filter(Boolean),
  };
}

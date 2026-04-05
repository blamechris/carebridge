/**
 * Role-Based Access Control (RBAC) middleware for tRPC procedures.
 *
 * This module provides:
 *   1. `requireRole(...roles)` — a tRPC middleware factory that rejects
 *      requests from users whose role is not in the allowed list.
 *   2. `requirePatientAccess` — ensures a user can only access records
 *      for patients they are authorized to see.
 *
 * HIPAA §164.312(a)(1) — Access Control (Required safeguard):
 * "Implement technical policies and procedures for electronic information
 * systems that maintain electronic protected health information to allow
 * access only to those persons or software programs that have been
 * granted access rights."
 *
 * Role permission matrix:
 *   admin      — full access
 *   physician  — read/write clinical data for all patients (TODO: scope to care team)
 *   specialist — read/write clinical data for assigned patients
 *   nurse      — read all clinical data, create vitals/notes
 *   patient    — read own records only, no mutations to clinical data
 */

import { TRPCError } from "@trpc/server";
import type { User } from "@carebridge/shared-types";

type Role = User["role"];

// Ordered from most to least privileged for display purposes
export const ROLE_HIERARCHY: Role[] = [
  "admin",
  "physician",
  "specialist",
  "nurse",
  "patient",
];

/**
 * Create a tRPC middleware that checks the caller's role.
 *
 * Usage:
 *   const physicianOrAdminProcedure = protectedProcedure.use(requireRole("physician", "admin"));
 */
export function requireRole(...allowedRoles: Role[]) {
  return async function roleMiddleware({
    ctx,
    next,
  }: {
    ctx: { user: User | null };
    next: () => Promise<unknown>;
  }) {
    if (!ctx.user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Authentication required.",
      });
    }

    if (!allowedRoles.includes(ctx.user.role)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `This operation requires one of the following roles: ${allowedRoles.join(", ")}. Your role: ${ctx.user.role}.`,
      });
    }

    return next();
  };
}

/**
 * Clinical write roles — users who can create or modify clinical records.
 */
export const CLINICAL_WRITER_ROLES: Role[] = ["admin", "physician", "specialist", "nurse"];

/**
 * Clinical admin roles — users who can manage the system.
 */
export const ADMIN_ROLES: Role[] = ["admin"];

/**
 * Clinician roles — all clinical staff (not patients).
 */
export const CLINICIAN_ROLES: Role[] = ["admin", "physician", "specialist", "nurse"];

/**
 * Check if a user can access records for a given patient.
 *
 * Current policy (permissive for v1 — tighten to care team in v2):
 *   - admin: yes
 *   - physician/specialist/nurse: yes (TODO: restrict to care team)
 *   - patient: only their own patient_id
 *
 * Throws a TRPCError if access is denied.
 */
export function assertPatientAccess(
  user: User,
  patientId: string,
  userPatientId?: string,
): void {
  if (user.role === "patient") {
    if (!userPatientId || userPatientId !== patientId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Patients can only access their own records.",
      });
    }
  }
  // All other roles permitted for now — future versions will enforce care team membership
}

/**
 * Check if a user can perform a clinical write operation.
 * Patients are never permitted to write to clinical data tables.
 */
export function assertClinicalWriteAccess(user: User): void {
  if (!CLINICAL_WRITER_ROLES.includes(user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Clinical data modifications require a clinical staff role.",
    });
  }
}

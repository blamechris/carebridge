import type { FastifyRequest, FastifyReply } from "fastify";
import type { User } from "@carebridge/shared-types";
import { getDb, careTeamAssignments } from "@carebridge/db-schema";
import { eq, and, isNull } from "drizzle-orm";

/**
 * Verify that the authenticated user has an active care-team assignment
 * for the given patient. Returns true if an active assignment exists.
 */
export async function assertCareTeamAccess(
  userId: string,
  patientId: string,
): Promise<boolean> {
  const db = getDb();
  const rows = await db
    .select({ id: careTeamAssignments.id })
    .from(careTeamAssignments)
    .where(
      and(
        eq(careTeamAssignments.user_id, userId),
        eq(careTeamAssignments.patient_id, patientId),
        isNull(careTeamAssignments.removed_at),
      ),
    )
    .limit(1);

  return rows.length > 0;
}

/**
 * HIPAA minimum-necessary access check for patient data.
 *
 * - **patient**: may only access their own record (user.id === patientId)
 * - **admin**: unrestricted access
 * - **clinicians** (physician, specialist, nurse): must have an active
 *   care-team assignment linking them to the patient
 *
 * Sends a 403 response and returns `false` when access is denied so
 * callers can short-circuit:
 *
 * ```ts
 * if (!(await assertPatientAccess(request, reply, patientId))) return;
 * ```
 */
export async function assertPatientAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  patientId: string,
): Promise<boolean> {
  const user = (request as unknown as Record<string, unknown>).user as
    | User
    | undefined;

  if (!user) {
    reply.code(401).send({ error: "Authentication required" });
    return false;
  }

  // Admins have unrestricted access.
  if (user.role === "admin") {
    return true;
  }

  // Patients may only view their own records.
  if (user.role === "patient") {
    if (user.id === patientId) {
      return true;
    }
    reply.code(403).send({ error: "Access denied: patients may only access their own records" });
    return false;
  }

  // Clinicians (physician, specialist, nurse) must be on the care team.
  const hasAccess = await assertCareTeamAccess(user.id, patientId);
  if (!hasAccess) {
    reply.code(403).send({
      error: "Access denied: no active care-team assignment for this patient",
    });
    return false;
  }

  return true;
}

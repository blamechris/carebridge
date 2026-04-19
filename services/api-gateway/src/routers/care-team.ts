/**
 * RBAC-enforced care-team management router (issue #397).
 *
 * Only `physician | specialist | admin` may mutate. Every mutation writes an
 * audit entry (HIPAA §164.312(b)). Mutations that pair a roster change with
 * an RBAC grant run inside one transaction so a grant failure rolls the team
 * edit back — see `packages/db-schema/src/schema/patients.ts` for the
 * careTeamMembers (clinical roster) vs careTeamAssignments (RBAC) split.
 */
import { TRPCError, initTRPC } from "@trpc/server";
import {
  getDb,
  careTeamMembers,
  careTeamAssignments,
  auditLog,
} from "@carebridge/db-schema";
import {
  addCareTeamMemberSchema,
  removeCareTeamMemberSchema,
  updateCareTeamRoleSchema,
  grantCareTeamAssignmentSchema,
  revokeCareTeamAssignmentSchema,
} from "@carebridge/validators";
import { and, eq, isNull } from "drizzle-orm";
import crypto from "node:crypto";
import type { Context } from "../context.js";
import { assertCareTeamAccess } from "../middleware/rbac.js";

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(isAuthenticated);

// Nurses can READ the roster via `patients.careTeam.getByPatient` but cannot
// mutate it — the triplet {physician, specialist, admin} mirrors issue #397.
const CARE_TEAM_MANAGER_ROLES = new Set<string>(["physician", "specialist", "admin"]);

function assertCanManageCareTeam(user: NonNullable<Context["user"]>): void {
  if (!CARE_TEAM_MANAGER_ROLES.has(user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Only physicians, specialists, and admins can manage care teams",
    });
  }
}

/**
 * HIPAA minimum-necessary access check — mirrors the helper used by every
 * other patient-scoped router (clinical-data, clinical-notes, patient-records,
 * fhir, ai-oversight). Role gating (`assertCanManageCareTeam`) governs *what*
 * a user can do; this gate governs *which patients* they can do it to.
 *
 * - admins bypass (unrestricted cross-patient access)
 * - patients never reach here (role gate rejects first), but kept consistent
 * - clinicians must have an active `careTeamAssignments` row for the patient
 */
async function enforcePatientAccess(
  user: NonNullable<Context["user"]>,
  patientId: string,
  clientIp?: string | null,
): Promise<void> {
  if (user.role === "admin") return;

  if (user.role === "patient") {
    if (user.id !== patientId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied: patients may only access their own records",
      });
    }
    return;
  }

  // clientIp flows through to the emergency_access_used audit row for
  // HIPAA § 164.312(b) completeness.
  const hasAccess = await assertCareTeamAccess(user.id, patientId, clientIp);
  if (!hasAccess) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Access denied: no active care-team assignment for this patient",
    });
  }
}

/**
 * Build a standard audit-log row. Returned as a plain value so callers can
 * `.insert(auditLog).values(row)` on either the top-level db handle or an
 * open transaction without fighting drizzle's `PgTransaction` generic.
 * Captures actor, action, target patient / user, and old/new values so an
 * auditor can reconstruct every change without replaying the DB.
 */
function buildAuditRow(params: {
  actor_user_id: string;
  action: string;
  resource_type: "care_team_member" | "care_team_assignment";
  resource_id: string;
  patient_id: string;
  target_user_id?: string;
  old_value?: Record<string, unknown>;
  new_value?: Record<string, unknown>;
  procedure_name: string;
  client_ip?: string | null;
}) {
  return {
    id: crypto.randomUUID(),
    user_id: params.actor_user_id,
    action: params.action,
    resource_type: params.resource_type,
    resource_id: params.resource_id,
    patient_id: params.patient_id,
    procedure_name: params.procedure_name,
    details: JSON.stringify({
      target_user_id: params.target_user_id,
      old_value: params.old_value,
      new_value: params.new_value,
    }),
    ip_address: params.client_ip ?? "",
    timestamp: new Date().toISOString(),
  };
}

export const careTeamRbacRouter = t.router({
  /**
   * Add a provider to a patient's clinical care team. When `assignment_role`
   * is supplied, the RBAC grant is inserted in the same transaction so a
   * grant failure rolls the roster row back (prevents chart/access split-brain).
   *
   * Idempotency (#881): if an active roster row already exists for this
   * (provider_id, patient_id) pair, return the existing row without writing
   * ANY new state (no insert, no audit). A duplicate add is not an error —
   * it aligns with the partial UNIQUE index in migration 0038 and keeps
   * clients safe to retry on transient failures. The DB index is the hard
   * guardrail; this app-level check avoids a needless round-trip + error
   * serialisation on the common happy retry path.
   */
  addMember: protectedProcedure
    .input(addCareTeamMemberSchema)
    .mutation(async ({ ctx, input }) => {
      assertCanManageCareTeam(ctx.user);
      await enforcePatientAccess(ctx.user, input.patient_id, ctx.clientIp);
      const db = getDb();

      // Idempotency check BEFORE the transaction: if an active row already
      // exists, return it verbatim and write no audit row. No state change
      // means no HIPAA-auditable event.
      const [existingActive] = await db
        .select()
        .from(careTeamMembers)
        .where(
          and(
            eq(careTeamMembers.provider_id, input.provider_id),
            eq(careTeamMembers.patient_id, input.patient_id),
            eq(careTeamMembers.is_active, true),
          ),
        )
        .limit(1);
      if (existingActive) return existingActive;

      const now = new Date().toISOString();
      const memberId = crypto.randomUUID();
      const memberRow = {
        id: memberId,
        patient_id: input.patient_id,
        provider_id: input.provider_id,
        role: input.role,
        specialty: input.specialty,
        is_active: true,
        started_at: now,
        created_at: now,
      };

      // Track the assignment id so the audit row can record it (#883) —
      // auditors need to correlate the roster insert with the access grant.
      let assignmentId: string | undefined;

      await db.transaction(async (tx) => {
        await tx.insert(careTeamMembers).values(memberRow);

        if (input.assignment_role) {
          assignmentId = crypto.randomUUID();
          // Atomic pair: if this grant throws (unique violation, DB outage),
          // the outer transaction rolls the member insert back.
          await tx.insert(careTeamAssignments).values({
            id: assignmentId,
            user_id: input.provider_id,
            patient_id: input.patient_id,
            role: input.assignment_role,
            assigned_at: now,
          });
        }

        await tx.insert(auditLog).values(
          buildAuditRow({
            actor_user_id: ctx.user.id,
            action: "care_team_add_member",
            resource_type: "care_team_member",
            resource_id: memberId,
            patient_id: input.patient_id,
            target_user_id: input.provider_id,
            new_value: {
              provider_id: input.provider_id,
              role: input.role,
              specialty: input.specialty,
              assignment_role: input.assignment_role,
              // #883: record the RBAC assignment_id (when applicable) so an
              // auditor can trace the team+grant pair back to a single row.
              ...(assignmentId !== undefined && { assignment_id: assignmentId }),
            },
            procedure_name: "careTeam.addMember",
            client_ip: ctx.clientIp,
          }),
        );
      });

      return memberRow;
    }),

  // Soft-delete only — retaining the row preserves HIPAA-required history
  // of who was on the patient's team and when.
  removeMember: protectedProcedure
    .input(removeCareTeamMemberSchema)
    .mutation(async ({ ctx, input }) => {
      assertCanManageCareTeam(ctx.user);
      const db = getDb();
      const [existing] = await db
        .select()
        .from(careTeamMembers)
        .where(eq(careTeamMembers.id, input.member_id))
        .limit(1);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Care-team member ${input.member_id} not found`,
        });
      }

      // Patient is resolved from the member row — mirrors the pattern used in
      // clinical-data.medications.update where the resource id is the only
      // input and patient_id is looked up before the access check.
      await enforcePatientAccess(ctx.user, existing.patient_id as string, ctx.clientIp);

      // Idempotency (#881): if already inactive, treat as a 200 no-op per
      // REST idempotent-DELETE semantics. Crucially we do NOT overwrite the
      // original `ended_at` — auditors need to trust WHEN the member was
      // actually removed, and a stale retry shouldn't rewrite that history.
      if (!existing.is_active) {
        return { removed: true, member_id: input.member_id };
      }

      const now = new Date().toISOString();
      await db.transaction(async (tx) => {
        await tx
          .update(careTeamMembers)
          .set({ is_active: false, ended_at: now })
          .where(eq(careTeamMembers.id, input.member_id));

        await tx.insert(auditLog).values(
          buildAuditRow({
            actor_user_id: ctx.user.id,
            action: "care_team_remove_member",
            resource_type: "care_team_member",
            resource_id: input.member_id,
            patient_id: existing.patient_id as string,
            target_user_id: existing.provider_id as string,
            old_value: {
              role: existing.role,
              specialty: existing.specialty,
              is_active: existing.is_active,
            },
            new_value: { is_active: false, ended_at: now },
            procedure_name: "careTeam.removeMember",
            client_ip: ctx.clientIp,
          }),
        );
      });

      return { removed: true, member_id: input.member_id };
    }),

  // Change role (and optionally specialty) for an existing care-team member.
  updateRole: protectedProcedure
    .input(updateCareTeamRoleSchema)
    .mutation(async ({ ctx, input }) => {
      assertCanManageCareTeam(ctx.user);
      const db = getDb();
      const [existing] = await db
        .select()
        .from(careTeamMembers)
        .where(eq(careTeamMembers.id, input.member_id))
        .limit(1);
      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Care-team member ${input.member_id} not found`,
        });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id as string, ctx.clientIp);

      const patch: Record<string, unknown> = { role: input.role };
      if (input.specialty !== undefined) patch.specialty = input.specialty;

      await db.transaction(async (tx) => {
        await tx
          .update(careTeamMembers)
          .set(patch)
          .where(eq(careTeamMembers.id, input.member_id));

        await tx.insert(auditLog).values(
          buildAuditRow({
            actor_user_id: ctx.user.id,
            action: "care_team_update_role",
            resource_type: "care_team_member",
            resource_id: input.member_id,
            patient_id: existing.patient_id as string,
            target_user_id: existing.provider_id as string,
            old_value: {
              role: existing.role,
              specialty: existing.specialty,
            },
            new_value: {
              role: input.role,
              specialty: input.specialty ?? existing.specialty,
            },
            procedure_name: "careTeam.updateRole",
            client_ip: ctx.clientIp,
          }),
        );
      });

      return {
        member_id: input.member_id,
        role: input.role,
        specialty: input.specialty ?? existing.specialty,
      };
    }),

  // RBAC sub-router — grant/revoke access without touching the clinical
  // roster (e.g. covering physician needing temporary chart access).
  assignments: t.router({
    grant: protectedProcedure
      .input(grantCareTeamAssignmentSchema)
      .mutation(async ({ ctx, input }) => {
        assertCanManageCareTeam(ctx.user);
        await enforcePatientAccess(ctx.user, input.patient_id, ctx.clientIp);
        const db = getDb();

        // Idempotency (#881): if an active assignment exists for this
        // (user_id, patient_id), return it and write no state. Matches the
        // partial UNIQUE index added in migration 0038. No audit row —
        // nothing actually changed.
        const [existingActive] = await db
          .select()
          .from(careTeamAssignments)
          .where(
            and(
              eq(careTeamAssignments.user_id, input.user_id),
              eq(careTeamAssignments.patient_id, input.patient_id),
              isNull(careTeamAssignments.removed_at),
            ),
          )
          .limit(1);
        if (existingActive) return existingActive;

        const now = new Date().toISOString();
        const assignmentId = crypto.randomUUID();
        const assignmentRow = {
          id: assignmentId,
          user_id: input.user_id,
          patient_id: input.patient_id,
          role: input.role,
          assigned_at: now,
        };

        await db.transaction(async (tx) => {
          await tx.insert(careTeamAssignments).values(assignmentRow);

          await tx.insert(auditLog).values(
            buildAuditRow({
              actor_user_id: ctx.user.id,
              action: "care_team_grant_assignment",
              resource_type: "care_team_assignment",
              resource_id: assignmentId,
              patient_id: input.patient_id,
              target_user_id: input.user_id,
              new_value: { role: input.role },
              procedure_name: "careTeamAssignments.grant",
              client_ip: ctx.clientIp,
            }),
          );
        });

        return assignmentRow;
      }),

    revoke: protectedProcedure
      .input(revokeCareTeamAssignmentSchema)
      .mutation(async ({ ctx, input }) => {
        assertCanManageCareTeam(ctx.user);
        const db = getDb();
        // Drop the `removed_at IS NULL` filter so we can distinguish
        // "does not exist" (NOT_FOUND) from "already revoked" (no-op).
        const [existing] = await db
          .select()
          .from(careTeamAssignments)
          .where(eq(careTeamAssignments.id, input.assignment_id))
          .limit(1);
        if (!existing) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Care-team assignment ${input.assignment_id} not found`,
          });
        }

        await enforcePatientAccess(ctx.user, existing.patient_id as string, ctx.clientIp);

        // Idempotency (#881): already revoked → 200 no-op. Preserve the
        // original `removed_at` so the audit trail of WHEN access was
        // actually revoked stays trustworthy.
        if (existing.removed_at) {
          return { revoked: true, assignment_id: input.assignment_id };
        }

        const now = new Date().toISOString();
        await db.transaction(async (tx) => {
          await tx
            .update(careTeamAssignments)
            .set({ removed_at: now })
            .where(eq(careTeamAssignments.id, input.assignment_id));

          await tx.insert(auditLog).values(
            buildAuditRow({
              actor_user_id: ctx.user.id,
              action: "care_team_revoke_assignment",
              resource_type: "care_team_assignment",
              resource_id: input.assignment_id,
              patient_id: existing.patient_id as string,
              target_user_id: existing.user_id as string,
              old_value: { role: existing.role, removed_at: null },
              new_value: { removed_at: now },
              procedure_name: "careTeamAssignments.revoke",
              client_ip: ctx.clientIp,
            }),
          );
        });

        return { revoked: true, assignment_id: input.assignment_id };
      }),
  }),
});

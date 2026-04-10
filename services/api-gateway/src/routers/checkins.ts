/**
 * RBAC-enforced check-ins router.
 *
 * Wraps the standalone `@carebridge/checkins` router with:
 *
 *   1. Authentication (all procedures require a logged-in session).
 *   2. HIPAA minimum-necessary patient access checks — patients may
 *      only submit / read their own check-ins; family caregivers (Phase
 *      B3) must have an active, scoped family_relationship grant;
 *      clinicians must be on the patient's care team.
 *   3. Submitter identity stamping — `submitted_by_user_id` and
 *      `submitted_by_relationship` are derived from the authenticated
 *      session, never trusted from the client. For self-submissions
 *      the relationship is "self"; Phase B3 will expand this by
 *      loading the `family_relationships` row for the user + patient
 *      pair.
 *
 * The underlying service router is called via `createCaller({})`,
 * mirroring the `fhirRbacRouter` pattern in
 * `services/api-gateway/src/routers/fhir.ts`.
 */
import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import { checkinsRouter } from "@carebridge/checkins";
import {
  submitCheckInSchema,
  type CheckInRelationship,
} from "@carebridge/validators";
import { getFamilyRelationship } from "@carebridge/auth";
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

/**
 * Minimum-necessary check for a check-in operation. The rules are
 * deliberately stricter than the clinical-notes router because a
 * check-in is patient-voice data — patients are the primary
 * submitters, clinicians are observers.
 */
async function enforcePatientAccess(
  user: NonNullable<Context["user"]>,
  patientId: string,
  requiredScope?: string,
): Promise<void> {
  if (user.role === "admin") return;

  if (user.role === "patient") {
    if (user.id !== patientId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied: patients may only access their own check-ins",
      });
    }
    return;
  }

  // Family caregivers must have an active relationship with the required scope.
  if (user.role === "family_caregiver") {
    const rel = await getFamilyRelationship(user.id, patientId);
    if (!rel) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied: no active family relationship for this patient",
      });
    }
    if (requiredScope && !rel.access_scopes.includes(requiredScope)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Access denied: missing required scope '${requiredScope}'`,
      });
    }
    return;
  }

  // Clinicians (physician, specialist, nurse) must be on the care team.
  const hasAccess = await assertCareTeamAccess(user.id, patientId);
  if (!hasAccess) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Access denied: no active care-team assignment for this patient",
    });
  }
}

/**
 * Derive the submitter relationship for a check-in submission.
 *
 * Phase B1 scope: patients submit for themselves ("self") and
 * clinicians can submit on behalf of a patient during an in-clinic
 * encounter ("other"). The family-caregiver relationships
 * ("spouse", "adult_child", "parent", "healthcare_poa") are populated
 * by Phase B3 once the `family_relationships` schema and its
 * privacy-officer sign-off are in place — until then, family users
 * simply can't reach this procedure because no RBAC path grants them
 * access.
 */
async function resolveSubmitterRelationship(
  user: NonNullable<Context["user"]>,
  patientId: string,
): Promise<CheckInRelationship> {
  if (user.role === "patient" && user.id === patientId) {
    return "self";
  }
  // Family caregiver — look up the relationship type from the grant.
  if (user.role === "family_caregiver") {
    const rel = await getFamilyRelationship(user.id, patientId);
    if (rel) return rel.relationship as CheckInRelationship;
  }
  // Clinician-assisted submission during a visit.
  return "other";
}

// Standalone context-less caller into @carebridge/checkins.
const checkinsCaller = checkinsRouter.createCaller({});

export const checkinsRbacRouter = t.router({
  templates: t.router({
    /**
     * Templates are not PHI — any authenticated user can see the
     * library. The patient portal renders the list; the clinician
     * portal uses it to label check-in-sourced flags.
     */
    list: protectedProcedure.query(async () => {
      return checkinsCaller.templates.list();
    }),

    get: protectedProcedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }) => {
        return checkinsCaller.templates.get(input);
      }),
  }),

  submit: protectedProcedure
    .input(submitCheckInSchema)
    .mutation(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patient_id, "submit_checkins");
      const relationship = await resolveSubmitterRelationship(
        ctx.user,
        input.patient_id,
      );
      return checkinsCaller.submit({
        ...input,
        submitted_by_user_id: ctx.user.id,
        submitted_by_relationship: relationship,
      });
    }),

  history: t.router({
    byPatient: protectedProcedure
      .input(
        z.object({
          patient_id: z.string().uuid(),
          limit: z.number().int().positive().max(100).default(25),
        }),
      )
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patient_id, "view_checkins_history");
        return checkinsCaller.history.byPatient(input);
      }),
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await checkinsCaller.getById(input);
      if (!row) return null;
      await enforcePatientAccess(ctx.user, row.patient_id);
      return row;
    }),
});

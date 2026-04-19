/**
 * RBAC-enforced clinical-data router.
 *
 * Every patient-scoped procedure calls enforcePatientAccess() before
 * delegating to the underlying repository functions from @carebridge/clinical-data.
 *
 * Procedures where the patient must be resolved from another resource id
 * (medications.update, medications.logAdmin) perform a lightweight DB lookup
 * to obtain the patient_id before running the access check.
 */
import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import {
  createVitalSchema,
  vitalTypeSchema,
  createLabPanelSchema,
  createMedicationSchema,
  updateMedicationSchema,
  medStatusSchema,
  createProcedureSchema,
} from "@carebridge/validators";
import {
  vitalRepo,
  labRepo,
  medicationRepo,
  procedureRepo,
  ConflictError,
} from "@carebridge/clinical-data";
import {
  getDb,
  medications,
  familyRelationships,
  users,
} from "@carebridge/db-schema";
import {
  hasScope,
  normaliseScopes,
  type ScopeToken,
} from "@carebridge/shared-types";
import { and, eq } from "drizzle-orm";
import type { Context } from "../context.js";
import { assertCareTeamAccess } from "../middleware/rbac.js";

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(isAuthenticated);

/**
 * Enforce HIPAA minimum-necessary access for a given user / patientId pair.
 * Throws TRPCError(FORBIDDEN) on denial.
 *
 * Role semantics mirror patient-records.ts — family_caregiver resolves via
 * an active family_relationships row joined through users.patient_id. When
 * `requiredScope` is provided, the relationship's `access_scopes` array is
 * checked (`hasScope` superset rules). Caregivers with only `view_summary`
 * cannot read medications/labs/notes — each procedure declares its scope.
 */
async function enforcePatientAccess(
  user: NonNullable<Context["user"]>,
  patientId: string,
  requiredScope?: ScopeToken,
  clientIp?: string | null,
): Promise<void> {
  if (user.role === "admin") return;

  if (user.role === "patient") {
    const ownRecord = user.patient_id ?? user.id;
    if (ownRecord !== patientId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied: patients may only access their own records",
      });
    }
    return;
  }

  if (user.role === "family_caregiver") {
    // Default-deny: caregivers only ever access scope-gated reads. Every
    // patient-scoped mutation on this router calls enforcePatientAccess
    // WITHOUT a requiredScope, so an undefined scope here means "not a
    // read procedure" — and caregivers must not write. Blocks the latent
    // privilege escalation from issue #908 regardless of whether the
    // procedure-level block is forgotten. (HIPAA / defense in depth)
    if (requiredScope === undefined) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Caregivers cannot perform this operation",
      });
    }
    const db = getDb();
    const [row] = await db
      .select({
        id: familyRelationships.id,
        access_scopes: familyRelationships.access_scopes,
      })
      .from(familyRelationships)
      .innerJoin(users, eq(users.id, familyRelationships.patient_id))
      .where(
        and(
          eq(familyRelationships.caregiver_id, user.id),
          eq(users.patient_id, patientId),
          eq(familyRelationships.status, "active"),
        ),
      )
      .limit(1);
    if (!row) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Access denied: no active family relationship grants access to this patient",
      });
    }
    const scopes = normaliseScopes(
      (row.access_scopes ?? null) as ScopeToken[] | null,
    );
    if (!hasScope(scopes, requiredScope)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: `Access denied: caregiver lacks ${requiredScope} scope`,
      });
    }
    return;
  }

  // Clinicians (physician, specialist, nurse) must be on the care team.
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

// ─── Vitals ──────────────────────────────────────────────────────────────────

const vitalsRouter = t.router({
  create: protectedProcedure
    .input(createVitalSchema)
    .mutation(async ({ ctx, input }) => {
      // Explicit caregiver block (issue #908 / defense in depth). Caregiver
      // role is read-only — ROLE_PERMISSIONS in shared-types/auth.ts grants
      // zero write:* perms. Mirror the diagnoses/allergies/observations
      // pattern in patient-records.ts so the intent is visible at the
      // procedure level and does not rely on enforcePatientAccess alone.
      if (ctx.user.role === "family_caregiver") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Caregivers cannot create vitals",
        });
      }
      // Mutations remain role-blocked elsewhere; no scope check on writes.
      await enforcePatientAccess(ctx.user, input.patient_id, undefined, ctx.clientIp);
      return vitalRepo.createVital(input);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid(), type: vitalTypeSchema.optional() }))
    .query(async ({ ctx, input }) => {
      // Vitals belong to the summary tier (like observations/diagnoses).
      await enforcePatientAccess(ctx.user, input.patientId, "view_summary", ctx.clientIp);
      return vitalRepo.getVitalsByPatient(input.patientId, input.type);
    }),

  getLatest: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId, "view_summary", ctx.clientIp);
      return vitalRepo.getLatestVitals(input.patientId);
    }),
});

// ─── Labs ─────────────────────────────────────────────────────────────────────

const labsRouter = t.router({
  createPanel: protectedProcedure
    .input(createLabPanelSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === "family_caregiver") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Caregivers cannot create lab panels",
        });
      }
      await enforcePatientAccess(ctx.user, input.patient_id, undefined, ctx.clientIp);
      return labRepo.createLabPanel(input);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId, "view_labs", ctx.clientIp);
      return labRepo.getLabPanelsByPatient(input.patientId);
    }),

  getHistory: protectedProcedure
    .input(z.object({ patientId: z.string().uuid(), testName: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId, "view_labs", ctx.clientIp);
      return labRepo.getLabResultHistory(input.patientId, input.testName);
    }),
});

// ─── Medications ──────────────────────────────────────────────────────────────

const medicationsRouter = t.router({
  create: protectedProcedure
    .input(createMedicationSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === "family_caregiver") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Caregivers cannot create medications",
        });
      }
      await enforcePatientAccess(ctx.user, input.patient_id, undefined, ctx.clientIp);
      return medicationRepo.createMedication(input);
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updateMedicationSchema))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === "family_caregiver") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Caregivers cannot update medications",
        });
      }
      // Resolve patientId from the medication record before checking access.
      const db = getDb();
      const [existing] = await db
        .select({ patient_id: medications.patient_id })
        .from(medications)
        .where(eq(medications.id, input.id))
        .limit(1);

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Medication ${input.id} not found` });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id, undefined, ctx.clientIp);

      const { id, ...rest } = input;
      try {
        return await medicationRepo.updateMedication(id, rest);
      } catch (err) {
        if (err instanceof ConflictError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid(), status: medStatusSchema.optional() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId, "view_medications", ctx.clientIp);
      return medicationRepo.getMedicationsByPatient(input.patientId, input.status);
    }),

  logAdmin: protectedProcedure
    .input(
      z.object({
        medicationId: z.string().uuid(),
        administeredAt: z.string().datetime(),
        doseAmount: z.number().positive().optional(),
        doseUnit: z.string().max(20).optional(),
        administeredBy: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === "family_caregiver") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Caregivers cannot log medication administration",
        });
      }
      // Resolve patientId from the medication before checking access.
      const db = getDb();
      const [existing] = await db
        .select({ patient_id: medications.patient_id })
        .from(medications)
        .where(eq(medications.id, input.medicationId))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Medication ${input.medicationId} not found`,
        });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id, undefined, ctx.clientIp);

      return medicationRepo.logAdministration(
        input.medicationId,
        input.administeredAt,
        input.doseAmount,
        input.doseUnit,
        input.administeredBy,
      );
    }),
});

// ─── Procedures ───────────────────────────────────────────────────────────────

const proceduresRouter = t.router({
  create: protectedProcedure
    .input(createProcedureSchema)
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === "family_caregiver") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Caregivers cannot create procedures",
        });
      }
      await enforcePatientAccess(ctx.user, input.patient_id, undefined, ctx.clientIp);
      return procedureRepo.createProcedure(input);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Procedures are summary-tier — part of the patient's clinical snapshot.
      await enforcePatientAccess(ctx.user, input.patientId, "view_summary", ctx.clientIp);
      return procedureRepo.getProceduresByPatient(input.patientId);
    }),
});

// ─── Composed router ──────────────────────────────────────────────────────────

export const clinicalDataRbacRouter = t.router({
  vitals: vitalsRouter,
  labs: labsRouter,
  medications: medicationsRouter,
  procedures: proceduresRouter,
});

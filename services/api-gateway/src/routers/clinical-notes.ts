/**
 * RBAC-enforced clinical-notes router.
 *
 * Every patient-scoped procedure calls enforcePatientAccess() before
 * delegating to the underlying noteService functions from @carebridge/clinical-notes.
 *
 * For notes.update, notes.sign, and notes.getById the patient is resolved
 * from the note record (DB lookup) before the access check runs.
 */
import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import crypto from "node:crypto";
import {
  createNoteSchema,
  updateNoteSchema,
  cosignNoteSchema,
  amendNoteSchema,
  noteTemplateTypeSchema,
} from "@carebridge/validators";
import type { NoteTemplateType } from "@carebridge/shared-types";
import {
  noteService,
  createSOAPTemplate,
  createProgressTemplate,
} from "@carebridge/clinical-notes";
import {
  getDb,
  clinicalNotes,
  auditLog,
  familyRelationships,
  users,
} from "@carebridge/db-schema";
import { and, eq } from "drizzle-orm";
import {
  hasScope,
  normaliseScopes,
  type ScopeToken,
} from "@carebridge/shared-types";
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
 * Role semantics (kept aligned with patient-records.enforcePatientAccess):
 *  - admin: unrestricted
 *  - patient: own record only
 *  - family_caregiver: active family_relationships row. When `requiredScope`
 *    is provided, the scope set on that row must include it (`hasScope`
 *    superset rules). Notes read procedures pass `"view_notes"`.
 *  - clinicians: active care-team assignment
 *
 * Caregiver branch added for issue #896 (previous notes enforce was
 * clinician-only — caregivers would fall through to the care-team check
 * and get a FORBIDDEN with no route to notes at all).
 */
async function enforcePatientAccess(
  user: NonNullable<Context["user"]>,
  patientId: string,
  requiredScope?: ScopeToken,
  clientIp?: string | null,
): Promise<void> {
  if (user.role === "admin") return;

  if (user.role === "patient") {
    // Note: clinical-notes historically used user.id === patientId because
    // some older test fixtures equate the two. Support both the canonical
    // user.patient_id mapping (production) and the fixture fallback so
    // this branch matches the other routers without breaking tests.
    const ownRecord = user.patient_id ?? user.id;
    if (ownRecord !== patientId && user.id !== patientId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied: patients may only access their own records",
      });
    }
    return;
  }

  if (user.role === "family_caregiver") {
    // Default-deny: notes mutations (create/update/sign/cosign/amend) all
    // call enforcePatientAccess without a requiredScope. An undefined
    // scope here means "not a read procedure" — caregivers never write
    // clinical notes. Explicit block matches the per-procedure role
    // checks below and the issue #908 defense-in-depth posture.
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

const templateBuilders: Record<
  NoteTemplateType,
  (() => ReturnType<typeof createSOAPTemplate>) | null
> = {
  soap: createSOAPTemplate,
  progress: createProgressTemplate,
  h_and_p: null,
  discharge: null,
  consult: null,
};

export const clinicalNotesRbacRouter = t.router({
  create: protectedProcedure
    .input(createNoteSchema)
    .mutation(async ({ ctx, input }) => {
      // Issue #908: caregivers are read-only — they must never author a
      // clinical note. sign/cosign/amend below already gate on
      // physician/specialist/admin, but create and update had no explicit
      // role gate and previously relied on enforcePatientAccess to reject
      // caregivers at the care-team fallback. The caregiver branch added
      // in #896 broke that assumption, so block here explicitly.
      if (ctx.user.role === "family_caregiver") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Caregivers cannot create clinical notes",
        });
      }
      await enforcePatientAccess(ctx.user, input.patient_id, undefined, ctx.clientIp);
      return noteService.createNote(input);
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updateNoteSchema))
    .mutation(async ({ ctx, input }) => {
      if (ctx.user.role === "family_caregiver") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Caregivers cannot update clinical notes",
        });
      }
      const db = getDb();
      const [existing] = await db
        .select({ patient_id: clinicalNotes.patient_id })
        .from(clinicalNotes)
        .where(eq(clinicalNotes.id, input.id))
        .limit(1);

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Note ${input.id} not found` });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id, undefined, ctx.clientIp);

      const { id, ...rest } = input;
      return noteService.updateNote(id, rest);
    }),

  sign: protectedProcedure
    // Deliberately do NOT merge signNoteSchema here — the signer is always
    // ctx.user.id (see comment below). Accepting a client-supplied signed_by
    // would let any permitted role (physician/specialist/admin) forge another
    // user's signature by sending a different UUID.
    .input(z.object({ noteId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Only physicians, specialists, and admins hold the `sign:notes`
      // permission in ROLE_PERMISSIONS (packages/shared-types/src/auth.ts).
      // Enforce that gate explicitly here so a nurse with care-team access
      // cannot forge a physician signature. (HIPAA / issue #271)
      if (!["physician", "specialist", "admin"].includes(ctx.user.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied: role not permitted to sign clinical notes",
        });
      }

      const db = getDb();
      const [existing] = await db
        .select({ patient_id: clinicalNotes.patient_id })
        .from(clinicalNotes)
        .where(eq(clinicalNotes.id, input.noteId))
        .limit(1);

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Note ${input.noteId} not found` });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id, undefined, ctx.clientIp);

      // Signer is always the authenticated caller — never a client-supplied
      // value. The signNoteSchema's `signed_by` field is intentionally
      // ignored at the gateway boundary so signature spoofing is impossible
      // even for permitted roles.
      return noteService.signNote(input.noteId, ctx.user.id);
    }),

  cosign: protectedProcedure
    .input(cosignNoteSchema)
    .mutation(async ({ ctx, input }) => {
      // Cosign requires the same clinical authority as signing — nurses
      // and patients must not cosign. Apply the role gate explicitly in
      // the gateway boundary (matching the sign procedure above) rather
      // than relying on a per-service check.
      if (!["physician", "specialist", "admin"].includes(ctx.user.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied: role not permitted to cosign clinical notes",
        });
      }

      const db = getDb();
      const [existing] = await db
        .select({ patient_id: clinicalNotes.patient_id })
        .from(clinicalNotes)
        .where(eq(clinicalNotes.id, input.noteId))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Note ${input.noteId} not found`,
        });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id, undefined, ctx.clientIp);

      let result;
      try {
        result = await noteService.cosignNote(input.noteId, ctx.user.id);
      } catch (err) {
        if (err instanceof Error && err.name === "NoteStateError") {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }

      // Domain-level audit entry. The Fastify onResponse audit hook also
      // records the tRPC call generically; this explicit row carries the
      // cosigner / subject pair as structured details for HIPAA review.
      try {
        await db.insert(auditLog).values({
          id: crypto.randomUUID(),
          user_id: ctx.user.id,
          action: "cosign",
          resource_type: "clinical_note",
          resource_id: input.noteId,
          patient_id: existing.patient_id,
          procedure_name: "clinicalNotes.cosign",
          details: JSON.stringify({ cosigned_by: ctx.user.id }),
          ip_address: ctx.clientIp ?? "",
          success: true,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Audit write must never fail the mutation — the Fastify hook
        // still captures the base record for this request.
      }

      return result;
    }),

  amend: protectedProcedure
    .input(amendNoteSchema)
    .mutation(async ({ ctx, input }) => {
      if (!["physician", "specialist", "admin"].includes(ctx.user.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied: role not permitted to amend clinical notes",
        });
      }

      const db = getDb();
      // Capture the pre-amend status + version so the audit row can
      // record the clinically-meaningful transition (#886). Amending a
      // cosigned note is a different HIPAA-level event than amending a
      // signed-but-not-cosigned one, and without the pair the audit row
      // alone can't reconstruct which state the chart was in when the
      // amendment happened. Reading before the service call gives us a
      // snapshot of the row as it existed at the moment of the amend
      // decision — races with a concurrent amend are safe because the
      // service-side amend is itself ordered by DB row state.
      const [existing] = await db
        .select({
          patient_id: clinicalNotes.patient_id,
          status: clinicalNotes.status,
          version: clinicalNotes.version,
        })
        .from(clinicalNotes)
        .where(eq(clinicalNotes.id, input.noteId))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Note ${input.noteId} not found`,
        });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id, undefined, ctx.clientIp);

      let result;
      try {
        result = await noteService.amendNote(
          input.noteId,
          ctx.user.id,
          input.sections,
          input.reason,
        );
      } catch (err) {
        if (err instanceof Error && err.name === "NoteStateError") {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }

      // Record the amendment reason explicitly — HIPAA amendment audit
      // requires the reason be retrievable alongside the actor/subject.
      // `old_status` + `new_status` + `previous_version` capture the
      // clinical transition (#886): amending a cosigned chart is a
      // materially different event than amending a signed-only draft.
      try {
        await db.insert(auditLog).values({
          id: crypto.randomUUID(),
          user_id: ctx.user.id,
          action: "amend",
          resource_type: "clinical_note",
          resource_id: input.noteId,
          patient_id: existing.patient_id,
          procedure_name: "clinicalNotes.amend",
          details: JSON.stringify({
            amended_by: ctx.user.id,
            reason: input.reason,
            old_status: existing.status,
            new_status: result.status,
            previous_version: existing.version,
            new_version: result.version,
          }),
          ip_address: ctx.clientIp ?? "",
          success: true,
          timestamp: new Date().toISOString(),
        });
      } catch {
        // See cosign above — audit failures are never surfaced.
      }

      return result;
    }),

  getVersionHistory: protectedProcedure
    .input(z.object({ noteId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const [existing] = await db
        .select({ patient_id: clinicalNotes.patient_id })
        .from(clinicalNotes)
        .where(eq(clinicalNotes.id, input.noteId))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `Note ${input.noteId} not found`,
        });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id, "view_notes", ctx.clientIp);

      return noteService.getVersionHistory(input.noteId);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId, "view_notes", ctx.clientIp);
      return noteService.getNotesByPatient(input.patientId);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const result = await noteService.getNoteById(input.id);

      if (!result) {
        return null;
      }

      await enforcePatientAccess(ctx.user, result.note.patient_id, "view_notes", ctx.clientIp);

      return result;
    }),

  templates: t.router({
    list: t.procedure.query(() => {
      return Object.entries(templateBuilders)
        .filter(([, builder]) => builder !== null)
        .map(([type]) => type as NoteTemplateType);
    }),

    get: t.procedure
      .input(z.object({ type: noteTemplateTypeSchema }))
      .query(({ input }) => {
        const builder = templateBuilders[input.type];
        if (!builder) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Template "${input.type}" is not yet implemented`,
          });
        }
        return builder();
      }),
  }),
});

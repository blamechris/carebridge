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
import { getDb, clinicalNotes, auditLog } from "@carebridge/db-schema";
import { eq } from "drizzle-orm";
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
 */
async function enforcePatientAccess(
  user: NonNullable<Context["user"]>,
  patientId: string,
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

  // Clinicians (physician, specialist, nurse) must be on the care team.
  const hasAccess = await assertCareTeamAccess(user.id, patientId);
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
      await enforcePatientAccess(ctx.user, input.patient_id);
      return noteService.createNote(input);
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updateNoteSchema))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [existing] = await db
        .select({ patient_id: clinicalNotes.patient_id })
        .from(clinicalNotes)
        .where(eq(clinicalNotes.id, input.id))
        .limit(1);

      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Note ${input.id} not found` });
      }

      await enforcePatientAccess(ctx.user, existing.patient_id);

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

      await enforcePatientAccess(ctx.user, existing.patient_id);

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

      await enforcePatientAccess(ctx.user, existing.patient_id);

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
          ip_address: "",
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

      await enforcePatientAccess(ctx.user, existing.patient_id);

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
            new_version: result.version,
          }),
          ip_address: "",
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

      await enforcePatientAccess(ctx.user, existing.patient_id);

      return noteService.getVersionHistory(input.noteId);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await enforcePatientAccess(ctx.user, input.patientId);
      return noteService.getNotesByPatient(input.patientId);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const result = await noteService.getNoteById(input.id);

      if (!result) {
        return null;
      }

      await enforcePatientAccess(ctx.user, result.note.patient_id);

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

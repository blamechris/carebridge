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
import {
  createNoteSchema,
  updateNoteSchema,
  signNoteSchema,
  noteTemplateTypeSchema,
} from "@carebridge/validators";
import type { NoteTemplateType } from "@carebridge/shared-types";
import {
  noteService,
  createSOAPTemplate,
  createProgressTemplate,
} from "@carebridge/clinical-notes";
import { getDb, clinicalNotes } from "@carebridge/db-schema";
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
    .input(z.object({ noteId: z.string().uuid() }).merge(signNoteSchema))
    .mutation(async ({ ctx, input }) => {
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

      return noteService.signNote(input.noteId, input.signed_by);
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

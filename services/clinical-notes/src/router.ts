import { initTRPC, TRPCError } from "@trpc/server";
import type { User, ServiceContext, NoteTemplateType } from "@carebridge/shared-types";
import { z } from "zod";
import {
  createNoteSchema,
  updateNoteSchema,
  signNoteSchema,
  noteTemplateTypeSchema,
} from "@carebridge/validators";
import * as noteService from "./services/note-service.js";
import { createSOAPTemplate } from "./templates/soap.js";
import { createProgressTemplate } from "./templates/progress.js";

// ---------------------------------------------------------------------------
// tRPC instance with gateway context
// ---------------------------------------------------------------------------

const t = initTRPC.context<ServiceContext>().create();

// ---------------------------------------------------------------------------
// Procedure builders with RBAC
// ---------------------------------------------------------------------------
const CLINICAL_WRITER_ROLES: User["role"][] = ["admin", "physician", "specialist", "nurse"];

const authed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required." });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const requireClinicalWrite = t.middleware(({ ctx, next }) => {
  if (!ctx.user || !CLINICAL_WRITER_ROLES.includes(ctx.user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Clinical data modifications require a clinical staff role.",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(authed);
const clinicalWriteProcedure = t.procedure.use(authed).use(requireClinicalWrite);

/** Assert patient can only see own records. */
function assertPatientAccess(user: User, patientId: string): void {
  if (user.role === "patient" && user.id !== patientId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Patients can only access their own records.",
    });
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const templateBuilders: Record<NoteTemplateType, (() => ReturnType<typeof createSOAPTemplate>) | null> = {
  soap: createSOAPTemplate,
  progress: createProgressTemplate,
  h_and_p: null,
  discharge: null,
  consult: null,
};

export const clinicalNotesRouter = t.router({
  create: clinicalWriteProcedure
    .input(createNoteSchema)
    .mutation(async ({ input }) => {
      return noteService.createNote(input);
    }),

  update: clinicalWriteProcedure
    .input(z.object({ id: z.string().uuid() }).merge(updateNoteSchema))
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      return noteService.updateNote(id, rest);
    }),

  sign: clinicalWriteProcedure
    .input(z.object({ noteId: z.string().uuid() }).merge(signNoteSchema))
    .mutation(async ({ input }) => {
      return noteService.signNote(input.noteId, input.signed_by);
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      assertPatientAccess(ctx.user, input.patientId);
      return noteService.getNotesByPatient(input.patientId);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      // Note: patient-scoping by noteId would require fetching the note first
      // to check patient_id. Deferred to v2 — for now any authenticated user
      // can read a note by its id (read-level access only).
      return noteService.getNoteById(input.id);
    }),

  templates: t.router({
    list: protectedProcedure.query(() => {
      return Object.entries(templateBuilders)
        .filter(([, builder]) => builder !== null)
        .map(([type]) => type as NoteTemplateType);
    }),

    get: protectedProcedure
      .input(z.object({ type: noteTemplateTypeSchema }))
      .query(({ input }) => {
        const builder = templateBuilders[input.type];
        if (!builder) {
          throw new Error(`Template "${input.type}" is not yet implemented`);
        }
        return builder();
      }),
  }),
});

export type ClinicalNotesRouter = typeof clinicalNotesRouter;

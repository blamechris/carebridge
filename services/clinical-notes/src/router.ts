import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createNoteSchema,
  updateNoteSchema,
  signNoteSchema,
  cosignNoteSchema,
  amendNoteSchema,
  noteTemplateTypeSchema,
} from "@carebridge/validators";
import type { NoteTemplateType } from "@carebridge/shared-types";
import * as noteService from "./services/note-service.js";
import { NoteConflictError, NoteStateError } from "./services/note-service.js";
import { createSOAPTemplate } from "./templates/soap.js";
import { createProgressTemplate } from "./templates/progress.js";
import { createHAndPTemplate } from "./templates/h-and-p.js";
import { createDischargeTemplate } from "./templates/discharge.js";
import { createConsultTemplate } from "./templates/consult.js";

const t = initTRPC.create();

const templateBuilders: Record<NoteTemplateType, (() => ReturnType<typeof createSOAPTemplate>) | null> = {
  soap: createSOAPTemplate,
  progress: createProgressTemplate,
  h_and_p: createHAndPTemplate,
  discharge: createDischargeTemplate,
  consult: createConsultTemplate,
};

export const clinicalNotesRouter = t.router({
  create: t.procedure
    .input(createNoteSchema)
    .mutation(async ({ input }) => {
      return noteService.createNote(input);
    }),

  update: t.procedure
    .input(z.object({ id: z.string().uuid() }).merge(updateNoteSchema))
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      try {
        return await noteService.updateNote(id, rest);
      } catch (err) {
        if (err instanceof NoteConflictError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),

  sign: t.procedure
    .input(z.object({ noteId: z.string().uuid() }).merge(signNoteSchema))
    .mutation(async ({ input }) => {
      return noteService.signNote(input.noteId, input.signed_by);
    }),

  cosign: t.procedure
    // Cosigner identity is carried in the caller's auth context at the
    // gateway tier; this internal router takes it as a second field to
    // keep the service-under-router ergonomic for unit tests and for
    // future call sites that don't go through the auth boundary.
    .input(cosignNoteSchema.extend({ cosigned_by: z.string().uuid() }))
    .mutation(async ({ input }) => {
      try {
        return await noteService.cosignNote(input.noteId, input.cosigned_by);
      } catch (err) {
        if (err instanceof NoteStateError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),

  amend: t.procedure
    .input(amendNoteSchema.extend({ amended_by: z.string().uuid() }))
    .mutation(async ({ input }) => {
      try {
        return await noteService.amendNote(
          input.noteId,
          input.amended_by,
          input.sections,
          input.reason,
        );
      } catch (err) {
        if (err instanceof NoteStateError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),

  getVersionHistory: t.procedure
    .input(z.object({ noteId: z.string().uuid() }))
    .query(async ({ input }) => {
      return noteService.getVersionHistory(input.noteId);
    }),

  getByPatient: t.procedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ input }) => {
      return noteService.getNotesByPatient(input.patientId);
    }),

  getById: t.procedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      return noteService.getNoteById(input.id);
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
          throw new Error(`Template "${input.type}" is not yet implemented`);
        }
        return builder();
      }),
  }),
});

export type ClinicalNotesRouter = typeof clinicalNotesRouter;

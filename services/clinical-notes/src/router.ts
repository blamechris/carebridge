import { initTRPC } from "@trpc/server";
import { z } from "zod";
import {
  createNoteSchema,
  updateNoteSchema,
  signNoteSchema,
  noteTemplateTypeSchema,
} from "@carebridge/validators";
import type { NoteTemplateType } from "@carebridge/shared-types";
import * as noteService from "./services/note-service.js";
import { createSOAPTemplate } from "./templates/soap.js";
import { createProgressTemplate } from "./templates/progress.js";

const t = initTRPC.create();

const templateBuilders: Record<NoteTemplateType, (() => ReturnType<typeof createSOAPTemplate>) | null> = {
  soap: createSOAPTemplate,
  progress: createProgressTemplate,
  h_and_p: null,
  discharge: null,
  consult: null,
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
      return noteService.updateNote(id, rest);
    }),

  sign: t.procedure
    .input(z.object({ noteId: z.string().uuid() }).merge(signNoteSchema))
    .mutation(async ({ input }) => {
      return noteService.signNote(input.noteId, input.signed_by);
    }),

  getByPatient: t.procedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ input }) => {
      return noteService.getNotesByPatient(input.patientId);
    }),

  timelineByPatient: t.procedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ input }) => {
      return noteService.getTimelineByPatient(input.patientId);
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

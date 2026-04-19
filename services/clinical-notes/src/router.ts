import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  createNoteSchema,
  updateNoteSchema,
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

/**
 * Internal router context (#884).
 *
 * The internal clinical-notes router no longer accepts `cosigned_by` /
 * `amended_by` in Zod input — those fields were a spoofing vector even if
 * the only in-tree caller (the gateway wrapper) passes the authenticated
 * user id. Call sites that do not flow through the auth boundary (unit
 * tests, future BullMQ workers) must pass the actor id via ctx.actorId.
 *
 * Leaving `actorId` optional keeps the router ergonomic for read-only
 * procedures (getVersionHistory, getByPatient, getById, templates.*) that
 * never need an actor — the actor resolution helper only throws for the
 * mutation procedures that actually write an actor-bearing row.
 */
export interface ClinicalNotesRouterContext {
  actorId?: string;
}

const t = initTRPC.context<ClinicalNotesRouterContext>().create();

/**
 * Resolve the acting user id for a state-changing procedure. Throws
 * UNAUTHORIZED when the context lacks one so mis-wired call sites fail
 * loudly instead of silently attributing a write to an empty string.
 */
function getActorId(
  ctx: ClinicalNotesRouterContext,
  operation: string,
): string {
  if (!ctx.actorId || ctx.actorId.length === 0) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: `Internal clinical-notes router requires ctx.actorId for ${operation}`,
    });
  }
  return ctx.actorId;
}

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
    // `signed_by` is server-derived from ctx.actorId — see #884. The
    // input schema carries only the target note id so the internal
    // router has no avenue to spoof the signer even if mounted directly.
    .input(z.object({ noteId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const actor = getActorId(ctx, "sign");
      return noteService.signNote(input.noteId, actor);
    }),

  cosign: t.procedure
    // Cosigner and amender identities are server-derived only (#884).
    //
    // Previously these procedures accepted `cosigned_by` / `amended_by` in
    // input via `.extend()`, which would have let a caller forge another
    // user's signature if the internal router were ever mounted directly.
    // The gateway-level wrapper in `api-gateway/src/routers/clinical-notes.ts`
    // already ignores client input and uses `ctx.user.id`, but this
    // internal router is the last line of defence — accepting identity via
    // Zod input was a latent spoofing vector, so we drop those fields from
    // the schema and read them from the meta object passed by call sites
    // that don't flow through the auth boundary (unit tests, workers).
    .input(cosignNoteSchema)
    .mutation(async ({ input, ctx }) => {
      const actor = getActorId(ctx, "cosign");
      try {
        return await noteService.cosignNote(input.noteId, actor);
      } catch (err) {
        if (err instanceof NoteStateError) {
          throw new TRPCError({ code: "CONFLICT", message: err.message });
        }
        throw err;
      }
    }),

  amend: t.procedure
    .input(amendNoteSchema)
    .mutation(async ({ input, ctx }) => {
      const actor = getActorId(ctx, "amend");
      try {
        return await noteService.amendNote(
          input.noteId,
          actor,
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

/**
 * Phase B1 — @carebridge/checkins tRPC router.
 *
 * Standalone, context-less router. Authentication / RBAC is enforced
 * by the api-gateway wrapper (`services/api-gateway/src/routers/checkins.ts`)
 * which injects `submitted_by_user_id` + `submitted_by_relationship`
 * from the authenticated session before calling `submit`. This mirrors
 * the existing `@carebridge/fhir-gateway` -> api-gateway wrapping
 * pattern so the feature service stays deploy-independent of auth.
 *
 * Procedures:
 *   - templates.list       — list published, non-retired templates
 *   - templates.get        — fetch a single template by id
 *   - submit               — validate + persist a check-in, emit event
 *   - history.byPatient    — recent check-ins for a patient
 *   - getById              — single check-in by id (for detail view)
 */

import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import {
  getDb,
  checkInTemplates,
  checkIns,
} from "@carebridge/db-schema";
import { submitCheckInServiceSchema } from "@carebridge/validators";
import {
  submitCheckIn,
  TemplateNotFoundError,
  TemplateRetiredError,
  TemplateVersionMismatchError,
} from "./services/checkin-service.js";

const t = initTRPC.create();

/**
 * Thin DTO for the templates list — intentionally parses the
 * `questions` JSON string so the UI doesn't have to. `target_condition`
 * and `frequency` are included so the portal can group and label
 * templates without a second round trip.
 */
function templateRowToDto(row: typeof checkInTemplates.$inferSelect) {
  let questions: unknown;
  try {
    questions = JSON.parse(row.questions);
  } catch {
    // A malformed template shouldn't take the whole list down; surface
    // it as an empty question set so the UI can render "template
    // unavailable" and the clinician ops team notices.
    questions = [];
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    target_condition: row.target_condition,
    frequency: row.frequency,
    published_at: row.published_at,
    questions,
  };
}

export const checkinsRouter = t.router({
  templates: t.router({
    /**
     * List every currently-active template. "Active" = published and
     * not retired. Ordered by name for stable rendering.
     */
    list: t.procedure.query(async () => {
      const db = getDb();
      const rows = await db
        .select()
        .from(checkInTemplates)
        .where(
          and(
            isNotNull(checkInTemplates.published_at),
            isNull(checkInTemplates.retired_at),
          ),
        );
      return rows
        .map(templateRowToDto)
        .sort((a, b) => a.name.localeCompare(b.name));
    }),

    /**
     * Fetch a single template by id. Returns null if not found so the
     * UI can distinguish "404" from a server error.
     */
    get: t.procedure
      .input(z.object({ id: z.string().uuid() }))
      .query(async ({ input }) => {
        const db = getDb();
        const [row] = await db
          .select()
          .from(checkInTemplates)
          .where(eq(checkInTemplates.id, input.id))
          .limit(1);
        return row ? templateRowToDto(row) : null;
      }),
  }),

  /**
   * Submit a check-in. Validation, template-version checks, PHI
   * sanitisation, red-flag evaluation, DB insert, and clinical-events
   * emission all live in `submitCheckIn` — this procedure is just a
   * thin mapping from `Error` subclasses to tRPC error codes.
   */
  submit: t.procedure
    .input(submitCheckInServiceSchema)
    .mutation(async ({ input }) => {
      try {
        return await submitCheckIn(input);
      } catch (err) {
        if (err instanceof TemplateNotFoundError) {
          throw new Error("NOT_FOUND: " + err.message);
        }
        if (err instanceof TemplateRetiredError) {
          throw new Error("TEMPLATE_RETIRED: " + err.message);
        }
        if (err instanceof TemplateVersionMismatchError) {
          throw new Error(
            `TEMPLATE_VERSION_MISMATCH: client sent v${err.clientVersion}, server is v${err.serverVersion}`,
          );
        }
        throw err;
      }
    }),

  history: t.router({
    /**
     * Recent check-ins for a patient, newest first. Bounded by `limit`
     * so large patients don't blow up the portal; pagination can be
     * added later when the UI needs it.
     *
     * Note: this returns the encrypted `responses` column via drizzle's
     * encryptedJsonb helper, so the decryption happens inside the
     * PHI-handling boundary. The api-gateway wrapper is responsible for
     * enforcing patient access scope before calling this.
     */
    byPatient: t.procedure
      .input(
        z.object({
          patient_id: z.string().uuid(),
          limit: z.number().int().positive().max(100).default(25),
        }),
      )
      .query(async ({ input }) => {
        const db = getDb();
        const rows = await db
          .select()
          .from(checkIns)
          .where(eq(checkIns.patient_id, input.patient_id))
          .orderBy(desc(checkIns.submitted_at))
          .limit(input.limit);
        return rows.map((row) => ({
          id: row.id,
          patient_id: row.patient_id,
          template_id: row.template_id,
          template_version: row.template_version,
          submitted_by_user_id: row.submitted_by_user_id,
          submitted_by_relationship: row.submitted_by_relationship,
          responses: row.responses,
          red_flag_hits: safeParseStringArray(row.red_flag_hits),
          submitted_at: row.submitted_at,
        }));
      }),
  }),

  /**
   * Single check-in by id — used by the clinician flag-detail view
   * when they click a check-in-sourced flag and want to see the
   * actual patient answers. Returns null if not found.
   */
  getById: t.procedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = getDb();
      const [row] = await db
        .select()
        .from(checkIns)
        .where(eq(checkIns.id, input.id))
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        patient_id: row.patient_id,
        template_id: row.template_id,
        template_version: row.template_version,
        submitted_by_user_id: row.submitted_by_user_id,
        submitted_by_relationship: row.submitted_by_relationship,
        responses: row.responses,
        red_flag_hits: safeParseStringArray(row.red_flag_hits),
        submitted_at: row.submitted_at,
      };
    }),
});

export type CheckinsRouter = typeof checkinsRouter;

/**
 * The `red_flag_hits` column is a JSON-encoded string[]. Parse
 * defensively — a corrupt row should not 500 the whole history list.
 */
function safeParseStringArray(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
      return parsed as string[];
    }
  } catch {
    // fall through
  }
  return [];
}

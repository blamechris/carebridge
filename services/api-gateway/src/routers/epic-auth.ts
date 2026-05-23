/**
 * tRPC surface for SMART App Launch state (#392).
 *
 * Powers the clinician portal Settings page ("Connect to Epic" card)
 * and the launch-context banner shown when a clinician arrives via
 * EHR Launch.
 *
 *   epicAuth.getMyConnections  — list every Epic org this user has linked
 *   epicAuth.getLaunchContext  — patient + encounter context for the
 *                                most-recently-launched connection (if
 *                                still within the access-token's TTL)
 *   epicAuth.disconnect        — delete the connection row for a given org
 *
 * No write of new connections via tRPC — those land via the OAuth
 * callback (services/api-gateway/src/routes/epic-auth.ts) after a real
 * browser round-trip to Epic.
 */
import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import {
  getConnectionsForUser,
  deleteConnection,
} from "@carebridge/epic-connector";
import type { Context } from "../context.js";

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

export const epicAuthRbacRouter = t.router({
  /**
   * List every Epic-org connection for the authenticated user.
   * Access/refresh tokens are intentionally NOT returned — clients
   * never need them. We surface only the metadata (org URL, granted
   * scopes, expiry, FHIR identity).
   */
  getMyConnections: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getConnectionsForUser(ctx.user.id);
    return rows.map((r) => ({
      id: r.id,
      epic_org_iss: r.epic_org_iss,
      scopes: r.scopes,
      expires_at: r.expires_at,
      epic_practitioner_fhir_id: r.epic_practitioner_fhir_id,
      epic_patient_fhir_id: r.epic_patient_fhir_id,
      launch_encounter_fhir_id: r.launch_encounter_fhir_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
    }));
  }),

  /**
   * Return the most-recent connection plus its launch context, if
   * still valid. Returns `null` when the user has no Epic connection
   * or every connection's token has expired.
   *
   * The clinician portal uses this on page load to decide whether to
   * pre-select the Epic-supplied patient/encounter.
   */
  getLaunchContext: protectedProcedure.query(async ({ ctx }) => {
    const rows = await getConnectionsForUser(ctx.user.id);
    const valid = rows.filter(
      (r) => Date.parse(r.expires_at) > Date.now(),
    );
    if (valid.length === 0) return null;
    // Most-recently-updated (latest launch) wins.
    valid.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    const top = valid[0]!;
    return {
      epic_org_iss: top.epic_org_iss,
      epic_practitioner_fhir_id: top.epic_practitioner_fhir_id,
      epic_patient_fhir_id: top.epic_patient_fhir_id,
      launch_encounter_fhir_id: top.launch_encounter_fhir_id,
      expires_at: top.expires_at,
    };
  }),

  /**
   * Delete a single Epic-org connection. Idempotent — returning
   * { removed: false } when no row matched is treated as success.
   */
  disconnect: protectedProcedure
    .input(z.object({ epic_org_iss: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      const removed = await deleteConnection(ctx.user.id, input.epic_org_iss);
      return { removed };
    }),
});

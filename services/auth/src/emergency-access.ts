/**
 * Break-the-glass emergency access procedures.
 *
 * Allows providers to request time-limited access to patient records they
 * aren't assigned to. Every request is:
 * 1. Logged with mandatory justification (encrypted at rest)
 * 2. Time-limited (default: 4 hours)
 * 3. Immediately flagged to compliance via audit log
 */

import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getDb, emergencyAccess, auditLog } from "@carebridge/db-schema";
import { eq, and, gt, isNull } from "drizzle-orm";
import crypto from "node:crypto";

const t = initTRPC.create();

/** Default emergency access duration: 4 hours. */
const DEFAULT_ACCESS_HOURS = 4;

export const emergencyAccessRouter = t.router({
  /** Request emergency access to a patient record. */
  request: t.procedure
    .input(z.object({
      userId: z.string(),
      patientId: z.string(),
      justification: z.string().min(10, "Justification must be at least 10 characters"),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + DEFAULT_ACCESS_HOURS * 60 * 60 * 1000);

      const id = crypto.randomUUID();

      await db.insert(emergencyAccess).values({
        id,
        user_id: input.userId,
        patient_id: input.patientId,
        justification: input.justification,
        granted_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        created_at: now.toISOString(),
      });

      // Create high-priority audit log entry for compliance
      await db.insert(auditLog).values({
        id: crypto.randomUUID(),
        user_id: input.userId,
        action: "emergency_access",
        resource_type: "patient",
        resource_id: input.patientId,
        patient_id: input.patientId,
        procedure_name: "emergencyAccess.request",
        ip_address: "",
        timestamp: now.toISOString(),
      });

      return {
        id,
        expires_at: expiresAt.toISOString(),
        duration_hours: DEFAULT_ACCESS_HOURS,
      };
    }),

  /** Check if a user has active emergency access to a patient. */
  check: t.procedure
    .input(z.object({
      userId: z.string(),
      patientId: z.string(),
    }))
    .query(async ({ input }) => {
      const db = getDb();
      const now = new Date().toISOString();

      const [active] = await db.select().from(emergencyAccess)
        .where(
          and(
            eq(emergencyAccess.user_id, input.userId),
            eq(emergencyAccess.patient_id, input.patientId),
            gt(emergencyAccess.expires_at, now),
            isNull(emergencyAccess.revoked_at),
          ),
        )
        .limit(1);

      return {
        hasAccess: !!active,
        expiresAt: active?.expires_at ?? null,
      };
    }),

  /** Revoke emergency access (by compliance or admin). */
  revoke: t.procedure
    .input(z.object({
      accessId: z.string(),
      revokedBy: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const now = new Date().toISOString();

      await db.update(emergencyAccess)
        .set({
          revoked_at: now,
          revoked_by: input.revokedBy,
        })
        .where(eq(emergencyAccess.id, input.accessId));

      return { revoked: true };
    }),

  /** List all emergency access events (for compliance dashboard). */
  listAll: t.procedure
    .input(z.object({ limit: z.number().optional().default(50) }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(emergencyAccess)
        .orderBy(emergencyAccess.granted_at)
        .limit(input.limit);
    }),
});

export type EmergencyAccessRouter = typeof emergencyAccessRouter;

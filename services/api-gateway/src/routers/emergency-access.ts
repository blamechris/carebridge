/**
 * RBAC-enforced emergency access router.
 *
 * Only clinicians (physician, specialist, nurse) and admins can request
 * emergency access. Patients cannot use this mechanism.
 */

import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import { getDb } from "@carebridge/db-schema";
import { emergencyAccess, auditLog } from "@carebridge/db-schema";
import { eq, and, gt, isNull, desc } from "drizzle-orm";
import crypto from "node:crypto";
import type { Context } from "../context.js";
import { assertPermission } from "../middleware/rbac.js";

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(isAuthenticated);

const DEFAULT_ACCESS_HOURS = 4;

export const emergencyAccessRbacRouter = t.router({
  request: protectedProcedure
    .input(z.object({
      patientId: z.string(),
      justification: z.string().min(10, "Justification must be at least 10 characters"),
    }))
    .mutation(async ({ ctx, input }) => {
      // Only clinicians and admins can request emergency access
      if (ctx.user.role === "patient") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Patients cannot request emergency access to other patients",
        });
      }

      const db = getDb();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + DEFAULT_ACCESS_HOURS * 60 * 60 * 1000);
      const id = crypto.randomUUID();

      await db.insert(emergencyAccess).values({
        id,
        user_id: ctx.user.id,
        patient_id: input.patientId,
        justification: input.justification,
        granted_at: now.toISOString(),
        expires_at: expiresAt.toISOString(),
        created_at: now.toISOString(),
      });

      await db.insert(auditLog).values({
        id: crypto.randomUUID(),
        user_id: ctx.user.id,
        action: "emergency_access",
        resource_type: "patient",
        resource_id: input.patientId,
        patient_id: input.patientId,
        procedure_name: "emergencyAccess.request",
        ip_address: "",
        timestamp: now.toISOString(),
      });

      return { id, expires_at: expiresAt.toISOString(), duration_hours: DEFAULT_ACCESS_HOURS };
    }),

  check: protectedProcedure
    .input(z.object({ patientId: z.string() }))
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const now = new Date().toISOString();

      const [active] = await db.select().from(emergencyAccess)
        .where(
          and(
            eq(emergencyAccess.user_id, ctx.user.id),
            eq(emergencyAccess.patient_id, input.patientId),
            gt(emergencyAccess.expires_at, now),
            isNull(emergencyAccess.revoked_at),
          ),
        )
        .limit(1);

      return { hasAccess: !!active, expiresAt: active?.expires_at ?? null };
    }),

  revoke: protectedProcedure
    .input(z.object({ accessId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Centralized RBAC: `admin:users` is only granted to the admin role
      // in ROLE_PERMISSIONS, so this replaces the previous inline role check.
      assertPermission(ctx.user, "admin:users");
      const db = getDb();
      await db.update(emergencyAccess)
        .set({ revoked_at: new Date().toISOString(), revoked_by: ctx.user.id })
        .where(eq(emergencyAccess.id, input.accessId));
      return { revoked: true };
    }),

  listAll: protectedProcedure
    .input(z.object({ limit: z.number().optional().default(50) }))
    .query(async ({ ctx }) => {
      if (ctx.user.role !== "admin") {
        throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can view all emergency access records" });
      }
      const db = getDb();
      return db.select().from(emergencyAccess)
        .orderBy(desc(emergencyAccess.granted_at))
        .limit(50);
    }),
});

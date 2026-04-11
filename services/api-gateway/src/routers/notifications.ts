/**
 * RBAC-enforced notifications router.
 *
 * Wraps the notifications service procedures with authentication and
 * ownership checks. userId is derived from ctx.user.id, never from client
 * input, so cross-user PHI reads are impossible.
 *
 * Procedures:
 *   - getMine:          read the caller's own notifications
 *   - getByUser:        back-compat alias; allowed only when caller owns the
 *                       userId (or is admin)
 *   - markRead:         ownership check against the notification row
 *   - getPreferences:   scoped to ctx.user.id
 *   - updatePreference: scoped to ctx.user.id
 *
 * The `create` mutation from the raw service router is intentionally NOT
 * exposed here — notifications are produced internally by workers, not by
 * external API callers.
 */

import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import { getDb } from "@carebridge/db-schema";
import { notifications, notificationPreferences } from "@carebridge/db-schema";
import { eq, and, desc } from "drizzle-orm";
import crypto from "node:crypto";
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

export const notificationsRbacRouter = t.router({
  /**
   * Read the authenticated user's notifications. userId is derived from
   * the session context, so there is no way for a caller to read another
   * user's notifications.
   */
  getMine: protectedProcedure
    .input(z.object({ unreadOnly: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const db = getDb();
      const conditions = [eq(notifications.user_id, ctx.user.id)];
      if (input?.unreadOnly) {
        conditions.push(eq(notifications.is_read, false));
      }
      return db
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.created_at))
        .limit(50);
    }),

  /**
   * Back-compat alias for clients that still pass userId explicitly.
   * Enforces that the requested userId matches ctx.user.id, or that the
   * caller is an admin.
   */
  getByUser: protectedProcedure
    .input(z.object({ userId: z.string(), unreadOnly: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      if (ctx.user.role !== "admin" && ctx.user.id !== input.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Access denied: you may only read your own notifications",
        });
      }

      const db = getDb();
      const conditions = [eq(notifications.user_id, input.userId)];
      if (input.unreadOnly) {
        conditions.push(eq(notifications.is_read, false));
      }
      return db
        .select()
        .from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.created_at))
        .limit(50);
    }),

  /**
   * Mark a single notification as read. The notification must belong to
   * the authenticated user (or the caller must be an admin).
   */
  markRead: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      // Select only the ownership column. notifications.title and .body are
      // encryptedText, so a SELECT * would unnecessarily decrypt PHI just to
      // perform an ownership check. Per Copilot review on PR #373.
      const [existing] = await db
        .select({ user_id: notifications.user_id })
        .from(notifications)
        .where(eq(notifications.id, input.id))
        .limit(1);

      if (!existing) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Notification not found",
        });
      }

      if (ctx.user.role !== "admin" && existing.user_id !== ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Access denied: notification belongs to another user",
        });
      }

      await db
        .update(notifications)
        .set({ is_read: true, read_at: new Date().toISOString() })
        .where(eq(notifications.id, input.id));
      return { success: true };
    }),

  /**
   * Read the authenticated user's notification preferences. userId is
   * derived from ctx and cannot be overridden by the caller.
   */
  getPreferences: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    return db
      .select()
      .from(notificationPreferences)
      .where(eq(notificationPreferences.user_id, ctx.user.id));
  }),

  /**
   * Upsert a notification preference for the authenticated user. userId
   * is derived from ctx — the client cannot modify another user's
   * preferences.
   */
  updatePreference: protectedProcedure
    .input(
      z.object({
        notificationType: z.string(),
        channel: z.string(),
        enabled: z.boolean(),
        quietHoursStart: z.string().nullable().optional(),
        quietHoursEnd: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const now = new Date().toISOString();

      const [existing] = await db
        .select()
        .from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.user_id, ctx.user.id),
            eq(notificationPreferences.notification_type, input.notificationType),
            eq(notificationPreferences.channel, input.channel),
          ),
        );

      if (existing) {
        await db
          .update(notificationPreferences)
          .set({
            enabled: input.enabled,
            quiet_hours_start: input.quietHoursStart ?? null,
            quiet_hours_end: input.quietHoursEnd ?? null,
            updated_at: now,
          })
          .where(eq(notificationPreferences.id, existing.id));
        // Reflect ALL updated fields in the response, not just enabled.
        // Per Copilot review on PR #373 — the previous response leaked the
        // pre-update quiet_hours_start/end from `existing`.
        return {
          ...existing,
          enabled: input.enabled,
          quiet_hours_start: input.quietHoursStart ?? null,
          quiet_hours_end: input.quietHoursEnd ?? null,
          updated_at: now,
        };
      }

      const pref = {
        id: crypto.randomUUID(),
        user_id: ctx.user.id,
        notification_type: input.notificationType,
        channel: input.channel,
        enabled: input.enabled,
        quiet_hours_start: input.quietHoursStart ?? null,
        quiet_hours_end: input.quietHoursEnd ?? null,
        created_at: now,
        updated_at: now,
      };

      await db.insert(notificationPreferences).values(pref);
      return pref;
    }),
});

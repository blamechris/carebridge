import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getDb } from "@carebridge/db-schema";
import { notifications, notificationPreferences } from "@carebridge/db-schema";
import { eq, and, desc } from "drizzle-orm";
import crypto from "node:crypto";
import { publishNotification } from "./publish.js";

const t = initTRPC.create();

export const notificationsRouter = t.router({
  getByUser: t.procedure
    .input(z.object({ userId: z.string(), unreadOnly: z.boolean().optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      const conditions = [eq(notifications.user_id, input.userId)];
      if (input.unreadOnly) conditions.push(eq(notifications.is_read, false));
      return db.select().from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.created_at))
        .limit(50);
    }),

  markRead: t.procedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(notifications)
        .set({ is_read: true, read_at: new Date().toISOString() })
        .where(eq(notifications.id, input.id));
      return { success: true };
    }),

  create: t.procedure
    .input(z.object({
      user_id: z.string(),
      type: z.string(),
      title: z.string(),
      body: z.string().optional(),
      summary_safe: z.string().optional(),
      link: z.string().optional(),
      related_flag_id: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const notification = {
        id: crypto.randomUUID(),
        ...input,
        is_read: false,
        created_at: new Date().toISOString(),
      };
      await db.insert(notifications).values(notification);

      // Publish to Redis pub/sub for real-time SSE delivery.
      // Best-effort: a Redis outage should not fail the mutation after
      // the notification row has already been persisted.
      try {
        await publishNotification(notification.user_id, {
          id: notification.id,
          type: notification.type,
          title: notification.title,
          body: notification.body,
          link: notification.link,
          related_flag_id: notification.related_flag_id,
          created_at: notification.created_at,
        });
      } catch (error) {
        console.error("[notifications] Failed to publish notification to Redis", {
          notificationId: notification.id,
          userId: notification.user_id,
          error,
        });
      }

      return notification;
    }),
  getPreferences: t.procedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(notificationPreferences)
        .where(eq(notificationPreferences.user_id, input.userId));
    }),

  updatePreference: t.procedure
    .input(z.object({
      userId: z.string(),
      notificationType: z.string(),
      channel: z.string(),
      enabled: z.boolean(),
      quietHoursStart: z.string().nullable().optional(),
      quietHoursEnd: z.string().nullable().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const now = new Date().toISOString();

      // Check if preference exists
      const [existing] = await db.select().from(notificationPreferences)
        .where(
          and(
            eq(notificationPreferences.user_id, input.userId),
            eq(notificationPreferences.notification_type, input.notificationType),
            eq(notificationPreferences.channel, input.channel),
          ),
        );

      if (existing) {
        await db.update(notificationPreferences)
          .set({
            enabled: input.enabled,
            quiet_hours_start: input.quietHoursStart ?? null,
            quiet_hours_end: input.quietHoursEnd ?? null,
            updated_at: now,
          })
          .where(eq(notificationPreferences.id, existing.id));
        return { ...existing, enabled: input.enabled, updated_at: now };
      }

      const pref = {
        id: crypto.randomUUID(),
        user_id: input.userId,
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

export type NotificationsRouter = typeof notificationsRouter;

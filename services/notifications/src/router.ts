import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getDb } from "@carebridge/db-schema";
import { notifications } from "@carebridge/db-schema";
import { eq, and, desc } from "drizzle-orm";
import crypto from "node:crypto";

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
      return notification;
    }),
});

export type NotificationsRouter = typeof notificationsRouter;

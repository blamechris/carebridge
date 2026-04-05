import { initTRPC, TRPCError } from "@trpc/server";
import type { User, ServiceContext } from "@carebridge/shared-types";
import { z } from "zod";
import { getDb } from "@carebridge/db-schema";
import { notifications } from "@carebridge/db-schema";
import { eq, and, desc } from "drizzle-orm";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// tRPC instance with gateway context
// ---------------------------------------------------------------------------

const t = initTRPC.context<ServiceContext>().create();

// ---------------------------------------------------------------------------
// Procedure builders with RBAC
// ---------------------------------------------------------------------------
const CLINICAL_WRITER_ROLES: User["role"][] = ["admin", "physician", "specialist", "nurse"];

const authed = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required." });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const requireClinicalWrite = t.middleware(({ ctx, next }) => {
  if (!ctx.user || !CLINICAL_WRITER_ROLES.includes(ctx.user.role)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Clinical data modifications require a clinical staff role.",
    });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(authed);
const clinicalWriteProcedure = t.procedure.use(authed).use(requireClinicalWrite);

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
export const notificationsRouter = t.router({
  getByUser: protectedProcedure
    .input(z.object({ userId: z.string(), unreadOnly: z.boolean().optional() }))
    .query(async ({ ctx, input }) => {
      // Users can only view their own notifications
      if (ctx.user.id !== input.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only view your own notifications.",
        });
      }
      const db = getDb();
      const conditions = [eq(notifications.user_id, input.userId)];
      if (input.unreadOnly) conditions.push(eq(notifications.is_read, false));
      return db.select().from(notifications)
        .where(and(...conditions))
        .orderBy(desc(notifications.created_at))
        .limit(50);
    }),

  markRead: protectedProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify the notification belongs to the requesting user
      const db = getDb();
      const [existing] = await db.select().from(notifications).where(eq(notifications.id, input.id));
      if (existing && existing.user_id !== ctx.user.id) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can only mark your own notifications as read.",
        });
      }
      await db.update(notifications)
        .set({ is_read: true, read_at: new Date().toISOString() })
        .where(eq(notifications.id, input.id));
      return { success: true };
    }),

  create: clinicalWriteProcedure
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

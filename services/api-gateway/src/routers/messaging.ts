/**
 * RBAC-enforced messaging router.
 *
 * Wraps the messaging service procedures with authentication and
 * authorization. userId is derived from ctx.user.id, never from client input.
 * Conversation access is verified via participant membership.
 */

import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import { getDb } from "@carebridge/db-schema";
import {
  conversations,
  conversationParticipants,
  messages,
} from "@carebridge/db-schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { Queue } from "bullmq";
import {
  getRedisConnection,
  CLINICAL_EVENTS_JOB_OPTIONS,
} from "@carebridge/redis-config";
import crypto from "node:crypto";
import type { Context } from "../context.js";

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(isAuthenticated);

const connection = getRedisConnection();
const clinicalEventsQueue = new Queue("clinical-events", {
  connection,
  defaultJobOptions: CLINICAL_EVENTS_JOB_OPTIONS,
});

/** Verify the authenticated user is a participant in the conversation. */
async function assertConversationAccess(userId: string, conversationId: string): Promise<void> {
  const db = getDb();
  const [participant] = await db.select().from(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversation_id, conversationId),
        eq(conversationParticipants.user_id, userId),
      ),
    )
    .limit(1);

  if (!participant) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Access denied: not a participant in this conversation",
    });
  }
}

export const messagingRbacRouter = t.router({
  listConversations: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();
    const participantRows = await db
      .select({ conversation_id: conversationParticipants.conversation_id })
      .from(conversationParticipants)
      .where(eq(conversationParticipants.user_id, ctx.user.id));

    if (participantRows.length === 0) return [];

    const convIds = participantRows.map((r) => r.conversation_id);
    return db.select().from(conversations)
      .where(inArray(conversations.id, convIds))
      .orderBy(desc(conversations.updated_at));
  }),

  getConversation: protectedProcedure
    .input(z.object({ conversationId: z.string() }))
    .query(async ({ ctx, input }) => {
      await assertConversationAccess(ctx.user.id, input.conversationId);

      const db = getDb();
      const [conversation] = await db.select().from(conversations)
        .where(eq(conversations.id, input.conversationId));

      const participants = await db.select().from(conversationParticipants)
        .where(eq(conversationParticipants.conversation_id, input.conversationId));

      return { ...conversation, participants };
    }),

  createConversation: protectedProcedure
    .input(z.object({
      patientId: z.string(),
      subject: z.string(),
      participantIds: z.array(z.string()),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const now = new Date().toISOString();
      const conversationId = crypto.randomUUID();

      await db.insert(conversations).values({
        id: conversationId,
        patient_id: input.patientId,
        subject: input.subject,
        status: "open",
        created_by: ctx.user.id,
        created_at: now,
        updated_at: now,
      });

      const allParticipantIds = new Set([ctx.user.id, ...input.participantIds]);
      for (const userId of allParticipantIds) {
        await db.insert(conversationParticipants).values({
          id: crypto.randomUUID(),
          conversation_id: conversationId,
          user_id: userId,
          role: userId === ctx.user.id
            ? (ctx.user.role === "patient" ? "patient" : "provider")
            : "provider",
          joined_at: now,
        });
      }

      return { id: conversationId };
    }),

  listMessages: protectedProcedure
    .input(z.object({
      conversationId: z.string(),
      limit: z.number().optional().default(50),
    }))
    .query(async ({ ctx, input }) => {
      await assertConversationAccess(ctx.user.id, input.conversationId);

      const db = getDb();
      return db.select().from(messages)
        .where(eq(messages.conversation_id, input.conversationId))
        .orderBy(desc(messages.created_at))
        .limit(input.limit);
    }),

  sendMessage: protectedProcedure
    .input(z.object({
      conversationId: z.string(),
      body: z.string().min(1),
      messageType: z.enum(["text", "refill_request", "appointment_request"]).optional().default("text"),
    }))
    .mutation(async ({ ctx, input }) => {
      await assertConversationAccess(ctx.user.id, input.conversationId);

      const db = getDb();
      const now = new Date().toISOString();
      const messageId = crypto.randomUUID();

      await db.insert(messages).values({
        id: messageId,
        conversation_id: input.conversationId,
        sender_id: ctx.user.id,
        body: input.body,
        message_type: input.messageType,
        read_by: [ctx.user.id],
        created_at: now,
      });

      await db.update(conversations)
        .set({ updated_at: now })
        .where(eq(conversations.id, input.conversationId));

      // Emit event for AI oversight if sender is a patient
      if (ctx.user.role === "patient") {
        const [conversation] = await db.select().from(conversations)
          .where(eq(conversations.id, input.conversationId));

        if (conversation) {
          await clinicalEventsQueue.add("message.received", {
            id: crypto.randomUUID(),
            type: "message.received",
            patient_id: conversation.patient_id,
            data: {
              message_id: messageId,
              conversation_id: input.conversationId,
              sender_role: "patient",
              message_type: input.messageType,
            },
            timestamp: now,
          });
        }
      }

      return { id: messageId };
    }),

  markRead: protectedProcedure
    .input(z.object({ messageId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const [message] = await db.select().from(messages)
        .where(eq(messages.id, input.messageId));

      if (!message) return { success: false };

      // Verify access via conversation
      await assertConversationAccess(ctx.user.id, message.conversation_id);

      const readBy = (message.read_by ?? []) as string[];
      if (!readBy.includes(ctx.user.id)) {
        readBy.push(ctx.user.id);
        await db.update(messages)
          .set({ read_by: readBy })
          .where(eq(messages.id, input.messageId));
      }

      return { success: true };
    }),
});

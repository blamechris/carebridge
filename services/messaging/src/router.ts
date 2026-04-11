/**
 * Secure messaging tRPC router.
 *
 * Provides CRUD for conversations and messages between patients and their
 * care team. Message bodies are encrypted at rest via Drizzle custom type.
 * All message access is audit-logged at the gateway level.
 */

import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getDb } from "@carebridge/db-schema";
import {
  conversations,
  conversationParticipants,
  messages,
} from "@carebridge/db-schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { Queue } from "bullmq";
import { getRedisConnection } from "@carebridge/redis-config";
import crypto from "node:crypto";

const t = initTRPC.create();

const connection = getRedisConnection();

const clinicalEventsQueue = new Queue("clinical-events", {
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 10000 },
  },
});

export const messagingRouter = t.router({
  /** List conversations for a user (patient sees their own, providers see assigned patients). */
  listConversations: t.procedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();

      // Find conversations where this user is a participant
      const participantRows = await db
        .select({ conversation_id: conversationParticipants.conversation_id })
        .from(conversationParticipants)
        .where(eq(conversationParticipants.user_id, input.userId));

      if (participantRows.length === 0) return [];

      const convIds = participantRows.map((r) => r.conversation_id);

      const convos = await db
        .select()
        .from(conversations)
        .where(inArray(conversations.id, convIds))
        .orderBy(desc(conversations.updated_at));

      return convos;
    }),

  /** Get a single conversation with its participants. */
  getConversation: t.procedure
    .input(z.object({ conversationId: z.string(), userId: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();

      // Verify user is a participant
      const participant = await db
        .select()
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversation_id, input.conversationId),
            eq(conversationParticipants.user_id, input.userId),
          ),
        )
        .limit(1);

      if (participant.length === 0) {
        throw new Error("Access denied: user is not a participant in this conversation");
      }

      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId));

      const participants = await db
        .select()
        .from(conversationParticipants)
        .where(eq(conversationParticipants.conversation_id, input.conversationId));

      return { ...conversation, participants };
    }),

  /** Create a new conversation. */
  createConversation: t.procedure
    .input(z.object({
      patientId: z.string(),
      subject: z.string(),
      createdBy: z.string(),
      participantIds: z.array(z.string()),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const now = new Date().toISOString();
      const conversationId = crypto.randomUUID();

      await db.insert(conversations).values({
        id: conversationId,
        patient_id: input.patientId,
        subject: input.subject,
        status: "open",
        created_by: input.createdBy,
        created_at: now,
        updated_at: now,
      });

      // Add all participants
      const allParticipantIds = new Set([input.createdBy, ...input.participantIds]);
      for (const userId of allParticipantIds) {
        await db.insert(conversationParticipants).values({
          id: crypto.randomUUID(),
          conversation_id: conversationId,
          user_id: userId,
          role: userId === input.createdBy ? "patient" : "provider",
          joined_at: now,
        });
      }

      return { id: conversationId };
    }),

  /** List messages in a conversation. */
  listMessages: t.procedure
    .input(z.object({
      conversationId: z.string(),
      userId: z.string(),
      limit: z.number().optional().default(50),
    }))
    .query(async ({ input }) => {
      const db = getDb();

      // Verify user is a participant
      const participant = await db
        .select()
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversation_id, input.conversationId),
            eq(conversationParticipants.user_id, input.userId),
          ),
        )
        .limit(1);

      if (participant.length === 0) {
        throw new Error("Access denied: user is not a participant in this conversation");
      }

      return db
        .select()
        .from(messages)
        .where(eq(messages.conversation_id, input.conversationId))
        .orderBy(desc(messages.created_at))
        .limit(input.limit);
    }),

  /** Send a message in a conversation. */
  sendMessage: t.procedure
    .input(z.object({
      conversationId: z.string(),
      senderId: z.string(),
      body: z.string().min(1),
      messageType: z.enum(["text", "refill_request", "appointment_request"]).optional().default("text"),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const now = new Date().toISOString();
      const messageId = crypto.randomUUID();

      // Verify sender is a participant
      const participant = await db
        .select()
        .from(conversationParticipants)
        .where(
          and(
            eq(conversationParticipants.conversation_id, input.conversationId),
            eq(conversationParticipants.user_id, input.senderId),
          ),
        )
        .limit(1);

      if (participant.length === 0) {
        throw new Error("Access denied: user is not a participant in this conversation");
      }

      await db.insert(messages).values({
        id: messageId,
        conversation_id: input.conversationId,
        sender_id: input.senderId,
        body: input.body,
        message_type: input.messageType,
        read_by: [input.senderId], // Sender has read their own message
        created_at: now,
      });

      // Update conversation timestamp
      await db
        .update(conversations)
        .set({ updated_at: now })
        .where(eq(conversations.id, input.conversationId));

      // Emit message.received event to clinical-events queue for AI oversight
      // Get the conversation to find the patient_id
      const [conversation] = await db
        .select()
        .from(conversations)
        .where(eq(conversations.id, input.conversationId));

      if (conversation && participant[0].role === "patient") {
        await clinicalEventsQueue.add("message.received", {
          id: crypto.randomUUID(),
          type: "message.received",
          patient_id: conversation.patient_id,
          provider_id: undefined,
          data: {
            message_id: messageId,
            conversation_id: input.conversationId,
            sender_role: "patient",
            message_type: input.messageType,
            // Don't include body in event — AI oversight reads it from DB with proper decryption
          },
          timestamp: now,
        });
      }

      return { id: messageId };
    }),

  /** Mark a message as read by a user. */
  markRead: t.procedure
    .input(z.object({
      messageId: z.string(),
      userId: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();

      const [message] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, input.messageId));

      if (!message) return { success: false };

      const readBy = (message.read_by ?? []) as string[];
      if (!readBy.includes(input.userId)) {
        readBy.push(input.userId);
        await db
          .update(messages)
          .set({ read_by: readBy })
          .where(eq(messages.id, input.messageId));
      }

      return { success: true };
    }),
});

export type MessagingRouter = typeof messagingRouter;

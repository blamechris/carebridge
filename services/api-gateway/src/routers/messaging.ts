/**
 * RBAC-enforced messaging router.
 *
 * Wraps the messaging service procedures with authentication and
 * authorization. userId is derived from ctx.user.id, never from client input.
 *
 * Access model (two paths; first match wins):
 *  1. Participant path (clinicians + patients): the caller is a direct
 *     member of `conversation_participants`. This is the pre-existing
 *     model — care-team clinicians and the patient themselves are always
 *     explicit participants.
 *  2. Delegated-caregiver path (family_caregiver role, issue #909): the
 *     caller is not a participant but holds an active family_relationships
 *     row linking them to the conversation's patient_id, AND that row
 *     grants the `view_and_message` scope. This is the delegation grant
 *     defined by the resource→scope mapping in #896 — messaging requires
 *     the superset scope so caregivers only gain message visibility when
 *     explicitly opted-in.
 *
 * Write-side policy (HIPAA minimum-necessary):
 *  Caregivers are role-level BLOCKED from sendMessage and createConversation.
 *  The clinical value of the message log depends on authorship provenance
 *  (the patient is the first-person reporter), so caregivers read but never
 *  post on behalf of the patient. Mirrors the observations.create block.
 */

import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import { getDb } from "@carebridge/db-schema";
import {
  conversations,
  conversationParticipants,
  messages,
  familyRelationships,
  users,
} from "@carebridge/db-schema";
import { eq, and, desc, inArray } from "drizzle-orm";
import { Queue } from "bullmq";
import {
  getRedisConnection,
  CLINICAL_EVENTS_JOB_OPTIONS,
} from "@carebridge/redis-config";
import {
  hasScope,
  normaliseScopes,
  type ScopeToken,
} from "@carebridge/shared-types";
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

/** Scope required for a caregiver to access a patient's messaging resources. */
const MESSAGING_REQUIRED_SCOPE: ScopeToken = "view_and_message";

/** Verify the authenticated user is a direct participant in the conversation. */
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

/**
 * Resolve the active family_relationships row linking a caregiver to the
 * given patient record (by `patients.id`). Returns the access_scopes array
 * so callers can run their own `hasScope` check with a role-specific scope
 * requirement. `family_relationships.patient_id` references `users.id`, so
 * we close the mapping through `users.patient_id`.
 */
async function findActiveFamilyRelationship(
  caregiverUserId: string,
  patientRecordId: string,
): Promise<{ id: string; access_scopes: ScopeToken[] | null } | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: familyRelationships.id,
      access_scopes: familyRelationships.access_scopes,
    })
    .from(familyRelationships)
    .innerJoin(users, eq(users.id, familyRelationships.patient_id))
    .where(
      and(
        eq(familyRelationships.caregiver_id, caregiverUserId),
        eq(users.patient_id, patientRecordId),
        eq(familyRelationships.status, "active"),
      ),
    )
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    access_scopes: (row.access_scopes ?? null) as ScopeToken[] | null,
  };
}

/**
 * Enforce caregiver scope on a messaging resource. Loads the conversation
 * to resolve the target patient, then requires an active family link with
 * `view_and_message`. Throws FORBIDDEN on any denial. Error messages name
 * the missing scope but never leak patient identifiers.
 */
async function assertCaregiverMessagingScope(
  caregiverUserId: string,
  conversationId: string,
): Promise<void> {
  const db = getDb();
  const [conversation] = await db
    .select({ id: conversations.id, patient_id: conversations.patient_id })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .limit(1);

  if (!conversation) {
    // Default-deny: treat a missing conversation as access denied rather
    // than a 404 so enumeration probes can't distinguish "does not exist"
    // from "you cannot see it".
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Access denied: conversation not found or not accessible",
    });
  }

  const relationship = await findActiveFamilyRelationship(
    caregiverUserId,
    conversation.patient_id,
  );
  if (!relationship) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message:
        "Access denied: no active family relationship grants access to this patient",
    });
  }

  if (!hasScope(normaliseScopes(relationship.access_scopes), MESSAGING_REQUIRED_SCOPE)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Access denied: caregiver lacks ${MESSAGING_REQUIRED_SCOPE} scope`,
    });
  }
}

/**
 * Unified access check for messaging reads. Caregivers go through the
 * delegated-scope path; every other role uses the existing participant
 * check (unchanged regression behaviour).
 */
async function assertMessagingReadAccess(
  user: NonNullable<Context["user"]>,
  conversationId: string,
): Promise<void> {
  if (user.role === "family_caregiver") {
    await assertCaregiverMessagingScope(user.id, conversationId);
    return;
  }
  await assertConversationAccess(user.id, conversationId);
}

export const messagingRbacRouter = t.router({
  listConversations: protectedProcedure.query(async ({ ctx }) => {
    const db = getDb();

    // Caregivers aren't participants in the patient's conversations, so the
    // participant lookup used below would return []. Instead, enumerate the
    // patients they hold `view_and_message` on and return every conversation
    // for those patients. Filtering happens in-DB on access_scopes so the
    // naïve list is never materialised.
    if (ctx.user.role === "family_caregiver") {
      const rels = await db
        .select({
          patient_user_id: familyRelationships.patient_id,
          access_scopes: familyRelationships.access_scopes,
        })
        .from(familyRelationships)
        .where(
          and(
            eq(familyRelationships.caregiver_id, ctx.user.id),
            eq(familyRelationships.status, "active"),
          ),
        );

      // Apply `hasScope` in-memory so the same normalisation (null/empty
      // array -> default) used by read procedures is used here — keeping
      // "what the list shows" consistent with "what a getById would allow".
      const authorisedUserIds = rels
        .filter((r) =>
          hasScope(
            normaliseScopes((r.access_scopes ?? null) as ScopeToken[] | null),
            MESSAGING_REQUIRED_SCOPE,
          ),
        )
        .map((r) => r.patient_user_id);

      if (authorisedUserIds.length === 0) return [];

      const userRows = await db
        .select({ id: users.id, patient_id: users.patient_id })
        .from(users)
        .where(inArray(users.id, authorisedUserIds));
      const patientRecordIds = userRows
        .map((u) => u.patient_id)
        .filter((id): id is string => Boolean(id));
      if (patientRecordIds.length === 0) return [];

      return db
        .select()
        .from(conversations)
        .where(inArray(conversations.patient_id, patientRecordIds))
        .orderBy(desc(conversations.updated_at));
    }

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
      await assertMessagingReadAccess(ctx.user, input.conversationId);

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
      // HIPAA write-side block: caregivers read messages but never initiate
      // conversations on behalf of the patient. See module jsdoc.
      if (ctx.user.role === "family_caregiver") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Family caregivers cannot create conversations on behalf of a patient",
        });
      }

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
      await assertMessagingReadAccess(ctx.user, input.conversationId);

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
      // HIPAA write-side block: caregivers are read-only for messaging even
      // when their scope grants `view_and_message`. Authorship provenance
      // matters clinically — the patient is the first-person reporter and
      // the UI surfaces the sender identity as such. See module jsdoc.
      if (ctx.user.role === "family_caregiver") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message:
            "Family caregivers cannot send messages on behalf of a patient",
        });
      }

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

      // Verify access via conversation — caregivers go through the scope
      // path, everyone else through the existing participant path.
      await assertMessagingReadAccess(ctx.user, message.conversation_id);

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

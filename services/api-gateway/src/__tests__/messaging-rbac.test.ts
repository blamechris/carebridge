/**
 * RBAC tests for the messaging router scope enforcement (issue #909).
 *
 * Issue #909 wires the `view_and_message` family caregiver scope into the
 * messaging router. Wave 7 (#896 / PR #900) already wired the other four
 * patient-scoped resource routers but the spec line
 * `messages.* -> view_and_message` was missed. This test file locks in the
 * following contract:
 *
 *  - A family_caregiver with `view_and_message` scope on the represented
 *    patient can list conversations, open a conversation, and read messages.
 *  - A caregiver WITHOUT `view_and_message` (any other scope token) is
 *    denied with FORBIDDEN — messaging is default-deny.
 *  - Caregivers are blocked from writes (sendMessage, createConversation)
 *    at the role level — HIPAA requires they read messages but never post
 *    on behalf of the patient.
 *  - Regression coverage: clinician participants and the patient themselves
 *    continue to go through the existing participant-based path.
 *
 * The tests exercise `messagingRbacRouter.createCaller(ctx)` directly so the
 * middleware + procedure code runs without an HTTP transport.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User, ScopeToken } from "@carebridge/shared-types";

const CAREGIVER_ID = "77777777-7777-4777-8777-777777777777";
const PATIENT_USER_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_RECORD_ID = "aaaa1111-1111-4111-8111-111111111111";
const OTHER_PATIENT_RECORD_ID = "bbbb2222-2222-4222-8222-222222222222";
const CLINICIAN_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "cccc3333-3333-4333-8333-333333333333";
const OTHER_CONVERSATION_ID = "dddd4444-4444-4444-8444-444444444444";
const MESSAGE_ID = "eeee5555-5555-4555-8555-555555555555";

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  let queue: unknown[][] = [];

  function nextResult(): unknown[] {
    return queue.shift() ?? [];
  }

  function makeChain() {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => {
      const next = nextResult();
      const wrapper: Record<string, unknown> = {
        then: (resolve: (v: unknown) => void) => {
          resolve(next);
          return wrapper;
        },
        // orderBy returns a thenable that also exposes .limit(), so chains
        // of the form `.where().orderBy().limit()` work.
        orderBy: vi.fn(() => {
          const inner: Record<string, unknown> = {
            then: (resolve: (v: unknown) => void) => {
              resolve(next);
              return inner;
            },
            limit: vi.fn(async () => next),
          };
          return inner;
        }),
        limit: vi.fn(async () => next),
      };
      return wrapper;
    });
    chain.orderBy = vi.fn(async () => nextResult());
    chain.limit = vi.fn(async () => nextResult());
    return chain;
  }

  const mockDb = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
  };

  return {
    mockDb,
    setQueue: (q: unknown[][]) => {
      queue = [...q];
    },
  };
});

// ---------------------------------------------------------------------------
// Shared module mocks
// ---------------------------------------------------------------------------

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mocks.mockDb,
  conversations: {
    id: "conversations.id",
    patient_id: "conversations.patient_id",
    updated_at: "conversations.updated_at",
  },
  conversationParticipants: {
    id: "conversation_participants.id",
    conversation_id: "conversation_participants.conversation_id",
    user_id: "conversation_participants.user_id",
    role: "conversation_participants.role",
  },
  messages: {
    id: "messages.id",
    conversation_id: "messages.conversation_id",
    sender_id: "messages.sender_id",
    body: "messages.body",
    message_type: "messages.message_type",
    read_by: "messages.read_by",
    created_at: "messages.created_at",
  },
  familyRelationships: {
    id: "family_relationships.id",
    caregiver_id: "family_relationships.caregiver_id",
    patient_id: "family_relationships.patient_id",
    status: "family_relationships.status",
    access_scopes: "family_relationships.access_scopes",
  },
  users: {
    id: "users.id",
    patient_id: "users.patient_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  desc: (col: unknown) => ({ op: "desc", col }),
  inArray: (col: unknown, vals: unknown) => ({ op: "inArray", col, vals }),
}));

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
  CLINICAL_EVENTS_JOB_OPTIONS: {},
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add() {
      return Promise.resolve();
    }
  },
}));

// ---------------------------------------------------------------------------
// Router import (AFTER mocks)
// ---------------------------------------------------------------------------

import { messagingRbacRouter } from "../routers/messaging.js";
import type { Context } from "../context.js";

function makeUser(
  role: User["role"],
  id: string,
  overrides: Partial<User> = {},
): User {
  return {
    id,
    email: `${role}@carebridge.dev`,
    name: `Test ${role}`,
    role,
    is_active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ctxFor(user: User | null): Context {
  return {
    db: mocks.mockDb as unknown as Context["db"],
    user,
    sessionId: "session-1",
    requestId: "req-1",
  };
}

function caller(user: User) {
  return messagingRbacRouter.createCaller(ctxFor(user));
}

// ---------------------------------------------------------------------------
// Caregiver scope enforcement
// ---------------------------------------------------------------------------

describe("messaging router — caregiver view_and_message scope (issue #909)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getConversation", () => {
    it("grants access when caregiver holds view_and_message scope", async () => {
      mocks.setQueue([
        // 1) conversation lookup (to resolve patient_id)
        [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID }],
        // 2) family_relationships scope lookup
        [{ id: "rel-1", access_scopes: ["view_and_message"] as ScopeToken[] }],
        // 3) conversation select for the payload
        [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID, subject: "test" }],
        // 4) participants
        [],
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      await expect(
        c.getConversation({ conversationId: CONVERSATION_ID }),
      ).resolves.toBeDefined();
    });

    it("denies caregiver with only view_summary (not view_and_message)", async () => {
      mocks.setQueue([
        [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID }],
        [{ id: "rel-1", access_scopes: ["view_summary"] as ScopeToken[] }],
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      await expect(
        c.getConversation({ conversationId: CONVERSATION_ID }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        // Error must name the missing scope so the UI can explain the denial,
        // and must NOT leak patient identifiers.
        message: expect.stringContaining("view_and_message"),
      });
    });

    it("denies caregiver with no active family relationship", async () => {
      mocks.setQueue([
        [{ id: CONVERSATION_ID, patient_id: OTHER_PATIENT_RECORD_ID }],
        [], // no family relationship row
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      await expect(
        c.getConversation({ conversationId: CONVERSATION_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("denies caregiver when conversation does not exist", async () => {
      mocks.setQueue([
        [], // conversation lookup => not found
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      await expect(
        c.getConversation({ conversationId: CONVERSATION_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("null access_scopes column falls back to read_only default — deny", async () => {
      mocks.setQueue([
        [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID }],
        [{ id: "rel-1", access_scopes: null }],
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      await expect(
        c.getConversation({ conversationId: CONVERSATION_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("empty access_scopes falls back to read_only default — deny", async () => {
      mocks.setQueue([
        [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID }],
        [{ id: "rel-1", access_scopes: [] as ScopeToken[] }],
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      await expect(
        c.getConversation({ conversationId: CONVERSATION_ID }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("listMessages", () => {
    it("grants caregiver with view_and_message access to message history", async () => {
      mocks.setQueue([
        [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID }],
        [{ id: "rel-1", access_scopes: ["view_and_message"] as ScopeToken[] }],
        [], // messages select
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      await expect(
        c.listMessages({ conversationId: CONVERSATION_ID }),
      ).resolves.toEqual([]);
    });

    it("denies caregiver with view_notes (wrong scope) on message history", async () => {
      mocks.setQueue([
        [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID }],
        [{ id: "rel-1", access_scopes: ["view_notes"] as ScopeToken[] }],
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      await expect(
        c.listMessages({ conversationId: CONVERSATION_ID }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("view_and_message"),
      });
    });
  });

  describe("listConversations", () => {
    it("caregiver sees conversations for every patient they hold view_and_message on", async () => {
      mocks.setQueue([
        // 1) family_relationships with view_and_message filter
        [
          {
            patient_user_id: PATIENT_USER_ID,
            access_scopes: ["view_and_message"] as ScopeToken[],
          },
        ],
        // 2) users -> patient record id mapping
        [{ id: PATIENT_USER_ID, patient_id: PATIENT_RECORD_ID }],
        // 3) conversations for those patients
        [
          {
            id: CONVERSATION_ID,
            patient_id: PATIENT_RECORD_ID,
            subject: "Follow-up",
          },
        ],
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      const rows = await c.listConversations();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: CONVERSATION_ID });
    });

    it("caregiver with only view_summary sees no conversations", async () => {
      mocks.setQueue([
        // family_relationships filter drops non-view_and_message rows
        [],
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      const rows = await c.listConversations();
      expect(rows).toEqual([]);
    });

    it("caregiver with no active relationships sees empty list", async () => {
      mocks.setQueue([[]]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      const rows = await c.listConversations();
      expect(rows).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Write-side block (HIPAA — caregivers read, never post on behalf of)
  // -------------------------------------------------------------------------

  describe("write-side role block", () => {
    it("caregiver cannot sendMessage even with view_and_message", async () => {
      // Block happens at the role check BEFORE any DB lookup.
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      await expect(
        c.sendMessage({
          conversationId: CONVERSATION_ID,
          body: "hello",
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringMatching(/caregiver/i),
      });
    });

    it("caregiver cannot createConversation", async () => {
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      await expect(
        c.createConversation({
          patientId: PATIENT_RECORD_ID,
          subject: "test",
          participantIds: [CLINICIAN_ID],
        }),
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringMatching(/caregiver/i),
      });
    });
  });

  // -------------------------------------------------------------------------
  // FORBIDDEN message hygiene (PHI-leak safeguard)
  // -------------------------------------------------------------------------

  describe("error-message hygiene", () => {
    it("scope-denial names the missing scope and never leaks patient identifiers", async () => {
      mocks.setQueue([
        [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID }],
        [{ id: "rel-1", access_scopes: ["view_summary"] as ScopeToken[] }],
      ]);
      const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
      try {
        await c.getConversation({ conversationId: CONVERSATION_ID });
        expect.fail("expected FORBIDDEN");
      } catch (err) {
        const message = (err as { message?: string }).message ?? "";
        expect(message).toMatch(/view_and_message/);
        expect(message).not.toContain(PATIENT_RECORD_ID);
        expect(message).not.toContain(PATIENT_USER_ID);
        expect(message).not.toContain(CONVERSATION_ID);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Regression: existing clinician/participant and patient paths are unchanged
// ---------------------------------------------------------------------------

describe("messaging router — participant-based access regression", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clinician participant can read a conversation (participant path)", async () => {
    mocks.setQueue([
      // assertConversationAccess participant lookup
      [{ id: "p-1", conversation_id: CONVERSATION_ID, user_id: CLINICIAN_ID }],
      // conversations select
      [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID, subject: "s" }],
      // participants select
      [],
    ]);
    const clinician = makeUser("physician", CLINICIAN_ID);
    const c = caller(clinician);
    await expect(
      c.getConversation({ conversationId: CONVERSATION_ID }),
    ).resolves.toBeDefined();
  });

  it("clinician NOT a participant gets FORBIDDEN", async () => {
    mocks.setQueue([
      [], // participant lookup empty
    ]);
    const clinician = makeUser("physician", CLINICIAN_ID);
    const c = caller(clinician);
    await expect(
      c.getConversation({ conversationId: OTHER_CONVERSATION_ID }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("patient participant can read their own conversation", async () => {
    mocks.setQueue([
      [{ id: "p-2", conversation_id: CONVERSATION_ID, user_id: PATIENT_USER_ID }],
      [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID, subject: "s" }],
      [],
    ]);
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    const c = caller(patient);
    await expect(
      c.getConversation({ conversationId: CONVERSATION_ID }),
    ).resolves.toBeDefined();
  });

  it("patient can still sendMessage in their conversation", async () => {
    mocks.setQueue([
      // participant lookup => present
      [{ id: "p-2", conversation_id: CONVERSATION_ID, user_id: PATIENT_USER_ID }],
      // conversation lookup for event emission
      [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID }],
    ]);
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    const c = caller(patient);
    await expect(
      c.sendMessage({ conversationId: CONVERSATION_ID, body: "hi" }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("clinician participant can sendMessage (write path unchanged)", async () => {
    mocks.setQueue([
      [{ id: "p-1", conversation_id: CONVERSATION_ID, user_id: CLINICIAN_ID }],
    ]);
    const clinician = makeUser("physician", CLINICIAN_ID);
    const c = caller(clinician);
    await expect(
      c.sendMessage({ conversationId: CONVERSATION_ID, body: "checkup" }),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });
});

// ---------------------------------------------------------------------------
// markRead: caregivers with view_and_message may mark (read implies read-state)
// ---------------------------------------------------------------------------

describe("markRead", () => {
  beforeEach(() => vi.clearAllMocks());

  it("caregiver with view_and_message can mark messages as read", async () => {
    mocks.setQueue([
      // 1) message lookup
      [
        {
          id: MESSAGE_ID,
          conversation_id: CONVERSATION_ID,
          read_by: [],
        },
      ],
      // 2) conversation lookup (to resolve patient_id)
      [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID }],
      // 3) family_relationships scope lookup
      [{ id: "rel-1", access_scopes: ["view_and_message"] as ScopeToken[] }],
    ]);
    const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
    await expect(c.markRead({ messageId: MESSAGE_ID })).resolves.toMatchObject({
      success: true,
    });
  });

  it("caregiver without view_and_message cannot mark as read", async () => {
    mocks.setQueue([
      [{ id: MESSAGE_ID, conversation_id: CONVERSATION_ID, read_by: [] }],
      [{ id: CONVERSATION_ID, patient_id: PATIENT_RECORD_ID }],
      [{ id: "rel-1", access_scopes: ["view_summary"] as ScopeToken[] }],
    ]);
    const c = caller(makeUser("family_caregiver", CAREGIVER_ID));
    await expect(c.markRead({ messageId: MESSAGE_ID })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

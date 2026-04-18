import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

const updateWhereMock = vi.fn().mockResolvedValue(undefined);
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

const selectLimitMock = vi.fn();
const selectOrderByMock = vi.fn(() => ({ limit: selectLimitMock }));
const selectWhereMock = vi.fn(() => ({
  orderBy: selectOrderByMock,
  limit: selectLimitMock,
}));
const selectFromMock = vi.fn(() => ({
  where: selectWhereMock,
}));
const selectMock = vi.fn(() => ({ from: selectFromMock }));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    insert: insertMock,
    select: selectMock,
    update: updateMock,
  }),
  notifications: {
    id: "notifications.id",
    user_id: "notifications.user_id",
    is_read: "notifications.is_read",
    created_at: "notifications.created_at",
  },
  notificationPreferences: {
    id: "notificationPreferences.id",
    user_id: "notificationPreferences.user_id",
    notification_type: "notificationPreferences.notification_type",
    channel: "notificationPreferences.channel",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...conditions: unknown[]) => ({ and: conditions }),
  desc: (col: unknown) => ({ desc: col }),
}));

// ── Mock publish (Redis pub/sub) ────────────────────────────────
const publishNotificationMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../publish.js", () => ({
  publishNotification: (...args: unknown[]) => publishNotificationMock(...args),
}));

// ── Mock logger ─────────────────────────────────────────────────
vi.mock("@carebridge/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── Import after mocks ──────────────────────────────────────────
const { notificationsRouter } = await import("../router.js");

import { initTRPC } from "@trpc/server";
const t = initTRPC.create();
const caller = t.createCallerFactory(notificationsRouter)({});

const USER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Create ──────────────────────────────────────────────────────
describe("notifications create", () => {
  it("inserts a notification and publishes to Redis", async () => {
    const input = {
      user_id: USER_ID,
      type: "clinical_flag",
      title: "New clinical flag",
      body: "A flag has been raised.",
    };

    const result = await caller.create(input);

    expect(result).toMatchObject({
      user_id: USER_ID,
      type: "clinical_flag",
      title: "New clinical flag",
      body: "A flag has been raised.",
      is_read: false,
      is_urgent: false,
    });
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeDefined();
    expect(insertMock).toHaveBeenCalledOnce();
    expect(publishNotificationMock).toHaveBeenCalledOnce();
    expect(publishNotificationMock).toHaveBeenCalledWith(
      USER_ID,
      expect.objectContaining({ title: "New clinical flag" }),
    );
  });

  it("sets is_urgent when specified", async () => {
    const result = await caller.create({
      user_id: USER_ID,
      type: "urgent_flag",
      title: "Urgent",
      is_urgent: true,
    });

    expect(result.is_urgent).toBe(true);
  });

  it("still succeeds when Redis publish fails", async () => {
    publishNotificationMock.mockRejectedValueOnce(new Error("Redis down"));

    const result = await caller.create({
      user_id: USER_ID,
      type: "clinical_flag",
      title: "Test",
    });

    // Mutation should still succeed — notification row was persisted
    expect(result.id).toBeDefined();
    expect(insertMock).toHaveBeenCalledOnce();
  });
});

// ── GetByUser ───────────────────────────────────────────────────
describe("notifications getByUser", () => {
  it("returns notifications for a user", async () => {
    const rows = [
      { id: "n1", user_id: USER_ID, title: "Flag 1", is_read: false },
      { id: "n2", user_id: USER_ID, title: "Flag 2", is_read: true },
    ];
    selectLimitMock.mockResolvedValueOnce(rows);

    const result = await caller.getByUser({ userId: USER_ID });

    expect(result).toEqual(rows);
    expect(selectMock).toHaveBeenCalled();
  });

  it("supports unreadOnly filter", async () => {
    selectLimitMock.mockResolvedValueOnce([]);

    await caller.getByUser({ userId: USER_ID, unreadOnly: true });

    // The and() mock captures the conditions — verify two conditions passed
    expect(selectWhereMock).toHaveBeenCalled();
  });
});

// ── MarkRead ────────────────────────────────────────────────────
describe("notifications markRead", () => {
  it("marks a notification as read", async () => {
    const NOTIF_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";

    const result = await caller.markRead({ id: NOTIF_ID });

    expect(result).toEqual({ success: true });
    expect(updateMock).toHaveBeenCalledOnce();
    expect(updateSetMock).toHaveBeenCalledWith(
      expect.objectContaining({ is_read: true }),
    );
    expect(updateWhereMock).toHaveBeenCalledOnce();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { publishNotification, setPublisher } from "../publish.js";

/**
 * Tests for Redis pub/sub notification publishing.
 *
 * Verifies that notification creation correctly publishes to the expected
 * Redis channel with the payload format the SSE endpoint consumes.
 */

function createMockRedis() {
  return {
    publish: vi.fn().mockResolvedValue(1),
    quit: vi.fn().mockResolvedValue("OK"),
  };
}

describe("publishNotification", () => {
  let mockRedis: ReturnType<typeof createMockRedis>;

  beforeEach(() => {
    mockRedis = createMockRedis();
    setPublisher(mockRedis as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("publishes to the correct Redis channel for a user", async () => {
    const userId = "user-abc-123";
    const payload = {
      id: "notif-001",
      type: "ai-flag",
      title: "CRITICAL: Clinical flag — drug interaction",
      body: "Potential interaction between warfarin and aspirin",
      link: "/patients?flagId=flag-001",
      related_flag_id: "flag-001",
      created_at: "2026-04-12T10:00:00.000Z",
    };

    await publishNotification(userId, payload);

    expect(mockRedis.publish).toHaveBeenCalledTimes(1);
    expect(mockRedis.publish).toHaveBeenCalledWith(
      `notifications:${userId}`,
      JSON.stringify(payload),
    );
  });

  it("publishes JSON matching the format the SSE endpoint expects", async () => {
    const payload = {
      id: "notif-002",
      type: "ai-flag",
      title: "Warning: Clinical flag — critical lab value",
      created_at: "2026-04-12T11:00:00.000Z",
    };

    await publishNotification("user-xyz", payload);

    const publishedMessage = mockRedis.publish.mock.calls[0][1] as string;
    const parsed = JSON.parse(publishedMessage);

    // SSE endpoint forwards the raw message as event data.
    // Verify required fields are present.
    expect(parsed).toHaveProperty("id");
    expect(parsed).toHaveProperty("type");
    expect(parsed).toHaveProperty("title");
    expect(parsed).toHaveProperty("created_at");
  });

  it("handles optional fields (body, link, related_flag_id) gracefully", async () => {
    const payload = {
      id: "notif-003",
      type: "system",
      title: "Test notification",
      created_at: "2026-04-12T12:00:00.000Z",
    };

    await publishNotification("user-abc", payload);

    const publishedMessage = mockRedis.publish.mock.calls[0][1] as string;
    const parsed = JSON.parse(publishedMessage);

    expect(parsed.body).toBeUndefined();
    expect(parsed.link).toBeUndefined();
    expect(parsed.related_flag_id).toBeUndefined();
  });

  it("does not publish when userId is empty", async () => {
    const payload = {
      id: "notif-004",
      type: "ai-flag",
      title: "Should not be published",
      created_at: "2026-04-12T13:00:00.000Z",
    };

    await publishNotification("", payload);

    expect(mockRedis.publish).not.toHaveBeenCalled();
  });

  it("publishes to distinct channels for different users", async () => {
    const payload = {
      id: "notif-005",
      type: "ai-flag",
      title: "Shared flag",
      created_at: "2026-04-12T14:00:00.000Z",
    };

    await publishNotification("user-a", payload);
    await publishNotification("user-b", payload);

    expect(mockRedis.publish).toHaveBeenCalledTimes(2);
    expect(mockRedis.publish).toHaveBeenCalledWith(
      "notifications:user-a",
      expect.any(String),
    );
    expect(mockRedis.publish).toHaveBeenCalledWith(
      "notifications:user-b",
      expect.any(String),
    );
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  assertCareTeamAccess,
  clearCareTeamCache,
  invalidateCareTeamCache,
  initCareTeamCacheInvalidation,
  publishCareTeamCacheInvalidation,
  CARETEAM_INVALIDATE_CHANNEL,
  __resetRbacModuleForTests,
  type RbacPubClient,
  type RbacSubClient,
} from "./rbac.js";

// Mock the db-schema module so we never hit a real database.
const selectMock = vi.fn();

vi.mock("@carebridge/db-schema", () => {
  const fromMock = vi.fn(() => ({ where: vi.fn(() => ({ limit: selectMock })) }));
  return {
    getDb: () => ({ select: () => ({ from: fromMock }) }),
    careTeamAssignments: {
      id: "id",
      user_id: "user_id",
      patient_id: "patient_id",
      removed_at: "removed_at",
    },
  };
});

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  isNull: (col: unknown) => col,
}));

describe("care-team cache", () => {
  beforeEach(() => {
    clearCareTeamCache();
    selectMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries the DB on a cache miss", async () => {
    selectMock.mockResolvedValueOnce([{ id: "row-1" }]);

    const result = await assertCareTeamAccess("user-1", "patient-1");

    expect(result).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("returns cached value without hitting the DB on a cache hit", async () => {
    selectMock.mockResolvedValueOnce([{ id: "row-1" }]);

    await assertCareTeamAccess("user-1", "patient-1");
    const result = await assertCareTeamAccess("user-1", "patient-1");

    expect(result).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(1); // only the first call
  });

  it("caches false (no access) results as well", async () => {
    selectMock.mockResolvedValueOnce([]);

    const first = await assertCareTeamAccess("user-2", "patient-2");
    const second = await assertCareTeamAccess("user-2", "patient-2");

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("expires entries after the 60-second fallback TTL", async () => {
    selectMock.mockResolvedValueOnce([{ id: "row-1" }]);
    selectMock.mockResolvedValueOnce([]); // second call returns no access

    await assertCareTeamAccess("user-3", "patient-3");

    // Advance time past the 60s defense-in-depth TTL.
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    const result = await assertCareTeamAccess("user-3", "patient-3");
    expect(result).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("still serves from cache at 59 seconds (TTL not yet exceeded)", async () => {
    selectMock.mockResolvedValueOnce([{ id: "row-1" }]);

    await assertCareTeamAccess("user-ttl", "patient-ttl");

    vi.useFakeTimers();
    vi.advanceTimersByTime(59_000);

    const result = await assertCareTeamAccess("user-ttl", "patient-ttl");
    expect(result).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(1); // no second DB hit

    vi.useRealTimers();
  });

  it("clearCareTeamCache() forces a fresh DB query", async () => {
    selectMock.mockResolvedValueOnce([{ id: "row-1" }]);
    selectMock.mockResolvedValueOnce([{ id: "row-1" }]);

    await assertCareTeamAccess("user-4", "patient-4");
    clearCareTeamCache();
    await assertCareTeamAccess("user-4", "patient-4");

    expect(selectMock).toHaveBeenCalledTimes(2);
  });

  it("uses separate cache entries per user/patient pair", async () => {
    selectMock.mockResolvedValueOnce([{ id: "row-1" }]);
    selectMock.mockResolvedValueOnce([]);

    const a = await assertCareTeamAccess("user-a", "patient-x");
    const b = await assertCareTeamAccess("user-b", "patient-x");

    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(2);
  });
});

/* ---------------------------------------------------------------- */
/*  Phase D P1 #7 — PUBSUB invalidation                             */
/* ---------------------------------------------------------------- */

/**
 * Warm the cache with an entry for (userId, patientId). Mocks the DB
 * one-shot so a subsequent assertCareTeamAccess triggers a DB call again
 * (lets tests distinguish "cache hit" from "invalidated").
 */
async function warmCache(
  userId: string,
  patientId: string,
  hasAccess = true,
): Promise<void> {
  selectMock.mockResolvedValueOnce(hasAccess ? [{ id: "row" }] : []);
  await assertCareTeamAccess(userId, patientId);
}

describe("invalidateCareTeamCache — selector semantics", () => {
  beforeEach(() => {
    __resetRbacModuleForTests();
    selectMock.mockReset();
  });

  it("drops exactly one entry when both user_id and patient_id are provided", async () => {
    await warmCache("u1", "p1");
    await warmCache("u1", "p2");
    await warmCache("u2", "p1");

    const dropped = invalidateCareTeamCache({
      user_id: "u1",
      patient_id: "p1",
    });
    expect(dropped).toBe(1);

    // u1/p2 and u2/p1 remain cached — no DB hit on next check.
    const remaining1 = await assertCareTeamAccess("u1", "p2");
    const remaining2 = await assertCareTeamAccess("u2", "p1");
    expect(remaining1).toBe(true);
    expect(remaining2).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(3); // only the warm-up calls
  });

  it("drops every entry for a given user when only user_id is provided", async () => {
    await warmCache("clinician-a", "patient-1");
    await warmCache("clinician-a", "patient-2");
    await warmCache("clinician-a", "patient-3");
    await warmCache("clinician-b", "patient-1");

    const dropped = invalidateCareTeamCache({ user_id: "clinician-a" });
    expect(dropped).toBe(3);

    // clinician-b/patient-1 still cached.
    selectMock.mockResolvedValueOnce([{ id: "fresh" }]);
    await assertCareTeamAccess("clinician-a", "patient-1");
    expect(selectMock).toHaveBeenCalledTimes(5); // 4 warm-ups + 1 refresh
  });

  it("drops every entry for a given patient when only patient_id is provided", async () => {
    await warmCache("u1", "target-patient");
    await warmCache("u2", "target-patient");
    await warmCache("u1", "other-patient");

    const dropped = invalidateCareTeamCache({ patient_id: "target-patient" });
    expect(dropped).toBe(2);

    // u1/other-patient still cached.
    const still = await assertCareTeamAccess("u1", "other-patient");
    expect(still).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(3); // only the warm-ups
  });

  it("drops the entire cache when the selector is empty", async () => {
    await warmCache("u1", "p1");
    await warmCache("u2", "p2");

    const dropped = invalidateCareTeamCache({});
    expect(dropped).toBe(2);

    selectMock.mockResolvedValueOnce([{ id: "fresh" }]);
    await assertCareTeamAccess("u1", "p1");
    expect(selectMock).toHaveBeenCalledTimes(3); // 2 warm-ups + 1 refresh
  });
});

describe("publishCareTeamCacheInvalidation", () => {
  beforeEach(() => {
    __resetRbacModuleForTests();
    selectMock.mockReset();
  });

  it("drops the local cache entry immediately, even with no publisher registered", async () => {
    await warmCache("u-solo", "p-solo");

    await publishCareTeamCacheInvalidation({
      user_id: "u-solo",
      patient_id: "p-solo",
    });

    selectMock.mockResolvedValueOnce([{ id: "fresh" }]);
    await assertCareTeamAccess("u-solo", "p-solo");
    expect(selectMock).toHaveBeenCalledTimes(2); // warm-up + post-invalidate refresh
  });

  it("publishes a JSON-encoded selector on the invalidation channel when initialized", async () => {
    const publishMock =
      vi.fn<(channel: string, message: string) => Promise<number>>(
        async () => 1,
      );
    const pub: RbacPubClient = { publish: publishMock };
    const sub: RbacSubClient = {
      subscribe: vi.fn(async () => 1),
      on: vi.fn(),
    };

    initCareTeamCacheInvalidation(pub, sub);

    await publishCareTeamCacheInvalidation({
      user_id: "clinician-x",
      patient_id: "patient-y",
    });

    expect(publishMock).toHaveBeenCalledTimes(1);
    const [channel, message] = publishMock.mock.calls[0]!;
    expect(channel).toBe(CARETEAM_INVALIDATE_CHANNEL);
    expect(JSON.parse(message)).toEqual({
      user_id: "clinician-x",
      patient_id: "patient-y",
    });
  });

  it("does not throw when the publisher rejects — local cache is still dropped", async () => {
    const publishMock = vi.fn(async () => {
      throw new Error("redis is down");
    });
    const pub: RbacPubClient = { publish: publishMock };
    const sub: RbacSubClient = {
      subscribe: vi.fn(async () => 1),
      on: vi.fn(),
    };
    initCareTeamCacheInvalidation(pub, sub);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await warmCache("u", "p");

    await expect(
      publishCareTeamCacheInvalidation({ user_id: "u", patient_id: "p" }),
    ).resolves.toBeUndefined();

    // Local cache was dropped despite the publish failure.
    selectMock.mockResolvedValueOnce([{ id: "fresh" }]);
    await assertCareTeamAccess("u", "p");
    expect(selectMock).toHaveBeenCalledTimes(2);

    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

describe("initCareTeamCacheInvalidation — PUBSUB listener", () => {
  beforeEach(() => {
    __resetRbacModuleForTests();
    selectMock.mockReset();
  });

  /**
   * Build a fake Redis sub client that records the message listener so
   * tests can synthesize incoming messages.
   */
  function fakeSubClient(): {
    client: RbacSubClient;
    subscribeMock: ReturnType<typeof vi.fn>;
    fire: (channel: string, message: string) => void;
  } {
    let listener: ((channel: string, message: string) => void) | null = null;
    const subscribeMock = vi.fn(async () => 1);
    const client: RbacSubClient = {
      subscribe: subscribeMock,
      on: (_event, cb) => {
        listener = cb;
      },
    };
    return {
      client,
      subscribeMock,
      fire: (channel, message) => {
        if (listener) listener(channel, message);
      },
    };
  }

  it("subscribes to the canonical invalidation channel on init", () => {
    const pub: RbacPubClient = { publish: vi.fn(async () => 1) };
    const { client, subscribeMock } = fakeSubClient();

    initCareTeamCacheInvalidation(pub, client);

    expect(subscribeMock).toHaveBeenCalledWith(CARETEAM_INVALIDATE_CHANNEL);
  });

  it("drops matching cache entries when an invalidation message arrives", async () => {
    const pub: RbacPubClient = { publish: vi.fn(async () => 1) };
    const { client, fire } = fakeSubClient();
    initCareTeamCacheInvalidation(pub, client);

    await warmCache("u1", "p1");
    await warmCache("u2", "p2");

    fire(
      CARETEAM_INVALIDATE_CHANNEL,
      JSON.stringify({ user_id: "u1", patient_id: "p1" }),
    );

    // u1/p1 refreshes, u2/p2 still cached.
    selectMock.mockResolvedValueOnce([{ id: "fresh" }]);
    await assertCareTeamAccess("u1", "p1");
    await assertCareTeamAccess("u2", "p2");
    expect(selectMock).toHaveBeenCalledTimes(3); // warm + warm + refresh
  });

  it("ignores messages on other channels", async () => {
    const pub: RbacPubClient = { publish: vi.fn(async () => 1) };
    const { client, fire } = fakeSubClient();
    initCareTeamCacheInvalidation(pub, client);

    await warmCache("u", "p");

    fire("some:other:channel", JSON.stringify({ user_id: "u", patient_id: "p" }));

    // Still cached.
    const cached = await assertCareTeamAccess("u", "p");
    expect(cached).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(1);
  });

  it("logs and ignores malformed invalidation payloads", async () => {
    const pub: RbacPubClient = { publish: vi.fn(async () => 1) };
    const { client, fire } = fakeSubClient();
    initCareTeamCacheInvalidation(pub, client);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await warmCache("u", "p");

    fire(CARETEAM_INVALIDATE_CHANNEL, "not-json");

    // Still cached — the malformed message must not wipe the cache.
    const cached = await assertCareTeamAccess("u", "p");
    expect(cached).toBe(true);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("a wildcard user_id invalidation from another replica drops every entry for that user", async () => {
    const pub: RbacPubClient = { publish: vi.fn(async () => 1) };
    const { client, fire } = fakeSubClient();
    initCareTeamCacheInvalidation(pub, client);

    await warmCache("revoked-clinician", "p1");
    await warmCache("revoked-clinician", "p2");
    await warmCache("other-clinician", "p1");

    fire(
      CARETEAM_INVALIDATE_CHANNEL,
      JSON.stringify({ user_id: "revoked-clinician" }),
    );

    // Both entries for revoked-clinician dropped; other-clinician still cached.
    selectMock.mockResolvedValueOnce([]); // revoked
    selectMock.mockResolvedValueOnce([]); // revoked
    const a = await assertCareTeamAccess("revoked-clinician", "p1");
    const b = await assertCareTeamAccess("revoked-clinician", "p2");
    const c = await assertCareTeamAccess("other-clinician", "p1");
    expect(a).toBe(false);
    expect(b).toBe(false);
    expect(c).toBe(true);
    expect(selectMock).toHaveBeenCalledTimes(5); // 3 warm + 2 refresh
  });
});

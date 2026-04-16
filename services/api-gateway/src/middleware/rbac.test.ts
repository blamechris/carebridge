import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRPCError } from "@trpc/server";
import type { User } from "@carebridge/shared-types";
import { hasPermission } from "@carebridge/shared-types";
import {
  assertCareTeamAccess,
  assertPermission,
  clearCareTeamCache,
  invalidateCareTeamCacheEntry,
  invalidateCareTeamCacheForPatient,
  applyInvalidationMessage,
  broadcastCareTeamInvalidation,
  CARE_TEAM_INVALIDATE_CHANNEL,
} from "./rbac.js";

function makeUser(role: User["role"]): User {
  return {
    id: `user-${role}`,
    email: `${role}@example.test`,
    name: `${role} user`,
    role,
    is_active: true,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
  };
}

// Mock the db-schema module so we never hit a real database.
const careTeamSelectMock = vi.fn();
const emergencySelectMock = vi.fn();
vi.mock("@carebridge/db-schema", () => {
  const careTeamFromMock = vi.fn((_table?: unknown) => ({ where: vi.fn(() => ({ limit: careTeamSelectMock })) }));
  const emergencyFromMock = vi.fn((_table?: unknown) => ({ where: vi.fn(() => ({ limit: emergencySelectMock })) }));

  // Track which table the `from` call targets to route to the right mock.
  const selectFn = () => ({
    from: (table: { id: string }) => {
      if (table === emergencyAccessTable) {
        return emergencyFromMock(table);
      }
      return careTeamFromMock(table);
    },
  });

  const emergencyAccessTable = {
    id: "id",
    user_id: "user_id",
    patient_id: "patient_id",
    revoked_at: "revoked_at",
    expires_at: "expires_at",
  };

  const auditLogTable = {
    id: "id",
    user_id: "user_id",
    action: "action",
    resource_type: "resource_type",
    resource_id: "resource_id",
    details: "details",
    ip_address: "ip_address",
    timestamp: "timestamp",
  };

  return {
    getDb: () => ({
      select: selectFn,
      insert: () => ({ values: () => Promise.resolve() }),
    }),
    careTeamAssignments: {
      id: "id",
      user_id: "user_id",
      patient_id: "patient_id",
      removed_at: "removed_at",
    },
    emergencyAccess: emergencyAccessTable,
    auditLog: auditLogTable,
  };
});

vi.mock("drizzle-orm", () => ({
  eq: (...args: unknown[]) => args,
  and: (...args: unknown[]) => args,
  isNull: (col: unknown) => col,
  gt: (...args: unknown[]) => args,
}));

describe("care-team cache", () => {
  beforeEach(() => {
    clearCareTeamCache();
    careTeamSelectMock.mockReset();
    emergencySelectMock.mockReset();
    // Default: no emergency access unless explicitly set in a test.
    emergencySelectMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queries the DB on a cache miss", async () => {
    careTeamSelectMock.mockResolvedValueOnce([{ id: "row-1" }]);

    const result = await assertCareTeamAccess("user-1", "patient-1");

    expect(result).toBe(true);
    expect(careTeamSelectMock).toHaveBeenCalledTimes(1);
  });

  it("returns cached value without hitting the DB on a cache hit", async () => {
    careTeamSelectMock.mockResolvedValueOnce([{ id: "row-1" }]);

    await assertCareTeamAccess("user-1", "patient-1");
    const result = await assertCareTeamAccess("user-1", "patient-1");

    expect(result).toBe(true);
    expect(careTeamSelectMock).toHaveBeenCalledTimes(1); // only the first call
  });

  it("caches false (no access) results as well", async () => {
    careTeamSelectMock.mockResolvedValueOnce([]);

    const first = await assertCareTeamAccess("user-2", "patient-2");
    const second = await assertCareTeamAccess("user-2", "patient-2");

    expect(first).toBe(false);
    expect(second).toBe(false);
    expect(careTeamSelectMock).toHaveBeenCalledTimes(1);
  });

  it("expires entries after the TTL window", async () => {
    careTeamSelectMock.mockResolvedValueOnce([{ id: "row-1" }]);
    careTeamSelectMock.mockResolvedValueOnce([]); // second call returns no access

    await assertCareTeamAccess("user-3", "patient-3");

    // Advance past the 2 s TTL (kept tight so missed invalidations converge
    // quickly — see #277).
    vi.useFakeTimers();
    vi.advanceTimersByTime(3_000);

    const result = await assertCareTeamAccess("user-3", "patient-3");
    expect(result).toBe(false);
    expect(careTeamSelectMock).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  it("clearCareTeamCache() forces a fresh DB query", async () => {
    careTeamSelectMock.mockResolvedValueOnce([{ id: "row-1" }]);
    careTeamSelectMock.mockResolvedValueOnce([{ id: "row-1" }]);

    await assertCareTeamAccess("user-4", "patient-4");
    clearCareTeamCache();
    await assertCareTeamAccess("user-4", "patient-4");

    expect(careTeamSelectMock).toHaveBeenCalledTimes(2);
  });

  it("uses separate cache entries per user/patient pair", async () => {
    careTeamSelectMock.mockResolvedValueOnce([{ id: "row-1" }]);
    careTeamSelectMock.mockResolvedValueOnce([]);

    const a = await assertCareTeamAccess("user-a", "patient-x");
    const b = await assertCareTeamAccess("user-b", "patient-x");

    expect(a).toBe(true);
    expect(b).toBe(false);
    expect(careTeamSelectMock).toHaveBeenCalledTimes(2);
  });
});

describe("emergency access fallback", () => {
  beforeEach(() => {
    clearCareTeamCache();
    careTeamSelectMock.mockReset();
    emergencySelectMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("grants access via emergency access when no care-team assignment exists", async () => {
    careTeamSelectMock.mockResolvedValueOnce([]); // no care-team
    emergencySelectMock.mockResolvedValueOnce([{ id: "ea-1" }]); // active emergency grant

    const result = await assertCareTeamAccess("user-emergency", "patient-1");

    expect(result).toBe(true);
    expect(careTeamSelectMock).toHaveBeenCalledTimes(1);
    expect(emergencySelectMock).toHaveBeenCalledTimes(1);
  });

  it("denies access when emergency access grant has expired", async () => {
    careTeamSelectMock.mockResolvedValueOnce([]); // no care-team
    emergencySelectMock.mockResolvedValueOnce([]); // no active emergency (expired filtered by gt)

    const result = await assertCareTeamAccess("user-expired", "patient-1");

    expect(result).toBe(false);
    expect(emergencySelectMock).toHaveBeenCalledTimes(1);
  });

  it("denies access when emergency access grant has been revoked", async () => {
    careTeamSelectMock.mockResolvedValueOnce([]); // no care-team
    emergencySelectMock.mockResolvedValueOnce([]); // no active emergency (revoked filtered by isNull)

    const result = await assertCareTeamAccess("user-revoked", "patient-1");

    expect(result).toBe(false);
    expect(emergencySelectMock).toHaveBeenCalledTimes(1);
  });

  it("does not check emergency access when care-team assignment exists", async () => {
    careTeamSelectMock.mockResolvedValueOnce([{ id: "ct-1" }]); // has care-team

    const result = await assertCareTeamAccess("user-team", "patient-1");

    expect(result).toBe(true);
    expect(emergencySelectMock).not.toHaveBeenCalled();
  });
});

describe("hasPermission", () => {
  it("returns true when the role's grant list contains the permission", () => {
    expect(hasPermission(makeUser("physician"), "sign:notes")).toBe(true);
  });

  it("returns false when the role does not have the permission", () => {
    expect(hasPermission(makeUser("nurse"), "sign:notes")).toBe(false);
  });

  it("returns false for patient users attempting clinician permissions", () => {
    expect(hasPermission(makeUser("patient"), "sign:notes")).toBe(false);
  });

  it("returns false for unknown permission strings", () => {
    expect(hasPermission(makeUser("admin"), "launch:missiles")).toBe(false);
  });
});

describe("assertPermission", () => {
  it("throws TRPCError(FORBIDDEN) when the user lacks the permission", () => {
    let caught: unknown;
    try {
      assertPermission(makeUser("nurse"), "sign:notes");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    expect((caught as TRPCError).code).toBe("FORBIDDEN");
  });

  it("does not throw when the user has the permission", () => {
    expect(() => assertPermission(makeUser("physician"), "sign:notes")).not.toThrow();
  });

  it("defaults to a generic message that does not leak the permission key (PR #381 Copilot review)", () => {
    try {
      assertPermission(makeUser("nurse"), "admin:users");
    } catch (err) {
      const msg = (err as TRPCError).message;
      // Generic default — does NOT contain the internal permission identifier.
      expect(msg).toBe("Access denied");
      expect(msg).not.toContain("admin:users");
    }
  });

  it("honours an explicit domain-appropriate message when provided", () => {
    try {
      assertPermission(
        makeUser("nurse"),
        "admin:users",
        "Only admins can revoke emergency access",
      );
    } catch (err) {
      expect((err as TRPCError).message).toBe(
        "Only admins can revoke emergency access",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Targeted invalidation — #277
// ---------------------------------------------------------------------------

describe("invalidateCareTeamCacheEntry", () => {
  beforeEach(() => {
    clearCareTeamCache();
    careTeamSelectMock.mockReset();
    emergencySelectMock.mockReset();
    emergencySelectMock.mockResolvedValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("drops a single entry without affecting others", async () => {
    careTeamSelectMock
      .mockResolvedValueOnce([{ id: "r-1" }]) // user-A first call
      .mockResolvedValueOnce([{ id: "r-2" }]) // user-B first call
      .mockResolvedValueOnce([]); // user-A re-fetch after invalidation
    await assertCareTeamAccess("user-A", "patient-1");
    await assertCareTeamAccess("user-B", "patient-1");
    expect(careTeamSelectMock).toHaveBeenCalledTimes(2);

    invalidateCareTeamCacheEntry("user-A", "patient-1");

    // A re-queries; B still cached
    expect(await assertCareTeamAccess("user-A", "patient-1")).toBe(false);
    expect(await assertCareTeamAccess("user-B", "patient-1")).toBe(true);
    expect(careTeamSelectMock).toHaveBeenCalledTimes(3);
  });

  it("no-ops on an entry that is not cached", () => {
    expect(() =>
      invalidateCareTeamCacheEntry("nobody", "patient-nobody"),
    ).not.toThrow();
  });
});

describe("invalidateCareTeamCacheForPatient", () => {
  beforeEach(() => {
    clearCareTeamCache();
    careTeamSelectMock.mockReset();
    emergencySelectMock.mockReset();
    emergencySelectMock.mockResolvedValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("drops every entry for the patient across users", async () => {
    careTeamSelectMock
      .mockResolvedValueOnce([{ id: "r-1" }])
      .mockResolvedValueOnce([{ id: "r-2" }])
      .mockResolvedValueOnce([{ id: "r-3" }])
      .mockResolvedValueOnce([]) // user-A re-fetch
      .mockResolvedValueOnce([]) // user-B re-fetch
      .mockResolvedValueOnce([{ id: "r-3" }]); // user-C / other patient still cached
    await assertCareTeamAccess("user-A", "patient-1");
    await assertCareTeamAccess("user-B", "patient-1");
    await assertCareTeamAccess("user-C", "patient-2"); // different patient

    invalidateCareTeamCacheForPatient("patient-1");

    expect(await assertCareTeamAccess("user-A", "patient-1")).toBe(false);
    expect(await assertCareTeamAccess("user-B", "patient-1")).toBe(false);
    // user-C / patient-2 still cached
    expect(await assertCareTeamAccess("user-C", "patient-2")).toBe(true);
    expect(careTeamSelectMock).toHaveBeenCalledTimes(5);
  });
});

describe("applyInvalidationMessage (PUBSUB handler)", () => {
  beforeEach(() => {
    clearCareTeamCache();
    careTeamSelectMock.mockReset();
    emergencySelectMock.mockReset();
    emergencySelectMock.mockResolvedValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("applies a user:patient message by dropping that entry", async () => {
    careTeamSelectMock
      .mockResolvedValueOnce([{ id: "r-1" }])
      .mockResolvedValueOnce([]);
    await assertCareTeamAccess("user-A", "patient-1");

    applyInvalidationMessage("user-A:patient-1");

    expect(await assertCareTeamAccess("user-A", "patient-1")).toBe(false);
  });

  it("applies a *:patient message as a patient-wide invalidation", async () => {
    careTeamSelectMock
      .mockResolvedValueOnce([{ id: "r-1" }])
      .mockResolvedValueOnce([{ id: "r-2" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await assertCareTeamAccess("user-A", "patient-1");
    await assertCareTeamAccess("user-B", "patient-1");

    applyInvalidationMessage("*:patient-1");

    expect(await assertCareTeamAccess("user-A", "patient-1")).toBe(false);
    expect(await assertCareTeamAccess("user-B", "patient-1")).toBe(false);
  });

  it("ignores malformed messages", () => {
    expect(() => applyInvalidationMessage("")).not.toThrow();
    expect(() => applyInvalidationMessage("only-one-token")).not.toThrow();
  });
});

describe("broadcastCareTeamInvalidation", () => {
  beforeEach(() => {
    clearCareTeamCache();
    careTeamSelectMock.mockReset();
    emergencySelectMock.mockReset();
    emergencySelectMock.mockResolvedValue([]);
  });

  afterEach(() => vi.restoreAllMocks());

  it("publishes to the care-team channel and invalidates locally", async () => {
    const publisher = { publish: vi.fn(async () => 1) };

    careTeamSelectMock
      .mockResolvedValueOnce([{ id: "r-1" }])
      .mockResolvedValueOnce([]);
    await assertCareTeamAccess("user-A", "patient-1");

    await broadcastCareTeamInvalidation(publisher, "user-A", "patient-1");

    expect(publisher.publish).toHaveBeenCalledWith(
      CARE_TEAM_INVALIDATE_CHANNEL,
      "user-A:patient-1",
    );
    expect(await assertCareTeamAccess("user-A", "patient-1")).toBe(false);
  });

  it("swallows publisher errors — local invalidation still happens", async () => {
    const publisher = {
      publish: vi.fn(async () => {
        throw new Error("redis down");
      }),
    };

    careTeamSelectMock
      .mockResolvedValueOnce([{ id: "r-1" }])
      .mockResolvedValueOnce([]);
    await assertCareTeamAccess("user-A", "patient-1");

    await expect(
      broadcastCareTeamInvalidation(publisher, "user-A", "patient-1"),
    ).resolves.toBeUndefined();
    expect(await assertCareTeamAccess("user-A", "patient-1")).toBe(false);
  });

  it("accepts '*' as the user to broadcast a patient-wide invalidation", async () => {
    const publisher = { publish: vi.fn(async () => 1) };
    careTeamSelectMock
      .mockResolvedValueOnce([{ id: "r-1" }])
      .mockResolvedValueOnce([{ id: "r-2" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await assertCareTeamAccess("user-A", "patient-1");
    await assertCareTeamAccess("user-B", "patient-1");

    await broadcastCareTeamInvalidation(publisher, "*", "patient-1");

    expect(publisher.publish).toHaveBeenCalledWith(
      CARE_TEAM_INVALIDATE_CHANNEL,
      "*:patient-1",
    );
    expect(await assertCareTeamAccess("user-A", "patient-1")).toBe(false);
    expect(await assertCareTeamAccess("user-B", "patient-1")).toBe(false);
  });
});

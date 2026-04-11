import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRPCError } from "@trpc/server";
import type { User } from "@carebridge/shared-types";
import { hasPermission } from "@carebridge/shared-types";
import { assertCareTeamAccess, assertPermission, clearCareTeamCache } from "./rbac.js";

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

  it("expires entries after 60 seconds", async () => {
    selectMock.mockResolvedValueOnce([{ id: "row-1" }]);
    selectMock.mockResolvedValueOnce([]); // second call returns no access

    await assertCareTeamAccess("user-3", "patient-3");

    // Advance time past the 60 s TTL
    vi.useFakeTimers();
    vi.advanceTimersByTime(61_000);

    const result = await assertCareTeamAccess("user-3", "patient-3");
    expect(result).toBe(false);
    expect(selectMock).toHaveBeenCalledTimes(2);

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

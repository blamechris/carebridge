import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { assertCareTeamAccess, clearCareTeamCache } from "./rbac.js";

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

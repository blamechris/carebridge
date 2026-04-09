/**
 * Phase C3 — notification-router unit tests.
 *
 * Covers:
 *   - specialty token normalization (slash/underscore/mixed-case)
 *   - specialty matching (exact, substring both directions, length gate)
 *   - fan-out to matching care-team members
 *   - fallback to all-active when no specialty matches
 *   - idempotency on (flag_id, user_id) — retries don't duplicate
 *   - inactive members never notified
 *   - empty care team is a no-op
 *   - title / link builders
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
// The router makes:
//   1. db.select().from(careTeamMembers).where(...) → members
//   2. db.select().from(notifications).where(...).limit(1) → existing[]  (per member)
//   3. db.insert(notifications).values({...})
//
// We stage the care-team roster and an existence map keyed by provider_id.

interface CareTeamMemberRow {
  id: string;
  patient_id: string;
  provider_id: string;
  role: string;
  specialty: string | null;
  is_active: boolean;
  started_at: string;
  ended_at: string | null;
  created_at: string;
}

let careTeamRows: CareTeamMemberRow[] = [];
// Provider IDs whose (flag, user) pair already exists in notifications.
// Keyed as `${flagId}::${userId}`.
let existingNotifications = new Set<string>();
// Inserted rows (for assertions).
const insertedNotifications: Array<Record<string, unknown>> = [];

// Track which where() call we're on by examining the table marker.
// drizzle-orm symbols are opaque in our mock, so we use the `from(X)`
// argument identity as the table selector.
let lastFromTable: unknown = null;
// Filter state captured from the most recent where() call so that the
// notifications-lookup path can find the right (user_id, flag_id) pair.
let lastWhereArgs: unknown[] = [];

const selectMock = vi.fn(() => ({
  from: (table: unknown) => {
    lastFromTable = table;
    return {
      where: (...whereArgs: unknown[]) => {
        lastWhereArgs = whereArgs;
        if (lastFromTable === CARE_TEAM_TABLE) {
          return Promise.resolve(
            careTeamRows.filter((r) => r.is_active),
          );
        }
        if (lastFromTable === NOTIFICATIONS_TABLE) {
          // `where` clause is (user_id == X AND related_flag_id == Y).
          // Rather than parse drizzle condition objects we pull the
          // ids out of the whereArgs via our simple mock predicates.
          // The eq() mock below stashes the value on the condition
          // object so we can read it here.
          const conds = extractEqConditions(whereArgs);
          const userId = conds.user_id as string | undefined;
          const flagId = conds.related_flag_id as string | undefined;
          const key = `${flagId ?? ""}::${userId ?? ""}`;
          const exists = existingNotifications.has(key);
          return {
            limit: () => Promise.resolve(exists ? [{ id: "existing" }] : []),
          };
        }
        return { limit: () => Promise.resolve([]) };
      },
    };
  },
}));

const insertMock = vi.fn((_table: unknown) => ({
  values: (row: Record<string, unknown>) => {
    insertedNotifications.push(row);
    return Promise.resolve(undefined);
  },
}));

// Sentinel objects for the two tables we care about.
const CARE_TEAM_TABLE = { __table: "care_team_members" };
const NOTIFICATIONS_TABLE = { __table: "notifications" };

// Column marker objects — stored on eq() condition records so the
// mock can recognize which column a given condition targets.
const CARE_TEAM_COLS = {
  id: { __col: "ct.id" },
  patient_id: { __col: "ct.patient_id" },
  provider_id: { __col: "ct.provider_id" },
  is_active: { __col: "ct.is_active" },
  specialty: { __col: "ct.specialty" },
};
const NOTIFICATIONS_COLS = {
  id: { __col: "n.id" },
  user_id: { __col: "n.user_id" },
  related_flag_id: { __col: "n.related_flag_id" },
};

type ColMarker = { __col: string };
type EqCondition = { __eq: true; col: ColMarker; value: unknown };

function isEqCondition(x: unknown): x is EqCondition {
  return (
    typeof x === "object" &&
    x !== null &&
    (x as { __eq?: boolean }).__eq === true
  );
}

function extractEqConditions(args: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (isEqCondition(node)) {
      // Map column short name → value.
      const shortName = node.col.__col.split(".").pop() ?? node.col.__col;
      out[shortName] = node.value;
      return;
    }
    if (typeof node === "object" && node !== null) {
      const andInner = (node as { __and?: unknown[] }).__and;
      if (Array.isArray(andInner)) andInner.forEach(walk);
    }
  };
  walk(args);
  return out;
}

vi.mock("drizzle-orm", () => ({
  eq: (col: ColMarker, value: unknown) => ({ __eq: true, col, value }),
  and: (...conds: unknown[]) => ({ __and: conds }),
  sql: (..._args: unknown[]) => ({ __sql: true }),
}));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ select: selectMock, insert: insertMock }),
  careTeamMembers: Object.assign(CARE_TEAM_TABLE, CARE_TEAM_COLS),
  notifications: Object.assign(NOTIFICATIONS_TABLE, NOTIFICATIONS_COLS),
}));

// ── Import under test after mocks ────────────────────────────────
const {
  routeFlagToCareTeam,
  normalizeSpecialtyTokens,
  specialtyMatches,
  buildFlagLink,
  buildFlagTitle,
} = await import("../services/notification-router.js");

// ── Fixtures ─────────────────────────────────────────────────────
const PATIENT = "11111111-1111-1111-1111-111111111111";
const FLAG_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const DR_SMITH = "22222222-2222-2222-2222-222222222222";
const DR_JONES = "33333333-3333-3333-3333-333333333333";
const DR_GREY = "44444444-4444-4444-4444-444444444444";

function memberRow(overrides: Partial<CareTeamMemberRow>): CareTeamMemberRow {
  return {
    id: crypto.randomUUID(),
    patient_id: PATIENT,
    provider_id: DR_SMITH,
    role: "specialist",
    specialty: "hematology_oncology",
    is_active: true,
    started_at: "2026-01-01T00:00:00.000Z",
    ended_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function basePayload(overrides: Record<string, unknown> = {}) {
  return {
    flag_id: FLAG_ID,
    patient_id: PATIENT,
    severity: "warning" as const,
    category: "cross-specialty",
    summary: "Possible contradiction between SOAP and vital sign readings.",
    notify_specialties: ["oncology"],
    rule_id: "NOTE-VITAL-CONTRADICTION-001",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  careTeamRows = [];
  existingNotifications = new Set();
  insertedNotifications.length = 0;
});

describe("normalizeSpecialtyTokens", () => {
  it("splits slash-separated composite specialties", () => {
    const tokens = normalizeSpecialtyTokens("Hematology/Oncology");
    expect(tokens.has("hematology")).toBe(true);
    expect(tokens.has("oncology")).toBe(true);
  });

  it("splits underscore-separated tokens", () => {
    const tokens = normalizeSpecialtyTokens("hematology_oncology");
    expect(tokens.has("hematology")).toBe(true);
    expect(tokens.has("oncology")).toBe(true);
  });

  it("returns an empty set for null", () => {
    expect(normalizeSpecialtyTokens(null).size).toBe(0);
  });

  it("lowercases and trims whitespace", () => {
    const tokens = normalizeSpecialtyTokens("  Interventional Radiology  ");
    expect(tokens.has("interventional")).toBe(true);
    expect(tokens.has("radiology")).toBe(true);
  });
});

describe("specialtyMatches", () => {
  it("matches identical tokens", () => {
    expect(
      specialtyMatches(new Set(["oncology"]), new Set(["oncology"])),
    ).toBe(true);
  });

  it("matches when a member token is a substring of a flag token (>3 chars)", () => {
    expect(
      specialtyMatches(new Set(["onco"]), new Set(["oncology_onc"])),
    ).toBe(true);
  });

  it("matches when a flag token is a substring of a member token (>3 chars)", () => {
    // "radio" is 5 chars and appears inside "radiology".
    expect(
      specialtyMatches(new Set(["radiology"]), new Set(["radio"])),
    ).toBe(true);
  });

  it("does not substring-match tokens of 3 chars or fewer", () => {
    // "rad" is 3 chars — below the >3 floor, so no substring match.
    expect(
      specialtyMatches(new Set(["radiology"]), new Set(["rad"])),
    ).toBe(false);
  });

  it("returns false when either side is empty", () => {
    expect(specialtyMatches(new Set(), new Set(["oncology"]))).toBe(false);
    expect(specialtyMatches(new Set(["oncology"]), new Set())).toBe(false);
  });
});

describe("buildFlagTitle", () => {
  it("prefixes critical flags with 'Critical AI flag'", () => {
    const t = buildFlagTitle(
      basePayload({ severity: "critical" }) as Parameters<
        typeof buildFlagTitle
      >[0],
    );
    expect(t.startsWith("Critical AI flag: ")).toBe(true);
  });

  it("truncates summaries longer than 120 chars", () => {
    const long = "a".repeat(200);
    const t = buildFlagTitle(
      basePayload({ summary: long }) as Parameters<typeof buildFlagTitle>[0],
    );
    expect(t.length).toBeLessThanOrEqual(120 + "AI flag: ".length + 3);
    expect(t.endsWith("...")).toBe(true);
  });
});

describe("buildFlagLink", () => {
  it("builds a relative flags-tab deep link", () => {
    expect(buildFlagLink(PATIENT)).toBe(`/patients/${PATIENT}?tab=flags`);
  });
});

describe("routeFlagToCareTeam", () => {
  it("is a no-op when the care team is empty", async () => {
    careTeamRows = [];
    const result = await routeFlagToCareTeam(basePayload());
    expect(result.recipients_matched).toBe(0);
    expect(result.notified_user_ids).toEqual([]);
    expect(result.used_fallback).toBe(false);
    expect(insertedNotifications).toHaveLength(0);
  });

  it("notifies only members whose specialty matches notify_specialties", async () => {
    careTeamRows = [
      memberRow({ provider_id: DR_SMITH, specialty: "hematology_oncology" }),
      memberRow({ provider_id: DR_JONES, specialty: "radiology" }),
      memberRow({ provider_id: DR_GREY, specialty: "cardiology" }),
    ];

    const result = await routeFlagToCareTeam(
      basePayload({ notify_specialties: ["oncology"] }),
    );

    expect(result.used_fallback).toBe(false);
    expect(result.notified_user_ids).toEqual([DR_SMITH]);
    expect(insertedNotifications).toHaveLength(1);
    expect(insertedNotifications[0].user_id).toBe(DR_SMITH);
    expect(insertedNotifications[0].related_flag_id).toBe(FLAG_ID);
    expect(insertedNotifications[0].type).toBe("ai-flag");
    expect(insertedNotifications[0].is_read).toBe(false);
  });

  it("falls back to all active members when no specialty matches", async () => {
    careTeamRows = [
      memberRow({ provider_id: DR_SMITH, specialty: "dermatology" }),
      memberRow({ provider_id: DR_JONES, specialty: "podiatry" }),
    ];

    const result = await routeFlagToCareTeam(
      basePayload({ notify_specialties: ["oncology"] }),
    );

    expect(result.used_fallback).toBe(true);
    expect(result.notified_user_ids.sort()).toEqual(
      [DR_SMITH, DR_JONES].sort(),
    );
    expect(insertedNotifications).toHaveLength(2);
  });

  it("falls back when the flag has no notify_specialties", async () => {
    careTeamRows = [
      memberRow({ provider_id: DR_SMITH, specialty: "dermatology" }),
    ];

    const result = await routeFlagToCareTeam(
      basePayload({ notify_specialties: [] }),
    );

    expect(result.used_fallback).toBe(true);
    expect(result.notified_user_ids).toEqual([DR_SMITH]);
  });

  it("excludes inactive care-team members from routing", async () => {
    careTeamRows = [
      memberRow({ provider_id: DR_SMITH, specialty: "oncology" }),
      memberRow({
        provider_id: DR_JONES,
        specialty: "oncology",
        is_active: false,
        ended_at: "2026-02-01T00:00:00.000Z",
      }),
    ];

    const result = await routeFlagToCareTeam(basePayload());

    expect(result.notified_user_ids).toEqual([DR_SMITH]);
    expect(insertedNotifications).toHaveLength(1);
  });

  it("is idempotent — does not insert a second notification for the same (flag, user) pair", async () => {
    careTeamRows = [
      memberRow({ provider_id: DR_SMITH, specialty: "oncology" }),
    ];
    // Simulate a prior run having already created the notification
    existingNotifications.add(`${FLAG_ID}::${DR_SMITH}`);

    const result = await routeFlagToCareTeam(basePayload());

    expect(result.notified_user_ids).toEqual([]);
    expect(result.skipped_existing).toBe(1);
    expect(insertedNotifications).toHaveLength(0);
  });

  it("dedupes care-team rows where the same provider appears twice", async () => {
    careTeamRows = [
      memberRow({
        provider_id: DR_SMITH,
        role: "primary",
        specialty: "oncology",
      }),
      memberRow({
        provider_id: DR_SMITH,
        role: "specialist",
        specialty: "oncology",
      }),
    ];

    const result = await routeFlagToCareTeam(basePayload());

    expect(result.recipients_matched).toBe(1);
    expect(insertedNotifications).toHaveLength(1);
  });

  it("mixes matched-members and a provider who happens to be active but off-specialty when fallback triggers", async () => {
    careTeamRows = [
      memberRow({ provider_id: DR_SMITH, specialty: "dermatology" }),
      memberRow({ provider_id: DR_JONES, specialty: null }),
    ];

    const result = await routeFlagToCareTeam(
      basePayload({ notify_specialties: ["neurology"] }),
    );

    expect(result.used_fallback).toBe(true);
    expect(result.notified_user_ids.sort()).toEqual(
      [DR_SMITH, DR_JONES].sort(),
    );
  });
});

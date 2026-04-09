/**
 * Phase D P1 — patient_ai_consent gate unit tests.
 *
 * Covers:
 *   - default deny: no row → hasActiveAiConsent returns false
 *   - active grant: row with revoked_at null → hasActiveAiConsent returns true
 *   - revoked grant: row with revoked_at set → hasActiveAiConsent returns false
 *   - scope isolation: grant for llm_review doesn't satisfy note_extraction
 *   - revokeAiConsent is idempotent and returns false when no grant exists
 *   - grantAiConsent inserts with expected columns
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

interface ConsentRow {
  id: string;
  patient_id: string;
  scope: string;
  policy_version: string;
  granted_by_user_id: string;
  granted_by_relationship: string;
  granted_at: string;
  revoked_at: string | null;
  revoked_by_user_id: string | null;
  revocation_reason: string | null;
  created_at: string;
}

let rows: ConsentRow[] = [];
let lastInsertValues: ConsentRow | null = null;
let lastUpdateSet: Partial<ConsentRow> | null = null;
let lastUpdateWhereId: string | null = null;

const selectMock = vi.fn(() => ({
  from: () => ({
    where: (whereArgs: unknown) => ({
      orderBy: () => ({
        limit: () => {
          // Extract the patient_id and scope from the where clause by
          // reading the stashed eq() conditions from our drizzle mock.
          const conds = collectEq(whereArgs);
          const patientId = conds.patient_id;
          const scope = conds.scope;
          const filtered = rows
            .filter(
              (r) =>
                r.patient_id === patientId &&
                r.scope === scope &&
                r.revoked_at === null,
            )
            .sort((a, b) => b.granted_at.localeCompare(a.granted_at));
          return Promise.resolve(filtered.slice(0, 1));
        },
      }),
    }),
  }),
}));

const insertMock = vi.fn(() => ({
  values: (row: ConsentRow) => {
    lastInsertValues = row;
    rows.push(row);
    return Promise.resolve();
  },
}));

const updateMock = vi.fn(() => ({
  set: (values: Partial<ConsentRow>) => {
    lastUpdateSet = values;
    return {
      where: (whereArgs: unknown) => {
        const conds = collectEq(whereArgs);
        lastUpdateWhereId = (conds.id as string) ?? null;
        const target = rows.find((r) => r.id === lastUpdateWhereId);
        if (target) Object.assign(target, values);
        return Promise.resolve();
      },
    };
  },
}));

function collectEq(node: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const walk = (n: unknown) => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (typeof n !== "object" || n === null) return;
    const obj = n as Record<string, unknown>;
    if (obj.__eq === true) {
      const short = String(obj.col).split(".").pop() ?? String(obj.col);
      out[short] = obj.value;
      return;
    }
    if (Array.isArray(obj.__and)) obj.__and.forEach(walk);
    if (obj.__isNull === true) {
      const short = String(obj.col).split(".").pop() ?? String(obj.col);
      out[short] = null;
    }
  };
  walk(node);
  return out;
}

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, value: unknown) => ({ __eq: true, col, value }),
  isNull: (col: unknown) => ({ __isNull: true, col }),
  and: (...conds: unknown[]) => ({ __and: conds }),
  desc: (col: unknown) => ({ __desc: true, col }),
}));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    select: selectMock,
    insert: insertMock,
    update: updateMock,
  }),
  patientAiConsent: {
    id: "pac.id",
    patient_id: "pac.patient_id",
    scope: "pac.scope",
    policy_version: "pac.policy_version",
    granted_by_user_id: "pac.granted_by_user_id",
    granted_at: "pac.granted_at",
    revoked_at: "pac.revoked_at",
  },
}));

const {
  hasActiveAiConsent,
  getActiveAiConsent,
  grantAiConsent,
  revokeAiConsent,
} = await import("../services/consent-service.js");

const PATIENT = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";

function mkRow(overrides: Partial<ConsentRow> = {}): ConsentRow {
  return {
    id: crypto.randomUUID(),
    patient_id: PATIENT,
    scope: "llm_review",
    policy_version: "ai-consent-v1.0",
    granted_by_user_id: USER,
    granted_by_relationship: "self",
    granted_at: "2026-03-01T00:00:00.000Z",
    revoked_at: null,
    revoked_by_user_id: null,
    revocation_reason: null,
    created_at: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  rows = [];
  lastInsertValues = null;
  lastUpdateSet = null;
  lastUpdateWhereId = null;
});

describe("hasActiveAiConsent", () => {
  it("returns false when the patient has no consent row (default deny)", async () => {
    expect(await hasActiveAiConsent(PATIENT)).toBe(false);
  });

  it("returns true when the patient has an unrevoked grant", async () => {
    rows = [mkRow()];
    expect(await hasActiveAiConsent(PATIENT)).toBe(true);
  });

  it("returns false when the only grant has been revoked", async () => {
    rows = [
      mkRow({
        revoked_at: "2026-03-10T00:00:00.000Z",
        revoked_by_user_id: USER,
        revocation_reason: "patient withdrew",
      }),
    ];
    expect(await hasActiveAiConsent(PATIENT)).toBe(false);
  });

  it("returns true when a fresh grant supersedes a prior revocation", async () => {
    rows = [
      mkRow({
        granted_at: "2026-01-01T00:00:00.000Z",
        revoked_at: "2026-02-01T00:00:00.000Z",
      }),
      mkRow({ granted_at: "2026-03-01T00:00:00.000Z" }),
    ];
    expect(await hasActiveAiConsent(PATIENT)).toBe(true);
  });

  it("scopes are isolated — llm_review grant does not satisfy note_extraction query", async () => {
    rows = [mkRow({ scope: "llm_review" })];
    expect(await hasActiveAiConsent(PATIENT, "note_extraction")).toBe(false);
  });
});

describe("getActiveAiConsent", () => {
  it("returns the freshest active grant's fields", async () => {
    rows = [
      mkRow({
        id: "old",
        granted_at: "2026-01-01T00:00:00.000Z",
      }),
      mkRow({
        id: "new",
        granted_at: "2026-03-01T00:00:00.000Z",
        policy_version: "ai-consent-v2.0",
      }),
    ];

    const active = await getActiveAiConsent(PATIENT);
    expect(active).not.toBeNull();
    expect(active?.id).toBe("new");
    expect(active?.policy_version).toBe("ai-consent-v2.0");
  });

  it("returns null when no active grant exists", async () => {
    expect(await getActiveAiConsent(PATIENT)).toBeNull();
  });
});

describe("grantAiConsent", () => {
  it("inserts a new row with expected columns and returns the grant", async () => {
    const result = await grantAiConsent(
      {
        patient_id: PATIENT,
        scope: "llm_review",
        policy_version: "ai-consent-v1.0",
        granted_by_user_id: USER,
        granted_by_relationship: "self",
      },
      new Date("2026-03-15T12:00:00.000Z"),
    );

    expect(lastInsertValues?.patient_id).toBe(PATIENT);
    expect(lastInsertValues?.scope).toBe("llm_review");
    expect(lastInsertValues?.granted_at).toBe("2026-03-15T12:00:00.000Z");
    expect(lastInsertValues?.revoked_at).toBeNull();
    expect(result.id).toBeDefined();
    expect(result.granted_at).toBe("2026-03-15T12:00:00.000Z");
  });
});

describe("revokeAiConsent", () => {
  it("returns false when there is no active grant to revoke", async () => {
    const result = await revokeAiConsent(PATIENT, USER, "n/a");
    expect(result).toBe(false);
    expect(lastUpdateSet).toBeNull();
  });

  it("flips revoked_at / revoked_by on the active row and returns true", async () => {
    rows = [mkRow({ id: "active-grant" })];
    const result = await revokeAiConsent(
      PATIENT,
      USER,
      "withdrew at follow-up",
      "llm_review",
      new Date("2026-04-01T00:00:00.000Z"),
    );

    expect(result).toBe(true);
    expect(lastUpdateWhereId).toBe("active-grant");
    expect(lastUpdateSet?.revoked_at).toBe("2026-04-01T00:00:00.000Z");
    expect(lastUpdateSet?.revoked_by_user_id).toBe(USER);
    expect(lastUpdateSet?.revocation_reason).toBe("withdrew at follow-up");
  });

  it("is idempotent — second call after revocation returns false", async () => {
    rows = [mkRow({ id: "g1" })];
    expect(await revokeAiConsent(PATIENT, USER, "first")).toBe(true);
    expect(await revokeAiConsent(PATIENT, USER, "second")).toBe(false);
  });
});

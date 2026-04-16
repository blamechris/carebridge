import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

// ---------------------------------------------------------------------------
// Mocks — covers @carebridge/db-schema and drizzle-orm so deriveActorContext
// can be exercised without a real DB. Each test controls what the select()
// chain resolves to.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const state: { relationshipRow: Array<{ relationship_type: string }> } = {
    relationshipRow: [],
  };
  const fn = vi.fn;
  function makeChain() {
    const chain: Record<string, unknown> = {};
    chain.from = fn(() => chain);
    chain.innerJoin = fn(() => chain);
    chain.where = fn(() => chain);
    chain.limit = fn(async () => state.relationshipRow);
    return chain;
  }
  return {
    state,
    mockDb: { select: fn(() => makeChain()) },
  };
});

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mocks.mockDb,
  auditLog: {},
  familyRelationships: {
    caregiver_id: "family_relationships.caregiver_id",
    patient_id: "family_relationships.patient_id",
    relationship_type: "family_relationships.relationship_type",
    status: "family_relationships.status",
  },
  users: { id: "users.id", patient_id: "users.patient_id" },
}));

vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => ({ and: args }),
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

import { deriveActorContext, getFamilyRelationshipType } from "../middleware/audit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(
  role: string,
  id = "user-1",
  patient_id?: string,
): User {
  return {
    id,
    email: `${role}@carebridge.dev`,
    name: `Test ${role}`,
    role: role as User["role"],
    is_active: true,
    patient_id,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// deriveActorContext
// ---------------------------------------------------------------------------

describe("deriveActorContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.relationshipRow = [];
  });

  it("returns both null for anonymous/no user", async () => {
    expect(await deriveActorContext(undefined, "pat-1")).toEqual({
      actorRelationship: null,
      onBehalfOfPatientId: null,
    });
  });

  it('returns "self" when patient accesses their own record (patient_id matches)', async () => {
    expect(
      await deriveActorContext(
        makeUser("patient", "user-1", "pat-1"),
        "pat-1",
      ),
    ).toEqual({ actorRelationship: "self", onBehalfOfPatientId: null });
  });

  it('returns "self" for patients when patientId is null', async () => {
    expect(
      await deriveActorContext(
        makeUser("patient", "user-1", "pat-1"),
        null,
      ),
    ).toEqual({ actorRelationship: "self", onBehalfOfPatientId: null });
  });

  it("returns null when a patient attempts cross-patient access", async () => {
    // Cross-patient attempt — audit row must NOT claim "self" or it will
    // mislabel the denied access in the trail.
    expect(
      await deriveActorContext(
        makeUser("patient", "user-1", "pat-1"),
        "pat-other",
      ),
    ).toEqual({ actorRelationship: null, onBehalfOfPatientId: null });
  });

  it("returns null for clinicians (physician, nurse, specialist)", async () => {
    for (const role of ["physician", "nurse", "specialist"]) {
      expect(
        await deriveActorContext(makeUser(role), "pat-1"),
      ).toEqual({ actorRelationship: null, onBehalfOfPatientId: null });
    }
  });

  it("returns null for admin", async () => {
    expect(
      await deriveActorContext(makeUser("admin"), "pat-1"),
    ).toEqual({ actorRelationship: null, onBehalfOfPatientId: null });
  });

  it("returns relationship_type and on_behalf for family_caregiver with active row", async () => {
    mocks.state.relationshipRow = [{ relationship_type: "spouse" }];
    expect(
      await deriveActorContext(makeUser("family_caregiver", "careg-1"), "pat-99"),
    ).toEqual({ actorRelationship: "spouse", onBehalfOfPatientId: "pat-99" });
  });

  it('falls back to "caregiver" when no active relationship exists', async () => {
    mocks.state.relationshipRow = [];
    expect(
      await deriveActorContext(makeUser("family_caregiver", "careg-1"), "pat-99"),
    ).toEqual({ actorRelationship: "caregiver", onBehalfOfPatientId: "pat-99" });
  });

  it('returns "caregiver" and null on_behalf when patientId is null', async () => {
    expect(
      await deriveActorContext(makeUser("family_caregiver"), null),
    ).toEqual({ actorRelationship: "caregiver", onBehalfOfPatientId: null });
  });

  it("preserves all family relationship_type values", async () => {
    for (const rel of ["parent", "child", "sibling", "healthcare_poa", "other"]) {
      mocks.state.relationshipRow = [{ relationship_type: rel }];
      const ctx = await deriveActorContext(
        makeUser("family_caregiver", "careg-1"),
        "pat-99",
      );
      expect(ctx.actorRelationship).toBe(rel);
    }
  });
});

// ---------------------------------------------------------------------------
// getFamilyRelationshipType
// ---------------------------------------------------------------------------

describe("getFamilyRelationshipType", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.state.relationshipRow = [];
  });

  it("returns the relationship_type from the first row", async () => {
    mocks.state.relationshipRow = [{ relationship_type: "healthcare_poa" }];
    expect(await getFamilyRelationshipType("careg-1", "pat-1")).toBe(
      "healthcare_poa",
    );
  });

  it("returns null when no row found", async () => {
    mocks.state.relationshipRow = [];
    expect(await getFamilyRelationshipType("careg-1", "pat-1")).toBeNull();
  });
});

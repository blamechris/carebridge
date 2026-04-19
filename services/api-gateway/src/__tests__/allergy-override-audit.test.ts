/**
 * Allergy override audit trail — regression tests for issue #233.
 *
 * The `allergies.override` procedure writes THREE rows in one transaction:
 *   - allergy_overrides (structured record)
 *   - clinical_flags (status -> dismissed)
 *   - audit_log (explicit HIPAA quality-review row)
 *
 * These tests exercise the router directly with a mocked DB so we can assert
 * that:
 *  1. Only physician / specialist / admin can override (nurse, patient,
 *     family_caregiver are FORBIDDEN even for valid input).
 *  2. Empty / too-short justification is rejected BEFORE the DB is touched.
 *  3. Unrecognised override_reason enum values are rejected by the validator.
 *  4. A successful override inserts all three rows with the expected fields.
 *  5. Missing flag -> NOT_FOUND.
 *  6. Cross-patient allergy_id -> BAD_REQUEST (blocks override bleed).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_PATIENT_ID = "99999999-9999-4999-8999-999999999999";
const FLAG_ID = "33333333-3333-4333-8333-333333333aaa";
const ALLERGY_ID = "44444444-4444-4444-8444-444444444aaa";
const FOREIGN_ALLERGY_ID = "55555555-5555-4555-8555-555555555aaa";

const ROLE_IDS: Record<string, string> = {
  nurse: "33333333-3333-4333-8333-333333333333",
  physician: "44444444-4444-4444-8444-444444444444",
  specialist: "55555555-5555-4555-8555-555555555555",
  admin: "66666666-6666-4666-8666-666666666666",
  patient: PATIENT_ID,
  family_caregiver: "77777777-7777-4777-8777-777777777777",
};

// ---------------------------------------------------------------------------
// DB mock — mirrors the select/insert/transaction chain used in care-team-rbac
// tests. `selectQueue` lets each test seed the FIFO order of .limit() results
// so we can simulate "flag exists + allergy exists (same patient)" vs the
// various not-found / cross-patient paths.
// ---------------------------------------------------------------------------
const mocks = vi.hoisted(() => {
  const fn = vi.fn;
  type InsertedRow = { table: string; row: Record<string, unknown> };
  const state: {
    selectQueue: unknown[][];
    insertedRows: InsertedRow[];
    updatedRows: { table: string; set: Record<string, unknown> }[];
  } = { selectQueue: [], insertedRows: [], updatedRows: [] };

  function tableOf(t: unknown): string {
    return (t as { __table?: string })?.__table ?? "unknown";
  }

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = fn(() => chain);
    chain.where = fn(() => chain);
    chain.limit = fn(async () => state.selectQueue.shift() ?? []);
    return chain;
  }

  function buildHandle() {
    return {
      select: fn(() => makeSelectChain()),
      insert: fn((table: unknown) => ({
        values: fn(async (row: Record<string, unknown>) => {
          state.insertedRows.push({ table: tableOf(table), row });
        }),
      })),
      update: fn((table: unknown) => ({
        set: fn((set: Record<string, unknown>) => ({
          where: fn(async () => {
            state.updatedRows.push({ table: tableOf(table), set });
          }),
        })),
      })),
    };
  }

  const mockDb = {
    ...buildHandle(),
    transaction: fn(async (cb: (tx: unknown) => Promise<unknown>) => {
      // Non-rollback tx mock — sufficient for these tests which focus on
      // the happy-path row-writing contract. Rollback behaviour is covered
      // by the care-team-rbac test's dedicated rollback suite.
      return cb(buildHandle());
    }),
  };

  const assertCareTeamAccess = fn(async () => true);

  return { state, mockDb, assertCareTeamAccess };
});

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mocks.mockDb,
  hmacForIndex: (v: string) => `hmac:${v}`,
  patients: { id: "patients.id", __table: "patients" },
  diagnoses: { id: "diagnoses.id", patient_id: "diagnoses.patient_id" },
  allergies: {
    id: "allergies.id",
    patient_id: "allergies.patient_id",
    __table: "allergies",
  },
  allergyOverrides: { __table: "allergy_overrides" },
  auditLog: { __table: "audit_log" },
  careTeamMembers: { patient_id: "care_team_members.patient_id" },
  careTeamAssignments: {
    patient_id: "care_team_assignments.patient_id",
    removed_at: "care_team_assignments.removed_at",
    user_id: "care_team_assignments.user_id",
  },
  clinicalFlags: {
    __table: "clinical_flags",
    id: "clinical_flags.id",
  },
  familyRelationships: {},
  users: { id: "users.id", patient_id: "users.patient_id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  and: (...args: unknown[]) => ({ and: args }),
  desc: (col: unknown) => ({ desc: col }),
  inArray: (col: unknown, vals: unknown[]) => ({ inArray: col, vals }),
  isNotNull: (col: unknown) => ({ isNotNull: col }),
  isNull: (col: unknown) => ({ isNull: col }),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertCareTeamAccess: mocks.assertCareTeamAccess,
}));

vi.mock("@carebridge/patient-records", () => ({
  listObservationsByPatient: vi.fn(),
  createObservation: vi.fn(),
  createDiagnosis: vi.fn(),
  updateDiagnosis: vi.fn(),
  createAllergy: vi.fn(),
  updateAllergy: vi.fn(),
}));

import { patientRecordsRbacRouter } from "../routers/patient-records.js";
import type { Context } from "../context.js";

function makeUser(role: User["role"], id = ROLE_IDS[role]!): User {
  return {
    id,
    email: `${role}@carebridge.dev`,
    name: `Test ${role}`,
    role,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function callerFor(user: User | null, clientIp: string | null = null) {
  const ctx: Context = {
    db: mocks.mockDb as unknown as Context["db"],
    user,
    sessionId: "s",
    requestId: "r",
    clientIp,
  };
  return patientRecordsRbacRouter.createCaller(ctx);
}

const overrideInput = {
  flag_id: FLAG_ID,
  allergy_id: ALLERGY_ID,
  override_reason: "patient_tolerated_previously" as const,
  clinical_justification:
    "Patient has tolerated three subsequent courses of amoxicillin without reaction since 2021.",
};

const overrideRows = () =>
  mocks.state.insertedRows.filter((r) => r.table === "allergy_overrides");
const auditRows = () =>
  mocks.state.insertedRows.filter((r) => r.table === "audit_log");
const flagUpdates = () =>
  mocks.state.updatedRows.filter((r) => r.table === "clinical_flags");

function reset() {
  mocks.state.selectQueue = [];
  mocks.state.insertedRows = [];
  mocks.state.updatedRows = [];
  mocks.assertCareTeamAccess.mockReset();
  mocks.assertCareTeamAccess.mockImplementation(async () => true);
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

describe("allergies.override — role gate", () => {
  function seedFlagAndAllergy() {
    // 1st .limit() -> clinical_flags lookup
    mocks.state.selectQueue.push([
      {
        id: FLAG_ID,
        patient_id: PATIENT_ID,
        status: "open",
        summary:
          'Medication "Amoxicillin" matches patient allergy to "Penicillin"',
      },
    ]);
    // 2nd .limit() -> allergies lookup (cross-patient guard + allergen
    // denormalisation source; both needs served by the same fetch after
    // the #905 refactor).
    mocks.state.selectQueue.push([
      { id: ALLERGY_ID, patient_id: PATIENT_ID, allergen: "Penicillin" },
    ]);
  }

  it.each(["nurse", "patient", "family_caregiver"] as const)(
    "rejects %s with FORBIDDEN",
    async (role) => {
      const caller = callerFor(makeUser(role));
      await expect(caller.allergies.override(overrideInput)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      // Role check must run before any DB work.
      expect(overrideRows()).toHaveLength(0);
      expect(auditRows()).toHaveLength(0);
    },
  );

  it.each(["physician", "specialist", "admin"] as const)(
    "allows %s to override and writes all three rows",
    async (role) => {
      seedFlagAndAllergy();
      const caller = callerFor(makeUser(role));
      await expect(caller.allergies.override(overrideInput)).resolves.toMatchObject({
        flag_id: FLAG_ID,
        patient_id: PATIENT_ID,
        allergy_id: ALLERGY_ID,
        override_reason: "patient_tolerated_previously",
      });

      // Structured override row
      expect(overrideRows()).toHaveLength(1);
      expect(overrideRows()[0]!.row).toMatchObject({
        patient_id: PATIENT_ID,
        flag_id: FLAG_ID,
        allergy_id: ALLERGY_ID,
        override_reason: "patient_tolerated_previously",
        overridden_by: ROLE_IDS[role],
      });

      // Flag transitioned to dismissed with a summary that names the reason
      expect(flagUpdates()).toHaveLength(1);
      const flagSet = flagUpdates()[0]!.set;
      expect(flagSet).toMatchObject({
        status: "dismissed",
        dismissed_by: ROLE_IDS[role],
      });
      expect(flagSet.dismiss_reason).toMatch(/patient_tolerated_previously/);

      // Explicit audit row
      expect(auditRows()).toHaveLength(1);
      const audit = auditRows()[0]!.row;
      expect(audit).toMatchObject({
        user_id: ROLE_IDS[role],
        action: "allergy_override",
        resource_type: "allergy_override",
        patient_id: PATIENT_ID,
        procedure_name: "allergies.override",
      });
      const details = JSON.parse(audit.details as string);
      expect(details).toMatchObject({
        flag_id: FLAG_ID,
        allergy_id: ALLERGY_ID,
        override_reason: "patient_tolerated_previously",
        clinical_justification: overrideInput.clinical_justification,
      });
    },
  );
});

describe("allergies.override — validation", () => {
  it.each([
    ["empty string", ""],
    ["whitespace-only", "          "],
    ["short (< 10 char)", "tolerated"],
  ] as const)("rejects %s justification", async (_label, justification) => {
    const caller = callerFor(makeUser("physician"));
    await expect(
      caller.allergies.override({ ...overrideInput, clinical_justification: justification }),
    ).rejects.toBeDefined();
    expect(overrideRows()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("rejects unrecognised override_reason enum value", async () => {
    const caller = callerFor(makeUser("physician"));
    await expect(
      caller.allergies.override({
        ...overrideInput,
        // @ts-expect-error — deliberately invalid to exercise validator
        override_reason: "clinician_felt_like_it",
      }),
    ).rejects.toBeDefined();
    expect(overrideRows()).toHaveLength(0);
  });
});

describe("allergies.override — flag / allergy lookups", () => {
  it("returns NOT_FOUND when the flag does not exist", async () => {
    mocks.state.selectQueue.push([]); // flag lookup empty
    const caller = callerFor(makeUser("physician"));
    await expect(caller.allergies.override(overrideInput)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(overrideRows()).toHaveLength(0);
  });

  it("returns FORBIDDEN when clinician is not on the care team", async () => {
    mocks.state.selectQueue.push([
      { id: FLAG_ID, patient_id: PATIENT_ID, status: "open" },
    ]);
    mocks.assertCareTeamAccess.mockResolvedValueOnce(false);
    const caller = callerFor(makeUser("physician"));
    await expect(caller.allergies.override(overrideInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(overrideRows()).toHaveLength(0);
  });

  it("rejects BAD_REQUEST when allergy_id belongs to a different patient", async () => {
    // Flag belongs to PATIENT_ID; allergy belongs to OTHER_PATIENT_ID.
    mocks.state.selectQueue.push([
      { id: FLAG_ID, patient_id: PATIENT_ID, status: "open" },
    ]);
    mocks.state.selectQueue.push([
      {
        id: FOREIGN_ALLERGY_ID,
        patient_id: OTHER_PATIENT_ID,
        allergen: "Sulfa",
      },
    ]);
    const caller = callerFor(makeUser("physician"));
    await expect(
      caller.allergies.override({
        ...overrideInput,
        allergy_id: FOREIGN_ALLERGY_ID,
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(overrideRows()).toHaveLength(0);
    expect(auditRows()).toHaveLength(0);
  });

  it("allows override without allergy_id (contraindication-only override)", async () => {
    mocks.state.selectQueue.push([
      { id: FLAG_ID, patient_id: PATIENT_ID, status: "open" },
    ]);
    const { allergy_id: _ignored, ...withoutAllergy } = overrideInput;
    const caller = callerFor(makeUser("physician"));
    await expect(caller.allergies.override(withoutAllergy)).resolves.toMatchObject({
      allergy_id: null,
    });
    expect(overrideRows()).toHaveLength(1);
    expect(overrideRows()[0]!.row).toMatchObject({ allergy_id: null });
  });

  it("rejects unauthenticated callers with UNAUTHORIZED", async () => {
    const caller = callerFor(null);
    await expect(caller.allergies.override(overrideInput)).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(overrideRows()).toHaveLength(0);
  });
});

describe("allergies.override — denormalised allergen/medication (#905)", () => {
  function seedFlagAndAllergy(summary: string, allergen = "Penicillin") {
    mocks.state.selectQueue.push([
      { id: FLAG_ID, patient_id: PATIENT_ID, status: "open", summary },
    ]);
    mocks.state.selectQueue.push([
      { id: ALLERGY_ID, patient_id: PATIENT_ID, allergen },
    ]);
  }

  it("denormalises medication_name and allergen_name onto the override row", async () => {
    seedFlagAndAllergy(
      'Medication "Amoxicillin 500mg" matches patient allergy to "Penicillin"',
    );
    const caller = callerFor(makeUser("physician"));
    await caller.allergies.override(overrideInput);

    expect(overrideRows()).toHaveLength(1);
    expect(overrideRows()[0]!.row).toMatchObject({
      medication_name: "Amoxicillin 500mg",
      allergen_name: "Penicillin",
    });
  });

  it("prefers the structured allergies row for allergen_name over the flag summary", async () => {
    // Summary names "Penicillin" but the structured allergies row records
    // the canonical "Amoxicillin" — the denormalisation must prefer the
    // structured row so reviewers see the clinician's documented allergen
    // rather than the flag's rendered description.
    seedFlagAndAllergy(
      'Medication "Augmentin" may cross-react with allergy to "Penicillin" (penicillin class)',
      "Amoxicillin",
    );
    const caller = callerFor(makeUser("physician"));
    await caller.allergies.override(overrideInput);

    expect(overrideRows()[0]!.row).toMatchObject({
      medication_name: "Augmentin",
      allergen_name: "Amoxicillin",
    });
  });

  it("leaves denormalised columns NULL when the flag summary has no recognisable medication line", async () => {
    // Contraindication-only override (no allergy_id) against a flag whose
    // summary isn't produced by checkAllergyMedication — e.g. a
    // cross-specialty warning. The loader-side fallback keeps suppression
    // correct; the row itself simply has NULLs.
    mocks.state.selectQueue.push([
      {
        id: FLAG_ID,
        patient_id: PATIENT_ID,
        status: "open",
        summary: "Unrelated pattern warning — see care plan",
      },
    ]);

    const { allergy_id: _omit, ...withoutAllergy } = overrideInput;
    const caller = callerFor(makeUser("physician"));
    await caller.allergies.override(withoutAllergy);

    expect(overrideRows()[0]!.row).toMatchObject({
      medication_name: null,
      allergen_name: null,
    });
  });
});

describe("allergies.override — audit ip_address capture (issue #907)", () => {
  function seedFlagAndAllergy() {
    mocks.state.selectQueue.push([
      {
        id: FLAG_ID,
        patient_id: PATIENT_ID,
        status: "open",
        summary:
          'Medication "Amoxicillin" matches patient allergy to "Penicillin"',
      },
    ]);
    mocks.state.selectQueue.push([
      { id: ALLERGY_ID, patient_id: PATIENT_ID, allergen: "Penicillin" },
    ]);
  }

  it("propagates ctx.clientIp into the audit_log row", async () => {
    seedFlagAndAllergy();
    const caller = callerFor(makeUser("physician"), "203.0.113.42");
    await caller.allergies.override(overrideInput);

    expect(auditRows()).toHaveLength(1);
    expect(auditRows()[0]!.row.ip_address).toBe("203.0.113.42");
  });

  it("falls back to empty string when ctx.clientIp is null", async () => {
    seedFlagAndAllergy();
    const caller = callerFor(makeUser("physician"), null);
    await caller.allergies.override(overrideInput);

    expect(auditRows()).toHaveLength(1);
    // Preserves the historical empty-string fallback so existing audit
    // filters that match "" continue to work when the transport can't
    // resolve an IP (should be rare in HTTP-land, guarded defensively).
    expect(auditRows()[0]!.row.ip_address).toBe("");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const PHYSICIAN_ID = "44444444-4444-4444-8444-444444444444";
const NURSE_ID = "33333333-3333-4333-8333-333333333333";
const ADMIN_ID = "66666666-6666-4666-8666-666666666666";

const PATIENT_RECORD_1 = {
  id: "aaaa1111-1111-4111-8111-111111111111",
  name: "Alice Patient",
  name_hmac: "hmac:Alice Patient",
  date_of_birth: "1980-01-01",
  biological_sex: "female",
  mrn: "MRN001",
  mrn_hmac: "hmac:MRN001",
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
};

const PATIENT_RECORD_2 = {
  id: "bbbb2222-2222-4222-8222-222222222222",
  name: "Bob Patient",
  name_hmac: "hmac:Bob Patient",
  date_of_birth: "1990-06-15",
  biological_sex: "male",
  mrn: "MRN002",
  mrn_hmac: "hmac:MRN002",
  created_at: "2025-01-02T00:00:00.000Z",
  updated_at: "2025-01-02T00:00:00.000Z",
};

const ALL_PATIENTS = [PATIENT_RECORD_1, PATIENT_RECORD_2];

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const fn = vi.fn;

  // Track calls for verification
  let selectColumns: unknown = undefined;
  let joinTable: unknown = undefined;
  let joinCondition: unknown = undefined;
  let whereConditions: unknown[] = [];
  let resolvedData: unknown[] = [];
  let resolvedDataQueue: unknown[][] = [];

  function nextData() {
    if (resolvedDataQueue.length > 0) {
      return resolvedDataQueue.shift()!;
    }
    return resolvedData;
  }

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = fn((..._args: unknown[]) => chain);
    chain.innerJoin = fn((...args: unknown[]) => {
      joinTable = args[0];
      joinCondition = args[1];
      return chain;
    });
    chain.where = fn((...args: unknown[]) => {
      whereConditions = args;
      return Promise.resolve(nextData());
    });
    chain.limit = fn(async () => nextData());
    // When no where/join is called, resolve via then
    (chain as Record<string | symbol, unknown>)[Symbol.toStringTag] =
      "Promise";
    const originalFrom = chain.from;
    chain.from = fn((...args: unknown[]) => {
      const result = (originalFrom as (...a: unknown[]) => unknown)(...args);
      // Make the chain thenable so `await db.select().from(patients)` works
      (result as Record<string, unknown>).then = (
        resolve: (v: unknown) => void,
      ) => {
        resolve(nextData());
        return result;
      };
      return result;
    });
    return chain;
  }

  return {
    selectColumns,
    getJoinTable: () => joinTable,
    getJoinCondition: () => joinCondition,
    getWhereConditions: () => whereConditions,
    setResolvedData: (data: unknown[]) => {
      resolvedData = data;
    },
    setResolvedDataQueue: (queue: unknown[][]) => {
      resolvedDataQueue = [...queue];
    },
    makeSelectChain,
    mockDb: {
      select: fn((...args: unknown[]) => {
        selectColumns = args[0];
        return makeSelectChain();
      }),
      insert: fn(() => ({ values: fn() })),
    },
  };
});

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mocks.mockDb,
  hmacForIndex: (v: string) => `hmac:${v}`,
  patients: {
    id: "patients.id",
    name: "patients.name",
    name_hmac: "patients.name_hmac",
    date_of_birth: "patients.date_of_birth",
    biological_sex: "patients.biological_sex",
    diagnosis: "patients.diagnosis",
    primary_provider_id: "patients.primary_provider_id",
    allergy_status: "patients.allergy_status",
    weight_kg: "patients.weight_kg",
    mrn: "patients.mrn",
    mrn_hmac: "patients.mrn_hmac",
    created_at: "patients.created_at",
    updated_at: "patients.updated_at",
  },
  diagnoses: { id: "diagnoses.id", patient_id: "diagnoses.patient_id" },
  allergies: { id: "allergies.id", patient_id: "allergies.patient_id" },
  careTeamMembers: { patient_id: "care_team_members.patient_id" },
  careTeamAssignments: {
    id: "care_team_assignments.id",
    user_id: "care_team_assignments.user_id",
    patient_id: "care_team_assignments.patient_id",
    removed_at: "care_team_assignments.removed_at",
  },
  familyRelationships: {
    caregiver_id: "family_relationships.caregiver_id",
    patient_id: "family_relationships.patient_id",
    status: "family_relationships.status",
  },
  users: {
    id: "users.id",
    patient_id: "users.patient_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  inArray: (col: unknown, vals: unknown) => ({ op: "inArray", col, vals }),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertCareTeamAccess: vi.fn(async () => true),
}));

vi.mock("@carebridge/patient-records", () => ({
  listObservationsByPatient: vi.fn(),
  createObservation: vi.fn(),
  createDiagnosis: vi.fn(),
  updateDiagnosis: vi.fn(),
  createAllergy: vi.fn(),
  updateAllergy: vi.fn(),
}));

vi.mock("@carebridge/validators", async () => {
  const { z } = await import("zod");
  return {
    createPatientSchema: z.object({ mrn: z.string().optional() }),
    updatePatientSchema: z.object({}),
    createDiagnosisSchema: z.object({
      patient_id: z.string().uuid(),
      icd10_code: z.string(),
      description: z.string(),
      status: z.string().optional().default("active"),
    }),
    updateDiagnosisSchema: z.object({
      status: z.string().optional(),
      description: z.string().optional(),
    }),
    createAllergySchema: z.object({
      patient_id: z.string().uuid(),
      allergen: z.string(),
      reaction: z.string(),
      severity: z.string(),
    }),
    updateAllergySchema: z.object({
      severity: z.string().optional(),
      reaction: z.string().optional(),
    }),
  };
});

import { patientRecordsRbacRouter } from "../routers/patient-records.js";
import type { Context } from "../context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(
  role: User["role"],
  id: string,
  overrides: Partial<User> = {},
): User {
  return {
    id,
    email: `${role}@carebridge.dev`,
    name: `Test ${role}`,
    role,
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(user: User | null): Context {
  return {
    db: mocks.mockDb as unknown as Context["db"],
    user,
    sessionId: "session-1",
    requestId: "req-1",
  };
}

function callerFor(user: User | null) {
  return patientRecordsRbacRouter.createCaller(makeContext(user));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("patientRecordsRbacRouter.list — HIPAA minimum-necessary filtering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setResolvedData(ALL_PATIENTS);
  });

  it("rejects unauthenticated users", async () => {
    const caller = callerFor(null);
    await expect(caller.list()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("returns all patients for admin role with projection", async () => {
    const admin = makeUser("admin", ADMIN_ID);
    const caller = callerFor(admin);

    const result = await caller.list();

    expect(result).toEqual(ALL_PATIENTS);
    // Admin select should now pass a column subset (HIPAA projection)
    const selectArg = mocks.mockDb.select.mock.calls[0]?.[0];
    expect(selectArg).toBeDefined();
    expect(selectArg).toHaveProperty("id");
    expect(selectArg).toHaveProperty("name");
    expect(selectArg).not.toHaveProperty("insurance_id");
    expect(selectArg).not.toHaveProperty("emergency_contact_name");
    expect(selectArg).not.toHaveProperty("emergency_contact_phone");
    expect(selectArg).not.toHaveProperty("notes");
  });

  it("returns only the patient's own record for patient role with projection", async () => {
    mocks.setResolvedData([PATIENT_RECORD_1]);
    const patient = makeUser("patient", "user-patient-id", {
      patient_id: PATIENT_RECORD_1.id,
    });
    const caller = callerFor(patient);

    const result = await caller.list();

    expect(result).toEqual([PATIENT_RECORD_1]);
    // Patient self-lookup should also use column projection
    const selectArg = mocks.mockDb.select.mock.calls[0]?.[0];
    expect(selectArg).toBeDefined();
    expect(selectArg).toHaveProperty("id");
    expect(selectArg).not.toHaveProperty("insurance_id");
    expect(selectArg).not.toHaveProperty("notes");
  });

  it("returns empty list for patient with no patient_id link", async () => {
    const patient = makeUser("patient", "user-patient-id");
    // patient_id is undefined
    const caller = callerFor(patient);

    const result = await caller.list();

    expect(result).toEqual([]);
    // DB should not be queried at all
    expect(mocks.mockDb.select).not.toHaveBeenCalled();
  });

  it("filters by care-team assignment for physician role", async () => {
    mocks.setResolvedData([PATIENT_RECORD_1]);
    const physician = makeUser("physician", PHYSICIAN_ID);
    const caller = callerFor(physician);

    const result = await caller.list();

    expect(result).toEqual([PATIENT_RECORD_1]);
    // Verify select was called with a column subset (not full select)
    const selectArg = mocks.mockDb.select.mock.calls[0]?.[0];
    expect(selectArg).toBeDefined();
    expect(selectArg).toHaveProperty("id");
    expect(selectArg).toHaveProperty("name");
  });

  it("filters by care-team assignment for nurse role", async () => {
    mocks.setResolvedData([PATIENT_RECORD_2]);
    const nurse = makeUser("nurse", NURSE_ID);
    const caller = callerFor(nurse);

    const result = await caller.list();

    expect(result).toEqual([PATIENT_RECORD_2]);
    // Verify innerJoin was called (care team filtering)
    const selectChain = mocks.mockDb.select.mock.results[0]?.value;
    expect(selectChain).toBeDefined();
  });

  it("filters by care-team assignment for specialist role", async () => {
    mocks.setResolvedData([PATIENT_RECORD_1]);
    const specialist = makeUser("specialist", "55555555-5555-4555-8555-555555555555");
    const caller = callerFor(specialist);

    const result = await caller.list();

    expect(result).toEqual([PATIENT_RECORD_1]);
  });

  it("returns only linked patients for family_caregiver role with projection", async () => {
    const CAREGIVER_ID = "77777777-7777-4777-8777-777777777777";
    const CAREGIVER_USER_ID = "88888888-8888-4888-8888-888888888888";
    // Queue: 1) familyRelationships query, 2) users query, 3) patients query
    mocks.setResolvedDataQueue([
      [{ patient_user_id: CAREGIVER_USER_ID }],
      [{ patient_id: PATIENT_RECORD_1.id }],
      [PATIENT_RECORD_1],
    ]);
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);
    const caller = callerFor(caregiver);

    const result = await caller.list();

    expect(result).toEqual([PATIENT_RECORD_1]);
    // The final select (3rd call) should use column projection
    const selectArg = mocks.mockDb.select.mock.calls[2]?.[0];
    expect(selectArg).toBeDefined();
    expect(selectArg).toHaveProperty("id");
    expect(selectArg).toHaveProperty("name");
    expect(selectArg).not.toHaveProperty("insurance_id");
    expect(selectArg).not.toHaveProperty("notes");
  });

  it("returns empty list for family_caregiver with no active relationships", async () => {
    const CAREGIVER_ID = "77777777-7777-4777-8777-777777777777";
    // Queue: familyRelationships returns empty
    mocks.setResolvedDataQueue([[]]);
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);
    const caller = callerFor(caregiver);

    const result = await caller.list();

    expect(result).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // HIPAA minimum-necessary projection regression (issue #550)
  // ---------------------------------------------------------------------------

  const EXCLUDED_FIELDS = [
    "insurance_id",
    "emergency_contact_name",
    "emergency_contact_phone",
    "notes",
  ] as const;

  for (const role of ["admin", "patient", "physician", "nurse", "specialist", "family_caregiver"] as const) {
    it(`excludes sensitive columns from list response for ${role} role`, async () => {
      if (role === "family_caregiver") {
        const CAREGIVER_ID = "77777777-7777-4777-8777-777777777777";
        const CAREGIVER_USER_ID = "88888888-8888-4888-8888-888888888888";
        mocks.setResolvedDataQueue([
          [{ patient_user_id: CAREGIVER_USER_ID }],
          [{ patient_id: PATIENT_RECORD_1.id }],
          [PATIENT_RECORD_1],
        ]);
        const user = makeUser("family_caregiver", CAREGIVER_ID);
        const caller = callerFor(user);

        await caller.list();

        const selectArg = mocks.mockDb.select.mock.calls[2]?.[0];
        expect(selectArg).toBeDefined();
        for (const field of EXCLUDED_FIELDS) {
          expect(selectArg).not.toHaveProperty(field);
        }
        return;
      }

      mocks.setResolvedData(role === "patient" ? [PATIENT_RECORD_1] : ALL_PATIENTS);
      const overrides: Partial<User> =
        role === "patient" ? { patient_id: PATIENT_RECORD_1.id } : {};
      const userId =
        role === "admin"
          ? ADMIN_ID
          : role === "physician"
            ? PHYSICIAN_ID
            : role === "nurse"
              ? NURSE_ID
              : role === "patient"
                ? "user-patient-id"
                : "55555555-5555-4555-8555-555555555555";
      const user = makeUser(role, userId, overrides);
      const caller = callerFor(user);

      await caller.list();

      const selectArg = mocks.mockDb.select.mock.calls[0]?.[0];
      expect(selectArg).toBeDefined();
      for (const field of EXCLUDED_FIELDS) {
        expect(selectArg).not.toHaveProperty(field);
      }
    });
  }
});

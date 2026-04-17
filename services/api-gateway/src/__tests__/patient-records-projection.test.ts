import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PATIENT_ID = "aaaa1111-1111-4111-8111-111111111111";
const PHYSICIAN_ID = "44444444-4444-4444-8444-444444444444";

/**
 * Full patient row as it would exist in the database — includes the sensitive
 * columns that the projection must strip out.
 */
const FULL_PATIENT_ROW = {
  id: PATIENT_ID,
  name: "Alice Patient",
  name_hmac: "hmac:Alice Patient",
  date_of_birth: "1980-01-01",
  biological_sex: "female",
  diagnosis: "DVT",
  mrn: "MRN001",
  mrn_hmac: "hmac:MRN001",
  primary_provider_id: "provider-1",
  allergy_status: "NKDA",
  weight_kg: 70,
  created_at: "2025-01-01T00:00:00.000Z",
  updated_at: "2025-01-01T00:00:00.000Z",
  // Sensitive fields that must NOT be returned
  insurance_id: "INS-9876",
  emergency_contact_name: "Bob Patient",
  emergency_contact_phone: "555-0100",
  notes: "Private clinical notes — PHI",
};

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  const fn = vi.fn;

  let selectColumns: Record<string, unknown> | undefined = undefined;
  let resolvedData: unknown[] = [];

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = fn((..._args: unknown[]) => chain);
    chain.innerJoin = fn((..._args: unknown[]) => chain);
    chain.where = fn((..._args: unknown[]) => {
      // Return projected rows: if selectColumns is set, filter each row
      // down to only those keys so the mock faithfully simulates Drizzle
      // column selection.
      if (selectColumns) {
        const keys = Object.keys(selectColumns);
        return Promise.resolve(
          resolvedData.map((row) => {
            const out: Record<string, unknown> = {};
            for (const k of keys) {
              out[k] = (row as Record<string, unknown>)[k];
            }
            return out;
          }),
        );
      }
      return Promise.resolve(resolvedData);
    });
    chain.limit = fn(async () => resolvedData);
    // Make the chain thenable for bare `await db.select().from()`
    (chain as Record<string | symbol, unknown>)[Symbol.toStringTag] = "Promise";
    const originalFrom = chain.from;
    chain.from = fn((...args: unknown[]) => {
      const result = (originalFrom as (...a: unknown[]) => unknown)(...args);
      (result as Record<string, unknown>).then = (
        resolve: (v: unknown) => void,
      ) => {
        resolve(resolvedData);
        return result;
      };
      return result;
    });
    return chain;
  }

  return {
    getSelectColumns: () => selectColumns,
    setResolvedData: (data: unknown[]) => {
      resolvedData = data;
    },
    makeSelectChain,
    mockDb: {
      select: fn((...args: unknown[]) => {
        selectColumns = args[0] as Record<string, unknown> | undefined;
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
    mrn: "patients.mrn",
    mrn_hmac: "patients.mrn_hmac",
    primary_provider_id: "patients.primary_provider_id",
    allergy_status: "patients.allergy_status",
    weight_kg: "patients.weight_kg",
    created_at: "patients.created_at",
    updated_at: "patients.updated_at",
    insurance_id: "patients.insurance_id",
    emergency_contact_name: "patients.emergency_contact_name",
    emergency_contact_phone: "patients.emergency_contact_phone",
    notes: "patients.notes",
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
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: "inArray", col, vals }),
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

const SENSITIVE_FIELDS = [
  "insurance_id",
  "emergency_contact_name",
  "emergency_contact_phone",
  "notes",
] as const;

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
// Tests — getById projection
// ---------------------------------------------------------------------------

describe("patients.getById — HIPAA minimum-necessary projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setResolvedData([FULL_PATIENT_ROW]);
  });

  it("returns projected clinical fields", async () => {
    const physician = makeUser("physician", PHYSICIAN_ID);
    const caller = callerFor(physician);

    const result = await caller.getById({ id: PATIENT_ID });

    expect(result).not.toBeNull();
    const keys = Object.keys(result!);
    const expected = [
      "id",
      "name",
      "name_hmac",
      "mrn",
      "date_of_birth",
      "biological_sex",
      "diagnosis",
      "allergy_status",
      "weight_kg",
      "primary_provider_id",
      "mrn_hmac",
      "created_at",
      "updated_at",
    ];
    for (const field of expected) {
      expect(keys, `expected field "${field}" to be present`).toContain(field);
    }
  });

  it("does NOT return insurance_id, emergency_contact_name, emergency_contact_phone, or notes", async () => {
    const physician = makeUser("physician", PHYSICIAN_ID);
    const caller = callerFor(physician);

    const result = await caller.getById({ id: PATIENT_ID });

    expect(result).not.toBeNull();
    const keys = Object.keys(result!);
    for (const field of SENSITIVE_FIELDS) {
      expect(keys, `sensitive field "${field}" must not be returned`).not.toContain(field);
    }
  });

  it("passes an explicit column map to db.select()", async () => {
    const physician = makeUser("physician", PHYSICIAN_ID);
    const caller = callerFor(physician);

    await caller.getById({ id: PATIENT_ID });

    const selectCols = mocks.getSelectColumns();
    expect(selectCols).toBeDefined();
    expect(selectCols).toHaveProperty("id");
    expect(selectCols).toHaveProperty("name");
    // Sensitive columns must be absent from the projection
    for (const field of SENSITIVE_FIELDS) {
      expect(selectCols).not.toHaveProperty(field);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests — getSummary projection
// ---------------------------------------------------------------------------

describe("patients.getSummary — minimum-necessary summary projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.setResolvedData([FULL_PATIENT_ROW]);
  });

  it("returns exactly { id, name, mrn }", async () => {
    const physician = makeUser("physician", PHYSICIAN_ID);
    const caller = callerFor(physician);

    const result = await caller.getSummary({ id: PATIENT_ID });

    expect(result).not.toBeNull();
    expect(Object.keys(result!).sort()).toEqual(["id", "mrn", "name"]);
    expect(result).toEqual({
      id: PATIENT_ID,
      name: "Alice Patient",
      mrn: "MRN001",
    });
  });

  it("does NOT return sensitive or clinical-detail fields", async () => {
    const physician = makeUser("physician", PHYSICIAN_ID);
    const caller = callerFor(physician);

    const result = await caller.getSummary({ id: PATIENT_ID });

    expect(result).not.toBeNull();
    const keys = Object.keys(result!);
    const forbidden = [
      ...SENSITIVE_FIELDS,
      "date_of_birth",
      "biological_sex",
      "diagnosis",
      "weight_kg",
      "allergy_status",
      "primary_provider_id",
    ];
    for (const field of forbidden) {
      expect(keys, `field "${field}" must not be in summary`).not.toContain(field);
    }
  });

  it("passes a column map with only id, name, mrn to db.select()", async () => {
    const physician = makeUser("physician", PHYSICIAN_ID);
    const caller = callerFor(physician);

    await caller.getSummary({ id: PATIENT_ID });

    const selectCols = mocks.getSelectColumns();
    expect(selectCols).toBeDefined();
    expect(Object.keys(selectCols!).sort()).toEqual(["id", "mrn", "name"]);
  });
});

/**
 * Server-side tests for family_caregiver read access (issue #329).
 *
 * Verifies that:
 *  - enforcePatientAccess grants reads for a caregiver with an active
 *    family_relationships row joined through users.patient_id.
 *  - enforcePatientAccess rejects a caregiver with no active link.
 *  - patients.getMyPatients returns the linked patient set (with
 *    relationship_type) for caregivers and a single "self" row for patients.
 *  - observations.create is denied for caregivers even when they otherwise
 *    have access to the patient record.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

const CAREGIVER_USER_ID = "77777777-7777-4777-8777-777777777777";
const LINKED_PATIENT_USER_ID = "11111111-1111-4111-8111-111111111111";
const LINKED_PATIENT_RECORD_ID = "aaaa1111-1111-4111-8111-111111111111";
const OTHER_PATIENT_RECORD_ID = "bbbb2222-2222-4222-8222-222222222222";

const mocks = vi.hoisted(() => {
  let queue: unknown[][] = [];

  function makeChain() {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    // where() returns a thenable so `await db.select().from().where()` works,
    // but also still exposes .limit() for chains that terminate with a limit.
    chain.where = vi.fn(() => {
      const next = queue.shift() ?? [];
      // Build a thenable wrapper that also carries a .limit() method.
      const wrapper: Record<string, unknown> = {
        then: (resolve: (v: unknown) => void) => {
          resolve(next);
          return wrapper;
        },
        limit: vi.fn(async () => next),
      };
      return wrapper;
    });
    chain.limit = vi.fn(async () => queue.shift() ?? []);
    return chain;
  }

  const mockDb = {
    select: vi.fn(() => makeChain()),
    insert: vi.fn(() => ({ values: vi.fn() })),
  };

  return {
    mockDb,
    setQueue: (q: unknown[][]) => {
      queue = [...q];
    },
  };
});

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mocks.mockDb,
  hmacForIndex: (v: string) => `hmac:${v}`,
  patients: {
    id: "patients.id",
    name: "patients.name",
    mrn: "patients.mrn",
    name_hmac: "patients.name_hmac",
    date_of_birth: "patients.date_of_birth",
    biological_sex: "patients.biological_sex",
    diagnosis: "patients.diagnosis",
    primary_provider_id: "patients.primary_provider_id",
    allergy_status: "patients.allergy_status",
    weight_kg: "patients.weight_kg",
    mrn_hmac: "patients.mrn_hmac",
    created_at: "patients.created_at",
    updated_at: "patients.updated_at",
  },
  diagnoses: { id: "diagnoses.id", patient_id: "diagnoses.patient_id" },
  allergies: { id: "allergies.id", patient_id: "allergies.patient_id" },
  allergyOverrides: { id: "allergy_overrides.id" },
  auditLog: {},
  clinicalFlags: { id: "clinical_flags.id" },
  careTeamMembers: { patient_id: "care_team_members.patient_id" },
  careTeamAssignments: {
    id: "care_team_assignments.id",
    user_id: "care_team_assignments.user_id",
    patient_id: "care_team_assignments.patient_id",
    removed_at: "care_team_assignments.removed_at",
  },
  familyRelationships: {
    id: "family_relationships.id",
    caregiver_id: "family_relationships.caregiver_id",
    patient_id: "family_relationships.patient_id",
    relationship_type: "family_relationships.relationship_type",
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
  desc: (col: unknown) => ({ op: "desc", col }),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertCareTeamAccess: vi.fn(async () => false),
}));

vi.mock("@carebridge/patient-records", () => ({
  listObservationsByPatient: vi.fn(async () => []),
  createObservation: vi.fn(async (input: unknown) => ({
    id: "obs-1",
    ...(input as Record<string, unknown>),
  })),
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
    overrideAllergyFlagSchema: z.object({
      flag_id: z.string().uuid(),
      allergy_id: z.string().uuid().optional(),
      override_reason: z.enum([
        "mild_reaction_ok",
        "patient_tolerated_previously",
        "benefit_exceeds_risk",
        "desensitized",
        "misdiagnosed_allergy",
        "other",
      ]),
      clinical_justification: z.string().trim().min(10).max(2000),
    }),
  };
});

import { patientRecordsRbacRouter } from "../routers/patient-records.js";
import type { Context } from "../context.js";

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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function callerFor(user: User | null) {
  const ctx: Context = {
    db: mocks.mockDb as unknown as Context["db"],
    user,
    sessionId: "session-1",
    requestId: "req-1",
  };
  return patientRecordsRbacRouter.createCaller(ctx);
}

describe("enforcePatientAccess — family_caregiver", () => {
  beforeEach(() => vi.clearAllMocks());

  it("grants observations.getByPatient to a caregiver with an active link", async () => {
    // limit() for the family_relationships join => row found
    // then createObservation / list runs without another DB call we care about
    mocks.setQueue([
      [{ id: "rel-1" }], // family link lookup
    ]);
    const caregiver = makeUser("family_caregiver", CAREGIVER_USER_ID);
    const caller = callerFor(caregiver);

    await expect(
      caller.observations.getByPatient({
        patientId: LINKED_PATIENT_RECORD_ID,
        limit: 20,
      }),
    ).resolves.toEqual([]);
  });

  it("denies observations.getByPatient to a caregiver with no active link", async () => {
    mocks.setQueue([
      [], // family link lookup => empty
    ]);
    const caregiver = makeUser("family_caregiver", CAREGIVER_USER_ID);
    const caller = callerFor(caregiver);

    await expect(
      caller.observations.getByPatient({
        patientId: OTHER_PATIENT_RECORD_ID,
        limit: 20,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("denies observations.create for family_caregiver even with active link", async () => {
    // Server-side block is explicit for family_caregiver — must happen
    // BEFORE the access check, so no DB lookups are expected.
    const caregiver = makeUser("family_caregiver", CAREGIVER_USER_ID);
    const caller = callerFor(caregiver);

    await expect(
      caller.observations.create({
        patientId: LINKED_PATIENT_RECORD_ID,
        observationType: "pain",
        description: "test",
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/caregiver/i),
    });
  });
});

describe("patients.getMyPatients", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a single self-relationship row for a patient user", async () => {
    const patientUser = makeUser("patient", "patient-user-1", {
      patient_id: LINKED_PATIENT_RECORD_ID,
    });
    mocks.setQueue([
      [
        {
          id: LINKED_PATIENT_RECORD_ID,
          name: "Jane Doe",
          mrn: "MRN001",
        },
      ],
    ]);
    const caller = callerFor(patientUser);
    const result = await caller.getMyPatients();

    expect(result).toEqual([
      {
        id: LINKED_PATIENT_RECORD_ID,
        name: "Jane Doe",
        mrn: "MRN001",
        relationship: "self",
      },
    ]);
  });

  it("returns empty list for a patient user with no patient_id link", async () => {
    const patientUser = makeUser("patient", "patient-user-1");
    const caller = callerFor(patientUser);
    const result = await caller.getMyPatients();
    expect(result).toEqual([]);
  });

  it("returns linked patients with relationship_type for a caregiver", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_USER_ID);
    mocks.setQueue([
      // 1) family_relationships rows
      [
        {
          patient_user_id: LINKED_PATIENT_USER_ID,
          relationship_type: "spouse",
        },
      ],
      // 2) users rows with patient_id
      [{ id: LINKED_PATIENT_USER_ID, patient_id: LINKED_PATIENT_RECORD_ID }],
      // 3) patients rows (minimum-necessary projection: id, name, mrn)
      [
        {
          id: LINKED_PATIENT_RECORD_ID,
          name: "Jane Doe",
          mrn: "MRN001",
        },
      ],
    ]);

    const caller = callerFor(caregiver);
    const result = await caller.getMyPatients();

    expect(result).toEqual([
      {
        id: LINKED_PATIENT_RECORD_ID,
        name: "Jane Doe",
        mrn: "MRN001",
        relationship: "spouse",
      },
    ]);
  });

  it("returns multiple rows when a caregiver represents multiple patients", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_USER_ID);
    const SECOND_PATIENT_USER_ID = "22222222-2222-4222-8222-222222222222";

    mocks.setQueue([
      [
        {
          patient_user_id: LINKED_PATIENT_USER_ID,
          relationship_type: "parent",
        },
        {
          patient_user_id: SECOND_PATIENT_USER_ID,
          relationship_type: "child",
        },
      ],
      [
        { id: LINKED_PATIENT_USER_ID, patient_id: LINKED_PATIENT_RECORD_ID },
        { id: SECOND_PATIENT_USER_ID, patient_id: OTHER_PATIENT_RECORD_ID },
      ],
      [
        { id: LINKED_PATIENT_RECORD_ID, name: "Mom", mrn: "MRN001" },
        { id: OTHER_PATIENT_RECORD_ID, name: "Kid", mrn: "MRN002" },
      ],
    ]);

    const caller = callerFor(caregiver);
    const result = await caller.getMyPatients();

    expect(result).toHaveLength(2);
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: LINKED_PATIENT_RECORD_ID,
          relationship: "parent",
        }),
        expect.objectContaining({
          id: OTHER_PATIENT_RECORD_ID,
          relationship: "child",
        }),
      ]),
    );
  });

  it("returns empty list when a caregiver has no active relationships", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_USER_ID);
    mocks.setQueue([[]]);
    const caller = callerFor(caregiver);
    const result = await caller.getMyPatients();
    expect(result).toEqual([]);
  });

  it("returns empty list for admins and clinicians (patient portal only)", async () => {
    for (const role of ["admin", "nurse", "physician", "specialist"] as const) {
      mocks.setQueue([]);
      const caller = callerFor(makeUser(role, `${role}-id`));
      const result = await caller.getMyPatients();
      expect(result).toEqual([]);
    }
  });
});

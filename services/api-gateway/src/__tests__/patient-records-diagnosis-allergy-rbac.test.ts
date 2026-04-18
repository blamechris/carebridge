import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

// ---------------------------------------------------------------------------
// Mocks — vi.hoisted ensures these are available when vi.mock factories run
// ---------------------------------------------------------------------------

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const DIAGNOSIS_ID = "aaaa1111-1111-4111-8111-111111111111";
const ALLERGY_ID = "bbbb1111-1111-4111-8111-111111111111";
const ROLE_IDS: Record<string, string> = {
  nurse: "33333333-3333-4333-8333-333333333333",
  physician: "44444444-4444-4444-8444-444444444444",
  specialist: "55555555-5555-4555-8555-555555555555",
  admin: "66666666-6666-4666-8666-666666666666",
  patient: PATIENT_ID,
  family_caregiver: "77777777-7777-4777-8777-777777777777",
};

const mocks = vi.hoisted(() => {
  const fn = vi.fn;
  // DB mock chain — each test can override the limit() resolver
  const state: { limitResult: unknown[] } = {
    limitResult: [{ patient_id: "22222222-2222-4222-8222-222222222222" }],
  };
  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = fn(() => chain);
    chain.where = fn(() => chain);
    chain.limit = fn(async () => state.limitResult);
    return chain;
  }
  return {
    state,
    mockDb: {
      select: fn(() => makeSelectChain()),
      insert: fn(() => ({ values: fn() })),
    },
    assertCareTeamAccess: fn(async () => true),
    createDiagnosis: fn(async (input: unknown) => ({
      id: "aaaa1111-1111-4111-8111-111111111111",
      ...(input as Record<string, unknown>),
    })),
    updateDiagnosis: fn(async (id: string, data: unknown) => ({
      id,
      ...(data as Record<string, unknown>),
    })),
    createAllergy: fn(async (input: unknown) => ({
      id: "bbbb1111-1111-4111-8111-111111111111",
      ...(input as Record<string, unknown>),
    })),
    updateAllergy: fn(async (id: string, data: unknown) => ({
      id,
      ...(data as Record<string, unknown>),
    })),
  };
});

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => mocks.mockDb,
  hmacForIndex: (v: string) => `hmac:${v}`,
  patients: { id: "patients.id" },
  diagnoses: { id: "diagnoses.id", patient_id: "diagnoses.patient_id" },
  allergies: { id: "allergies.id", patient_id: "allergies.patient_id" },
  allergyOverrides: { id: "allergy_overrides.id" },
  auditLog: {},
  clinicalFlags: { id: "clinical_flags.id" },
  careTeamMembers: { patient_id: "care_team_members.patient_id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock("../middleware/rbac.js", () => ({
  assertCareTeamAccess: mocks.assertCareTeamAccess,
}));

vi.mock("@carebridge/patient-records", () => ({
  listObservationsByPatient: vi.fn(),
  createObservation: vi.fn(),
  createDiagnosis: mocks.createDiagnosis,
  updateDiagnosis: mocks.updateDiagnosis,
  createAllergy: mocks.createAllergy,
  updateAllergy: mocks.updateAllergy,
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

const diagnosisInput = {
  patient_id: PATIENT_ID,
  icd10_code: "C50.9",
  description: "Breast cancer, unspecified",
  status: "active" as const,
};

const allergyInput = {
  patient_id: PATIENT_ID,
  allergen: "Penicillin",
  reaction: "Hives and swelling",
  severity: "moderate" as const,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("patientRecordsRbacRouter — diagnoses role restrictions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects patient from creating a diagnosis (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("patient", PATIENT_ID));
    await expect(caller.diagnoses.create(diagnosisInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.createDiagnosis).not.toHaveBeenCalled();
  });

  it("rejects family_caregiver from creating a diagnosis (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("family_caregiver"));
    await expect(caller.diagnoses.create(diagnosisInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.createDiagnosis).not.toHaveBeenCalled();
  });

  it("rejects patient from updating a diagnosis (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("patient", PATIENT_ID));
    await expect(
      caller.diagnoses.update({ id: DIAGNOSIS_ID, status: "resolved" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateDiagnosis).not.toHaveBeenCalled();
  });

  it("rejects family_caregiver from updating a diagnosis (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("family_caregiver"));
    await expect(
      caller.diagnoses.update({ id: DIAGNOSIS_ID, status: "resolved" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateDiagnosis).not.toHaveBeenCalled();
  });

  it("allows a physician to create a diagnosis", async () => {
    const caller = callerFor(makeUser("physician"));
    await expect(caller.diagnoses.create(diagnosisInput)).resolves.toBeDefined();
    expect(mocks.createDiagnosis).toHaveBeenCalled();
  });

  it("allows a specialist to create a diagnosis", async () => {
    const caller = callerFor(makeUser("specialist"));
    await expect(caller.diagnoses.create(diagnosisInput)).resolves.toBeDefined();
    expect(mocks.createDiagnosis).toHaveBeenCalled();
  });

  it("allows a nurse to create a diagnosis", async () => {
    const caller = callerFor(makeUser("nurse"));
    await expect(caller.diagnoses.create(diagnosisInput)).resolves.toBeDefined();
    expect(mocks.createDiagnosis).toHaveBeenCalled();
  });

  it("allows an admin to create a diagnosis", async () => {
    const caller = callerFor(makeUser("admin"));
    await expect(caller.diagnoses.create(diagnosisInput)).resolves.toBeDefined();
    expect(mocks.createDiagnosis).toHaveBeenCalled();
  });
});

describe("patientRecordsRbacRouter — allergies role restrictions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("rejects patient from creating an allergy (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("patient", PATIENT_ID));
    await expect(caller.allergies.create(allergyInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.createAllergy).not.toHaveBeenCalled();
  });

  it("rejects family_caregiver from creating an allergy (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("family_caregiver"));
    await expect(caller.allergies.create(allergyInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.createAllergy).not.toHaveBeenCalled();
  });

  it("rejects patient from updating an allergy (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("patient", PATIENT_ID));
    await expect(
      caller.allergies.update({ id: ALLERGY_ID, severity: "severe" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateAllergy).not.toHaveBeenCalled();
  });

  it("rejects family_caregiver from updating an allergy (FORBIDDEN)", async () => {
    const caller = callerFor(makeUser("family_caregiver"));
    await expect(
      caller.allergies.update({ id: ALLERGY_ID, severity: "severe" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateAllergy).not.toHaveBeenCalled();
  });

  it("allows a physician to create an allergy", async () => {
    const caller = callerFor(makeUser("physician"));
    await expect(caller.allergies.create(allergyInput)).resolves.toBeDefined();
    expect(mocks.createAllergy).toHaveBeenCalled();
  });

  it("allows a specialist to create an allergy", async () => {
    const caller = callerFor(makeUser("specialist"));
    await expect(caller.allergies.create(allergyInput)).resolves.toBeDefined();
    expect(mocks.createAllergy).toHaveBeenCalled();
  });

  it("allows a nurse to create an allergy", async () => {
    const caller = callerFor(makeUser("nurse"));
    await expect(caller.allergies.create(allergyInput)).resolves.toBeDefined();
    expect(mocks.createAllergy).toHaveBeenCalled();
  });

  it("allows an admin to create an allergy", async () => {
    const caller = callerFor(makeUser("admin"));
    await expect(caller.allergies.create(allergyInput)).resolves.toBeDefined();
    expect(mocks.createAllergy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Care-team enforcement — clinician must have an active care-team assignment
// for the target patient. Admin bypasses the check.
// ---------------------------------------------------------------------------

describe("patientRecordsRbacRouter — care-team enforcement (diagnoses)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertCareTeamAccess.mockImplementation(async () => true);
    mocks.state.limitResult = [{ id: DIAGNOSIS_ID, patient_id: PATIENT_ID }];
  });

  // Care-team denial: every clinician role × (create, update) combination.
  // Full matrix so the test file can be read as a coverage contract.
  it.each([
    ["physician", "create"],
    ["physician", "update"],
    ["nurse", "create"],
    ["nurse", "update"],
    ["specialist", "create"],
    ["specialist", "update"],
  ] as const)(
    "denies non-care-team %s on %s (FORBIDDEN)",
    async (role, action) => {
      mocks.assertCareTeamAccess.mockResolvedValueOnce(false);
      const caller = callerFor(makeUser(role));
      if (action === "create") {
        await expect(
          caller.diagnoses.create(diagnosisInput),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(mocks.createDiagnosis).not.toHaveBeenCalled();
      } else {
        await expect(
          caller.diagnoses.update({ id: DIAGNOSIS_ID, status: "resolved" }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(mocks.updateDiagnosis).not.toHaveBeenCalled();
      }
    },
  );

  it("allows care-team physician to update", async () => {
    const caller = callerFor(makeUser("physician"));
    await expect(
      caller.diagnoses.update({ id: DIAGNOSIS_ID, status: "resolved" }),
    ).resolves.toBeDefined();
    expect(mocks.assertCareTeamAccess).toHaveBeenCalledWith(
      ROLE_IDS.physician,
      PATIENT_ID,
    );
    expect(mocks.updateDiagnosis).toHaveBeenCalled();
  });

  it("admin bypasses care-team check on create", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => false);
    const caller = callerFor(makeUser("admin"));
    await expect(caller.diagnoses.create(diagnosisInput)).resolves.toBeDefined();
    expect(mocks.assertCareTeamAccess).not.toHaveBeenCalled();
    expect(mocks.createDiagnosis).toHaveBeenCalled();
  });

  it("admin bypasses care-team check on update", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => false);
    const caller = callerFor(makeUser("admin"));
    await expect(
      caller.diagnoses.update({ id: DIAGNOSIS_ID, status: "resolved" }),
    ).resolves.toBeDefined();
    expect(mocks.assertCareTeamAccess).not.toHaveBeenCalled();
    expect(mocks.updateDiagnosis).toHaveBeenCalled();
  });

  it("returns NOT_FOUND when diagnosis does not exist on update", async () => {
    mocks.state.limitResult = [];
    const caller = callerFor(makeUser("physician"));
    await expect(
      caller.diagnoses.update({ id: DIAGNOSIS_ID, status: "resolved" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.updateDiagnosis).not.toHaveBeenCalled();
  });

  it.each([
    ["create"],
    ["update"],
  ] as const)(
    "rejects unauthenticated caller on %s (UNAUTHORIZED)",
    async (action) => {
      const caller = callerFor(null);
      if (action === "create") {
        await expect(
          caller.diagnoses.create(diagnosisInput),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        expect(mocks.createDiagnosis).not.toHaveBeenCalled();
      } else {
        await expect(
          caller.diagnoses.update({ id: DIAGNOSIS_ID, status: "resolved" }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        expect(mocks.updateDiagnosis).not.toHaveBeenCalled();
      }
    },
  );
});

describe("patientRecordsRbacRouter — care-team enforcement (allergies)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertCareTeamAccess.mockImplementation(async () => true);
    mocks.state.limitResult = [{ id: ALLERGY_ID, patient_id: PATIENT_ID }];
  });

  // Full clinician-role × action matrix. See diagnoses block above.
  it.each([
    ["physician", "create"],
    ["physician", "update"],
    ["nurse", "create"],
    ["nurse", "update"],
    ["specialist", "create"],
    ["specialist", "update"],
  ] as const)(
    "denies non-care-team %s on %s (FORBIDDEN)",
    async (role, action) => {
      mocks.assertCareTeamAccess.mockResolvedValueOnce(false);
      const caller = callerFor(makeUser(role));
      if (action === "create") {
        await expect(
          caller.allergies.create(allergyInput),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(mocks.createAllergy).not.toHaveBeenCalled();
      } else {
        await expect(
          caller.allergies.update({ id: ALLERGY_ID, severity: "severe" }),
        ).rejects.toMatchObject({ code: "FORBIDDEN" });
        expect(mocks.updateAllergy).not.toHaveBeenCalled();
      }
    },
  );

  it("allows care-team nurse to update", async () => {
    const caller = callerFor(makeUser("nurse"));
    await expect(
      caller.allergies.update({ id: ALLERGY_ID, severity: "severe" }),
    ).resolves.toBeDefined();
    expect(mocks.assertCareTeamAccess).toHaveBeenCalledWith(
      ROLE_IDS.nurse,
      PATIENT_ID,
    );
    expect(mocks.updateAllergy).toHaveBeenCalled();
  });

  it("admin bypasses care-team check on update", async () => {
    mocks.assertCareTeamAccess.mockImplementation(async () => false);
    const caller = callerFor(makeUser("admin"));
    await expect(
      caller.allergies.update({ id: ALLERGY_ID, severity: "severe" }),
    ).resolves.toBeDefined();
    expect(mocks.assertCareTeamAccess).not.toHaveBeenCalled();
    expect(mocks.updateAllergy).toHaveBeenCalled();
  });

  it("returns NOT_FOUND when allergy does not exist on update", async () => {
    mocks.state.limitResult = [];
    const caller = callerFor(makeUser("physician"));
    await expect(
      caller.allergies.update({ id: ALLERGY_ID, severity: "severe" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.updateAllergy).not.toHaveBeenCalled();
  });

  it.each([
    ["create"],
    ["update"],
  ] as const)(
    "rejects unauthenticated caller on %s (UNAUTHORIZED)",
    async (action) => {
      const caller = callerFor(null);
      if (action === "create") {
        await expect(
          caller.allergies.create(allergyInput),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        expect(mocks.createAllergy).not.toHaveBeenCalled();
      } else {
        await expect(
          caller.allergies.update({ id: ALLERGY_ID, severity: "severe" }),
        ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
        expect(mocks.updateAllergy).not.toHaveBeenCalled();
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Regression guard for issue #847 — "family_caregiver" must be a first-class
// member of the User["role"] union so the router deny-branches compile as
// type-safe equality checks without `(ctx.user.role as string)` casts.
// ---------------------------------------------------------------------------

describe("family_caregiver role typing (issue #847)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("accepts family_caregiver as a literal User['role'] value without casts", () => {
    // If this compiles, the union includes "family_caregiver". If it ever
    // regresses back to the narrower union, tsc will fail at build time.
    const caregiver: User = {
      id: ROLE_IDS.family_caregiver!,
      email: "caregiver@carebridge.dev",
      name: "Test Caregiver",
      role: "family_caregiver",
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    expect(caregiver.role).toBe("family_caregiver");
  });

  it("rejects family_caregiver through the type-safe deny branch on diagnoses.create", async () => {
    // Before issue #847 the router relied on `(ctx.user.role as string) === "family_caregiver"`
    // because the union was too narrow. With the union widened, the equality
    // check is type-safe and this assertion protects the deny path.
    const caller = callerFor(makeUser("family_caregiver"));
    await expect(caller.diagnoses.create(diagnosisInput)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(mocks.createDiagnosis).not.toHaveBeenCalled();
  });

  it("rejects family_caregiver through the type-safe deny branch on allergies.update", async () => {
    const caller = callerFor(makeUser("family_caregiver"));
    await expect(
      caller.allergies.update({ id: ALLERGY_ID, severity: "severe" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.updateAllergy).not.toHaveBeenCalled();
  });
});

/**
 * Issue #1304 — the gateway's `patients.careTeam.getByPatient` procedure
 * was returning bare `care_team_members` rows so the clinician portal
 * rendered raw `provider_id` UUIDs as the only identifier.
 *
 * The procedure now LEFT JOINs the `users` table and projects
 * `provider_name` + `provider_specialty` (roster-level specialty wins,
 * falling back to the user's profile specialty). The LEFT join is
 * intentional: a stale roster entry pointing at a deleted user must still
 * appear on the chart so reviewers can spot the orphan.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User } from "@carebridge/shared-types";

const PATIENT_ID = "22222222-2222-4222-8222-222222222222";
const PHYSICIAN_ID = "44444444-4444-4444-8444-444444444444";

const mocks = vi.hoisted(() => {
  const fn = vi.fn;

  // Captures the most recent select() column-map argument, the joined
  // table reference, and the rows we want the awaited chain to resolve to.
  const state: {
    selectColumns: Record<string, unknown> | undefined;
    leftJoinArgs: unknown[] | undefined;
    rows: unknown[];
  } = {
    selectColumns: undefined,
    leftJoinArgs: undefined,
    rows: [],
  };

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = fn(() => chain);
    chain.leftJoin = fn((...args: unknown[]) => {
      state.leftJoinArgs = args;
      return chain;
    });
    chain.where = fn(() => Promise.resolve(state.rows));
    chain.limit = fn(async () => state.rows);
    return chain;
  }

  return {
    state,
    mockDb: {
      select: fn((cols?: Record<string, unknown>) => {
        state.selectColumns = cols;
        return makeSelectChain();
      }),
      insert: fn(() => ({ values: fn() })),
    },
    assertCareTeamAccess: fn(async () => true),
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
  familyRelationships: { id: "family_relationships.id" },
  careTeamMembers: {
    id: "care_team_members.id",
    patient_id: "care_team_members.patient_id",
    provider_id: "care_team_members.provider_id",
    role: "care_team_members.role",
    specialty: "care_team_members.specialty",
    is_active: "care_team_members.is_active",
    started_at: "care_team_members.started_at",
    ended_at: "care_team_members.ended_at",
    created_at: "care_team_members.created_at",
  },
  careTeamAssignments: {
    id: "care_team_assignments.id",
    user_id: "care_team_assignments.user_id",
    patient_id: "care_team_assignments.patient_id",
    removed_at: "care_team_assignments.removed_at",
  },
  users: {
    id: "users.id",
    name: "users.name",
    specialty: "users.specialty",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  isNull: (col: unknown) => ({ op: "isNull", col }),
  isNotNull: (col: unknown) => ({ op: "isNotNull", col }),
  inArray: (col: unknown, vals: unknown[]) => ({ op: "inArray", col, vals }),
  desc: (col: unknown) => ({ op: "desc", col }),
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

vi.mock("@carebridge/shared-types", async () => {
  const actual = await vi.importActual<typeof import("@carebridge/shared-types")>(
    "@carebridge/shared-types",
  );
  const { z } = await import("zod");
  return {
    ...actual,
    createPatientSchema: z.object({ mrn: z.string().optional() }),
    updatePatientSchema: z.object({}),
    createDiagnosisSchema: z.object({}),
    updateDiagnosisSchema: z.object({}),
    createAllergySchema: z.object({}),
    updateAllergySchema: z.object({}),
    overrideAllergyFlagSchema: z.object({}),
  };
});

import { patientRecordsRbacRouter } from "../routers/patient-records.js";
import type { Context } from "../context.js";

function makeUser(role: User["role"], id: string): User {
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
    clientIp: null,
  };
}

function callerFor(user: User | null) {
  return patientRecordsRbacRouter.createCaller(makeContext(user));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.state.selectColumns = undefined;
  mocks.state.leftJoinArgs = undefined;
  mocks.state.rows = [];
});

describe("patients.careTeam.getByPatient — joins users for name + specialty (#1304)", () => {
  it("selects provider_name + provider_specialty via LEFT JOIN on users", async () => {
    mocks.state.rows = [];

    const physician = makeUser("physician", PHYSICIAN_ID);
    await callerFor(physician).careTeam.getByPatient({ patientId: PATIENT_ID });

    expect(mocks.mockDb.select).toHaveBeenCalledTimes(1);
    const cols = mocks.state.selectColumns!;
    expect(cols).toBeDefined();

    // The projection must surface the new joined columns alongside the
    // existing roster columns the patient-portal already consumes.
    expect(cols).toHaveProperty("provider_name");
    expect(cols).toHaveProperty("provider_user_specialty");
    expect(cols).toHaveProperty("provider_id");
    expect(cols).toHaveProperty("role");
    expect(cols).toHaveProperty("specialty");

    // LEFT (not INNER) join — orphaned roster rows must still surface.
    expect(mocks.state.leftJoinArgs).toBeDefined();
    expect(mocks.state.leftJoinArgs![0]).toEqual({
      id: "users.id",
      name: "users.name",
      specialty: "users.specialty",
    });
  });

  it("returns provider_name + provider_specialty when the users row exists", async () => {
    mocks.state.rows = [
      {
        id: "ctm-1",
        patient_id: PATIENT_ID,
        provider_id: "provider-1",
        role: "primary",
        specialty: null,
        is_active: true,
        started_at: "2025-01-01T00:00:00Z",
        ended_at: null,
        created_at: "2025-01-01T00:00:00Z",
        provider_name: "Dr. Sarah Smith",
        provider_user_specialty: "Hematology/Oncology",
      },
    ];

    const physician = makeUser("physician", PHYSICIAN_ID);
    const result = await callerFor(physician).careTeam.getByPatient({
      patientId: PATIENT_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      provider_id: "provider-1",
      role: "primary",
      provider_name: "Dr. Sarah Smith",
      provider_specialty: "Hematology/Oncology",
    });
    // The intermediate alias is stripped from the response payload.
    expect(result[0]).not.toHaveProperty("provider_user_specialty");
  });

  it("prefers roster-level specialty over the user profile specialty", async () => {
    mocks.state.rows = [
      {
        id: "ctm-2",
        patient_id: PATIENT_ID,
        provider_id: "provider-2",
        role: "specialist",
        // Roster overrides the user's general specialty for this patient.
        specialty: "Interventional Radiology — Stroke",
        is_active: true,
        started_at: "2025-01-01T00:00:00Z",
        ended_at: null,
        created_at: "2025-01-01T00:00:00Z",
        provider_name: "Dr. Michael Jones",
        provider_user_specialty: "Interventional Radiology",
      },
    ];

    const physician = makeUser("physician", PHYSICIAN_ID);
    const result = await callerFor(physician).careTeam.getByPatient({
      patientId: PATIENT_ID,
    });

    expect(result[0]?.provider_specialty).toBe(
      "Interventional Radiology — Stroke",
    );
  });

  it("returns null name/specialty when the joined user row is missing", async () => {
    // Stale roster entry — provider_id points at a deleted user. LEFT JOIN
    // yields nulls for the user columns; the response surfaces null so
    // the UI can render an explicit "Unknown provider" fallback.
    mocks.state.rows = [
      {
        id: "ctm-3",
        patient_id: PATIENT_ID,
        provider_id: "deleted-provider",
        role: "nurse",
        specialty: null,
        is_active: true,
        started_at: "2025-01-01T00:00:00Z",
        ended_at: null,
        created_at: "2025-01-01T00:00:00Z",
        provider_name: null,
        provider_user_specialty: null,
      },
    ];

    const physician = makeUser("physician", PHYSICIAN_ID);
    const result = await callerFor(physician).careTeam.getByPatient({
      patientId: PATIENT_ID,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.provider_name).toBeNull();
    expect(result[0]?.provider_specialty).toBeNull();
  });
});

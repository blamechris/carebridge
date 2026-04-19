/**
 * Matrix coverage for family_caregiver scope enforcement (issue #896).
 *
 * Each scope token is tested against each representative patient-scoped
 * read resource. The intent is to lock in the resource→scope mapping in
 * the issue body, so any drift (e.g. "labs read started accepting
 * view_summary") is caught immediately.
 *
 * The router-under-test is selected per resource so a single set of
 * hoisted mocks drives every call. We intentionally avoid going through
 * fetch / HTTP — calling `.createCaller` on the tRPC router exercises
 * the same middleware + procedure code without the transport layer.
 *
 * Matrix dimensions
 * -----------------
 *   scopes:    [read_only, view_summary, view_appointments,
 *               view_medications, view_labs, view_notes, view_and_message]
 *   resources: [patients.getById, diagnoses.getByPatient, allergies.getByPatient,
 *               observations.getByPatient, appointments.listByPatient,
 *               medications.getByPatient, labs.getByPatient, notes.getByPatient]
 *
 * Expectations
 *  - `view_and_message` grants every read (superset).
 *  - `read_only` maps to `view_summary` (blanket summary permit).
 *  - Every other token grants exactly the resources mapped to it in #896.
 *  - Denials return FORBIDDEN with a message naming the missing scope
 *    and never leak PHI (no patient name, no MRN, no diagnosis).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { User, ScopeToken } from "@carebridge/shared-types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CAREGIVER_ID = "77777777-7777-4777-8777-777777777777";
const PATIENT_USER_ID = "11111111-1111-4111-8111-111111111111";
const PATIENT_RECORD_ID = "aaaa1111-1111-4111-8111-111111111111";
const NOTE_ID = "cccc4444-4444-4444-8444-444444444444";

const ALL_SCOPES: ScopeToken[] = [
  "read_only",
  "view_summary",
  "view_appointments",
  "view_medications",
  "view_labs",
  "view_notes",
  "view_and_message",
];

/**
 * Expected allow-list per scope token. Derived directly from the issue body
 * so any future drift between the scope taxonomy and the resource→scope
 * mapping lights up in this test.
 *
 * Keys are the resource short-name used in the tests; the value is the set
 * of scopes that SHOULD grant access.
 */
const RESOURCE_SCOPE_REQUIREMENT: Record<
  | "patientsGetById"
  | "diagnosesGetByPatient"
  | "allergiesGetByPatient"
  | "observationsGetByPatient"
  | "appointmentsListByPatient"
  | "medicationsGetByPatient"
  | "labsGetByPatient"
  | "notesGetByPatient",
  ScopeToken
> = {
  patientsGetById: "view_summary",
  diagnosesGetByPatient: "view_summary",
  allergiesGetByPatient: "view_summary",
  observationsGetByPatient: "view_summary",
  appointmentsListByPatient: "view_appointments",
  medicationsGetByPatient: "view_medications",
  labsGetByPatient: "view_labs",
  notesGetByPatient: "view_notes",
};

// ---------------------------------------------------------------------------
// Hoisted mocks — shared across every router import below
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => {
  let queue: unknown[][] = [];

  function nextResult(): unknown[] {
    return queue.shift() ?? [];
  }

  function makeSelectChain() {
    const chain: Record<string, unknown> = {};
    chain.from = vi.fn(() => chain);
    chain.innerJoin = vi.fn(() => chain);
    chain.where = vi.fn(() => {
      const result: Record<string | symbol, unknown> = {
        orderBy: vi.fn(async () => nextResult()),
        limit: vi.fn(async () => nextResult()),
      };
      (result as { then: (resolve: (v: unknown) => void) => unknown }).then = (
        resolve,
      ) => {
        resolve(nextResult());
        return result;
      };
      return result;
    });
    chain.orderBy = vi.fn(async () => nextResult());
    chain.limit = vi.fn(async () => nextResult());
    return chain;
  }

  const mockDb = {
    select: vi.fn(() => makeSelectChain()),
    insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({ where: vi.fn(async () => undefined) })),
    })),
    transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        select: vi.fn(() => makeSelectChain()),
        insert: vi.fn(() => ({ values: vi.fn(async () => undefined) })),
      }),
    ),
  };

  return {
    mockDb,
    setQueue: (q: unknown[][]) => {
      queue = [...q];
    },
  };
});

// ---------------------------------------------------------------------------
// Shared module mocks (one set, used by every router)
// ---------------------------------------------------------------------------

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
    access_scopes: "family_relationships.access_scopes",
  },
  users: {
    id: "users.id",
    patient_id: "users.patient_id",
  },
  medications: {
    id: "medications.id",
    patient_id: "medications.patient_id",
  },
  clinicalNotes: {
    id: "clinical_notes.id",
    patient_id: "clinical_notes.patient_id",
  },
  appointments: {
    id: "appointments.id",
    patient_id: "appointments.patient_id",
    provider_id: "appointments.provider_id",
    start_time: "appointments.start_time",
    end_time: "appointments.end_time",
    status: "appointments.status",
  },
  auditLog: {
    id: "audit_log.id",
  },
  conversations: { id: "conversations.id" },
  conversationParticipants: { conversation_id: "cp.conversation_id", user_id: "cp.user_id" },
  messages: { id: "messages.id" },
  providerSchedules: {},
  scheduleBlocks: {},
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ op: "eq", col, val }),
  and: (...args: unknown[]) => ({ op: "and", args }),
  gte: (col: unknown, val: unknown) => ({ op: "gte", col, val }),
  lte: (col: unknown, val: unknown) => ({ op: "lte", col, val }),
  ne: (col: unknown, val: unknown) => ({ op: "ne", col, val }),
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
  createObservation: vi.fn(async () => ({})),
  createDiagnosis: vi.fn(),
  updateDiagnosis: vi.fn(),
  createAllergy: vi.fn(),
  updateAllergy: vi.fn(),
}));

vi.mock("@carebridge/clinical-data", () => ({
  vitalRepo: {
    createVital: vi.fn(async () => ({})),
    getVitalsByPatient: vi.fn(async () => []),
    getLatestVitals: vi.fn(async () => []),
  },
  labRepo: {
    createLabPanel: vi.fn(async () => ({})),
    getLabPanelsByPatient: vi.fn(async () => []),
    getLabResultHistory: vi.fn(async () => []),
  },
  medicationRepo: {
    createMedication: vi.fn(async () => ({})),
    updateMedication: vi.fn(async () => ({})),
    getMedicationsByPatient: vi.fn(async () => []),
    logAdministration: vi.fn(async () => ({})),
  },
  procedureRepo: {
    createProcedure: vi.fn(async () => ({})),
    getProceduresByPatient: vi.fn(async () => []),
  },
  ConflictError: class ConflictError extends Error {},
}));

vi.mock("@carebridge/clinical-notes", () => ({
  noteService: {
    createNote: vi.fn(async () => ({})),
    updateNote: vi.fn(async () => ({})),
    signNote: vi.fn(async () => ({})),
    cosignNote: vi.fn(async () => ({})),
    amendNote: vi.fn(async () => ({})),
    getVersionHistory: vi.fn(async () => []),
    getNotesByPatient: vi.fn(async () => []),
    getNoteById: vi.fn(async () => ({
      note: { id: NOTE_ID, patient_id: PATIENT_RECORD_ID },
    })),
  },
  createSOAPTemplate: () => ({}),
  createProgressTemplate: () => ({}),
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
    createVitalSchema: z.object({ patient_id: z.string().uuid() }),
    vitalTypeSchema: z.string(),
    createLabPanelSchema: z.object({ patient_id: z.string().uuid() }),
    createMedicationSchema: z.object({ patient_id: z.string().uuid() }),
    updateMedicationSchema: z.object({}),
    medStatusSchema: z.string(),
    createProcedureSchema: z.object({ patient_id: z.string().uuid() }),
    createNoteSchema: z.object({ patient_id: z.string().uuid() }),
    updateNoteSchema: z.object({}),
    cosignNoteSchema: z.object({ noteId: z.string().uuid() }),
    amendNoteSchema: z.object({
      noteId: z.string().uuid(),
      sections: z.any(),
      reason: z.string(),
    }),
    noteTemplateTypeSchema: z.enum(["soap", "progress", "h_and_p", "discharge", "consult"]),
    appointmentTypeSchema: z.enum(["follow_up", "new_patient", "procedure", "telehealth"]),
    cancelReasonSchema: z.string().trim().min(1),
    // #233 — patient-records router now accepts an allergy-override input.
    // The schema shape itself isn't exercised by the caregiver-scope matrix
    // (none of the mapped caregiver scopes can invoke the clinician-only
    // override mutation), but the router module wires it to `.input(...)`
    // at load time so the mock must provide *something* with `.parse`.
    overrideAllergyFlagSchema: z.object({
      flag_id: z.string().uuid(),
      allergy_id: z.string().uuid().optional(),
      override_reason: z.string(),
      clinical_justification: z.string(),
    }),
    allergyOverrideReasonSchema: z.string(),
  };
});

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
  CLINICAL_EVENTS_JOB_OPTIONS: {},
}));

vi.mock("bullmq", () => ({
  Queue: class {
    add() {
      return Promise.resolve();
    }
  },
}));

// ---------------------------------------------------------------------------
// Router imports (AFTER mocks above)
// ---------------------------------------------------------------------------

import { patientRecordsRbacRouter } from "../routers/patient-records.js";
import { clinicalDataRbacRouter } from "../routers/clinical-data.js";
import { clinicalNotesRbacRouter } from "../routers/clinical-notes.js";
import { schedulingRbacRouter } from "../routers/scheduling.js";
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
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function ctxFor(user: User | null): Context {
  return {
    db: mocks.mockDb as unknown as Context["db"],
    user,
    sessionId: "session-1",
    requestId: "req-1",
    clientIp: null,
  };
}

/**
 * Queue the family_relationships lookup so enforcePatientAccess resolves
 * an active relationship row with the given scopes.
 *
 * Most read procedures do exactly ONE such lookup then delegate to a mocked
 * repo that returns []. A few (clinical-notes.getById, notes.getVersionHistory,
 * medications.update) do a pre-lookup to resolve patient_id first — those
 * cases are handled in their specific tests.
 */
function enqueueRelationship(scopes: ScopeToken[] | null): void {
  mocks.setQueue([[{ id: "rel-1", access_scopes: scopes }]]);
}

// ---------------------------------------------------------------------------
// Resource call wrappers — normalise the invocation surface across routers
// ---------------------------------------------------------------------------

type ResourceCaller = (caregiver: User) => Promise<unknown>;

const resourceCalls: Record<keyof typeof RESOURCE_SCOPE_REQUIREMENT, ResourceCaller> = {
  patientsGetById: (caregiver) =>
    patientRecordsRbacRouter
      .createCaller(ctxFor(caregiver))
      .getById({ id: PATIENT_RECORD_ID }),

  diagnosesGetByPatient: (caregiver) =>
    patientRecordsRbacRouter
      .createCaller(ctxFor(caregiver))
      .diagnoses.getByPatient({ patientId: PATIENT_RECORD_ID }),

  allergiesGetByPatient: (caregiver) =>
    patientRecordsRbacRouter
      .createCaller(ctxFor(caregiver))
      .allergies.getByPatient({ patientId: PATIENT_RECORD_ID }),

  observationsGetByPatient: (caregiver) =>
    patientRecordsRbacRouter
      .createCaller(ctxFor(caregiver))
      .observations.getByPatient({ patientId: PATIENT_RECORD_ID, limit: 20 }),

  appointmentsListByPatient: (caregiver) =>
    schedulingRbacRouter
      .createCaller(ctxFor(caregiver))
      .appointments.listByPatient({ patientId: PATIENT_RECORD_ID }),

  medicationsGetByPatient: (caregiver) =>
    clinicalDataRbacRouter
      .createCaller(ctxFor(caregiver))
      .medications.getByPatient({ patientId: PATIENT_RECORD_ID }),

  labsGetByPatient: (caregiver) =>
    clinicalDataRbacRouter
      .createCaller(ctxFor(caregiver))
      .labs.getByPatient({ patientId: PATIENT_RECORD_ID }),

  notesGetByPatient: (caregiver) =>
    clinicalNotesRbacRouter
      .createCaller(ctxFor(caregiver))
      .getByPatient({ patientId: PATIENT_RECORD_ID }),
};

/**
 * Returns true when the given caregiver scope set SHOULD grant access to
 * the resource, applying the superset rules from `hasScope`:
 *  - view_and_message grants everything
 *  - read_only satisfies view_summary
 */
function shouldGrant(
  scopes: ScopeToken[],
  resourceScope: ScopeToken,
): boolean {
  if (scopes.includes("view_and_message")) return true;
  if (resourceScope === "view_summary" && scopes.includes("read_only")) return true;
  return scopes.includes(resourceScope);
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

describe("caregiver scope matrix (issue #896)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // One `describe.each` per resource keeps the vitest output readable — you
  // see "medications.getByPatient → view_notes DENIED" rather than a
  // flattened giant list.
  (Object.keys(resourceCalls) as Array<keyof typeof resourceCalls>).forEach(
    (resource) => {
      const requiredScope = RESOURCE_SCOPE_REQUIREMENT[resource];

      describe(`${resource} (requires ${requiredScope})`, () => {
        ALL_SCOPES.forEach((scope) => {
          const expectAllow = shouldGrant([scope], requiredScope);
          const label = `scope=${scope} → ${expectAllow ? "ALLOW" : "DENY"}`;

          it(label, async () => {
            enqueueRelationship([scope]);
            const caregiver = makeUser("family_caregiver", CAREGIVER_ID);
            const call = resourceCalls[resource](caregiver);

            if (expectAllow) {
              await expect(call).resolves.toBeDefined();
            } else {
              await expect(call).rejects.toMatchObject({
                code: "FORBIDDEN",
                // Error message NAMES the missing scope — UI can explain.
                message: expect.stringContaining(requiredScope),
              });
            }
          });
        });
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Superset / default behaviour
// ---------------------------------------------------------------------------

describe("scope superset and default-scope behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("view_and_message grants EVERY read resource", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);

    for (const resource of Object.keys(resourceCalls) as Array<
      keyof typeof resourceCalls
    >) {
      enqueueRelationship(["view_and_message"]);
      await expect(resourceCalls[resource](caregiver)).resolves.toBeDefined();
    }
  });

  it("read_only grants the view_summary tier but denies labs / meds / notes / appointments", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);

    // Summary-tier reads should SUCCEED with read_only.
    for (const resource of [
      "patientsGetById",
      "diagnosesGetByPatient",
      "allergiesGetByPatient",
      "observationsGetByPatient",
    ] as const) {
      enqueueRelationship(["read_only"]);
      await expect(resourceCalls[resource](caregiver)).resolves.toBeDefined();
    }

    // Non-summary tiers should FAIL.
    for (const resource of [
      "appointmentsListByPatient",
      "medicationsGetByPatient",
      "labsGetByPatient",
      "notesGetByPatient",
    ] as const) {
      enqueueRelationship(["read_only"]);
      await expect(resourceCalls[resource](caregiver)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });

  it("null access_scopes falls back to the default (read_only) — NOT all-scopes", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);

    // Null column -> default [read_only]. Summary tier allowed, others denied.
    enqueueRelationship(null);
    await expect(
      resourceCalls.patientsGetById(caregiver),
    ).resolves.toBeDefined();

    enqueueRelationship(null);
    await expect(
      resourceCalls.medicationsGetByPatient(caregiver),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("empty access_scopes array falls back to the default (read_only)", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);

    enqueueRelationship([]);
    await expect(
      resourceCalls.patientsGetById(caregiver),
    ).resolves.toBeDefined();

    enqueueRelationship([]);
    await expect(
      resourceCalls.labsGetByPatient(caregiver),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("multiple scopes combine additively (view_labs + view_medications allows both, still denies notes)", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);

    enqueueRelationship(["view_labs", "view_medications"]);
    await expect(
      resourceCalls.labsGetByPatient(caregiver),
    ).resolves.toBeDefined();

    enqueueRelationship(["view_labs", "view_medications"]);
    await expect(
      resourceCalls.medicationsGetByPatient(caregiver),
    ).resolves.toBeDefined();

    enqueueRelationship(["view_labs", "view_medications"]);
    await expect(
      resourceCalls.notesGetByPatient(caregiver),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

// ---------------------------------------------------------------------------
// Error-message hygiene (PHI leak safeguard)
// ---------------------------------------------------------------------------

describe("FORBIDDEN message hygiene", () => {
  beforeEach(() => vi.clearAllMocks());

  it("names the missing scope without leaking patient identifiers", async () => {
    const caregiver = makeUser("family_caregiver", CAREGIVER_ID);
    enqueueRelationship(["view_summary"]); // deliberately insufficient for labs

    try {
      await resourceCalls.labsGetByPatient(caregiver);
      expect.fail("expected FORBIDDEN");
    } catch (err) {
      const message = (err as { message?: string }).message ?? "";
      expect(message).toMatch(/view_labs/);
      // The patient record id is a UUID in our fixtures — must NOT appear.
      expect(message).not.toContain(PATIENT_RECORD_ID);
      expect(message).not.toContain(PATIENT_USER_ID);
    }
  });
});

// ---------------------------------------------------------------------------
// Role bypass: patient / admin are NOT subject to scope checks
// ---------------------------------------------------------------------------

describe("scope-check bypass for non-caregiver roles", () => {
  beforeEach(() => vi.clearAllMocks());

  it("admin bypasses scope checks entirely (no DB lookup needed)", async () => {
    const admin = makeUser("admin", "66666666-6666-4666-8666-666666666666");
    // No queue entries — admin must NOT hit the relationship lookup path.
    await expect(
      patientRecordsRbacRouter
        .createCaller(ctxFor(admin))
        .allergies.getByPatient({ patientId: PATIENT_RECORD_ID }),
    ).resolves.toBeDefined();
  });

  it("patient viewing their own record bypasses scope checks", async () => {
    const patient = makeUser("patient", PATIENT_USER_ID, {
      patient_id: PATIENT_RECORD_ID,
    });
    await expect(
      patientRecordsRbacRouter
        .createCaller(ctxFor(patient))
        .allergies.getByPatient({ patientId: PATIENT_RECORD_ID }),
    ).resolves.toBeDefined();
  });
});

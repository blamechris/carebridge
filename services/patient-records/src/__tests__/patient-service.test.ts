import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

// ── Mock DB ──────────────────────────────────────────────────────
// A single MockDb instance is reused across tests; `beforeEach` recreates it
// so per-test queues and call records start fresh.
let db: MockDb;
const getDb = vi.fn(() => db);

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => getDb(),
  hmacForIndex: (val: string) => `hmac_${val}`,
  patients: { id: "patients.id" },
  diagnoses: { id: "diagnoses.id", patient_id: "diagnoses.patient_id" },
  allergies: { id: "allergies.id", patient_id: "allergies.patient_id" },
  careTeamMembers: { patient_id: "careTeamMembers.patient_id" },
  patientObservations: {
    id: "patientObservations.id",
    patient_id: "patientObservations.patient_id",
    created_at: "patientObservations.created_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
  desc: (col: unknown) => ({ desc: col }),
}));

// ── Mock BullMQ ──────────────────────────────────────────────────
const addMock = vi.fn().mockResolvedValue(undefined);
vi.mock("bullmq", () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: addMock })),
}));

vi.mock("@carebridge/redis-config", () => ({
  getRedisConnection: () => ({}),
  CLINICAL_EVENTS_JOB_OPTIONS: {},
}));

// ── Import after mocks ──────────────────────────────────────────
const { patientRecordsRouter } = await import("../router.js");

// Create a tRPC caller for testing
import { initTRPC } from "@trpc/server";
const t = initTRPC.create();
const caller = t.createCallerFactory(patientRecordsRouter)({});

const PATIENT_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
});

// ── Create ──────────────────────────────────────────────────────
describe("patient-records create", () => {
  it("inserts a patient and returns the record", async () => {
    const input = {
      name: "Jane Doe",
      date_of_birth: "1990-01-15",
      mrn: "MRN-001",
    };

    const result = await caller.create(input);

    expect(result).toMatchObject({
      name: "Jane Doe",
      date_of_birth: "1990-01-15",
      mrn: "MRN-001",
      mrn_hmac: "hmac_MRN-001",
    });
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeDefined();
    expect(db.insert).toHaveBeenCalledOnce();
    expect(db.insert.calls[0]?.chain).toContain("values");
  });

  it("handles missing mrn by setting mrn_hmac to undefined", async () => {
    const input = { name: "John Smith" };

    const result = await caller.create(input);

    expect(result.mrn_hmac).toBeUndefined();
    expect(db.insert).toHaveBeenCalledOnce();
  });
});

// ── Update ──────────────────────────────────────────────────────
describe("patient-records update", () => {
  it("updates a patient and returns the updated fields", async () => {
    const result = await caller.update({
      id: PATIENT_ID,
      name: "Updated Name",
    });

    expect(result).toMatchObject({ id: PATIENT_ID, name: "Updated Name" });
    expect(db.update).toHaveBeenCalledOnce();
    const call = db.update.calls[0];
    expect(call?.chain).toContain("set");
    expect(call?.chain).toContain("where");
  });
});

// ── GetById ─────────────────────────────────────────────────────
describe("patient-records getById", () => {
  it("returns a patient when found", async () => {
    const patientRow = {
      id: PATIENT_ID,
      name: "Jane Doe",
    };
    db.willSelect([patientRow]);

    const result = await caller.getById({ id: PATIENT_ID });

    expect(result).toEqual(patientRow);
  });

  it("returns null when patient is not found", async () => {
    db.willSelect([]);

    const result = await caller.getById({ id: "nonexistent" });

    expect(result).toBeNull();
  });
});

// ── List ────────────────────────────────────────────────────────
describe("patient-records list", () => {
  it("returns all patients", async () => {
    const rows = [
      { id: "1", name: "Alice" },
      { id: "2", name: "Bob" },
    ];
    db.willSelect(rows);

    const result = await caller.list();

    expect(result).toEqual(rows);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

const updateWhereMock = vi.fn().mockResolvedValue(undefined);
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

const selectLimitMock = vi.fn();
const selectWhereMock = vi.fn(() => ({ limit: selectLimitMock }));
const selectOrderByMock = vi.fn(() => ({ limit: vi.fn().mockResolvedValue([]) }));
const selectFromMock = vi.fn(() => ({
  where: selectWhereMock,
  orderBy: selectOrderByMock,
}));
const selectMock = vi.fn(() => ({ from: selectFromMock }));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    insert: insertMock,
    select: selectMock,
    update: updateMock,
  }),
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
    expect(insertMock).toHaveBeenCalledOnce();
    expect(insertValuesMock).toHaveBeenCalledOnce();
  });

  it("handles missing mrn by setting mrn_hmac to undefined", async () => {
    const input = { name: "John Smith" };

    const result = await caller.create(input);

    expect(result.mrn_hmac).toBeUndefined();
    expect(insertMock).toHaveBeenCalledOnce();
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
    expect(updateMock).toHaveBeenCalledOnce();
    expect(updateSetMock).toHaveBeenCalledOnce();
    expect(updateWhereMock).toHaveBeenCalledOnce();
  });
});

// ── GetById ─────────────────────────────────────────────────────
describe("patient-records getById", () => {
  it("returns a patient when found", async () => {
    const patientRow = {
      id: PATIENT_ID,
      name: "Jane Doe",
    };
    // getById uses select().from().where() which returns array directly
    selectFromMock.mockReturnValueOnce({
      where: vi.fn().mockResolvedValueOnce([patientRow]),
      orderBy: selectOrderByMock,
    });

    const result = await caller.getById({ id: PATIENT_ID });

    expect(result).toEqual(patientRow);
  });

  it("returns null when patient is not found", async () => {
    selectFromMock.mockReturnValueOnce({
      where: vi.fn().mockResolvedValueOnce([]),
      orderBy: selectOrderByMock,
    });

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
    selectFromMock.mockReturnValueOnce({
      where: selectWhereMock,
      orderBy: selectOrderByMock,
    });
    // list() calls select().from(patients) which resolves directly
    selectMock.mockReturnValueOnce({
      from: vi.fn().mockResolvedValueOnce(rows),
    });

    const result = await caller.list();

    expect(result).toEqual(rows);
  });
});

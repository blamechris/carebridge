import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

const updateSetWhereMock = vi.fn().mockResolvedValue(undefined);
const updateSetMock = vi.fn(() => ({ where: updateSetWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

const selectFromWhereLimitMock = vi.fn();
const selectFromWhereMock = vi.fn(() => ({ limit: selectFromWhereLimitMock }));
const selectFromMock = vi.fn(() => ({
  where: selectFromWhereMock,
  orderBy: vi.fn().mockReturnValue({ where: selectFromWhereMock }),
}));
const selectMock = vi.fn(() => ({ from: selectFromMock }));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    insert: insertMock,
    select: selectMock,
    update: updateMock,
  }),
  medications: {
    id: "id",
    patient_id: "patient_id",
    status: "status",
    created_at: "created_at",
  },
  medLogs: {},
}));

// ── Mock events ──────────────────────────────────────────────────
const emitClinicalEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../events.js", () => ({ emitClinicalEvent }));

// ── Import after mocks ──────────────────────────────────────────
const { createMedication, updateMedication } = await import(
  "../repositories/medication-repo.js"
);

const PATIENT_ID = "33333333-3333-3333-3333-333333333333";
const MED_ID = "44444444-4444-4444-4444-444444444444";

const sampleMedInput = {
  patient_id: PATIENT_ID,
  name: "Enoxaparin",
  brand_name: "Lovenox",
  dose_amount: 40,
  dose_unit: "mg",
  route: "subcutaneous" as const,
  frequency: "BID",
  status: "active" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createMedication", () => {
  it("inserts a medication and returns it with all fields", async () => {
    const result = await createMedication(sampleMedInput);

    expect(insertMock).toHaveBeenCalledOnce();
    expect(insertValuesMock).toHaveBeenCalledOnce();

    expect(result).toMatchObject({
      patient_id: PATIENT_ID,
      name: "Enoxaparin",
      brand_name: "Lovenox",
      dose_amount: 40,
      dose_unit: "mg",
      route: "subcutaneous",
      status: "active",
    });
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeDefined();
    expect(result.updated_at).toBeDefined();
  });

  it("emits medication.created event", async () => {
    const result = await createMedication(sampleMedInput);

    expect(emitClinicalEvent).toHaveBeenCalledOnce();
    const emittedEvent = emitClinicalEvent.mock.calls[0][0];
    expect(emittedEvent).toMatchObject({
      type: "medication.created",
      patient_id: PATIENT_ID,
      data: {
        resourceId: result.id,
        name: "Enoxaparin",
        status: "active",
      },
    });
  });
});

describe("updateMedication", () => {
  it("emits medication.updated event with changed fields", async () => {
    const existingRow = {
      id: MED_ID,
      patient_id: PATIENT_ID,
      name: "Enoxaparin",
      brand_name: "Lovenox",
      dose_amount: 40,
      dose_unit: "mg",
      route: "subcutaneous",
      frequency: "BID",
      status: "active",
      started_at: null,
      ended_at: null,
      prescribed_by: null,
      notes: null,
      rxnorm_code: null,
      ordering_provider_id: null,
      encounter_id: null,
      source_system: null,
      created_at: "2026-03-15T10:00:00.000Z",
      updated_at: "2026-03-15T10:00:00.000Z",
    };

    // First select: find existing record
    selectFromWhereLimitMock.mockResolvedValueOnce([existingRow]);
    // Second select: re-fetch updated record
    selectFromWhereLimitMock.mockResolvedValueOnce([
      { ...existingRow, status: "discontinued", updated_at: "2026-03-16T10:00:00.000Z" },
    ]);

    await updateMedication(MED_ID, { status: "discontinued" });

    expect(emitClinicalEvent).toHaveBeenCalledOnce();
    const emittedEvent = emitClinicalEvent.mock.calls[0][0];
    expect(emittedEvent).toMatchObject({
      type: "medication.updated",
      patient_id: PATIENT_ID,
      data: {
        resourceId: MED_ID,
        changedFields: ["status"],
      },
    });
  });

  it("throws when medication is not found", async () => {
    selectFromWhereLimitMock.mockResolvedValueOnce([]);

    await expect(updateMedication("nonexistent", { status: "discontinued" }))
      .rejects.toThrow("Medication nonexistent not found");
  });
});

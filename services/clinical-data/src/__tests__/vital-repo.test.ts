import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

const selectFromWhereMock = vi.fn().mockReturnValue({
  orderBy: vi.fn().mockResolvedValue([]),
});
const selectFromMock = vi.fn((table: unknown) => ({
  where: selectFromWhereMock,
}));
const selectMock = vi.fn(() => ({ from: selectFromMock }));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    insert: insertMock,
    select: selectMock,
  }),
  vitals: { patient_id: "patient_id", type: "type", recorded_at: "recorded_at" },
}));

// ── Mock events ──────────────────────────────────────────────────
const emitClinicalEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../events.js", () => ({ emitClinicalEvent }));

// ── Import after mocks ──────────────────────────────────────────
const { createVital, getVitalsByPatient } = await import(
  "../repositories/vital-repo.js"
);

const PATIENT_ID = "11111111-1111-1111-1111-111111111111";

const sampleVitalInput = {
  patient_id: PATIENT_ID,
  recorded_at: "2026-03-15T10:30:00.000Z",
  type: "heart_rate" as const,
  value_primary: 72,
  unit: "bpm",
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createVital", () => {
  it("inserts a vital record and returns it with all fields", async () => {
    const result = await createVital(sampleVitalInput);

    expect(insertMock).toHaveBeenCalledOnce();
    expect(insertValuesMock).toHaveBeenCalledOnce();

    expect(result).toMatchObject({
      patient_id: PATIENT_ID,
      type: "heart_rate",
      value_primary: 72,
      unit: "bpm",
      recorded_at: "2026-03-15T10:30:00.000Z",
    });
    expect(result.id).toBeDefined();
    expect(result.created_at).toBeDefined();
  });

  it("emits a clinical event with correct shape", async () => {
    const result = await createVital(sampleVitalInput);

    expect(emitClinicalEvent).toHaveBeenCalledOnce();

    const emittedEvent = emitClinicalEvent.mock.calls[0][0];
    expect(emittedEvent).toMatchObject({
      type: "vital.created",
      patient_id: PATIENT_ID,
      data: {
        resourceId: result.id,
        vitalType: "heart_rate",
        value: 72,
      },
    });
    expect(emittedEvent.id).toBeDefined();
    expect(emittedEvent.timestamp).toBeDefined();
  });
});

describe("getVitalsByPatient", () => {
  it("queries vitals for the correct patient", async () => {
    const mockRows = [
      {
        id: "v1",
        patient_id: PATIENT_ID,
        recorded_at: "2026-03-15T10:30:00.000Z",
        type: "heart_rate",
        value_primary: 72,
        value_secondary: null,
        unit: "bpm",
        notes: null,
        provider_id: null,
        encounter_id: null,
        source_system: null,
        created_at: "2026-03-15T10:30:00.000Z",
      },
    ];

    selectFromWhereMock.mockReturnValueOnce({
      orderBy: vi.fn().mockResolvedValue(mockRows),
    });

    const results = await getVitalsByPatient(PATIENT_ID);

    expect(selectMock).toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      id: "v1",
      patient_id: PATIENT_ID,
      type: "heart_rate",
      value_primary: 72,
      unit: "bpm",
    });
  });

  it("returns empty array when no vitals exist for patient", async () => {
    selectFromWhereMock.mockReturnValueOnce({
      orderBy: vi.fn().mockResolvedValue([]),
    });

    const results = await getVitalsByPatient("nonexistent-id");
    expect(results).toEqual([]);
  });
});

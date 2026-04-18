import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

// ── Mock DB ──────────────────────────────────────────────────────
let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
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
  db = createMockDb();
});

describe("createVital", () => {
  it("inserts a vital record and returns it with all fields", async () => {
    const result = await createVital(sampleVitalInput);

    expect(db.insert).toHaveBeenCalledOnce();
    expect(db.insert.calls[0]?.chain).toContain("values");

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

    db.willSelect(mockRows);

    const results = await getVitalsByPatient(PATIENT_ID);

    expect(db.select).toHaveBeenCalled();
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
    db.willSelect([]);

    const results = await getVitalsByPatient("nonexistent-id");
    expect(results).toEqual([]);
  });
});

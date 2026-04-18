import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

// ── Mock DB ──────────────────────────────────────────────────────
let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  medications: {
    id: "id",
    patient_id: "patient_id",
    status: "status",
    created_at: "created_at",
    updated_at: "updated_at",
  },
  medLogs: {},
  allergies: {
    patient_id: "patient_id",
  },
}));

// ── Mock events ──────────────────────────────────────────────────
const emitClinicalEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../events.js", () => ({ emitClinicalEvent }));

// ── Import after mocks ──────────────────────────────────────────
const { createMedication, updateMedication, ConflictError } = await import(
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
  db = createMockDb();
});

describe("createMedication", () => {
  it("inserts a medication and returns it with all fields", async () => {
    // createMedication first selects allergies — return none so the insert path runs.
    db.willSelect([]);

    const result = await createMedication(sampleMedInput);

    expect(db.insert).toHaveBeenCalledOnce();
    expect(db.insert.calls[0]?.chain).toContain("values");

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
    db.willSelect([]); // no allergy conflicts

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

    // First select: find existing record.
    db.willSelect([existingRow]);
    // Update returning: row was updated.
    db.willUpdate([{ id: MED_ID }]);
    // Second select: re-fetch updated record.
    db.willSelect([
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
        name: "Enoxaparin",
        status: "discontinued",
      },
    });
  });

  it("throws when medication is not found", async () => {
    db.willSelect([]);

    await expect(updateMedication("nonexistent", { status: "discontinued" }))
      .rejects.toThrow("Medication nonexistent not found");
  });

  it("succeeds when expectedUpdatedAt matches the current value", async () => {
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

    db.willSelect([existingRow]);
    db.willUpdate([{ id: MED_ID }]);
    db.willSelect([
      { ...existingRow, status: "discontinued", updated_at: "2026-03-16T10:00:00.000Z" },
    ]);

    const result = await updateMedication(MED_ID, {
      status: "discontinued",
      expectedUpdatedAt: "2026-03-15T10:00:00.000Z",
    });

    expect(result.status).toBe("discontinued");
    expect(db.update).toHaveBeenCalledOnce();
    expect(db.update.calls[0]?.chain).toContain("set");
    expect(db.update.calls[0]?.chain).toContain("where");
  });

  it("throws ConflictError when expectedUpdatedAt does not match (concurrent modification)", async () => {
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
      updated_at: "2026-03-16T12:00:00.000Z", // already modified by another user
    };

    db.willSelect([existingRow]);
    // Update returns 0 rows because updated_at doesn't match.
    db.willUpdate([]);

    const error = await updateMedication(MED_ID, {
      status: "discontinued",
      expectedUpdatedAt: "2026-03-15T10:00:00.000Z", // stale value
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as InstanceType<typeof ConflictError>).message).toBe(
      "Medication was modified by another user. Please refresh and try again.",
    );
    // Event should NOT have been emitted on conflict
    expect(emitClinicalEvent).not.toHaveBeenCalled();
  });

  it("persists 'held' status and emits event with status='held' (unblocks ONCO-ANTICOAG-HELD)", async () => {
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

    db.willSelect([existingRow]);
    db.willUpdate([{ id: MED_ID }]);
    db.willSelect([
      { ...existingRow, status: "held", updated_at: "2026-03-16T10:00:00.000Z" },
    ]);

    const result = await updateMedication(MED_ID, { status: "held" });

    expect(result.status).toBe("held");
    expect(emitClinicalEvent).toHaveBeenCalledOnce();
    const emittedEvent = emitClinicalEvent.mock.calls[0][0];
    expect(emittedEvent).toMatchObject({
      type: "medication.updated",
      patient_id: PATIENT_ID,
      data: {
        resourceId: MED_ID,
        changedFields: ["status"],
        name: "Enoxaparin",
        status: "held",
      },
    });
  });

  it("does not check optimistic locking when expectedUpdatedAt is omitted", async () => {
    const existingRow = {
      id: MED_ID,
      patient_id: PATIENT_ID,
      name: "Enoxaparin",
      brand_name: null,
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

    db.willSelect([existingRow]);
    db.willUpdate([{ id: MED_ID }]);
    db.willSelect([
      { ...existingRow, frequency: "TID", updated_at: "2026-03-16T10:00:00.000Z" },
    ]);

    // Should succeed without expectedUpdatedAt (backwards compatible)
    const result = await updateMedication(MED_ID, { frequency: "TID" });
    expect(result.frequency).toBe("TID");
  });
});

describe("allergy safety check", () => {
  it("blocks medication that directly matches a patient allergy", async () => {
    db.willSelect([
      {
        id: "allergy-1",
        patient_id: PATIENT_ID,
        allergen: "Penicillin",
        rxnorm_code: null,
        severity: "severe",
        reaction: "anaphylaxis",
        snomed_code: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await expect(
      createMedication({ ...sampleMedInput, name: "Penicillin V" }),
    ).rejects.toThrow(/ALLERGY_CONFLICT.*Penicillin/);

    // Must NOT have inserted into the database
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("blocks medication that cross-reacts with a patient allergy (penicillin → amoxicillin)", async () => {
    db.willSelect([
      {
        id: "allergy-2",
        patient_id: PATIENT_ID,
        allergen: "Penicillin",
        rxnorm_code: null,
        severity: "severe",
        reaction: "anaphylaxis",
        snomed_code: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);

    await expect(
      createMedication({ ...sampleMedInput, name: "Amoxicillin 500mg" }),
    ).rejects.toThrow(/ALLERGY_CONFLICT.*Amoxicillin.*Penicillin.*penicillin/);

    expect(db.insert).not.toHaveBeenCalled();
  });

  it("allows medication when no allergy conflicts exist", async () => {
    db.willSelect([
      {
        id: "allergy-3",
        patient_id: PATIENT_ID,
        allergen: "Penicillin",
        rxnorm_code: null,
        severity: "moderate",
        reaction: "rash",
        snomed_code: null,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await createMedication(sampleMedInput); // Enoxaparin — no penicillin cross-reactivity

    expect(result.name).toBe("Enoxaparin");
    expect(db.insert).toHaveBeenCalledOnce();
  });

  it("allows medication when patient has no allergies", async () => {
    db.willSelect([]);

    const result = await createMedication(sampleMedInput);

    expect(result.name).toBe("Enoxaparin");
    expect(db.insert).toHaveBeenCalledOnce();
  });
});

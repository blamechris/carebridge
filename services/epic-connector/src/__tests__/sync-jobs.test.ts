/**
 * Tests for the sync-job orchestrators (#391).
 *
 * Verifies the full/incremental/single dispatch wiring without touching
 * Redis, Postgres, or Epic. Persistence + sync-state-repo are mocked so
 * each test can assert exactly which calls the orchestrator made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClinicalEvent } from "@carebridge/shared-types";

// ── Mock persistence ─────────────────────────────────────────────
const persistPatient = vi.fn();
const persistObservation = vi.fn();
const persistCondition = vi.fn();
const persistMedicationRequest = vi.fn();
const persistAllergy = vi.fn();

vi.mock("../sync/persistence.js", () => ({
  persistPatient,
  persistObservation,
  persistCondition,
  persistMedicationRequest,
  persistAllergy,
  persistMedicationStatement: vi.fn(),
}));

// ── Mock sync-state-repo ─────────────────────────────────────────
const markRunning = vi.fn().mockResolvedValue(undefined);
const markOk = vi.fn().mockResolvedValue(undefined);
const markFailed = vi.fn().mockResolvedValue(undefined);
const getSyncState = vi.fn().mockResolvedValue(null);

vi.mock("../sync/sync-state-repo.js", () => ({
  markRunning,
  markOk,
  markFailed,
  getSyncState,
  getAllSyncStatesForPatient: vi.fn(),
  listRecentFailures: vi.fn(),
}));

// ── Import after mocks ──────────────────────────────────────────
const {
  runFullSync,
  runIncrementalSync,
  runSingleResourceSync,
  SUPPORTED_RESOURCE_TYPES,
} = await import("../sync/sync-jobs.js");

const PATIENT_ID = "11111111-1111-1111-1111-111111111111";
const EPIC_PATIENT_FHIR_ID = "epic-patient-1";

function makeFakeClient(resourcesByType: Record<string, unknown[]>) {
  return {
    readPatient: vi.fn().mockResolvedValue(
      resourcesByType.Patient?.[0] ?? {
        resourceType: "Patient",
        id: EPIC_PATIENT_FHIR_ID,
      },
    ),
    searchAll: vi.fn().mockImplementation((resourceType: string) => {
      const list = resourcesByType[resourceType] ?? [];
      return (async function* () {
        for (const r of list) yield r;
      })();
    }),
  } as unknown as Parameters<typeof runFullSync>[1]["client"];
}

describe("Epic sync-jobs (#391)", () => {
  let emit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    emit = vi.fn().mockResolvedValue(undefined);
  });

  it("runSingleResourceSync fetches, persists, and emits a clinical-event with source_system=epic", async () => {
    persistObservation.mockResolvedValueOnce({
      internalId: "internal-vital-1",
      kind: "vital",
      inserted: true,
    });
    const client = makeFakeClient({
      Observation: [
        { resourceType: "Observation", id: "obs-1", meta: { lastUpdated: "2026-05-20T10:00:00Z" } },
      ],
    });

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "Observation",
        watermark: null,
      },
      { client, emit },
    );

    expect(markRunning).toHaveBeenCalledWith(PATIENT_ID, "Observation");
    expect(persistObservation).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledOnce();

    const event = emit.mock.calls[0]![0] as ClinicalEvent;
    expect(event.type).toBe("vital.created");
    expect(event.patient_id).toBe(PATIENT_ID);
    expect(event.data.source_system).toBe("epic");
    expect(event.data.epic_fhir_id).toBe("obs-1");
    expect(event.data.operation).toBe("created");

    expect(markOk).toHaveBeenCalledOnce();
    expect(markOk.mock.calls[0]![0]).toMatchObject({
      patientId: PATIENT_ID,
      resourceType: "Observation",
      highWatermark: "2026-05-20T10:00:00Z",
      importedCount: 1,
    });

    expect(result).toMatchObject({
      patient_id: PATIENT_ID,
      resource_type: "Observation",
      imported: 1,
      updated: 0,
      conflicts: 0,
      errors: [],
    });
  });

  it("emits vital.updated (not vital.created) when persist reports inserted=false", async () => {
    persistObservation.mockResolvedValueOnce({
      internalId: "internal-vital-1",
      kind: "vital",
      inserted: false,
    });
    const client = makeFakeClient({
      Observation: [{ resourceType: "Observation", id: "obs-1" }],
    });

    await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "Observation",
        watermark: null,
      },
      { client, emit },
    );

    const event = emit.mock.calls[0]![0] as ClinicalEvent;
    expect(event.type).toBe("vital.updated");
    expect(event.data.operation).toBe("updated");
  });

  it("does NOT emit when persist returns a conflict", async () => {
    persistMedicationRequest.mockResolvedValueOnce({
      internalId: "internal-med-1",
      kind: "medication",
      inserted: false,
      conflict: "source_system_conflict",
    });
    const client = makeFakeClient({
      MedicationRequest: [
        { resourceType: "MedicationRequest", id: "med-1" },
      ],
    });

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "MedicationRequest",
        watermark: null,
      },
      { client, emit },
    );

    expect(emit).not.toHaveBeenCalled();
    expect(result.conflicts).toBe(1);
    expect(result.imported).toBe(0);
  });

  it("skips unmapped resources without crashing the loop", async () => {
    persistObservation
      .mockResolvedValueOnce({
        internalId: null,
        kind: "unmapped",
        inserted: false,
      })
      .mockResolvedValueOnce({
        internalId: "internal-vital-2",
        kind: "vital",
        inserted: true,
      });
    const client = makeFakeClient({
      Observation: [
        { resourceType: "Observation", id: "obs-unmappable" },
        { resourceType: "Observation", id: "obs-good" },
      ],
    });

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "Observation",
        watermark: null,
      },
      { client, emit },
    );

    expect(persistObservation).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledOnce();
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("captures per-resource failures without aborting the resource-type batch", async () => {
    persistCondition
      .mockRejectedValueOnce(new Error("write blew up"))
      .mockResolvedValueOnce({
        internalId: "diag-2",
        kind: "diagnosis",
        inserted: true,
      });
    const client = makeFakeClient({
      Condition: [
        { resourceType: "Condition", id: "cond-1" },
        { resourceType: "Condition", id: "cond-2" },
      ],
    });

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "Condition",
        watermark: null,
      },
      { client, emit },
    );

    expect(result.imported).toBe(1);
    expect(result.errors).toEqual(["write blew up"]);
    // Failure of one resource still results in `markOk` for the batch —
    // the per-resource errors are surfaced via the SyncResult, not by
    // marking the whole resource_type as failed.
    expect(markOk).toHaveBeenCalled();
  });

  it("marks the resource_type FAILED when the fetch itself throws", async () => {
    const client = makeFakeClient({});
    (client.searchAll as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("network down");
    });

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "Condition",
        watermark: null,
      },
      { client, emit },
    );

    expect(markFailed).toHaveBeenCalledWith({
      patientId: PATIENT_ID,
      resourceType: "Condition",
      errorMessage: "network down",
    });
    expect(result.errors).toContain("network down");
  });

  it("Patient resource fetch uses readPatient(epicPatientFhirId), not searchAll", async () => {
    persistPatient.mockResolvedValueOnce({
      internalId: PATIENT_ID,
      kind: "patient",
      inserted: false,
    });
    const client = makeFakeClient({
      Patient: [{ resourceType: "Patient", id: EPIC_PATIENT_FHIR_ID }],
    });

    await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "Patient",
        watermark: null,
      },
      { client, emit },
    );

    expect(client.readPatient).toHaveBeenCalledWith(EPIC_PATIENT_FHIR_ID);
    expect(client.searchAll).not.toHaveBeenCalled();
  });

  it("incremental sync passes the stored watermark as _lastUpdated=gt<value>", async () => {
    getSyncState.mockImplementation(async (_p, rt) =>
      rt === "Observation"
        ? {
            patient_id: PATIENT_ID,
            resource_type: "Observation",
            last_fhir_lastupdated: "2026-05-01T00:00:00Z",
            last_synced_at: "2026-05-01T00:00:00Z",
            status: "ok",
            resources_synced_count: 5,
            error_count: 0,
            last_error_message: null,
            last_error_at: null,
          }
        : null,
    );
    persistPatient.mockResolvedValue({
      internalId: PATIENT_ID,
      kind: "patient",
      inserted: false,
    });
    const client = makeFakeClient({});

    await runIncrementalSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
      },
      { client, emit },
    );

    const observationCall = (client.searchAll as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === "Observation",
    );
    expect(observationCall).toBeDefined();
    expect(observationCall![1]._lastUpdated).toBe("gt2026-05-01T00:00:00Z");
  });

  it("full sync iterates every supported resource type", async () => {
    persistPatient.mockResolvedValue({
      internalId: PATIENT_ID,
      kind: "patient",
      inserted: false,
    });
    const client = makeFakeClient({});
    await runFullSync(
      { patientId: PATIENT_ID, epicPatientFhirId: EPIC_PATIENT_FHIR_ID },
      { client, emit },
    );
    // Patient = readPatient; the rest = searchAll
    const searchedTypes = (client.searchAll as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => c[0],
    );
    for (const rt of SUPPORTED_RESOURCE_TYPES) {
      if (rt === "Patient") continue;
      expect(searchedTypes).toContain(rt);
    }
  });
});

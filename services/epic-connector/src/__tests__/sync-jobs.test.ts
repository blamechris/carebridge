/**
 * Tests for the sync-job orchestrators (#391).
 *
 * Verifies the full/incremental/single dispatch wiring without touching
 * Redis, Postgres, or Epic. Persistence + sync-state-repo are mocked so
 * each test can assert exactly which calls the orchestrator made.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ClinicalEvent } from "@carebridge/shared-types";
import { EpicFhirError } from "../fhir-client.js";
import type { OperationOutcome } from "../fhir-types.js";

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

  // ── #1094: Epic-specific search-param requirements ─────────────
  // Epic's R4 sandbox rejects blanket `?patient=X` queries for
  // Observation (needs `category`) and MedicationRequest (needs
  // `status`). The sync-job fetch layer fans out so each request
  // Epic sees carries the params it whitelists.

  it("Observation fetch fans out across vital-signs and laboratory categories", async () => {
    const client = makeFakeClient({
      Observation: [{ resourceType: "Observation", id: "obs-1" }],
    });
    persistObservation.mockResolvedValue({
      internalId: "obs-internal",
      kind: "vital",
      inserted: true,
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

    const observationCalls = (
      client.searchAll as ReturnType<typeof vi.fn>
    ).mock.calls.filter((c) => c[0] === "Observation");
    expect(observationCalls).toHaveLength(2);
    const categories = observationCalls.map((c) => c[1].category).sort();
    expect(categories).toEqual(["laboratory", "vital-signs"]);
    // Both calls must still carry `patient` so Epic scopes results.
    for (const call of observationCalls) {
      expect(call[1].patient).toBe(EPIC_PATIENT_FHIR_ID);
    }
  });

  it("Observation fetch dedups resources that appear in multiple category fan-out responses", async () => {
    // Same Observation id under both categories — defensive guard
    // against Epic returning the same row for vital-signs and laboratory.
    const sharedObservation = { resourceType: "Observation", id: "obs-shared" };
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation(() =>
        (async function* () {
          yield sharedObservation;
        })(),
      ),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    persistObservation.mockResolvedValue({
      internalId: "obs-internal",
      kind: "vital",
      inserted: true,
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

    // searchAll fires twice (fan-out), persistObservation should
    // fire once because the duplicate is dropped before persistence.
    expect(client.searchAll).toHaveBeenCalledTimes(2);
    expect(persistObservation).toHaveBeenCalledTimes(1);
    expect(result.imported).toBe(1);
  });

  it("MedicationRequest fetch defaults to status=active so Epic accepts the query", async () => {
    const client = makeFakeClient({
      MedicationRequest: [{ resourceType: "MedicationRequest", id: "med-1" }],
    });
    persistMedicationRequest.mockResolvedValue({
      internalId: "med-internal",
      kind: "medication",
      inserted: true,
    });

    await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "MedicationRequest",
        watermark: null,
      },
      { client, emit },
    );

    const medCall = (
      client.searchAll as ReturnType<typeof vi.fn>
    ).mock.calls.find((c) => c[0] === "MedicationRequest");
    expect(medCall).toBeDefined();
    expect(medCall![1].status).toBe("active");
    expect(medCall![1].patient).toBe(EPIC_PATIENT_FHIR_ID);
  });

  it("Observation fan-out swallows 'not authorized sub-resource' on individual categories", async () => {
    // Simulate Epic rejecting vital-signs (app doesn't carry that scope)
    // but accepting laboratory. Sync should still succeed for labs.
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation((_resourceType: string, params: Record<string, string>) => {
        if (params.category === "vital-signs") {
          return (async function* () {
            throw new Error(
              "Epic FHIR request returned 400 Bad Request — Combination of parameters is not valid for any authorized sub-resource. No search was performed.",
            );
          })();
        }
        return (async function* () {
          yield { resourceType: "Observation", id: "lab-1" };
        })();
      }),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    persistObservation.mockResolvedValue({
      internalId: "obs-internal",
      kind: "lab",
      inserted: true,
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

    expect(client.searchAll).toHaveBeenCalledTimes(2);
    expect(persistObservation).toHaveBeenCalledTimes(1);
    expect(result.imported).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("Observation fan-out re-throws errors that are NOT auth-scope failures", async () => {
    // Network error, 5xx, malformed response — must NOT be swallowed.
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation(() => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:443");
      }),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "Observation",
        watermark: null,
      },
      { client, emit },
    );

    // Fetch threw → resource_type marked failed in result.errors.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("ECONNREFUSED");
  });

  it("Observation fan-out does NOT swallow Epic 400s that lack 'authorized sub-resource' (genuine request-shape errors)", async () => {
    // Epic returns "Combination of parameters is not valid" for both
    // scope-rejection (with "authorized sub-resource") AND for genuine
    // request-shape problems (missing required params, unsupported
    // search modifiers). The soft-skip MUST only swallow the former —
    // dropping data because of a real shape bug would be silent corruption.
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation(() =>
        (async function* () {
          throw new Error(
            "Epic FHIR request returned 400 Bad Request — Combination of parameters is not valid. Unsupported search modifier on `_lastUpdated`.",
          );
        })(),
      ),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "Observation",
        watermark: null,
      },
      { client, emit },
    );

    // Surfaces as a per-resource-type error, NOT a silent skip.
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Combination of parameters is not valid");
    expect(result.errors[0]).not.toContain("authorized sub-resource");
  });

  it("MedicationRequest fan-out gracefully skips when scope isn't authorized", async () => {
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation(() =>
        (async function* () {
          throw new Error(
            "Epic FHIR request returned 400 Bad Request — Combination of parameters is not valid for any authorized sub-resource.",
          );
        })(),
      ),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "MedicationRequest",
        watermark: null,
      },
      { client, emit },
    );

    // Soft-skip means zero imports and zero errors — the
    // resource_type ran successfully, it just had nothing to import.
    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(persistMedicationRequest).not.toHaveBeenCalled();
  });

  it("Observation fan-out preserves the incremental watermark on every category call", async () => {
    getSyncState.mockImplementation(async (_p, rt) =>
      rt === "Observation"
        ? {
            patient_id: PATIENT_ID,
            resource_type: "Observation",
            last_fhir_lastupdated: "2026-04-01T00:00:00Z",
            last_synced_at: "2026-04-01T00:00:00Z",
            status: "ok",
            resources_synced_count: 0,
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
      { patientId: PATIENT_ID, epicPatientFhirId: EPIC_PATIENT_FHIR_ID },
      { client, emit },
    );

    const observationCalls = (
      client.searchAll as ReturnType<typeof vi.fn>
    ).mock.calls.filter((c) => c[0] === "Observation");
    expect(observationCalls).toHaveLength(2);
    for (const call of observationCalls) {
      expect(call[1]._lastUpdated).toBe("gt2026-04-01T00:00:00Z");
    }
  });

  // ── #1096 / #1099: structured detection + error-shape coverage ──
  // The fhir-client now throws EpicFhirError carrying the parsed
  // OperationOutcome. isUnauthorizedSubResourceError prefers structured
  // detection on `details.coding[].code === "59022"` over substring
  // matching the human text. Tests below cover BOTH the structured
  // path (new) and the substring fallback (legacy safety net).

  function epicAuthScopeError(): EpicFhirError {
    const oo: OperationOutcome = {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "fatal",
          code: "invalid",
          details: {
            text: "Combination of parameters is not valid for any authorized sub-resource. No search was performed.",
            coding: [{ code: "59022" }],
          },
        },
      ],
    };
    return new EpicFhirError(
      "Epic FHIR request returned 400 Bad Request — Combination of parameters is not valid for any authorized sub-resource.",
      400,
      "Bad Request",
      JSON.stringify(oo),
      oo,
    );
  }

  function epicMissingElementError(): EpicFhirError {
    const oo: OperationOutcome = {
      resourceType: "OperationOutcome",
      issue: [
        {
          severity: "fatal",
          code: "required",
          details: {
            text: "A required element is missing.",
            coding: [{ code: "59108" }],
          },
        },
      ],
    };
    return new EpicFhirError(
      "Epic FHIR request returned 400 Bad Request — A required element is missing.",
      400,
      "Bad Request",
      JSON.stringify(oo),
      oo,
    );
  }

  it("structured detection: EpicFhirError with code 59022 → soft-skipped", async () => {
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation(() =>
        (async function* () {
          throw epicAuthScopeError();
        })(),
      ),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "MedicationRequest",
        watermark: null,
      },
      { client, emit },
    );

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(persistMedicationRequest).not.toHaveBeenCalled();
  });

  it("structured detection: EpicFhirError with code 59108 (missing element) → NOT swallowed", async () => {
    // 59108 means the request shape is bad (e.g. Observation without
    // category) — that's a real bug in the caller, not a scope issue.
    // Soft-skip MUST NOT swallow it or we'd silently lose data after
    // a future fhir-client refactor breaks param construction.
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation(() =>
        (async function* () {
          throw epicMissingElementError();
        })(),
      ),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "Observation",
        watermark: null,
      },
      { client, emit },
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("A required element is missing");
  });

  it("substring fallback: EpicFhirError without parsed OO but message says 'authorized sub-resource' → soft-skipped", async () => {
    // Real-world fallback: Epic edge proxy returns the auth-scope
    // error as a non-JSON body (HTML/plain text). The OperationOutcome
    // parse fails, but the substring is still in the Error message.
    const fallback = new EpicFhirError(
      "Epic FHIR request returned 400 Bad Request — Combination of parameters is not valid for any authorized sub-resource.",
      400,
      "Bad Request",
      "non-json body",
      undefined,
    );
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation(() =>
        (async function* () {
          throw fallback;
        })(),
      ),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "MedicationRequest",
        watermark: null,
      },
      { client, emit },
    );

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // #1099 acceptance #1: lock-in for the operationOutcomeError() shape
  it("substring fallback: 'Epic returned OperationOutcome:' shape with auth-scope text → soft-skipped", async () => {
    // fhir-client's operationOutcomeError() helper produces this
    // alternate shape: "Epic returned OperationOutcome: invalid — <text>".
    // It's currently emitted from createResource/updateResource and
    // from read() on an OperationOutcome response. The soft-skip must
    // match this shape too so future code that catches this Error form
    // gets the same skip behavior.
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation(() =>
        (async function* () {
          throw new Error(
            "Epic returned OperationOutcome: invalid — Combination of parameters is not valid for any authorized sub-resource. No search was performed.",
          );
        })(),
      ),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "MedicationRequest",
        watermark: null,
      },
      { client, emit },
    );

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // #1099 acceptance #2: dedup invariant with non-trivial overlap
  it("Observation dedup correctly merges [A,B] + [B,C] → [A,B,C]", async () => {
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation((_rt: string, params: Record<string, string>) => {
        if (params.category === "vital-signs") {
          return (async function* () {
            yield { resourceType: "Observation", id: "A" };
            yield { resourceType: "Observation", id: "B" };
          })();
        }
        // laboratory
        return (async function* () {
          yield { resourceType: "Observation", id: "B" };
          yield { resourceType: "Observation", id: "C" };
        })();
      }),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    persistObservation.mockResolvedValue({
      internalId: "internal",
      kind: "vital",
      inserted: true,
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

    // 3 unique observations persisted (A, B, C) — not 4.
    expect(persistObservation).toHaveBeenCalledTimes(3);
    const persistedIds = persistObservation.mock.calls
      .map((c) => (c[0] as { id: string }).id)
      .sort();
    expect(persistedIds).toEqual(["A", "B", "C"]);
    expect(result.imported).toBe(3);
  });

  // #1099 acceptance #3: synchronous-throw soft-skip case
  it("soft-skip works when EpicFhirError is thrown SYNCHRONOUSLY from searchAll (not just from inside the generator)", async () => {
    // Earlier soft-skip tests throw from inside the async generator
    // body. Some fetch wrappers throw synchronously *before* returning
    // the iterable — this test locks in that the wrapping catch in
    // collectSearchOrSkipUnauthorized covers BOTH call paths.
    const client = {
      readPatient: vi.fn(),
      searchAll: vi.fn().mockImplementation(() => {
        throw epicAuthScopeError();
      }),
    } as unknown as Parameters<typeof runFullSync>[1]["client"];

    const result = await runSingleResourceSync(
      {
        patientId: PATIENT_ID,
        epicPatientFhirId: EPIC_PATIENT_FHIR_ID,
        resourceType: "MedicationRequest",
        watermark: null,
      },
      { client, emit },
    );

    expect(result.imported).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  // #1099 acceptance #4: documented placeholder for multi-status fan-out
  it.skip(
    "MedicationRequest fan-out supports multi-status override (active + on-hold + completed) — future",
    async () => {
      // When the worker dispatch grows a `medication_request_statuses?:
      // string[]` override, this test should drive the fan-out across
      // each status as a separate searchAll call. Today the default is
      // hardcoded to "active" and there's no per-job override channel
      // — see issue #1097 for the related sync_result signalling work.
      expect(false).toBe(true);
    },
  );
});

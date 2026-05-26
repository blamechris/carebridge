/**
 * Defense-in-depth cap on findConflictingMappings (#1231).
 *
 * Background: #1219 introduced a 5-row forensic cap on the conflicting
 * Epic-mapping lookup used by the `epic_sync_dedup_conflict` audit row.
 * The cap was enforced purely at SQL via `.limit(CAP_CONFLICTING_MAPPINGS)`.
 * A future query-builder refactor, an accidentally-dropped limit, or a
 * test mock that over-queues rows could let the audit payload grow past
 * the bound.
 *
 * This suite pins the cap at the JS layer: hand the function 7 rows
 * (bypassing the SQL `.limit()` via the mock DB) and assert the audit's
 * `existing_epic_fhir_ids` array is truncated to exactly 5 entries — the
 * first 5 in arrival order, with the back-compat scalar
 * `existing_epic_fhir_id` still pointing at the first entry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  patients: {
    id: "id",
    mrn_hmac: "mrn_hmac",
    patient_id: "patient_id",
  },
  medications: {
    id: "id",
    patient_id: "patient_id",
    rxnorm_code: "rxnorm_code",
    started_at: "started_at",
  },
  vitals: {
    id: "id",
    patient_id: "patient_id",
    loinc_code: "loinc_code",
    recorded_at: "recorded_at",
  },
  labPanels: {},
  labResults: {},
  diagnoses: {
    id: "id",
    patient_id: "patient_id",
    icd10_code: "icd10_code",
    snomed_code: "snomed_code",
    onset_date: "onset_date",
  },
  allergies: {
    id: "id",
    patient_id: "patient_id",
    rxnorm_code: "rxnorm_code",
    snomed_code: "snomed_code",
  },
  encounters: {
    id: "id",
    patient_id: "patient_id",
    start_time: "start_time",
    encounter_type: "encounter_type",
  },
  fhirResources: {
    id: "id",
    resource_type: "resource_type",
    resource_id: "resource_id",
    internal_record_id: "internal_record_id",
  },
  auditLog: {},
  hmacForIndex: (value: string) => `hmac:${value}`,
}));

const { persistEncounter } = await import("../sync/persistence.js");

const PATIENT_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
});

function findAuditInsert(
  action: string,
): Record<string, unknown> | undefined {
  const hit = db.insert.calls.find((c) => {
    const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
    return v?.action === action;
  });
  return hit?.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
}

const RESOURCE = {
  resourceType: "Encounter",
  id: "epic-enc-NEW",
  status: "finished",
  class: { code: "AMB" },
  subject: { reference: "Patient/p-1" },
  period: { start: "2026-05-20T09:00:00Z", end: "2026-05-20T09:45:00Z" },
};

describe("findConflictingMappings JS-level cap (#1231)", () => {
  it("hands the function 7 rows (mock bypasses SQL .limit()) → audit's existing_epic_fhir_ids is capped at 5", async () => {
    const existingInternalId = "internal-enc-overcap";
    const existingEpicIds = [
      "epic-enc-A",
      "epic-enc-B",
      "epic-enc-C",
      "epic-enc-D",
      "epic-enc-E",
      "epic-enc-F",
      "epic-enc-G",
    ];

    db.willSelect([]); // findMapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        start_time: "2026-05-20T09:00:00Z",
        encounter_type: "AMB",
        source_system: "epic",
      },
    ]); // fingerprint hit
    // Hand the conflict-mapping lookup 7 rows. The mock ignores
    // .limit(CAP_CONFLICTING_MAPPINGS) and returns the full array,
    // simulating a future schema change or accidentally-dropped LIMIT.
    db.willSelect(
      existingEpicIds.map((rid) => ({
        id: `epic:Encounter:${rid}`,
        resource_type: "Encounter",
        resource_id: rid,
        internal_record_id: existingInternalId,
      })),
    );
    db.willInsert(); // new encounters row
    db.willInsert(); // new mapping
    db.willInsert(); // audit_log dedup_conflict

    await persistEncounter(RESOURCE, PATIENT_ID);

    const audit = findAuditInsert("epic_sync_dedup_conflict");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);

    // Cap is a code-level invariant — 5 entries, in arrival order.
    expect(Array.isArray(details.existing_epic_fhir_ids)).toBe(true);
    expect(details.existing_epic_fhir_ids).toHaveLength(5);
    expect(details.existing_epic_fhir_ids).toEqual(
      existingEpicIds.slice(0, 5),
    );

    // Back-compat scalar still points at the first entry.
    expect(details.existing_epic_fhir_id).toBe(existingEpicIds[0]);
  });
});

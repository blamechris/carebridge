/**
 * Multi-conflict audit surfacing on the fingerprint-merge dedup_conflict
 * path (#1219).
 *
 * Background: #1201 introduced the `epic_sync_dedup_conflict` audit row
 * for the case where a fingerprint hit lands on an internal row already
 * mapped to a DIFFERENT Epic FHIR id. The original implementation used
 * `LIMIT 1` and surfaced a single `existing_epic_fhir_id` in the audit
 * details — sufficient for detection, but loses information when more
 * than one Epic id maps to the same internal id (today impossible via
 * the `(resource_type, resource_id)` unique key on `fhir_resources`, but
 * possible after manual DB intervention or any future schema change
 * that loosens the constraint).
 *
 * This suite pins the new behaviour:
 *  - Single-conflict (existing case, exactly one row): the audit
 *    details carry `existing_epic_fhir_ids` as a 1-element array AND
 *    the back-compat `existing_epic_fhir_id` is the same string.
 *  - Multi-conflict (synthetic 2-3 rows): `existing_epic_fhir_ids` is
 *    the full array (capped at 5), and `existing_epic_fhir_id` is the
 *    first entry.
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

describe("dedup_conflict audit surfaces multiple existing Epic ids (#1219)", () => {
  it("single conflicting mapping → existing_epic_fhir_ids is a 1-element array AND existing_epic_fhir_id matches it (back-compat)", async () => {
    const existingInternalId = "internal-enc-single";
    const existingEpicId = "epic-enc-A";

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
    db.willSelect([
      {
        id: `epic:Encounter:${existingEpicId}`,
        resource_type: "Encounter",
        resource_id: existingEpicId,
        internal_record_id: existingInternalId,
      },
    ]); // conflict-mapping lookup → 1 row
    db.willInsert(); // new encounters row
    db.willInsert(); // new mapping
    db.willInsert(); // audit_log dedup_conflict

    await persistEncounter(RESOURCE, PATIENT_ID);

    const audit = findAuditInsert("epic_sync_dedup_conflict");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);

    // New array shape carries all conflicting Epic ids.
    expect(Array.isArray(details.existing_epic_fhir_ids)).toBe(true);
    expect(details.existing_epic_fhir_ids).toEqual([existingEpicId]);

    // Back-compat scalar is the first entry of the array.
    expect(details.existing_epic_fhir_id).toBe(existingEpicId);
    expect(details.existing_epic_fhir_id).toBe(
      details.existing_epic_fhir_ids[0],
    );

    // Other invariants from #1201 still hold.
    expect(details.new_epic_fhir_id).toBe("epic-enc-NEW");
    expect(details.matched_internal_id).toBe(existingInternalId);
  });

  it("multiple conflicting mappings (3 rows) → existing_epic_fhir_ids carries every id; existing_epic_fhir_id is the first", async () => {
    const existingInternalId = "internal-enc-multi";
    const existingEpicIds = ["epic-enc-A", "epic-enc-B", "epic-enc-C"];

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
    // Synthetic 3-row conflict — drop the unique-key invariant for the
    // test by simulating a post-intervention state where multiple Epic
    // ids already map to the same internal id.
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

    expect(Array.isArray(details.existing_epic_fhir_ids)).toBe(true);
    expect(details.existing_epic_fhir_ids).toEqual(existingEpicIds);

    // Back-compat scalar stays populated with the first entry — old
    // consumers that read only `existing_epic_fhir_id` still see a
    // valid Epic id rather than null.
    expect(details.existing_epic_fhir_id).toBe(existingEpicIds[0]);
  });
});

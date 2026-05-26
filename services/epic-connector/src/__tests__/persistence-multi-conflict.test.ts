/**
 * Multi-conflict audit surfacing on the fingerprint-merge dedup_conflict
 * path (#1219, #1233).
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
 * #1219 introduced the `existing_epic_fhir_ids: string[]` array shape on
 * the audit details (back-compat: `existing_epic_fhir_id` mirrors the
 * first entry). #1233 parametrizes the shape assertion across every
 * persist function so each callsite of `logDedupConflict` independently
 * locks the array shape in.
 *
 * Coverage:
 *  - Single-conflict (existing case, exactly one row, Encounter): the
 *    audit details carry `existing_epic_fhir_ids` as a 1-element array
 *    AND the back-compat `existing_epic_fhir_id` is the same string.
 *  - Multi-conflict (synthetic 3 rows) for ALL 6 persisters:
 *    persistPatient, persistMedicationRequest (covers persistMedicationRow
 *    + persistMedicationStatement), persistObservation (vital path),
 *    persistCondition, persistAllergy, persistEncounter — each asserts
 *    `existing_epic_fhir_ids.length === 3` AND `existing_epic_fhir_id
 *    === existing_epic_fhir_ids[0]`.
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

const {
  persistPatient,
  persistMedicationRequest,
  persistObservation,
  persistCondition,
  persistAllergy,
  persistEncounter,
} = await import("../sync/persistence.js");

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

// ── Encounter single-conflict back-compat (kept verbatim from the
// original suite — pins the 1-element array case that hits the same
// callsite as the multi-row Encounter case below) ────────────────────

const ENCOUNTER_RESOURCE = {
  resourceType: "Encounter",
  id: "epic-enc-NEW",
  status: "finished",
  class: { code: "AMB" },
  subject: { reference: "Patient/p-1" },
  period: { start: "2026-05-20T09:00:00Z", end: "2026-05-20T09:45:00Z" },
};

describe("dedup_conflict audit shape — single-conflict back-compat (#1219)", () => {
  it("Encounter: single conflicting mapping → existing_epic_fhir_ids is a 1-element array AND existing_epic_fhir_id matches it", async () => {
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

    await persistEncounter(ENCOUNTER_RESOURCE, PATIENT_ID);

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
});

// ── Parametrized multi-conflict (#1233) ───────────────────────────────
//
// Every persist function calls `logDedupConflict` independently on its
// own fingerprint-merge fall-through. Run the same 3-row conflict shape
// assertion against each one so per-callsite drift (someone passing the
// truncated array, or a scalar, or forgetting to wire the call) trips
// here rather than in production audit consumers.
//
// Each case sets up:
//   1. findMapping miss (Epic-id lookup for the inbound FHIR id)
//   2. Fingerprint hit on an Epic-owned internal row
//   3. 3 pre-existing fhir_resources mappings on that internal row, each
//      with a different `resource_id` (synthetic — drops the
//      (resource_type, resource_id) unique-key invariant for the test)
//   4. New internal row insert + new mapping + audit row inserts
//
// Then invokes the persist function with a 4th distinct Epic FHIR id
// and asserts the audit shape.

type MultiConflictCase = {
  name: string;
  expectedResourceType: string;
  expectedNewEpicId: string;
  setupFingerprintHit: () => void;
  invoke: () => Promise<unknown>;
  /** Extra select stubs (e.g. lab panel lookups) the persister issues
   *  AFTER the conflict lookup but BEFORE the inserts. Empty for most
   *  resources; non-empty if needed in the future. */
  extraSelects?: () => void;
};

const CONFLICT_EPIC_IDS = ["epic-X-A", "epic-X-B", "epic-X-C"];

function stubConflictMappings(resourceType: string, internalId: string) {
  db.willSelect(
    CONFLICT_EPIC_IDS.map((rid) => ({
      id: `epic:${resourceType}:${rid}`,
      resource_type: resourceType,
      resource_id: rid,
      internal_record_id: internalId,
    })),
  );
}

const CASES: MultiConflictCase[] = [
  {
    name: "persistPatient",
    expectedResourceType: "Patient",
    expectedNewEpicId: "epic-pat-NEW",
    setupFingerprintHit: () => {
      const internalId = "internal-pat-multi";
      db.willSelect([]); // findMapping miss
      // MRN-HMAC fingerprint hit on internal-pat-multi.
      db.willSelect([
        {
          id: internalId,
          mrn_hmac: "hmac:MRN-99999",
        },
      ]);
      stubConflictMappings("Patient", internalId);
      db.willInsert(); // new patients row
      db.willInsert(); // new mapping
      db.willInsert(); // audit_log dedup_conflict
    },
    invoke: () =>
      persistPatient({
        resourceType: "Patient",
        id: "epic-pat-NEW",
        active: true,
        name: [{ family: "Doe", given: ["Jane"] }],
        gender: "female",
        birthDate: "1980-04-12",
        identifier: [
          {
            type: { coding: [{ code: "MR" }] },
            value: "MRN-99999",
          },
        ],
      }),
  },
  {
    name: "persistMedicationRequest (persistMedicationRow)",
    expectedResourceType: "MedicationRequest",
    expectedNewEpicId: "epic-med-NEW",
    setupFingerprintHit: () => {
      const internalId = "internal-med-multi";
      db.willSelect([]); // findMapping miss
      db.willSelect([
        {
          id: internalId,
          patient_id: PATIENT_ID,
          rxnorm_code: "314076",
          started_at: "2026-05-01T10:00:00Z",
          source_system: "epic",
        },
      ]); // rxnorm_code + started_at fingerprint hit
      stubConflictMappings("MedicationRequest", internalId);
      db.willInsert(); // new medications row
      db.willInsert(); // new mapping
      db.willInsert(); // audit_log
    },
    invoke: () =>
      persistMedicationRequest(
        {
          resourceType: "MedicationRequest",
          id: "epic-med-NEW",
          status: "active",
          intent: "order",
          subject: { reference: "Patient/p-1" },
          medicationCodeableConcept: {
            text: "Lisinopril 10 mg",
            coding: [
              {
                system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                code: "314076",
              },
            ],
          },
          authoredOn: "2026-05-01T10:00:00Z",
        },
        PATIENT_ID,
      ),
  },
  {
    name: "persistObservation (vital)",
    expectedResourceType: "Observation",
    expectedNewEpicId: "epic-obs-NEW",
    setupFingerprintHit: () => {
      const internalId = "internal-vital-multi";
      db.willSelect([]); // findMapping miss
      db.willSelect([
        {
          id: internalId,
          patient_id: PATIENT_ID,
          loinc_code: "8867-4",
          recorded_at: "2026-05-20T08:00:00Z",
          source_system: "epic",
        },
      ]); // loinc_code + recorded_at fingerprint hit
      stubConflictMappings("Observation", internalId);
      db.willInsert(); // new vitals row
      db.willInsert(); // new mapping
      db.willInsert(); // audit_log
    },
    invoke: () =>
      persistObservation(
        {
          resourceType: "Observation",
          id: "epic-obs-NEW",
          status: "final",
          category: [
            {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/observation-category",
                  code: "vital-signs",
                },
              ],
            },
          ],
          code: {
            coding: [
              {
                system: "http://loinc.org",
                code: "8867-4",
                display: "Heart rate",
              },
            ],
          },
          subject: { reference: "Patient/p-1" },
          effectiveDateTime: "2026-05-20T08:00:00Z",
          valueQuantity: { value: 72, unit: "/min" },
        },
        PATIENT_ID,
      ),
  },
  {
    name: "persistCondition",
    expectedResourceType: "Condition",
    expectedNewEpicId: "epic-cond-NEW",
    setupFingerprintHit: () => {
      const internalId = "internal-diag-multi";
      db.willSelect([]); // findMapping miss
      db.willSelect([
        {
          id: internalId,
          patient_id: PATIENT_ID,
          icd10_code: "I26.99",
          onset_date: "2026-04-15",
          source_system: "epic",
        },
      ]); // icd10_code fingerprint hit
      stubConflictMappings("Condition", internalId);
      db.willInsert(); // new diagnoses row
      db.willInsert(); // new mapping
      db.willInsert(); // audit_log
    },
    invoke: () =>
      persistCondition(
        {
          resourceType: "Condition",
          id: "epic-cond-NEW",
          subject: { reference: "Patient/p-1" },
          code: {
            text: "Pulmonary embolism",
            coding: [
              {
                system: "http://hl7.org/fhir/sid/icd-10-cm",
                code: "I26.99",
              },
            ],
          },
          onsetDateTime: "2026-04-15",
          clinicalStatus: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/condition-clinical",
                code: "active",
              },
            ],
          },
        },
        PATIENT_ID,
      ),
  },
  {
    name: "persistAllergy",
    expectedResourceType: "AllergyIntolerance",
    expectedNewEpicId: "epic-aller-NEW",
    setupFingerprintHit: () => {
      const internalId = "internal-aller-multi";
      db.willSelect([]); // findMapping miss
      db.willSelect([
        {
          id: internalId,
          patient_id: PATIENT_ID,
          rxnorm_code: "7980",
          source_system: "epic",
          allergen: "Penicillin",
          severity: null,
          reaction: null,
        },
      ]); // rxnorm_code fingerprint hit
      stubConflictMappings("AllergyIntolerance", internalId);
      db.willInsert(); // new allergies row
      db.willInsert(); // new mapping
      db.willInsert(); // audit_log
    },
    invoke: () =>
      persistAllergy(
        {
          resourceType: "AllergyIntolerance",
          id: "epic-aller-NEW",
          patient: { reference: "Patient/p-1" },
          code: {
            text: "Penicillin",
            coding: [
              {
                system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                code: "7980",
                display: "Penicillin G",
              },
            ],
          },
          clinicalStatus: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
                code: "active",
              },
            ],
          },
        },
        PATIENT_ID,
      ),
  },
  {
    name: "persistEncounter",
    expectedResourceType: "Encounter",
    expectedNewEpicId: "epic-enc-NEW",
    setupFingerprintHit: () => {
      const internalId = "internal-enc-multi";
      db.willSelect([]); // findMapping miss
      db.willSelect([
        {
          id: internalId,
          patient_id: PATIENT_ID,
          start_time: "2026-05-20T09:00:00Z",
          encounter_type: "AMB",
          source_system: "epic",
        },
      ]); // start_time + encounter_type fingerprint hit
      stubConflictMappings("Encounter", internalId);
      db.willInsert(); // new encounters row
      db.willInsert(); // new mapping
      db.willInsert(); // audit_log
    },
    invoke: () => persistEncounter(ENCOUNTER_RESOURCE, PATIENT_ID),
  },
];

describe.each(CASES)(
  "dedup_conflict audit shape — multi-conflict (3 rows) per persister (#1233)",
  ({ name, expectedResourceType, expectedNewEpicId, setupFingerprintHit, invoke }) => {
    it(`${name}: 3-row conflict → existing_epic_fhir_ids carries every id; existing_epic_fhir_id === existing_epic_fhir_ids[0]`, async () => {
      setupFingerprintHit();

      await invoke();

      const audit = findAuditInsert("epic_sync_dedup_conflict");
      expect(audit).toBeDefined();
      expect(audit?.resource_type).toBe(expectedResourceType);

      const details = JSON.parse(audit?.details as string);

      // Array shape carries every conflicting Epic id, length 3.
      expect(Array.isArray(details.existing_epic_fhir_ids)).toBe(true);
      expect(details.existing_epic_fhir_ids).toHaveLength(3);
      expect(details.existing_epic_fhir_ids).toEqual(CONFLICT_EPIC_IDS);

      // Back-compat scalar mirrors the first entry — old consumers wired
      // against `existing_epic_fhir_id` still see a valid Epic id.
      expect(details.existing_epic_fhir_id).toBe(
        details.existing_epic_fhir_ids[0],
      );
      expect(details.existing_epic_fhir_id).toBe(CONFLICT_EPIC_IDS[0]);

      // Inbound Epic id and resource type are preserved verbatim.
      expect(details.new_epic_fhir_id).toBe(expectedNewEpicId);
    });
  },
);
// ── existing_epic_fhir_id_count audit field (#1232) ───────────────────
//
// #1232 adds a derived `existing_epic_fhir_id_count` field to the
// dedup_conflict audit details: it's `existingEpicFhirIds.length` and
// gives audit consumers a cheap numeric signal without re-counting the
// array client-side. These two cases lock in the single-row (count===1)
// and multi-row (count===3) shapes against the Encounter persister.

describe("dedup_conflict audit surfaces existing_epic_fhir_id_count (#1232)", () => {
  it("single conflicting mapping → existing_epic_fhir_id_count === 1", async () => {
    const existingInternalId = "internal-enc-count-single";
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

    await persistEncounter(ENCOUNTER_RESOURCE, PATIENT_ID);

    const audit = findAuditInsert("epic_sync_dedup_conflict");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);

    expect(details.existing_epic_fhir_id_count).toBe(1);
    expect(details.existing_epic_fhir_id_count).toBe(
      details.existing_epic_fhir_ids.length,
    );
  });

  it("multiple conflicting mappings (3 rows) → existing_epic_fhir_id_count === 3", async () => {
    const existingInternalId = "internal-enc-count-multi";
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

    await persistEncounter(ENCOUNTER_RESOURCE, PATIENT_ID);

    const audit = findAuditInsert("epic_sync_dedup_conflict");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);

    expect(details.existing_epic_fhir_id_count).toBe(3);
    expect(details.existing_epic_fhir_id_count).toBe(
      details.existing_epic_fhir_ids.length,
    );
  });
});

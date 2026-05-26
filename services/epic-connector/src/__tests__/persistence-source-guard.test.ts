/**
 * Source-system guard on the fingerprint-merge path (#1200).
 *
 * #1197 added cross-source fingerprint dedup that UPDATEs the matched
 * row with the Epic payload regardless of who originally created it.
 * The Epic-id mapping path has guarded against this since #1183 ("Epic
 * does not get to overwrite CareBridge-originated data"). This test
 * suite pins the equivalent guard for the fingerprint path:
 *
 *  - When findByFingerprint hits a row whose source_system != 'epic'
 *    (or null on a table that has the column — treated as non-epic):
 *      • SKIP the UPDATE of clinical fields
 *      • Still write the fhir_resources mapping (Epic id round-trips
 *        to the same internal row)
 *      • Write an audit_log row with action='epic_sync_source_conflict'
 *        carrying the matched row id, the Epic FHIR id, and the
 *        source_system value of the matched row.
 *  - When the matched row has source_system='epic' (or table lacks the
 *    column and we treat absence as 'epic-equivalent' per resource —
 *    medications/vitals where the column was added long ago and pre-
 *    column rows are effectively internal — we still treat null as
 *    non-epic to be safe): existing dedup-match behaviour preserved.
 *
 * Uses the shared createMockDb harness — same pattern as the cycle-5
 * tests in persistence.test.ts.
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

// ── helpers ─────────────────────────────────────────────────────

function findAuditInsert(
  action: string,
): Record<string, unknown> | undefined {
  const hit = db.insert.calls.find((c) => {
    const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
    return v?.action === action;
  });
  return hit?.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
}

function findMappingInsert(): Record<string, unknown> | undefined {
  const hit = db.insert.calls.find((c) => {
    const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
    return v?.resource_type !== undefined && v?.resource_id !== undefined;
  });
  return hit?.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
}

// ── Encounter ───────────────────────────────────────────────────

describe("persistEncounter — source_system guard on fingerprint path (#1200)", () => {
  const RESOURCE = {
    resourceType: "Encounter",
    id: "epic-enc-1",
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p-1" },
    period: { start: "2026-05-20T09:00:00Z", end: "2026-05-20T11:00:00Z" },
    location: [{ location: { display: "ICU" } }],
    reasonCode: [{ text: "unstable" }],
  };

  it("matched fingerprint row with source_system='internal' → skip UPDATE, write mapping, audit epic_sync_source_conflict", async () => {
    const existingInternalId = "internal-enc-1";
    db.willSelect([]); // findMapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        start_time: "2026-05-20T09:00:00Z",
        encounter_type: "AMB",
        source_system: "internal",
        location: "ER Bay 4",
        reason: "chest pain",
      },
    ]);
    // No willUpdate() — the guard MUST short-circuit before db.update is called.
    db.willInsert(); // mapping upsert
    db.willInsert(); // audit_log epic_sync_source_conflict

    const result = await persistEncounter(RESOURCE, PATIENT_ID);

    expect(result.internalId).toBe(existingInternalId);
    expect(result.kind).toBe("encounter");
    expect(result.inserted).toBe(false);
    expect(result.conflict).toBe("source_system_conflict");

    // UPDATE must NOT have been called — clinician's data is protected.
    expect(db.update).not.toHaveBeenCalled();

    // Mapping row IS written so the Epic FHIR id still round-trips to
    // the same internal row on the next sync.
    const mapping = findMappingInsert();
    expect(mapping).toBeDefined();
    expect(mapping?.resource_type).toBe("Encounter");
    expect(mapping?.resource_id).toBe("epic-enc-1");
    expect(mapping?.internal_record_id).toBe(existingInternalId);

    // Audit row uses the NEW action — distinct from epic_sync_dedup_match.
    const audit = findAuditInsert("epic_sync_source_conflict");
    expect(audit).toBeDefined();
    expect(audit?.resource_type).toBe("Encounter");
    expect(audit?.resource_id).toBe(existingInternalId);
    const details = JSON.parse(audit?.details as string);
    expect(details.epic_fhir_id).toBe("epic-enc-1");
    expect(details.existing_source).toBe("internal");
    expect(details.resolution).toBe("keep_carebridge_value");

    // No epic_sync_dedup_match row — this is a conflict, not a merge.
    expect(findAuditInsert("epic_sync_dedup_match")).toBeUndefined();
  });

  it("matched fingerprint row with source_system='epic' → UPDATE + epic_sync_dedup_match (negative)", async () => {
    const existingInternalId = "internal-enc-epic";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        start_time: "2026-05-20T09:00:00Z",
        encounter_type: "AMB",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert(); // mapping
    db.willInsert(); // audit_log epic_sync_dedup_match

    const result = await persistEncounter(RESOURCE, PATIENT_ID);

    expect(result.internalId).toBe(existingInternalId);
    expect(result.conflict).toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();
    expect(findAuditInsert("epic_sync_dedup_match")).toBeDefined();
    expect(findAuditInsert("epic_sync_source_conflict")).toBeUndefined();
  });

  it("matched fingerprint row with source_system=null → treated as non-epic, skip UPDATE", async () => {
    // Defensive: even though encounters.source_system is NOT NULL with
    // default 'internal' today, pre-#1190 rows that bypassed the default
    // (or any future schema regression) should still be protected.
    const existingInternalId = "internal-enc-null";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        start_time: "2026-05-20T09:00:00Z",
        encounter_type: "AMB",
        source_system: null,
      },
    ]);
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistEncounter(RESOURCE, PATIENT_ID);
    expect(result.conflict).toBe("source_system_conflict");
    expect(db.update).not.toHaveBeenCalled();
    expect(findAuditInsert("epic_sync_source_conflict")).toBeDefined();
  });
});

// ── Condition / Diagnosis ──────────────────────────────────────

describe("persistCondition — source_system guard on fingerprint path (#1200)", () => {
  const RESOURCE = {
    resourceType: "Condition",
    id: "epic-cond-1",
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
  };

  it("CareBridge-originated diagnosis (source_system='internal') is preserved", async () => {
    const existingInternalId = "internal-diag-1";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        icd10_code: "I26.99",
        onset_date: "2026-04-15",
        source_system: "internal",
      },
    ]);
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistCondition(RESOURCE, PATIENT_ID);
    expect(result.conflict).toBe("source_system_conflict");
    expect(result.kind).toBe("diagnosis");
    expect(db.update).not.toHaveBeenCalled();

    const audit = findAuditInsert("epic_sync_source_conflict");
    expect(audit).toBeDefined();
    expect(audit?.resource_type).toBe("Condition");
    const details = JSON.parse(audit?.details as string);
    expect(details.existing_source).toBe("internal");

    const mapping = findMappingInsert();
    expect(mapping?.internal_record_id).toBe(existingInternalId);
  });

  it("Epic-originated diagnosis still gets merged + epic_sync_dedup_match", async () => {
    db.willSelect([]);
    db.willSelect([
      {
        id: "diag-epic-1",
        patient_id: PATIENT_ID,
        icd10_code: "I26.99",
        onset_date: "2026-04-15",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert();
    db.willInsert();

    const result = await persistCondition(RESOURCE, PATIENT_ID);
    expect(result.conflict).toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();
    expect(findAuditInsert("epic_sync_dedup_match")).toBeDefined();
  });
});

// ── Allergy ────────────────────────────────────────────────────

describe("persistAllergy — source_system guard on fingerprint path (#1200)", () => {
  const RESOURCE = {
    resourceType: "AllergyIntolerance",
    id: "epic-aller-1",
    patient: { reference: "Patient/p-1" },
    code: {
      text: "Penicillin",
      coding: [
        {
          system: "http://snomed.info/sct",
          code: "373270004",
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
  };

  it("CareBridge-originated allergy is preserved", async () => {
    const existingInternalId = "internal-aller-1";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        snomed_code: "373270004",
        source_system: "internal",
      },
    ]);
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistAllergy(RESOURCE, PATIENT_ID);
    expect(result.conflict).toBe("source_system_conflict");
    expect(db.update).not.toHaveBeenCalled();
    expect(findAuditInsert("epic_sync_source_conflict")).toBeDefined();
    const mapping = findMappingInsert();
    expect(mapping?.internal_record_id).toBe(existingInternalId);
  });

  it("Epic-originated allergy follows the existing dedup-match path", async () => {
    db.willSelect([]);
    db.willSelect([
      {
        id: "aller-epic-1",
        patient_id: PATIENT_ID,
        snomed_code: "373270004",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert();
    db.willInsert();

    const result = await persistAllergy(RESOURCE, PATIENT_ID);
    expect(result.conflict).toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();
    expect(findAuditInsert("epic_sync_dedup_match")).toBeDefined();
  });
});

// ── MedicationRequest ──────────────────────────────────────────

describe("persistMedicationRequest — source_system guard on fingerprint path (#1200)", () => {
  const RESOURCE = {
    resourceType: "MedicationRequest",
    id: "epic-med-1",
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
  };

  it("CareBridge-originated medication is preserved", async () => {
    const existingInternalId = "internal-med-1";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        rxnorm_code: "314076",
        started_at: "2026-05-01T10:00:00Z",
        source_system: "internal",
      },
    ]);
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistMedicationRequest(RESOURCE, PATIENT_ID);
    expect(result.conflict).toBe("source_system_conflict");
    expect(result.kind).toBe("medication");
    expect(db.update).not.toHaveBeenCalled();
    expect(findAuditInsert("epic_sync_source_conflict")).toBeDefined();
  });

  it("Epic-originated medication still merges + epic_sync_dedup_match", async () => {
    db.willSelect([]);
    db.willSelect([
      {
        id: "med-epic-1",
        patient_id: PATIENT_ID,
        rxnorm_code: "314076",
        started_at: "2026-05-01T10:00:00Z",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert();
    db.willInsert();

    const result = await persistMedicationRequest(RESOURCE, PATIENT_ID);
    expect(result.conflict).toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();
    expect(findAuditInsert("epic_sync_dedup_match")).toBeDefined();
  });
});

// ── Vitals (Observation) ───────────────────────────────────────

describe("persistObservation (vital) — source_system guard on fingerprint path (#1200)", () => {
  const RESOURCE = {
    resourceType: "Observation",
    id: "epic-obs-1",
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
  };

  it("CareBridge-originated vital is preserved", async () => {
    const existingInternalId = "internal-vital-1";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        loinc_code: "8867-4",
        recorded_at: "2026-05-20T08:00:00Z",
        source_system: "internal",
      },
    ]);
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistObservation(RESOURCE, PATIENT_ID);
    expect(result.conflict).toBe("source_system_conflict");
    expect(result.kind).toBe("vital");
    expect(db.update).not.toHaveBeenCalled();
    expect(findAuditInsert("epic_sync_source_conflict")).toBeDefined();
  });

  it("Epic-originated vital still merges + epic_sync_dedup_match", async () => {
    db.willSelect([]);
    db.willSelect([
      {
        id: "vital-epic-1",
        patient_id: PATIENT_ID,
        loinc_code: "8867-4",
        recorded_at: "2026-05-20T08:00:00Z",
        source_system: "epic",
      },
    ]);
    db.willUpdate();
    db.willInsert();
    db.willInsert();

    const result = await persistObservation(RESOURCE, PATIENT_ID);
    expect(result.conflict).toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();
    expect(findAuditInsert("epic_sync_dedup_match")).toBeDefined();
  });
});

// ── Clinical-safety scenario from issue #1200 ─────────────────

describe("Clinical-safety scenario — clinician edits survive Epic sync (#1200)", () => {
  it("Pre-existing CareBridge encounter location='ER Bay 4', reason='chest pain' → Epic sync with location='ICU', reason='unstable' → row unchanged + audit row", async () => {
    // Pre-existing CareBridge-originated encounter.
    const carebridgeEncounter = {
      id: "internal-enc-cs",
      patient_id: PATIENT_ID,
      start_time: "2026-05-25T08:00:00Z",
      encounter_type: "AMB",
      status: "in-progress",
      end_time: null,
      location: "ER Bay 4",
      reason: "chest pain",
      source_system: "internal",
      created_at: "2026-05-25T08:00:00Z",
    };

    db.willSelect([]); // findMapping miss
    db.willSelect([carebridgeEncounter]); // fingerprint hit
    db.willInsert(); // fhir_resources mapping
    db.willInsert(); // audit_log

    const epicPayload = {
      resourceType: "Encounter",
      id: "epic-enc-cs",
      status: "in-progress",
      class: { code: "AMB" },
      subject: { reference: "Patient/p-cs" },
      period: { start: "2026-05-25T08:00:00Z" },
      location: [{ location: { display: "ICU" } }],
      reasonCode: [{ text: "unstable" }],
    };

    const result = await persistEncounter(epicPayload, PATIENT_ID);

    expect(result.internalId).toBe(carebridgeEncounter.id);
    expect(result.conflict).toBe("source_system_conflict");
    // CRITICAL: db.update was NEVER called → location stays 'ER Bay 4',
    // reason stays 'chest pain'. The clinician's work is intact.
    expect(db.update).not.toHaveBeenCalled();
    // Mapping written so the next Epic sync of the same FHIR id finds
    // this same internal row (and still hits the source-system guard).
    expect(findMappingInsert()?.internal_record_id).toBe(carebridgeEncounter.id);
    // Audit row carries enough provenance for manual review.
    const audit = findAuditInsert("epic_sync_source_conflict");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);
    expect(details.epic_fhir_id).toBe("epic-enc-cs");
    expect(details.existing_source).toBe("internal");
  });
});

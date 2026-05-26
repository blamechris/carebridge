/**
 * Epic-id conflict detection on the fingerprint-merge path (#1201).
 *
 * Background: #1191 introduced fingerprint dedup so that a CareBridge-
 * originated row created before Epic sync was wired doesn't get
 * duplicated when Epic later syncs the same logical entity. #1200
 * tightened that path so the dedup-merge UPDATE is skipped when the
 * matched row is CareBridge-originated.
 *
 * But there's a *separate* failure mode: the fingerprint match lands on
 * an internal row that ALREADY has an Epic FHIR id mapping pointing at
 * it — and the inbound Epic FHIR id is *different*. That means either
 * Epic has re-issued an ID for the same logical entity, or two
 * genuinely distinct Epic entities collide on our fingerprint key. The
 * old dedup-merge path silently wrote a SECOND `fhir_resources` row
 * pointing at the same internal id, so two Epic FHIR ids both
 * round-tripped to one CareBridge record with no signal to a reviewer.
 *
 * This suite pins the new behaviour: when the matched internal row
 * already has a conflicting Epic mapping, the writer skips the merge,
 * falls through to a plain INSERT (a new internal row + a new mapping
 * for the inbound Epic id), and writes ONE audit row with
 * action='epic_sync_dedup_conflict' carrying both Epic ids.
 *
 * Pipeline order, per the issue:
 *   1. fingerprint lookup → hit?
 *   2. (NEW) conflict check on fhir_resources → if conflict, fall
 *      through to plain INSERT + audit `epic_sync_dedup_conflict`.
 *   3. source_system guard (#1200).
 *   4. dedup-merge.
 *
 * The conflict check is FIRST after the fingerprint hit because it's
 * about identity ambiguity, not data ownership — once two Epic ids both
 * point at one row we've lost the ability to safely round-trip either.
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
  persistCondition,
  persistEncounter,
  persistPatient,
  persistAllergy,
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

function findAllAuditInserts(
  action: string,
): Array<Record<string, unknown>> {
  return db.insert.calls
    .map((c) => c.chainArgs[0]?.[0] as Record<string, unknown> | undefined)
    .filter(
      (v): v is Record<string, unknown> => v !== undefined && v.action === action,
    );
}

function findAllMappingInserts(): Array<Record<string, unknown>> {
  return db.insert.calls
    .map((c) => c.chainArgs[0]?.[0] as Record<string, unknown> | undefined)
    .filter(
      (v): v is Record<string, unknown> =>
        v !== undefined &&
        v.resource_type !== undefined &&
        v.resource_id !== undefined &&
        // discriminate audit_log (also has resource_type) by presence of
        // `internal_record_id` / `imported_at`.
        (v.internal_record_id !== undefined || v.imported_at !== undefined),
    );
}

// ── Encounter ───────────────────────────────────────────────────

describe("persistEncounter — Epic-id conflict on fingerprint match (#1201)", () => {
  const RESOURCE = {
    resourceType: "Encounter",
    id: "epic-enc-B", // inbound Epic id
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p-1" },
    period: { start: "2026-05-20T09:00:00Z", end: "2026-05-20T09:45:00Z" },
  };

  it("fingerprint hit on internal row already mapped to a DIFFERENT Epic id → fall through to INSERT + epic_sync_dedup_conflict audit", async () => {
    const existingInternalId = "internal-enc-X";
    const existingEpicId = "epic-enc-A";

    // findMapping (Epic-id lookup for epic-enc-B) → miss
    db.willSelect([]);
    // fingerprint lookup → hits internal-enc-X (Epic-owned, would otherwise merge)
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        start_time: "2026-05-20T09:00:00Z",
        encounter_type: "AMB",
        source_system: "epic",
      },
    ]);
    // NEW conflict-mapping lookup → returns a row mapping epic-enc-A to internal-enc-X
    db.willSelect([
      {
        id: `epic:Encounter:${existingEpicId}`,
        resource_type: "Encounter",
        resource_id: existingEpicId,
        internal_record_id: existingInternalId,
        source_system: "epic",
      },
    ]);
    db.willInsert(); // new encounters row (INSERT, not UPDATE)
    db.willInsert(); // new fhir_resources mapping for epic-enc-B
    db.willInsert(); // audit_log epic_sync_dedup_conflict

    const result = await persistEncounter(RESOURCE, PATIENT_ID);

    // A NEW internal row was inserted — result.inserted must be true and
    // the returned internalId must NOT be the existing one.
    expect(result.kind).toBe("encounter");
    expect(result.inserted).toBe(true);
    expect(result.internalId).not.toBe(existingInternalId);
    // #1217: caller-visible discriminator mirrors source_system_conflict
    // so the sync orchestrator can distinguish a forked-insert (fingerprint
    // collided on a different Epic id) from a clean import without
    // re-reading the audit_log row.
    expect(result.conflict).toBe("epic_id_conflict");

    // UPDATE must NOT have happened — the existing row is left alone.
    expect(db.update).not.toHaveBeenCalled();

    // A new fhir_resources mapping was written pointing at the NEW
    // internal id (not the existing one). We do not silently write a
    // second mapping pointing at the same internal row.
    const mappings = findAllMappingInserts();
    const inboundMapping = mappings.find(
      (m) => m.resource_id === "epic-enc-B",
    );
    expect(inboundMapping).toBeDefined();
    expect(inboundMapping?.internal_record_id).toBe(result.internalId);
    expect(inboundMapping?.internal_record_id).not.toBe(existingInternalId);

    // No mapping pointing at the existing internal row was inserted in
    // this call (i.e. we did not write a second mapping `epic-enc-B → X`).
    expect(
      mappings.find(
        (m) =>
          m.internal_record_id === existingInternalId &&
          m.resource_id === "epic-enc-B",
      ),
    ).toBeUndefined();

    // Audit row uses the NEW action.
    const audit = findAuditInsert("epic_sync_dedup_conflict");
    expect(audit).toBeDefined();
    expect(audit?.resource_type).toBe("Encounter");
    expect(audit?.success).toBe(false);
    const details = JSON.parse(audit?.details as string);
    // Both Epic ids surface for manual review.
    expect(details.new_epic_fhir_id).toBe("epic-enc-B");
    expect(details.existing_epic_fhir_id).toBe(existingEpicId);
    expect(details.matched_internal_id).toBe(existingInternalId);
    // Fingerprint fields are preserved for forensics.
    expect(details.fingerprint).toBeDefined();

    // No dedup-match row — this is a conflict, not a merge.
    expect(findAuditInsert("epic_sync_dedup_match")).toBeUndefined();
    // No source-conflict row — this is identity ambiguity, not data ownership.
    expect(findAuditInsert("epic_sync_source_conflict")).toBeUndefined();
  });

  it("fingerprint hit + SAME Epic id (mapping already points at the matched row) → existing dedup-match path", async () => {
    // This is the negative case: epic-enc-A already maps to internal-enc-X,
    // and the inbound Epic id is ALSO epic-enc-A (e.g. mapping was lost
    // due to a partial-failure and Epic is re-syncing). The conflict
    // check must NOT trip — the existing mapping's resource_id equals
    // the inbound FHIR id, so no ambiguity. Dedup-merge proceeds.
    const existingInternalId = "internal-enc-same";
    const SAME_RESOURCE = { ...RESOURCE, id: "epic-enc-A" };

    db.willSelect([]); // findMapping miss (defensive — caller knows it)
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        start_time: "2026-05-20T09:00:00Z",
        encounter_type: "AMB",
        source_system: "epic",
      },
    ]);
    // conflict-mapping lookup → empty (mapping with resource_id != A
    // doesn't exist; only a row for A would, and we filter that out).
    db.willSelect([]);
    db.willUpdate();
    db.willInsert(); // mapping upsert
    db.willInsert(); // audit_log epic_sync_dedup_match

    const result = await persistEncounter(SAME_RESOURCE, PATIENT_ID);

    expect(result.internalId).toBe(existingInternalId);
    expect(result.inserted).toBe(false);
    expect(result.conflict).toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();
    expect(findAuditInsert("epic_sync_dedup_match")).toBeDefined();
    expect(findAuditInsert("epic_sync_dedup_conflict")).toBeUndefined();
  });
});

// ── Condition / Diagnosis ──────────────────────────────────────

describe("persistCondition — Epic-id conflict on fingerprint match (#1201)", () => {
  const RESOURCE = {
    resourceType: "Condition",
    id: "epic-cond-B",
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

  it("fingerprint hit on internal row already mapped to a DIFFERENT Epic id → INSERT + dedup_conflict audit", async () => {
    const existingInternalId = "internal-diag-X";
    const existingEpicId = "epic-cond-A";

    db.willSelect([]); // findMapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        icd10_code: "I26.99",
        onset_date: "2026-04-15",
        source_system: "epic",
      },
    ]);
    db.willSelect([
      {
        id: `epic:Condition:${existingEpicId}`,
        resource_type: "Condition",
        resource_id: existingEpicId,
        internal_record_id: existingInternalId,
      },
    ]);
    db.willInsert(); // new diagnoses row
    db.willInsert(); // new mapping
    db.willInsert(); // audit_log

    const result = await persistCondition(RESOURCE, PATIENT_ID);

    expect(result.kind).toBe("diagnosis");
    expect(result.inserted).toBe(true);
    expect(result.internalId).not.toBe(existingInternalId);
    // #1217: discriminator surfaces the forked-insert reason to callers.
    expect(result.conflict).toBe("epic_id_conflict");
    expect(db.update).not.toHaveBeenCalled();

    const audit = findAuditInsert("epic_sync_dedup_conflict");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);
    expect(details.new_epic_fhir_id).toBe("epic-cond-B");
    expect(details.existing_epic_fhir_id).toBe(existingEpicId);
    expect(details.matched_internal_id).toBe(existingInternalId);

    expect(findAuditInsert("epic_sync_dedup_match")).toBeUndefined();
  });
});

// ── MedicationRequest ──────────────────────────────────────────

describe("persistMedicationRequest — Epic-id conflict on fingerprint match (#1201)", () => {
  const RESOURCE = {
    resourceType: "MedicationRequest",
    id: "epic-med-B",
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

  it("fingerprint hit on internal row already mapped to a DIFFERENT Epic id → INSERT + dedup_conflict audit", async () => {
    const existingInternalId = "internal-med-X";
    const existingEpicId = "epic-med-A";

    db.willSelect([]); // findMapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        rxnorm_code: "314076",
        started_at: "2026-05-01T10:00:00Z",
        source_system: "epic",
      },
    ]);
    db.willSelect([
      {
        id: `epic:MedicationRequest:${existingEpicId}`,
        resource_type: "MedicationRequest",
        resource_id: existingEpicId,
        internal_record_id: existingInternalId,
      },
    ]);
    db.willInsert(); // new medications row
    db.willInsert(); // new mapping
    db.willInsert(); // audit_log

    const result = await persistMedicationRequest(RESOURCE, PATIENT_ID);

    expect(result.kind).toBe("medication");
    expect(result.inserted).toBe(true);
    expect(result.internalId).not.toBe(existingInternalId);
    // #1217: discriminator surfaces the forked-insert reason to callers.
    expect(result.conflict).toBe("epic_id_conflict");
    expect(db.update).not.toHaveBeenCalled();

    const audit = findAuditInsert("epic_sync_dedup_conflict");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit?.details as string);
    expect(details.new_epic_fhir_id).toBe("epic-med-B");
    expect(details.existing_epic_fhir_id).toBe(existingEpicId);
    expect(details.matched_internal_id).toBe(existingInternalId);

    // Exactly one audit row — we don't double-log conflict + match.
    expect(findAllAuditInserts("epic_sync_dedup_conflict")).toHaveLength(1);
    expect(findAuditInsert("epic_sync_dedup_match")).toBeUndefined();
  });

  it("fingerprint hit + SAME Epic id → existing dedup-match path", async () => {
    const existingInternalId = "internal-med-same";
    const SAME_RESOURCE = { ...RESOURCE, id: "epic-med-A" };

    db.willSelect([]); // findMapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        rxnorm_code: "314076",
        started_at: "2026-05-01T10:00:00Z",
        source_system: "epic",
      },
    ]);
    // conflict-mapping lookup → empty (any mapping for A would be
    // filtered out by `resource_id != A`).
    db.willSelect([]);
    db.willUpdate();
    db.willInsert(); // mapping
    db.willInsert(); // audit_log dedup_match

    const result = await persistMedicationRequest(SAME_RESOURCE, PATIENT_ID);

    expect(result.internalId).toBe(existingInternalId);
    expect(result.inserted).toBe(false);
    expect(result.conflict).toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();
    expect(findAuditInsert("epic_sync_dedup_match")).toBeDefined();
    expect(findAuditInsert("epic_sync_dedup_conflict")).toBeUndefined();
  });
});

// ── Patient ────────────────────────────────────────────────────
//
// Patient identity is called out in persistPatient as the highest-stakes
// case for this conflict path: two Epic patient FHIR ids landing on the
// same MRN-HMAC typically means an Epic-side merge / unmerge cycle, and
// silently writing a second mapping would conflate two distinct charts.

describe("persistPatient — Epic-id conflict on fingerprint match (#1201)", () => {
  const RESOURCE = {
    resourceType: "Patient",
    id: "epic-pat-B", // inbound Epic id
    active: true,
    name: [{ family: "Smith", given: ["Jane"] }],
    gender: "female",
    birthDate: "1980-04-12",
    identifier: [
      {
        type: { coding: [{ code: "MR" }] },
        value: "MRN-12345",
      },
    ],
  };

  it("fingerprint hit on internal row already mapped to a DIFFERENT Epic id → fall through to INSERT + epic_sync_dedup_conflict audit", async () => {
    const existingInternalId = "internal-pat-X";
    const existingEpicId = "epic-pat-A";

    // findMapping (Epic-id lookup for epic-pat-B) → miss
    db.willSelect([]);
    // MRN-HMAC fingerprint lookup → hits internal-pat-X
    db.willSelect([
      {
        id: existingInternalId,
        mrn_hmac: "hmac:MRN-12345",
      },
    ]);
    // NEW conflict-mapping lookup → returns a row mapping epic-pat-A
    // to internal-pat-X (a different Epic id already owns this MRN).
    db.willSelect([
      {
        id: `epic:Patient:${existingEpicId}`,
        resource_type: "Patient",
        resource_id: existingEpicId,
        internal_record_id: existingInternalId,
      },
    ]);
    db.willInsert(); // new patients row (INSERT, not UPDATE)
    db.willInsert(); // new fhir_resources mapping for epic-pat-B
    db.willInsert(); // audit_log epic_sync_dedup_conflict

    const result = await persistPatient(RESOURCE);

    // A NEW internal row was inserted — Epic merge/unmerge cycles must
    // never silently collapse two charts onto one CareBridge row.
    expect(result.kind).toBe("patient");
    expect(result.inserted).toBe(true);
    expect(result.internalId).not.toBe(existingInternalId);

    // UPDATE must NOT have happened — the existing patient row is left alone.
    expect(db.update).not.toHaveBeenCalled();

    // A new fhir_resources mapping was written pointing at the NEW
    // internal id (not the existing one). No second mapping silently
    // points the inbound Epic id at the pre-existing chart.
    const mappings = findAllMappingInserts();
    const inboundMapping = mappings.find(
      (m) => m.resource_id === "epic-pat-B",
    );
    expect(inboundMapping).toBeDefined();
    expect(inboundMapping?.internal_record_id).toBe(result.internalId);
    expect(inboundMapping?.internal_record_id).not.toBe(existingInternalId);

    expect(
      mappings.find(
        (m) =>
          m.internal_record_id === existingInternalId &&
          m.resource_id === "epic-pat-B",
      ),
    ).toBeUndefined();

    // Audit row carries both Epic ids + the MRN-HMAC fingerprint so a
    // reviewer can reconcile the merge/unmerge against Epic.
    const audit = findAuditInsert("epic_sync_dedup_conflict");
    expect(audit).toBeDefined();
    expect(audit?.resource_type).toBe("Patient");
    expect(audit?.success).toBe(false);
    const details = JSON.parse(audit?.details as string);
    expect(details.new_epic_fhir_id).toBe("epic-pat-B");
    expect(details.existing_epic_fhir_id).toBe(existingEpicId);
    expect(details.matched_internal_id).toBe(existingInternalId);
    // Fingerprint preserved for forensics — MRN HMAC is the only
    // dimension on the patient fingerprint.
    expect(details.fingerprint).toBeDefined();
    expect(details.fingerprint.mrn_hmac).toBe("hmac:MRN-12345");

    // No dedup-match row — this is a conflict, not a merge.
    expect(findAuditInsert("epic_sync_dedup_match")).toBeUndefined();
    // No source-conflict row — this is identity ambiguity, not data ownership.
    expect(findAuditInsert("epic_sync_source_conflict")).toBeUndefined();
  });

  it("fingerprint hit + SAME Epic id (mapping already points at the matched row) → existing dedup-match path", async () => {
    // Negative case: epic-pat-A already maps to internal-pat-same, and
    // the inbound Epic id is ALSO epic-pat-A (e.g. mapping was lost due
    // to a partial-failure and Epic is re-syncing). The conflict check
    // must NOT trip — dedup-merge proceeds.
    const existingInternalId = "internal-pat-same";
    const SAME_RESOURCE = { ...RESOURCE, id: "epic-pat-A" };

    db.willSelect([]); // findMapping miss (defensive)
    db.willSelect([
      {
        id: existingInternalId,
        mrn_hmac: "hmac:MRN-12345",
      },
    ]);
    // conflict-mapping lookup → empty (any mapping for A would be
    // filtered out by `resource_id != A`).
    db.willSelect([]);
    db.willUpdate();
    db.willInsert(); // mapping upsert
    db.willInsert(); // audit_log epic_sync_dedup_match

    const result = await persistPatient(SAME_RESOURCE);

    expect(result.internalId).toBe(existingInternalId);
    expect(result.inserted).toBe(false);
    expect(result.conflict).toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();
    expect(findAuditInsert("epic_sync_dedup_match")).toBeDefined();
    expect(findAuditInsert("epic_sync_dedup_conflict")).toBeUndefined();
  });
});

// ── AllergyIntolerance ─────────────────────────────────────────

describe("persistAllergy — Epic-id conflict on fingerprint match (#1201)", () => {
  const RESOURCE = {
    resourceType: "AllergyIntolerance",
    id: "epic-aller-B", // inbound Epic id
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
  };

  it("fingerprint hit on internal row already mapped to a DIFFERENT Epic id → INSERT + dedup_conflict audit", async () => {
    const existingInternalId = "internal-aller-X";
    const existingEpicId = "epic-aller-A";

    db.willSelect([]); // findMapping miss
    // RxNorm fingerprint lookup → hits internal-aller-X (Epic-owned,
    // would otherwise merge).
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        rxnorm_code: "7980",
        source_system: "epic",
        allergen: "Penicillin",
        severity: null,
        reaction: null,
      },
    ]);
    // NEW conflict-mapping lookup → returns a row mapping epic-aller-A
    // to internal-aller-X.
    db.willSelect([
      {
        id: `epic:AllergyIntolerance:${existingEpicId}`,
        resource_type: "AllergyIntolerance",
        resource_id: existingEpicId,
        internal_record_id: existingInternalId,
      },
    ]);
    db.willInsert(); // new allergies row
    db.willInsert(); // new mapping
    db.willInsert(); // audit_log

    const result = await persistAllergy(RESOURCE, PATIENT_ID);

    expect(result.kind).toBe("allergy");
    expect(result.inserted).toBe(true);
    expect(result.internalId).not.toBe(existingInternalId);
    expect(db.update).not.toHaveBeenCalled();

    const mappings = findAllMappingInserts();
    const inboundMapping = mappings.find(
      (m) => m.resource_id === "epic-aller-B",
    );
    expect(inboundMapping).toBeDefined();
    expect(inboundMapping?.internal_record_id).toBe(result.internalId);
    expect(inboundMapping?.internal_record_id).not.toBe(existingInternalId);

    const audit = findAuditInsert("epic_sync_dedup_conflict");
    expect(audit).toBeDefined();
    expect(audit?.resource_type).toBe("AllergyIntolerance");
    expect(audit?.success).toBe(false);
    const details = JSON.parse(audit?.details as string);
    expect(details.new_epic_fhir_id).toBe("epic-aller-B");
    expect(details.existing_epic_fhir_id).toBe(existingEpicId);
    expect(details.matched_internal_id).toBe(existingInternalId);
    // Allergy fingerprint carries patient_id + the coded substance.
    expect(details.fingerprint).toBeDefined();
    expect(details.fingerprint.patient_id).toBe(PATIENT_ID);
    expect(details.fingerprint.rxnorm_code).toBe("7980");

    // Exactly one audit row — we don't double-log conflict + match.
    expect(findAllAuditInserts("epic_sync_dedup_conflict")).toHaveLength(1);
    expect(findAuditInsert("epic_sync_dedup_match")).toBeUndefined();
    expect(findAuditInsert("epic_sync_source_conflict")).toBeUndefined();
  });

  it("fingerprint hit + SAME Epic id → existing dedup-match path", async () => {
    const existingInternalId = "internal-aller-same";
    const SAME_RESOURCE = { ...RESOURCE, id: "epic-aller-A" };

    db.willSelect([]); // findMapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        rxnorm_code: "7980",
        source_system: "epic",
        allergen: "Penicillin",
        severity: null,
        reaction: null,
      },
    ]);
    // conflict-mapping lookup → empty.
    db.willSelect([]);
    db.willUpdate();
    db.willInsert(); // mapping
    db.willInsert(); // audit_log dedup_match

    const result = await persistAllergy(SAME_RESOURCE, PATIENT_ID);

    expect(result.internalId).toBe(existingInternalId);
    expect(result.inserted).toBe(false);
    expect(result.conflict).toBeUndefined();
    expect(db.update).toHaveBeenCalledOnce();
    expect(findAuditInsert("epic_sync_dedup_match")).toBeDefined();
    expect(findAuditInsert("epic_sync_dedup_conflict")).toBeUndefined();
  });
});

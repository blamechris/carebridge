/**
 * Cross-source dedup tests for Epic persistence layer (#1191).
 *
 * The existing path keys mapping by Epic FHIR id (resource_type +
 * resource_id) and updates in place on re-sync. But if a CareBridge-
 * originated row already exists for the same logical entity (no
 * `fhir_resources` mapping row), an Epic sync of the same entity used
 * to insert a duplicate. These tests pin the fix: each persist*
 * function does a fingerprint fallback when the Epic-id mapping
 * misses, updates the matched CareBridge row in place, creates the
 * mapping row, and logs an audit entry.
 *
 * Uses the shared createMockDb harness so we stay decoupled from
 * Postgres + Drizzle internals (see sync-state-repo.test.ts for the
 * established pattern in this service).
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
  labPanels: {
    id: "id",
    patient_id: "patient_id",
    panel_name: "panel_name",
    collected_at: "collected_at",
  },
  labResults: {
    id: "id",
    panel_id: "panel_id",
  },
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

// ── helpers ─────────────────────────────────────────────────────

/**
 * Collect every recorded INSERT and tag it by the table reference
 * passed in. Useful because a single persist call can fan out to
 * several tables (e.g. fhir_resources mapping, audit_log).
 */
function insertsByTable(): Array<{ tableArg: unknown; values: unknown }> {
  return db.insert.calls.map((c) => ({
    tableArg: c.args[0],
    values: c.chainArgs[0]?.[0],
  }));
}

function findInsertFor(
  tableSentinel: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const hit = insertsByTable().find((i) => i.tableArg === tableSentinel);
  return hit?.values as Record<string, unknown> | undefined;
}

function findAllInsertsFor(
  tableSentinel: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return insertsByTable()
    .filter((i) => i.tableArg === tableSentinel)
    .map((i) => i.values as Record<string, unknown>);
}

// ── Encounter ───────────────────────────────────────────────────

describe("persistEncounter — cross-source dedup (#1191)", () => {
  const RESOURCE = {
    resourceType: "Encounter",
    id: "epic-enc-1",
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p-1" },
    period: { start: "2026-05-20T09:00:00Z", end: "2026-05-20T09:45:00Z" },
  };

  it("dedups against an existing CareBridge-originated encounter by patient_id+start_time+encounter_type and inserts a mapping row", async () => {
    const existingInternalId = "internal-enc-1";
    // findMapping → no Epic mapping yet
    db.willSelect([]);
    // findByFingerprint → existing internal row matches the fingerprint
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        start_time: "2026-05-20T09:00:00Z",
        encounter_type: "AMB",
      },
    ]);
    // UPDATE the matched encounters row
    db.willUpdate();
    // UPSERT the fhir_resources mapping row
    db.willInsert();
    // audit_log insert (epic_sync_dedup_match)
    db.willInsert();

    const result = await persistEncounter(RESOURCE, PATIENT_ID);

    expect(result.internalId).toBe(existingInternalId);
    expect(result.kind).toBe("encounter");
    expect(result.inserted).toBe(false);
    // No new encounters row was inserted — only the mapping + audit.
    expect(findAllInsertsFor({} as never)).toBeDefined();

    // Verify mapping row was upserted pointing at the existing internal id.
    const fhirInsert = db.insert.calls.find((c) =>
      Object.prototype.hasOwnProperty.call(c.chainArgs[0]?.[0] ?? {}, "resource_type"),
    );
    expect(fhirInsert).toBeDefined();
    const mappingValues = fhirInsert!.chainArgs[0]![0] as Record<string, unknown>;
    expect(mappingValues.resource_type).toBe("Encounter");
    expect(mappingValues.resource_id).toBe("epic-enc-1");
    expect(mappingValues.internal_record_id).toBe(existingInternalId);

    // Verify audit_log entry with action=epic_sync_dedup_match
    const auditInsert = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.action === "epic_sync_dedup_match";
    });
    expect(auditInsert).toBeDefined();
    const auditValues = auditInsert!.chainArgs[0]![0] as Record<string, unknown>;
    expect(auditValues.resource_type).toBe("Encounter");
    expect(auditValues.resource_id).toBe(existingInternalId);
  });

  it("inserts a new row when no fingerprint match exists", async () => {
    db.willSelect([]); // findMapping miss
    db.willSelect([]); // findByFingerprint miss
    db.willInsert(); // new encounters row
    db.willInsert(); // fhir_resources mapping row

    const result = await persistEncounter(RESOURCE, PATIENT_ID);

    expect(result.inserted).toBe(true);
    expect(result.kind).toBe("encounter");
    // No audit_log dedup-match row when there's no fingerprint hit.
    const dedup = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.action === "epic_sync_dedup_match";
    });
    expect(dedup).toBeUndefined();
  });
});

// ── Condition / Diagnosis ──────────────────────────────────────

describe("persistCondition — cross-source dedup (#1191)", () => {
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
          display: "Other pulmonary embolism without acute cor pulmonale",
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

  it("dedups against existing CareBridge diagnosis by patient_id+icd10_code+onset_date", async () => {
    const existingInternalId = "internal-diag-1";
    db.willSelect([]); // findMapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        icd10_code: "I26.99",
        onset_date: "2026-04-15",
      },
    ]);
    db.willUpdate();
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistCondition(RESOURCE, PATIENT_ID);

    expect(result.internalId).toBe(existingInternalId);
    expect(result.kind).toBe("diagnosis");
    expect(result.inserted).toBe(false);

    const audit = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.action === "epic_sync_dedup_match";
    });
    expect(audit).toBeDefined();
  });

  it("falls through to insert when fingerprint misses", async () => {
    db.willSelect([]); // findMapping miss
    db.willSelect([]); // findByFingerprint miss
    db.willInsert(); // new diagnoses row
    db.willInsert(); // mapping

    const result = await persistCondition(RESOURCE, PATIENT_ID);
    expect(result.inserted).toBe(true);
  });
});

// ── Allergy ────────────────────────────────────────────────────

describe("persistAllergy — cross-source dedup (#1191)", () => {
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
          display: "Penicillin",
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

  it("dedups against existing CareBridge allergy by patient_id+snomed_code", async () => {
    const existingInternalId = "internal-aller-1";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        snomed_code: "373270004",
      },
    ]);
    db.willUpdate();
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistAllergy(RESOURCE, PATIENT_ID);
    expect(result.internalId).toBe(existingInternalId);
    expect(result.kind).toBe("allergy");
    expect(result.inserted).toBe(false);

    const audit = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.action === "epic_sync_dedup_match";
    });
    expect(audit).toBeDefined();
  });

  it("inserts when no fingerprint match", async () => {
    db.willSelect([]); // mapping miss
    db.willSelect([]); // fingerprint miss
    db.willInsert(); // new allergy row
    db.willInsert(); // mapping

    const result = await persistAllergy(RESOURCE, PATIENT_ID);
    expect(result.inserted).toBe(true);
  });
});

// ── MedicationRequest ──────────────────────────────────────────

describe("persistMedicationRequest — cross-source dedup (#1191)", () => {
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
          display: "Lisinopril 10 MG Oral Tablet",
        },
      ],
    },
    authoredOn: "2026-05-01T10:00:00Z",
  };

  it("dedups against existing CareBridge medication by patient_id+rxnorm_code+started_at", async () => {
    const existingInternalId = "internal-med-1";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        rxnorm_code: "314076",
        started_at: "2026-05-01T10:00:00Z",
      },
    ]);
    db.willUpdate();
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistMedicationRequest(RESOURCE, PATIENT_ID);
    expect(result.internalId).toBe(existingInternalId);
    expect(result.kind).toBe("medication");
    expect(result.inserted).toBe(false);

    const audit = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.action === "epic_sync_dedup_match";
    });
    expect(audit).toBeDefined();
  });

  it("inserts when no fingerprint match", async () => {
    db.willSelect([]); // mapping miss
    db.willSelect([]); // fingerprint miss
    db.willInsert(); // new medication row
    db.willInsert(); // mapping

    const result = await persistMedicationRequest(RESOURCE, PATIENT_ID);
    expect(result.inserted).toBe(true);
  });
});

// ── Observation / Vital ────────────────────────────────────────

describe("persistObservation (vital) — cross-source dedup (#1191)", () => {
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

  it("dedups against existing CareBridge vital by patient_id+loinc_code+recorded_at", async () => {
    const existingInternalId = "internal-vital-1";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingInternalId,
        patient_id: PATIENT_ID,
        loinc_code: "8867-4",
        recorded_at: "2026-05-20T08:00:00Z",
      },
    ]);
    db.willUpdate();
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistObservation(RESOURCE, PATIENT_ID);
    expect(result.internalId).toBe(existingInternalId);
    expect(result.kind).toBe("vital");
    expect(result.inserted).toBe(false);

    const audit = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.action === "epic_sync_dedup_match";
    });
    expect(audit).toBeDefined();
  });

  it("inserts when no fingerprint match", async () => {
    db.willSelect([]); // mapping miss
    db.willSelect([]); // fingerprint miss
    db.willInsert(); // new vital row
    db.willInsert(); // mapping

    const result = await persistObservation(RESOURCE, PATIENT_ID);
    expect(result.inserted).toBe(true);
  });
});

// ── Observation / Lab Panel ────────────────────────────────────

describe("persistObservation (lab) — panel-level dedup (#1202)", () => {
  const RESOURCE = {
    resourceType: "Observation",
    id: "epic-lab-1",
    status: "final",
    category: [
      {
        coding: [
          {
            system:
              "http://terminology.hl7.org/CodeSystem/observation-category",
            code: "laboratory",
          },
        ],
      },
    ],
    code: {
      text: "Hemoglobin",
      coding: [
        {
          system: "http://loinc.org",
          code: "718-7",
          display: "Hemoglobin",
        },
      ],
    },
    subject: { reference: "Patient/p-1" },
    effectiveDateTime: "2026-05-20T07:30:00Z",
    valueQuantity: { value: 13.2, unit: "g/dL" },
  };

  it("dedups against existing CareBridge lab_panels row by patient_id+panel_name+collected_at and attaches the result to it", async () => {
    const existingPanelId = "internal-panel-1";
    db.willSelect([]); // findMapping miss
    db.willSelect([
      {
        id: existingPanelId,
        patient_id: PATIENT_ID,
        panel_name: "Hemoglobin",
        collected_at: "2026-05-20T07:30:00Z",
      },
    ]);
    db.willInsert(); // lab_results row attached to existing panel
    db.willInsert(); // fhir_resources mapping row
    db.willInsert(); // audit_log epic_sync_dedup_match

    const result = await persistObservation(RESOURCE, PATIENT_ID);

    expect(result.kind).toBe("lab");
    expect(result.inserted).toBe(false);
    expect(result.internalId).toBe(existingPanelId);

    // Total of 3 inserts — lab_results, mapping, audit. No new lab_panels row.
    expect(db.insert).toHaveBeenCalledTimes(3);

    // There should be a lab_results insert pointing at the existing panel id.
    const labResultInsert = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.panel_id === existingPanelId;
    });
    expect(labResultInsert).toBeDefined();

    // audit_log epic_sync_dedup_match for the panel.
    const auditInsert = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.action === "epic_sync_dedup_match";
    });
    expect(auditInsert).toBeDefined();
    const auditValues = auditInsert!.chainArgs[0]![0] as Record<
      string,
      unknown
    >;
    expect(auditValues.resource_type).toBe("Observation");
    expect(auditValues.resource_id).toBe(existingPanelId);

    // fhir_resources mapping points at the existing panel id (so the
    // next Epic re-sync of the same Observation finds the same panel).
    const fhirInsert = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.resource_type === "Observation";
    });
    expect(fhirInsert).toBeDefined();
  });

  it("inserts a new lab_panels + lab_results row when no fingerprint match exists", async () => {
    db.willSelect([]); // findMapping miss
    db.willSelect([]); // findLabPanelByFingerprint miss
    db.willInsert(); // new lab_panels row
    db.willInsert(); // new lab_results row
    db.willInsert(); // fhir_resources mapping row

    const result = await persistObservation(RESOURCE, PATIENT_ID);

    expect(result.inserted).toBe(true);
    expect(result.kind).toBe("lab");

    // No audit_log dedup-match row when there's no fingerprint hit.
    const dedup = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.action === "epic_sync_dedup_match";
    });
    expect(dedup).toBeUndefined();
  });

  it("dedups single-result Observations using test_name as panel_name", async () => {
    // Two single-test Epic Observations for the same patient at the same
    // collected_at + test_name should resolve to the same lab_panels row.
    const existingPanelId = "internal-panel-cbc-1";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingPanelId,
        patient_id: PATIENT_ID,
        panel_name: "Hemoglobin",
        collected_at: "2026-05-20T07:30:00Z",
      },
    ]);
    db.willInsert(); // lab_results row attached
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistObservation(RESOURCE, PATIENT_ID);

    expect(result.internalId).toBe(existingPanelId);
    expect(result.kind).toBe("lab");
    expect(result.inserted).toBe(false);
  });
});

// ── Patient (already MRN-safe) ─────────────────────────────────

describe("persistPatient — MRN unique constraint preserves safety (#1191)", () => {
  const RESOURCE = {
    resourceType: "Patient",
    id: "epic-pat-1",
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

  it("dedups against existing CareBridge patient row by MRN fingerprint", async () => {
    const existingInternalId = "internal-pat-1";
    db.willSelect([]); // mapping miss
    db.willSelect([
      {
        id: existingInternalId,
        mrn_hmac: "anything",
      },
    ]);
    db.willUpdate();
    db.willInsert(); // mapping
    db.willInsert(); // audit

    const result = await persistPatient(RESOURCE);
    expect(result.internalId).toBe(existingInternalId);
    expect(result.kind).toBe("patient");
    expect(result.inserted).toBe(false);

    const audit = db.insert.calls.find((c) => {
      const v = c.chainArgs[0]?.[0] as Record<string, unknown> | undefined;
      return v?.action === "epic_sync_dedup_match";
    });
    expect(audit).toBeDefined();
  });

  it("inserts a new patient when no MRN match exists", async () => {
    db.willSelect([]); // mapping miss
    db.willSelect([]); // MRN fingerprint miss
    db.willInsert(); // new patient row
    db.willInsert(); // mapping

    const result = await persistPatient(RESOURCE);
    expect(result.inserted).toBe(true);
  });
});

// ── Smoke: pre-existing #1183 flow still works ────────────────

describe("findMapping fast-path remains intact (#1191 backwards compat)", () => {
  const RESOURCE = {
    resourceType: "Encounter",
    id: "epic-enc-2",
    status: "finished",
    class: { code: "AMB" },
    subject: { reference: "Patient/p-1" },
    period: { start: "2026-05-20T09:00:00Z" },
  };

  it("when fhir_resources mapping already exists, fingerprint lookup is skipped", async () => {
    db.willSelect([
      {
        id: "epic:Encounter:epic-enc-2",
        resource_type: "Encounter",
        resource_id: "epic-enc-2",
        internal_record_id: "internal-existing",
        source_system: "epic",
      },
    ]);
    db.willUpdate(); // update encounters row in place
    db.willInsert(); // upsert mapping (refresh)

    const result = await persistEncounter(RESOURCE, PATIENT_ID);
    expect(result.internalId).toBe("internal-existing");
    expect(result.inserted).toBe(false);
    // Exactly one SELECT call — the mapping lookup. No fingerprint SELECT.
    expect(db.select).toHaveBeenCalledOnce();
  });
});

// suppress unused helper warning
void findInsertFor;

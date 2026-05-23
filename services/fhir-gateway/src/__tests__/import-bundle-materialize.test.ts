/**
 * Integration test (#1066): import a bundle with a MedicationRequest
 * carrying Dosage.maxDosePerPeriod = 4/day with `materialize: true`,
 * then verify the persisted `medications` row carries the structured
 * fields buildPatientContextForRules consumes — in particular,
 * `max_doses_per_day: 4`.
 *
 * buildPatientContextForRules itself is covered end-to-end by tests in
 * services/ai-oversight; here we assert the row shape that landed in
 * the table, which is the exact contract that consumer reads:
 *   `active_medications_detail[].max_doses_per_day = m.max_doses_per_day ?? null`
 * (services/ai-oversight/src/services/review-service.ts ~914).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

type InsertCall = { table: unknown; row: Record<string, unknown> };
const insertCalls: InsertCall[] = [];

const insertMock = vi.fn((table: unknown) => ({
  values: vi.fn(async (row: Record<string, unknown>) => {
    insertCalls.push({ table, row });
  }),
}));

const transactionMock = vi.fn(
  async (cb: (tx: { insert: typeof insertMock }) => Promise<unknown>) => {
    return cb({ insert: insertMock });
  },
);

const fhirResourcesTable = { __name: "fhir_resources" };
const auditLogTable = { __name: "audit_log" };
const medicationsTable = { __name: "medications" };

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ insert: insertMock, transaction: transactionMock }),
  fhirResources: fhirResourcesTable,
  auditLog: auditLogTable,
  patients: { __name: "patients" },
  vitals: { __name: "vitals" },
  labPanels: { __name: "lab_panels" },
  labResults: { __name: "lab_results" },
  medications: medicationsTable,
  diagnoses: { __name: "diagnoses" },
  allergies: { __name: "allergies" },
  encounters: { __name: "encounters" },
  procedures: { __name: "procedures" },
  users: { __name: "users" },
}));

const { fhirGatewayRouter } = await import("../router.js");

const adminCtx = {
  user: {
    id: "user-admin",
    email: "admin@carebridge.dev",
    name: "Admin",
    role: "admin" as const,
    is_active: true,
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
  },
};

beforeEach(() => {
  insertCalls.length = 0;
  insertMock.mockClear();
  transactionMock.mockClear();
});

describe("importBundle materialize flag (#1066)", () => {
  it("does NOT write a medications row by default (materialize defaults to false)", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "MedicationRequest",
            id: "mr-1",
            status: "active",
            intent: "order",
            medicationCodeableConcept: { text: "Aspirin" },
            subject: { reference: "Patient/p-1" },
          },
        },
      ],
    };
    const result = await caller.importBundle({
      bundle,
      source_system: "epic-sandbox",
      user_id: "user-admin",
    });
    expect(result.imported).toBe(1);
    expect(result.materialized_medications).toBe(0);
    expect(insertCalls.some((c) => c.table === medicationsTable)).toBe(false);
  });

  it("materialises a MedicationRequest with maxDosePerPeriod=4/day into a medications row carrying max_doses_per_day:4", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "MedicationRequest",
            id: "mr-prn-morphine",
            status: "active",
            intent: "order",
            medicationCodeableConcept: {
              coding: [
                {
                  system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                  code: "7052",
                  display: "Morphine",
                },
              ],
              text: "Morphine",
            },
            subject: { reference: "Patient/p-1" },
            authoredOn: "2026-05-22T10:00:00.000Z",
            requester: { reference: "Practitioner/dr-smith" },
            dosageInstruction: [
              {
                timing: { code: { text: "q4h PRN" } },
                route: {
                  coding: [
                    {
                      system: "http://snomed.info/sct",
                      code: "26643006",
                      display: "Oral route",
                    },
                  ],
                  text: "oral",
                },
                doseAndRate: [
                  {
                    doseQuantity: {
                      value: 10,
                      unit: "mg",
                      system: "http://unitsofmeasure.org",
                      code: "mg",
                    },
                  },
                ],
                // Dosage.maxDosePerPeriod = 4 doses / 1 day
                maxDosePerPeriod: {
                  numerator: { value: 4, unit: "doses" },
                  denominator: {
                    value: 1,
                    unit: "day",
                    system: "http://unitsofmeasure.org",
                    code: "d",
                  },
                },
              },
            ],
          },
        },
      ],
    };

    const result = await caller.importBundle({
      bundle,
      source_system: "epic-sandbox",
      user_id: "user-admin",
      materialize: true,
      patient_id: "p-1",
    });

    expect(result.imported).toBe(1);
    expect(result.materialized_medications).toBe(1);

    const medRows = insertCalls
      .filter((c) => c.table === medicationsTable)
      .map((c) => c.row);
    expect(medRows).toHaveLength(1);
    const row = medRows[0]!;

    // The fields buildPatientContextForRules reads when assembling
    // active_medications_detail[] (services/ai-oversight/src/services/
    // review-service.ts ~904-925).
    expect(row.patient_id).toBe("p-1");
    expect(row.name).toBe("Morphine");
    expect(row.dose_amount).toBe(10);
    expect(row.dose_unit).toBe("mg");
    expect(row.route).toBe("oral");
    expect(row.frequency).toBe("q4h PRN");
    // The critical assertion: maxDosePerPeriod=4/day → max_doses_per_day:4
    // (the rule context flows this straight through to PatientMedication).
    expect(row.max_doses_per_day).toBe(4);
    expect(row.status).toBe("active");
    expect(row.started_at).toBe("2026-05-22T10:00:00.000Z");
    expect(row.prescribed_by).toBe("dr-smith");
    expect(row.rxnorm_code).toBe("7052");
    expect(row.source_system).toBe("fhir_import");
  });

  it("materialises MedicationStatement entries with no requester (prescribed_by stays null)", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "MedicationStatement",
            id: "ms-1",
            status: "active",
            medicationCodeableConcept: { text: "Lisinopril" },
            subject: { reference: "Patient/p-1" },
            effectivePeriod: { start: "2025-12-01T00:00:00.000Z" },
            dosage: [
              {
                timing: { code: { text: "daily" } },
                doseAndRate: [{ doseQuantity: { value: 10, unit: "mg" } }],
                route: { text: "oral" },
              },
            ],
          },
        },
      ],
    };
    const result = await caller.importBundle({
      bundle,
      source_system: "epic-sandbox",
      user_id: "user-admin",
      materialize: true,
      patient_id: "p-1",
    });
    expect(result.materialized_medications).toBe(1);
    const medRow = insertCalls.find((c) => c.table === medicationsTable)?.row;
    expect(medRow).toBeDefined();
    expect(medRow!.name).toBe("Lisinopril");
    expect(medRow!.prescribed_by).toBeNull();
    expect(medRow!.started_at).toBe("2025-12-01T00:00:00.000Z");
  });

  it("skips non-medication resources during materialisation but still imports them as raw FHIR", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Observation",
            id: "obs-1",
            status: "final",
            code: { text: "BP" },
          },
        },
        {
          resource: {
            resourceType: "MedicationRequest",
            id: "mr-skip",
            status: "entered-in-error", // mapper returns null → skipped
            medicationCodeableConcept: { text: "Acetaminophen" },
          },
        },
      ],
    };
    const result = await caller.importBundle({
      bundle,
      source_system: "epic-sandbox",
      user_id: "user-admin",
      materialize: true,
      patient_id: "p-1",
    });
    expect(result.imported).toBe(2);
    expect(result.materialized_medications).toBe(0);
    // Both raw FHIR resources should still be persisted + audited.
    expect(
      insertCalls.filter((c) => c.table === fhirResourcesTable),
    ).toHaveLength(2);
    expect(
      insertCalls.filter((c) => c.table === auditLogTable),
    ).toHaveLength(2);
    expect(
      insertCalls.filter((c) => c.table === medicationsTable),
    ).toHaveLength(0);
  });
});

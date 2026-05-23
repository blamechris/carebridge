/**
 * Integration test (#337): import a bundle with an AllergyIntolerance
 * carrying RxNorm coding + criticality + reaction.severity with
 * `materialize: true`, then verify the persisted `allergies` row carries
 * the structured fields the ai-oversight allergy-medication rule consumes.
 *
 * Mirrors the medication-mapper integration test at
 * import-bundle-materialize.test.ts but for the allergies-row path.
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
const allergiesTable = { __name: "allergies" };
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
  allergies: allergiesTable,
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

describe("importBundle materialize flag — AllergyIntolerance (#337)", () => {
  it("does NOT write an allergies row by default (materialize defaults to false)", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "AllergyIntolerance",
            id: "ai-1",
            code: { text: "Penicillin" },
            patient: { reference: "Patient/p-1" },
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
    expect(result.materialized_allergies).toBe(0);
    expect(insertCalls.some((c) => c.table === allergiesTable)).toBe(false);
  });

  it("materialises an AllergyIntolerance with RxNorm coding + reaction.severity into an allergies row", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "AllergyIntolerance",
            id: "ai-penicillin",
            clinicalStatus: {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
                  code: "active",
                },
              ],
            },
            verificationStatus: {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
                  code: "confirmed",
                },
              ],
            },
            code: {
              coding: [
                {
                  system: "http://www.nlm.nih.gov/research/umls/rxnorm",
                  code: "7980",
                  display: "Penicillin G",
                },
              ],
              text: "Penicillin",
            },
            patient: { reference: "Patient/p-1" },
            recordedDate: "2026-04-10T00:00:00.000Z",
            criticality: "high",
            recorder: { reference: "Practitioner/dr-smith" },
            reaction: [
              {
                manifestation: [
                  { coding: [{ display: "Hives" }], text: "Hives" },
                ],
                description: "Hives and throat swelling 30 min post-dose",
                severity: "severe",
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
    expect(result.materialized_allergies).toBe(1);

    const allergyRows = insertCalls
      .filter((c) => c.table === allergiesTable)
      .map((c) => c.row);
    expect(allergyRows).toHaveLength(1);
    const row = allergyRows[0]!;

    expect(row.patient_id).toBe("p-1");
    expect(row.allergen).toBe("Penicillin");
    expect(row.rxnorm_code).toBe("7980");
    expect(row.snomed_code).toBeNull();
    expect(row.reaction).toBe("Hives and throat swelling 30 min post-dose");
    expect(row.severity).toBe("severe");
    expect(row.verification_status).toBe("confirmed");
    expect(typeof row.created_at).toBe("string");
  });

  it("materialises a food AllergyIntolerance (no RxNorm) with criticality-derived severity", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "AllergyIntolerance",
            id: "ai-peanut",
            code: { text: "Peanut" },
            patient: { reference: "Patient/p-1" },
            criticality: "low",
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
    expect(result.materialized_allergies).toBe(1);
    const row = insertCalls.find((c) => c.table === allergiesTable)?.row;
    expect(row).toBeDefined();
    expect(row!.allergen).toBe("Peanut");
    expect(row!.rxnorm_code).toBeNull();
    expect(row!.severity).toBe("mild"); // low → mild
    expect(row!.reaction).toBeNull();
    expect(row!.verification_status).toBe("unconfirmed");
  });

  it("skips AllergyIntolerance entries with verificationStatus: entered-in-error", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "AllergyIntolerance",
            id: "ai-mistake",
            verificationStatus: {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/allergyintolerance-verification",
                  code: "entered-in-error",
                },
              ],
            },
            code: { text: "Aspirin" },
            patient: { reference: "Patient/p-1" },
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
    // The raw FHIR resource still imports, but the materialised row does not.
    expect(result.imported).toBe(1);
    expect(result.materialized_allergies).toBe(0);
    expect(insertCalls.some((c) => c.table === allergiesTable)).toBe(false);
    expect(insertCalls.some((c) => c.table === fhirResourcesTable)).toBe(true);
  });

  it("returns both materialised counters (medications + allergies) in a mixed bundle", async () => {
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
            medicationCodeableConcept: { text: "Lisinopril" },
            subject: { reference: "Patient/p-1" },
          },
        },
        {
          resource: {
            resourceType: "AllergyIntolerance",
            id: "ai-1",
            code: { text: "Penicillin" },
            patient: { reference: "Patient/p-1" },
            criticality: "high",
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
    expect(result.materialized_medications).toBe(1);
    expect(result.materialized_allergies).toBe(1);
    expect(insertCalls.filter((c) => c.table === medicationsTable)).toHaveLength(1);
    expect(insertCalls.filter((c) => c.table === allergiesTable)).toHaveLength(1);
  });
});

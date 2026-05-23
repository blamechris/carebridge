/**
 * Integration test (#337): import a bundle with a FHIR Condition
 * carrying ICD-10 + SNOMED codings, clinicalStatus=active and a
 * recorder reference, then verify the persisted `diagnoses` row
 * carries the structured fields the patient-records router would
 * have produced for an internal write.
 *
 * Mirrors import-bundle-materialize.test.ts (#1066) so the
 * Condition mapper integration sits next to the MedicationRequest
 * mapper integration with the same shape.
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
const diagnosesTable = { __name: "diagnoses" };
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
  diagnoses: diagnosesTable,
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

describe("importBundle materialize flag — Condition (#337)", () => {
  it("does NOT write a diagnoses row by default (materialize defaults to false)", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Condition",
            id: "cond-1",
            code: { text: "Hypertension" },
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
    expect(result.materialized_diagnoses).toBe(0);
    expect(insertCalls.some((c) => c.table === diagnosesTable)).toBe(false);
  });

  it("materialises a Condition with ICD-10 + SNOMED into a diagnoses row", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Condition",
            id: "cond-breast-ca",
            clinicalStatus: {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/condition-clinical",
                  code: "active",
                },
              ],
            },
            verificationStatus: {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/condition-ver-status",
                  code: "confirmed",
                },
              ],
            },
            code: {
              coding: [
                {
                  system: "http://hl7.org/fhir/sid/icd-10-cm",
                  code: "C50.911",
                  display: "Malignant neoplasm of breast",
                },
                {
                  system: "http://snomed.info/sct",
                  code: "254837009",
                  display: "Malignant neoplasm of breast",
                },
              ],
              text: "Malignant neoplasm of breast",
            },
            subject: { reference: "Patient/p-1" },
            onsetDateTime: "2026-04-10T00:00:00.000Z",
            recordedDate: "2026-04-11T00:00:00.000Z",
            recorder: { reference: "Practitioner/dr-smith" },
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
    expect(result.materialized_diagnoses).toBe(1);

    const dxRows = insertCalls
      .filter((c) => c.table === diagnosesTable)
      .map((c) => c.row);
    expect(dxRows).toHaveLength(1);
    const row = dxRows[0]!;

    expect(row.patient_id).toBe("p-1");
    expect(row.description).toBe("Malignant neoplasm of breast");
    expect(row.icd10_code).toBe("C50.911");
    expect(row.snomed_code).toBe("254837009");
    expect(row.status).toBe("active");
    expect(row.onset_date).toBe("2026-04-10T00:00:00.000Z");
    expect(row.resolved_date).toBeNull();
    expect(row.diagnosed_by).toBe("dr-smith");
    // External recordedDate is honoured in the persisted created_at.
    expect(row.created_at).toBe("2026-04-11T00:00:00.000Z");
  });

  it("skips Condition resources flagged entered-in-error but still imports them as raw FHIR", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Condition",
            id: "cond-erroneous",
            verificationStatus: {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/condition-ver-status",
                  code: "entered-in-error",
                },
              ],
            },
            code: { text: "Hypertension" },
            subject: { reference: "Patient/p-1" },
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
    expect(result.materialized_diagnoses).toBe(0);
    // Raw FHIR resource still persisted + audited even though the
    // diagnoses materialisation skipped.
    expect(
      insertCalls.filter((c) => c.table === fhirResourcesTable),
    ).toHaveLength(1);
    expect(
      insertCalls.filter((c) => c.table === auditLogTable),
    ).toHaveLength(1);
    expect(
      insertCalls.filter((c) => c.table === diagnosesTable),
    ).toHaveLength(0);
  });

  it("materialises a SNOMED-only Condition with null icd10_code", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Condition",
            clinicalStatus: {
              coding: [
                {
                  system:
                    "http://terminology.hl7.org/CodeSystem/condition-clinical",
                  code: "inactive",
                },
              ],
            },
            code: {
              coding: [
                {
                  system: "http://snomed.info/sct",
                  code: "73211009",
                  display: "Diabetes mellitus",
                },
              ],
            },
            subject: { reference: "Patient/p-1" },
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
    expect(result.materialized_diagnoses).toBe(1);
    const row = insertCalls.find((c) => c.table === diagnosesTable)?.row;
    expect(row).toBeDefined();
    expect(row!.icd10_code).toBeNull();
    expect(row!.snomed_code).toBe("73211009");
    expect(row!.status).toBe("resolved");
    expect(row!.onset_date).toBeNull();
  });
});

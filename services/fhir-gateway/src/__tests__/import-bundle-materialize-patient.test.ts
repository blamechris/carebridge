/**
 * Integration test (#337): import a bundle containing FHIR Patient
 * resources with `materialize: true`, then verify the persisted
 * `patients` rows carry the demographic fields the patient-records
 * service expects — name, date_of_birth, biological_sex, mrn,
 * source_system.
 *
 * Mirrors the structure of import-bundle-materialize.test.ts (#1066)
 * which covers the MedicationRequest materialisation path.
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
const patientsTable = { __name: "patients" };
const medicationsTable = { __name: "medications" };

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ insert: insertMock, transaction: transactionMock }),
  // hmacForIndex stub — the real impl HMACs with a key but for the
  // materialiser test we only need a deterministic non-empty string so
  // the writer code can stash it in `mrn_hmac` / `name_hmac`.
  hmacForIndex: (v: string) => `hmac:${v}`,
  fhirResources: fhirResourcesTable,
  auditLog: auditLogTable,
  patients: patientsTable,
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

describe("importBundle materialize=true → patients row (#337)", () => {
  it("does NOT write a patients row when materialize is false (default)", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Patient",
            id: "pat-1",
            name: [{ use: "official", text: "Jane Doe", family: "Doe", given: ["Jane"] }],
            birthDate: "1980-05-12",
            gender: "female",
            identifier: [
              {
                type: {
                  coding: [
                    {
                      system: "http://terminology.hl7.org/CodeSystem/v2-0203",
                      code: "MR",
                    },
                  ],
                },
                value: "MRN-12345",
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
    });
    expect(result.imported).toBe(1);
    expect(result.materialized_patients).toBe(0);
    expect(insertCalls.some((c) => c.table === patientsTable)).toBe(false);
    // Raw FHIR insert + audit_log row still happen.
    expect(
      insertCalls.filter((c) => c.table === fhirResourcesTable),
    ).toHaveLength(1);
  });

  it("materialises a Patient with name, dob, sex, and MRN", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Patient",
            id: "pat-jane-doe",
            active: true,
            name: [
              {
                use: "official",
                family: "Doe",
                given: ["Jane", "Marie"],
                text: "Jane Marie Doe",
              },
            ],
            birthDate: "1980-05-12",
            gender: "female",
            identifier: [
              {
                use: "usual",
                type: {
                  coding: [
                    {
                      system: "http://terminology.hl7.org/CodeSystem/v2-0203",
                      code: "MR",
                      display: "Medical Record Number",
                    },
                  ],
                },
                system: "https://carebridge.dev/fhir/sid/mrn",
                value: "MRN-42",
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
    });

    expect(result.imported).toBe(1);
    expect(result.materialized_patients).toBe(1);

    const patientRows = insertCalls
      .filter((c) => c.table === patientsTable)
      .map((c) => c.row);
    expect(patientRows).toHaveLength(1);
    const row = patientRows[0]!;

    expect(row.name).toBe("Jane Marie Doe");
    expect(row.date_of_birth).toBe("1980-05-12");
    expect(row.biological_sex).toBe("female");
    expect(row.mrn).toBe("MRN-42");
    // `patients` table has no `source_system` column today (unlike the
    // `medications` table) — the mapper still produces a source_system
    // tag for callers / logging, but it isn't persisted into the row.
    expect(row.source_system).toBeUndefined();
    // Server-assigned fields are present.
    expect(typeof row.id).toBe("string");
    expect(typeof row.created_at).toBe("string");
    expect(typeof row.updated_at).toBe("string");
    // HMAC columns are populated for searchable fields.
    expect(row.name_hmac).toBe("hmac:Jane Marie Doe");
    expect(row.mrn_hmac).toBe("hmac:MRN-42");
  });

  it("skips materialisation when Patient.active is false", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Patient",
            id: "pat-retired",
            active: false,
            name: [{ family: "Retired", text: "Retired Patient" }],
          },
        },
      ],
    };
    const result = await caller.importBundle({
      bundle,
      source_system: "epic-sandbox",
      user_id: "user-admin",
      materialize: true,
    });
    // Raw FHIR insert + audit still happen (we don't drop the FHIR
    // resource itself just because we won't materialise a patient row).
    expect(result.imported).toBe(1);
    expect(result.materialized_patients).toBe(0);
    expect(insertCalls.some((c) => c.table === patientsTable)).toBe(false);
  });

  it("skips materialisation when Patient has no name and no MRN", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Patient",
            id: "pat-anon",
            gender: "unknown",
          },
        },
      ],
    };
    const result = await caller.importBundle({
      bundle,
      source_system: "epic-sandbox",
      user_id: "user-admin",
      materialize: true,
    });
    expect(result.imported).toBe(1);
    expect(result.materialized_patients).toBe(0);
    expect(insertCalls.some((c) => c.table === patientsTable)).toBe(false);
  });

  it("leaves mrn_hmac unset when the Patient has no MRN", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Patient",
            id: "pat-no-mrn",
            name: [{ family: "Smith", given: ["John"] }],
            gender: "male",
          },
        },
      ],
    };
    await caller.importBundle({
      bundle,
      source_system: "epic-sandbox",
      user_id: "user-admin",
      materialize: true,
    });
    const row = insertCalls.find((c) => c.table === patientsTable)?.row;
    expect(row).toBeDefined();
    expect(row!.mrn).toBeNull();
    expect(row!.mrn_hmac).toBeNull();
    expect(row!.name).toBe("John Smith");
  });

  it("materialises multiple Patient entries in one bundle", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Patient",
            id: "pat-a",
            name: [{ text: "Alice Adams" }],
            gender: "female",
          },
        },
        {
          resource: {
            resourceType: "Patient",
            id: "pat-b",
            name: [{ text: "Bob Brown" }],
            gender: "male",
          },
        },
      ],
    };
    const result = await caller.importBundle({
      bundle,
      source_system: "epic-sandbox",
      user_id: "user-admin",
      materialize: true,
    });
    expect(result.imported).toBe(2);
    expect(result.materialized_patients).toBe(2);
    expect(
      insertCalls.filter((c) => c.table === patientsTable),
    ).toHaveLength(2);
  });
});

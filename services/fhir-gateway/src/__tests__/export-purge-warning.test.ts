import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
type InsertCall = { table: unknown; row: Record<string, unknown> };
const insertCalls: InsertCall[] = [];

const insertMock = vi.fn((table: unknown) => ({
  values: vi.fn(async (row: Record<string, unknown>) => {
    insertCalls.push({ table, row });
  }),
}));

const patientsTable = { __name: "patients" };
const vitalsTable = { __name: "vitals" };
const labPanelsTable = { __name: "lab_panels" };
const labResultsTable = { __name: "lab_results" };
const medicationsTable = { __name: "medications" };
const diagnosesTable = { __name: "diagnoses" };
const allergiesTable = { __name: "allergies" };
const encountersTable = { __name: "encounters" };
const proceduresTable = { __name: "procedures" };
const usersTable = { __name: "users" };
const fhirResourcesTable = { __name: "fhir_resources" };
const auditLogTable = { __name: "audit_log" };

let patientRows: Record<string, unknown>[] = [];
// Rows returned when the router queries audit_log for prior expired exports.
let priorAuditRows: Record<string, unknown>[] = [];

function selectMock() {
  return {
    from: (table: unknown) => ({
      where: async () => {
        if (table === patientsTable) return patientRows;
        if (table === auditLogTable) return priorAuditRows;
        return [];
      },
    }),
  };
}

const transactionMock = vi.fn(
  async (cb: (tx: { insert: typeof insertMock }) => Promise<unknown>) => {
    return cb({ insert: insertMock });
  },
);

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    insert: insertMock,
    transaction: transactionMock,
    select: selectMock,
  }),
  fhirResources: fhirResourcesTable,
  auditLog: auditLogTable,
  patients: patientsTable,
  vitals: vitalsTable,
  labPanels: labPanelsTable,
  labResults: labResultsTable,
  medications: medicationsTable,
  diagnoses: diagnosesTable,
  allergies: allergiesTable,
  encounters: encountersTable,
  procedures: proceduresTable,
  users: usersTable,
}));

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, _val: unknown) => ({ __eq: true }),
  and: (..._args: unknown[]) => ({ __and: true }),
  inArray: (_col: unknown, _values: unknown[]) => ({ __inArray: true }),
  sql: Object.assign(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => ({
      __sql: true,
    }),
    { raw: (s: string) => ({ __raw: s }) },
  ),
}));

vi.mock("../generators/index.js", () => ({
  toFhirPatient: (p: unknown) => ({ resourceType: "Patient", _p: p }),
  toFhirVitalObservation: () => ({ resourceType: "Observation" }),
  toFhirLabObservation: () => ({ resourceType: "Observation" }),
  toFhirCondition: () => ({ resourceType: "Condition" }),
  toFhirMedicationStatement: () => ({ resourceType: "MedicationStatement" }),
  toFhirAllergyIntolerance: () => ({ resourceType: "AllergyIntolerance" }),
  toFhirEncounter: () => ({ resourceType: "Encounter" }),
  toFhirProcedure: () => ({ resourceType: "Procedure" }),
  toFhirPractitioner: () => ({ resourceType: "Practitioner" }),
  toFhirMedicationRequest: () => ({ resourceType: "MedicationRequest" }),
  isClinicalRole: (role: string) =>
    ["physician", "specialist", "nurse"].includes(role),
}));

vi.mock("@carebridge/phi-sanitizer", () => ({
  sanitizeFreeText: (s: string) => s,
}));

// Capture logger.warn calls.
const loggerWarnSpy = vi.fn();
vi.mock("@carebridge/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerWarnSpy,
    error: vi.fn(),
  }),
}));

// ── Import after mocks ─────────────────────────────────────────
const { fhirGatewayRouter } = await import("../router.js");

const adminUser = {
  id: "user-admin-1",
  email: "admin@carebridge.dev",
  name: "Admin",
  role: "admin" as const,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

beforeEach(() => {
  insertCalls.length = 0;
  insertMock.mockClear();
  transactionMock.mockClear();
  loggerWarnSpy.mockClear();
  patientRows = [];
  priorAuditRows = [];
});

describe("exportPatient purge-at audit warning", () => {
  it("emits a structured warning when a prior export has an expired recommended_purge_at", async () => {
    patientRows = [
      {
        id: "patient-42",
        first_name: "Ada",
        last_name: "Lovelace",
        date_of_birth: "1815-12-10",
      },
    ];

    const pastPurge = new Date(Date.now() - 60_000).toISOString();
    priorAuditRows = [
      {
        id: "audit-prev-1",
        details: JSON.stringify({
          export_type: "patient_full_bundle",
          export_id: "prev-export-id",
          recommended_purge_at: pastPurge,
        }),
        timestamp: new Date(Date.now() - 120_000).toISOString(),
      },
    ];

    const caller = fhirGatewayRouter.createCaller({ user: adminUser });
    const bundle = await caller.exportPatient({ patientId: "patient-42" });

    expect(bundle.resourceType).toBe("Bundle");

    // Logger should have been called with the warning.
    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    const [msg, meta] = loggerWarnSpy.mock.calls[0]!;
    expect(msg).toBe("re-export requested after recommended_purge_at");
    expect(meta).toMatchObject({
      user_id: "user-admin-1",
      patient_id: "patient-42",
      prior_export_id: "prev-export-id",
      prior_recommended_purge_at: pastPurge,
      expired_export_count: 1,
    });
  });

  it("does not emit a warning when there are no prior expired exports", async () => {
    patientRows = [
      {
        id: "patient-42",
        first_name: "Ada",
        last_name: "Lovelace",
        date_of_birth: "1815-12-10",
      },
    ];
    priorAuditRows = []; // No prior exports.

    const caller = fhirGatewayRouter.createCaller({ user: adminUser });
    await caller.exportPatient({ patientId: "patient-42" });

    expect(loggerWarnSpy).not.toHaveBeenCalled();
  });

  it("includes expired_export_count when multiple prior exports exist", async () => {
    patientRows = [
      {
        id: "patient-42",
        first_name: "Ada",
        last_name: "Lovelace",
        date_of_birth: "1815-12-10",
      },
    ];

    const pastPurge1 = new Date(Date.now() - 120_000).toISOString();
    const pastPurge2 = new Date(Date.now() - 60_000).toISOString();
    priorAuditRows = [
      {
        id: "audit-prev-1",
        details: JSON.stringify({
          export_type: "patient_full_bundle",
          export_id: "prev-export-1",
          recommended_purge_at: pastPurge1,
        }),
        timestamp: new Date(Date.now() - 180_000).toISOString(),
      },
      {
        id: "audit-prev-2",
        details: JSON.stringify({
          export_type: "patient_full_bundle",
          export_id: "prev-export-2",
          recommended_purge_at: pastPurge2,
        }),
        timestamp: new Date(Date.now() - 90_000).toISOString(),
      },
    ];

    const caller = fhirGatewayRouter.createCaller({ user: adminUser });
    await caller.exportPatient({ patientId: "patient-42" });

    expect(loggerWarnSpy).toHaveBeenCalledTimes(1);
    const [, meta] = loggerWarnSpy.mock.calls[0]!;
    expect(meta.expired_export_count).toBe(2);
    // Should reference the most recent (last) prior export.
    expect(meta.prior_export_id).toBe("prev-export-2");
  });
});

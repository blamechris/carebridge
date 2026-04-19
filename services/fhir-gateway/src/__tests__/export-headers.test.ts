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
const fhirResourcesTable = { __name: "fhir_resources" };
const auditLogTable = { __name: "audit_log" };

let patientRows: Record<string, unknown>[] = [];

function selectMock() {
  return {
    from: (table: unknown) => ({
      where: async () => {
        if (table === patientsTable) return patientRows;
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
}));

vi.mock("drizzle-orm", () => ({
  eq: (_col: unknown, _val: unknown) => ({ __eq: true }),
  and: (..._args: unknown[]) => ({ __and: true }),
  sql: Object.assign(
    (_strings: TemplateStringsArray, ..._values: unknown[]) => ({ __sql: true }),
    { raw: (s: string) => ({ __raw: s }) },
  ),
}));

vi.mock("@carebridge/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
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
}));

vi.mock("@carebridge/phi-sanitizer", () => ({
  sanitizeFreeText: (s: string) => s,
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
  patientRows = [];
});

describe("exportPatient security headers", () => {
  it("sets Cache-Control: no-store, no-cache, must-revalidate via setHeader", async () => {
    patientRows = [
      {
        id: "patient-42",
        first_name: "Ada",
        last_name: "Lovelace",
        date_of_birth: "1815-12-10",
      },
    ];

    const setHeader = vi.fn();
    const caller = fhirGatewayRouter.createCaller({
      user: adminUser,
      setHeader,
    });

    await caller.exportPatient({ patientId: "patient-42" });

    expect(setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "no-store, no-cache, must-revalidate",
    );
  });

  it("sets Pragma: no-cache via setHeader", async () => {
    patientRows = [
      {
        id: "patient-42",
        first_name: "Ada",
        last_name: "Lovelace",
        date_of_birth: "1815-12-10",
      },
    ];

    const setHeader = vi.fn();
    const caller = fhirGatewayRouter.createCaller({
      user: adminUser,
      setHeader,
    });

    await caller.exportPatient({ patientId: "patient-42" });

    expect(setHeader).toHaveBeenCalledWith("Pragma", "no-cache");
  });

  it("sets Content-Disposition: attachment with export-id filename via setHeader", async () => {
    patientRows = [
      {
        id: "patient-42",
        first_name: "Ada",
        last_name: "Lovelace",
        date_of_birth: "1815-12-10",
      },
    ];

    const setHeader = vi.fn();
    const caller = fhirGatewayRouter.createCaller({
      user: adminUser,
      setHeader,
    });

    const bundle = await caller.exportPatient({ patientId: "patient-42" });

    // Extract the export_id from the bundle meta extension to verify the
    // Content-Disposition filename matches.
    const ext = bundle.meta!.extension![0]!;
    const extPayload = JSON.parse(ext.valueString as string) as Record<
      string,
      unknown
    >;
    const exportId = extPayload.export_id as string;

    expect(setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      `attachment; filename="bundle-${exportId}.json"`,
    );
  });

  it("does not throw when setHeader is absent (createCaller without HTTP context)", async () => {
    patientRows = [
      {
        id: "patient-42",
        first_name: "Ada",
        last_name: "Lovelace",
        date_of_birth: "1815-12-10",
      },
    ];

    // No setHeader in context — simulates direct createCaller usage.
    const caller = fhirGatewayRouter.createCaller({ user: adminUser });

    const bundle = await caller.exportPatient({ patientId: "patient-42" });
    expect(bundle.resourceType).toBe("Bundle");
  });

  it("does not set headers on failure (patient not found)", async () => {
    patientRows = [];

    const setHeader = vi.fn();
    const caller = fhirGatewayRouter.createCaller({
      user: adminUser,
      setHeader,
    });

    await expect(
      caller.exportPatient({ patientId: "nonexistent" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // Headers are only set on the success path.
    expect(setHeader).not.toHaveBeenCalled();
  });
});

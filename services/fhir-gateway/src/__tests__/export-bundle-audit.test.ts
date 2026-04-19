import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
// Capture every `db.insert(table).values(row)` call so we can assert the
// exportPatient procedure writes an audit_log row with the right action,
// success flag, and http_status_code on both the happy path and the
// patient-not-found failure path.
type InsertCall = { table: unknown; row: Record<string, unknown> };
const insertCalls: InsertCall[] = [];

const insertMock = vi.fn((table: unknown) => ({
  values: vi.fn(async (row: Record<string, unknown>) => {
    insertCalls.push({ table, row });
  }),
}));

// Control what `db.select().from(table).where(...)` resolves to. The
// exportPatient procedure issues 6 distinct reads: one `patients` lookup,
// then vitals/labPanels/medications/diagnoses/allergies in parallel, then
// zero-or-more labResults reads per panel. We route by table reference.
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
// When set, reading this table throws the given error — used to simulate
// a mid-bundle DB failure so we can assert the failure audit path.
let throwOnTable: { table: unknown; error: Error } | null = null;

function selectMock() {
  return {
    from: (table: unknown) => ({
      where: async () => {
        if (throwOnTable && table === throwOnTable.table) {
          throw throwOnTable.error;
        }
        if (table === patientsTable) return patientRows;
        // Every other table returns empty — a minimal patient export.
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

// drizzle-orm's `eq` is only used to build where-clauses; our select mock
// ignores the predicate and returns rows based solely on the table, so
// stub `eq` to a no-op sentinel.
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

// The router also imports FHIR generators — mock to identity-ish stubs so
// the test doesn't depend on generator output shape.
vi.mock("../generators/index.js", () => ({
  toFhirPatient: (p: unknown) => ({ resourceType: "Patient", _p: p }),
  toFhirVitalObservation: () => ({ resourceType: "Observation" }),
  toFhirLabObservation: () => ({ resourceType: "Observation" }),
  toFhirCondition: () => ({ resourceType: "Condition" }),
  toFhirMedicationStatement: () => ({ resourceType: "MedicationStatement" }),
  toFhirAllergyIntolerance: () => ({ resourceType: "AllergyIntolerance" }),
}));

// PHI sanitizer pass-through.
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
  throwOnTable = null;
});

describe("exportPatient audit logging", () => {
  it("writes one audit_log row with action='fhir_export', success=true on happy path", async () => {
    patientRows = [
      {
        id: "patient-42",
        first_name: "Ada",
        last_name: "Lovelace",
        date_of_birth: "1815-12-10",
      },
    ];

    const caller = fhirGatewayRouter.createCaller({ user: adminUser });

    const bundle = await caller.exportPatient({ patientId: "patient-42" });

    // Sanity: bundle came back.
    expect(bundle.resourceType).toBe("Bundle");
    expect(bundle.type).toBe("collection");

    // FHIR-conformant meta: export metadata carried as a Meta.extension,
    // not as ad-hoc primitive fields on Meta.
    expect(bundle.meta).toBeDefined();
    expect(bundle.meta!.lastUpdated).toBeDefined();
    expect(Array.isArray(bundle.meta!.extension)).toBe(true);
    const ext = bundle.meta!.extension![0]!;
    expect(ext.url).toBe(
      "https://carebridge.dev/fhir/StructureDefinition/export-meta",
    );
    const extPayload = JSON.parse(ext.valueString as string) as Record<
      string,
      unknown
    >;
    expect(extPayload.export_id).toBeDefined();
    expect(extPayload.exported_at).toBeDefined();
    expect(extPayload.recommended_purge_at).toBeDefined();
    expect(extPayload.exported_by).toBe("user-admin-1");

    // Exactly one audit_log row, written AFTER the bundle succeeded.
    const auditRows = insertCalls
      .filter((c) => c.table === auditLogTable)
      .map((c) => c.row);
    expect(auditRows).toHaveLength(1);

    const row = auditRows[0]!;
    expect(row.user_id).toBe("user-admin-1");
    expect(row.action).toBe("fhir_export");
    expect(row.resource_type).toBe("fhir_bundle");
    expect(row.procedure_name).toBe("fhir.exportPatient");
    expect(row.patient_id).toBe("patient-42");
    expect(row.http_status_code).toBe(200);
    expect(row.success).toBe(true);
    expect(row.error_message).toBeNull();

    const details = JSON.parse(row.details as string) as Record<string, unknown>;
    expect(details.export_type).toBe("patient_full_bundle");
    expect(details.export_id).toBeDefined();
    expect(details.recommended_purge_at).toBeDefined();
  });

  it("writes audit_log with success=false when the patient fetch returns no rows", async () => {
    patientRows = []; // Triggers NOT_FOUND in the router.

    const caller = fhirGatewayRouter.createCaller({ user: adminUser });

    await expect(
      caller.exportPatient({ patientId: "nonexistent" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const auditRows = insertCalls
      .filter((c) => c.table === auditLogTable)
      .map((c) => c.row);

    // Exactly one audit_log row — the failure audit written before the
    // TRPCError is thrown. No duplicate in the outer catch.
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0]!;
    expect(row.action).toBe("fhir_export");
    expect(row.success).toBe(false);
    expect(row.http_status_code).toBe(404);
    expect(row.patient_id).toBe("nonexistent");
    expect(typeof row.error_message).toBe("string");
    expect(row.error_message).toContain("not found");
  });

  it("writes audit_log with success=false when an unexpected error happens mid-fetch", async () => {
    // Patient row exists — get past NOT_FOUND — but the vitals select
    // throws, simulating a DB hiccup during bundle assembly. The router
    // must still record the attempt as a failed export via the outer
    // catch/writeAudit path.
    patientRows = [
      {
        id: "patient-7",
        first_name: "Grace",
        last_name: "Hopper",
        date_of_birth: "1906-12-09",
      },
    ];
    throwOnTable = {
      table: vitalsTable,
      error: new Error("simulated DB failure on vitals read"),
    };

    const caller = fhirGatewayRouter.createCaller({ user: adminUser });

    await expect(
      caller.exportPatient({ patientId: "patient-7" }),
    ).rejects.toThrow(/simulated DB failure/);

    const auditRows = insertCalls
      .filter((c) => c.table === auditLogTable)
      .map((c) => c.row);
    expect(auditRows).toHaveLength(1);
    const row = auditRows[0]!;
    expect(row.action).toBe("fhir_export");
    expect(row.success).toBe(false);
    expect(row.http_status_code).toBe(500);
    expect(row.patient_id).toBe("patient-7");
    expect(row.error_message).toContain("simulated DB failure");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
// Capture every `db.insert(table).values(row)` call so we can assert the
// importBundle procedure writes both fhir_resources rows AND audit_log rows.
type InsertCall = { table: unknown; row: Record<string, unknown> };
const insertCalls: InsertCall[] = [];

const insertMock = vi.fn((table: unknown) => ({
  values: vi.fn(async (row: Record<string, unknown>) => {
    insertCalls.push({ table, row });
  }),
}));

// Sentinels so the test can distinguish tables without needing real drizzle defs.
const fhirResourcesTable = { __name: "fhir_resources" };
const auditLogTable = { __name: "audit_log" };

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ insert: insertMock }),
  fhirResources: fhirResourcesTable,
  auditLog: auditLogTable,
  // The router also imports these, so they need to exist on the mock even
  // though they are only used by the unrelated exportPatient procedure.
  patients: { __name: "patients" },
  vitals: { __name: "vitals" },
  labPanels: { __name: "lab_panels" },
  labResults: { __name: "lab_results" },
  medications: { __name: "medications" },
  diagnoses: { __name: "diagnoses" },
  allergies: { __name: "allergies" },
}));

// ── Import after mocks ─────────────────────────────────────────
const { fhirGatewayRouter } = await import("../router.js");

beforeEach(() => {
  insertCalls.length = 0;
  insertMock.mockClear();
});

describe("importBundle audit logging", () => {
  it("writes a per-resource audit_log entry for each imported resource", async () => {
    const caller = fhirGatewayRouter.createCaller({});

    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Observation",
            id: "obs-1",
            status: "final",
            code: { text: "Heart rate" },
          },
        },
        {
          resource: {
            resourceType: "Observation",
            id: "obs-2",
            status: "final",
            code: { text: "Blood pressure" },
          },
        },
        {
          resource: {
            resourceType: "Condition",
            id: "cond-1",
            code: { text: "Hypertension" },
          },
        },
      ],
    };

    const result = await caller.importBundle({
      bundle,
      source_system: "epic-sandbox",
      user_id: "user-admin-42",
    });

    expect(result.imported).toBe(3);

    const auditRows = insertCalls
      .filter((c) => c.table === auditLogTable)
      .map((c) => c.row);

    expect(auditRows).toHaveLength(3);

    // Every audit row records the acting user and the fhir_import action.
    for (const row of auditRows) {
      expect(row.user_id).toBe("user-admin-42");
      expect(row.action).toBe("fhir_import");
      expect(row.id).toBeDefined();
      expect(row.timestamp).toBeDefined();
    }

    // Resource type / id pairs must match the bundle entries.
    const pairs = auditRows
      .map((r) => `${r.resource_type}:${r.resource_id}`)
      .sort();
    expect(pairs).toEqual(
      ["Condition:cond-1", "Observation:obs-1", "Observation:obs-2"].sort(),
    );

    // Details should capture the FHIR source context.
    for (const row of auditRows) {
      expect(typeof row.details).toBe("string");
      const details = JSON.parse(row.details as string) as Record<string, unknown>;
      expect(details.source).toBe("fhir_bundle");
      expect(details.source_system).toBe("epic-sandbox");
    }
  });

  it("writes one fhir_resources row and one audit_log row per entry (paired)", async () => {
    const caller = fhirGatewayRouter.createCaller({});

    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Observation",
            id: "obs-a",
            status: "final",
          },
        },
      ],
    };

    await caller.importBundle({
      bundle,
      source_system: "test-ehr",
      user_id: "user-1",
    });

    const fhirRows = insertCalls.filter((c) => c.table === fhirResourcesTable);
    const auditRows = insertCalls.filter((c) => c.table === auditLogTable);

    expect(fhirRows).toHaveLength(1);
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]!.row.resource_type).toBe("Observation");
    expect(auditRows[0]!.row.resource_id).toBe("obs-a");
  });
});

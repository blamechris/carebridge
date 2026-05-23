/**
 * Integration test (#337): import a bundle with a DiagnosticReport
 * (CBC) plus its three referenced Observation entries with
 * `materialize: true`, and verify the persisted `lab_panels` row
 * lands alongside one `lab_results` row per referenced Observation,
 * all linked via the same `panel_id`.
 *
 * Mirrors the import-bundle-materialize.test.ts harness pattern
 * shipped in #1066 — the in-memory mock captures every insert so we
 * can assert table + row pairs without touching a real Postgres.
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
const labPanelsTable = { __name: "lab_panels" };
const labResultsTable = { __name: "lab_results" };
const medicationsTable = { __name: "medications" };

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ insert: insertMock, transaction: transactionMock }),
  fhirResources: fhirResourcesTable,
  auditLog: auditLogTable,
  patients: { __name: "patients" },
  vitals: { __name: "vitals" },
  labPanels: labPanelsTable,
  labResults: labResultsTable,
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

describe("importBundle DiagnosticReport materialisation (#337)", () => {
  it("does NOT write a lab_panels row by default (materialize defaults to false)", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "DiagnosticReport",
            id: "dr-1",
            status: "final",
            code: { text: "CBC" },
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
    expect(result.materialized_lab_panels).toBe(0);
    expect(result.materialized_lab_results).toBe(0);
    expect(insertCalls.some((c) => c.table === labPanelsTable)).toBe(false);
    expect(insertCalls.some((c) => c.table === labResultsTable)).toBe(false);
  });

  it("materialises a CBC DiagnosticReport with three Observations into one panel + three result rows linked by panel_id", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          // The DiagnosticReport may appear BEFORE its child Observations
          // in the bundle. The router pre-indexes the bundle so order
          // doesn't matter.
          resource: {
            resourceType: "DiagnosticReport",
            id: "dr-cbc-1",
            status: "final",
            code: {
              coding: [
                { system: "http://loinc.org", code: "58410-2", display: "CBC panel" },
              ],
              text: "CBC",
            },
            subject: { reference: "Patient/p-1" },
            effectiveDateTime: "2026-05-22T08:00:00.000Z",
            issued: "2026-05-22T09:30:00.000Z",
            performer: [{ reference: "Practitioner/lab-tech-1" }],
            resultsInterpreter: [{ reference: "Practitioner/dr-smith" }],
            result: [
              { reference: "Observation/obs-wbc" },
              { reference: "Observation/obs-hgb" },
              { reference: "Observation/obs-plt" },
            ],
          },
        },
        {
          resource: {
            resourceType: "Observation",
            id: "obs-wbc",
            status: "final",
            code: {
              coding: [{ system: "http://loinc.org", code: "6690-2", display: "WBC" }],
              text: "WBC",
            },
            valueQuantity: { value: 7.5, unit: "10*3/uL" },
            referenceRange: [
              { low: { value: 4.5, unit: "10*3/uL" }, high: { value: 11, unit: "10*3/uL" } },
            ],
          },
        },
        {
          resource: {
            resourceType: "Observation",
            id: "obs-hgb",
            status: "final",
            code: {
              coding: [{ system: "http://loinc.org", code: "718-7", display: "Hemoglobin" }],
              text: "Hemoglobin",
            },
            valueQuantity: { value: 9.2, unit: "g/dL" },
            referenceRange: [
              { low: { value: 12, unit: "g/dL" }, high: { value: 16, unit: "g/dL" } },
            ],
            interpretation: [
              {
                coding: [
                  {
                    system: "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                    code: "L",
                  },
                ],
              },
            ],
          },
        },
        {
          resource: {
            resourceType: "Observation",
            id: "obs-plt",
            status: "final",
            code: {
              coding: [{ system: "http://loinc.org", code: "777-3", display: "Platelets" }],
              text: "Platelets",
            },
            valueQuantity: { value: 250, unit: "10*3/uL" },
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

    expect(result.imported).toBe(4);
    expect(result.materialized_lab_panels).toBe(1);
    expect(result.materialized_lab_results).toBe(3);

    const panelRows = insertCalls
      .filter((c) => c.table === labPanelsTable)
      .map((c) => c.row);
    expect(panelRows).toHaveLength(1);
    const panel = panelRows[0]!;
    expect(panel.patient_id).toBe("p-1");
    expect(panel.panel_name).toBe("CBC");
    // resultsInterpreter wins over performer for the ordering signal.
    expect(panel.ordered_by).toBe("dr-smith");
    expect(panel.ordering_provider_id).toBe("dr-smith");
    expect(panel.collected_at).toBe("2026-05-22T08:00:00.000Z");
    expect(panel.reported_at).toBe("2026-05-22T09:30:00.000Z");
    expect(panel.source_system).toBe("fhir_import");

    const resultRows = insertCalls
      .filter((c) => c.table === labResultsTable)
      .map((c) => c.row);
    expect(resultRows).toHaveLength(3);
    // Every child result must be linked to the parent panel.
    for (const r of resultRows) {
      expect(r.panel_id).toBe(panel.id);
    }
    const byName = Object.fromEntries(resultRows.map((r) => [r.test_name, r]));
    expect(byName.WBC).toMatchObject({
      test_code: "6690-2",
      value: 7.5,
      unit: "10*3/uL",
      reference_low: 4.5,
      reference_high: 11,
      flag: null,
    });
    expect(byName.Hemoglobin).toMatchObject({
      test_code: "718-7",
      value: 9.2,
      unit: "g/dL",
      reference_low: 12,
      reference_high: 16,
      flag: "L",
    });
    expect(byName.Platelets).toMatchObject({
      test_code: "777-3",
      value: 250,
      unit: "10*3/uL",
      reference_low: null,
      reference_high: null,
      flag: null,
    });
  });

  it("emits a panel with no child results when the DiagnosticReport.result[] refs don't resolve in the bundle", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "DiagnosticReport",
            id: "dr-isolated",
            status: "final",
            code: { text: "Lipid panel" },
            subject: { reference: "Patient/p-1" },
            // result[] references an Observation that's not in this
            // bundle — the panel should still land.
            result: [{ reference: "Observation/obs-not-in-bundle" }],
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
    expect(result.materialized_lab_panels).toBe(1);
    expect(result.materialized_lab_results).toBe(0);
    expect(insertCalls.filter((c) => c.table === labPanelsTable)).toHaveLength(1);
    expect(insertCalls.filter((c) => c.table === labResultsTable)).toHaveLength(0);
  });

  it("skips a DiagnosticReport with entered-in-error status (still imports raw FHIR)", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "DiagnosticReport",
            id: "dr-mistake",
            status: "entered-in-error",
            code: { text: "CBC" },
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
    expect(result.materialized_lab_panels).toBe(0);
    expect(result.materialized_lab_results).toBe(0);
    // Raw FHIR + audit_log rows still landed.
    expect(insertCalls.filter((c) => c.table === fhirResourcesTable)).toHaveLength(1);
    expect(insertCalls.filter((c) => c.table === auditLogTable)).toHaveLength(1);
    expect(insertCalls.filter((c) => c.table === labPanelsTable)).toHaveLength(0);
  });
});

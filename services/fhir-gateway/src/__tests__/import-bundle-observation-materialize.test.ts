/**
 * Integration test (#337): import a mixed bundle of vital-sign and
 * laboratory Observations with `materialize: true`, then verify both
 * tables receive the structured rows the rule engine consumes.
 *
 * The materialisation contract this test pins down:
 *   - Observation(category=vital-signs) → exactly one `vitals` row
 *     (panel-style BP collapses to a single row with value_secondary).
 *   - Observation(category=laboratory)  → one `lab_panels` row +
 *     one `lab_results` row (per-Observation panel — batching peer
 *     results under one panel is a follow-up).
 *   - Observation with no category falls through, raw FHIR persisted
 *     but neither vitals nor lab_results written.
 *   - status=entered-in-error is skipped by both mappers.
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
const vitalsTable = { __name: "vitals" };
const labPanelsTable = { __name: "lab_panels" };
const labResultsTable = { __name: "lab_results" };

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ insert: insertMock, transaction: transactionMock }),
  fhirResources: fhirResourcesTable,
  auditLog: auditLogTable,
  patients: { __name: "patients" },
  vitals: vitalsTable,
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

describe("importBundle Observation materialisation (#337)", () => {
  it("materialises a mixed bundle: vitals + lab_results land in their own tables", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        // Heart rate
        {
          resource: {
            resourceType: "Observation",
            id: "obs-hr",
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
            effectiveDateTime: "2026-05-22T10:00:00.000Z",
            valueQuantity: { value: 72, unit: "bpm", code: "/min" },
          },
        },
        // Blood pressure with component[]
        {
          resource: {
            resourceType: "Observation",
            id: "obs-bp",
            status: "final",
            category: [{ coding: [{ code: "vital-signs" }] }],
            code: {
              coding: [
                {
                  system: "http://loinc.org",
                  code: "85354-9",
                  display: "Blood pressure panel",
                },
              ],
            },
            subject: { reference: "Patient/p-1" },
            effectiveDateTime: "2026-05-22T10:01:00.000Z",
            component: [
              {
                code: {
                  coding: [
                    { system: "http://loinc.org", code: "8480-6" },
                  ],
                },
                valueQuantity: { value: 122, unit: "mmHg" },
              },
              {
                code: {
                  coding: [
                    { system: "http://loinc.org", code: "8462-4" },
                  ],
                },
                valueQuantity: { value: 78, unit: "mmHg" },
              },
            ],
          },
        },
        // Glucose lab result with reference range and H flag
        {
          resource: {
            resourceType: "Observation",
            id: "obs-glu",
            status: "final",
            category: [{ coding: [{ code: "laboratory" }] }],
            code: {
              coding: [
                {
                  system: "http://loinc.org",
                  code: "2339-0",
                  display: "Glucose",
                },
              ],
              text: "Glucose",
            },
            subject: { reference: "Patient/p-1" },
            effectiveDateTime: "2026-05-22T10:05:00.000Z",
            valueQuantity: { value: 145, unit: "mg/dL" },
            referenceRange: [
              {
                low: { value: 70, unit: "mg/dL" },
                high: { value: 100, unit: "mg/dL" },
              },
            ],
            interpretation: [
              {
                coding: [
                  {
                    system:
                      "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                    code: "H",
                  },
                ],
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

    expect(result.imported).toBe(3);
    expect(result.materialized_vitals).toBe(2);
    expect(result.materialized_lab_results).toBe(1);

    // ── vitals assertions ───────────────────────────────────
    const vitalRows = insertCalls
      .filter((c) => c.table === vitalsTable)
      .map((c) => c.row);
    expect(vitalRows).toHaveLength(2);

    const hr = vitalRows.find((r) => r.type === "heart_rate")!;
    expect(hr).toBeDefined();
    expect(hr.patient_id).toBe("p-1");
    expect(hr.loinc_code).toBe("8867-4");
    expect(hr.value_primary).toBe(72);
    expect(hr.value_secondary).toBeNull();
    expect(hr.unit).toBe("bpm");
    expect(hr.recorded_at).toBe("2026-05-22T10:00:00.000Z");
    expect(hr.source_system).toBe("fhir_import");

    const bp = vitalRows.find((r) => r.type === "blood_pressure")!;
    expect(bp).toBeDefined();
    expect(bp.value_primary).toBe(122);
    expect(bp.value_secondary).toBe(78);
    expect(bp.unit).toBe("mmHg");

    // ── lab_results + lab_panels assertions ─────────────────
    const labRows = insertCalls
      .filter((c) => c.table === labResultsTable)
      .map((c) => c.row);
    const panelRows = insertCalls
      .filter((c) => c.table === labPanelsTable)
      .map((c) => c.row);
    expect(labRows).toHaveLength(1);
    expect(panelRows).toHaveLength(1);

    const labRow = labRows[0]!;
    const panelRow = panelRows[0]!;
    expect(labRow.test_name).toBe("Glucose");
    expect(labRow.test_code).toBe("2339-0");
    expect(labRow.value).toBe(145);
    expect(labRow.unit).toBe("mg/dL");
    expect(labRow.reference_low).toBe(70);
    expect(labRow.reference_high).toBe(100);
    expect(labRow.flag).toBe("H");
    // panel_id must thread through from the sidecar lab_panels row
    expect(labRow.panel_id).toBe(panelRow.id);
    expect(panelRow.patient_id).toBe("p-1");
    expect(panelRow.panel_name).toBe("Glucose");
    expect(panelRow.collected_at).toBe("2026-05-22T10:05:00.000Z");

    // No medications row should have been written.
    expect(
      insertCalls.filter((c) => c.table === medicationsTable),
    ).toHaveLength(0);
  });

  it("skips Observations without a recognised category (raw FHIR still persisted)", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Observation",
            id: "obs-no-cat",
            status: "final",
            // No category[]
            code: {
              coding: [{ system: "http://loinc.org", code: "8867-4" }],
            },
            effectiveDateTime: "2026-05-22T10:00:00.000Z",
            valueQuantity: { value: 72, unit: "bpm" },
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
    expect(result.materialized_vitals).toBe(0);
    expect(result.materialized_lab_results).toBe(0);
    expect(
      insertCalls.filter((c) => c.table === fhirResourcesTable),
    ).toHaveLength(1);
    expect(insertCalls.filter((c) => c.table === vitalsTable)).toHaveLength(0);
    expect(insertCalls.filter((c) => c.table === labResultsTable)).toHaveLength(
      0,
    );
  });

  it("skips entered-in-error Observations from materialisation but still imports raw", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Observation",
            id: "obs-err",
            status: "entered-in-error",
            category: [{ coding: [{ code: "vital-signs" }] }],
            code: {
              coding: [{ system: "http://loinc.org", code: "8867-4" }],
            },
            effectiveDateTime: "2026-05-22T10:00:00.000Z",
            valueQuantity: { value: 72, unit: "bpm" },
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
    expect(result.materialized_vitals).toBe(0);
    expect(insertCalls.filter((c) => c.table === vitalsTable)).toHaveLength(0);
    expect(
      insertCalls.filter((c) => c.table === fhirResourcesTable),
    ).toHaveLength(1);
  });

  it("does NOT materialise Observations by default (materialize defaults to false)", async () => {
    const caller = fhirGatewayRouter.createCaller(adminCtx);
    const bundle = {
      resourceType: "Bundle" as const,
      type: "collection" as const,
      entry: [
        {
          resource: {
            resourceType: "Observation",
            id: "obs-hr",
            status: "final",
            category: [{ coding: [{ code: "vital-signs" }] }],
            code: {
              coding: [{ system: "http://loinc.org", code: "8867-4" }],
            },
            effectiveDateTime: "2026-05-22T10:00:00.000Z",
            valueQuantity: { value: 72, unit: "bpm" },
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
    expect(result.materialized_vitals).toBe(0);
    expect(result.materialized_lab_results).toBe(0);
    expect(insertCalls.filter((c) => c.table === vitalsTable)).toHaveLength(0);
  });
});

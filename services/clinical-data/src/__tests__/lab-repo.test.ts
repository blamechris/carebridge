import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
const insertValuesMock = vi.fn().mockResolvedValue(undefined);
const insertMock = vi.fn(() => ({ values: insertValuesMock }));

const selectFromWhereMock = vi.fn().mockResolvedValue([]);
const selectFromMock = vi.fn(() => ({
  where: selectFromWhereMock,
  orderBy: vi.fn().mockReturnValue({
    where: selectFromWhereMock,
  }),
}));
const selectMock = vi.fn(() => ({ from: selectFromMock }));

const txInsertValuesMock = vi.fn().mockResolvedValue(undefined);
const txInsertMock = vi.fn(() => ({ values: txInsertValuesMock }));
const transactionMock = vi.fn(async (cb: (tx: unknown) => Promise<void>) => {
  await cb({ insert: txInsertMock });
});

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({
    insert: insertMock,
    select: selectMock,
    transaction: transactionMock,
  }),
  labPanels: { patient_id: "patient_id", collected_at: "collected_at" },
  labResults: { panel_id: "panel_id" },
}));

// ── Mock events ──────────────────────────────────────────────────
const emitClinicalEvent = vi.fn().mockResolvedValue(undefined);
vi.mock("../events.js", () => ({ emitClinicalEvent }));

// ── Import after mocks ──────────────────────────────────────────
const { createLabPanel, getLabPanelsByPatient } = await import(
  "../repositories/lab-repo.js"
);

const PATIENT_ID = "22222222-2222-2222-2222-222222222222";

const sampleLabInput = {
  patient_id: PATIENT_ID,
  panel_name: "CBC",
  ordered_by: "Dr. Smith",
  collected_at: "2026-03-15T08:00:00.000Z",
  results: [
    {
      test_name: "WBC",
      test_code: "6690-2",
      value: 7.5,
      unit: "10^3/uL",
      reference_low: 4.0,
      reference_high: 11.0,
    },
    {
      test_name: "RBC",
      test_code: "789-8",
      value: 4.8,
      unit: "10^6/uL",
      reference_low: 4.2,
      reference_high: 5.9,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createLabPanel", () => {
  it("inserts panel and results in a transaction", async () => {
    const result = await createLabPanel(sampleLabInput);

    expect(transactionMock).toHaveBeenCalledOnce();
    // Two inserts in the transaction: one for panel, one for results
    expect(txInsertMock).toHaveBeenCalledTimes(2);

    expect(result.panel).toMatchObject({
      patient_id: PATIENT_ID,
      panel_name: "CBC",
      ordered_by: "Dr. Smith",
    });
    expect(result.panel.id).toBeDefined();
    expect(result.panel.created_at).toBeDefined();
  });

  it("returns the correct number of results", async () => {
    const result = await createLabPanel(sampleLabInput);

    expect(result.results).toHaveLength(2);
    expect(result.results[0]).toMatchObject({
      test_name: "WBC",
      value: 7.5,
      unit: "10^3/uL",
    });
    expect(result.results[1]).toMatchObject({
      test_name: "RBC",
      value: 4.8,
      unit: "10^6/uL",
    });
  });

  it("emits lab.resulted event with correct shape", async () => {
    const result = await createLabPanel(sampleLabInput);

    expect(emitClinicalEvent).toHaveBeenCalledOnce();
    const emittedEvent = emitClinicalEvent.mock.calls[0][0];
    expect(emittedEvent).toMatchObject({
      type: "lab.resulted",
      patient_id: PATIENT_ID,
      data: {
        resourceId: result.panel.id,
        panelName: "CBC",
        resultCount: 2,
      },
    });
  });

  it("rejects a panel when a result has an invalid unit", async () => {
    await expect(
      createLabPanel({
        patient_id: PATIENT_ID,
        panel_name: "BMP",
        results: [
          {
            test_name: "Glucose",
            test_code: "2345-7",
            value: 200,
            unit: "mmol/L",
          },
        ],
      }),
    ).rejects.toThrow(/Lab panel validation failed.*Glucose unit "mmol\/L" is not accepted/);

    // No transaction should have been started
    expect(transactionMock).not.toHaveBeenCalled();
  });

  it("rejects the entire panel when some results are valid and others invalid (all-or-nothing)", async () => {
    await expect(
      createLabPanel({
        patient_id: PATIENT_ID,
        panel_name: "Mixed Panel",
        results: [
          {
            test_name: "WBC",
            test_code: "6690-2",
            value: 7.5,
            unit: "K/uL",
          },
          {
            test_name: "Hemoglobin",
            test_code: "718-7",
            value: 14.0,
            unit: "g/dL",
          },
          {
            test_name: "Glucose",
            test_code: "2345-7",
            value: 95,
            unit: "mmol/L",
          },
        ],
      }),
    ).rejects.toThrow(/Lab panel validation failed.*Glucose unit "mmol\/L" is not accepted/);

    // The transaction must never have been started — no partial inserts
    expect(transactionMock).not.toHaveBeenCalled();

    // No clinical event should have been emitted for the failed panel
    expect(emitClinicalEvent).not.toHaveBeenCalled();
  });

  it("attaches validation warnings to the emitted clinical event", async () => {
    await createLabPanel({
      patient_id: PATIENT_ID,
      panel_name: "BMP",
      results: [
        {
          test_name: "Glucose",
          test_code: "2345-7",
          value: 350,
          unit: "mg/dL",
        },
      ],
    });

    const emittedEvent = emitClinicalEvent.mock.calls[0][0];
    expect(emittedEvent.data.validationWarnings).toBeDefined();
    expect(emittedEvent.data.validationWarnings).toEqual(
      expect.arrayContaining([expect.stringContaining("above typical range")]),
    );
  });
});

describe("getLabPanelsByPatient", () => {
  it("returns panels with results for the patient", async () => {
    const mockPanelRow = {
      id: "panel-1",
      patient_id: PATIENT_ID,
      panel_name: "CBC",
      ordered_by: "Dr. Smith",
      collected_at: "2026-03-15T08:00:00.000Z",
      reported_at: null,
      notes: null,
      ordering_provider_id: null,
      encounter_id: null,
      source_system: null,
      created_at: "2026-03-15T08:00:00.000Z",
    };

    const mockResultRow = {
      id: "result-1",
      panel_id: "panel-1",
      test_name: "WBC",
      test_code: "6690-2",
      value: 7.5,
      unit: "10^3/uL",
      reference_low: 4.0,
      reference_high: 11.0,
      flag: null,
      notes: null,
      created_at: "2026-03-15T08:00:00.000Z",
    };

    // First call: select panels (with orderBy)
    selectFromMock.mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue([mockPanelRow]),
      }),
      orderBy: vi.fn(),
    });
    // Second call: select results for panel-1
    selectFromMock.mockReturnValueOnce({
      where: vi.fn().mockResolvedValue([mockResultRow]),
      orderBy: vi.fn(),
    });

    const results = await getLabPanelsByPatient(PATIENT_ID);

    expect(results).toHaveLength(1);
    expect(results[0].panel.panel_name).toBe("CBC");
    expect(results[0].results).toHaveLength(1);
    expect(results[0].results[0].test_name).toBe("WBC");
  });
});

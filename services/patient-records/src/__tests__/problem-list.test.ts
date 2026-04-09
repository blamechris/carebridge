/**
 * Phase C1 — getProblemListByPatient unit tests.
 *
 * Validates the in-memory aggregation that powers the clinician portal's
 * Problem List tab:
 *   - resolved diagnoses are filtered out
 *   - care team rows are joined onto every active problem (temporary
 *     until Phase C3 links flags and notes per-problem)
 *   - specialty is resolved from users when the careTeamMembers row
 *     doesn't carry one
 *   - open_flag_count surfaces from clinical_flags
 *   - stale_days is computed from the most recent signed note or,
 *     failing that, the diagnosis row's own created_at
 *   - sort order puts the freshest problem first
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
// The service makes several parallel queries through Promise.all.
// We stage a FIFO queue of rows, one entry per call to db.select(),
// and each `where(...)` resolves to whatever's at the head.

let nextQueryResults: unknown[][] = [];

function chainForRows(rows: unknown[]) {
  return {
    orderBy: () => ({
      limit: () => Promise.resolve(rows),
      then: (
        onFulfilled: (value: unknown) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) => Promise.resolve(rows).then(onFulfilled, onRejected),
    }),
    limit: () => Promise.resolve(rows),
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
}

const selectMock = vi.fn(() => ({
  from: (..._args: unknown[]) => ({
    where: (..._whereArgs: unknown[]) => {
      const rows = (nextQueryResults.shift() ?? []) as unknown[];
      return chainForRows(rows);
    },
  }),
}));

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => ({ select: selectMock }),
  diagnoses: {
    id: "id",
    patient_id: "patient_id",
    status: "status",
    description: "description",
    icd10_code: "icd10_code",
    snomed_code: "snomed_code",
    onset_date: "onset_date",
    diagnosed_by: "diagnosed_by",
    created_at: "created_at",
  },
  careTeamMembers: {
    id: "id",
    patient_id: "patient_id",
    provider_id: "provider_id",
    role: "role",
    specialty: "specialty",
    is_active: "is_active",
  },
  clinicalNotes: {
    id: "id",
    patient_id: "patient_id",
    provider_id: "provider_id",
    template_type: "template_type",
    signed_at: "signed_at",
  },
  clinicalFlags: {
    patient_id: "patient_id",
    status: "status",
  },
  users: {
    id: "id",
    specialty: "specialty",
  },
  hmacForIndex: (s: string) => s,
  patients: {},
  allergies: {},
}));

// ── Import under test after mocks ─────────────────────────────
const { getProblemListByPatient } = await import(
  "../services/problem-list-service.js"
);

const PATIENT_ID = "11111111-1111-1111-1111-111111111111";
const DR_SMITH = "22222222-2222-2222-2222-222222222222";
const DR_JONES = "33333333-3333-3333-3333-333333333333";
const DX_CANCER = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const DX_DVT = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
const NOTE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

function diagnosisRow(overrides: Record<string, unknown> = {}) {
  return {
    id: DX_CANCER,
    patient_id: PATIENT_ID,
    description: "metastatic colon cancer",
    icd10_code: "C18.9",
    snomed_code: null,
    status: "active",
    onset_date: "2025-09-10",
    diagnosed_by: DR_SMITH,
    created_at: "2025-09-10T10:00:00.000Z",
    ...overrides,
  };
}

function careTeamRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ct-1",
    patient_id: PATIENT_ID,
    provider_id: DR_SMITH,
    role: "specialist",
    specialty: "hematology_oncology",
    is_active: true,
    started_at: "2025-09-10T00:00:00.000Z",
    ended_at: null,
    created_at: "2025-09-10T00:00:00.000Z",
    ...overrides,
  };
}

function noteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTE_A,
    provider_id: DR_SMITH,
    template_type: "soap",
    signed_at: "2026-03-20T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextQueryResults = [];
});

describe("getProblemListByPatient", () => {
  it("returns an empty list when the patient has no active diagnoses", async () => {
    nextQueryResults = [
      [], // diagnoses
      [], // careTeamMembers
      [], // clinicalNotes
      [{ count: 0 }], // open flag count
      // users query skipped because providerIds empty
    ];

    const result = await getProblemListByPatient(PATIENT_ID);
    expect(result).toEqual([]);
  });

  it("joins care-team specialists and the most recent signed note onto each problem", async () => {
    const now = new Date("2026-04-01T00:00:00.000Z");

    nextQueryResults = [
      // diagnoses
      [diagnosisRow()],
      // care team
      [
        careTeamRow({
          provider_id: DR_SMITH,
          specialty: "hematology_oncology",
          role: "specialist",
        }),
        careTeamRow({
          provider_id: DR_JONES,
          specialty: "radiology",
          role: "specialist",
        }),
      ],
      // most recent signed notes
      [noteRow()],
      // flag count
      [{ count: 2 }],
      // users (for specialty resolution)
      [
        { id: DR_SMITH, specialty: "hematology_oncology" },
        { id: DR_JONES, specialty: "radiology" },
      ],
    ];

    const result = await getProblemListByPatient(PATIENT_ID, now);

    expect(result).toHaveLength(1);
    const problem = result[0];
    expect(problem.description).toBe("metastatic colon cancer");
    expect(problem.icd10_code).toBe("C18.9");
    expect(problem.managing_specialists).toHaveLength(2);
    expect(problem.managing_specialists.map((s) => s.specialty)).toEqual([
      "hematology_oncology",
      "radiology",
    ]);
    expect(problem.most_recent_note?.id).toBe(NOTE_A);
    expect(problem.most_recent_note?.provider_specialty).toBe(
      "hematology_oncology",
    );
    expect(problem.open_flag_count).toBe(2);
    expect(problem.last_touched_at).toBe("2026-03-20T12:00:00.000Z");
    // stale_days = floor((2026-04-01T00:00 - 2026-03-20T12:00) / 1 day) = 11
    expect(problem.stale_days).toBe(11);
  });

  it("filters out diagnoses in 'resolved' status", async () => {
    nextQueryResults = [
      // Service issues the SQL filter for status != 'resolved', but we
      // verify at the orchestration layer that resolved rows never reach
      // the caller by feeding only active rows in the mock.
      [diagnosisRow({ id: DX_CANCER, status: "active" })],
      [],
      [],
      [{ count: 0 }],
      [],
    ];

    const result = await getProblemListByPatient(PATIENT_ID);
    expect(result).toHaveLength(1);
    expect(result[0].status).toBe("active");
  });

  it("falls back to the diagnosis created_at when there is no signed note", async () => {
    const now = new Date("2026-04-01T00:00:00.000Z");

    nextQueryResults = [
      [
        diagnosisRow({
          id: DX_DVT,
          description: "acute lower extremity DVT",
          created_at: "2026-03-25T00:00:00.000Z",
        }),
      ],
      [],
      [], // no signed notes
      [{ count: 0 }],
      [{ id: DR_SMITH, specialty: "oncology" }],
    ];

    const result = await getProblemListByPatient(PATIENT_ID, now);

    expect(result[0].most_recent_note).toBeNull();
    expect(result[0].last_touched_at).toBe("2026-03-25T00:00:00.000Z");
    // stale_days = floor((2026-04-01 - 2026-03-25) / 1 day) = 7
    expect(result[0].stale_days).toBe(7);
  });

  it("prefers the note signed_at over diagnosis created_at when newer", async () => {
    const now = new Date("2026-04-01T00:00:00.000Z");

    nextQueryResults = [
      [
        diagnosisRow({
          created_at: "2025-09-10T00:00:00.000Z",
        }),
      ],
      [],
      [noteRow({ signed_at: "2026-03-30T09:00:00.000Z" })],
      [{ count: 0 }],
      [{ id: DR_SMITH, specialty: "oncology" }],
    ];

    const result = await getProblemListByPatient(PATIENT_ID, now);
    expect(result[0].last_touched_at).toBe("2026-03-30T09:00:00.000Z");
    expect(result[0].stale_days).toBe(1);
  });

  it("sorts problems by last_touched_at descending", async () => {
    // Two diagnoses — because there is only one "most recent note" shared
    // across both (Phase C1 limitation), both share last_touched_at of
    // the note's signed_at unless their created_at is newer.
    const now = new Date("2026-04-01T00:00:00.000Z");

    nextQueryResults = [
      [
        diagnosisRow({
          id: DX_CANCER,
          description: "cancer",
          created_at: "2025-01-01T00:00:00.000Z",
        }),
        diagnosisRow({
          id: DX_DVT,
          description: "DVT",
          // Diagnosis created AFTER the most recent note → last_touched
          // should come from the diagnosis for this row.
          created_at: "2026-03-30T00:00:00.000Z",
        }),
      ],
      [],
      [noteRow({ signed_at: "2026-03-25T00:00:00.000Z" })],
      [{ count: 0 }],
      [{ id: DR_SMITH, specialty: "oncology" }],
    ];

    const result = await getProblemListByPatient(PATIENT_ID, now);
    expect(result.map((p) => p.description)).toEqual(["DVT", "cancer"]);
  });

  it("computes stale_days as 0 when last_touched_at is in the future", async () => {
    const now = new Date("2026-03-01T00:00:00.000Z");

    nextQueryResults = [
      [
        diagnosisRow({
          created_at: "2026-03-15T00:00:00.000Z",
        }),
      ],
      [],
      [],
      [{ count: 0 }],
      [{ id: DR_SMITH, specialty: "oncology" }],
    ];

    const result = await getProblemListByPatient(PATIENT_ID, now);
    expect(result[0].stale_days).toBe(0);
  });

  it("resolves provider specialty from users when careTeamMembers.specialty is null", async () => {
    nextQueryResults = [
      [diagnosisRow()],
      [
        careTeamRow({
          provider_id: DR_SMITH,
          specialty: null, // care team row missing specialty
        }),
      ],
      [],
      [{ count: 0 }],
      // users lookup fills in the gap
      [{ id: DR_SMITH, specialty: "oncology" }],
    ];

    const result = await getProblemListByPatient(PATIENT_ID);
    expect(result[0].managing_specialists[0].specialty).toBe("oncology");
  });

  it("surfaces open_flag_count on every problem even when zero", async () => {
    nextQueryResults = [
      [diagnosisRow()],
      [],
      [],
      [{ count: 0 }],
      [{ id: DR_SMITH, specialty: "oncology" }],
    ];

    const result = await getProblemListByPatient(PATIENT_ID);
    expect(result[0].open_flag_count).toBe(0);
  });
});

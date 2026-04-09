/**
 * Phase C2 — getTimelineByPatient unit tests.
 *
 * Exercises the lean projection the clinician portal's "All Notes" tab
 * relies on: provider name/specialty resolution, Phase A1 assertion
 * previews, and sort ordering that puts the freshest signed note first.
 *
 * The Drizzle query chain is mocked per-test to return deterministic rows.
 * We verify the function's join / flatten logic, not DB semantics.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ──────────────────────────────────────────────────────
// Drizzle chain semantics we need to emulate:
//   - `db.select({...}).from(...).where(...).orderBy(...)` → Promise<rows>
//   - `db.select({...}).from(...).where(...)` → Promise<rows> (thenable)
//
// We represent each query result with a "thenable chain" object that
// resolves to the staged rows AND exposes a terminal `.orderBy(...)`
// method which resolves to the same staged rows. The calling code in
// getTimelineByPatient decides whether to chain orderBy or not; both
// paths return the rows we set via `nextQueryResults`.
//
// Each call to `db.select()` pops the next staged result from the queue.

let nextQueryResults: unknown[][] = [];

function chainForRows(rows: unknown[]) {
  const chain: Record<string, unknown> = {
    orderBy: () => Promise.resolve(rows),
    // Thenable so `await chain` resolves to rows even without orderBy.
    then: (
      onFulfilled: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(onFulfilled, onRejected),
  };
  return chain;
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
  clinicalNotes: {
    id: "id",
    patient_id: "patient_id",
    provider_id: "provider_id",
    template_type: "template_type",
    status: "status",
    version: "version",
    signed_at: "signed_at",
    cosigned_at: "cosigned_at",
    created_at: "created_at",
    copy_forward_score: "copy_forward_score",
  },
  noteVersions: {
    id: "id",
    note_id: "note_id",
    version: "version",
    sections: "sections",
    saved_at: "saved_at",
    saved_by: "saved_by",
  },
  noteAssertions: {
    note_id: "note_id",
    patient_id: "patient_id",
    payload: "payload",
    extraction_status: "extraction_status",
    created_at: "created_at",
  },
  users: {
    id: "id",
    name: "name",
    specialty: "specialty",
  },
}));

// ── Mock events (not exercised here but the module imports it) ──
vi.mock("../events.js", () => ({
  emitClinicalEvent: vi.fn().mockResolvedValue(undefined),
}));

// ── Import under test after mocks ─────────────────────────────
const { getTimelineByPatient } = await import(
  "../services/note-service.js"
);

const PATIENT_ID = "11111111-1111-1111-1111-111111111111";
const DR_SMITH = "22222222-2222-2222-2222-222222222222";
const DR_JONES = "33333333-3333-3333-3333-333333333333";
const NOTE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const NOTE_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const NOTE_C = "cccccccc-cccc-cccc-cccc-cccccccccccc";

function buildNoteRow(overrides: Record<string, unknown> = {}) {
  return {
    id: NOTE_A,
    patient_id: PATIENT_ID,
    provider_id: DR_SMITH,
    template_type: "soap",
    status: "signed",
    version: 1,
    signed_at: "2026-03-20T12:00:00.000Z",
    cosigned_at: null,
    created_at: "2026-03-20T11:00:00.000Z",
    copy_forward_score: null,
    ...overrides,
  };
}

function buildPayload(overrides: Record<string, unknown> = {}) {
  return {
    symptoms_reported: [],
    symptoms_denied: [],
    assessments: [],
    plan_items: [],
    referenced_results: [],
    one_line_summary: "",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  nextQueryResults = [];
});

function stage(results: unknown[][]): void {
  nextQueryResults = results;
}

describe("getTimelineByPatient", () => {
  it("returns an empty array when the patient has no notes", async () => {
    nextQueryResults = [
      [], // clinicalNotes select returns no rows
    ];

    const result = await getTimelineByPatient(PATIENT_ID);

    expect(result).toEqual([]);
  });

  it("populates provider_name and provider_specialty from the users join", async () => {
    nextQueryResults = [
      // clinicalNotes rows
      [buildNoteRow()],
      // users rows
      [
        {
          id: DR_SMITH,
          name: "Dr. Smith",
          specialty: "hematology_oncology",
        },
      ],
      // noteAssertions rows
      [],
    ];

    const result = await getTimelineByPatient(PATIENT_ID);

    expect(result).toHaveLength(1);
    expect(result[0].provider_name).toBe("Dr. Smith");
    expect(result[0].provider_specialty).toBe("hematology_oncology");
    expect(result[0].assertion_preview).toBeNull();
  });

  it("projects assertion previews from the freshest successful extraction", async () => {
    nextQueryResults = [
      [buildNoteRow({ id: NOTE_A })],
      [{ id: DR_SMITH, name: "Dr. Smith", specialty: "oncology" }],
      [
        {
          note_id: NOTE_A,
          payload: buildPayload({
            one_line_summary: "New headache in known DVT patient",
            assessments: [
              {
                problem: "headache",
                status: "new",
                evidence_quote: "reports HA x3d",
              },
              {
                problem: "lower extremity DVT",
                status: "stable",
                evidence_quote: "on rivaroxaban",
              },
              {
                problem: "metastatic colon ca",
                status: "stable",
                evidence_quote: null,
              },
              {
                problem: "extra problem 4",
                status: "stable",
                evidence_quote: null,
              },
            ],
            plan_items: [
              {
                action: "obtain non-contrast head CT",
                target_followup: null,
                ordered_by_specialty: "oncology",
                evidence_quote: null,
              },
              {
                action: "continue rivaroxaban",
                target_followup: null,
                ordered_by_specialty: null,
                evidence_quote: null,
              },
            ],
          }),
          created_at: "2026-03-20T12:05:00.000Z",
        },
      ],
    ];

    const result = await getTimelineByPatient(PATIENT_ID);

    expect(result).toHaveLength(1);
    expect(result[0].assertion_preview).not.toBeNull();
    expect(result[0].assertion_preview?.one_line_summary).toBe(
      "New headache in known DVT patient",
    );
    expect(result[0].assertion_preview?.assessment_problems).toEqual([
      "headache",
      "lower extremity DVT",
      "metastatic colon ca",
    ]);
    expect(result[0].assertion_preview?.top_plan_actions).toEqual([
      "obtain non-contrast head CT",
      "continue rivaroxaban",
    ]);
  });

  it("caps assertion preview lists at three items each", async () => {
    const assessments = Array.from({ length: 6 }, (_, i) => ({
      problem: `problem ${i}`,
      status: "stable" as const,
      evidence_quote: null,
    }));
    const planItems = Array.from({ length: 8 }, (_, i) => ({
      action: `action ${i}`,
      target_followup: null,
      ordered_by_specialty: null,
      evidence_quote: null,
    }));

    nextQueryResults = [
      [buildNoteRow()],
      [{ id: DR_SMITH, name: "Dr. Smith", specialty: "oncology" }],
      [
        {
          note_id: NOTE_A,
          payload: buildPayload({ assessments, plan_items: planItems }),
          created_at: "2026-03-20T12:00:00.000Z",
        },
      ],
    ];

    const result = await getTimelineByPatient(PATIENT_ID);

    expect(result[0].assertion_preview?.assessment_problems).toHaveLength(3);
    expect(result[0].assertion_preview?.top_plan_actions).toHaveLength(3);
  });

  it("keeps only the freshest assertion row per note when duplicates exist", async () => {
    nextQueryResults = [
      [buildNoteRow({ id: NOTE_A })],
      [{ id: DR_SMITH, name: "Dr. Smith", specialty: "oncology" }],
      // noteAssertions — sorted desc by created_at, so newer first
      [
        {
          note_id: NOTE_A,
          payload: buildPayload({ one_line_summary: "latest" }),
          created_at: "2026-03-21T00:00:00.000Z",
        },
        {
          note_id: NOTE_A,
          payload: buildPayload({ one_line_summary: "stale" }),
          created_at: "2026-03-20T00:00:00.000Z",
        },
      ],
    ];

    const result = await getTimelineByPatient(PATIENT_ID);
    expect(result[0].assertion_preview?.one_line_summary).toBe("latest");
  });

  it("sorts freshest signed note first across multiple entries", async () => {
    nextQueryResults = [
      // Notes — unordered on purpose to verify the in-memory secondary sort.
      [
        buildNoteRow({
          id: NOTE_A,
          signed_at: "2026-03-20T12:00:00.000Z",
          created_at: "2026-03-20T11:00:00.000Z",
          provider_id: DR_SMITH,
        }),
        buildNoteRow({
          id: NOTE_B,
          signed_at: "2026-03-22T09:00:00.000Z",
          created_at: "2026-03-22T08:00:00.000Z",
          provider_id: DR_JONES,
          template_type: "progress",
        }),
        buildNoteRow({
          id: NOTE_C,
          signed_at: null,
          created_at: "2026-03-23T06:00:00.000Z",
          provider_id: DR_SMITH,
          status: "draft",
        }),
      ],
      [
        { id: DR_SMITH, name: "Dr. Smith", specialty: "oncology" },
        { id: DR_JONES, name: "Dr. Jones", specialty: "radiology" },
      ],
      [],
    ];

    const result = await getTimelineByPatient(PATIENT_ID);

    expect(result.map((r) => r.id)).toEqual([NOTE_C, NOTE_B, NOTE_A]);
  });

  it("resolves null provider_specialty when the user row is missing", async () => {
    nextQueryResults = [
      [buildNoteRow({ provider_id: "ghost-provider" })],
      [], // no user row for ghost-provider
      [],
    ];

    const result = await getTimelineByPatient(PATIENT_ID);
    expect(result[0].provider_name).toBeNull();
    expect(result[0].provider_specialty).toBeNull();
  });

  it("normalizes copy_forward_score null vs numeric", async () => {
    nextQueryResults = [
      [
        buildNoteRow({ id: NOTE_A, copy_forward_score: null }),
        buildNoteRow({
          id: NOTE_B,
          copy_forward_score: 82,
          signed_at: "2026-03-21T12:00:00.000Z",
          created_at: "2026-03-21T11:00:00.000Z",
        }),
      ],
      [{ id: DR_SMITH, name: "Dr. Smith", specialty: "oncology" }],
      [],
    ];

    const result = await getTimelineByPatient(PATIENT_ID);
    const byId = new Map(result.map((e) => [e.id, e]));
    expect(byId.get(NOTE_A)?.copy_forward_score).toBeNull();
    expect(byId.get(NOTE_B)?.copy_forward_score).toBe(82);
  });
});

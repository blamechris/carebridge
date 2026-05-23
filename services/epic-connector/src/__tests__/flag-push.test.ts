/**
 * Tests for the outbound flag-push orchestrator (#393).
 *
 * Mocks @carebridge/db-schema so no Postgres is required. Verifies:
 *   - POST when epic_flag_id is unset (create path)
 *   - PUT when epic_flag_id is already set (update path)
 *   - skipped when patient has no Epic mapping
 *   - audit_log row written on success AND on failure
 *   - clinical_flags row updated with epic_flag_id + push timestamp
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMockDb, type MockDb } from "@carebridge/test-utils";

let db: MockDb;

vi.mock("@carebridge/db-schema", () => ({
  getDb: () => db,
  clinicalFlags: { id: "id" },
  patients: {},
  auditLog: {},
  fhirResources: {
    internal_record_id: "internal_record_id",
    resource_type: "resource_type",
    resource_id: "resource_id",
  },
}));

const { pushFlagToEpic, pushFlagStatusUpdate } = await import(
  "../outbound/flag-push.js"
);

const FLAG = {
  id: "flag-1",
  patient_id: "patient-1",
  summary: "summary text",
  rationale: "rationale text",
  suggested_action: "suggested action",
  severity: "critical",
  category: "cross-specialty",
  status: "open",
  rule_id: "ONCO-VTE-NEURO-001",
  created_at: "2026-05-22T10:00:00Z",
  resolved_at: null,
  dismissed_at: null,
  epic_flag_id: null,
};

function fakeClient() {
  return {
    createResource: vi
      .fn()
      .mockResolvedValue({ resourceType: "Flag", id: "epic-flag-99" }),
    updateResource: vi
      .fn()
      .mockResolvedValue({ resourceType: "Flag", id: "epic-flag-99" }),
  } as unknown as Parameters<typeof pushFlagToEpic>[1]["client"];
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createMockDb();
});

describe("pushFlagToEpic (#393)", () => {
  it("creates a Flag on Epic when epic_flag_id is unset, then records the id", async () => {
    db.willSelect([FLAG]); // load flag
    db.willSelect([{ resource_id: "epic-patient-1" }]); // patient mapping lookup
    db.willUpdate(); // clinical_flags update
    db.willInsert(); // audit_log insert
    const client = fakeClient();

    const result = await pushFlagToEpic("flag-1", { client });

    expect(result).toMatchObject({
      flag_id: "flag-1",
      epic_flag_id: "epic-flag-99",
      operation: "created",
    });
    expect(client.createResource).toHaveBeenCalledOnce();
    const [resourceType, body] = (client.createResource as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(resourceType).toBe("Flag");
    expect(body.resourceType).toBe("Flag");
    expect(body.subject.reference).toBe("Patient/epic-patient-1");

    // updated clinical_flags row, inserted audit_log
    expect(db.update).toHaveBeenCalledOnce();
    expect(db.insert).toHaveBeenCalledOnce();
    const auditValues = db.insert.calls[0]!.chainArgs[0]![0] as Record<string, unknown>;
    expect(auditValues.action).toBe("epic_flag_push");
    expect(auditValues.success).toBe(true);
  });

  it("updates an existing Flag on Epic (PUT) when epic_flag_id is already set", async () => {
    db.willSelect([{ ...FLAG, epic_flag_id: "epic-flag-existing" }]);
    db.willSelect([{ resource_id: "epic-patient-1" }]);
    db.willUpdate();
    db.willInsert();
    const client = fakeClient();

    const result = await pushFlagToEpic("flag-1", { client });

    expect(result.operation).toBe("updated");
    expect(client.createResource).not.toHaveBeenCalled();
    expect(client.updateResource).toHaveBeenCalledOnce();
    const [resourceType, id] = (client.updateResource as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(resourceType).toBe("Flag");
    expect(id).toBe("epic-flag-existing");
  });

  it("returns skipped when the patient has no Epic mapping", async () => {
    db.willSelect([FLAG]);
    db.willSelect([]); // no mapping rows
    const client = fakeClient();

    const result = await pushFlagToEpic("flag-1", { client });
    expect(result.operation).toBe("skipped");
    expect(result.error).toBe("epic_patient_id_unknown");
    expect(client.createResource).not.toHaveBeenCalled();
  });

  it("on Epic write failure, records the error on the flag row + audit_log", async () => {
    db.willSelect([FLAG]);
    db.willSelect([{ resource_id: "epic-patient-1" }]);
    db.willUpdate(); // epic_push_error write
    db.willInsert(); // failure audit
    const client = fakeClient();
    (client.createResource as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Epic write rejected (422)"),
    );

    const result = await pushFlagToEpic("flag-1", { client });
    expect(result.operation).toBe("failed");
    expect(result.error).toMatch(/Epic write rejected/);

    const auditValues = db.insert.calls[0]!.chainArgs[0]![0] as Record<string, unknown>;
    expect(auditValues.action).toBe("epic_flag_push");
    expect(auditValues.success).toBe(false);
    expect(auditValues.error_message).toMatch(/Epic write rejected/);
  });

  it("pushFlagStatusUpdate is a no-op when epic_flag_id is unset", async () => {
    db.willSelect([{ epic_flag_id: null }]);
    const client = fakeClient();
    const result = await pushFlagStatusUpdate("flag-1", { client });
    expect(result.operation).toBe("skipped");
    expect(result.error).toBe("not_pushed_yet");
    expect(client.createResource).not.toHaveBeenCalled();
    expect(client.updateResource).not.toHaveBeenCalled();
  });

  it("pushFlagStatusUpdate delegates to pushFlagToEpic when epic_flag_id is set", async () => {
    // 1st select inside pushFlagStatusUpdate
    db.willSelect([{ epic_flag_id: "epic-flag-existing" }]);
    // pushFlagToEpic then re-selects the full flag + mapping
    db.willSelect([{ ...FLAG, epic_flag_id: "epic-flag-existing" }]);
    db.willSelect([{ resource_id: "epic-patient-1" }]);
    db.willUpdate();
    db.willInsert();
    const client = fakeClient();

    const result = await pushFlagStatusUpdate("flag-1", { client });
    expect(result.operation).toBe("updated");
    expect(client.updateResource).toHaveBeenCalledOnce();
  });
});

/**
 * Regression tests for issue #270 — AI oversight IDOR.
 *
 * The raw ai-oversight router exposed flags.getByPatient / getOpenCount and
 * reviews.getByPatient as unauthenticated tRPC procedures, letting any caller
 * enumerate patient flags by UUID. These tests exercise the RBAC wrapper
 * directly and prove that:
 *
 *  1. An unauthenticated caller is rejected with UNAUTHORIZED.
 *  2. A patient trying to read another patient's flags is rejected with
 *     FORBIDDEN and the flag service is never invoked.
 *  3. A clinician without a care-team assignment is rejected with FORBIDDEN.
 *  4. A clinician with a care-team assignment is allowed through and sees the
 *     expected payload from the flag service.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mocks — referenced from vi.mock factories that get hoisted above
// the rest of the file.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getFlagsByPatient: vi.fn(),
  getOpenFlagCount: vi.fn(),
  getReviewJobsByPatient: vi.fn(),
  assertCareTeamAccess: vi.fn(),
}));

vi.mock("@carebridge/ai-oversight", () => ({
  flagService: {
    getFlagsByPatient: mocks.getFlagsByPatient,
    getOpenFlagCount: mocks.getOpenFlagCount,
    getAllOpenFlags: vi.fn(),
    acknowledgeFlag: vi.fn(),
    resolveFlag: vi.fn(),
    dismissFlag: vi.fn(),
  },
  getReviewJobsByPatient: mocks.getReviewJobsByPatient,
}));

vi.mock("../middleware/rbac.js", () => ({
  assertCareTeamAccess: (...args: unknown[]) =>
    mocks.assertCareTeamAccess(...args),
}));

// ---------------------------------------------------------------------------
// Import after mocks are in place.
// ---------------------------------------------------------------------------

import { aiOversightRbacRouter } from "../routers/ai-oversight.js";
import type { Context } from "../context.js";

type User = NonNullable<Context["user"]>;

const patientA: User = {
  id: "11111111-1111-1111-1111-111111111111",
  email: "alice@carebridge.dev",
  name: "Alice",
  role: "patient",
  is_active: true,
} as User;

const patientBId = "22222222-2222-2222-2222-222222222222";

const physician: User = {
  id: "33333333-3333-3333-3333-333333333333",
  email: "dr.smith@carebridge.dev",
  name: "Dr. Smith",
  role: "physician",
  specialty: "Hematology/Oncology",
  is_active: true,
} as User;

function makeContext(user: Context["user"]): Context {
  return {
    db: {} as Context["db"],
    user,
    sessionId: null,
    requestId: "test-request",
  };
}

const caller = (ctx: Context) =>
  aiOversightRbacRouter.createCaller(ctx);

describe("aiOversightRbacRouter — issue #270 IDOR regression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects unauthenticated flags.getByPatient with UNAUTHORIZED", async () => {
    await expect(
      caller(makeContext(null)).flags.getByPatient({ patientId: patientBId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(mocks.getFlagsByPatient).not.toHaveBeenCalled();
  });

  it("rejects a patient requesting another patient's flags with FORBIDDEN", async () => {
    await expect(
      caller(makeContext(patientA)).flags.getByPatient({
        patientId: patientBId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.getFlagsByPatient).not.toHaveBeenCalled();
  });

  it("rejects a clinician with no care-team assignment with FORBIDDEN", async () => {
    mocks.assertCareTeamAccess.mockResolvedValueOnce(false);

    await expect(
      caller(makeContext(physician)).flags.getByPatient({
        patientId: patientBId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.assertCareTeamAccess).toHaveBeenCalledWith(
      physician.id,
      patientBId,
    );
    expect(mocks.getFlagsByPatient).not.toHaveBeenCalled();
  });

  it("allows a clinician with a care-team assignment to read flags", async () => {
    mocks.assertCareTeamAccess.mockResolvedValueOnce(true);
    const fakeFlags = [{ id: "flag-1", patient_id: patientBId }];
    mocks.getFlagsByPatient.mockResolvedValueOnce(fakeFlags);

    const result = await caller(makeContext(physician)).flags.getByPatient({
      patientId: patientBId,
    });

    expect(result).toEqual(fakeFlags);
    expect(mocks.getFlagsByPatient).toHaveBeenCalledWith(patientBId, undefined);
  });

  it("rejects unauthenticated flags.getOpenCount with UNAUTHORIZED", async () => {
    await expect(
      caller(makeContext(null)).flags.getOpenCount({ patientId: patientBId }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(mocks.getOpenFlagCount).not.toHaveBeenCalled();
  });

  it("rejects cross-patient flags.getOpenCount with FORBIDDEN", async () => {
    await expect(
      caller(makeContext(patientA)).flags.getOpenCount({
        patientId: patientBId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.getOpenFlagCount).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated reviews.getByPatient with UNAUTHORIZED", async () => {
    await expect(
      caller(makeContext(null)).reviews.getByPatient({
        patientId: patientBId,
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    expect(mocks.getReviewJobsByPatient).not.toHaveBeenCalled();
  });

  it("rejects cross-patient reviews.getByPatient with FORBIDDEN", async () => {
    await expect(
      caller(makeContext(patientA)).reviews.getByPatient({
        patientId: patientBId,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    expect(mocks.getReviewJobsByPatient).not.toHaveBeenCalled();
  });
});

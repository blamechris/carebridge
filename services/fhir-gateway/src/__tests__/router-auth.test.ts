import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

// Stub the DB layer so the router's createCaller doesn't try to connect.
// The auth middleware rejects unauthenticated/unauthorised callers before
// any DB access is attempted, so these mocks only need to exist for the
// admin happy-path test and return empty-ish values.
const insertMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@carebridge/db-schema", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@carebridge/db-schema",
  );
  return {
    ...actual,
    getDb: () => ({
      insert: () => ({ values: insertMock }),
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([]),
        }),
      }),
    }),
  };
});

import { fhirGatewayRouter } from "../router.js";

const patientUser = {
  id: "user-patient-1",
  email: "p@example.com",
  name: "Patient One",
  role: "patient" as const,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const adminUser = {
  id: "user-admin-1",
  email: "a@example.com",
  name: "Admin",
  role: "admin" as const,
  is_active: true,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const validBundle = {
  resourceType: "Bundle" as const,
  type: "collection" as const,
  entry: [],
};

beforeEach(() => {
  insertMock.mockClear();
});

describe("fhirGatewayRouter raw auth (defense-in-depth)", () => {
  describe("unauthenticated access", () => {
    it("rejects getByPatient with UNAUTHORIZED when ctx.user is null", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: null });
      await expect(
        caller.getByPatient({ patientId: "p1" }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("rejects exportPatient with UNAUTHORIZED when ctx.user is null", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: null });
      await expect(
        caller.exportPatient({ patientId: "p1" }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });

    it("rejects importBundle with UNAUTHORIZED when ctx.user is null", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: null });
      await expect(
        caller.importBundle({
          bundle: validBundle,
          source_system: "test",
        }),
      ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    });
  });

  describe("importBundle admin-only", () => {
    it("rejects a patient user with FORBIDDEN", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: patientUser });
      await expect(
        caller.importBundle({
          bundle: validBundle,
          source_system: "test",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(insertMock).not.toHaveBeenCalled();
    });

    it("allows an admin user through to the import logic", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: adminUser });
      const result = await caller.importBundle({
        bundle: {
          resourceType: "Bundle",
          type: "collection",
          entry: [
            {
              resource: {
                resourceType: "Observation",
                id: "obs-1",
              },
            },
          ],
        },
        source_system: "unit-test",
      });
      expect(result).toEqual({ imported: 1 });
      expect(insertMock).toHaveBeenCalledTimes(1);
    });

    it("throws TRPCError instances (not plain Errors) for auth failures", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: null });
      await expect(
        caller.exportPatient({ patientId: "p1" }),
      ).rejects.toBeInstanceOf(TRPCError);
    });
  });
});

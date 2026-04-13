import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

// Stub the DB layer so the router's createCaller doesn't try to connect.
// The auth middleware rejects unauthenticated/unauthorised callers before
// any DB access is attempted, so these mocks only need to exist for the
// admin happy-path test and return empty-ish values.
const insertMock = vi.fn().mockResolvedValue(undefined);
const txInsert = vi.fn(() => ({ values: insertMock }));
const txMock = { insert: txInsert };
const transactionMock = vi.fn(
  async (cb: (tx: typeof txMock) => Promise<unknown>) => cb(txMock),
);
vi.mock("@carebridge/db-schema", async () => {
  const actual = await vi.importActual<Record<string, unknown>>(
    "@carebridge/db-schema",
  );
  return {
    ...actual,
    getDb: () => ({
      insert: () => ({ values: insertMock }),
      transaction: transactionMock,
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
          user_id: "user-x",
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
          user_id: patientUser.id,
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
        user_id: adminUser.id,
      });
      expect(result).toEqual({ imported: 1 });
      // fhir_resources insert + audit_log insert = 2 inserts per resource
      expect(insertMock).toHaveBeenCalledTimes(2);
    });

    it("throws TRPCError instances (not plain Errors) for auth failures", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: null });
      await expect(
        caller.exportPatient({ patientId: "p1" }),
      ).rejects.toBeInstanceOf(TRPCError);
    });
  });

  describe("getByPatient / exportPatient defense-in-depth (PR #379 Copilot review)", () => {
    it("rejects a patient requesting another patient's resources via getByPatient", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: patientUser });
      await expect(
        caller.getByPatient({ patientId: "some-other-patient" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects a patient requesting another patient's bundle via exportPatient", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: patientUser });
      await expect(
        caller.exportPatient({ patientId: "some-other-patient" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects a clinician through the raw router (must use the gateway wrapper)", async () => {
      const physicianUser = {
        ...patientUser,
        id: "user-physician-1",
        role: "physician" as const,
        specialty: "Hematology/Oncology",
      };
      const caller = fhirGatewayRouter.createCaller({ user: physicianUser });
      await expect(
        caller.getByPatient({ patientId: "user-patient-1" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("allows a patient to read their own resources via getByPatient (self-access)", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: patientUser });
      // No throw — DB select mock returns []
      await expect(
        caller.getByPatient({ patientId: patientUser.id }),
      ).resolves.toEqual([]);
    });

    it("allows an admin to read any patient via getByPatient", async () => {
      const caller = fhirGatewayRouter.createCaller({ user: adminUser });
      await expect(
        caller.getByPatient({ patientId: "any-patient" }),
      ).resolves.toEqual([]);
    });
  });

  describe("rbacVerified context flag (gateway RBAC pre-authorization)", () => {
    const physicianUser = {
      ...patientUser,
      id: "user-physician-1",
      role: "physician" as const,
      specialty: "Hematology/Oncology",
    };

    it("allows a clinician through getByPatient when rbacVerified is true", async () => {
      const caller = fhirGatewayRouter.createCaller({
        user: physicianUser,
        rbacVerified: true,
      });
      await expect(
        caller.getByPatient({ patientId: "any-patient" }),
      ).resolves.toEqual([]);
    });

    it("still rejects a clinician on getByPatient when rbacVerified is false", async () => {
      const caller = fhirGatewayRouter.createCaller({
        user: physicianUser,
        rbacVerified: false,
      });
      await expect(
        caller.getByPatient({ patientId: "any-patient" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("still rejects a clinician on getByPatient when rbacVerified is not set", async () => {
      const caller = fhirGatewayRouter.createCaller({
        user: physicianUser,
      });
      await expect(
        caller.getByPatient({ patientId: "any-patient" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("allows a clinician through exportPatient when rbacVerified is true", async () => {
      const caller = fhirGatewayRouter.createCaller({
        user: physicianUser,
        rbacVerified: true,
      });
      // DB mock returns [] for patients, so exportPatient will throw NOT_FOUND
      // — but NOT FORBIDDEN, proving the rbacVerified flag was accepted.
      await expect(
        caller.exportPatient({ patientId: "any-patient" }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("rejects a clinician on exportPatient when rbacVerified is false", async () => {
      const caller = fhirGatewayRouter.createCaller({
        user: physicianUser,
        rbacVerified: false,
      });
      await expect(
        caller.exportPatient({ patientId: "any-patient" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("rejects a clinician on exportPatient when rbacVerified is not set", async () => {
      const caller = fhirGatewayRouter.createCaller({
        user: physicianUser,
      });
      await expect(
        caller.exportPatient({ patientId: "any-patient" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });
});

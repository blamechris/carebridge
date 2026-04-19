import { describe, it, expect } from "vitest";
import {
  careTeamMemberRoleSchema,
  careTeamAssignmentRoleSchema,
  addCareTeamMemberSchema,
  removeCareTeamMemberSchema,
  updateCareTeamRoleSchema,
  grantCareTeamAssignmentSchema,
  revokeCareTeamAssignmentSchema,
} from "../care-team.js";

const PATIENT_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
const PROVIDER_ID = "a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5";

// The DB CHECK constraint added in migration 0038 mirrors these enum
// values one-to-one. If either side drifts, this test breaks and forces
// the schema migration to catch up.
describe("careTeamMemberRoleSchema (DB CHECK constraint parity)", () => {
  const EXPECTED_ROLES = ["primary", "specialist", "nurse", "coordinator"] as const;

  it.each(EXPECTED_ROLES)("accepts role=%s", (role) => {
    expect(careTeamMemberRoleSchema.safeParse(role).success).toBe(true);
  });

  it("rejects unknown roles", () => {
    expect(careTeamMemberRoleSchema.safeParse("surgeon").success).toBe(false);
    expect(careTeamMemberRoleSchema.safeParse("").success).toBe(false);
  });

  it("enumerates exactly the DB CHECK-constraint set (no drift)", () => {
    // `z.enum` exposes its values via `.options` — compare as sets so the
    // ordering isn't load-bearing.
    expect([...careTeamMemberRoleSchema.options].sort()).toEqual([...EXPECTED_ROLES].sort());
  });
});

describe("careTeamAssignmentRoleSchema (DB CHECK constraint parity)", () => {
  const EXPECTED_ROLES = ["attending", "consulting", "nursing", "covering"] as const;

  it.each(EXPECTED_ROLES)("accepts role=%s", (role) => {
    expect(careTeamAssignmentRoleSchema.safeParse(role).success).toBe(true);
  });

  it("rejects unknown roles", () => {
    expect(careTeamAssignmentRoleSchema.safeParse("primary").success).toBe(false);
    expect(careTeamAssignmentRoleSchema.safeParse("").success).toBe(false);
  });

  it("enumerates exactly the DB CHECK-constraint set (no drift)", () => {
    expect([...careTeamAssignmentRoleSchema.options].sort()).toEqual([...EXPECTED_ROLES].sort());
  });
});

describe("addCareTeamMemberSchema", () => {
  const valid = {
    patient_id: PATIENT_ID,
    provider_id: PROVIDER_ID,
    role: "nurse" as const,
  };

  it("accepts a minimal valid payload", () => {
    expect(addCareTeamMemberSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts optional specialty + assignment_role", () => {
    expect(
      addCareTeamMemberSchema.safeParse({
        ...valid,
        specialty: "Oncology",
        assignment_role: "nursing",
      }).success,
    ).toBe(true);
  });

  it("rejects an invalid role (would fail DB CHECK too)", () => {
    expect(addCareTeamMemberSchema.safeParse({ ...valid, role: "surgeon" }).success).toBe(false);
  });

  it("rejects mismatched assignment_role", () => {
    expect(
      addCareTeamMemberSchema.safeParse({ ...valid, assignment_role: "primary" }).success,
    ).toBe(false);
  });
});

describe("removeCareTeamMemberSchema / updateCareTeamRoleSchema", () => {
  it("removeCareTeamMemberSchema requires a UUID member_id", () => {
    expect(removeCareTeamMemberSchema.safeParse({ member_id: PROVIDER_ID }).success).toBe(true);
    expect(removeCareTeamMemberSchema.safeParse({ member_id: "not-a-uuid" }).success).toBe(false);
  });

  it("updateCareTeamRoleSchema enforces the member-role enum", () => {
    expect(
      updateCareTeamRoleSchema.safeParse({ member_id: PROVIDER_ID, role: "coordinator" }).success,
    ).toBe(true);
    expect(
      updateCareTeamRoleSchema.safeParse({ member_id: PROVIDER_ID, role: "attending" }).success,
    ).toBe(false);
  });
});

describe("grantCareTeamAssignmentSchema / revokeCareTeamAssignmentSchema", () => {
  it("grantCareTeamAssignmentSchema accepts a valid assignment role", () => {
    expect(
      grantCareTeamAssignmentSchema.safeParse({
        user_id: PROVIDER_ID,
        patient_id: PATIENT_ID,
        role: "attending",
      }).success,
    ).toBe(true);
  });

  it("grantCareTeamAssignmentSchema rejects a clinical-roster role", () => {
    expect(
      grantCareTeamAssignmentSchema.safeParse({
        user_id: PROVIDER_ID,
        patient_id: PATIENT_ID,
        role: "nurse",
      }).success,
    ).toBe(false);
  });

  it("revokeCareTeamAssignmentSchema requires a UUID assignment_id", () => {
    expect(revokeCareTeamAssignmentSchema.safeParse({ assignment_id: PROVIDER_ID }).success).toBe(
      true,
    );
    expect(revokeCareTeamAssignmentSchema.safeParse({ assignment_id: "nope" }).success).toBe(false);
  });
});

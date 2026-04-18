import { describe, it, expect } from "vitest";
import {
  userRoleSchema,
  loginSchema,
  createUserSchema,
  mfaVerifySchema,
  mfaDisableSchema,
  mfaCompleteLoginSchema,
  changePasswordSchema,
} from "../auth.js";

// ─── User Roles ────────────────────────────────────────────────

describe("userRoleSchema", () => {
  it("accepts all valid roles", () => {
    const roles = ["patient", "nurse", "physician", "specialist", "admin"];
    for (const role of roles) {
      expect(userRoleSchema.safeParse(role).success, `Expected role "${role}" to pass`).toBe(true);
    }
  });

  it("rejects invalid roles", () => {
    for (const role of ["doctor", "superadmin", "", "PATIENT"]) {
      expect(userRoleSchema.safeParse(role).success, `Expected role "${role}" to fail`).toBe(false);
    }
  });
});

// ─── Login ─────────────────────────────────────────────────────

describe("loginSchema", () => {
  const validLogin = {
    email: "dr.smith@carebridge.dev",
    password: "password123",
  };

  it("accepts valid login credentials", () => {
    const result = loginSchema.safeParse(validLogin);
    expect(result.success).toBe(true);
  });

  it("rejects invalid email", () => {
    const result = loginSchema.safeParse({ ...validLogin, email: "not-an-email" });
    expect(result.success).toBe(false);
  });

  it("rejects empty email", () => {
    const result = loginSchema.safeParse({ ...validLogin, email: "" });
    expect(result.success).toBe(false);
  });

  it("rejects password shorter than 8 characters", () => {
    const result = loginSchema.safeParse({ ...validLogin, password: "short" });
    expect(result.success).toBe(false);
  });

  it("accepts password of exactly 8 characters", () => {
    const result = loginSchema.safeParse({ ...validLogin, password: "12345678" });
    expect(result.success).toBe(true);
  });

  it("rejects missing fields", () => {
    expect(loginSchema.safeParse({}).success).toBe(false);
    expect(loginSchema.safeParse({ email: "a@b.com" }).success).toBe(false);
    expect(loginSchema.safeParse({ password: "password123" }).success).toBe(false);
  });
});

// ─── Create User ───────────────────────────────────────────────

describe("createUserSchema", () => {
  const validUser = {
    email: "dr.jones@carebridge.dev",
    password: "password123",
    name: "Dr. Jones",
    role: "physician" as const,
  };

  it("accepts valid user with required fields only", () => {
    const result = createUserSchema.safeParse(validUser);
    expect(result.success).toBe(true);
  });

  it("accepts valid user with all optional fields", () => {
    const result = createUserSchema.safeParse({
      ...validUser,
      specialty: "Interventional Radiology",
      department: "Radiology",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = createUserSchema.safeParse({ ...validUser, name: "" });
    expect(result.success).toBe(false);
  });

  it("rejects name exceeding 200 characters", () => {
    const result = createUserSchema.safeParse({ ...validUser, name: "A".repeat(201) });
    expect(result.success).toBe(false);
  });

  it("accepts name of exactly 200 characters", () => {
    const result = createUserSchema.safeParse({ ...validUser, name: "A".repeat(200) });
    expect(result.success).toBe(true);
  });

  it("rejects specialty exceeding 100 characters", () => {
    const result = createUserSchema.safeParse({ ...validUser, specialty: "X".repeat(101) });
    expect(result.success).toBe(false);
  });

  it("rejects department exceeding 100 characters", () => {
    const result = createUserSchema.safeParse({ ...validUser, department: "X".repeat(101) });
    expect(result.success).toBe(false);
  });

  it("rejects invalid role", () => {
    const result = createUserSchema.safeParse({ ...validUser, role: "superadmin" });
    expect(result.success).toBe(false);
  });

  it("accepts family_caregiver role", () => {
    // family_caregiver is a first-class role (see UserRole union) and must
    // be creatable through the admin createUser flow that family-invite
    // acceptance maps onto.
    const result = createUserSchema.safeParse({
      ...validUser,
      email: "caregiver@carebridge.dev",
      role: "family_caregiver",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing required fields", () => {
    expect(createUserSchema.safeParse({}).success).toBe(false);
  });
});

// ─── MFA Verify ────────────────────────────────────────────────

describe("mfaVerifySchema", () => {
  it("accepts a valid 6-digit TOTP code", () => {
    const result = mfaVerifySchema.safeParse({ code: "123456" });
    expect(result.success).toBe(true);
  });

  it("rejects non-digit characters", () => {
    const result = mfaVerifySchema.safeParse({ code: "12345a" });
    expect(result.success).toBe(false);
  });

  it("rejects codes shorter than 6 digits", () => {
    const result = mfaVerifySchema.safeParse({ code: "12345" });
    expect(result.success).toBe(false);
  });

  it("rejects codes longer than 6 digits", () => {
    const result = mfaVerifySchema.safeParse({ code: "1234567" });
    expect(result.success).toBe(false);
  });

  it("rejects empty code", () => {
    const result = mfaVerifySchema.safeParse({ code: "" });
    expect(result.success).toBe(false);
  });
});

// ─── MFA Disable ───────────────────────────────────────────────

describe("mfaDisableSchema", () => {
  it("accepts a valid 6-digit TOTP code", () => {
    const result = mfaDisableSchema.safeParse({ code: "654321" });
    expect(result.success).toBe(true);
  });

  it("rejects non-numeric code", () => {
    const result = mfaDisableSchema.safeParse({ code: "abcdef" });
    expect(result.success).toBe(false);
  });
});

// ─── MFA Complete Login ────────────────────────────────────────

describe("mfaCompleteLoginSchema", () => {
  const validPayload = {
    mfaSessionId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    code: "123456",
  };

  it("accepts valid MFA complete login payload", () => {
    const result = mfaCompleteLoginSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  it("accepts recovery code format", () => {
    const result = mfaCompleteLoginSchema.safeParse({
      ...validPayload,
      code: "ABCDE-FGHIJ",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-UUID mfaSessionId", () => {
    const result = mfaCompleteLoginSchema.safeParse({
      ...validPayload,
      mfaSessionId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty code", () => {
    const result = mfaCompleteLoginSchema.safeParse({
      ...validPayload,
      code: "",
    });
    expect(result.success).toBe(false);
  });
});

// ─── Change Password ───────────────────────────────────────────

describe("changePasswordSchema", () => {
  it("accepts valid password change", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "oldpass123",
      newPassword: "newpass12",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty current password", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "",
      newPassword: "newpass12",
    });
    expect(result.success).toBe(false);
  });

  it("rejects new password shorter than 8 characters", () => {
    const result = changePasswordSchema.safeParse({
      currentPassword: "oldpass123",
      newPassword: "short",
    });
    expect(result.success).toBe(false);
  });
});

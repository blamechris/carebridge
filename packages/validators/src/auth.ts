import { z } from "zod";

export const userRoleSchema = z.enum([
  "patient",
  "nurse",
  "physician",
  "specialist",
  "admin",
  "family_caregiver",
]);

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(200),
  role: userRoleSchema,
  specialty: z.string().max(100).optional(),
  department: z.string().max(100).optional(),
});

// ---------- MFA schemas ----------

export const mfaVerifySchema = z.object({
  code: z.string().length(6).regex(/^\d{6}$/, "TOTP code must be 6 digits"),
});

export const mfaDisableSchema = z.object({
  code: z.string().length(6).regex(/^\d{6}$/, "TOTP code must be 6 digits"),
});

export const mfaCompleteLoginSchema = z.object({
  mfaSessionId: z.string().uuid(),
  code: z.string().min(1), // 6-digit TOTP or XXXXX-XXXXX recovery code
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type MFAVerifyInput = z.infer<typeof mfaVerifySchema>;
export type MFADisableInput = z.infer<typeof mfaDisableSchema>;
export type MFACompleteLoginInput = z.infer<typeof mfaCompleteLoginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

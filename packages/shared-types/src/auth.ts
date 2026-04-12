import type { MutableRecord } from "./base.js";

export type UserRole = "patient" | "nurse" | "physician" | "specialist" | "admin";

export interface User extends MutableRecord {
  email: string;
  name: string;
  role: UserRole;
  patient_id?: string; // links patient-role users to their patient record
  specialty?: string; // for physicians/specialists
  department?: string;
  is_active: boolean;
}

export interface Session {
  id: string;
  user_id: string;
  expires_at: string;
}

// ---------- MFA types ----------

export interface MFASetupResponse {
  secret: string;
  uri: string;
  recoveryCodes: string[];
}

export interface MFAVerifyResponse {
  enabled: true;
  recoveryCodes: string[];
}

export interface MFALoginRequired {
  requiresMFA: true;
  mfaSessionId: string;
}

export interface MFACompleteLoginResponse {
  user: User;
  session: Session;
}

export type LoginResponse =
  | { user: User; session: Session }
  | MFALoginRequired;

// ---------- Permissions ----------

export type Permission =
  | "read:patients"
  | "write:patients"
  | "read:vitals"
  | "write:vitals"
  | "read:labs"
  | "write:labs"
  | "read:medications"
  | "write:medications"
  | "read:notes"
  | "write:notes"
  | "sign:notes"
  | "read:flags"
  | "write:flags"
  | "acknowledge:flags"
  | "admin:users"
  | "admin:rules";

export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  patient: ["read:patients", "read:vitals", "read:labs", "read:medications", "read:notes", "read:flags"],
  nurse: [
    "read:patients", "write:patients",
    "read:vitals", "write:vitals",
    "read:labs",
    "read:medications", "write:medications",
    "read:notes", "write:notes",
    "read:flags", "acknowledge:flags",
  ],
  physician: [
    "read:patients", "write:patients",
    "read:vitals", "write:vitals",
    "read:labs", "write:labs",
    "read:medications", "write:medications",
    "read:notes", "write:notes", "sign:notes",
    "read:flags", "write:flags", "acknowledge:flags",
  ],
  specialist: [
    "read:patients", "write:patients",
    "read:vitals", "write:vitals",
    "read:labs", "write:labs",
    "read:medications", "write:medications",
    "read:notes", "write:notes", "sign:notes",
    "read:flags", "write:flags", "acknowledge:flags",
  ],
  admin: [
    "read:patients", "write:patients",
    "read:vitals", "write:vitals",
    "read:labs", "write:labs",
    "read:medications", "write:medications",
    "read:notes", "write:notes", "sign:notes",
    "read:flags", "write:flags", "acknowledge:flags",
    "admin:users", "admin:rules",
  ],
};

/**
 * Centralized permission check for RBAC enforcement.
 *
 * Returns `true` when the user's role grants the given permission per
 * `ROLE_PERMISSIONS`, otherwise `false`. An unknown permission string
 * (one not present in any role's grant list) always returns `false`.
 *
 * Callers that need to short-circuit a request should use
 * `assertPermission` from `services/api-gateway/src/middleware/rbac.ts`,
 * which wraps this helper and throws a tRPC `FORBIDDEN` error on denial.
 *
 * This helper lives in `@carebridge/shared-types` so every service and
 * app can import it without a framework-specific dependency.
 */
export function hasPermission(user: User, permission: string): boolean {
  const grants = ROLE_PERMISSIONS[user.role];
  if (!grants) return false;
  return (grants as readonly string[]).includes(permission);
}

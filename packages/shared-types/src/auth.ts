import type { MutableRecord } from "./base.js";

export type UserRole = "patient" | "nurse" | "physician" | "specialist" | "admin";

export interface User extends MutableRecord {
  email: string;
  name: string;
  role: UserRole;
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

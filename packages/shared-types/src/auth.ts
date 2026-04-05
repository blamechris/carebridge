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

/**
 * Minimal tRPC context expected by service routers for RBAC enforcement.
 * The api-gateway's full Context extends this (it adds db, requestId, etc.).
 */
export interface ServiceContext {
  user: User | null;
}

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

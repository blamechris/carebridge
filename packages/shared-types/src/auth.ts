import type { MutableRecord } from "./base.js";

export type UserRole =
  | "patient"
  | "nurse"
  | "physician"
  | "specialist"
  | "admin"
  // Family caregivers are invited by a patient and gain scoped read access to
  // that patient's record via the `family_relationships` table. Write access
  // to clinical data (diagnoses, allergies, notes, orders) is always denied —
  // the role is read-only by design. See services/auth/src/family-invite-flow.ts
  // and the `list` projection in services/api-gateway/src/routers/patient-records.ts.
  | "family_caregiver";

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
  // Family caregivers inherit the patient read-set at the role level; granular
  // filtering by active relationship and per-relationship access_scopes is
  // enforced separately at the router layer. No write permissions are granted
  // at the role level — clinical write-paths explicitly deny family_caregiver.
  family_caregiver: ["read:patients", "read:vitals", "read:labs", "read:medications", "read:notes", "read:flags"],
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

// ---------- Family-caregiver access scopes ----------

/**
 * Permitted access-scope tokens for a `family_relationships.access_scopes`
 * entry. Mirrors `FAMILY_ACCESS_SCOPES` in
 * `packages/db-schema/src/schema/family-access.ts` — that file owns the
 * database-level CHECK, this file owns the API-boundary type.
 *
 * Scope semantics (see issue #896):
 *  - `read_only`         — blanket "summary-equivalent" permit. Treated as a
 *                          synonym for `view_summary` in scope checks.
 *  - `view_summary`      — patient demographics, diagnoses, allergies,
 *                          observations. Minimum useful read set.
 *  - `view_appointments` — appointments list for the patient.
 *  - `view_medications`  — medication list + administration history.
 *  - `view_labs`         — lab panels + result history.
 *  - `view_notes`        — clinical notes + version history.
 *  - `view_and_message`  — SUPERSET. Grants every read scope above plus
 *                          messaging participation. Any scope check with a
 *                          `view_and_message` present always passes.
 *
 * IMPORTANT: when expanding this list, keep the `FAMILY_ACCESS_SCOPES`
 * literal in db-schema in sync — both are the source of truth for different
 * layers (DB vs API boundary) and a drift between them is a latent bug.
 */
export const SCOPE_TOKENS = [
  "read_only",
  "view_summary",
  "view_appointments",
  "view_medications",
  "view_labs",
  "view_notes",
  "view_and_message",
] as const;

export type ScopeToken = (typeof SCOPE_TOKENS)[number];

/**
 * Default scope set applied when a family_relationships row has `null` or
 * an empty `access_scopes` array. `read_only` is the safest backstop
 * (summary-equivalent read) and matches the value the API treats as
 * "no granular scopes selected".
 */
export const DEFAULT_CAREGIVER_SCOPES: readonly ScopeToken[] = ["read_only"];

/**
 * Check whether a caregiver's scope set grants the given required scope.
 *
 * Superset rules:
 *  - `view_and_message` grants every other read scope.
 *  - `read_only` is equivalent to `view_summary` (blanket summary permit).
 *
 * Called from `enforcePatientAccess` when the caller is a family caregiver
 * and the procedure declares a `requiredScope`. Never throws — returns a
 * plain boolean so the caller controls the error surface (and the error
 * message can name the missing scope without leaking PHI).
 */
export function hasScope(
  scopes: readonly ScopeToken[] | null | undefined,
  required: ScopeToken,
): boolean {
  const set = scopes && scopes.length > 0 ? scopes : DEFAULT_CAREGIVER_SCOPES;

  // view_and_message is a superset — always grants read access.
  if (set.includes("view_and_message")) return true;

  // read_only is the blanket summary permit.
  if (required === "view_summary" && set.includes("read_only")) return true;
  if (required === "read_only" && set.includes("view_summary")) return true;

  return set.includes(required);
}

/**
 * Normalise an `access_scopes` column value to a non-empty scope array.
 * Treats `null`, `undefined`, or `[]` as the default (`["read_only"]`),
 * so old rows that predate the column never accidentally fall through
 * to a deny-everything state AND never accidentally grant more than a
 * baseline summary permit.
 */
export function normaliseScopes(
  scopes: readonly ScopeToken[] | null | undefined,
): readonly ScopeToken[] {
  if (!scopes || scopes.length === 0) return DEFAULT_CAREGIVER_SCOPES;
  return scopes;
}

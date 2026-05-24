import { pgTable, text, boolean, integer, index } from "drizzle-orm/pg-core";
import { encryptedText } from "../encryption.js";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  password_hash: text("password_hash").notNull(),
  name: text("name").notNull(),
  /**
   * Structured name columns (#972). Populated authoritatively by writers
   * and preferred by FHIR Practitioner export. `parseName` in
   * services/fhir-gateway/src/generators/practitioner.ts remains as a
   * fallback for rows where the structured columns are still null.
   *
   * `name_family` carries the full family name including particles
   * (e.g. "de Klerk", "van der Berg") and two-part Hispanic surnames
   * (e.g. "García López"). `name_given` is the ordered list of given
   * names including middle names. Prefix is honorifics ("Dr.", "Mrs.");
   * suffix is credentials ("MD", "RN", "PhD", "III").
   *
   * Nullable until a one-shot backfill populates every clinical-role row.
   */
  name_family: text("name_family"),
  name_given: text("name_given").array(),
  name_prefix: text("name_prefix"),
  name_suffix: text("name_suffix"),
  role: text("role").notNull(), // patient, nurse, physician, specialist, admin, family_caregiver
  patient_id: text("patient_id"), // links patient users to their patient record
  specialty: text("specialty"),
  department: text("department"),
  /**
   * National Provider Identifier (#947). 10-digit string assigned by CMS;
   * stored as text to preserve any leading zeros and avoid integer
   * coercion. Nullable — only clinical-role rows that have been linked
   * to an NPPES record populate this. The FHIR Practitioner generator
   * emits it as `identifier[]` entry with system
   * `http://hl7.org/fhir/sid/us-npi` when present.
   */
  npi: text("npi"),
  /**
   * NUCC Health Care Provider Taxonomy code (#947). Free-form 10-char
   * code such as "207RC0000X" (Cardiologist - Clinical Cardiac
   * Electrophysiology). When populated, the FHIR Practitioner generator
   * attaches a `coding` entry to `qualification.code` alongside the
   * existing free-text `specialty`. Nullable; absent NUCC keeps the
   * text-only behaviour.
   */
  nucc_code: text("nucc_code"),
  is_active: boolean("is_active").notNull().default(true),
  mfa_secret: encryptedText("mfa_secret"), // encrypted TOTP secret, null if MFA not set up
  mfa_enabled: boolean("mfa_enabled").default(false),
  recovery_codes: text("recovery_codes"), // JSON array of hashed recovery codes
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull().references(() => users.id),
  expires_at: text("expires_at").notNull(),
  created_at: text("created_at").notNull(),
  last_active_at: text("last_active_at"),
  /** Opaque 32-byte hex token used to issue a replacement session without re-authentication. */
  refresh_token: text("refresh_token"),
}, (table) => [
  index("idx_sessions_user").on(table.user_id),
  index("idx_sessions_expires").on(table.expires_at),
  index("idx_sessions_refresh_token").on(table.refresh_token),
]);

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey(),
  user_id: text("user_id").notNull(),
  action: text("action").notNull(), // read, create, update, delete
  resource_type: text("resource_type").notNull(), // patient, vital, note, etc.
  resource_id: text("resource_id").notNull(),
  procedure_name: text("procedure_name"), // tRPC procedure name, e.g. "patients.getById"
  patient_id: text("patient_id"), // explicit patient ID for HIPAA audit trails
  // "self" for patients acting on their own record; for family caregivers,
  // the family_relationships.relationship_type when available ("spouse",
  // "parent", ...) or the literal "caregiver" fallback when no active
  // relationship row exists; NULL for clinicians/admins and for cross-
  // patient access attempts by a patient account. See migration 0031.
  actor_relationship: text("actor_relationship"),
  // When a family caregiver acts on behalf of a patient, records the patient
  // record id so revocation audits can reconstruct affected subjects.
  on_behalf_of_patient_id: text("on_behalf_of_patient_id"),
  details: text("details"), // JSON string of additional context
  ip_address: text("ip_address"),
  http_status_code: integer("http_status_code"), // HTTP response status (200, 401, 403, 500, ...)
  success: boolean("success"), // true for 2xx responses, false otherwise
  error_message: text("error_message"), // short failure reason for non-2xx responses
  timestamp: text("timestamp").notNull(),
}, (table) => [
  index("idx_audit_user").on(table.user_id, table.timestamp),
  index("idx_audit_resource").on(table.resource_type, table.resource_id),
  index("idx_audit_patient").on(table.patient_id, table.timestamp),
  index("idx_audit_success_timestamp").on(table.success, table.timestamp),
  index("idx_audit_actor_relationship").on(table.actor_relationship, table.timestamp),
  index("idx_audit_on_behalf_of").on(table.on_behalf_of_patient_id, table.timestamp),
]);

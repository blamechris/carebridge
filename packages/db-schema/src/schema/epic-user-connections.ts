import { pgTable, text, unique, index } from "drizzle-orm/pg-core";
import { users } from "./auth.js";
import { encryptedText } from "../encryption.js";

/**
 * SMART on FHIR App Launch connection state (#392).
 *
 * One row per (CareBridge user, Epic organisation). Captures the
 * OAuth tokens, scopes, and launch context returned by Epic when a
 * clinician authorises CareBridge against their Epic identity.
 *
 * Token columns are encrypted at rest via the same encryption hook
 * used for PHI columns (see {@link encryptedText}). Refresh tokens
 * may be NULL if the granted scope set didn't include `offline_access`
 * — short-lived sessions still get an access_token, but the user has
 * to re-launch from Epic when it expires.
 */
export const epicUserConnections = pgTable(
  "epic_user_connections",
  {
    id: text("id").primaryKey(),
    user_id: text("user_id")
      .notNull()
      .references(() => users.id),
    /**
     * Epic's `iss` URL — the FHIR base URL for the org. Identifies
     * which Epic instance the tokens are valid against.
     */
    epic_org_iss: text("epic_org_iss").notNull(),
    /**
     * `sub` claim from the id_token. Together with epic_org_iss this
     * gives a stable identifier for the Epic identity across sessions.
     */
    id_token_subject: text("id_token_subject"),
    /**
     * FHIR Practitioner.id Epic returns in the `fhirUser` field. Used
     * to attribute clinical actions back to the right Practitioner
     * resource for outbound flag push (#393).
     */
    epic_practitioner_fhir_id: text("epic_practitioner_fhir_id"),
    /**
     * FHIR Patient.id Epic returns in the launch context (EHR launch
     * only). NULL for standalone launches.
     */
    epic_patient_fhir_id: text("epic_patient_fhir_id"),
    access_token_enc: encryptedText("access_token_enc").notNull(),
    refresh_token_enc: encryptedText("refresh_token_enc"),
    expires_at: text("expires_at").notNull(),
    /** Space-separated SMART scopes Epic granted (may be a subset of requested). */
    scopes: text("scopes").notNull(),
    /**
     * FHIR Encounter.id from EHR launch context, when Epic supplies one
     * (typical for inpatient launches; outpatient launches often omit).
     */
    launch_encounter_fhir_id: text("launch_encounter_fhir_id"),
    created_at: text("created_at").notNull(),
    updated_at: text("updated_at").notNull(),
  },
  (table) => [
    unique("unique_user_epic_org").on(table.user_id, table.epic_org_iss),
    index("idx_epic_user_connections_user").on(table.user_id),
    index("idx_epic_user_connections_practitioner").on(
      table.epic_practitioner_fhir_id,
    ),
  ],
);

/**
 * CRUD for `epic_user_connections` rows (#392).
 *
 * Upserts on (user_id, epic_org_iss) so a re-launch by the same
 * clinician at the same Epic org refreshes the tokens in place rather
 * than appending. Access/refresh tokens are encrypted at rest via the
 * same encryption hook used for PHI columns.
 */
import crypto from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDb, epicUserConnections } from "@carebridge/db-schema";

export interface EpicConnectionUpsert {
  user_id: string;
  epic_org_iss: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: string;
  scopes: string;
  id_token_subject: string | null;
  epic_practitioner_fhir_id: string | null;
  epic_patient_fhir_id: string | null;
  launch_encounter_fhir_id: string | null;
}

export interface EpicConnectionRow {
  id: string;
  user_id: string;
  epic_org_iss: string;
  /** Decrypted access token. */
  access_token: string;
  /** Decrypted refresh token (or null). */
  refresh_token: string | null;
  expires_at: string;
  scopes: string;
  id_token_subject: string | null;
  epic_practitioner_fhir_id: string | null;
  epic_patient_fhir_id: string | null;
  launch_encounter_fhir_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Upsert the connection row. Returns the row id. Tokens are written
 * via the encryption hook attached to the schema columns.
 */
export async function upsertEpicConnection(
  input: EpicConnectionUpsert,
): Promise<string> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db
    .insert(epicUserConnections)
    .values({
      id,
      user_id: input.user_id,
      epic_org_iss: input.epic_org_iss,
      access_token_enc: input.access_token,
      refresh_token_enc: input.refresh_token,
      expires_at: input.expires_at,
      scopes: input.scopes,
      id_token_subject: input.id_token_subject,
      epic_practitioner_fhir_id: input.epic_practitioner_fhir_id,
      epic_patient_fhir_id: input.epic_patient_fhir_id,
      launch_encounter_fhir_id: input.launch_encounter_fhir_id,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: [
        epicUserConnections.user_id,
        epicUserConnections.epic_org_iss,
      ],
      set: {
        access_token_enc: input.access_token,
        refresh_token_enc: input.refresh_token,
        expires_at: input.expires_at,
        scopes: input.scopes,
        id_token_subject: input.id_token_subject,
        epic_practitioner_fhir_id: input.epic_practitioner_fhir_id,
        epic_patient_fhir_id: input.epic_patient_fhir_id,
        launch_encounter_fhir_id: input.launch_encounter_fhir_id,
        updated_at: now,
      },
    });

  return id;
}

export async function getConnectionsForUser(
  userId: string,
): Promise<EpicConnectionRow[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(epicUserConnections)
    .where(eq(epicUserConnections.user_id, userId));
  return rows.map(mapRow);
}

export async function getConnection(
  userId: string,
  epicOrgIss: string,
): Promise<EpicConnectionRow | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(epicUserConnections)
    .where(
      and(
        eq(epicUserConnections.user_id, userId),
        eq(epicUserConnections.epic_org_iss, epicOrgIss),
      ),
    )
    .limit(1);
  const row = rows[0];
  return row ? mapRow(row) : null;
}

export async function deleteConnection(
  userId: string,
  epicOrgIss: string,
): Promise<boolean> {
  const db = getDb();
  const result = await db
    .delete(epicUserConnections)
    .where(
      and(
        eq(epicUserConnections.user_id, userId),
        eq(epicUserConnections.epic_org_iss, epicOrgIss),
      ),
    )
    .returning({ id: epicUserConnections.id });
  return result.length > 0;
}

function mapRow(row: typeof epicUserConnections.$inferSelect): EpicConnectionRow {
  return {
    id: row.id,
    user_id: row.user_id,
    epic_org_iss: row.epic_org_iss,
    access_token: row.access_token_enc,
    refresh_token: row.refresh_token_enc,
    expires_at: row.expires_at,
    scopes: row.scopes,
    id_token_subject: row.id_token_subject,
    epic_practitioner_fhir_id: row.epic_practitioner_fhir_id,
    epic_patient_fhir_id: row.epic_patient_fhir_id,
    launch_encounter_fhir_id: row.launch_encounter_fhir_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

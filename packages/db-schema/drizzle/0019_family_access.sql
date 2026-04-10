-- Phase B3: family caregiver access (patient-initiated path)

CREATE TABLE IF NOT EXISTS family_relationships (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  family_user_id  TEXT NOT NULL REFERENCES users(id),
  relationship    TEXT NOT NULL,
  access_scopes   TEXT NOT NULL,
  consented_at    TEXT NOT NULL,
  revoked_at      TEXT,
  revoked_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT (now()::text)
);

CREATE INDEX IF NOT EXISTS idx_family_rel_patient ON family_relationships(patient_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_family_rel_user    ON family_relationships(family_user_id, revoked_at);

CREATE TABLE IF NOT EXISTS family_invites (
  id              TEXT PRIMARY KEY,
  patient_id      TEXT NOT NULL REFERENCES patients(id),
  invited_by      TEXT NOT NULL REFERENCES users(id),
  invitee_email   TEXT NOT NULL,
  relationship    TEXT NOT NULL,
  access_scopes   TEXT NOT NULL,
  token           TEXT NOT NULL UNIQUE,
  status          TEXT NOT NULL DEFAULT 'pending',
  expires_at      TEXT NOT NULL,
  accepted_at     TEXT,
  cancelled_at    TEXT,
  created_at      TEXT NOT NULL DEFAULT (now()::text)
);

CREATE INDEX IF NOT EXISTS idx_family_invite_patient ON family_invites(patient_id, status);
CREATE INDEX IF NOT EXISTS idx_family_invite_token   ON family_invites(token);

-- Extend audit_log with caregiver attribution columns.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS actor_relationship TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS on_behalf_of_patient_id TEXT;

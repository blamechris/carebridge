-- Migration: Create emergency_access table for break-the-glass access

CREATE TABLE IF NOT EXISTS emergency_access (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  patient_id TEXT NOT NULL REFERENCES patients(id),
  justification TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revoked_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emergency_access_user ON emergency_access(user_id);
CREATE INDEX IF NOT EXISTS idx_emergency_access_patient ON emergency_access(patient_id);
CREATE INDEX IF NOT EXISTS idx_emergency_access_expires ON emergency_access(expires_at);

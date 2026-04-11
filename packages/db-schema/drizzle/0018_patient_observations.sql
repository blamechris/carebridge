-- Migration: Create patient_observations table for symptom journal
--
-- Patient-contributed observations that feed into the AI oversight engine.
-- These are separate from the clinical chart — they appear in a "Patient Signals"
-- section visible to providers but do not clutter clinical documentation.

CREATE TABLE IF NOT EXISTS patient_observations (
  id TEXT PRIMARY KEY,
  patient_id TEXT NOT NULL REFERENCES patients(id),
  observation_type TEXT NOT NULL,
  description TEXT NOT NULL,
  structured_data JSONB,
  severity_self_assessment TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_patient_observations_patient ON patient_observations(patient_id, created_at);
CREATE INDEX IF NOT EXISTS idx_patient_observations_type ON patient_observations(observation_type);

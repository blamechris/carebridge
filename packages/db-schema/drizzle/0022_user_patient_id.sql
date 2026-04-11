-- Migration: Add patient_id column to users table
--
-- Links patient-role users directly to their patient record, replacing
-- the fragile name-match lookup pattern in the patient portal.

ALTER TABLE users ADD COLUMN IF NOT EXISTS patient_id TEXT REFERENCES patients(id);

-- Migration: Add weight_kg column to patients table
--
-- Supports weight-based dose validation in the AI oversight engine.
-- Weight is stored in kilograms as a nullable real column — null indicates
-- weight has not yet been documented for the patient.

ALTER TABLE patients ADD COLUMN IF NOT EXISTS weight_kg REAL;

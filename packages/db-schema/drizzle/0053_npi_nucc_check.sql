-- #1150: CHECK constraints on users.npi and users.nucc_code.
--
-- PR #1141 added the nullable `npi` and `nucc_code` columns and wired
-- them into the FHIR Practitioner generator. The generator stamps
-- `meta.profile = us-core-practitioner` when both are present — a real
-- downstream conformance claim. Without a shape gate, a malformed
-- value from an ops backfill (typo, swapped letter, truncated copy)
-- would sail through and produce a *false* conformance claim that
-- HAPI / Inferno / Touchstone would flag at the FHIR validator layer.
--
-- This migration adds DB-side shape gates as defence in depth:
--
--   npi        — must be NULL or exactly 10 ASCII digits.
--   nucc_code  — must be NULL or match the NUCC provider-taxonomy
--                pattern XXXXX0000X (5 alphanumeric + literal "0000"
--                + one trailing letter).
--
-- The Luhn check-digit for NPI is enforced at the application layer
-- (services/fhir-gateway/src/generators/practitioner-validation.ts).
-- Postgres CHECK constraints can't compute Luhn without a plpgsql
-- function, and adding one for two columns isn't worth the ongoing
-- maintenance — the shape check here is sufficient to reject the
-- most common backfill mistakes, and the app-side validator catches
-- the rest before any FHIR resource is emitted.
--
-- Both constraints permit NULL because clinical-role rows that have
-- not yet been backfilled with NPPES data legitimately have no NPI /
-- NUCC code (the same NULL-tolerant contract documented on the
-- columns in #947).

-- Idempotency: drop any prior version of these constraints first so the
-- migration is safe to re-apply in dev/test environments where the
-- schema may already have them (e.g. squashed DB, manual apply, branch
-- swap during local work). Pattern mirrored from 0026 and 0038.
ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_npi_shape_chk;
ALTER TABLE users
  ADD CONSTRAINT users_npi_shape_chk
  CHECK (npi IS NULL OR npi ~ '^[0-9]{10}$');

ALTER TABLE users
  DROP CONSTRAINT IF EXISTS users_nucc_code_shape_chk;
ALTER TABLE users
  ADD CONSTRAINT users_nucc_code_shape_chk
  CHECK (nucc_code IS NULL OR nucc_code ~ '^[A-Z0-9]{5}0000[A-Z]$');

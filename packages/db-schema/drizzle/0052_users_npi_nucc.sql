-- #947: optional NPI + NUCC taxonomy columns on users for US Core Practitioner conformance.
--
-- US Core Practitioner mandates at least one identifier with a
-- registered system (NPI preferred) and SHOULD carry an NUCC taxonomy
-- coding on `qualification.code`. The existing users row gives us only
-- the locally-scoped `urn:carebridge:users` identifier and a free-text
-- `specialty` string, neither of which satisfy the profile.
--
-- These two columns are nullable so existing rows continue to emit the
-- pre-#947 shape (text-only qualification, internal identifier only).
-- The Practitioner generator opts into the US Core profile per-row only
-- when BOTH `npi` and a NUCC qualification coding are present — see
-- services/fhir-gateway/src/generators/practitioner.ts for the gate
-- rationale. Asserting `meta.profile` without these would be a false
-- conformance claim against downstream validators.
--
-- No backfill is performed in this migration; existing clinical-role
-- rows remain NULL and behave as before. A separate operator-driven
-- backfill (NPI registry lookup + specialty-to-NUCC mapping) is
-- expected to populate these columns over time.

ALTER TABLE users ADD COLUMN IF NOT EXISTS npi text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS nucc_code text;

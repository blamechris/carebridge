-- #972: structured name columns on users for authoritative FHIR Practitioner export.
--
-- The `users.name` free-text column is adequate for display but ambiguous
-- for FHIR — `parseName` in services/fhir-gateway/src/generators/practitioner.ts
-- runs a particle-aware heuristic at export time (Hispanic two-part surnames,
-- particle-prefixed families like "de Klerk", middle-initial Anglo names).
-- The heuristic is correct in the common case but inevitably miscategorises
-- edge cases (full middle names, hyphenated surnames with particles, etc.).
--
-- Authoritative structure on the row eliminates the guess: writers
-- populate the structured columns explicitly, and toFhirPractitioner reads
-- them when present. The free-text `name` column stays for display and as
-- a fallback for unbackfilled rows.
--
-- Backfill is a separate one-shot script that runs the existing parseName
-- over every users row and queues Hispanic / particle / hyphenated names
-- for admin review (tracked separately). Once the backfill completes and
-- all clinical roles have non-null name_family + name_given, a follow-up
-- migration will flip the columns to NOT NULL and parseName is removed.

ALTER TABLE users ADD COLUMN IF NOT EXISTS name_family text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_given text[];
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_prefix text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS name_suffix text;

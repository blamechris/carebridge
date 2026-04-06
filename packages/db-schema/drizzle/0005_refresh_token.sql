-- Add refresh_token column to sessions table.
-- Each session may optionally carry an opaque 32-byte hex refresh token
-- that can be used to issue a replacement session without re-authentication.

ALTER TABLE "sessions"
  ADD COLUMN "refresh_token" text;

CREATE INDEX IF NOT EXISTS "idx_sessions_refresh_token"
  ON "sessions" ("refresh_token");

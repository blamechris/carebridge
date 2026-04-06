-- Add created_at and last_active_at columns to sessions table.
-- created_at uses a default so existing rows are backfilled automatically.

ALTER TABLE "sessions"
  ADD COLUMN "created_at" text NOT NULL DEFAULT (now()::text);

ALTER TABLE "sessions"
  ADD COLUMN "last_active_at" text;

-- Drop the default after backfill so future inserts must supply a value explicitly.
ALTER TABLE "sessions"
  ALTER COLUMN "created_at" DROP DEFAULT;

-- Index for expiry-based queries used by the cleanup worker.
CREATE INDEX IF NOT EXISTS "idx_sessions_expires" ON "sessions" ("expires_at");

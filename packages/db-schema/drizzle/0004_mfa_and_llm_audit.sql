-- MFA columns on users table
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_secret" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "mfa_enabled" BOOLEAN DEFAULT false;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "recovery_codes" TEXT;

-- LLM interaction log table
CREATE TABLE IF NOT EXISTS "llm_interaction_log" (
  "id" TEXT PRIMARY KEY,
  "patient_id" TEXT NOT NULL,
  "review_job_id" TEXT,
  "model" TEXT NOT NULL,
  "prompt_version" TEXT NOT NULL,
  "fields_redacted" JSONB,
  "provider_count_redacted" INTEGER DEFAULT 0,
  "prompt_hash" TEXT NOT NULL,
  "request_tokens" INTEGER,
  "response_tokens" INTEGER,
  "response_valid" BOOLEAN NOT NULL DEFAULT true,
  "response_flags_count" INTEGER DEFAULT 0,
  "validation_error" TEXT,
  "latency_ms" INTEGER,
  "timestamp" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_llm_log_patient" ON "llm_interaction_log" ("patient_id", "timestamp");
CREATE INDEX IF NOT EXISTS "idx_llm_log_model" ON "llm_interaction_log" ("model", "timestamp");
CREATE INDEX IF NOT EXISTS "idx_llm_log_prompt_hash" ON "llm_interaction_log" ("prompt_hash");

-- MedLens sync tokens table
CREATE TABLE IF NOT EXISTS "medlens_sync_tokens" (
  "id" TEXT PRIMARY KEY,
  "patient_id" TEXT NOT NULL,
  "token_hash" TEXT NOT NULL UNIQUE,
  "scopes" JSONB NOT NULL,
  "created_at" TEXT NOT NULL,
  "expires_at" TEXT NOT NULL,
  "revoked_at" TEXT,
  "revoked_reason" TEXT
);

CREATE INDEX IF NOT EXISTS "idx_medlens_tokens_patient" ON "medlens_sync_tokens" ("patient_id");
CREATE INDEX IF NOT EXISTS "idx_medlens_tokens_hash" ON "medlens_sync_tokens" ("token_hash");

-- MedLens sync log table
CREATE TABLE IF NOT EXISTS "medlens_sync_log" (
  "id" TEXT PRIMARY KEY,
  "token_id" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "record_count" INTEGER NOT NULL DEFAULT 0,
  "vitals_count" INTEGER DEFAULT 0,
  "labs_count" INTEGER DEFAULT 0,
  "events_count" INTEGER DEFAULT 0,
  "timestamp" TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_medlens_sync_log_token" ON "medlens_sync_log" ("token_id", "timestamp");

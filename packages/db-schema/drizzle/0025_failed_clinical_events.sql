CREATE TABLE IF NOT EXISTS "failed_clinical_events" (
  "id" text PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "patient_id" text NOT NULL,
  "event_payload" jsonb NOT NULL,
  "error_message" text,
  "status" text NOT NULL DEFAULT 'pending',
  "retry_count" real NOT NULL DEFAULT 0,
  "created_at" text NOT NULL,
  "processed_at" text
);

CREATE INDEX IF NOT EXISTS "idx_failed_events_status" ON "failed_clinical_events" ("status", "created_at");

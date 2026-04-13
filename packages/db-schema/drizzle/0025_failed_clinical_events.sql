CREATE TABLE IF NOT EXISTS "failed_clinical_events" (
  "id" text PRIMARY KEY NOT NULL,
  "event_type" text NOT NULL,
  "event_payload" jsonb NOT NULL,
  "error_message" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "retry_count" real DEFAULT 0 NOT NULL,
  "created_at" text NOT NULL,
  "retried_at" text
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_failed_clinical_events_status" ON "failed_clinical_events" USING btree ("status","created_at");

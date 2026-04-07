CREATE TABLE IF NOT EXISTS "encounters" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "encounter_type" text NOT NULL,
  "status" text NOT NULL,
  "start_time" text NOT NULL,
  "end_time" text,
  "provider_id" text REFERENCES "users"("id"),
  "location" text,
  "reason" text,
  "notes" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_encounters_patient" ON "encounters" ("patient_id");
CREATE INDEX IF NOT EXISTS "idx_encounters_start_time" ON "encounters" ("start_time");

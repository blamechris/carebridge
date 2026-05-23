-- #391: per-patient, per-resource-type Epic sync bookkeeping.
--
-- The Epic sync worker (services/epic-connector/src/workers/sync-worker.ts)
-- pulls FHIR resources from Epic on a schedule. To support incremental
-- pulls (Epic search-param `_lastUpdated=gt<ts>`) and to surface sync
-- health in the clinician portal, we track the last successful sync
-- timestamp, the FHIR `_lastUpdated` watermark, and the most recent
-- error per (patient_id, resource_type) tuple.
--
-- One row per (patient, resource_type). `last_fhir_lastupdated` is the
-- watermark used in the next incremental request (NOT the wall-clock
-- time the sync ran — that's `last_synced_at`).
CREATE TABLE IF NOT EXISTS "epic_sync_state" (
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "resource_type" text NOT NULL,
  "last_synced_at" text,
  "last_fhir_lastupdated" text,
  "status" text NOT NULL DEFAULT 'pending',
  "resources_synced_count" integer NOT NULL DEFAULT 0,
  "error_count" integer NOT NULL DEFAULT 0,
  "last_error_message" text,
  "last_error_at" text,
  PRIMARY KEY ("patient_id", "resource_type")
);

CREATE INDEX IF NOT EXISTS "idx_epic_sync_state_status"
  ON "epic_sync_state" ("status");

CREATE INDEX IF NOT EXISTS "idx_epic_sync_state_last_synced"
  ON "epic_sync_state" ("last_synced_at");

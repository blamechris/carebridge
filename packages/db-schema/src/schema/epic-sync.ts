import { pgTable, text, integer, primaryKey, index } from "drizzle-orm/pg-core";
import { patients } from "./patients.js";

/**
 * Per-patient, per-resource-type Epic sync bookkeeping (#391).
 *
 * The Epic sync worker reads/writes one row per (patient_id, resource_type)
 * tuple to drive incremental pulls (`_lastUpdated=gt<watermark>`) and to
 * surface sync health in the clinician portal.
 *
 * Columns:
 *   - last_synced_at        — wall-clock time the sync job last RAN
 *   - last_fhir_lastupdated — FHIR `_lastUpdated` watermark to feed the
 *                             NEXT incremental request. NOT the same as
 *                             `last_synced_at` — Epic resources may be
 *                             back-dated days after `last_synced_at`.
 *   - status                — pending | running | ok | failed
 *   - resources_synced_count — cumulative successful imports
 *   - error_count           — cumulative failures
 */
export const epicSyncState = pgTable(
  "epic_sync_state",
  {
    patient_id: text("patient_id")
      .notNull()
      .references(() => patients.id),
    resource_type: text("resource_type").notNull(),
    last_synced_at: text("last_synced_at"),
    last_fhir_lastupdated: text("last_fhir_lastupdated"),
    status: text("status").notNull().default("pending"),
    resources_synced_count: integer("resources_synced_count")
      .notNull()
      .default(0),
    error_count: integer("error_count").notNull().default(0),
    last_error_message: text("last_error_message"),
    last_error_at: text("last_error_at"),
  },
  (table) => [
    primaryKey({ columns: [table.patient_id, table.resource_type] }),
    index("idx_epic_sync_state_status").on(table.status),
    index("idx_epic_sync_state_last_synced").on(table.last_synced_at),
  ],
);

export type EpicSyncStatus = "pending" | "running" | "ok" | "failed";

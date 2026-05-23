/**
 * Epic-sync tRPC router (#391).
 *
 * Surface for the clinician portal's Epic sync dashboard and for
 * admin-driven manual sync triggers. Wired into the api-gateway via
 * services/api-gateway/src/routers/epic-sync.ts which adds RBAC.
 *
 * This module exports the raw router; auth/RBAC is layered in the
 * gateway, mirroring how ai-oversight, clinical-data and patient-records
 * structure their wrappers.
 *
 * Procedures:
 *   - epicSync.triggerSync       — enqueue a sync job (admin)
 *   - epicSync.getSyncStatus     — read all (patient, resource_type)
 *                                  rows for a patient
 *   - epicSync.listSyncErrors    — paginate the most recent failed
 *                                  sync rows across patients
 */
import { initTRPC } from "@trpc/server";
import { z } from "zod";
import {
  enqueueFullSync,
  enqueueIncrementalSync,
  enqueueSingleResourceSync,
} from "./workers/sync-worker.js";
import {
  getAllSyncStatesForPatient,
  listRecentFailures,
} from "./sync/sync-state-repo.js";
import { SUPPORTED_RESOURCE_TYPES } from "./sync/sync-jobs.js";

const t = initTRPC.create();

const syncResourceTypeSchema = z.enum(
  SUPPORTED_RESOURCE_TYPES as [string, ...string[]],
);

export const epicSyncRouter = t.router({
  /**
   * Enqueue a sync job. Three flavours:
   *   full         — pull every resource type, no watermark
   *   incremental  — pull every resource type, using stored watermarks
   *   single       — pull one resource type, optional watermark
   */
  triggerSync: t.procedure
    .input(
      z.discriminatedUnion("mode", [
        z.object({
          mode: z.literal("full"),
          patient_id: z.string().uuid(),
          epic_patient_fhir_id: z.string().optional(),
        }),
        z.object({
          mode: z.literal("incremental"),
          patient_id: z.string().uuid(),
          epic_patient_fhir_id: z.string().optional(),
        }),
        z.object({
          mode: z.literal("single"),
          patient_id: z.string().uuid(),
          resource_type: syncResourceTypeSchema,
          epic_patient_fhir_id: z.string().optional(),
          watermark: z.string().nullish(),
        }),
      ]),
    )
    .mutation(async ({ input }) => {
      if (input.mode === "full") {
        await enqueueFullSync({
          patient_id: input.patient_id,
          epic_patient_fhir_id: input.epic_patient_fhir_id,
        });
        return { enqueued: "full-sync", patient_id: input.patient_id };
      }
      if (input.mode === "incremental") {
        await enqueueIncrementalSync({
          patient_id: input.patient_id,
          epic_patient_fhir_id: input.epic_patient_fhir_id,
        });
        return {
          enqueued: "incremental-sync",
          patient_id: input.patient_id,
        };
      }
      await enqueueSingleResourceSync({
        patient_id: input.patient_id,
        // safe: the zod enum schema is built from SUPPORTED_RESOURCE_TYPES
        resource_type:
          input.resource_type as (typeof SUPPORTED_RESOURCE_TYPES)[number],
        epic_patient_fhir_id: input.epic_patient_fhir_id,
        watermark: input.watermark,
      });
      return {
        enqueued: "single-resource-sync",
        patient_id: input.patient_id,
        resource_type: input.resource_type,
      };
    }),

  /**
   * Read every (resource_type) sync row for a patient. The clinician
   * portal renders this as the per-patient Epic-sync health card.
   */
  getSyncStatus: t.procedure
    .input(z.object({ patient_id: z.string().uuid() }))
    .query(async ({ input }) => {
      return getAllSyncStatesForPatient(input.patient_id);
    }),

  /**
   * List the most recent N failed syncs across all patients — powers
   * the admin "things needing attention" dashboard.
   */
  listSyncErrors: t.procedure
    .input(z.object({ limit: z.number().min(1).max(500).optional() }))
    .query(async ({ input }) => {
      return listRecentFailures(input.limit);
    }),
});

export type EpicSyncRouter = typeof epicSyncRouter;

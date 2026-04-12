/**
 * Read-side helpers for the review_jobs table.
 *
 * Kept outside the router module so the RBAC wrapper in api-gateway can call
 * them directly without going through the raw tRPC router surface.
 */

import { eq, desc } from "drizzle-orm";
import { getDb, reviewJobs } from "@carebridge/db-schema";

export async function getReviewJobsByPatient(patientId: string) {
  const db = getDb();
  return db
    .select()
    .from(reviewJobs)
    .where(eq(reviewJobs.patient_id, patientId))
    .orderBy(desc(reviewJobs.created_at));
}

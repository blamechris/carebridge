/**
 * Integration test for issue #818 — readPendingBatch concurrent-disjointness
 * guarantee.
 *
 * PR #806 refactored outbox-reconciler tests to mock @carebridge/outbox
 * directly, which removed the end-to-end assertion that two concurrent
 * readPendingBatch calls receive disjoint row sets (the FOR UPDATE SKIP
 * LOCKED contract). This test restores that coverage against a real
 * Postgres instance.
 *
 * Gated on TEST_DATABASE_URL: the test is a no-op when no DB is available,
 * so local unit runs (pnpm test) don't require docker-compose to be up.
 * CI runs a `postgres` service and supplies TEST_DATABASE_URL. See the
 * `test` job in .github/workflows/ci.yml.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { sql } from "drizzle-orm";

// Point @carebridge/db-schema's getDb() singleton at the test DB BEFORE
// importing @carebridge/outbox (which calls getDb() lazily on first use).
// Honor an explicit DATABASE_URL if the caller has already set one.
const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = TEST_URL;
}

const { readPendingBatch } = await import("../index.js");
const { getDb, failedClinicalEvents } = await import("@carebridge/db-schema");

describe.skipIf(!TEST_URL)(
  "readPendingBatch — concurrent batch disjointness (#818)",
  () => {
    beforeAll(async () => {
      // Fail fast with a readable error if migrations haven't run against
      // the test DB.
      await getDb().execute(sql`SELECT 1 FROM failed_clinical_events LIMIT 1`);
    });

    beforeEach(async () => {
      await getDb().execute(sql`TRUNCATE TABLE failed_clinical_events`);
    });

    async function seedPending(count: number): Promise<string[]> {
      const now = new Date().toISOString();
      const rows = Array.from({ length: count }, (_, i) => {
        const id = crypto.randomUUID();
        return {
          id,
          event_type: "medication.created",
          patient_id: `patient-${i}`,
          event_payload: {
            id,
            type: "medication.created",
            patient_id: `patient-${i}`,
            timestamp: now,
            data: {},
          },
          error_message: null,
          status: "pending",
          retry_count: 0,
          created_at: now,
          updated_at: now,
        };
      });
      await getDb().insert(failedClinicalEvents).values(rows);
      return rows.map((r) => r.id);
    }

    it("two concurrent readPendingBatch calls claim disjoint rows", async () => {
      const LIMIT = 50;
      const SEEDED = 200; // Comfortably above 2 * LIMIT so both batches fill.
      const seeded = await seedPending(SEEDED);

      const [batchA, batchB] = await Promise.all([
        readPendingBatch(LIMIT),
        readPendingBatch(LIMIT),
      ]);

      const idsA = new Set(batchA.map((r) => r.id));
      const idsB = new Set(batchB.map((r) => r.id));

      // Disjoint: no id appears in both batches.
      for (const id of idsA) {
        expect(idsB.has(id), `id ${id} appeared in both batches`).toBe(false);
      }

      // Conservation: every claimed id came from the seeded pool; the union
      // size equals the sum of per-batch sizes (no duplicates across pool).
      const union = new Set([...idsA, ...idsB]);
      expect(union.size).toBe(idsA.size + idsB.size);
      const seededSet = new Set(seeded);
      for (const id of union) expect(seededSet.has(id)).toBe(true);

      // Each batch honors the limit.
      expect(batchA.length).toBeLessThanOrEqual(LIMIT);
      expect(batchB.length).toBeLessThanOrEqual(LIMIT);

      // With 2 × LIMIT rows available and SKIP LOCKED working, both
      // batches should fill to the limit. If this ever flakes the contract
      // is broken — widening the seed would hide a regression.
      expect(batchA.length + batchB.length).toBe(2 * LIMIT);
    });

    it("claimed rows flip to status='processing'; unclaimed stay pending", async () => {
      const seeded = await seedPending(20);

      const [batchA, batchB] = await Promise.all([
        readPendingBatch(5),
        readPendingBatch(5),
      ]);

      const claimedIds = [...batchA, ...batchB].map((r) => r.id);
      expect(claimedIds).toHaveLength(10);

      // Verify status directly from the DB for the claimed rows.
      const claimedRows = (await getDb().execute(
        sql`SELECT status FROM failed_clinical_events WHERE id = ANY(${claimedIds})`,
      )) as unknown as Array<{ status: string }>;
      expect(claimedRows).toHaveLength(claimedIds.length);
      for (const row of claimedRows) expect(row.status).toBe("processing");

      const leftover = (await getDb().execute(
        sql`SELECT COUNT(*)::int AS count FROM failed_clinical_events WHERE status = 'pending'`,
      )) as unknown as Array<{ count: number }>;
      expect(leftover[0].count).toBe(seeded.length - claimedIds.length);
    });
  },
);

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
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sql, inArray } from "drizzle-orm";

// Point @carebridge/db-schema's getDb() singleton at the test DB BEFORE
// importing @carebridge/outbox (which calls getDb() lazily on first use).
//
// Safety invariant: this test ALWAYS overrides DATABASE_URL with
// TEST_DATABASE_URL when the latter is set, so a developer with
// `DATABASE_URL=<prod-or-dev-DB>` in their shell can't accidentally have us
// mutate the wrong database. If the caller has set both to the same value
// we no-op; if they diverge we force the test URL. The old "honor existing
// DATABASE_URL" behaviour was unsafe — review comment on PR #917.
const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  if (
    process.env.DATABASE_URL &&
    process.env.DATABASE_URL !== TEST_URL
  ) {
    // Structured warning so the override is audible in CI logs.
    console.warn(
      `[batch-disjointness.int] Overriding DATABASE_URL (${process.env.DATABASE_URL}) ` +
        `with TEST_DATABASE_URL for test safety.`,
    );
  }
  process.env.DATABASE_URL = TEST_URL;
}

const { readPendingBatch } = await import("../index.js");
const { getDb, failedClinicalEvents } = await import("@carebridge/db-schema");

// Marker prefix used on seeded patient_id values so beforeEach can scope its
// DELETE to rows this test owns (#1298). Parallel int tests touching
// failed_clinical_events — or pre-existing dev rows in a shared DB — are
// never trampled. Replaces the older `TRUNCATE TABLE failed_clinical_events`
// approach which blast-deleted every other test's state.
const TEST_ROW_MARKER = "test-outbox-1298-";

describe.skipIf(!TEST_URL)(
  "readPendingBatch — concurrent batch disjointness (#818)",
  () => {
    beforeAll(async () => {
      // Fail fast with a readable error if migrations haven't run against
      // the test DB.
      await getDb().execute(sql`SELECT 1 FROM failed_clinical_events LIMIT 1`);
    });

    afterAll(async () => {
      // Close the underlying postgres-js client so Vitest / CI don't hang
      // on the open connection handle. drizzle-orm/postgres-js exposes the
      // raw client on `$client`; `.end()` is idempotent and awaitable.
      const db = getDb() as unknown as {
        $client?: { end?: () => Promise<void> };
      };
      await db.$client?.end?.();
    });

    beforeEach(async () => {
      // Targeted cleanup scoped to rows this test owns
      // (patient_id LIKE 'test-outbox-1298-%'). Parallel integration tests
      // touching failed_clinical_events — or dev rows sitting in the same
      // DB — are never trampled (#1298).
      await getDb().execute(
        sql`DELETE FROM failed_clinical_events WHERE patient_id LIKE ${TEST_ROW_MARKER + "%"}`,
      );
    });

    async function seedPending(count: number): Promise<string[]> {
      const now = new Date().toISOString();
      const rows = Array.from({ length: count }, (_, i) => {
        const id = crypto.randomUUID();
        const patientId = `${TEST_ROW_MARKER}${i}`;
        return {
          id,
          event_type: "medication.created",
          patient_id: patientId,
          event_payload: {
            id,
            type: "medication.created",
            patient_id: patientId,
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
      const seededSet = new Set(seeded);

      const [batchA, batchB] = await Promise.all([
        readPendingBatch(LIMIT),
        readPendingBatch(LIMIT),
      ]);

      const idsA = new Set(batchA.map((r) => r.id));
      const idsB = new Set(batchB.map((r) => r.id));

      // Disjoint: no id appears in both batches. This holds regardless of
      // what other parallel tests have seeded — SKIP LOCKED guarantees it.
      for (const id of idsA) {
        expect(idsB.has(id), `id ${id} appeared in both batches`).toBe(false);
      }

      // No duplicates in the union across batches.
      const union = new Set([...idsA, ...idsB]);
      expect(union.size).toBe(idsA.size + idsB.size);

      // Each batch honors the limit.
      expect(batchA.length).toBeLessThanOrEqual(LIMIT);
      expect(batchB.length).toBeLessThanOrEqual(LIMIT);

      // With 2 × LIMIT rows available from our seeded pool and SKIP LOCKED
      // working, both batches should fill to the limit. If this ever flakes
      // the contract is broken — widening the seed would hide a regression.
      // Note: readPendingBatch isn't patient_id-scoped, so a parallel int
      // test seeding older pending rows could push some claims out of our
      // seeded pool. We tolerate that — the count assertion uses total
      // batch size which is unaffected, and disjointness is the actual
      // contract being verified (#1298).
      expect(batchA.length + batchB.length).toBe(2 * LIMIT);

      // Of the claims that came from our seeded pool, they must remain
      // disjoint and in-pool (sanity check on the seeded-id subset).
      const claimedFromOurPool = [...union].filter((id) => seededSet.has(id));
      expect(new Set(claimedFromOurPool).size).toBe(claimedFromOurPool.length);
    });

    it("claimed rows flip to status='processing'; unclaimed stay pending", async () => {
      const seeded = await seedPending(20);
      const seededSet = new Set(seeded);

      const [batchA, batchB] = await Promise.all([
        readPendingBatch(5),
        readPendingBatch(5),
      ]);

      const claimedIds = [...batchA, ...batchB].map((r) => r.id);
      expect(claimedIds).toHaveLength(10);

      // Verify status directly from the DB for the claimed rows.
      const claimedRows = await getDb()
        .select({ status: failedClinicalEvents.status })
        .from(failedClinicalEvents)
        .where(inArray(failedClinicalEvents.id, claimedIds));
      expect(claimedRows).toHaveLength(claimedIds.length);
      for (const row of claimedRows) expect(row.status).toBe("processing");

      // Leftover pending count scoped to OUR seeded pool so parallel int
      // tests holding pending rows in failed_clinical_events don't poison
      // the assertion (#1298). The contract is: of the 20 rows we seeded,
      // however many ended up claimed must equal 20 minus the leftover.
      const ourClaimedCount = claimedIds.filter((id) => seededSet.has(id)).length;
      const leftover = (await getDb().execute(
        sql`SELECT COUNT(*)::int AS count
            FROM failed_clinical_events
            WHERE status = 'pending'
              AND patient_id LIKE ${TEST_ROW_MARKER + "%"}`,
      )) as unknown as Array<{ count: number }>;
      expect(leftover[0].count).toBe(seeded.length - ourClaimedCount);
    });
  },
);

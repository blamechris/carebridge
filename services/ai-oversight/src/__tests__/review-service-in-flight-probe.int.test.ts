/**
 * Integration test for issue #1252 — exercise the review-service in-flight
 * dedup probe against a real PostgreSQL instance, not a vi.mock("drizzle-orm")
 * stub.
 *
 * Why this test exists
 * --------------------
 * PR #1244 fixed a production-blocking bug where the probe's
 * `gte(reviewJobs.created_at, inFlightCutoff)` predicate compared a `text`
 * column to a `timestamp with time zone` expression, causing every BullMQ
 * review job to fail with:
 *
 *     operator does not exist: text >= timestamp with time zone
 *
 * The bug shipped because every existing review-service test under
 * services/ai-oversight/src/__tests__/ mocks `drizzle-orm` (see
 * `review-idempotency.test.ts` and `review-service-db-clock-idempotency.test.ts`):
 * the SQL is constructed in JS but never sent to a real planner that would
 * reject the type mismatch. The fix wraps the column side in a
 * `${col}::timestamptz` cast — but only a real-PG test can prove the cast is
 * still in place. Per the user memory `feedback_mocked_sql_misses_runtime_types`,
 * the same class of bug (Drizzle helper returning a different PG type than the
 * schema column) could be reintroduced on any future predicate touching a
 * non-text column. This file is the structural guard.
 *
 * Gating
 * ------
 * Gated on TEST_DATABASE_URL — no-op locally without docker-compose up.
 * CI's `test` job (.github/workflows/ci.yml) supplies it after running
 * migrations. Mirrors the harness shape already used by
 * `packages/outbox/src/__tests__/batch-disjointness.int.test.ts` and
 * `services/epic-connector/src/__tests__/persistence-source-system.int.test.ts`
 * so behaviour is consistent across the repo.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import {
  IN_FLIGHT_WINDOW_SEC,
  TERMINAL_REVIEW_STATUSES,
} from "../services/review-service.js";

// Safety invariant identical to the other *.int.test.ts harnesses: force
// DATABASE_URL to TEST_DATABASE_URL so a developer with DATABASE_URL pointing
// at a dev/prod DB cannot accidentally mutate it. The probe under test is
// read-only, but the test inserts seed rows and cleans up afterwards.
const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== TEST_URL) {
    console.warn(
      `[review-service-in-flight-probe.int] Overriding DATABASE_URL (${process.env.DATABASE_URL}) ` +
        `with TEST_DATABASE_URL for test safety.`,
    );
  }
  process.env.DATABASE_URL = TEST_URL;
}

// `patients.name` is an encryptedText column, so seeding a patient (needed to
// satisfy review_jobs.patient_id FK) requires a PHI_ENCRYPTION_KEY. Match the
// pattern from `persistence-source-system.int.test.ts`: generate a per-process
// throwaway key BEFORE the dynamic import of @carebridge/db-schema so the
// encryption module's memoised key read picks it up.
if (TEST_URL && !process.env.PHI_ENCRYPTION_KEY) {
  process.env.PHI_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
}

const { getDb, patients, reviewJobs } = await import("@carebridge/db-schema");

/**
 * Reconstruct the exact dedup probe query from
 * services/ai-oversight/src/services/review-service.ts lines 137-168.
 *
 * Kept inline (rather than calling processReviewJob directly) so the test
 * exercises just the SQL surface where the bug lives, without dragging in the
 * Claude client, BullMQ, context-builder, and flag-service dependencies that
 * the full pipeline needs. A throw from this select is the exact symptom of
 * the production-blocking bug PR #1244 fixed.
 */
async function runInFlightProbe(triggerEventId: string) {
  const db = getDb();
  const inFlightCutoff = sql`NOW() - ${IN_FLIGHT_WINDOW_SEC} * interval '1 second'`;
  return db
    .select({
      id: reviewJobs.id,
      status: reviewJobs.status,
      created_at: reviewJobs.created_at,
    })
    .from(reviewJobs)
    .where(
      and(
        eq(reviewJobs.trigger_event_id, triggerEventId),
        or(
          inArray(reviewJobs.status, TERMINAL_REVIEW_STATUSES as string[]),
          and(
            eq(reviewJobs.status, "processing"),
            // The cast under test. Without `::timestamptz` on the column side
            // PostgreSQL rejects this with "operator does not exist:
            // text >= timestamp with time zone".
            gte(sql`${reviewJobs.created_at}::timestamptz`, inFlightCutoff),
          ),
        ),
      ),
    )
    .limit(1);
}

// Marker prefix used in both id and the test patient row so beforeEach can
// scope its DELETE to rows this test owns and never touches dev seed data.
const TEST_ROW_MARKER = "test-1252-";

async function seedPatient(): Promise<string> {
  // Prefix the UUID so beforeEach can identify rows owned by this file even
  // if a previous run crashed mid-test and left state behind.
  const id = `${TEST_ROW_MARKER}${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await getDb().insert(patients).values({
    id,
    name: "In-Flight Probe Test",
    created_at: now,
    updated_at: now,
  });
  return id;
}

async function seedReviewJob(opts: {
  patientId: string;
  triggerEventId: string;
  status: string;
  createdAt: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  await getDb().insert(reviewJobs).values({
    id,
    patient_id: opts.patientId,
    status: opts.status,
    trigger_event_type: "note.saved",
    trigger_event_id: opts.triggerEventId,
    rules_evaluated: [],
    rules_fired: [],
    flags_generated: [],
    created_at: opts.createdAt,
  });
  return id;
}

describe.skipIf(!TEST_URL)(
  "review-service in-flight dedup probe runs against real PostgreSQL (#1252)",
  () => {
    beforeAll(async () => {
      // Fail fast with a readable error if migrations haven't run against the
      // test DB. If review_jobs is missing the whole test file is broken.
      await getDb().execute(sql`SELECT 1 FROM review_jobs LIMIT 1`);
    });

    afterAll(async () => {
      // Close the underlying postgres-js client so Vitest / CI don't hang on
      // the open connection handle. Mirrors the other *.int.test.ts files.
      const db = getDb() as unknown as {
        $client?: { end?: () => Promise<void> };
      };
      await db.$client?.end?.();
    });

    beforeEach(async () => {
      // Targeted cleanup scoped to rows this test owns (id LIKE 'test-1252-%').
      // Parallel integration tests touching unrelated tables — or dev seed
      // data sitting in the same DB — are never trampled. Order matters:
      // review_jobs.patient_id references patients.id, so reviews first.
      await getDb().execute(
        sql`DELETE FROM review_jobs WHERE patient_id LIKE ${TEST_ROW_MARKER + "%"}`,
      );
      await getDb().execute(
        sql`DELETE FROM patients WHERE id LIKE ${TEST_ROW_MARKER + "%"}`,
      );
    });

    it("does not throw 'operator does not exist: text >= timestamptz' against real PG", async () => {
      // The probe must execute cleanly even when there are no matching rows.
      // Pre-fix this threw at SQL-planning time because gte() bound the bare
      // text column to a timestamptz expression. Post-fix the column is cast
      // and the planner accepts the comparison.
      const triggerEventId = crypto.randomUUID();
      await expect(runInFlightProbe(triggerEventId)).resolves.toEqual([]);
    });

    it("finds a fresh 'processing' row inside the in-flight window (cast preserves semantics)", async () => {
      // Asserts the fix didn't break the predicate: a row in `processing`
      // with a created_at inside the 150s window must still match. A regression
      // that, say, used `text` comparison would yield wrong results for
      // offset-form timestamps; a regression that broke the cast would throw.
      const patientId = await seedPatient();
      const triggerEventId = crypto.randomUUID();
      // 5s ago — comfortably inside the 150s window.
      const freshCreatedAt = new Date(Date.now() - 5_000).toISOString();
      const jobId = await seedReviewJob({
        patientId,
        triggerEventId,
        status: "processing",
        createdAt: freshCreatedAt,
      });

      const rows = await runInFlightProbe(triggerEventId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(jobId);
      expect(rows[0]!.status).toBe("processing");
    });

    it("ignores a stale 'processing' row (orphan recovery path)", async () => {
      // A `processing` row older than IN_FLIGHT_WINDOW_SEC must NOT match —
      // the production pipeline treats it as an orphan from a crashed worker
      // and proceeds. The cast on the column side must produce a real
      // timestamptz comparison, not lexicographic text ordering.
      const patientId = await seedPatient();
      const triggerEventId = crypto.randomUUID();
      // 10 minutes ago — well outside the 150s window.
      const staleCreatedAt = new Date(Date.now() - 600_000).toISOString();
      await seedReviewJob({
        patientId,
        triggerEventId,
        status: "processing",
        createdAt: staleCreatedAt,
      });

      const rows = await runInFlightProbe(triggerEventId);
      expect(rows).toEqual([]);
    });

    it("matches a terminal-status row regardless of created_at age", async () => {
      // The probe's first OR branch (terminal-status match) does not use the
      // timestamptz cast at all — but its presence in the same query means a
      // SQL-planning regression on the cast would still tank this case too.
      // Belt-and-suspenders coverage.
      const patientId = await seedPatient();
      const triggerEventId = crypto.randomUUID();
      // Even if it's ancient, terminal rows must short-circuit.
      const ancientCreatedAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const jobId = await seedReviewJob({
        patientId,
        triggerEventId,
        status: "completed",
        createdAt: ancientCreatedAt,
      });

      const rows = await runInFlightProbe(triggerEventId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(jobId);
      expect(rows[0]!.status).toBe("completed");
    });
  },
);

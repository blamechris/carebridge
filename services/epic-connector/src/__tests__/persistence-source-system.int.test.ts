/**
 * Integration test for #1190 — persistEncounter / persistCondition /
 * persistAllergy must stamp source_system='epic' on the inserted row.
 *
 * Closes the gap surfaced during #1183 review: the Epic converters always
 * returned `source_system: "epic"` on the row shape, but for encounters,
 * diagnoses, and allergies the value was being silently dropped on insert
 * because the column didn't exist. Migration 0054 adds the column; the
 * persistence layer was updated to thread row.source_system through.
 *
 * Gated on TEST_DATABASE_URL — no-op locally without docker-compose up.
 * CI's `test` job (.github/workflows/ci.yml) supplies it after running
 * migrations.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import crypto from "node:crypto";
import { sql, eq } from "drizzle-orm";

// Safety invariant identical to packages/outbox/src/__tests__/batch-disjointness.int.test.ts:
// force DATABASE_URL to TEST_DATABASE_URL so we never mutate a dev/prod DB.
const TEST_URL = process.env.TEST_DATABASE_URL;
if (TEST_URL) {
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== TEST_URL) {
    console.warn(
      `[persistence-source-system.int] Overriding DATABASE_URL (${process.env.DATABASE_URL}) ` +
        `with TEST_DATABASE_URL for test safety.`,
    );
  }
  process.env.DATABASE_URL = TEST_URL;
}

// `patients.name` is an encryptedText column, so seedPatient() needs a
// PHI_ENCRYPTION_KEY to write any row. CI's test job (.github/workflows/ci.yml)
// doesn't set one — and we don't want it to, because that's a real production
// secret. Generate a per-process throwaway key here so the test is self-
// contained. Must be set BEFORE the dynamic import of @carebridge/db-schema
// below: getKey() memoises the parsed key on first read.
if (TEST_URL && !process.env.PHI_ENCRYPTION_KEY) {
  process.env.PHI_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");
}

const {
  getDb,
  patients,
  encounters,
  diagnoses,
  allergies,
  fhirResources,
} = await import("@carebridge/db-schema");
const { persistEncounter, persistCondition, persistAllergy } = await import(
  "../sync/persistence.js"
);

// Marker prefix used on seeded patient.id so beforeEach can scope its DELETE
// to rows this test owns (#1298). Encounters, diagnoses, allergies and
// fhir_resources all carry patient_id, so the prefix flows transitively to
// every dependent row. Replaces the older `LIKE '%'` cleanup which
// blast-deleted every row in those tables — including parallel int tests'
// state.
const TEST_ROW_MARKER = "test-epic-1298-";

async function seedPatient(): Promise<string> {
  // Prefix the UUID so beforeEach can identify rows owned by this file even
  // if a previous run crashed mid-test and left state behind.
  const id = `${TEST_ROW_MARKER}${crypto.randomUUID()}`;
  const now = new Date().toISOString();
  await getDb().insert(patients).values({
    id,
    name: "Source Sys Test",
    created_at: now,
    updated_at: now,
  });
  return id;
}

describe.skipIf(!TEST_URL)(
  "Epic persistence writes source_system='epic' (#1190)",
  () => {
    beforeAll(async () => {
      // Fail fast if migration 0054 hasn't run.
      await getDb().execute(
        sql`SELECT source_system FROM encounters LIMIT 1`,
      );
      await getDb().execute(
        sql`SELECT source_system FROM diagnoses LIMIT 1`,
      );
      await getDb().execute(
        sql`SELECT source_system FROM allergies LIMIT 1`,
      );
    });

    afterAll(async () => {
      const db = getDb() as unknown as {
        $client?: { end?: () => Promise<void> };
      };
      await db.$client?.end?.();
    });

    beforeEach(async () => {
      // Targeted cleanup scoped to rows this test owns
      // (patient_id LIKE 'test-epic-1298-%'). Parallel integration tests
      // touching the same tables — or dev seed data sitting in the same
      // DB — are never trampled (#1298). Order matters for the patient FK:
      // fhir_resources/encounters/diagnoses/allergies first, patients last.
      await getDb().execute(
        sql`DELETE FROM fhir_resources WHERE patient_id LIKE ${TEST_ROW_MARKER + "%"}`,
      );
      await getDb().execute(
        sql`DELETE FROM encounters WHERE patient_id LIKE ${TEST_ROW_MARKER + "%"}`,
      );
      await getDb().execute(
        sql`DELETE FROM diagnoses WHERE patient_id LIKE ${TEST_ROW_MARKER + "%"}`,
      );
      await getDb().execute(
        sql`DELETE FROM allergies WHERE patient_id LIKE ${TEST_ROW_MARKER + "%"}`,
      );
      await getDb().execute(
        sql`DELETE FROM patients WHERE id LIKE ${TEST_ROW_MARKER + "%"}`,
      );
    });

    it("persistEncounter writes source_system='epic' on insert", async () => {
      const patientId = await seedPatient();
      const result = await persistEncounter(
        {
          resourceType: "Encounter",
          id: "epic-enc-1",
          status: "finished",
          class: { code: "AMB" },
          subject: { reference: `Patient/epic-pat-1` },
          period: { start: "2026-05-22T10:00:00Z", end: "2026-05-22T11:00:00Z" },
        },
        patientId,
      );

      expect(result.inserted).toBe(true);
      expect(result.internalId).toBeTruthy();

      const rows = await getDb()
        .select({ source_system: encounters.source_system })
        .from(encounters)
        .where(eq(encounters.id, result.internalId!));
      expect(rows).toHaveLength(1);
      expect(rows[0].source_system).toBe("epic");
    });

    it("persistCondition writes source_system='epic' on insert", async () => {
      const patientId = await seedPatient();
      const result = await persistCondition(
        {
          resourceType: "Condition",
          id: "epic-cond-1",
          clinicalStatus: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/condition-clinical",
                code: "active",
              },
            ],
          },
          code: {
            text: "Test condition",
            coding: [
              { system: "http://hl7.org/fhir/sid/icd-10-cm", code: "Z00.0" },
            ],
          },
          subject: { reference: `Patient/epic-pat-1` },
        },
        patientId,
      );

      expect(result.inserted).toBe(true);
      expect(result.internalId).toBeTruthy();

      const rows = await getDb()
        .select({ source_system: diagnoses.source_system })
        .from(diagnoses)
        .where(eq(diagnoses.id, result.internalId!));
      expect(rows).toHaveLength(1);
      expect(rows[0].source_system).toBe("epic");
    });

    it("persistAllergy writes source_system='epic' on insert", async () => {
      const patientId = await seedPatient();
      const result = await persistAllergy(
        {
          resourceType: "AllergyIntolerance",
          id: "epic-allergy-1",
          clinicalStatus: {
            coding: [
              {
                system:
                  "http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical",
                code: "active",
              },
            ],
          },
          code: {
            text: "Peanut",
          },
          patient: { reference: `Patient/epic-pat-1` },
        },
        patientId,
      );

      expect(result.inserted).toBe(true);
      expect(result.internalId).toBeTruthy();

      const rows = await getDb()
        .select({ source_system: allergies.source_system })
        .from(allergies)
        .where(eq(allergies.id, result.internalId!));
      expect(rows).toHaveLength(1);
      expect(rows[0].source_system).toBe("epic");
    });

    it("default 'internal' applies when no source_system is supplied (existing row migration semantics)", async () => {
      // Verifies the migration default — a direct insert without
      // source_system populates 'internal'. This is the safety net for
      // rows that existed before migration 0054 ran.
      const patientId = await seedPatient();
      const id = crypto.randomUUID();
      await getDb().insert(encounters).values({
        id,
        patient_id: patientId,
        encounter_type: "AMB",
        status: "finished",
        start_time: "2026-05-22T10:00:00Z",
        created_at: new Date().toISOString(),
      });
      const rows = await getDb()
        .select({ source_system: encounters.source_system })
        .from(encounters)
        .where(eq(encounters.id, id));
      expect(rows).toHaveLength(1);
      expect(rows[0].source_system).toBe("internal");
    });
  },
);

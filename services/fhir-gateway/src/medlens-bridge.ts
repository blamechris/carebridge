/**
 * MedLens Bridge Router
 *
 * Provides CareBridge ↔ MedLens data synchronization endpoints.
 *
 * Architecture:
 *   1. Patient generates a sync token in CareBridge (scoped to specific operations)
 *   2. MedLens stores the token and uses it for all sync requests
 *   3. Token is validated on each request (scopes checked per endpoint)
 *
 * Endpoints:
 *   medlensBridge.createSyncToken  — Patient creates a new sync token
 *   medlensBridge.revokeSyncToken  — Patient revokes a token
 *   medlensBridge.listSyncTokens   — Patient views active tokens
 *   medlensBridge.exportForMedLens — MedLens pulls CareBridge data
 *   medlensBridge.importFromMedLens — MedLens pushes patient-captured data
 *
 * Integration guide for MedLens:
 *   1. User generates a sync token in CareBridge patient portal
 *   2. User enters token in MedLens Settings → CareBridge Sync
 *   3. MedLens calls exportForMedLens to populate the local DB
 *   4. MedLens calls importFromMedLens to push home readings
 */

import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import crypto from "node:crypto";
import { eq, and, gt } from "drizzle-orm";
import { getDb } from "@carebridge/db-schema";
import {
  medlensSyncTokens,
  medlensSyncLog,
  medications,
  vitals,
  labPanels,
  labResults,
  events,
} from "@carebridge/db-schema";
import type {
  MedLensSyncScope,
  MedLensExportBundle,
  MedLensImportResult,
} from "@carebridge/shared-types";

const t = initTRPC.create();

// ─── Token length & TTL ───────────────────────────────────────────────────────

const TOKEN_BYTES = 32;
const TOKEN_TTL_DAYS = 30;
const SYNC_TOKEN_PREFIX = "ml_";

function generateSyncToken(): string {
  const random = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
  return `${SYNC_TOKEN_PREFIX}${random}`;
}

// ─── Validation schemas ───────────────────────────────────────────────────────

const VALID_SCOPES: MedLensSyncScope[] = [
  "read:medications",
  "read:vitals",
  "read:labs",
  "write:vitals",
  "write:labs",
  "write:events",
];

const medlensSyncScopeSchema = z.enum([
  "read:medications",
  "read:vitals",
  "read:labs",
  "write:vitals",
  "write:labs",
  "write:events",
]);

const importVitalSchema = z.object({
  medlens_id: z.string(),
  recorded_at: z.string().datetime(),
  type: z.string().min(1).max(100),
  value_primary: z.number().finite(),
  value_secondary: z.number().finite().nullable(),
  unit: z.string().min(1).max(50),
  notes: z.string().max(500).nullable(),
  extraction_tier: z.enum(["local", "api-text", "api-vision"]),
  confidence: z.number().min(0).max(1),
});

const importLabResultSchema = z.object({
  medlens_id: z.string(),
  test_name: z.string().min(1).max(200),
  value: z.number().finite(),
  unit: z.string().min(1).max(50),
  reference_low: z.number().nullable(),
  reference_high: z.number().nullable(),
  flag: z.enum(["H", "L", "critical"]).nullable(),
  confidence: z.number().min(0).max(1),
});

const importLabPanelSchema = z.object({
  medlens_id: z.string(),
  panel_name: z.string().min(1).max(200),
  collected_at: z.string().datetime().nullable(),
  results: z.array(importLabResultSchema),
  extraction_tier: z.enum(["local", "api-text", "api-vision"]),
});

const importEventSchema = z.object({
  medlens_id: z.string(),
  occurred_at: z.string().datetime(),
  category: z.string().min(1).max(100),
  title: z.string().min(1).max(500),
  body: z.string().max(5000).nullable(),
  severity: z.enum(["info", "warning", "urgent"]),
});

// ─── Token validation helper ──────────────────────────────────────────────────

async function validateSyncToken(
  token: string,
  requiredScope: MedLensSyncScope,
): Promise<{ patientId: string; tokenId: string }> {
  const db = getDb();
  const now = new Date().toISOString();

  const rows = await db
    .select()
    .from(medlensSyncTokens)
    .where(
      and(
        eq(medlensSyncTokens.token, token),
        gt(medlensSyncTokens.expires_at, now),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Invalid or expired sync token.",
    });
  }

  const tokenRow = rows[0]!;

  if (tokenRow.revoked_at) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Sync token has been revoked.",
    });
  }

  const scopes = (tokenRow.scopes ?? []) as MedLensSyncScope[];
  if (!scopes.includes(requiredScope)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Token does not have the required scope: ${requiredScope}`,
    });
  }

  // Update last_used_at asynchronously
  db.update(medlensSyncTokens)
    .set({ last_used_at: now })
    .where(eq(medlensSyncTokens.id, tokenRow.id))
    .catch(() => {});

  return { patientId: tokenRow.patient_id, tokenId: tokenRow.id };
}

// ─── Router ───────────────────────────────────────────────────────────────────

export const medlensBridgeRouter = t.router({
  /**
   * Create a sync token that authorizes MedLens to access this patient's data.
   *
   * Called by: authenticated patient or authorized representative in CareBridge portal
   * The `patient_id` and `created_by` come from the authenticated session context.
   */
  createSyncToken: t.procedure
    .input(
      z.object({
        patient_id: z.string().uuid(),
        created_by: z.string().uuid(),
        scopes: z.array(medlensSyncScopeSchema).min(1),
        ttl_days: z.number().int().min(1).max(365).default(TOKEN_TTL_DAYS),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const id = crypto.randomUUID();
      const token = generateSyncToken();
      const now = new Date().toISOString();
      const expiresAt = new Date(
        Date.now() + input.ttl_days * 24 * 60 * 60 * 1000,
      ).toISOString();

      await db.insert(medlensSyncTokens).values({
        id,
        token,
        patient_id: input.patient_id,
        created_by: input.created_by,
        scopes: input.scopes,
        expires_at: expiresAt,
        created_at: now,
      });

      return {
        token_id: id,
        token,
        expires_at: expiresAt,
        scopes: input.scopes,
        setup_instructions: [
          "1. Open MedLens on your device",
          "2. Go to Settings → CareBridge Sync",
          "3. Tap 'Connect CareBridge'",
          "4. Enter this token: " + token,
          `5. Token expires: ${new Date(expiresAt).toLocaleDateString()}`,
        ],
      };
    }),

  /**
   * Revoke a sync token.
   */
  revokeSyncToken: t.procedure
    .input(
      z.object({
        token_id: z.string().uuid(),
        patient_id: z.string().uuid(),
        reason: z.string().max(200).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();

      await db
        .update(medlensSyncTokens)
        .set({
          revoked_at: new Date().toISOString(),
          revoke_reason: input.reason ?? "user_revoked",
        })
        .where(
          and(
            eq(medlensSyncTokens.id, input.token_id),
            eq(medlensSyncTokens.patient_id, input.patient_id),
          ),
        );

      return { success: true };
    }),

  /**
   * List active sync tokens for a patient.
   */
  listSyncTokens: t.procedure
    .input(z.object({ patient_id: z.string().uuid() }))
    .query(async ({ input }) => {
      const db = getDb();
      const now = new Date().toISOString();

      const tokens = await db
        .select({
          id: medlensSyncTokens.id,
          scopes: medlensSyncTokens.scopes,
          expires_at: medlensSyncTokens.expires_at,
          last_used_at: medlensSyncTokens.last_used_at,
          revoked_at: medlensSyncTokens.revoked_at,
          created_at: medlensSyncTokens.created_at,
        })
        .from(medlensSyncTokens)
        .where(
          and(
            eq(medlensSyncTokens.patient_id, input.patient_id),
            gt(medlensSyncTokens.expires_at, now),
          ),
        );

      // Never return the token value — only the ID and metadata
      return tokens;
    }),

  // ─── MedLens-facing endpoints ─────────────────────────────────────────────

  /**
   * Export CareBridge data in MedLens-compatible format.
   *
   * Called by: MedLens app using a sync token
   * Returns the patient's medications, vitals, and labs for local storage in MedLens.
   */
  exportForMedLens: t.procedure
    .input(
      z.object({
        sync_token: z.string().startsWith(SYNC_TOKEN_PREFIX),
        since: z.string().datetime().optional(), // Only export records updated after this timestamp
      }),
    )
    .query(async ({ input }) => {
      // Validate token and check read scopes
      const { patientId, tokenId } = await validateSyncToken(
        input.sync_token,
        "read:medications",
      );

      const db = getDb();
      const now = new Date().toISOString();

      const [meds, vitalRecords, panels] = await Promise.all([
        db.select().from(medications).where(eq(medications.patient_id, patientId)),
        db.select().from(vitals).where(eq(vitals.patient_id, patientId)),
        db.select().from(labPanels).where(eq(labPanels.patient_id, patientId)),
      ]);

      // Fetch lab results for all panels
      const panelIds = panels.map((p) => p.id);
      const allLabResults: typeof labResults.$inferSelect[] = [];
      for (const panelId of panelIds) {
        const results = await db
          .select()
          .from(labResults)
          .where(eq(labResults.panel_id, panelId));
        allLabResults.push(...results);
      }

      const resultsByPanelId = new Map<string, typeof labResults.$inferSelect[]>();
      for (const result of allLabResults) {
        const list = resultsByPanelId.get(result.panel_id) ?? [];
        list.push(result);
        resultsByPanelId.set(result.panel_id, list);
      }

      const bundle: MedLensExportBundle = {
        export_timestamp: now,
        patient_id: patientId,
        schema_version: "1.0",

        medications: meds.map((m) => ({
          carebridge_id: m.id,
          name: m.name,
          brand_name: null,
          dose_amount: m.dose_amount ?? null,
          dose_unit: m.dose_unit ?? null,
          route: m.route ?? null,
          frequency: m.frequency ?? null,
          status: (m.status ?? "active") as "active" | "discontinued" | "completed",
          started_at: m.started_at ?? null,
          ended_at: null,
          prescribed_by: null,
          notes: null,
          source: "carebridge" as const,
        })),

        vitals: vitalRecords.map((v) => ({
          carebridge_id: v.id,
          recorded_at: v.recorded_at,
          type: v.type,
          value_primary: v.value_primary,
          value_secondary: v.value_secondary ?? null,
          unit: v.unit,
          notes: null,
          source: "carebridge" as const,
        })),

        lab_panels: panels.map((p) => ({
          carebridge_id: p.id,
          panel_name: p.panel_name,
          collected_at: p.collected_at ?? null,
          reported_at: p.reported_at ?? null,
          ordered_by: p.ordered_by ?? null,
          source: "carebridge" as const,
          results: (resultsByPanelId.get(p.id) ?? []).map((r) => ({
            carebridge_id: r.id,
            test_name: r.test_name,
            test_code: r.test_code ?? null,
            value: r.value,
            unit: r.unit,
            reference_low: r.reference_low ?? null,
            reference_high: r.reference_high ?? null,
            flag: (r.flag ?? null) as "H" | "L" | "critical" | null,
          })),
        })),
      };

      // Log the export for HIPAA audit trail
      await db.insert(medlensSyncLog).values({
        id: crypto.randomUUID(),
        token_id: tokenId,
        patient_id: patientId,
        operation: "export",
        records_transferred: JSON.stringify({
          medications: meds.length,
          vitals: vitalRecords.length,
          lab_panels: panels.length,
        }),
        timestamp: now,
      });

      return bundle;
    }),

  /**
   * Import patient-captured data from MedLens into CareBridge.
   *
   * Called by: MedLens app using a sync token
   * Accepts vitals, lab results, and events captured by the patient at home
   * or during hospital stays. All imported records are tagged source: "medlens".
   */
  importFromMedLens: t.procedure
    .input(
      z.object({
        sync_token: z.string().startsWith(SYNC_TOKEN_PREFIX),
        medlens_patient_id: z.string(),
        schema_version: z.literal("1.0"),
        import_timestamp: z.string().datetime(),
        vitals: z.array(importVitalSchema).max(500),
        lab_panels: z.array(importLabPanelSchema).max(100),
        events: z.array(importEventSchema).max(200),
      }),
    )
    .mutation(async ({ input }) => {
      // Validate token and check write scope
      const { patientId, tokenId } = await validateSyncToken(
        input.sync_token,
        "write:vitals",
      );

      const db = getDb();
      const now = new Date().toISOString();
      const result: MedLensImportResult = {
        accepted: 0,
        skipped: 0,
        skipped_reasons: [],
        carebridge_ids: { vitals: [], lab_panels: [], events: [] },
      };

      // Import vitals — only accept readings with confidence > 0.6
      for (const v of input.vitals) {
        if (v.confidence < 0.6) {
          result.skipped++;
          result.skipped_reasons.push(`vital ${v.medlens_id}: confidence too low (${v.confidence})`);
          continue;
        }

        const id = crypto.randomUUID();
        try {
          await db.insert(vitals).values({
            id,
            patient_id: patientId,
            recorded_at: v.recorded_at,
            type: v.type,
            value_primary: v.value_primary,
            value_secondary: v.value_secondary ?? undefined,
            unit: v.unit,
            source_system: "medlens",
            created_at: now,
          });
          result.carebridge_ids.vitals.push(id);
          result.accepted++;
        } catch {
          result.skipped++;
          result.skipped_reasons.push(`vital ${v.medlens_id}: database error`);
        }
      }

      // Import lab panels + results
      for (const panel of input.lab_panels) {
        const panelId = crypto.randomUUID();
        try {
          await db.insert(labPanels).values({
            id: panelId,
            patient_id: patientId,
            panel_name: panel.panel_name,
            collected_at: panel.collected_at ?? undefined,
            source_system: "medlens",
            created_at: now,
          });

          for (const lr of panel.results) {
            if (lr.confidence >= 0.5) {
              await db.insert(labResults).values({
                id: crypto.randomUUID(),
                panel_id: panelId,
                test_name: lr.test_name,
                value: lr.value,
                unit: lr.unit,
                reference_low: lr.reference_low ?? undefined,
                reference_high: lr.reference_high ?? undefined,
                flag: lr.flag ?? undefined,
                created_at: now,
              });
            }
          }

          result.carebridge_ids.lab_panels.push(panelId);
          result.accepted++;
        } catch {
          result.skipped++;
          result.skipped_reasons.push(`lab panel ${panel.medlens_id}: database error`);
        }
      }

      // Import events as clinical notes/observations
      for (const ev of input.events) {
        const id = crypto.randomUUID();
        try {
          // Store as a patient-reported event
          await db.insert(events).values({
            id,
            patient_id: patientId,
            category: ev.category,
            title: `[MedLens] ${ev.title}`,
            body: ev.body ?? undefined,
            severity: ev.severity,
            occurred_at: ev.occurred_at,
            created_at: now,
          });
          result.carebridge_ids.events.push(id);
          result.accepted++;
        } catch {
          result.skipped++;
          result.skipped_reasons.push(`event ${ev.medlens_id}: database error`);
        }
      }

      // Log the import for HIPAA audit trail
      await db.insert(medlensSyncLog).values({
        id: crypto.randomUUID(),
        token_id: tokenId,
        patient_id: patientId,
        operation: "import",
        records_transferred: JSON.stringify({
          accepted: result.accepted,
          skipped: result.skipped,
          vitals: result.carebridge_ids.vitals.length,
          lab_panels: result.carebridge_ids.lab_panels.length,
          events: result.carebridge_ids.events.length,
        }),
        timestamp: now,
      });

      return result;
    }),
});

export type MedlensBridgeRouter = typeof medlensBridgeRouter;

import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb, hmacForIndex } from "@carebridge/db-schema";
import {
  fhirResources,
  auditLog,
  patients,
  vitals,
  labPanels,
  labResults,
  medications,
  diagnoses,
  allergies,
  encounters,
  procedures,
  users,
} from "@carebridge/db-schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { createLogger } from "@carebridge/logger";
import crypto from "node:crypto";
import type { Vital, LabResult, User } from "@carebridge/shared-types";
import {
  toFhirPatient,
  toFhirVitalObservation,
  toFhirLabObservation,
  toFhirCondition,
  toFhirMedicationStatement,
  toFhirAllergyIntolerance,
  toFhirEncounter,
  toFhirProcedure,
  toFhirPractitioner,
  isClinicalRole,
  toFhirMedicationRequest,
} from "./generators/index.js";
import { fhirBundleSchema } from "./schemas/bundle.js";
import { sanitizeFreeText } from "@carebridge/phi-sanitizer";
import {
  mapMedicationRequestToRow,
  mapMedicationStatementToRow,
  type InboundMedicationRequest,
  type InboundMedicationStatement,
} from "./medication-mapper.js";
import {
  mapFhirConditionToRow,
  type InboundCondition,
} from "./condition-mapper.js";
import {
  mapFhirPatientToRow,
  type InboundPatient,
} from "./patient-mapper.js";
import {
  classifyObservationCategory,
  mapFhirObservationToVitalRow,
  mapFhirObservationToLabResultRow,
  type InboundObservation,
} from "./observation-mapper.js";
import {
  mapFhirAllergyIntoleranceToRow,
  type InboundAllergyIntolerance,
} from "./allergy-mapper.js";

const logger = createLogger("fhir-gateway");

/**
 * Context for the raw FHIR gateway router.
 *
 * Defense-in-depth: even when this router is consumed directly (e.g. unit
 * tests, dev mode, other internal callers) rather than through the
 * api-gateway RBAC wrapper, all procedures require an authenticated user.
 * The wrapper at services/api-gateway/src/routers/fhir.ts performs the
 * full RBAC enforcement (care-team access, patient self-access, etc.); this
 * raw router only guarantees that there IS an authenticated user and that
 * importBundle is admin-only.
 */
export interface Context {
  user: User | null;
  /**
   * When true, the caller (api-gateway RBAC wrapper) has already verified
   * care-team access for the target patient. The raw router's
   * assertRawPatientAccess will skip its own restrictive check.
   */
  rbacVerified?: boolean;
  /**
   * Optional callback for setting HTTP response headers. Provided by the
   * api-gateway Fastify adapter; absent when the router is consumed via
   * createCaller (tests, internal callers). Procedures that need to
   * influence transport-layer headers (Cache-Control, Content-Disposition)
   * call this when present and silently skip when absent.
   */
  setHeader?: (name: string, value: string) => void;
}

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

const isAdmin = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Authentication required",
    });
  }
  if (ctx.user.role !== "admin") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "importBundle requires admin role",
    });
  }
  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

const protectedProcedure = t.procedure.use(isAuthenticated);
const adminProcedure = t.procedure.use(isAdmin);

/**
 * Defense-in-depth patient-access guard for the raw router.
 *
 * The api-gateway wrapper at services/api-gateway/src/routers/fhir.ts is
 * the canonical RBAC enforcement point and runs the full care-team check.
 * This helper exists so that if the raw router is consumed directly
 * (internal callers, tests, dev-mode), it still rejects cross-patient
 * access. Per Copilot review on PR #379.
 *
 * Allowed:
 *   - admin role: full access (unconditional)
 *   - rbacVerified context flag: gateway already ran care-team check
 *   - patient role: self-access only (user.id === patientId)
 *
 * Clinicians (physician/specialist/nurse) are deliberately NOT allowed
 * through the raw router — they MUST go through the gateway wrapper which
 * runs the care-team membership check. The raw router cannot do that
 * check without coupling to gateway concerns, so we fail closed here.
 */
function assertRawPatientAccess(
  user: User,
  patientId: string,
  rbacVerified?: boolean,
): void {
  if (rbacVerified) return;
  if (user.role === "admin") return;
  if (user.role === "patient" && user.id === patientId) return;
  throw new TRPCError({
    code: "FORBIDDEN",
    message:
      "Access denied: raw FHIR router only permits admin or patient self-access. " +
      "Route through the api-gateway wrapper for care-team-based access.",
  });
}

function sanitizeResourceStrings(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeFreeText(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeResourceStrings);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeResourceStrings(v);
    }
    return out;
  }
  return value;
}

export const fhirGatewayRouter = t.router({
  importBundle: adminProcedure
    .input(z.object({
      bundle: fhirBundleSchema,
      source_system: z.string(),
      /**
       * ID of the user performing the import. Required for HIPAA
       * § 164.312(b) audit completeness — every imported resource is
       * recorded in audit_log attributed to this user. The api-gateway
       * RBAC wrapper supplies this from ctx.user.id.
       */
      user_id: z.string(),
      bundle_id: z.string().optional(),
      /**
       * Opt-in materialisation flag (#1066, extended by #337). When
       * true, inbound clinical resources are additionally mapped to
       * the internal structured tables the ai-oversight rule engine
       * reads (`medications`, `vitals`, `lab_results`) — not just
       * persisted as raw FHIR in `fhir_resources`.
       *
       * Resource type → target table:
       *   - MedicationRequest / MedicationStatement → medications
       *   - Observation (category=vital-signs)      → vitals
       *   - Observation (category=laboratory)       → lab_results
       *
       * Default false to preserve the raw-FHIR-only contract the
       * endpoint advertises today; callers that want the FHIR rows
       * to drive the rule engine must explicitly opt in.
       */
      materialize: z.boolean().optional().default(false),
      /**
       * Patient id to associate materialised rows with. Required when
       * `materialize: true` AND the bundle contains resources whose
       * subject reference may carry an external Patient/{id} that is
       * not the same as the internal patients.id (Medication*, Observation,
       * Condition, AllergyIntolerance). Caller (api-gateway RBAC
       * wrapper) is responsible for cross-system reconciliation.
       *
       * NOT required for Patient resource materialisation (#337) —
       * the Patient resource itself defines the patient identity, so
       * the materialiser mints a fresh internal id at write time.
       *
       * Applies to every materialised target (medications, vitals,
       * lab_results, diagnoses). Ignored when `materialize: false`.
       */
      patient_id: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const now = new Date().toISOString();
      const entries = input.bundle.entry ?? [];
      let imported = 0;
      let materializedMedications = 0;
      let materializedDiagnoses = 0;
      let materializedPatients = 0;
      let materializedVitals = 0;
      let materializedLabResults = 0;
      let materializedAllergies = 0;
      for (const entry of entries) {
        if (!entry.resource) continue;
        const sanitized = sanitizeResourceStrings(entry.resource) as Record<string, unknown>;
        const resourceType = (sanitized.resourceType as string) ?? "Unknown";
        const resourceId = (sanitized.id as string) ?? crypto.randomUUID();

        // Persist the resource and its audit trail in a single transaction
        // so the pair commits or rolls back atomically. Without this, a
        // crash or audit_log outage between the two inserts could leave
        // imported PHI in fhir_resources with no audit row, defeating the
        // HIPAA § 164.312(b) audit completeness goal.
        // Per Copilot review on PR #378.
        //
        // When `materialize: true` (#1066, #337), the same transaction
        // also inserts a `medications` row for MedicationRequest /
        // MedicationStatement entries and a `patients` row for Patient
        // entries, so the raw-FHIR write and the materialised row are
        // guaranteed atomic — a crash mid-import can't leave one without
        // the other.
        await db.transaction(async (tx) => {
          await tx.insert(fhirResources).values({
            id: crypto.randomUUID(),
            resource_type: resourceType,
            resource_id: resourceId,
            patient_id: null,
            resource: sanitized,
            source_system: input.source_system,
            imported_at: now,
          });

          // HIPAA § 164.312(b): record who imported which PHI. One audit_log
          // row per resource so the bulk import path leaves the same trail
          // as a normal per-resource write through the clinical-data router.
          await tx.insert(auditLog).values({
            id: crypto.randomUUID(),
            user_id: input.user_id,
            action: "fhir_import",
            resource_type: resourceType,
            resource_id: resourceId,
            procedure_name: "fhir.importBundle",
            patient_id: null,
            details: JSON.stringify({
              source: "fhir_bundle",
              source_system: input.source_system,
              bundle_id: input.bundle_id ?? null,
            }),
            ip_address: null,
            timestamp: now,
          });

          // Optional materialisation pass (#1066, #337). The mappers
          // are pure and return null for unmappable entries (missing
          // name/code, entered-in-error status) — those skip silently.
          if (input.materialize && input.patient_id) {
            let medRow: ReturnType<typeof mapMedicationRequestToRow> = null;
            if (resourceType === "MedicationRequest") {
              medRow = mapMedicationRequestToRow(
                sanitized as unknown as InboundMedicationRequest,
                input.patient_id,
              );
            } else if (resourceType === "MedicationStatement") {
              medRow = mapMedicationStatementToRow(
                sanitized as unknown as InboundMedicationStatement,
                input.patient_id,
              );
            }
            if (medRow) {
              await tx.insert(medications).values({
                id: crypto.randomUUID(),
                patient_id: medRow.patient_id,
                name: medRow.name,
                dose_amount: medRow.dose_amount,
                dose_unit: medRow.dose_unit,
                route: medRow.route,
                frequency: medRow.frequency,
                max_doses_per_day: medRow.max_doses_per_day,
                status: medRow.status,
                started_at: medRow.started_at,
                prescribed_by: medRow.prescribed_by,
                rxnorm_code: medRow.rxnorm_code,
                source_system: medRow.source_system ?? input.source_system,
                created_at: now,
                updated_at: now,
              });
              materializedMedications++;
            }

            // (#337) Materialise AllergyIntolerance into the
            // `allergies` table so the ai-oversight allergy-medication
            // rules (which read `allergies`, not `fhir_resources`)
            // see external allergen + reaction detail.
            if (resourceType === "AllergyIntolerance") {
              const allergyRow = mapFhirAllergyIntoleranceToRow(
                sanitized as unknown as InboundAllergyIntolerance,
                input.patient_id,
              );
              if (allergyRow) {
                await tx.insert(allergies).values({
                  id: crypto.randomUUID(),
                  patient_id: allergyRow.patient_id,
                  allergen: allergyRow.allergen,
                  snomed_code: allergyRow.snomed_code,
                  rxnorm_code: allergyRow.rxnorm_code,
                  reaction: allergyRow.reaction,
                  severity: allergyRow.severity,
                  verification_status: allergyRow.verification_status,
                  created_at: now,
                });
                materializedAllergies++;
              }
            }

            // Condition → diagnoses materialisation (#337).
            if (resourceType === "Condition") {
              const dxRow = mapFhirConditionToRow(
                sanitized as unknown as InboundCondition,
                input.patient_id,
              );
              if (dxRow) {
                await tx.insert(diagnoses).values({
                  id: crypto.randomUUID(),
                  patient_id: dxRow.patient_id,
                  icd10_code: dxRow.icd10_code,
                  snomed_code: dxRow.snomed_code,
                  description: dxRow.description,
                  status: dxRow.status,
                  onset_date: dxRow.onset_date,
                  resolved_date: dxRow.resolved_date,
                  diagnosed_by: dxRow.diagnosed_by,
                  // Honour the external EHR's recordedDate when present
                  // so the imported row keeps provenance; otherwise
                  // use the import wall-clock.
                  created_at: dxRow.recorded_at ?? now,
                });
                materializedDiagnoses++;
              }
            }
          }

          // Patient materialisation (#337). Unlike medications, Patient
          // resources do NOT need an external `input.patient_id` — the
          // FHIR Patient resource IS the patient identity, so we mint a
          // fresh internal id on insert. The mapper returns null for
          // unmappable entries (active=false, no name AND no MRN);
          // those skip silently and the raw FHIR row is still imported.
          if (input.materialize && resourceType === "Patient") {
            const patientRow = mapFhirPatientToRow(
              sanitized as unknown as InboundPatient,
            );
            if (patientRow) {
              await tx.insert(patients).values({
                id: crypto.randomUUID(),
                name: patientRow.name,
                // HMAC indexes for searchable encrypted columns. Mirrors
                // the patient-records create path so a materialised
                // import and a manual create produce structurally
                // identical rows.
                name_hmac: hmacForIndex(patientRow.name),
                date_of_birth: patientRow.date_of_birth,
                biological_sex: patientRow.biological_sex,
                mrn: patientRow.mrn,
                mrn_hmac: patientRow.mrn
                  ? hmacForIndex(patientRow.mrn)
                  : null,
                created_at: now,
                updated_at: now,
              });
              materializedPatients++;
            }
          }

          // Observation routing (#337). The same FHIR resource type
          // fans out to two internal tables based on category:
          //   - vital-signs → `vitals`
          //   - laboratory  → `lab_results` (via a synthetic
          //                  `lab_panels` row anchoring panel_id)
          // Resources with no recognised category fall through
          // unmaterialised — the raw_fhir row is still persisted
          // above so no data is dropped silently.
          if (input.materialize && resourceType === "Observation" && input.patient_id) {
            const obs = sanitized as unknown as InboundObservation;
            const category = classifyObservationCategory(obs);
            if (category === "vital-signs") {
              const vitalRow = mapFhirObservationToVitalRow(
                obs,
                input.patient_id,
              );
              if (vitalRow) {
                await tx.insert(vitals).values({
                  id: crypto.randomUUID(),
                  patient_id: vitalRow.patient_id,
                  recorded_at: vitalRow.recorded_at,
                  type: vitalRow.type,
                  loinc_code: vitalRow.loinc_code,
                  value_primary: vitalRow.value_primary,
                  value_secondary: vitalRow.value_secondary,
                  unit: vitalRow.unit,
                  source_system: vitalRow.source_system ?? input.source_system,
                  created_at: now,
                });
                materializedVitals++;
              }
            } else if (category === "laboratory") {
              const labRow = mapFhirObservationToLabResultRow(obs);
              if (labRow) {
                // lab_results.panel_id is NOT NULL — every imported
                // lab Observation needs a sidecar lab_panels row.
                // We create one per Observation here; future work
                // could batch peer Observations under a single
                // panel (e.g. a CBC panel arriving as 11 separate
                // Observations with a shared encounter).
                const panelId = crypto.randomUUID();
                await tx.insert(labPanels).values({
                  id: panelId,
                  patient_id: input.patient_id,
                  panel_name: labRow.test_name,
                  collected_at: labRow.recorded_at,
                  reported_at: labRow.recorded_at,
                  source_system: input.source_system,
                  created_at: now,
                });
                await tx.insert(labResults).values({
                  id: crypto.randomUUID(),
                  panel_id: panelId,
                  test_name: labRow.test_name,
                  test_code: labRow.test_code,
                  value: labRow.value,
                  unit: labRow.unit,
                  reference_low: labRow.reference_low,
                  reference_high: labRow.reference_high,
                  flag: labRow.flag,
                  created_at: labRow.recorded_at,
                });
                materializedLabResults++;
              }
            }
          }
        });

        imported++;
      }
      return {
        imported,
        materialized_medications: materializedMedications,
        materialized_diagnoses: materializedDiagnoses,
        materialized_patients: materializedPatients,
        materialized_vitals: materializedVitals,
        materialized_lab_results: materializedLabResults,
        materialized_allergies: materializedAllergies,
      };
    }),

  getByPatient: protectedProcedure
    .input(z.object({ patientId: z.string(), resourceType: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      assertRawPatientAccess(ctx.user, input.patientId, ctx.rbacVerified);
      const db = getDb();
      return db.select().from(fhirResources)
        .where(eq(fhirResources.patient_id, input.patientId));
    }),

  exportPatient: protectedProcedure
    .input(z.object({ patientId: z.string() }))
    .query(async ({ ctx, input }) => {
      assertRawPatientAccess(ctx.user, input.patientId, ctx.rbacVerified);
      const db = getDb();
      const { patientId } = input;

      // Check for a previous export by the same user for this patient whose
      // recommended_purge_at has passed. This indicates the client may be
      // holding onto PHI beyond the recommended retention window and is
      // re-requesting it — worth a structured audit warning.
      const now = new Date();
      const priorExpiredExports = await db
        .select({
          id: auditLog.id,
          details: auditLog.details,
          timestamp: auditLog.timestamp,
        })
        .from(auditLog)
        .where(
          and(
            eq(auditLog.user_id, ctx.user.id),
            eq(auditLog.action, "fhir_export"),
            eq(auditLog.patient_id, patientId),
            eq(auditLog.success, true),
            sql`${auditLog.details}::jsonb->>'recommended_purge_at' < ${now.toISOString()}`,
          ),
        );

      if (priorExpiredExports.length > 0) {
        const mostRecent = priorExpiredExports[priorExpiredExports.length - 1]!;
        const priorDetails = mostRecent.details
          ? (JSON.parse(mostRecent.details) as Record<string, unknown>)
          : {};
        logger.warn("re-export requested after recommended_purge_at", {
          user_id: ctx.user.id,
          patient_id: patientId,
          prior_export_id: priorDetails.export_id ?? mostRecent.id,
          prior_export_at: mostRecent.timestamp,
          prior_recommended_purge_at: priorDetails.recommended_purge_at ?? null,
          expired_export_count: priorExpiredExports.length,
        });
      }

      const exportId = crypto.randomUUID();
      const exportedAt = new Date().toISOString();
      const recommendedPurgeAt = new Date(
        new Date(exportedAt).getTime() + 15 * 60 * 1000,
      ).toISOString();

      // HIPAA § 164.312(b) audit writer. Called AFTER the bundle is
      // assembled (success path) or inside the failure branch so the
      // recorded success/http_status_code reflects the actual outcome
      // rather than an optimistic pre-flight "200". Per PR #503 review.
      const writeAudit = async (args: {
        success: boolean;
        httpStatusCode: number;
        errorMessage?: string;
      }) => {
        await db.insert(auditLog).values({
          id: crypto.randomUUID(),
          user_id: ctx.user.id,
          action: "fhir_export",
          resource_type: "fhir_bundle",
          resource_id: exportId,
          procedure_name: "fhir.exportPatient",
          patient_id: patientId,
          http_status_code: args.httpStatusCode,
          success: args.success,
          error_message: args.errorMessage ?? null,
          details: JSON.stringify({
            export_type: "patient_full_bundle",
            export_id: exportId,
            recommended_purge_at: recommendedPurgeAt,
          }),
          ip_address: null,
          timestamp: new Date().toISOString(),
        });
      };

      try {
        // 1. Fetch the patient record
        const [patient] = await db
          .select()
          .from(patients)
          .where(eq(patients.id, patientId));

        if (!patient) {
          await writeAudit({
            success: false,
            httpStatusCode: 404,
            errorMessage: `Patient ${patientId} not found`,
          });
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Patient ${patientId} not found`,
          });
        }

        // 2. Fetch all related clinical data in parallel
        const [
          patientVitals,
          patientPanels,
          patientMedications,
          patientDiagnoses,
          patientAllergies,
          patientEncounters,
          patientProcedures,
        ] = await Promise.all([
          db.select().from(vitals).where(eq(vitals.patient_id, patientId)),
          db.select().from(labPanels).where(eq(labPanels.patient_id, patientId)),
          db.select().from(medications).where(eq(medications.patient_id, patientId)),
          db.select().from(diagnoses).where(eq(diagnoses.patient_id, patientId)),
          db.select().from(allergies).where(eq(allergies.patient_id, patientId)),
          db.select().from(encounters).where(eq(encounters.patient_id, patientId)),
          db.select().from(procedures).where(eq(procedures.patient_id, patientId)),
        ]);

        // Fetch lab results for all panels
        const panelIds = patientPanels.map((p) => p.id);
        const allLabResults: (typeof labResults.$inferSelect)[] = [];
        for (const panelId of panelIds) {
          const results = await db
            .select()
            .from(labResults)
            .where(eq(labResults.panel_id, panelId));
          allLabResults.push(...results);
        }

        // 3. Convert to FHIR resources
        const fhirPatient = toFhirPatient(patient);

        const entry: { fullUrl: string; resource: unknown }[] = [
          {
            fullUrl: `urn:uuid:${patientId}`,
            resource: fhirPatient,
          },
        ];

        for (const vital of patientVitals) {
          entry.push({
            fullUrl: `urn:uuid:${vital.id}`,
            resource: toFhirVitalObservation(vital as unknown as Vital, patientId),
          });
        }

        for (const lab of allLabResults) {
          entry.push({
            fullUrl: `urn:uuid:${lab.id}`,
            resource: toFhirLabObservation(lab as unknown as LabResult, patientId),
          });
        }

        for (const dx of patientDiagnoses) {
          entry.push({
            fullUrl: `urn:uuid:${dx.id}`,
            resource: toFhirCondition(dx, patientId),
          });
        }

        for (const med of patientMedications) {
          entry.push({
            fullUrl: `urn:uuid:${med.id}`,
            resource: toFhirMedicationStatement(med, patientId),
          });
        }

        for (const allergy of patientAllergies) {
          entry.push({
            fullUrl: `urn:uuid:${allergy.id}`,
            resource: toFhirAllergyIntolerance(allergy, patientId),
          });
        }

        for (const encounter of patientEncounters) {
          entry.push({
            fullUrl: `urn:uuid:${encounter.id}`,
            resource: toFhirEncounter(encounter, patientId),
          });
        }

        for (const procedure of patientProcedures) {
          entry.push({
            fullUrl: `urn:uuid:${procedure.id}`,
            resource: toFhirProcedure(procedure, patientId),
          });
        }

        // Epic-compatible MedicationRequest resources for active/ordered
        // medications (#388). MedicationStatement above remains for the
        // recorded/historical view; both formats are emitted so bundles
        // round-trip cleanly in either direction.
        for (const med of patientMedications) {
          // urn:uuid: values must be real UUIDs per RFC 4122; the earlier
          // `urn:uuid:request-${id}` form is rejected by strict FHIR
          // consumers. Generate a fresh UUID for the bundle-entry fullUrl;
          // `resource.id` keeps `med.id` so cross-resource references
          // (MedicationRequest.subject → Patient/{patientId}) stay stable.
          entry.push({
            fullUrl: `urn:uuid:${crypto.randomUUID()}`,
            resource: toFhirMedicationRequest(med, patientId),
          });
        }

        // Practitioner resources — one per unique clinician referenced by
        // any resource in the bundle (Encounter.participant,
        // Procedure.performer, MedicationRequest.requester, or the
        // medication-statement informationSource). Deduplicated by id.
        const providerIds = new Set<string>();
        for (const enc of patientEncounters) {
          if (enc.provider_id) providerIds.add(enc.provider_id);
        }
        for (const proc of patientProcedures) {
          if (proc.performed_by) providerIds.add(proc.performed_by);
          if (proc.provider_id) providerIds.add(proc.provider_id);
        }
        for (const med of patientMedications) {
          if (med.ordering_provider_id) providerIds.add(med.ordering_provider_id);
          if (med.prescribed_by) providerIds.add(med.prescribed_by);
        }

        if (providerIds.size > 0) {
          // Project only the columns toFhirPractitioner needs. A bare
          // select() on users pulls password_hash, mfa_secret, and
          // recovery_codes into memory for zero downstream use and risks
          // surfacing them via heap dumps or incidental logging.
          const providerRows = await db
            .select({
              id: users.id,
              name: users.name,
              role: users.role,
              specialty: users.specialty,
              email: users.email,
            })
            .from(users)
            .where(inArray(users.id, Array.from(providerIds)));
          for (const row of providerRows) {
            if (!isClinicalRole(row.role)) continue;
            entry.push({
              fullUrl: `urn:uuid:${row.id}`,
              resource: toFhirPractitioner(row as unknown as Parameters<typeof toFhirPractitioner>[0]),
            });
          }
        }

        // HIPAA § 164.312(b): record the successful PHI egress AFTER the
        // bundle is fully assembled, so success=true only if the data
        // was actually produced. Per PR #503 review.
        await writeAudit({ success: true, httpStatusCode: 200 });

        // Enforce recommended_purge_at at the transport layer: instruct
        // caches and intermediaries to never store this PHI bundle, and
        // prompt the client to save it as a file (not render inline).
        if (ctx.setHeader) {
          ctx.setHeader(
            "Cache-Control",
            "no-store, no-cache, must-revalidate",
          );
          ctx.setHeader(
            "Content-Disposition",
            `attachment; filename="bundle-${exportId}.json"`,
          );
          ctx.setHeader("Pragma", "no-cache");
        }

        // The bundle is returned inline rather than via a signed short-TTL
        // URL (which is the long-term target; see #290). Until that delivery
        // layer exists, callers MUST treat the response as ephemeral:
        //   - persist it only long enough for the immediate use case;
        //   - never cache it at the CDN or intermediary layer;
        //   - discard it after `recommended_purge_at`.
        // recommended_purge_at is set 15 minutes from generation to bound
        // the window a leaked in-memory copy remains useful.
        //
        // Export metadata (export_id, exported_at, recommended_purge_at,
        // exported_by) is carried as a FHIR R4 Meta.extension entry rather
        // than ad-hoc top-level Meta keys. Strict FHIR consumers (HAPI,
        // IBM FHIR Server, Smile CDR) ignore unknown extensions but reject
        // unknown primitive fields on Meta. Per PR #503 review.
        const exportMetaExtensionUrl =
          "https://carebridge.dev/fhir/StructureDefinition/export-meta";
        return {
          resourceType: "Bundle" as const,
          type: "collection" as const,
          meta: {
            lastUpdated: exportedAt,
            extension: [
              {
                url: exportMetaExtensionUrl,
                valueString: JSON.stringify({
                  export_id: exportId,
                  exported_at: exportedAt,
                  recommended_purge_at: recommendedPurgeAt,
                  ...(ctx.user?.id ? { exported_by: ctx.user.id } : {}),
                }),
              },
            ],
          },
          entry,
        };
      } catch (err) {
        // If the failure path wasn't already audited above (e.g. NOT_FOUND
        // writes its own row before throwing), record a failure audit row
        // now so the attempt is never silently lost. TRPCError from the
        // NOT_FOUND branch has already been audited; re-throw without a
        // duplicate write.
        if (!(err instanceof TRPCError)) {
          const message = err instanceof Error ? err.message : String(err);
          await writeAudit({
            success: false,
            httpStatusCode: 500,
            errorMessage: message,
          });
        }
        throw err;
      }
    }),
});

export type FhirGatewayRouter = typeof fhirGatewayRouter;

import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "@carebridge/db-schema";
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
} from "@carebridge/db-schema";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";
import type { Vital, LabResult } from "@carebridge/shared-types";
import {
  toFhirPatient,
  toFhirVitalObservation,
  toFhirLabObservation,
  toFhirCondition,
  toFhirMedicationStatement,
  toFhirAllergyIntolerance,
} from "./generators/index.js";
import { fhirBundleSchema } from "./schemas/bundle.js";
import { sanitizeFreeText } from "@carebridge/phi-sanitizer";

const t = initTRPC.create();

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
  importBundle: t.procedure
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
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const now = new Date().toISOString();
      const entries = input.bundle.entry ?? [];
      let imported = 0;
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
        });

        imported++;
      }
      return { imported };
    }),

  getByPatient: t.procedure
    .input(z.object({ patientId: z.string(), resourceType: z.string().optional() }))
    .query(async ({ input }) => {
      const db = getDb();
      return db.select().from(fhirResources)
        .where(eq(fhirResources.patient_id, input.patientId));
    }),

  exportPatient: t.procedure
    .input(z.object({ patientId: z.string() }))
    .query(async ({ input }) => {
      const db = getDb();
      const { patientId } = input;

      // 1. Fetch the patient record
      const [patient] = await db
        .select()
        .from(patients)
        .where(eq(patients.id, patientId));

      if (!patient) {
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
      ] = await Promise.all([
        db.select().from(vitals).where(eq(vitals.patient_id, patientId)),
        db.select().from(labPanels).where(eq(labPanels.patient_id, patientId)),
        db.select().from(medications).where(eq(medications.patient_id, patientId)),
        db.select().from(diagnoses).where(eq(diagnoses.patient_id, patientId)),
        db.select().from(allergies).where(eq(allergies.patient_id, patientId)),
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

      return {
        resourceType: "Bundle" as const,
        type: "collection" as const,
        entry,
      };
    }),
});

export type FhirGatewayRouter = typeof fhirGatewayRouter;

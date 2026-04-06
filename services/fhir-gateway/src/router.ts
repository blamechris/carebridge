import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "@carebridge/db-schema";
import {
  fhirResources,
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

const t = initTRPC.create();

export const fhirGatewayRouter = t.router({
  importBundle: t.procedure
    .input(z.object({
      bundle: z.any(), // FHIR Bundle JSON — full parsing in future
      source_system: z.string(),
    }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const now = new Date().toISOString();
      // Stub: store raw bundle entries as fhir_resources
      const bundle = input.bundle as { entry?: { resource?: Record<string, unknown> }[] };
      const entries = bundle.entry ?? [];
      let imported = 0;
      for (const entry of entries) {
        if (!entry.resource) continue;
        const resource = entry.resource;
        await db.insert(fhirResources).values({
          id: crypto.randomUUID(),
          resource_type: (resource.resourceType as string) ?? "Unknown",
          resource_id: (resource.id as string) ?? crypto.randomUUID(),
          patient_id: null,
          resource,
          source_system: input.source_system,
          imported_at: now,
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

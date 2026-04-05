import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getDb } from "@carebridge/db-schema";
import { fhirResources } from "@carebridge/db-schema";
import { eq } from "drizzle-orm";
import crypto from "node:crypto";

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
    .query(async () => {
      // Stub: will generate FHIR Bundle from internal data
      return { resourceType: "Bundle", type: "collection", entry: [] };
    }),
});

export type FhirGatewayRouter = typeof fhirGatewayRouter;

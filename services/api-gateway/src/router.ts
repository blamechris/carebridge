import { router, publicProcedure } from "./trpc.js";
import { authRouter } from "@carebridge/auth";
import { aiOversightRouter } from "@carebridge/ai-oversight";
import { notificationsRouter } from "@carebridge/notifications";
import { fhirGatewayRouter } from "@carebridge/fhir-gateway";
import { patientRecordsRbacRouter } from "./routers/patient-records.js";
import { clinicalDataRbacRouter } from "./routers/clinical-data.js";
import { clinicalNotesRbacRouter } from "./routers/clinical-notes.js";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      service: "api-gateway",
    };
  }),
  auth: authRouter,
  patients: patientRecordsRbacRouter,
  clinicalData: clinicalDataRbacRouter,
  notes: clinicalNotesRbacRouter,
  aiOversight: aiOversightRouter,
  notifications: notificationsRouter,
  fhir: fhirGatewayRouter,
});

export type AppRouter = typeof appRouter;

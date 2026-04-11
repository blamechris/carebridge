import { router, publicProcedure } from "./trpc.js";
import { authRouter, emergencyAccessRouter } from "@carebridge/auth";
import { aiOversightRouter } from "@carebridge/ai-oversight";
import { notificationsRouter } from "@carebridge/notifications";
import { messagingRouter } from "@carebridge/messaging";
import { patientRecordsRbacRouter } from "./routers/patient-records.js";
import { clinicalDataRbacRouter } from "./routers/clinical-data.js";
import { clinicalNotesRbacRouter } from "./routers/clinical-notes.js";
import { fhirRbacRouter } from "./routers/fhir.js";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      service: "api-gateway",
    };
  }),
  auth: authRouter,
  emergencyAccess: emergencyAccessRouter,
  patients: patientRecordsRbacRouter,
  clinicalData: clinicalDataRbacRouter,
  notes: clinicalNotesRbacRouter,
  aiOversight: aiOversightRouter,
  notifications: notificationsRouter,
  messaging: messagingRouter,
  fhir: fhirRbacRouter,
});

export type AppRouter = typeof appRouter;

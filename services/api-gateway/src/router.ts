import { router, publicProcedure } from "./trpc.js";
import { authRouter } from "@carebridge/auth";
import { aiOversightRouter } from "@carebridge/ai-oversight";
import { notificationsRouter } from "@carebridge/notifications";
import { patientRecordsRbacRouter } from "./routers/patient-records.js";
import { clinicalDataRbacRouter } from "./routers/clinical-data.js";
import { clinicalNotesRbacRouter } from "./routers/clinical-notes.js";
import { messagingRbacRouter } from "./routers/messaging.js";
import { schedulingRbacRouter } from "./routers/scheduling.js";
import { emergencyAccessRbacRouter } from "./routers/emergency-access.js";
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
  emergencyAccess: emergencyAccessRbacRouter,
  patients: patientRecordsRbacRouter,
  clinicalData: clinicalDataRbacRouter,
  notes: clinicalNotesRbacRouter,
  aiOversight: aiOversightRouter,
  notifications: notificationsRouter,
  messaging: messagingRbacRouter,
  scheduling: schedulingRbacRouter,
  fhir: fhirRbacRouter,
});

export type AppRouter = typeof appRouter;

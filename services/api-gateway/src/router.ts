import { router, publicProcedure } from "./trpc.js";
import { authRouter } from "@carebridge/auth";
import { patientRecordsRbacRouter } from "./routers/patient-records.js";
import { clinicalDataRbacRouter } from "./routers/clinical-data.js";
import { clinicalNotesRbacRouter } from "./routers/clinical-notes.js";
import { aiOversightRbacRouter } from "./routers/ai-oversight.js";
import { messagingRbacRouter } from "./routers/messaging.js";
import { schedulingRbacRouter } from "./routers/scheduling.js";
import { emergencyAccessRbacRouter } from "./routers/emergency-access.js";
import { fhirRbacRouter } from "./routers/fhir.js";
import { notificationsRbacRouter } from "./routers/notifications.js";

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
  aiOversight: aiOversightRbacRouter,
  notifications: notificationsRbacRouter,
  messaging: messagingRbacRouter,
  scheduling: schedulingRbacRouter,
  fhir: fhirRbacRouter,
});

export type AppRouter = typeof appRouter;

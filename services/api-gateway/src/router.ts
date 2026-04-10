import { router, publicProcedure } from "./trpc.js";
import { authRouter } from "@carebridge/auth";
import { aiOversightRouter } from "@carebridge/ai-oversight";
import { notificationsRouter } from "@carebridge/notifications";
import { patientRecordsRbacRouter } from "./routers/patient-records.js";
import { clinicalDataRbacRouter } from "./routers/clinical-data.js";
import { clinicalNotesRbacRouter } from "./routers/clinical-notes.js";
import { checkinsRbacRouter } from "./routers/checkins.js";
import { fhirRbacRouter } from "./routers/fhir.js";
import { familyAccessRouter } from "./routers/family-access.js";

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
  checkins: checkinsRbacRouter,
  aiOversight: aiOversightRouter,
  notifications: notificationsRouter,
  fhir: fhirRbacRouter,
  familyAccess: familyAccessRouter,
});

export type AppRouter = typeof appRouter;

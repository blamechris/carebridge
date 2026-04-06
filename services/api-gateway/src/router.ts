import { router, publicProcedure } from "./trpc.js";
import { authRouter } from "@carebridge/auth";
import { patientRecordsRouter } from "@carebridge/patient-records";
import { clinicalDataRouter } from "@carebridge/clinical-data";
import { clinicalNotesRouter } from "@carebridge/clinical-notes";
import { aiOversightRouter } from "@carebridge/ai-oversight";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      service: "api-gateway",
    };
  }),
  auth: authRouter,
  patients: patientRecordsRouter,
  clinicalData: clinicalDataRouter,
  notes: clinicalNotesRouter,
  aiOversight: aiOversightRouter,
});

export type AppRouter = typeof appRouter;

import { router, publicProcedure, mergeRouters } from "./trpc.js";
// ServiceContext import required so TypeScript can name the merged router type
import type { ServiceContext as _ServiceContext } from "@carebridge/shared-types";
import { authRouter } from "@carebridge/auth";
import { aiOversightRouter } from "@carebridge/ai-oversight";
import { clinicalDataRouter } from "@carebridge/clinical-data";
import { clinicalNotesRouter } from "@carebridge/clinical-notes";
import { patientRecordsRouter } from "@carebridge/patient-records";
import { fhirGatewayRouter, medlensBridgeRouter } from "@carebridge/fhir-gateway";
import { notificationsRouter } from "@carebridge/notifications";
import { schedulingRouter } from "@carebridge/scheduling";

const healthRouter = router({
  healthCheck: publicProcedure.query(() => {
    return {
      status: "ok" as const,
      timestamp: new Date().toISOString(),
      service: "api-gateway",
    };
  }),
});

export const appRouter = mergeRouters(
  healthRouter,
  authRouter,
  aiOversightRouter,
  clinicalDataRouter,
  clinicalNotesRouter,
  patientRecordsRouter,
  fhirGatewayRouter,
  medlensBridgeRouter,
  notificationsRouter,
  schedulingRouter,
);

export type AppRouter = typeof appRouter;

import { initTRPC } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();

// Placeholder — scheduling service will be implemented later
export const schedulingRouter = t.router({
  getByPatient: t.procedure
    .input(z.object({ patientId: z.string() }))
    .query(async () => {
      return []; // stub
    }),

  getByProvider: t.procedure
    .input(z.object({ providerId: z.string() }))
    .query(async () => {
      return []; // stub
    }),
});

export type SchedulingRouter = typeof schedulingRouter;

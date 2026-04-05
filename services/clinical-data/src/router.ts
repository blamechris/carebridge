import { initTRPC } from "@trpc/server";
import { z } from "zod";
import {
  createVitalSchema,
  vitalTypeSchema,
  createLabPanelSchema,
  createMedicationSchema,
  updateMedicationSchema,
  medStatusSchema,
  createProcedureSchema,
} from "@carebridge/validators";
import * as vitalRepo from "./repositories/vital-repo.js";
import * as labRepo from "./repositories/lab-repo.js";
import * as medicationRepo from "./repositories/medication-repo.js";
import * as procedureRepo from "./repositories/procedure-repo.js";

const t = initTRPC.create();

const vitalsRouter = t.router({
  create: t.procedure
    .input(createVitalSchema)
    .mutation(async ({ input }) => {
      return vitalRepo.createVital(input);
    }),

  getByPatient: t.procedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        type: vitalTypeSchema.optional(),
      }),
    )
    .query(async ({ input }) => {
      return vitalRepo.getVitalsByPatient(input.patientId, input.type);
    }),

  getLatest: t.procedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ input }) => {
      return vitalRepo.getLatestVitals(input.patientId);
    }),
});

const labsRouter = t.router({
  createPanel: t.procedure
    .input(createLabPanelSchema)
    .mutation(async ({ input }) => {
      return labRepo.createLabPanel(input);
    }),

  getByPatient: t.procedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ input }) => {
      return labRepo.getLabPanelsByPatient(input.patientId);
    }),

  getHistory: t.procedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        testName: z.string().min(1),
      }),
    )
    .query(async ({ input }) => {
      return labRepo.getLabResultHistory(input.patientId, input.testName);
    }),
});

const medicationsRouter = t.router({
  create: t.procedure
    .input(createMedicationSchema)
    .mutation(async ({ input }) => {
      return medicationRepo.createMedication(input);
    }),

  update: t.procedure
    .input(z.object({ id: z.string().uuid() }).merge(updateMedicationSchema))
    .mutation(async ({ input }) => {
      const { id, ...rest } = input;
      return medicationRepo.updateMedication(id, rest);
    }),

  getByPatient: t.procedure
    .input(
      z.object({
        patientId: z.string().uuid(),
        status: medStatusSchema.optional(),
      }),
    )
    .query(async ({ input }) => {
      return medicationRepo.getMedicationsByPatient(input.patientId, input.status);
    }),

  logAdmin: t.procedure
    .input(
      z.object({
        medicationId: z.string().uuid(),
        administeredAt: z.string().datetime(),
        doseAmount: z.number().positive().optional(),
        doseUnit: z.string().max(20).optional(),
        administeredBy: z.string().uuid().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      return medicationRepo.logAdministration(
        input.medicationId,
        input.administeredAt,
        input.doseAmount,
        input.doseUnit,
        input.administeredBy,
      );
    }),
});

const proceduresRouter = t.router({
  create: t.procedure
    .input(createProcedureSchema)
    .mutation(async ({ input }) => {
      return procedureRepo.createProcedure(input);
    }),

  getByPatient: t.procedure
    .input(z.object({ patientId: z.string().uuid() }))
    .query(async ({ input }) => {
      return procedureRepo.getProceduresByPatient(input.patientId);
    }),
});

export const clinicalDataRouter = t.router({
  vitals: vitalsRouter,
  labs: labsRouter,
  medications: medicationsRouter,
  procedures: proceduresRouter,
});

export type ClinicalDataRouter = typeof clinicalDataRouter;

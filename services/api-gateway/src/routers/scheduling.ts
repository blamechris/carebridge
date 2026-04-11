/**
 * RBAC-enforced scheduling router.
 *
 * Wraps scheduling procedures with authentication. Patients can only
 * view/manage their own appointments. Providers can manage their schedule.
 */

import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import { getDb } from "@carebridge/db-schema";
import { appointments, providerSchedules, scheduleBlocks } from "@carebridge/db-schema";
import { eq, and, gte, lte, desc, ne } from "drizzle-orm";
import crypto from "node:crypto";
import type { Context } from "../context.js";
import { assertCareTeamAccess } from "../middleware/rbac.js";

const t = initTRPC.context<Context>().create();

const isAuthenticated = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return next({ ctx: { ...ctx, user: ctx.user } });
});

const protectedProcedure = t.procedure.use(isAuthenticated);

export const schedulingRbacRouter = t.router({
  appointments: t.router({
    listByPatient: protectedProcedure
      .input(z.object({ patientId: z.string() }))
      .query(async ({ ctx, input }) => {
        // Patients can only see their own
        if (ctx.user.role === "patient" && ctx.user.id !== input.patientId) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Access denied" });
        }
        // Clinicians must be on care team
        if (ctx.user.role !== "patient" && ctx.user.role !== "admin") {
          const hasAccess = await assertCareTeamAccess(ctx.user.id, input.patientId);
          if (!hasAccess) {
            throw new TRPCError({ code: "FORBIDDEN", message: "No care team access" });
          }
        }
        const db = getDb();
        return db.select().from(appointments)
          .where(eq(appointments.patient_id, input.patientId))
          .orderBy(desc(appointments.start_time));
      }),

    listByProvider: protectedProcedure
      .input(z.object({ startDate: z.string(), endDate: z.string() }))
      .query(async ({ ctx, input }) => {
        // Providers see their own schedule; admins could see anyone's
        const providerId = ctx.user.id;
        const db = getDb();
        return db.select().from(appointments)
          .where(
            and(
              eq(appointments.provider_id, providerId),
              gte(appointments.start_time, input.startDate),
              lte(appointments.start_time, input.endDate),
            ),
          )
          .orderBy(appointments.start_time);
      }),

    create: protectedProcedure
      .input(z.object({
        patientId: z.string(),
        providerId: z.string(),
        appointmentType: z.enum(["follow_up", "new_patient", "procedure", "telehealth"]),
        startTime: z.string(),
        endTime: z.string(),
        location: z.string().optional(),
        reason: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        const db = getDb();
        const now = new Date().toISOString();

        return db.transaction(async (tx) => {
          const overlapping = await tx.select().from(appointments)
            .where(
              and(
                eq(appointments.provider_id, input.providerId),
                ne(appointments.status, "cancelled"),
                lte(appointments.start_time, input.endTime),
                gte(appointments.end_time, input.startTime),
              ),
            );

          if (overlapping.length > 0) {
            throw new Error("Time slot conflicts with an existing appointment");
          }

          const appointment = {
            id: crypto.randomUUID(),
            patient_id: input.patientId,
            provider_id: input.providerId,
            appointment_type: input.appointmentType,
            start_time: input.startTime,
            end_time: input.endTime,
            status: "scheduled",
            location: input.location ?? null,
            reason: input.reason ?? null,
            created_at: now,
            updated_at: now,
          };

          await tx.insert(appointments).values(appointment);
          return appointment;
        });
      }),

    cancel: protectedProcedure
      .input(z.object({ appointmentId: z.string(), reason: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const db = getDb();
        const now = new Date().toISOString();
        await db.update(appointments)
          .set({
            status: "cancelled",
            cancelled_at: now,
            cancelled_by: ctx.user.id,
            cancel_reason: input.reason,
            updated_at: now,
          })
          .where(eq(appointments.id, input.appointmentId));
        return { success: true };
      }),
  }),

  schedule: t.router({
    availability: protectedProcedure
      .input(z.object({ providerId: z.string(), date: z.string() }))
      .query(async ({ input }) => {
        const db = getDb();
        const dayOfWeek = new Date(input.date).getDay();

        const [template] = await db.select().from(providerSchedules)
          .where(
            and(
              eq(providerSchedules.provider_id, input.providerId),
              eq(providerSchedules.day_of_week, dayOfWeek),
              eq(providerSchedules.is_active, "true"),
            ),
          );

        if (!template) return { slots: [] };

        const dayStart = `${input.date}T00:00:00.000Z`;
        const dayEnd = `${input.date}T23:59:59.999Z`;

        const existingAppts = await db.select().from(appointments)
          .where(
            and(
              eq(appointments.provider_id, input.providerId),
              ne(appointments.status, "cancelled"),
              gte(appointments.start_time, dayStart),
              lte(appointments.start_time, dayEnd),
            ),
          );

        const blocks = await db.select().from(scheduleBlocks)
          .where(
            and(
              eq(scheduleBlocks.provider_id, input.providerId),
              lte(scheduleBlocks.start_time, dayEnd),
              gte(scheduleBlocks.end_time, dayStart),
            ),
          );

        const slots: Array<{ start: string; end: string; available: boolean }> = [];
        const slotMinutes = template.slot_duration_minutes;
        const [startHour, startMin] = template.start_time.split(":").map(Number);
        const [endHour, endMin] = template.end_time.split(":").map(Number);

        const slotStart = new Date(`${input.date}T00:00:00.000Z`);
        slotStart.setUTCHours(startHour, startMin, 0, 0);
        const scheduleEnd = new Date(`${input.date}T00:00:00.000Z`);
        scheduleEnd.setUTCHours(endHour, endMin, 0, 0);

        while (slotStart < scheduleEnd) {
          const slotEnd = new Date(slotStart.getTime() + slotMinutes * 60 * 1000);
          const startISO = slotStart.toISOString();
          const endISO = slotEnd.toISOString();

          const hasConflict = existingAppts.some((appt) =>
            appt.start_time < endISO && appt.end_time > startISO,
          );
          const isBlocked = blocks.some((block) =>
            block.start_time < endISO && block.end_time > startISO,
          );

          slots.push({ start: startISO, end: endISO, available: !hasConflict && !isBlocked });
          slotStart.setTime(slotStart.getTime() + slotMinutes * 60 * 1000);
        }

        return { slots };
      }),

    setProviderSchedule: protectedProcedure
      .input(z.object({
        dayOfWeek: z.number().min(0).max(6),
        startTime: z.string(),
        endTime: z.string(),
        slotDurationMinutes: z.number().min(10).max(120).optional().default(30),
        location: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        if (ctx.user.role === "patient") {
          throw new TRPCError({ code: "FORBIDDEN", message: "Patients cannot set provider schedules" });
        }
        const db = getDb();
        const schedule = {
          id: crypto.randomUUID(),
          provider_id: ctx.user.id,
          day_of_week: input.dayOfWeek,
          start_time: input.startTime,
          end_time: input.endTime,
          slot_duration_minutes: input.slotDurationMinutes,
          location: input.location ?? null,
          is_active: "true",
          created_at: new Date().toISOString(),
        };
        await db.insert(providerSchedules).values(schedule);
        return schedule;
      }),
  }),
});

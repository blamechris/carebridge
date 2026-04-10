/**
 * Appointment scheduling tRPC router.
 *
 * Provides appointment CRUD, provider schedule management, and slot
 * availability calculation with double-booking prevention.
 */

import { initTRPC } from "@trpc/server";
import { z } from "zod";
import { getDb } from "@carebridge/db-schema";
import { appointments, providerSchedules, scheduleBlocks } from "@carebridge/db-schema";
import { eq, and, gte, lte, desc, ne } from "drizzle-orm";
import crypto from "node:crypto";

const t = initTRPC.create();

export const schedulingRouter = t.router({
  appointments: t.router({
    /** List appointments for a patient. */
    listByPatient: t.procedure
      .input(z.object({ patientId: z.string() }))
      .query(async ({ input }) => {
        const db = getDb();
        return db.select().from(appointments)
          .where(eq(appointments.patient_id, input.patientId))
          .orderBy(desc(appointments.start_time));
      }),

    /** List appointments for a provider on a date range. */
    listByProvider: t.procedure
      .input(z.object({
        providerId: z.string(),
        startDate: z.string(),
        endDate: z.string(),
      }))
      .query(async ({ input }) => {
        const db = getDb();
        return db.select().from(appointments)
          .where(
            and(
              eq(appointments.provider_id, input.providerId),
              gte(appointments.start_time, input.startDate),
              lte(appointments.start_time, input.endDate),
            ),
          )
          .orderBy(appointments.start_time);
      }),

    /** Create a new appointment with double-booking prevention. */
    create: t.procedure
      .input(z.object({
        patientId: z.string(),
        providerId: z.string(),
        appointmentType: z.enum(["follow_up", "new_patient", "procedure", "telehealth"]),
        startTime: z.string(),
        endTime: z.string(),
        location: z.string().optional(),
        reason: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const db = getDb();
        const now = new Date().toISOString();

        // Check for overlapping appointments (double-booking prevention)
        const overlapping = await db.select().from(appointments)
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

        await db.insert(appointments).values(appointment);
        return appointment;
      }),

    /** Cancel an appointment with reason. */
    cancel: t.procedure
      .input(z.object({
        appointmentId: z.string(),
        cancelledBy: z.string(),
        reason: z.string(),
      }))
      .mutation(async ({ input }) => {
        const db = getDb();
        const now = new Date().toISOString();

        await db.update(appointments)
          .set({
            status: "cancelled",
            cancelled_at: now,
            cancelled_by: input.cancelledBy,
            cancel_reason: input.reason,
            updated_at: now,
          })
          .where(eq(appointments.id, input.appointmentId));

        return { success: true };
      }),

    /** Reschedule an appointment (cancel + create new). */
    reschedule: t.procedure
      .input(z.object({
        appointmentId: z.string(),
        cancelledBy: z.string(),
        newStartTime: z.string(),
        newEndTime: z.string(),
      }))
      .mutation(async ({ input }) => {
        const db = getDb();
        const now = new Date().toISOString();

        // Get original appointment
        const [original] = await db.select().from(appointments)
          .where(eq(appointments.id, input.appointmentId));

        if (!original) throw new Error("Appointment not found");

        // Cancel original
        await db.update(appointments)
          .set({
            status: "cancelled",
            cancelled_at: now,
            cancelled_by: input.cancelledBy,
            cancel_reason: "Rescheduled",
            updated_at: now,
          })
          .where(eq(appointments.id, input.appointmentId));

        // Check for conflicts at new time
        const overlapping = await db.select().from(appointments)
          .where(
            and(
              eq(appointments.provider_id, original.provider_id),
              ne(appointments.status, "cancelled"),
              lte(appointments.start_time, input.newEndTime),
              gte(appointments.end_time, input.newStartTime),
            ),
          );

        if (overlapping.length > 0) {
          throw new Error("New time slot conflicts with an existing appointment");
        }

        // Create new appointment
        const newAppt = {
          id: crypto.randomUUID(),
          patient_id: original.patient_id,
          provider_id: original.provider_id,
          appointment_type: original.appointment_type,
          start_time: input.newStartTime,
          end_time: input.newEndTime,
          status: "scheduled",
          location: original.location,
          reason: original.reason,
          created_at: now,
          updated_at: now,
        };

        await db.insert(appointments).values(newAppt);
        return newAppt;
      }),
  }),

  schedule: t.router({
    /** Get available slots for a provider on a date. */
    availability: t.procedure
      .input(z.object({
        providerId: z.string(),
        date: z.string(), // ISO date string (YYYY-MM-DD)
      }))
      .query(async ({ input }) => {
        const db = getDb();
        const dayOfWeek = new Date(input.date).getDay();

        // Get provider's schedule template for this day
        const [template] = await db.select().from(providerSchedules)
          .where(
            and(
              eq(providerSchedules.provider_id, input.providerId),
              eq(providerSchedules.day_of_week, dayOfWeek),
              eq(providerSchedules.is_active, "true"),
            ),
          );

        if (!template) return { slots: [], message: "Provider has no schedule for this day" };

        // Get existing appointments for this date
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

        // Get blocks for this date
        const blocks = await db.select().from(scheduleBlocks)
          .where(
            and(
              eq(scheduleBlocks.provider_id, input.providerId),
              lte(scheduleBlocks.start_time, dayEnd),
              gte(scheduleBlocks.end_time, dayStart),
            ),
          );

        // Generate time slots
        const slots: Array<{ start: string; end: string; available: boolean }> = [];
        const slotMinutes = template.slot_duration_minutes;

        // Parse template hours
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

          // Check if slot overlaps with existing appointment
          const hasConflict = existingAppts.some((appt) =>
            appt.start_time < endISO && appt.end_time > startISO,
          );

          // Check if slot overlaps with a block
          const isBlocked = blocks.some((block) =>
            block.start_time < endISO && block.end_time > startISO,
          );

          slots.push({
            start: startISO,
            end: endISO,
            available: !hasConflict && !isBlocked,
          });

          slotStart.setTime(slotStart.getTime() + slotMinutes * 60 * 1000);
        }

        return { slots };
      }),

    /** Set provider schedule template. */
    setProviderSchedule: t.procedure
      .input(z.object({
        providerId: z.string(),
        dayOfWeek: z.number().min(0).max(6),
        startTime: z.string(), // HH:MM
        endTime: z.string(), // HH:MM
        slotDurationMinutes: z.number().min(10).max(120).optional().default(30),
        location: z.string().optional(),
      }))
      .mutation(async ({ input }) => {
        const db = getDb();
        const now = new Date().toISOString();

        const schedule = {
          id: crypto.randomUUID(),
          provider_id: input.providerId,
          day_of_week: input.dayOfWeek,
          start_time: input.startTime,
          end_time: input.endTime,
          slot_duration_minutes: input.slotDurationMinutes,
          location: input.location ?? null,
          is_active: "true",
          created_at: now,
        };

        await db.insert(providerSchedules).values(schedule);
        return schedule;
      }),
  }),
});

export type SchedulingRouter = typeof schedulingRouter;

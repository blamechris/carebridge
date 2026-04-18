/**
 * RBAC-enforced scheduling router.
 *
 * Wraps scheduling procedures with authentication. Patients can only
 * view/manage their own appointments. Providers can manage their schedule.
 *
 * Patient-ownership enforcement on mutations (HIPAA):
 *  - appointments.create / appointments.cancel both resolve the target
 *    patient record id and run the same access check used by
 *    appointments.listByPatient before touching the database. The check
 *    mirrors patient-records.enforcePatientAccess:
 *      - admin: unrestricted
 *      - patient: own record only
 *      - family_caregiver: active family_relationships row joined through
 *        users.patient_id
 *      - clinicians: active care-team assignment (assertCareTeamAccess)
 */

import { z } from "zod";
import { TRPCError, initTRPC } from "@trpc/server";
import { getDb } from "@carebridge/db-schema";
import {
  appointments,
  providerSchedules,
  scheduleBlocks,
  familyRelationships,
  users,
} from "@carebridge/db-schema";
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

/**
 * Resolve whether a family caregiver user currently has an active
 * family_relationships row granting them access to the given patient
 * record id.
 *
 * family_relationships.patient_id references users.id (the patient's
 * user account), but appointments.patient_id references patients.id,
 * so the query joins through users to close the mapping.
 */
async function hasActiveFamilyLink(
  caregiverUserId: string,
  patientRecordId: string,
): Promise<boolean> {
  const db = getDb();
  const [row] = await db
    .select({ id: familyRelationships.id })
    .from(familyRelationships)
    .innerJoin(users, eq(users.id, familyRelationships.patient_id))
    .where(
      and(
        eq(familyRelationships.caregiver_id, caregiverUserId),
        eq(users.patient_id, patientRecordId),
        eq(familyRelationships.status, "active"),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Enforce HIPAA minimum-necessary access for a given user / patientId pair
 * on scheduling mutations. Throws TRPCError(FORBIDDEN) on denial.
 *
 * Role semantics mirror patient-records.enforcePatientAccess so a caller
 * who can read a patient's appointments can also mutate them through the
 * same authorisation boundary.
 */
async function enforcePatientAccess(
  user: NonNullable<Context["user"]>,
  patientId: string,
): Promise<void> {
  if (user.role === "admin") return;

  if (user.role === "patient") {
    // user.patient_id is the canonical mapping; fall back to user.id for
    // test fixtures that use the user id as the patient record id.
    const ownRecord = user.patient_id ?? user.id;
    if (ownRecord !== patientId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Access denied: patients may only manage their own appointments",
      });
    }
    return;
  }

  if (user.role === "family_caregiver") {
    const hasLink = await hasActiveFamilyLink(user.id, patientId);
    if (!hasLink) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Access denied: no active family relationship grants access to this patient",
      });
    }
    return;
  }

  // Clinicians (physician, specialist, nurse) must be on the care team.
  const hasAccess = await assertCareTeamAccess(user.id, patientId);
  if (!hasAccess) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Access denied: no active care-team assignment for this patient",
    });
  }
}

export const schedulingRbacRouter = t.router({
  appointments: t.router({
    listByPatient: protectedProcedure
      .input(z.object({ patientId: z.string() }))
      .query(async ({ ctx, input }) => {
        await enforcePatientAccess(ctx.user, input.patientId);
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
        // Optional on the wire — defaulted from ctx.user.patient_id for
        // patient-role callers below so the existing patient portal client
        // code (which historically passed patientId implicitly) keeps
        // working without modification. For any other role the field is
        // required and the access check enforces care-team / family-link
        // membership.
        patientId: z.string().optional(),
        providerId: z.string(),
        appointmentType: z.enum(["follow_up", "new_patient", "procedure", "telehealth"]),
        startTime: z.string(),
        endTime: z.string(),
        location: z.string().optional(),
        reason: z.string().optional(),
      }))
      .mutation(async ({ ctx, input }) => {
        // Resolve the target patient record.
        //  - patient role: default to the caller's linked record when absent;
        //    when present it must match (prevents a patient booking for
        //    someone else).
        //  - every other role: patientId must be supplied explicitly.
        let patientId: string;
        if (ctx.user.role === "patient") {
          const ownRecord = ctx.user.patient_id ?? ctx.user.id;
          if (input.patientId !== undefined && input.patientId !== ownRecord) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: "Access denied: patients may only book their own appointments",
            });
          }
          patientId = ownRecord;
        } else {
          if (!input.patientId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message: "patientId is required for non-patient roles",
            });
          }
          patientId = input.patientId;
        }

        await enforcePatientAccess(ctx.user, patientId);

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
            patient_id: patientId,
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

        // Load the appointment so we can run the access check against the
        // target patient record before mutating. Single select by primary
        // key — cheap and keeps the check server-authoritative (a tampered
        // client can't supply its own patient_id).
        const [existing] = await db
          .select({ patient_id: appointments.patient_id })
          .from(appointments)
          .where(eq(appointments.id, input.appointmentId))
          .limit(1);

        if (!existing) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: `Appointment ${input.appointmentId} not found`,
          });
        }

        await enforcePatientAccess(ctx.user, existing.patient_id);

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

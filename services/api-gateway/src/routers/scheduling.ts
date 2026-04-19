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
import {
  hasScope,
  normaliseScopes,
  type ScopeToken,
} from "@carebridge/shared-types";
import {
  appointmentTypeSchema,
  cancelReasonSchema,
} from "@carebridge/validators";
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
 * Resolve the active family_relationships row linking the caregiver to the
 * given patient record, returning its `access_scopes` set for downstream
 * scope enforcement. Null when no active relationship exists.
 */
async function findActiveFamilyRelationship(
  caregiverUserId: string,
  patientRecordId: string,
): Promise<{ id: string; access_scopes: ScopeToken[] | null } | null> {
  const db = getDb();
  const [row] = await db
    .select({
      id: familyRelationships.id,
      access_scopes: familyRelationships.access_scopes,
    })
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
  if (!row) return null;
  return {
    id: row.id,
    access_scopes: (row.access_scopes ?? null) as ScopeToken[] | null,
  };
}

/**
 * Enforce HIPAA minimum-necessary access for a given user / patientId pair
 * on scheduling procedures. Throws TRPCError(FORBIDDEN) on denial.
 *
 * Role semantics mirror patient-records.enforcePatientAccess. The optional
 * `requiredScope` is used for caregiver read procedures — appointments
 * require `view_appointments` per the resource→scope mapping in #896.
 */
async function enforcePatientAccess(
  user: NonNullable<Context["user"]>,
  patientId: string,
  requiredScope?: ScopeToken,
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
    const relationship = await findActiveFamilyRelationship(user.id, patientId);
    if (!relationship) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message:
          "Access denied: no active family relationship grants access to this patient",
      });
    }
    if (requiredScope !== undefined) {
      const scopes = normaliseScopes(relationship.access_scopes);
      if (!hasScope(scopes, requiredScope)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `Access denied: caregiver lacks ${requiredScope} scope`,
        });
      }
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
        // Appointments are gated by view_appointments (see #896).
        await enforcePatientAccess(ctx.user, input.patientId, "view_appointments");
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
        appointmentType: appointmentTypeSchema,
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
      // Issue #893: reason is server-authoritative — trim + min(1) reject
      // empty/whitespace with BAD_REQUEST even if the client UI fails to
      // enforce it.
      .input(z.object({ appointmentId: z.string(), reason: cancelReasonSchema }))
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

    /**
     * Atomic reschedule (issue #892): cancel the existing appointment AND
     * insert a new row at the requested slot inside a single transaction.
     *
     * Motivation: the patient-portal previously invoked cancel + create as
     * two separate RBAC-gated calls. If the network dropped between them
     * the patient ended up with their old slot cancelled and no new one
     * booked. Wrapping both mutations in a DB transaction makes the
     * operation all-or-nothing: a conflict on the new slot rolls back the
     * cancel, leaving the original appointment untouched.
     *
     * RBAC: the target patient_id is read from the existing appointment
     * row (not trusted from the wire) so the same enforcePatientAccess
     * check used by create/cancel applies here too.
     */
    reschedule: protectedProcedure
      .input(z.object({
        appointmentId: z.string(),
        newStartTime: z.string(),
        newEndTime: z.string(),
        reason: cancelReasonSchema,
      }))
      .mutation(async ({ ctx, input }) => {
        const db = getDb();

        // Pre-transaction lookup: resolve the patient for the access check
        // without holding a write lock. If the appointment is gone, bail
        // with NOT_FOUND before we even open a transaction.
        const [existing] = await db
          .select({
            id: appointments.id,
            patient_id: appointments.patient_id,
            provider_id: appointments.provider_id,
            appointment_type: appointments.appointment_type,
            location: appointments.location,
            reason: appointments.reason,
            start_time: appointments.start_time,
            end_time: appointments.end_time,
            status: appointments.status,
          })
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

        return db.transaction(async (tx) => {
          // Re-read inside the tx so the row is visible to the cancel
          // UPDATE below. If the row disappeared between the pre-check and
          // the tx (rare — someone else cancelled), treat as conflict.
          const [current] = await tx
            .select()
            .from(appointments)
            .where(eq(appointments.id, input.appointmentId))
            .limit(1);
          if (!current) {
            throw new Error("Appointment no longer exists");
          }

          // Overlap check on the new slot against the same provider's
          // active appointments. Exclude the appointment we're about to
          // cancel so a self-reschedule onto an overlapping slot doesn't
          // race against its own row.
          const overlapping = await tx
            .select()
            .from(appointments)
            .where(
              and(
                eq(appointments.provider_id, current.provider_id),
                ne(appointments.status, "cancelled"),
                ne(appointments.id, input.appointmentId),
                lte(appointments.start_time, input.newEndTime),
                gte(appointments.end_time, input.newStartTime),
              ),
            );

          if (overlapping.length > 0) {
            throw new Error(
              "New time slot conflicts with an existing appointment",
            );
          }

          // 1. Cancel the original row.
          await tx
            .update(appointments)
            .set({
              status: "cancelled",
              cancelled_at: now,
              cancelled_by: ctx.user.id,
              cancel_reason: input.reason,
              updated_at: now,
            })
            .where(eq(appointments.id, input.appointmentId));

          // 2. Insert the new appointment.
          const newAppt = {
            id: crypto.randomUUID(),
            patient_id: current.patient_id,
            provider_id: current.provider_id,
            appointment_type: current.appointment_type,
            start_time: input.newStartTime,
            end_time: input.newEndTime,
            status: "scheduled",
            location: current.location ?? null,
            reason: current.reason ?? null,
            created_at: now,
            updated_at: now,
          };

          await tx.insert(appointments).values(newAppt);

          return newAppt;
        });
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

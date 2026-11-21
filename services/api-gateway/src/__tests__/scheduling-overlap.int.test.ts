import { randomBytes, randomUUID } from "node:crypto";
import { fastifyTRPCPlugin } from "@trpc/server/adapters/fastify";
import { appointments, getDb, patients, providerSchedules, users } from "@carebridge/db-schema";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "../context.js";
import { schedulingRbacRouter } from "../routers/scheduling.js";

// CI supplies PostgreSQL and runs migrations. The queue is the only stubbed
// boundary so PostgreSQL evaluates the actual overlap predicates.
const { cancelReminders, scheduleReminders } = vi.hoisted(() => ({
  cancelReminders: vi.fn(async () => {}),
  scheduleReminders: vi.fn(async ({ id }: { id: string }) => ({
    reminder_24h_job_id: `${id}-reminder-24h`,
    reminder_2h_job_id: `${id}-reminder-2h`,
  })),
}));

vi.mock("@carebridge/scheduling", () => ({ cancelReminders, scheduleReminders }));

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const date = "2030-01-02";
const timestamp = (time: string) => `${date}T${time}:00.000Z`;

describe.skipIf(!testDatabaseUrl)("scheduling overlap with persisted appointments (#1346)", () => {
  const app = Fastify();
  const patientId = randomUUID();
  const patientUserId = randomUUID();
  const providerId = randomUUID();
  let db: ReturnType<typeof getDb> | undefined;
  let fixturesCreated = false;

  beforeAll(async () => {
    // Always override DATABASE_URL. The suite must never fall back to the
    // application connection when the dedicated test database is absent.
    const hostname = URL.parse(testDatabaseUrl ?? "")?.hostname;
    if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "[::1]") {
      throw new Error("Scheduling integration tests require a local TEST_DATABASE_URL.");
    }
    vi.stubEnv("DATABASE_URL", testDatabaseUrl);
    vi.stubEnv("PHI_ENCRYPTION_KEY", randomBytes(32).toString("hex"));
    const connection = getDb();
    db = connection;
    const now = new Date().toISOString();
    const auditDates = { created_at: now, updated_at: now };
    await connection.transaction(async (tx) => {
      await tx.insert(patients).values({ id: patientId, name: "Synthetic scheduling patient", ...auditDates });
      await tx.insert(users).values({
        id: providerId,
        email: `${providerId}@example.invalid`,
        name: "Synthetic scheduling provider",
        password_hash: "unusable-test-fixture",
        role: "physician",
        ...auditDates,
      });
      await tx.insert(providerSchedules).values({
        id: randomUUID(),
        provider_id: providerId,
        day_of_week: new Date(date).getDay(),
        start_time: "10:00",
        end_time: "11:30",
        slot_duration_minutes: 30,
        created_at: now,
      });
    });
    fixturesCreated = true;

    await app.register(fastifyTRPCPlugin, {
      prefix: "/trpc",
      trpcOptions: {
        router: schedulingRbacRouter,
        createContext: (): Context => ({
          db: connection,
          user: {
            id: patientUserId,
            patient_id: patientId,
            email: "synthetic-scheduler@example.invalid",
            name: "Synthetic scheduling patient",
            role: "patient",
            is_active: true,
            ...auditDates,
          },
          sessionId: null,
          requestId: randomUUID(),
          clientIp: null,
        }),
      },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (fixturesCreated) {
      await getDb().delete(appointments).where(eq(appointments.patient_id, patientId));
    }
  });

  afterAll(async () => {
    try {
      await app.close();
      if (db && fixturesCreated) {
        await db.transaction(async (tx) => {
          await tx.delete(appointments).where(eq(appointments.patient_id, patientId));
          await tx.delete(providerSchedules).where(eq(providerSchedules.provider_id, providerId));
          await tx.delete(users).where(eq(users.id, providerId));
          await tx.delete(patients).where(eq(patients.id, patientId));
        });
      }
    } finally {
      try {
        await db?.$client.end();
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  const book = (start: string, end: string) =>
    app.inject({
      method: "POST",
      url: "/trpc/appointments.create",
      payload: {
        providerId,
        appointmentType: "follow_up",
        startTime: timestamp(start),
        endTime: timestamp(end),
      },
    });

  const move = (id: string, start: string, end: string) =>
    app.inject({
      method: "POST",
      url: "/trpc/appointments.reschedule",
      payload: {
        appointmentId: id,
        reason: "Synthetic slot change",
        newStartTime: timestamp(start),
        newEndTime: timestamp(end),
      },
    });

  const persisted = () => getDb().select().from(appointments)
    .where(eq(appointments.patient_id, patientId)).orderBy(appointments.id);

  it("books slots touching either boundary and returns HTTP 409 for an overlap", async () => {
    expect((await book("10:30", "11:00")).statusCode).toBe(200);

    const input = encodeURIComponent(JSON.stringify({ providerId, date }));
    const availability = await app.inject({ method: "GET", url: `/trpc/schedule.availability?input=${input}` });
    expect(availability.statusCode).toBe(200);
    expect(availability.json().result.data.slots).toEqual([
      { start: timestamp("10:00"), end: timestamp("10:30"), available: true },
      { start: timestamp("10:30"), end: timestamp("11:00"), available: false },
      { start: timestamp("11:00"), end: timestamp("11:30"), available: true },
    ]);
    expect((await book("10:00", "10:30")).statusCode).toBe(200);
    expect((await book("11:00", "11:30")).statusCode).toBe(200);

    const before = await persisted();
    expect(before).toHaveLength(3);
    const conflict = await book("10:45", "11:15");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.data.code).toBe("CONFLICT");
    expect(await persisted()).toEqual(before);
    expect(scheduleReminders).toHaveBeenCalledTimes(3);
    expect(cancelReminders).not.toHaveBeenCalled();
  });

  it("reschedules at either boundary and preserves both rows and reminder IDs on conflict", async () => {
    expect((await book("10:30", "11:00")).statusCode).toBe(200);
    const original = await book("14:00", "14:30");
    expect(original.statusCode).toBe(200);

    const beforeSlot = await move(original.json().result.data.id, "10:00", "10:30");
    expect(beforeSlot.statusCode).toBe(200);
    const afterSlot = await move(beforeSlot.json().result.data.id, "11:00", "11:30");
    expect(afterSlot.statusCode).toBe(200);

    const before = await persisted();
    const active = before.filter((appointment) => appointment.status === "scheduled");
    expect(active).toHaveLength(2);
    for (const appointment of active) {
      expect(appointment.reminder_24h_job_id).toBe(`${appointment.id}-reminder-24h`);
      expect(appointment.reminder_2h_job_id).toBe(`${appointment.id}-reminder-2h`);
    }

    const conflict = await move(afterSlot.json().result.data.id, "10:45", "11:15");
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.data.code).toBe("CONFLICT");
    expect(await persisted()).toEqual(before);
    expect(scheduleReminders).toHaveBeenCalledTimes(4);
    expect(cancelReminders).toHaveBeenCalledTimes(2);
  });

  it("commits only one of two concurrent bookings for the same slot", async () => {
    const results = await Promise.all([book("10:00", "10:30"), book("10:00", "10:30")]);
    expect(results.map(({ statusCode }) => statusCode).sort((a, b) => a - b)).toEqual([200, 409]);
    const conflict = results.find(({ statusCode }) => statusCode === 409);
    expect(conflict?.json().error.data.code).toBe("CONFLICT");
    expect(await persisted()).toHaveLength(1);
    expect(scheduleReminders).toHaveBeenCalledTimes(1);
  });
});

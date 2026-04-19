import { describe, it, expect } from "vitest";
import {
  appointmentTypeSchema,
  cancelReasonSchema,
  cancelAppointmentSchema,
  rescheduleAppointmentSchema,
} from "../scheduling.js";

describe("appointmentTypeSchema", () => {
  it.each(["follow_up", "new_patient", "procedure", "telehealth"])(
    "accepts canonical type %s",
    (t) => {
      expect(appointmentTypeSchema.safeParse(t).success).toBe(true);
    },
  );

  it("rejects unknown types (prevents silent map holes)", () => {
    expect(appointmentTypeSchema.safeParse("walkin").success).toBe(false);
    expect(appointmentTypeSchema.safeParse("").success).toBe(false);
  });
});

describe("cancelReasonSchema (#893)", () => {
  it("accepts a non-empty trimmed reason", () => {
    const res = cancelReasonSchema.safeParse("Feeling better");
    expect(res.success).toBe(true);
    expect(res.data).toBe("Feeling better");
  });

  it("trims surrounding whitespace", () => {
    const res = cancelReasonSchema.safeParse("  conflict  ");
    expect(res.success).toBe(true);
    expect(res.data).toBe("conflict");
  });

  it("rejects an empty string", () => {
    expect(cancelReasonSchema.safeParse("").success).toBe(false);
  });

  it("rejects a whitespace-only reason", () => {
    expect(cancelReasonSchema.safeParse("   ").success).toBe(false);
    expect(cancelReasonSchema.safeParse("\t\n").success).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(cancelReasonSchema.safeParse(null).success).toBe(false);
    expect(cancelReasonSchema.safeParse(undefined).success).toBe(false);
    expect(cancelReasonSchema.safeParse(42).success).toBe(false);
  });
});

describe("cancelAppointmentSchema", () => {
  it("requires appointmentId and non-empty reason", () => {
    const ok = cancelAppointmentSchema.safeParse({
      appointmentId: "appt-1",
      reason: "changed plans",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects empty-string reason", () => {
    const bad = cancelAppointmentSchema.safeParse({
      appointmentId: "appt-1",
      reason: "",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects whitespace-only reason", () => {
    const bad = cancelAppointmentSchema.safeParse({
      appointmentId: "appt-1",
      reason: "   ",
    });
    expect(bad.success).toBe(false);
  });
});

describe("rescheduleAppointmentSchema (#892)", () => {
  it("accepts a complete payload", () => {
    const res = rescheduleAppointmentSchema.safeParse({
      appointmentId: "appt-1",
      newStartTime: "2026-05-01T15:00:00.000Z",
      newEndTime: "2026-05-01T15:30:00.000Z",
      reason: "Rescheduling",
    });
    expect(res.success).toBe(true);
  });

  it("rejects empty reason on reschedule", () => {
    const bad = rescheduleAppointmentSchema.safeParse({
      appointmentId: "appt-1",
      newStartTime: "2026-05-01T15:00:00.000Z",
      newEndTime: "2026-05-01T15:30:00.000Z",
      reason: "   ",
    });
    expect(bad.success).toBe(false);
  });
});

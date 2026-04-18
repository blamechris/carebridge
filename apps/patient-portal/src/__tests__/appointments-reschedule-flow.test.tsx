/**
 * @vitest-environment jsdom
 *
 * AppointmentsPageInner coordinator: cancel, book, and reschedule flows.
 * Reschedule = cancel (with reason) then auto-open the book wizard. The
 * scheduling service exposes cancel + create separately, not a single
 * atomic reschedule — called out as a follow-up in the PR body.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor } from "@testing-library/react";

import {
  AppointmentsPageInner, type AppointmentsPageInnerProps,
} from "@/components/appointments/appointments-page-inner";

const careTeam = [
  { provider_id: "prov-smith", name: "Dr. Smith", specialty: "Hematology", role: "primary" },
];

const upcomingAppt = {
  id: "appt-1", patient_id: "pt-1", provider_id: "prov-smith",
  appointment_type: "follow_up",
  start_time: "2026-04-25T15:00:00.000Z", end_time: "2026-04-25T15:30:00.000Z",
  status: "scheduled", location: "Clinic A", reason: null, cancel_reason: null,
};

const slots = [{ start: "2026-04-30T15:00:00.000Z", end: "2026-04-30T15:30:00.000Z", available: true }];

function props(over: Partial<AppointmentsPageInnerProps> = {}): AppointmentsPageInnerProps {
  return {
    patientId: "pt-1",
    appointments: [upcomingAppt],
    careTeam,
    onLoadSlots: vi.fn().mockResolvedValue(slots),
    onBook: vi.fn().mockResolvedValue(undefined),
    onCancel: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

async function walkBookWizard() {
  fireEvent.click(await screen.findByLabelText(/dr\. smith/i));
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  fireEvent.click(screen.getByLabelText(/follow-up/i));
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  fireEvent.change(screen.getByLabelText(/date/i), { target: { value: "2026-04-30" } });
  fireEvent.click(await screen.findByTestId("slot-option-2026-04-30T15:00:00.000Z"));
  fireEvent.click(screen.getByRole("button", { name: /next/i }));
  fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
}

describe("AppointmentsPageInner", () => {
  afterEach(() => cleanup());

  it("cancel flow: invokes onCancel with appointmentId and reason", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    render(<AppointmentsPageInner {...props({ onCancel })} />);

    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(await screen.findByRole("heading", { name: /cancel appointment/i })).toBeDefined();

    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Feeling better" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm cancel/i }));

    await waitFor(() =>
      expect(onCancel).toHaveBeenCalledWith({ appointmentId: "appt-1", reason: "Feeling better" }),
    );
  });

  it("book flow: invokes onBook with the tRPC create payload", async () => {
    const onBook = vi.fn().mockResolvedValue(undefined);
    render(<AppointmentsPageInner {...props({ onBook, appointments: [] })} />);

    fireEvent.click(screen.getByRole("button", { name: /book appointment/i }));
    await walkBookWizard();

    await waitFor(() =>
      expect(onBook).toHaveBeenCalledWith({
        patientId: "pt-1",
        providerId: "prov-smith",
        appointmentType: "follow_up",
        startTime: "2026-04-30T15:00:00.000Z",
        endTime: "2026-04-30T15:30:00.000Z",
      }),
    );
  });

  it("reschedule flow: cancels original, then auto-opens book and books new slot", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const onBook = vi.fn().mockResolvedValue(undefined);
    render(<AppointmentsPageInner {...props({ onCancel, onBook })} />);

    fireEvent.click(screen.getByRole("button", { name: /reschedule/i }));
    fireEvent.change(await screen.findByLabelText(/reason/i), { target: { value: "Rescheduling" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm cancel/i }));

    await waitFor(() =>
      expect(onCancel).toHaveBeenCalledWith({ appointmentId: "appt-1", reason: "Rescheduling" }),
    );

    // After cancel, the book modal opens automatically
    expect(await screen.findByRole("heading", { name: /select provider/i })).toBeDefined();
    await walkBookWizard();

    await waitFor(() =>
      expect(onBook).toHaveBeenCalledWith({
        patientId: "pt-1",
        providerId: "prov-smith",
        appointmentType: "follow_up",
        startTime: "2026-04-30T15:00:00.000Z",
        endTime: "2026-04-30T15:30:00.000Z",
      }),
    );
  });
});

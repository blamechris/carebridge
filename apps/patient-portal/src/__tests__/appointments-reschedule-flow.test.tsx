/**
 * @vitest-environment jsdom
 *
 * AppointmentsPageInner coordinator: cancel, book, and reschedule flows.
 * Reschedule = cancel (with reason) then auto-open the book wizard. The
 * scheduling service exposes cancel + create separately, not a single
 * atomic reschedule — called out as a follow-up in the PR body.
 */
import React, { StrictMode } from "react";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";

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
  const confirm = screen.getByRole("button", { name: /confirm/i });
  confirm.focus();
  fireEvent.click(confirm);
}

describe("AppointmentsPageInner", () => {
  // Freeze the test clock to a moment BEFORE the fixture appointment so
  // isUpcoming(row.end_time >= Date.now()) holds. Without this the suite
  // silently rots once real wall-clock passes the fixture date — the row
  // moves to the "past" tab where action buttons are intentionally hidden,
  // and `getByRole("button", { name: /reschedule/i })` cannot find them.
  // Derived from upcomingAppt.start_time so updating the fixture date
  // can never drift from the frozen clock.
  beforeAll(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fixtureStart = new Date(upcomingAppt.start_time).getTime();
    const oneDayMs = 24 * 60 * 60 * 1000;
    vi.setSystemTime(new Date(fixtureStart - oneDayMs));
  });
  afterAll(() => {
    vi.useRealTimers();
  });
  afterEach(() => cleanup());

  it("traps focus in the booking wizard and restores it on Escape", () => {
    render(<StrictMode><AppointmentsPageInner {...props()} /></StrictMode>);
    const opener = screen.getByRole("button", { name: /book appointment/i });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: /select provider/i });
    const first = within(dialog).getByRole("radio", { name: /dr\. smith/i });
    const last = within(dialog).getByRole("button", { name: /close/i });
    const disabledNext = within(dialog).getByRole("button", { name: /next/i });
    expect(disabledNext).toHaveAttribute("tabindex", "0");
    expect(disabledNext).toBeDisabled();

    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("wraps focus around the provider radio group before and after selection", () => {
    render(<AppointmentsPageInner {...props({
      careTeam: [
        ...careTeam,
        { provider_id: "prov-example", name: "Dr. Example", specialty: null, role: "secondary" },
      ],
    })} />);
    const opener = screen.getByRole("button", { name: /book appointment/i });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: /select provider/i });
    const alternate = within(dialog).getByRole("radio", { name: /dr\. example/i });
    const close = within(dialog).getByRole("button", { name: /close/i });

    // Native reverse traversal can enter the unchecked group at its last radio.
    alternate.focus();
    fireEvent.keyDown(alternate, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(close);

    alternate.focus();
    fireEvent.click(alternate);
    const last = within(dialog).getByRole("button", { name: /next/i });

    fireEvent.keyDown(alternate, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Tab" });
    expect(document.activeElement).toBe(alternate);
  });

  it("recaptures Tab after the focused Next button becomes disabled", () => {
    render(<AppointmentsPageInner {...props()} />);
    const opener = screen.getByRole("button", { name: /book appointment/i });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("radio", { name: /dr\. smith/i }));

    const next = screen.getByRole("button", { name: /next/i });
    next.focus();
    fireEvent.click(next);
    expect(next).toBeDisabled();

    const dialog = screen.getByRole("dialog", { name: /appointment type/i });
    const [firstType] = within(dialog).getAllByRole("radio");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
    expect(document.activeElement).toBe(firstType);
  });

  it("keeps focus across a page rerender and restores it when the reopened wizard closes", () => {
    const pageProps = props();
    const { rerender } = render(<AppointmentsPageInner {...pageProps} />);
    const opener = screen.getByRole("button", { name: /book appointment/i });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: /close/i }));

    opener.focus();
    fireEvent.click(opener);
    const closeButton = screen.getByRole("button", { name: /close/i });
    closeButton.focus();

    // The page can receive a refreshed appointment list while the wizard is open.
    rerender(<AppointmentsPageInner {...pageProps} appointments={[]} />);
    expect(document.activeElement).toBe(closeButton);

    fireEvent.click(closeButton);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it.each(["atomic", "legacy"])("keeps focus through the %s reschedule handoff and restores it on close", async (flow) => {
    render(<AppointmentsPageInner {...props({
      onReschedule: flow === "atomic" ? vi.fn().mockResolvedValue(undefined) : undefined,
    })} />);
    const opener = screen.getByRole("button", { name: /reschedule/i });
    opener.focus();
    fireEvent.click(opener);

    const reason = screen.getByLabelText(/reason/i);
    expect(document.activeElement).toBe(reason);
    fireEvent.change(reason, { target: { value: "Rescheduling" } });
    const next = screen.getByRole("button", { name: /continue|confirm cancel/i });
    next.focus();
    fireEvent.click(next);

    const dialog = await screen.findByRole("dialog", { name: /select provider/i });
    const first = within(dialog).getByRole("radio", { name: /dr\. smith/i });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it.each([
    { openerName: "Cancel", heading: "Cancel appointment" },
    { openerName: "View details", heading: "Appointment details" },
  ])("keeps $heading keyboard-accessible", ({ openerName, heading }) => {
    render(<AppointmentsPageInner {...props()} />);
    const opener = screen.getByRole("button", { name: openerName });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: heading });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

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

  it("legacy reschedule flow: cancels original, then auto-opens book and books new slot", async () => {
    // When onReschedule is not provided (legacy path) we still run the
    // two-step cancel→book UX. Locked in so existing pages that haven't
    // yet opted into the atomic procedure keep working.
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const onBook = vi.fn().mockResolvedValue(undefined);
    render(<AppointmentsPageInner {...props({ onCancel, onBook })} />);

    fireEvent.click(screen.getByRole("button", { name: /reschedule/i }));
    fireEvent.change(await screen.findByLabelText(/reason/i), { target: { value: "Rescheduling" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm cancel|continue/i }));

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

  it("atomic reschedule flow (#892): calls onReschedule once with both halves", async () => {
    const onCancel = vi.fn().mockResolvedValue(undefined);
    const onBook = vi.fn().mockResolvedValue(undefined);
    const onReschedule = vi.fn().mockResolvedValue(undefined);
    render(<AppointmentsPageInner {...props({ onCancel, onBook, onReschedule })} />);

    fireEvent.click(screen.getByRole("button", { name: /reschedule/i }));
    // The reason modal re-labels Confirm -> Continue so users understand
    // they haven't committed anything yet.
    expect(await screen.findByRole("heading", { name: /reschedule appointment/i })).toBeDefined();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Rescheduling" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    // After collecting the reason the slot picker opens — but we have NOT
    // called cancel or book yet (the whole transaction runs server-side).
    expect(await screen.findByRole("heading", { name: /select provider/i })).toBeDefined();
    expect(onCancel).not.toHaveBeenCalled();

    await walkBookWizard();

    await waitFor(() =>
      expect(onReschedule).toHaveBeenCalledWith({
        appointmentId: "appt-1",
        newStartTime: "2026-04-30T15:00:00.000Z",
        newEndTime: "2026-04-30T15:30:00.000Z",
        reason: "Rescheduling",
      }),
    );
    // Critically: the standalone create/cancel procedures are NEVER called.
    expect(onCancel).not.toHaveBeenCalled();
    expect(onBook).not.toHaveBeenCalled();
  });

  it("keeps focus in the wizard after an atomic reschedule conflict", async () => {
    const onReschedule = vi
      .fn()
      .mockRejectedValue(new Error("New time slot conflicts with an existing appointment"));
    render(<AppointmentsPageInner {...props({ onReschedule })} />);

    const opener = screen.getByRole("button", { name: /reschedule/i });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.change(await screen.findByLabelText(/reason/i), { target: { value: "Rescheduling" } });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(await screen.findByRole("heading", { name: /select provider/i })).toBeDefined();
    await walkBookWizard();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toMatch(/conflict/i),
    );
    const confirm = screen.getByRole("button", { name: /confirm/i });
    expect(document.activeElement).toBe(confirm);

    fireEvent.keyDown(confirm, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

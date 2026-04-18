/**
 * @vitest-environment jsdom
 *
 * AppointmentList: upcoming/past split, action buttons, telehealth labels.
 */
import React from "react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, within } from "@testing-library/react";

import { AppointmentList, type AppointmentRow } from "@/components/appointments/appointment-list";

const NOW = new Date("2026-04-17T12:00:00Z");
const providerMap = { "prov-smith": "Dr. Smith", "prov-jones": "Dr. Jones" };

function makeAppt(over: Partial<AppointmentRow> = {}): AppointmentRow {
  return {
    id: "a-1", patient_id: "pt-1", provider_id: "prov-smith",
    appointment_type: "follow_up",
    start_time: "2026-04-20T15:00:00.000Z", end_time: "2026-04-20T15:30:00.000Z",
    status: "scheduled", location: "Clinic A", reason: null, cancel_reason: null,
    ...over,
  };
}

function renderList(appts: AppointmentRow[], overrides: Partial<React.ComponentProps<typeof AppointmentList>> = {}) {
  const props = {
    appointments: appts, providerMap,
    onCancel: vi.fn(), onReschedule: vi.fn(), onViewDetail: vi.fn(),
    ...overrides,
  };
  render(<AppointmentList {...props} />);
  return props;
}

describe("AppointmentList", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it("splits upcoming from past into separate tabs", () => {
    renderList([
      makeAppt({ id: "u-1" }),
      makeAppt({ id: "p-1", start_time: "2026-03-01T15:00:00.000Z", end_time: "2026-03-01T15:30:00.000Z", status: "completed" }),
    ]);
    expect(screen.getByTestId("appointment-row-u-1")).toBeDefined();
    expect(screen.queryByTestId("appointment-row-p-1")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: /past/i }));
    expect(screen.getByTestId("appointment-row-p-1")).toBeDefined();
    expect(screen.queryByTestId("appointment-row-u-1")).toBeNull();
  });

  it("classifies cancelled appointments into past regardless of date", () => {
    renderList([makeAppt({ id: "c-1", start_time: "2026-05-01T15:00:00.000Z", status: "cancelled" })]);
    expect(screen.queryByTestId("appointment-row-c-1")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /past/i }));
    expect(screen.getByTestId("appointment-row-c-1")).toBeDefined();
  });

  it("renders provider name, type label, and location on rows", () => {
    renderList([makeAppt({ appointment_type: "follow_up", location: "Clinic A" })]);
    const row = screen.getByTestId("appointment-row-a-1");
    expect(within(row).getByText("Dr. Smith")).toBeDefined();
    expect(within(row).getByText(/follow-up/i)).toBeDefined();
    expect(within(row).getByText("Clinic A")).toBeDefined();
  });

  it('shows "Telehealth" as location label for telehealth appointments', () => {
    renderList([makeAppt({ appointment_type: "telehealth", location: null })]);
    const row = screen.getByTestId("appointment-row-a-1");
    expect(within(row).getAllByText("Telehealth").length).toBeGreaterThanOrEqual(2);
  });

  it("shows Cancel and Reschedule actions only on upcoming rows", () => {
    renderList([
      makeAppt({ id: "u-1" }),
      makeAppt({ id: "p-1", start_time: "2026-03-01T15:00:00.000Z", end_time: "2026-03-01T15:30:00.000Z", status: "completed" }),
    ]);
    const up = screen.getByTestId("appointment-row-u-1");
    expect(within(up).getByRole("button", { name: /cancel/i })).toBeDefined();
    expect(within(up).getByRole("button", { name: /reschedule/i })).toBeDefined();

    fireEvent.click(screen.getByRole("tab", { name: /past/i }));
    const past = screen.getByTestId("appointment-row-p-1");
    expect(within(past).queryByRole("button", { name: /cancel/i })).toBeNull();
    expect(within(past).queryByRole("button", { name: /reschedule/i })).toBeNull();
  });

  it("invokes callbacks with the appointment id", () => {
    const p = renderList([makeAppt({ id: "u-1" })]);
    const row = screen.getByTestId("appointment-row-u-1");
    fireEvent.click(within(row).getByRole("button", { name: /cancel/i }));
    fireEvent.click(within(row).getByRole("button", { name: /reschedule/i }));
    fireEvent.click(within(row).getByRole("button", { name: /view details/i }));
    expect(p.onCancel).toHaveBeenCalledWith("u-1");
    expect(p.onReschedule).toHaveBeenCalledWith("u-1");
    expect(p.onViewDetail).toHaveBeenCalledWith("u-1");
  });

  it("shows empty-state message with no upcoming appointments", () => {
    renderList([]);
    expect(screen.getByText(/no upcoming appointments/i)).toBeDefined();
  });
});

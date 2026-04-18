/**
 * @vitest-environment jsdom
 *
 * BookAppointmentModal wizard: provider -> type -> slot -> confirm.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

import {
  BookAppointmentModal, type CareTeamProvider, type SlotOption,
} from "@/components/appointments/book-appointment-modal";

const careTeam: CareTeamProvider[] = [
  { provider_id: "prov-smith", name: "Dr. Smith", specialty: "Hematology", role: "primary" },
  { provider_id: "prov-jones", name: "Dr. Jones", specialty: "Radiology", role: "specialist" },
];

const slots: SlotOption[] = [
  { start: "2026-04-20T15:00:00.000Z", end: "2026-04-20T15:30:00.000Z", available: true },
  { start: "2026-04-20T15:30:00.000Z", end: "2026-04-20T16:00:00.000Z", available: false },
  { start: "2026-04-20T16:00:00.000Z", end: "2026-04-20T16:30:00.000Z", available: true },
];

function renderModal(over: Partial<React.ComponentProps<typeof BookAppointmentModal>> = {}) {
  const props = {
    careTeam,
    onLoadSlots: vi.fn().mockResolvedValue(slots),
    onConfirm: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<BookAppointmentModal {...props} />);
  return props;
}

describe("BookAppointmentModal", () => {
  afterEach(() => cleanup());

  it("starts on provider selection; refuses to advance without a provider", () => {
    renderModal();
    expect(screen.getByRole("heading", { name: /select provider/i })).toBeDefined();
    expect(screen.getByText("Dr. Smith")).toBeDefined();
    const next = screen.getByRole("button", { name: /next/i }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
  });

  it("advances through the wizard and loads slots for the chosen provider + date", async () => {
    const { onLoadSlots } = renderModal();

    fireEvent.click(screen.getByLabelText(/dr\. smith/i));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("heading", { name: /appointment type/i })).toBeDefined();

    fireEvent.click(screen.getByLabelText(/follow-up/i));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("heading", { name: /select a time/i })).toBeDefined();

    fireEvent.change(screen.getByLabelText(/date/i), { target: { value: "2026-04-20" } });
    expect(onLoadSlots).toHaveBeenCalledWith({ providerId: "prov-smith", date: "2026-04-20" });
  });

  it("disables unavailable slots", async () => {
    renderModal();
    fireEvent.click(screen.getByLabelText(/dr\. smith/i));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByLabelText(/follow-up/i));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.change(screen.getByLabelText(/date/i), { target: { value: "2026-04-20" } });

    await screen.findByTestId("slot-option-2026-04-20T15:00:00.000Z");
    const taken = screen.getByTestId("slot-option-2026-04-20T15:30:00.000Z") as HTMLButtonElement;
    expect(taken.disabled).toBe(true);
  });

  it("emits the tRPC-ready payload on confirm", async () => {
    const { onConfirm } = renderModal();

    fireEvent.click(screen.getByLabelText(/dr\. smith/i));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByLabelText(/follow-up/i));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.change(screen.getByLabelText(/date/i), { target: { value: "2026-04-20" } });

    fireEvent.click(await screen.findByTestId("slot-option-2026-04-20T15:00:00.000Z"));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByRole("heading", { name: /confirm booking/i })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onConfirm).toHaveBeenCalledWith({
      providerId: "prov-smith",
      appointmentType: "follow_up",
      startTime: "2026-04-20T15:00:00.000Z",
      endTime: "2026-04-20T15:30:00.000Z",
    });
  });

  it("shows empty-state when no slots available", async () => {
    renderModal({ onLoadSlots: vi.fn().mockResolvedValue([]) });

    fireEvent.click(screen.getByLabelText(/dr\. smith/i));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByLabelText(/follow-up/i));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.change(screen.getByLabelText(/date/i), { target: { value: "2026-04-20" } });

    await screen.findByText(/no slots available/i);
  });
});

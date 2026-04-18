/**
 * @vitest-environment jsdom
 *
 * CancelAppointmentModal: required non-empty reason + confirm payload.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent } from "@testing-library/react";

import { CancelAppointmentModal } from "@/components/appointments/cancel-appointment-modal";

function renderModal(over: Partial<React.ComponentProps<typeof CancelAppointmentModal>> = {}) {
  const props = { appointmentId: "a-1", onConfirm: vi.fn(), onClose: vi.fn(), ...over };
  render(<CancelAppointmentModal {...props} />);
  return props;
}

describe("CancelAppointmentModal", () => {
  afterEach(() => cleanup());

  it("renders confirmation heading and reason textarea", () => {
    renderModal();
    expect(screen.getByRole("heading", { name: /cancel appointment/i })).toBeDefined();
    expect(screen.getByLabelText(/reason/i)).toBeDefined();
  });

  it("disables confirm until a non-empty reason is entered", () => {
    renderModal();
    const confirm = screen.getByRole("button", { name: /confirm cancel/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "   " } });
    expect(confirm.disabled).toBe(true);
  });

  it("does not call onConfirm on submit when reason is empty", () => {
    const { onConfirm } = renderModal();
    fireEvent.submit(screen.getByRole("form", { name: /cancel appointment/i }));
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("emits payload when reason is valid", () => {
    const { onConfirm } = renderModal();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Scheduling conflict" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm cancel/i }));
    expect(onConfirm).toHaveBeenCalledWith({ appointmentId: "a-1", reason: "Scheduling conflict" });
  });

  it("calls onClose on Close button", () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

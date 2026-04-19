/**
 * @vitest-environment jsdom
 *
 * Covers the shared `useModalFocusTrap` hook used by the appointment
 * booking + cancel modals (#894). Behaviour mirrors the clinician-portal
 * `useSidebarFocusTrap` so patterns stay consistent.
 */
import React, { useRef, useState } from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen, fireEvent, act } from "@testing-library/react";

import { useModalFocusTrap } from "@/lib/use-modal-focus-trap";

function Harness({
  onClose = vi.fn(),
  buttons = 2,
}: {
  onClose?: () => void;
  buttons?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  useModalFocusTrap(open, ref, () => {
    onClose();
    setOpen(false);
  });

  return (
    <div>
      <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <div role="dialog" aria-modal="true" ref={ref} tabIndex={-1} data-testid="modal">
          {Array.from({ length: buttons }).map((_, i) => (
            <button key={i} type="button" data-testid={`modal-btn-${i}`}>
              Button {i}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

describe("useModalFocusTrap", () => {
  afterEach(() => cleanup());

  it("moves focus to the first focusable on open", () => {
    render(<Harness />);
    const opener = screen.getByTestId("opener");
    act(() => {
      opener.focus();
      opener.click();
    });
    const firstBtn = screen.getByTestId("modal-btn-0");
    expect(document.activeElement).toBe(firstBtn);
  });

  it("falls back to the container when there are no focusable children", () => {
    render(<Harness buttons={0} />);
    act(() => {
      screen.getByTestId("opener").click();
    });
    expect(document.activeElement).toBe(screen.getByTestId("modal"));
  });

  it("wraps Tab at the last focusable back to the first", () => {
    render(<Harness buttons={2} />);
    act(() => {
      screen.getByTestId("opener").click();
    });
    const first = screen.getByTestId("modal-btn-0");
    const last = screen.getByTestId("modal-btn-1");

    act(() => {
      last.focus();
    });
    // Simulate Tab at the last element — trap should send us to first.
    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  it("wraps Shift+Tab at the first focusable to the last", () => {
    render(<Harness buttons={2} />);
    act(() => {
      screen.getByTestId("opener").click();
    });
    const first = screen.getByTestId("modal-btn-0");
    const last = screen.getByTestId("modal-btn-1");

    act(() => {
      first.focus();
    });
    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  it("invokes onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    act(() => {
      screen.getByTestId("opener").click();
    });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("restores focus to the opener on close", () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByTestId("opener") as HTMLButtonElement;
    act(() => {
      opener.focus();
      opener.click();
    });
    // Escape closes the modal — the harness sets open=false on onClose.
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(opener);
  });
});

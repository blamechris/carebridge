"use client";

import { useEffect, useRef } from "react";

/**
 * WCAG 2.1.2 / 2.4.3 / 2.4.7 focus management for modal dialogs (#894).
 *
 * Behaviour:
 *  - On open: saves the previously-focused element, then moves focus
 *    to the first focusable descendant of the modal. If the modal has
 *    no focusable children (rare — e.g. a confirmation step with only
 *    a dismiss button that we treat as the opener), focus the container
 *    itself. Pass `tabIndex={-1}` on the container to make this work.
 *  - While open: Tab / Shift+Tab wrap within focusable descendants.
 *  - Escape closes the modal via `onClose`.
 *  - On close or unmount, restores focus to the opener if it is still
 *    connected.
 *
 * Mirrors `useSidebarFocusTrap` from the clinician portal (Wave 7 #898).
 * Kept portal-local because the two portals ship independently and
 * elevating it to a shared package added bundle weight without a concrete
 * third consumer.
 */
export const MODAL_FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function getTabStops(container: HTMLElement) {
  const items = Array.from(
    container.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR),
  );
  const selectedRadios = Array.from(
    container.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked:not(:disabled)'),
  );

  // A selected radio represents its entire group in the browser's tab order.
  return items.filter((item) => {
    if (!(item instanceof HTMLInputElement) || item.type !== "radio" || !item.name || item.checked) {
      return true;
    }
    return !selectedRadios.some((radio) => radio.name === item.name && radio.form === item.form);
  });
}

export function useModalFocusTrap(
  isOpen: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const onCloseRef = useRef(onClose);

  // Keep Escape current without restarting the open dialog's focus trap.
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;

    const container = containerRef.current;
    if (!container) return;

    const previousFocus = document.activeElement as HTMLElement | null;

    const firstFocusable = getTabStops(container)[0];
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      container.focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const current = containerRef.current;
      if (!current) return;
      const items = getTabStops(current);
      if (items.length === 0) {
        event.preventDefault();
        current.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      const boundary = event.shiftKey ? first : last;

      // Advancing the wizard can remove or disable the focused control.
      if (active === boundary || !current.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      // Restore before the next dialog captures focus during rescheduling.
      if (previousFocus?.isConnected && typeof previousFocus.focus === "function") {
        previousFocus.focus();
      }
    };
  }, [isOpen, containerRef]);
}

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
 *  - On close: restores focus to the element that opened the modal
 *    (usually the button that triggered it).
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

export function useModalFocusTrap(
  isOpen: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const container = containerRef.current;
    if (!container) return;

    previousFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;

    const focusables = Array.from(
      container.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR),
    );
    const firstFocusable = focusables[0];
    if (firstFocusable) {
      firstFocusable.focus();
    } else {
      container.focus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;

      const current = containerRef.current;
      if (!current) return;
      const items = Array.from(
        current.querySelectorAll<HTMLElement>(MODAL_FOCUSABLE_SELECTOR),
      );
      if (items.length === 0) {
        event.preventDefault();
        current.focus();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (active === first || !current.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isOpen, containerRef, onClose]);

  useEffect(() => {
    if (isOpen) return;
    const previous = previousFocusRef.current;
    if (previous && typeof previous.focus === "function") {
      previous.focus();
    }
    previousFocusRef.current = null;
  }, [isOpen]);
}

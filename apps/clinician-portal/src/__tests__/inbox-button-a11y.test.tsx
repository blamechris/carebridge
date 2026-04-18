/**
 * @vitest-environment jsdom
 *
 * WCAG 2.1 AA — 4.1.2 Name, Role, Value.
 *
 * The per-flag Acknowledge / Resolve / Dismiss buttons in the inbox list
 * reuse the same visible label across many rows. Screen reader users need
 * each button's accessible name to disambiguate which flag it acts on,
 * so each button gets an `aria-label` that includes the flag summary.
 * Issue #183.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

// Flatten the auth guard so InboxContent renders directly.
vi.mock("@/lib/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock next/navigation
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

// FlagActionModal pulls in extra UI; stub it to a no-op for this test.
vi.mock("@/components/flag-action-modal", () => ({
  FlagActionModal: () => null,
}));

// Stub trpc with the query + mutation shapes used by InboxContent.
const flags = [
  {
    id: "flag-1",
    severity: "critical",
    summary: "Potential stroke risk from combined VTE + anticoagulation gap",
    suggested_action: "Order head CT",
    patient_id: "patient-1",
    created_at: "2026-04-17T10:00:00Z",
  },
  {
    id: "flag-2",
    severity: "warning",
    summary: "Missing INR follow-up after warfarin start",
    suggested_action: "Schedule INR draw",
    patient_id: "patient-2",
    created_at: "2026-04-17T09:00:00Z",
  },
];

vi.mock("@/lib/trpc", () => {
  const invalidate = vi.fn().mockResolvedValue(undefined);
  const useMutation = () => ({
    mutate: vi.fn(),
    isPending: false,
  });
  return {
    trpc: {
      useUtils: () => ({
        aiOversight: {
          flags: {
            getAllOpen: { invalidate },
            getByPatient: { invalidate },
            getOpenCount: { invalidate },
          },
        },
      }),
      aiOversight: {
        flags: {
          getAllOpen: {
            useQuery: () => ({ data: flags, isLoading: false, isError: false }),
          },
          acknowledge: { useMutation },
          resolve: { useMutation },
          dismiss: { useMutation },
        },
      },
    },
  };
});

import InboxPage from "../../app/inbox/page";

describe("inbox flag action button a11y (WCAG 4.1.2)", () => {
  afterEach(() => {
    cleanup();
  });

  it("gives every Acknowledge button an aria-label referencing the flag summary", () => {
    render(<InboxPage />);

    for (const flag of flags) {
      const btn = screen.getByLabelText(`Acknowledge flag: ${flag.summary}`);
      expect(btn.getAttribute("aria-label")).toBe(
        `Acknowledge flag: ${flag.summary}`,
      );
    }
  });

  it("gives every Resolve button an aria-label referencing the flag summary", () => {
    render(<InboxPage />);

    for (const flag of flags) {
      const btn = screen.getByLabelText(`Resolve flag: ${flag.summary}`);
      expect(btn.getAttribute("aria-label")).toBe(
        `Resolve flag: ${flag.summary}`,
      );
    }
  });

  it("gives every Dismiss button an aria-label referencing the flag summary", () => {
    render(<InboxPage />);

    for (const flag of flags) {
      const btn = screen.getByLabelText(`Dismiss flag: ${flag.summary}`);
      expect(btn.getAttribute("aria-label")).toBe(
        `Dismiss flag: ${flag.summary}`,
      );
    }
  });
});

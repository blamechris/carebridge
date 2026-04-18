/**
 * @vitest-environment jsdom
 *
 * WCAG 2.1 AA — 2.4.4 / 4.1.2.
 *
 * The patients-list search input has only a placeholder. Placeholders are
 * not an accessible name under the ARIA accessible-name algorithm, so a
 * screen reader cannot announce the control's purpose. This test pins
 * the contract that the input exposes `aria-label="Search by patient
 * name or MRN"`. Issue #183.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("@/lib/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    patients: {
      list: {
        useQuery: () => ({ data: [], isLoading: false, isError: false }),
      },
    },
  },
}));

import PatientsPage from "../../app/patients/page";

describe("patients list search input a11y (WCAG 2.4.4)", () => {
  afterEach(() => {
    cleanup();
  });

  it("exposes the search input with aria-label 'Search by patient name or MRN'", () => {
    render(<PatientsPage />);

    const input = screen.getByLabelText("Search by patient name or MRN");
    expect(input).toBeDefined();
    expect(input.getAttribute("aria-label")).toBe(
      "Search by patient name or MRN",
    );
    expect(input.tagName).toBe("INPUT");
  });
});

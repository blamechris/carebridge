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

const syntheticPatients = [
  {
    id: "synthetic-short",
    name: "Q",
    mrn: "SYNTHETIC-001",
    date_of_birth: "2000-01-01",
    biological_sex: "unknown",
  },
  {
    id: "synthetic-long",
    name: "Synthetic".padEnd(200, "x"),
    mrn: "SYNTHETIC".padEnd(50, "0"),
    date_of_birth: "2000-01-02",
    biological_sex: "unknown",
  },
];

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
        useQuery: () => ({
          data: syntheticPatients,
          isLoading: false,
          isError: false,
        }),
      },
    },
  },
}));

import PatientsPage from "../../app/patients/page";

describe("patients list accessibility", () => {
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

  it("keeps both chart links in the keyboard tab order for each patient", () => {
    render(<PatientsPage />);

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(syntheticPatients.length * 2);

    for (const [index, patient] of syntheticPatients.entries()) {
      const patientName = links[index * 2];
      const openChart = links[index * 2 + 1];
      const patientPath = `/patients/${patient.id}`;

      expect(patientName).toHaveAccessibleName(patient.name);
      expect(openChart).toHaveAccessibleName("Open Chart");

      for (const link of [patientName, openChart]) {
        expect(link).toHaveAttribute("href", patientPath);
        expect(link.tabIndex).toBe(0);

        link.focus();
        expect(link).toHaveFocus();
      }
    }
  });
});

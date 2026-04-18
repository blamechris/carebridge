/**
 * @vitest-environment jsdom
 *
 * WCAG 2.1 AA — 2.4.3 Focus Order / 4.1.2 Name, Role, Value.
 *
 * The patient-chart tab strip uses visual-only "active" styling. Screen
 * readers have no way to know which tab is currently selected without an
 * explicit `aria-current="page"` (or equivalent) on the active tab. Per
 * issue #183 we expose `aria-current="true"` on the active tab only; all
 * other tab buttons must omit the attribute entirely (not `"false"` —
 * that is a common anti-pattern).
 *
 * The attribute value is the string `"true"`, not the boolean — DOM
 * attributes always serialize to strings and aria-current specifically
 * treats the token `"true"` as valid.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";

vi.mock("@/lib/auth-guard", () => ({
  AuthGuard: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mutable holder so individual tests can set the active tab.
let currentTab: string | null = null;

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "patient-1" }),
  useSearchParams: () => ({ get: (k: string) => (k === "tab" ? currentTab : null) }),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

vi.mock("@/components/vitals-trend-chart", () => ({
  VitalsTrendChart: () => null,
}));

vi.mock("@/components/stale-data-banner", () => ({
  StaleDataBanner: () => null,
}));

// Every child tab pulls tRPC queries. Stub a permissive mock so any
// chained access returns a `useQuery`/`useMutation` that resolves to an
// empty/loading shape. This keeps the test focused on the tab strip.
const stubQuery = () => ({
  data: undefined,
  isLoading: true,
  isError: false,
});
const stubMutation = () => ({ mutate: vi.fn(), isPending: false });

const patient = {
  id: "patient-1",
  name: "Jane Doe",
  mrn: "MRN-0001",
  date_of_birth: "1970-01-01",
  biological_sex: "F",
};

vi.mock("@/lib/trpc", () => {
  // Flexible deep-getter — every leaf provides useQuery/useMutation.
  const makeLeaf = (key: string) => {
    const leaf: Record<string, unknown> = {
      useQuery: (..._args: unknown[]) => {
        if (key === "patients.getById") {
          return { data: patient, isLoading: false, isError: false };
        }
        return stubQuery();
      },
      useMutation: () => stubMutation(),
    };
    return leaf;
  };

  // A thin shim for `trpc.useUtils()` — every invalidate is a resolved noop.
  const utilsProxy = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "invalidate") {
            return () => Promise.resolve();
          }
          return utilsProxy();
        },
      },
    );

  const proxy = (path: string[]): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return undefined; // not a thenable
          if (prop === "useUtils") return () => utilsProxy();
          const nextPath = [...path, prop];
          if (prop === "useQuery" || prop === "useMutation") {
            return makeLeaf(path.join("."))[prop];
          }
          return proxy(nextPath);
        },
      },
    );

  return {
    trpc: proxy([]) as unknown,
  };
});

import PatientChartPage from "../../app/patients/[id]/page";

describe("patient-chart tab a11y (WCAG 2.4.3)", () => {
  afterEach(() => {
    cleanup();
    currentTab = null;
  });

  it("marks the Overview tab aria-current=true by default", () => {
    currentTab = null;
    render(<PatientChartPage />);

    const overview = screen.getByRole("button", { name: "Overview" });
    expect(overview.getAttribute("aria-current")).toBe("true");
  });

  it("marks only one tab aria-current at a time (Vitals active)", () => {
    currentTab = "vitals";
    render(<PatientChartPage />);

    const overview = screen.getByRole("button", { name: "Overview" });
    const vitals = screen.getByRole("button", { name: "Vitals" });
    const labs = screen.getByRole("button", { name: "Labs" });

    expect(vitals.getAttribute("aria-current")).toBe("true");
    expect(overview.getAttribute("aria-current")).toBeNull();
    expect(labs.getAttribute("aria-current")).toBeNull();
  });

  it("marks Labs aria-current when ?tab=labs", () => {
    currentTab = "labs";
    render(<PatientChartPage />);

    const labs = screen.getByRole("button", { name: "Labs" });
    expect(labs.getAttribute("aria-current")).toBe("true");
  });

  it("marks AI Flags aria-current when ?tab=flags", () => {
    currentTab = "flags";
    render(<PatientChartPage />);

    const flags = screen.getByRole("button", { name: "AI Flags" });
    expect(flags.getAttribute("aria-current")).toBe("true");
  });

  it("does not set aria-current=false on inactive tabs (must be absent)", () => {
    currentTab = "overview";
    render(<PatientChartPage />);

    const vitals = screen.getByRole("button", { name: "Vitals" });
    // ARIA spec: inactive tabs omit the attribute; "false" is the default.
    expect(vitals.hasAttribute("aria-current")).toBe(false);
  });
});

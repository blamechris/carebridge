/**
 * @vitest-environment jsdom
 *
 * Issue #1182 — Epic launch-context banner.
 *
 * Covers:
 *   - Banner hidden when no epic_patient param is present.
 *   - Banner shown when epic_patient param is present, with org name and
 *     patient FHIR id.
 *   - "Switch to portal mode" strips query params and stores a
 *     sessionStorage suppression flag so subsequent navigations don't
 *     re-show the banner.
 */
import React from "react";
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";
import {
  render,
  cleanup,
  screen,
  fireEvent,
} from "@testing-library/react";

const routerReplace = vi.fn();
let searchParamsMock = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: routerReplace,
  }),
  usePathname: () => "/patients/abc",
  useSearchParams: () => searchParamsMock,
}));

const getLaunchContextQuery = vi.fn(() => ({
  data: {
    epic_org_iss: "https://fhir.epic.example/api/FHIR/R4",
    epic_practitioner_fhir_id: "prac-1",
    epic_patient_fhir_id: "eP123",
    launch_encounter_fhir_id: null,
    expires_at: "2099-01-01T00:00:00Z",
  },
  isLoading: false,
  isError: false,
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    epicAuth: {
      getLaunchContext: {
        useQuery: (_input: unknown, _opts: unknown) => getLaunchContextQuery(),
      },
    },
  },
}));

import { EpicLaunchBanner } from "../components/epic-launch-banner";

function makeStorage(): {
  store: Map<string, string>;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
} {
  const store = new Map<string, string>();
  return {
    store,
    storage: {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => {
        store.set(k, String(v));
      },
      removeItem: (k) => {
        store.delete(k);
      },
    },
  };
}

beforeEach(() => {
  routerReplace.mockClear();
  searchParamsMock = new URLSearchParams();
});

afterEach(() => {
  cleanup();
});

describe("EpicLaunchBanner", () => {
  it("returns null when no URL params AND server has no launch context", () => {
    getLaunchContextQuery.mockReturnValueOnce({
      data: null,
      isLoading: false,
      isError: false,
    });
    const { storage } = makeStorage();
    render(<EpicLaunchBanner storage={storage} />);
    expect(screen.queryByTestId("epic-launch-banner")).toBeNull();
  });

  it("renders banner with org + patient FHIR id when launch context present", () => {
    searchParamsMock = new URLSearchParams({
      epic_patient: "eP123",
      epic_encounter: "eE456",
    });
    getLaunchContextQuery.mockReturnValueOnce({
      data: {
        epic_org_iss: "https://fhir.epic.example/api/FHIR/R4",
        epic_practitioner_fhir_id: "prac-1",
        epic_patient_fhir_id: "eP123",
        launch_encounter_fhir_id: "eE456",
        expires_at: "2099-01-01T00:00:00Z",
      },
      isLoading: false,
      isError: false,
    });
    const { storage } = makeStorage();
    render(<EpicLaunchBanner storage={storage} />);

    const banner = screen.getByTestId("epic-launch-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/Launched from/i);
    expect(banner.textContent).toMatch(/https:\/\/fhir\.epic\.example/);
    expect(banner.textContent).toMatch(/eP123/);
    expect(banner.textContent).toMatch(/eE456/);
  });

  it("Switch to portal mode strips epic_patient/encounter and sets suppression flag", () => {
    searchParamsMock = new URLSearchParams({
      epic_patient: "eP123",
      epic_encounter: "eE456",
      tab: "vitals",
    });
    const { store, storage } = makeStorage();
    render(<EpicLaunchBanner storage={storage} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: /Switch to portal mode/i,
      }),
    );

    // Replace URL was called with epic params stripped, but other params kept.
    expect(routerReplace).toHaveBeenCalledTimes(1);
    const target = routerReplace.mock.calls[0][0] as string;
    expect(target).not.toContain("epic_patient");
    expect(target).not.toContain("epic_encounter");
    expect(target).toContain("tab=vitals");

    // Suppression flag stored for this patient FHIR id.
    expect(store.get("carebridge_epic_launch_suppressed")).toBe("eP123");
  });

  it("stays hidden when sessionStorage flag matches current patient", () => {
    searchParamsMock = new URLSearchParams({
      epic_patient: "eP123",
    });
    const { store, storage } = makeStorage();
    store.set("carebridge_epic_launch_suppressed", "eP123");

    render(<EpicLaunchBanner storage={storage} />);
    expect(screen.queryByTestId("epic-launch-banner")).toBeNull();
  });

  // Issue #1186 — banner must NOT trust URL params alone. The server-confirmed
  // launch context (epicAuth.getLaunchContext) is the source of truth; URL
  // params are only used as a hint to enable the query.

  it("renders null when server returns null but URL has epic_patient (anti-spoof)", () => {
    searchParamsMock = new URLSearchParams({
      epic_patient: "spoofed-fhir-id",
    });
    getLaunchContextQuery.mockReturnValueOnce({
      data: null,
      isLoading: false,
      isError: false,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storage } = makeStorage();
    render(<EpicLaunchBanner storage={storage} />);
    expect(screen.queryByTestId("epic-launch-banner")).toBeNull();
    warnSpy.mockRestore();
  });

  it("renders banner from server values when URL params absent (post-callback genuine launch)", () => {
    // No URL params at all — but server has a valid launch context.
    searchParamsMock = new URLSearchParams();
    getLaunchContextQuery.mockReturnValueOnce({
      data: {
        epic_org_iss: "https://fhir.epic.example/api/FHIR/R4",
        epic_practitioner_fhir_id: "prac-1",
        epic_patient_fhir_id: "abc",
        launch_encounter_fhir_id: null,
        expires_at: "2099-01-01T00:00:00Z",
      },
      isLoading: false,
      isError: false,
    });
    const { storage } = makeStorage();
    render(<EpicLaunchBanner storage={storage} />);
    const banner = screen.getByTestId("epic-launch-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/abc/);
  });

  it("renders null + warns when URL epic_patient mismatches server epic_patient_fhir_id", () => {
    searchParamsMock = new URLSearchParams({
      epic_patient: "spoof",
    });
    getLaunchContextQuery.mockReturnValueOnce({
      data: {
        epic_org_iss: "https://fhir.epic.example/api/FHIR/R4",
        epic_practitioner_fhir_id: "prac-1",
        epic_patient_fhir_id: "abc",
        launch_encounter_fhir_id: null,
        expires_at: "2099-01-01T00:00:00Z",
      },
      isLoading: false,
      isError: false,
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storage } = makeStorage();
    render(<EpicLaunchBanner storage={storage} />);
    expect(screen.queryByTestId("epic-launch-banner")).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("renders banner from server values when URL epic_patient matches server (uses server values)", () => {
    searchParamsMock = new URLSearchParams({
      epic_patient: "abc",
    });
    getLaunchContextQuery.mockReturnValueOnce({
      data: {
        epic_org_iss: "https://fhir.epic.example/api/FHIR/R4",
        epic_practitioner_fhir_id: "prac-1",
        epic_patient_fhir_id: "abc",
        launch_encounter_fhir_id: null,
        expires_at: "2099-01-01T00:00:00Z",
      },
      isLoading: false,
      isError: false,
    });
    const { storage } = makeStorage();
    render(<EpicLaunchBanner storage={storage} />);
    const banner = screen.getByTestId("epic-launch-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/abc/);
  });
});

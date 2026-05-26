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

  // Issue #1187 — suppression flag must be read synchronously during render
  // (lazy useState initializer), not in a post-mount useEffect. Reading it
  // post-mount causes the banner to paint once before the effect hides it,
  // producing a visible flash on deep-link re-visits with launch params still
  // present in the URL.

  it("reads sessionStorage suppress flag during initial render (lazy init, not via effect)", () => {
    // Contract: with the lazy useState initializer, getItem must be called
    // as part of the synchronous render path. Without the fix, getItem is
    // only called inside useEffect — which fires AFTER the first paint.
    //
    // The probe below renders AFTER the banner in tree order. React calls
    // function components top-down during render, so by the time Probe's
    // render function executes, the banner's render function has already
    // run to completion (including any lazy useState initializer). If
    // getItem was called by then, the lazy-init path was exercised; if not,
    // the read is deferred to an effect and the banner has already painted.
    searchParamsMock = new URLSearchParams({
      epic_patient: "eP123",
    });
    getLaunchContextQuery.mockReturnValueOnce({
      data: {
        epic_org_iss: "https://fhir.epic.example/api/FHIR/R4",
        epic_practitioner_fhir_id: "prac-1",
        epic_patient_fhir_id: "eP123",
        launch_encounter_fhir_id: null,
        expires_at: "2099-01-01T00:00:00Z",
      },
      isLoading: false,
      isError: false,
    });

    const { store, storage } = makeStorage();
    store.set("carebridge_epic_launch_suppressed", "eP123");

    const getItemSpy = vi.fn((k: string) => storage.getItem(k));
    const spyStorage: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
      getItem: getItemSpy,
      setItem: (k, v) => storage.setItem(k, v),
      removeItem: (k) => storage.removeItem(k),
    };

    let getItemCallsSeenByProbe = 0;
    function Probe() {
      getItemCallsSeenByProbe = getItemSpy.mock.calls.length;
      return null;
    }

    render(
      <div>
        <EpicLaunchBanner storage={spyStorage} />
        <Probe />
      </div>,
    );

    expect(getItemCallsSeenByProbe).toBeGreaterThan(0);
    // And the steady-state DOM has no banner either.
    expect(screen.queryByTestId("epic-launch-banner")).toBeNull();
  });

  // Issue #1199 — the mismatch console.warn runs inline in render, so React
  // strict-mode double-renders and parent re-renders fired the same tamper
  // warning repeatedly in dev. Dedup by tracking the last warned
  // (urlEpicPatient, serverPatient) pair in a useRef and only re-warning
  // when the pair changes.

  it("warns only once when re-rendered repeatedly with the same patient mismatch", () => {
    searchParamsMock = new URLSearchParams({ epic_patient: "spoof" });
    getLaunchContextQuery.mockReturnValue({
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
    const { rerender } = render(<EpicLaunchBanner storage={storage} />);
    for (let i = 0; i < 10; i++) {
      rerender(<EpicLaunchBanner storage={storage} />);
    }

    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("emits a fresh warn when the mismatch pair changes between renders", () => {
    searchParamsMock = new URLSearchParams({ epic_patient: "spoof-1" });
    getLaunchContextQuery.mockReturnValue({
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
    const { rerender } = render(<EpicLaunchBanner storage={storage} />);
    rerender(<EpicLaunchBanner storage={storage} />);
    // Same pair so far: only one warn.
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // Switch the URL to a different spoofed value: pair changes, warn again.
    searchParamsMock = new URLSearchParams({ epic_patient: "spoof-2" });
    rerender(<EpicLaunchBanner storage={storage} />);
    rerender(<EpicLaunchBanner storage={storage} />);

    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });

  it("warns only once on repeat encounter-mismatch re-renders, fires again on new pair", () => {
    searchParamsMock = new URLSearchParams({
      epic_patient: "abc",
      epic_encounter: "spoof-enc-1",
    });
    getLaunchContextQuery.mockReturnValue({
      data: {
        epic_org_iss: "https://fhir.epic.example/api/FHIR/R4",
        epic_practitioner_fhir_id: "prac-1",
        epic_patient_fhir_id: "abc",
        // Cast through unknown because the vi.fn's inferred return type
        // pins this property to `null` from the module-level default;
        // tests need a concrete encounter id to exercise the mismatch path.
        launch_encounter_fhir_id: "real-enc" as unknown as null,
        expires_at: "2099-01-01T00:00:00Z",
      },
      isLoading: false,
      isError: false,
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { storage } = makeStorage();
    const { rerender } = render(<EpicLaunchBanner storage={storage} />);
    for (let i = 0; i < 10; i++) {
      rerender(<EpicLaunchBanner storage={storage} />);
    }
    expect(warnSpy).toHaveBeenCalledTimes(1);

    searchParamsMock = new URLSearchParams({
      epic_patient: "abc",
      epic_encounter: "spoof-enc-2",
    });
    rerender(<EpicLaunchBanner storage={storage} />);
    expect(warnSpy).toHaveBeenCalledTimes(2);
    warnSpy.mockRestore();
  });
});

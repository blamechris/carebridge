import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./auth";
import type { User } from "./auth";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock next/navigation (required by auth-guard, imported transitively)
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

// Provide a minimal localStorage implementation for environments where the
// jsdom provider does not expose one.
function createLocalStorageMock() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, String(value)),
    removeItem: (key: string) => store.delete(key),
    clear: () => store.clear(),
    get length() { return store.size; },
    key: (_i: number) => null,
  } as Storage;
}

Object.defineProperty(globalThis, "localStorage", {
  value: createLocalStorageMock(),
  writable: true,
});

// Capture fetch calls so we can simulate /auth/me responses.
const fetchMock = vi.fn();
globalThis.fetch = fetchMock;

// Stub getApiBaseUrl to avoid importing the real trpc module.
vi.mock("./trpc", () => ({
  getApiBaseUrl: () => "http://localhost:4000",
}));

const TEST_USER: User = {
  id: "user-1",
  email: "test@carebridge.dev",
  name: "Test User",
  role: "patient",
};

const DIFFERENT_USER: User = {
  id: "user-2",
  email: "other@carebridge.dev",
  name: "Other User",
  role: "physician",
};

// Issue #821: /auth/me returns specialty/department for clinical staff and
// patient_id for patients. These must flow through to the client User object.
const CLINICIAN_USER: User = {
  id: "user-3",
  email: "dr.smith@carebridge.dev",
  name: "Dr. Smith",
  role: "physician",
  specialty: "Hematology/Oncology",
  department: "Oncology",
};

const PATIENT_USER_WITH_RECORD: User = {
  id: "user-4",
  email: "patient@carebridge.dev",
  name: "Pat Ient",
  role: "patient",
  patient_id: "patient-abc-123",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper(queryClient?: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <AuthProvider queryClient={queryClient}>{children}</AuthProvider>;
  };
}

function mockAuthMeResponse(user: User | null, ok = true) {
  fetchMock.mockImplementation((url: string, _opts?: RequestInit) => {
    if (typeof url === "string" && url.includes("/auth/me")) {
      return Promise.resolve({
        ok: ok && user !== null,
        status: user ? 200 : 401,
        json: () => Promise.resolve(user ?? { error: "Not authenticated" }),
      });
    }
    // Default for other endpoints (session cookie set/clear)
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuthProvider /auth/me hydration", () => {
  beforeEach(() => {
    localStorage.removeItem("carebridge_user");
    localStorage.removeItem("carebridge_has_session");
    fetchMock.mockReset();
    // Prevent jsdom from complaining about navigation
    delete (window as Record<string, unknown>).location;
    (window as Record<string, unknown>).location = {
      href: "",
      pathname: "/dashboard",
      assign: vi.fn(),
      replace: vi.fn(),
      reload: vi.fn(),
    } as unknown as Location;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("validates localStorage identity against /auth/me on mount", async () => {
    // Pre-populate localStorage as if a previous session existed.
    localStorage.setItem("carebridge_user", JSON.stringify(TEST_USER));
    localStorage.setItem("carebridge_has_session", "true");
    mockAuthMeResponse(TEST_USER);

    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper(),
    });

    // Should hydrate immediately from localStorage.
    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.user?.id).toBe("user-1");

    // Wait for /auth/me verification to complete.
    await waitFor(() => expect(result.current.verifying).toBe(false));
    expect(result.current.user?.id).toBe("user-1");
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("clears session and redirects when /auth/me returns 401", async () => {
    localStorage.setItem("carebridge_user", JSON.stringify(TEST_USER));
    localStorage.setItem("carebridge_has_session", "true");
    mockAuthMeResponse(null);

    const queryClient = new QueryClient();
    const clearSpy = vi.spyOn(queryClient, "clear");

    renderHook(() => useAuth(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => {
      expect(localStorage.getItem("carebridge_user")).toBeNull();
    });

    expect(localStorage.getItem("carebridge_has_session")).toBeNull();
    expect(clearSpy).toHaveBeenCalled();
    expect(window.location.href).toBe("/login");
  });

  it("clears session when /auth/me returns a different user id", async () => {
    localStorage.setItem("carebridge_user", JSON.stringify(TEST_USER));
    localStorage.setItem("carebridge_has_session", "true");
    // Server returns a different user — localStorage was tampered.
    mockAuthMeResponse(DIFFERENT_USER);

    const queryClient = new QueryClient();
    const clearSpy = vi.spyOn(queryClient, "clear");

    renderHook(() => useAuth(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => {
      expect(localStorage.getItem("carebridge_user")).toBeNull();
    });

    expect(clearSpy).toHaveBeenCalled();
    expect(window.location.href).toBe("/login");
  });

  it("clears QueryClient cache on logout via clearSession", async () => {
    localStorage.setItem("carebridge_user", JSON.stringify(TEST_USER));
    localStorage.setItem("carebridge_has_session", "true");
    mockAuthMeResponse(TEST_USER);

    const queryClient = new QueryClient();
    const clearSpy = vi.spyOn(queryClient, "clear");

    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper(queryClient),
    });

    await waitFor(() => expect(result.current.verifying).toBe(false));
    expect(result.current.isAuthenticated).toBe(true);

    act(() => {
      result.current.clearSession();
    });

    expect(clearSpy).toHaveBeenCalled();
    expect(result.current.isAuthenticated).toBe(false);
  });

  // Regression tests for issue #821: the User type must expose specialty,
  // department, and patient_id so portal consumers can read them without a
  // separate fetch. If any of these fields is dropped on the type or during
  // hydration, consumers like useMyPatientRecord and the clinician sidebar
  // silently break.
  it("preserves specialty and department fields from /auth/me for clinical staff", async () => {
    localStorage.setItem("carebridge_user", JSON.stringify({
      id: CLINICIAN_USER.id,
      email: CLINICIAN_USER.email,
      name: CLINICIAN_USER.name,
      role: CLINICIAN_USER.role,
    }));
    localStorage.setItem("carebridge_has_session", "true");
    mockAuthMeResponse(CLINICIAN_USER);

    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.verifying).toBe(false));

    // Fields returned by the server must survive into the context user object.
    expect(result.current.user?.specialty).toBe("Hematology/Oncology");
    expect(result.current.user?.department).toBe("Oncology");

    // They must also be persisted to localStorage so they survive a reload
    // before the next /auth/me round-trip completes.
    const stored = JSON.parse(
      localStorage.getItem("carebridge_user") ?? "{}",
    ) as User;
    expect(stored.specialty).toBe("Hematology/Oncology");
    expect(stored.department).toBe("Oncology");
  });

  it("preserves patient_id field from /auth/me for patient users", async () => {
    localStorage.setItem("carebridge_user", JSON.stringify({
      id: PATIENT_USER_WITH_RECORD.id,
      email: PATIENT_USER_WITH_RECORD.email,
      name: PATIENT_USER_WITH_RECORD.name,
      role: PATIENT_USER_WITH_RECORD.role,
    }));
    localStorage.setItem("carebridge_has_session", "true");
    mockAuthMeResponse(PATIENT_USER_WITH_RECORD);

    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.verifying).toBe(false));

    // patient_id is used by useMyPatientRecord for direct patient lookup.
    expect(result.current.user?.patient_id).toBe("patient-abc-123");

    const stored = JSON.parse(
      localStorage.getItem("carebridge_user") ?? "{}",
    ) as User;
    expect(stored.patient_id).toBe("patient-abc-123");
  });

  it("preserves all extended fields through setSession (login path)", async () => {
    mockAuthMeResponse(null);

    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.hydrated).toBe(true));

    act(() => {
      result.current.setSession(CLINICIAN_USER, "test-session-token");
    });

    expect(result.current.user?.specialty).toBe("Hematology/Oncology");
    expect(result.current.user?.department).toBe("Oncology");
    expect(result.current.isAuthenticated).toBe(true);

    const stored = JSON.parse(
      localStorage.getItem("carebridge_user") ?? "{}",
    ) as User;
    expect(stored.specialty).toBe("Hematology/Oncology");
    expect(stored.department).toBe("Oncology");
  });

  it("skips /auth/me when no session flag exists in localStorage", async () => {
    // No session data at all — fresh visitor.
    mockAuthMeResponse(TEST_USER);

    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current.hydrated).toBe(true));
    expect(result.current.verifying).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
    // /auth/me should NOT have been called.
    const meCalls = fetchMock.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("/auth/me"),
    );
    expect(meCalls).toHaveLength(0);
  });
});

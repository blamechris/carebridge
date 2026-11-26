import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "./auth";
import type { User } from "./auth";
import type { UserRole } from "@carebridge/shared-types";
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
    let respond!: (response: Pick<Response, "ok" | "json">) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => { respond = resolve; }));

    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper(),
    });

    expect(result.current.hydrated).toBe(true);
    expect(result.current.verifying).toBe(true);
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);

    await act(async () => respond({ ok: true, json: async () => TEST_USER }));
    expect(result.current.verifying).toBe(false);
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

  it.each([
    { failure: "profile", keys: ["carebridge_user"] },
    { failure: "session flag", keys: ["carebridge_has_session"] },
    { failure: "both keys", keys: ["carebridge_user", "carebridge_has_session"] },
  ])("completes logout when removal fails for $failure", async ({ keys }) => {
    localStorage.setItem("carebridge_user", JSON.stringify(TEST_USER));
    localStorage.setItem("carebridge_has_session", "true");
    mockAuthMeResponse(TEST_USER);

    const queryClient = new QueryClient();
    const queryKey = ["synthetic-session-query"];
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper(queryClient) });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));
    queryClient.setQueryData(queryKey, "synthetic data");

    const removeItem = localStorage.removeItem.bind(localStorage);
    const removeSpy = vi.spyOn(localStorage, "removeItem").mockImplementation((key) => {
      if (keys.includes(key)) throw new Error("Storage unavailable");
      removeItem(key);
    });

    const push = vi.fn();
    await act(async () => {
      result.current.clearSession();
      push("/login");
    });

    expect(removeSpy.mock.calls).toEqual([["carebridge_user"], ["carebridge_has_session"]]);
    expect(result.current.user).toBeNull();
    expect(result.current.sessionId).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.verifying).toBe(false);
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();
    expect(push).toHaveBeenCalledWith("/login");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/auth/session/clear"),
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("clears queries and redirects when neither restoration nor storage cleanup can finish", async () => {
    localStorage.setItem("carebridge_user", JSON.stringify(TEST_USER));
    localStorage.setItem("carebridge_has_session", "true");
    let respond!: (response: Pick<Response, "ok" | "json">) => void;
    fetchMock.mockReturnValueOnce(new Promise((resolve) => { respond = resolve; }));

    const queryClient = new QueryClient();
    const queryKey = ["synthetic-session-query"];
    queryClient.setQueryData(queryKey, "synthetic data");
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper(queryClient) });
    expect(result.current.verifying).toBe(true);

    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("Storage write unavailable");
    });
    const removeSpy = vi.spyOn(localStorage, "removeItem").mockImplementation(() => {
      throw new Error("Storage removal unavailable");
    });

    await act(async () => respond({ ok: true, json: async () => TEST_USER }));

    expect(removeSpy.mock.calls).toEqual([["carebridge_user"], ["carebridge_has_session"]]);
    expect(result.current.user).toBeNull();
    expect(result.current.sessionId).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.verifying).toBe(false);
    expect(queryClient.getQueryData(queryKey)).toBeUndefined();
    expect(window.location.href).toBe("/login");
  });

  it("pins User.role to the UserRole literal union (issue #829)", () => {
    // This test is deliberately compile-time driven: if someone widens
    // `User.role` back to `string`, the `UserRole` assignment below will
    // fail `tsc`. If someone narrows it further (e.g. drops a role), the
    // exhaustive switch loses its `never` fallthrough and also fails `tsc`.
    const user: User = {
      id: "role-check",
      email: "r@carebridge.dev",
      name: "Role Check",
      role: "physician",
    };

    // 1. Direct assignability: `user.role` must flow into `UserRole` with
    //    no cast. This fails if `role: string` is reintroduced.
    const narrowed: UserRole = user.role;
    expect(narrowed).toBe("physician");

    // 2. Exhaustive switch: omitting any member of the union makes
    //    `_exhaustive` a non-`never` value and fails compilation.
    function describeRole(role: UserRole): string {
      switch (role) {
        case "patient":
          return "patient";
        case "nurse":
          return "nurse";
        case "physician":
          return "physician";
        case "specialist":
          return "specialist";
        case "admin":
          return "admin";
        default: {
          const _exhaustive: never = role;
          return _exhaustive;
        }
      }
    }

    expect(describeRole(user.role)).toBe("physician");

    // 3. Runtime typo guard: assigning a string not in the union should
    //    be a compile-time error. We express that with a `@ts-expect-error`
    //    so the test file itself breaks if the type ever re-widens.
    // @ts-expect-error "doctor" is not a member of UserRole
    const _typo: User = { ...user, role: "doctor" };
    void _typo;
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

  it("waits for the cookie POST and server identity before publishing a new session", async () => {
    let finishCookie!: (response: Pick<Response, "ok">) => void;
    let finishIdentity!: (response: Pick<Response, "ok" | "json">) => void;
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => { finishCookie = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { finishIdentity = resolve; }));

    const { result } = renderHook(() => useAuth(), {
      wrapper: makeWrapper(),
    });
    let login!: Promise<void>;
    act(() => {
      login = result.current.setSession(CLINICIAN_USER, "test-session-token");
    });

    expect(result.current.verifying).toBe(true);
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem("carebridge_has_session")).toBeNull();
    await waitFor(() => expect(fetchMock.mock.calls).toHaveLength(1));
    expect(fetchMock.mock.calls[0]?.[0]).toContain("/auth/session");

    await act(async () => finishCookie({ ok: true }));
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/auth/me");
    expect(result.current.isAuthenticated).toBe(false);

    await act(async () => {
      finishIdentity({ ok: true, json: async () => CLINICIAN_USER });
      await login;
    });

    expect(result.current.user).toEqual(CLINICIAN_USER);
    expect(result.current.isAuthenticated).toBe(true);
    expect(localStorage.getItem("carebridge_has_session")).toBe("true");
  });

  it("keeps the browser signed out when the cookie POST fails", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.setSession(CLINICIAN_USER, "test-session-token"))
        .rejects.toThrow("Could not establish a browser session");
    });

    expect(result.current.verifying).toBe(false);
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem("carebridge_has_session")).toBeNull();
    expect(fetchMock.mock.calls).toHaveLength(1);
  });

  it.each([
    ["unavailable", null],
    ["a different user", DIFFERENT_USER],
  ])("rejects login when the browser identity is %s", async (_case, serverUser) => {
    mockAuthMeResponse(serverUser);
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.setSession(CLINICIAN_USER, "test-session-token"))
        .rejects.toThrow("Could not verify the browser session");
    });

    expect(result.current.verifying).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem("carebridge_has_session")).toBeNull();
  });

  it("finishes a failed login's cookie rollback before a newer login writes", async () => {
    let finishRollback!: (response: Pick<Response, "ok">) => void;
    fetchMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false })
      .mockReturnValueOnce(new Promise((resolve) => { finishRollback = resolve; }))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => DIFFERENT_USER });

    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper() });
    let firstLogin!: Promise<unknown>;
    act(() => {
      firstLogin = result.current.setSession(CLINICIAN_USER, "first-token").catch((error) => error);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/auth/session/clear"),
      expect.objectContaining({ method: "POST" }),
    ));

    let secondLogin!: Promise<void>;
    act(() => {
      secondLogin = result.current.setSession(DIFFERENT_USER, "second-token");
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.current.isAuthenticated).toBe(false);

    await act(async () => {
      finishRollback({ ok: true });
      await secondLogin;
    });
    expect(await firstLogin).toEqual(new Error("Could not verify the browser session. Please try again."));
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/auth/session", "/auth/me", "/auth/session/clear", "/auth/session", "/auth/me",
    ]);
    expect(result.current.user).toEqual(DIFFERENT_USER);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it.each([false, true])("orders logout between cookie writes when removal fails = %s", async (removalFails) => {
    let finishWrite!: (response: Pick<Response, "ok">) => void;
    let finishLogout!: (response: Pick<Response, "ok">) => void;
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => { finishWrite = resolve; }))
      .mockResolvedValueOnce({ ok: true })
      .mockReturnValueOnce(new Promise((resolve) => { finishLogout = resolve; }))
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, json: async () => DIFFERENT_USER });
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper() });

    let firstLogin!: Promise<unknown>;
    act(() => {
      firstLogin = result.current.setSession(CLINICIAN_USER, "first-token").catch((error) => error);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    if (removalFails) {
      vi.spyOn(localStorage, "removeItem").mockImplementationOnce(() => {
        throw new Error("Storage unavailable");
      });
    }
    let secondLogin!: Promise<void>;
    act(() => {
      result.current.clearSession();
      secondLogin = result.current.setSession(DIFFERENT_USER, "second-token");
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.isAuthenticated).toBe(false);

    await act(async () => finishWrite({ ok: true }));
    expect(await firstLogin).toEqual(new Error("Sign-in was interrupted."));
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/auth/session", "/auth/session/clear", "/auth/session/clear",
    ]);
    expect(result.current.user).toBeNull();

    await act(async () => {
      finishLogout({ ok: true });
      await secondLogin;
    });
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/auth/session", "/auth/session/clear", "/auth/session/clear", "/auth/session", "/auth/me",
    ]);
    expect(result.current.user).toEqual(DIFFERENT_USER);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it("rolls back the cookie when persisting the verified session fails", async () => {
    mockAuthMeResponse(CLINICIAN_USER);
    vi.spyOn(localStorage, "setItem").mockImplementationOnce(() => {
      throw new Error("Storage unavailable");
    });
    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper() });

    await act(async () => {
      await expect(result.current.setSession(CLINICIAN_USER, "test-session-token"))
        .rejects.toThrow("Storage unavailable");
    });

    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      "/auth/session", "/auth/me", "/auth/session/clear",
    ]);
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem("carebridge_has_session")).toBeNull();
  });

  it("ignores a successful restoration response after logout", async () => {
    localStorage.setItem("carebridge_user", JSON.stringify(TEST_USER));
    localStorage.setItem("carebridge_has_session", "true");
    let respond!: (response: Pick<Response, "ok" | "json">) => void;
    fetchMock
      .mockReturnValueOnce(new Promise((resolve) => { respond = resolve; }))
      .mockResolvedValue({ ok: true });

    const { result } = renderHook(() => useAuth(), { wrapper: makeWrapper() });
    expect(result.current.verifying).toBe(true);
    act(() => result.current.clearSession());

    await act(async () => respond({ ok: true, json: async () => TEST_USER }));

    expect(result.current.verifying).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(localStorage.getItem("carebridge_user")).toBeNull();
    expect(localStorage.getItem("carebridge_has_session")).toBeNull();
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

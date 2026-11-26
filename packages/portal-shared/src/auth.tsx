"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { UserRole } from "@carebridge/shared-types";
import { getApiBaseUrl } from "./trpc";

export interface User {
  id: string;
  email: string;
  name: string;
  /**
   * Narrowed to the `UserRole` literal union from `@carebridge/shared-types`
   * so consumers get exhaustiveness checking on role-based switches and the
   * compiler rejects typos (e.g. "doctor" vs "physician"). See issue #829.
   */
  role: UserRole;
  /**
   * Clinical specialty for physicians/specialists (e.g. "Hematology/Oncology",
   * "Interventional Radiology"). Populated by the auth service when the user
   * has a specialty assigned. Absent for patients and non-specialist roles.
   */
  specialty?: string;
  /**
   * Clinical department for staff (e.g. "Oncology", "Emergency"). Populated
   * for clinical staff; absent for patients.
   */
  department?: string;
  /**
   * Patient-role users link to their patient record via this id. Set on the
   * users table by the auth service. Used by useMyPatientRecord to do a
   * direct lookup instead of the legacy fragile name-match. Kept in
   * snake_case to match the API gateway's /auth/me response shape and the
   * users.patient_id DB column.
   */
  patient_id?: string;
}

export interface AuthContextValue {
  user: User | null;
  sessionId: string | null;
  setSession: (user: User, sessionId: string) => Promise<void>;
  clearSession: () => void;
  isAuthenticated: boolean;
  /** True after the initial localStorage read completes on the client. */
  hydrated: boolean;
  /**
   * True while the browser session is being established or restored.
   */
  verifying: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const USER_KEY = "carebridge_user";
// The session token is now stored in an HttpOnly cookie set by POST /auth/session.
// It is NOT stored in localStorage, which prevents XSS-based token theft.
// Only the non-sensitive user profile (name, role) is kept in localStorage for
// hydration on page reload.
const HAS_SESSION_KEY = "carebridge_has_session";

function removeStoredSession() {
  for (const key of [USER_KEY, HAS_SESSION_KEY]) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage may be unavailable. Continue clearing the remaining auth state.
    }
  }
}

/**
 * Sends the session token to the API gateway which writes it into an HttpOnly
 * cookie. This is the primary session transport — the cookie is inaccessible
 * to JavaScript and immune to XSS token theft.
 */
async function setSessionCookie(token: string): Promise<void> {
  const baseUrl = getApiBaseUrl();
  const response = await fetch(`${baseUrl}/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error("Could not establish a browser session. Please try again.");
}

/**
 * Clears the HttpOnly session cookie via the API gateway.
 */
async function clearSessionCookie(): Promise<void> {
  const baseUrl = getApiBaseUrl();
  await fetch(`${baseUrl}/auth/session/clear`, {
    method: "POST",
    credentials: "include",
  }).catch(() => {
    // Best-effort — if the server is unreachable the cookie will expire on its own.
  });
}

/**
 * Fetches the server-authoritative user identity. Returns `null` when the
 * session cookie is missing, expired, or invalid.
 */
async function fetchAuthMe(): Promise<User | null> {
  const baseUrl = getApiBaseUrl();
  try {
    const res = await fetch(`${baseUrl}/auth/me`, {
      credentials: "include",
    });
    if (!res.ok) return null;
    return (await res.json()) as User;
  } catch {
    // Network error — treat as unauthenticated.
    return null;
  }
}

export interface AuthProviderProps {
  children: ReactNode;
  /** Optional QueryClient reference; cleared on auth state transitions. */
  queryClient?: QueryClient;
}

export function AuthProvider({ children, queryClient }: AuthProviderProps) {
  // Initialize as null on both server and client to avoid hydration mismatch.
  // localStorage is read in useEffect after the first client render.
  const [user, setUser] = useState<User | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // An older restore or login must not publish auth state after a newer action.
  const sessionOperation = useRef(0);
  const cookieQueue = useRef(Promise.resolve());

  const enqueueCookieOperation = useCallback((run: () => Promise<void>) => {
    const result = cookieQueue.current.then(run);
    cookieQueue.current = result.catch(() => {});
    return result;
  }, []);

  /**
   * Internal helper: clears the QueryClient cache if supplied.
   * Called on any auth state transition (login, logout, identity mismatch).
   */
  const clearQueryCache = useCallback(() => {
    if (queryClient) {
      queryClient.clear();
    }
  }, [queryClient]);

  /**
   * Wipes local auth state and redirects to login.
   * Called when `/auth/me` fails or returns a different identity.
   */
  const invalidateAndRedirect = useCallback(() => {
    removeStoredSession();
    setUser(null);
    setSessionId(null);
    clearQueryCache();
    // Use window.location for a hard redirect to ensure all in-memory state
    // is discarded (React tree, module-level caches, etc.).
    if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
      window.location.href = "/login";
    }
  }, [clearQueryCache]);

  useEffect(() => {
    let cancelled = false;
    const operation = sessionOperation.current;
    let hasSession: string | null = null;
    let storedUser: string | null = null;
    try {
      hasSession = localStorage.getItem(HAS_SESSION_KEY);
      storedUser = localStorage.getItem(USER_KEY);
    } catch { /* blocked storage — stay logged out */ }

    setVerifying(!!hasSession);
    setHydrated(true);
    if (hasSession) {
      fetchAuthMe().then((serverUser) => {
        if (cancelled || operation !== sessionOperation.current) return;

        try {
          if (!serverUser || (storedUser && JSON.parse(storedUser).id !== serverUser.id)) {
            invalidateAndRedirect();
            return;
          }

          localStorage.setItem(USER_KEY, JSON.stringify(serverUser));
          setUser(serverUser);
          setSessionId(hasSession);
        } catch {
          invalidateAndRedirect();
        } finally {
          setVerifying(false);
        }
      });
    }

    return () => { cancelled = true; };
  }, [invalidateAndRedirect]);

  const setSession = useCallback((u: User, sid: string) => {
    const operation = ++sessionOperation.current;
    setVerifying(true);
    setUser(null);
    setSessionId(null);
    clearQueryCache();

    return enqueueCookieOperation(async () => {
      let cookieInstalled = false;
      try {
        if (operation !== sessionOperation.current) throw new Error("Sign-in was interrupted.");
        localStorage.removeItem(USER_KEY);
        localStorage.removeItem(HAS_SESSION_KEY);
        await setSessionCookie(sid);
        cookieInstalled = true;
        if (operation !== sessionOperation.current) throw new Error("Sign-in was interrupted.");

        const serverUser = await fetchAuthMe();
        if (operation !== sessionOperation.current) throw new Error("Sign-in was interrupted.");
        if (!serverUser || serverUser.id !== u.id) {
          throw new Error("Could not verify the browser session. Please try again.");
        }

        localStorage.setItem(USER_KEY, JSON.stringify(serverUser));
        localStorage.setItem(HAS_SESSION_KEY, "true");
        setUser(serverUser);
        setSessionId(sid);
      } catch (error) {
        if (cookieInstalled) {
          // Complete rollback before a later action can write its cookie.
          await clearSessionCookie();
        }
        throw error;
      } finally {
        if (operation === sessionOperation.current) setVerifying(false);
      }
    });
  }, [clearQueryCache, enqueueCookieOperation]);

  const clearSession = useCallback(() => {
    ++sessionOperation.current;
    setVerifying(false);
    void enqueueCookieOperation(clearSessionCookie);
    removeStoredSession();
    setUser(null);
    setSessionId(null);
    clearQueryCache();
  }, [clearQueryCache, enqueueCookieOperation]);

  return (
    <AuthContext.Provider
      value={{
        user,
        sessionId,
        setSession,
        clearSession,
        isAuthenticated: hydrated && !verifying && !!user && !!sessionId,
        hydrated,
        verifying,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}

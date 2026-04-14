"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { ReactNode } from "react";
import { getApiBaseUrl } from "./trpc";

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  specialty?: string;
  department?: string;
  // Patient-role users link to their patient record via this id. Set on the
  // users table by the auth service. Used by useMyPatientRecord to do a direct
  // lookup instead of the legacy fragile name-match.
  patient_id?: string;
}

export interface AuthContextValue {
  user: User | null;
  sessionId: string | null;
  setSession: (user: User, sessionId: string) => void;
  clearSession: () => void;
  isAuthenticated: boolean;
  /** True after the initial localStorage read completes on the client. */
  hydrated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const USER_KEY = "carebridge_user";
// The session token is now stored in an HttpOnly cookie set by POST /auth/session.
// It is NOT stored in localStorage, which prevents XSS-based token theft.
// Only the non-sensitive user profile (name, role) is kept in localStorage for
// hydration on page reload.
const HAS_SESSION_KEY = "carebridge_has_session";

/**
 * Sends the session token to the API gateway which writes it into an HttpOnly
 * cookie. This is the primary session transport — the cookie is inaccessible
 * to JavaScript and immune to XSS token theft.
 */
async function setSessionCookie(token: string): Promise<void> {
  const baseUrl = getApiBaseUrl();
  await fetch(`${baseUrl}/auth/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ token }),
  });
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

export function AuthProvider({ children }: { children: ReactNode }) {
  // Initialize as null on both server and client to avoid hydration mismatch.
  // localStorage is read in useEffect after the first client render.
  const [user, setUser] = useState<User | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(USER_KEY);
      if (stored) setUser(JSON.parse(stored) as User);
      // The actual session token lives in an HttpOnly cookie. We use a flag
      // in localStorage only to know whether we believe we have an active
      // session (for hydration / isAuthenticated on the client).
      const hasSession = localStorage.getItem(HAS_SESSION_KEY);
      if (hasSession) setSessionId(hasSession);
    } catch { /* corrupt / blocked storage — stay logged out */ }
    setHydrated(true);
  }, []);

  const setSession = useCallback((u: User, sid: string) => {
    // Write the session token into an HttpOnly cookie via the API gateway.
    // The token is NOT stored in localStorage — only a flag indicating an
    // active session exists (the flag itself is not the token).
    setSessionCookie(sid).catch(() => {
      // If the cookie endpoint fails, the Authorization header fallback in
      // the auth middleware will still work for the current page session.
    });
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    localStorage.setItem(HAS_SESSION_KEY, "true");
    setUser(u);
    setSessionId(sid);
  }, []);

  const clearSession = useCallback(() => {
    clearSessionCookie();
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(HAS_SESSION_KEY);
    setUser(null);
    setSessionId(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        sessionId,
        setSession,
        clearSession,
        isAuthenticated: !!user && !!sessionId,
        hydrated,
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

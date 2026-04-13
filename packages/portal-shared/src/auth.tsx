"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { ReactNode } from "react";

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

const SESSION_KEY = "carebridge_session";
const USER_KEY = "carebridge_user";

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
      setSessionId(localStorage.getItem(SESSION_KEY));
    } catch { /* corrupt / blocked storage — stay logged out */ }
    setHydrated(true);
  }, []);

  const setSession = useCallback((u: User, sid: string) => {
    localStorage.setItem(SESSION_KEY, sid);
    localStorage.setItem(USER_KEY, JSON.stringify(u));
    setUser(u);
    setSessionId(sid);
  }, []);

  const clearSession = useCallback(() => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(USER_KEY);
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

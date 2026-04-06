"use client";

import { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { ReactNode } from "react";

interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  specialty?: string;
  department?: string;
}

interface AuthContextValue {
  user: User | null;
  sessionId: string | null;
  setSession: (user: User, sessionId: string) => void;
  clearSession: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const SESSION_KEY = "carebridge_session";
const USER_KEY = "carebridge_user";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const stored = localStorage.getItem(USER_KEY);
      return stored ? (JSON.parse(stored) as User) : null;
    } catch {
      return null;
    }
  });

  const [sessionId, setSessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return localStorage.getItem(SESSION_KEY);
  });

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

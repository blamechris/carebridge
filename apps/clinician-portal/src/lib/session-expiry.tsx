"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import type { ReactNode } from "react";

// ── Constants ──────────────────────────────────────────────────────────────────

const IDLE_WARNING_MS = 14 * 60 * 1000; // 14 minutes
const IDLE_LOGOUT_MS = 15 * 60 * 1000; // 15 minutes
const LAST_ACTIVITY_KEY = "carebridge_last_activity";
const SESSION_EXPIRED_KEY = "carebridge_session_expired";
const ACTIVITY_EVENTS: Array<keyof WindowEventMap> = [
  "mousedown",
  "keydown",
  "scroll",
  "touchstart",
];

// ── Session expiry event bus (for 401 interception) ────────────────────────────

type SessionExpiredListener = () => void;
const listeners = new Set<SessionExpiredListener>();

export function onSessionExpired(listener: SessionExpiredListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function emitSessionExpired(): void {
  listeners.forEach((fn) => fn());
}

// ── 401-intercepting fetch wrapper ─────────────────────────────────────────────

/**
 * Wraps the global fetch to detect 401 responses. When a 401 is received,
 * clears the session state and triggers the session-expired flow.
 *
 * The session token lives in an HttpOnly cookie (not localStorage), so there
 * is no token to remove here — only the non-sensitive user profile flag.
 */
export function createAuthFetch(): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);

    if (response.status === 401) {
      localStorage.removeItem("carebridge_has_session");
      localStorage.removeItem("carebridge_user");
      localStorage.setItem(SESSION_EXPIRED_KEY, "true");
      emitSessionExpired();
    }

    return response;
  };
}

// ── Session Expiry Context ─────────────────────────────────────────────────────

interface SessionExpiryContextValue {
  showWarning: boolean;
  showExpiredToast: boolean;
  dismissExpiredToast: () => void;
  secondsRemaining: number;
}

const SessionExpiryContext = createContext<SessionExpiryContextValue>({
  showWarning: false,
  showExpiredToast: false,
  dismissExpiredToast: () => {},
  secondsRemaining: 60,
});

export function useSessionExpiry(): SessionExpiryContextValue {
  return useContext(SessionExpiryContext);
}

// ── Provider ───────────────────────────────────────────────────────────────────

interface SessionExpiryProviderProps {
  children: ReactNode;
  isAuthenticated: boolean;
  onLogout: () => void;
}

export function SessionExpiryProvider({
  children,
  isAuthenticated,
  onLogout,
}: SessionExpiryProviderProps) {
  const [showWarning, setShowWarning] = useState(false);
  const [showExpiredToast, setShowExpiredToast] = useState(false);
  const [secondsRemaining, setSecondsRemaining] = useState(60);

  const warningTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearAllTimers = useCallback(() => {
    if (warningTimerRef.current) clearTimeout(warningTimerRef.current);
    if (logoutTimerRef.current) clearTimeout(logoutTimerRef.current);
    if (countdownRef.current) clearInterval(countdownRef.current);
    warningTimerRef.current = null;
    logoutTimerRef.current = null;
    countdownRef.current = null;
  }, []);

  const performLogout = useCallback(() => {
    clearAllTimers();
    setShowWarning(false);
    setShowExpiredToast(true);
    localStorage.setItem(SESSION_EXPIRED_KEY, "true");
    onLogout();
  }, [clearAllTimers, onLogout]);

  const resetIdleTimers = useCallback(() => {
    if (!isAuthenticated) return;

    clearAllTimers();
    setShowWarning(false);
    setSecondsRemaining(60);
    localStorage.setItem(LAST_ACTIVITY_KEY, Date.now().toString());

    warningTimerRef.current = setTimeout(() => {
      setShowWarning(true);
      setSecondsRemaining(60);

      countdownRef.current = setInterval(() => {
        setSecondsRemaining((prev) => {
          if (prev <= 1) {
            if (countdownRef.current) clearInterval(countdownRef.current);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }, IDLE_WARNING_MS);

    logoutTimerRef.current = setTimeout(() => {
      performLogout();
    }, IDLE_LOGOUT_MS);
  }, [isAuthenticated, clearAllTimers, performLogout]);

  // Set up activity listeners
  useEffect(() => {
    if (!isAuthenticated) {
      clearAllTimers();
      return;
    }

    resetIdleTimers();

    const handleActivity = () => resetIdleTimers();

    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, handleActivity, { passive: true });
    }

    return () => {
      clearAllTimers();
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, handleActivity);
      }
    };
  }, [isAuthenticated, resetIdleTimers, clearAllTimers]);

  // Listen for 401-triggered session expiry
  useEffect(() => {
    if (!isAuthenticated) return;

    const unsubscribe = onSessionExpired(() => {
      clearAllTimers();
      setShowWarning(false);
      setShowExpiredToast(true);
      onLogout();
    });

    return unsubscribe;
  }, [isAuthenticated, clearAllTimers, onLogout]);

  // Check if we should show the expired toast on mount (e.g. after redirect)
  useEffect(() => {
    if (localStorage.getItem(SESSION_EXPIRED_KEY) === "true") {
      setShowExpiredToast(true);
      localStorage.removeItem(SESSION_EXPIRED_KEY);
    }
  }, []);

  const dismissExpiredToast = useCallback(() => {
    setShowExpiredToast(false);
  }, []);

  return (
    <SessionExpiryContext.Provider
      value={{ showWarning, showExpiredToast, dismissExpiredToast, secondsRemaining }}
    >
      {children}
      {showWarning && <IdleWarningBanner secondsRemaining={secondsRemaining} />}
      {showExpiredToast && (
        <SessionExpiredToast onDismiss={dismissExpiredToast} />
      )}
    </SessionExpiryContext.Provider>
  );
}

// ── UI Components ──────────────────────────────────────────────────────────────

function IdleWarningBanner({ secondsRemaining }: { secondsRemaining: number }) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 10000,
        backgroundColor: "#f59e0b",
        color: "#1a1a1a",
        padding: "12px 20px",
        textAlign: "center",
        fontWeight: 600,
        fontSize: "14px",
        boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
      }}
    >
      Session expiring in {secondsRemaining} second
      {secondsRemaining !== 1 ? "s" : ""}. Move your mouse or press a key to
      stay logged in.
    </div>
  );
}

function SessionExpiredToast({ onDismiss }: { onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      style={{
        position: "fixed",
        top: 20,
        right: 20,
        zIndex: 10001,
        backgroundColor: "#ef4444",
        color: "#fff",
        padding: "14px 24px",
        borderRadius: "8px",
        fontSize: "14px",
        fontWeight: 500,
        boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
        maxWidth: "400px",
        display: "flex",
        alignItems: "center",
        gap: "12px",
      }}
    >
      <span style={{ flex: 1 }}>
        Your session has expired. Please log in again.
      </span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: "none",
          border: "none",
          color: "#fff",
          cursor: "pointer",
          fontSize: "18px",
          lineHeight: 1,
          padding: "0 4px",
        }}
      >
        x
      </button>
    </div>
  );
}

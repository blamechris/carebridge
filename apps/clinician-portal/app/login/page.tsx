"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { UserRole } from "@carebridge/shared-types";
import { useAuth } from "@/lib/auth";
import { trpcVanilla } from "@/lib/trpc";
import { PasswordInput } from "@carebridge/portal-shared/password-input";

type LoginStep = "credentials" | "mfa";

export default function LoginPage() {
  const isDev = process.env.NODE_ENV === "development";
  const [email, setEmail] = useState(isDev ? "dr.smith@carebridge.dev" : "");
  const [password, setPassword] = useState(isDev ? "password123" : "");
  const [totpCode, setTotpCode] = useState("");
  const [mfaSessionId, setMfaSessionId] = useState<string | null>(null);
  const [step, setStep] = useState<LoginStep>("credentials");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { setSession } = useAuth();

  async function handleCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await trpcVanilla.auth.login.mutate({ email, password });
      if ("requiresMFA" in result && result.requiresMFA) {
        setMfaSessionId(result.mfaSessionId);
        setStep("mfa");
        return;
      }
      const loginResult = result as {
        user: { id: string; name: string; email: string; role: UserRole };
        session: { id: string };
      };
      setSession(loginResult.user, loginResult.session.id);
      router.push("/");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Login failed. Please try again.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }

  async function handleMFA(e: React.FormEvent) {
    e.preventDefault();
    if (!mfaSessionId) return;
    setError(null);
    setLoading(true);

    try {
      const result = await trpcVanilla.auth.mfaCompleteLogin.mutate({
        mfaSessionId,
        code: totpCode.trim(),
      });
      setSession(result.user, result.session.id);
      router.push("/");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Verification failed. Please try again.";
      setError(message);
      setTotpCode("");
    } finally {
      setLoading(false);
    }
  }

  function handleBackToLogin() {
    setStep("credentials");
    setMfaSessionId(null);
    setTotpCode("");
    setError(null);
  }

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        minHeight: "80vh",
      }}
    >
      <div className="detail-card" style={{ maxWidth: 400, width: "100%" }}>
        {step === "credentials" ? (
          <>
            <div className="detail-card-title" style={{ marginBottom: 24 }}>
              Sign In to CareBridge
            </div>

            <form onSubmit={handleCredentials}>
              <div style={{ marginBottom: 16 }}>
                <label
                  htmlFor="email"
                  style={{
                    display: "block",
                    fontSize: 13,
                    color: "var(--text-secondary)",
                    marginBottom: 4,
                  }}
                >
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  className="search-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  style={{ width: "100%" }}
                />
              </div>

              <div style={{ marginBottom: 16 }}>
                <label
                  htmlFor="password"
                  style={{
                    display: "block",
                    fontSize: 13,
                    color: "var(--text-secondary)",
                    marginBottom: 4,
                  }}
                >
                  Password
                </label>
                <PasswordInput
                  id="password"
                  className="search-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  style={{ width: "100%" }}
                />
              </div>

              {error && (
                <div
                  style={{
                    color: "var(--critical)",
                    fontSize: 13,
                    marginBottom: 12,
                  }}
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading}
                style={{ width: "100%" }}
              >
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>

            {isDev && (
              <div
                style={{
                  marginTop: 16,
                  fontSize: 12,
                  color: "var(--text-muted)",
                  textAlign: "center",
                }}
              >
                Dev accounts: dr.smith@carebridge.dev / dr.jones@carebridge.dev / nurse.rachel@carebridge.dev
              </div>
            )}
          </>
        ) : (
          <>
            <div className="detail-card-title" style={{ marginBottom: 8 }}>
              Two-Factor Authentication
            </div>
            <p
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                marginBottom: 24,
                lineHeight: 1.5,
              }}
            >
              Enter the 6-digit code from your authenticator app, or a recovery
              code to complete sign-in.
            </p>

            <form onSubmit={handleMFA}>
              <div style={{ marginBottom: 16 }}>
                <label
                  htmlFor="totp-code"
                  style={{
                    display: "block",
                    fontSize: 13,
                    color: "var(--text-secondary)",
                    marginBottom: 4,
                  }}
                >
                  Verification Code
                </label>
                <input
                  id="totp-code"
                  type="text"
                  className="search-input"
                  value={totpCode}
                  onChange={(e) => setTotpCode(e.target.value)}
                  placeholder="000000"
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={10}
                  required
                  // eslint-disable-next-line jsx-a11y/no-autofocus
                  autoFocus
                  style={{
                    width: "100%",
                    letterSpacing: "0.15em",
                    fontSize: 18,
                    textAlign: "center",
                  }}
                />
              </div>

              {error && (
                <div
                  style={{
                    color: "var(--critical)",
                    fontSize: 13,
                    marginBottom: 12,
                  }}
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="btn btn-primary"
                disabled={loading || totpCode.trim().length === 0}
                style={{ width: "100%", marginBottom: 8 }}
              >
                {loading ? "Verifying..." : "Verify"}
              </button>

              <button
                type="button"
                className="btn btn-ghost"
                onClick={handleBackToLogin}
                style={{ width: "100%" }}
              >
                Back to Sign In
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}

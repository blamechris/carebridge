"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpcVanilla } from "@/lib/trpc";

type LoginStep = "credentials" | "mfa";

export default function LoginPage() {
  const isDev = process.env.NODE_ENV === "development";
  const [email, setEmail] = useState(isDev ? "patient@carebridge.dev" : "");
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
      const loginResult = result as { user: { id: string; name: string; email: string; role: string }; session: { id: string } };
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

  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    backgroundColor: "#1a1a1a",
    border: "1px solid #2a2a2a",
    borderRadius: "6px",
    color: "#ededed",
    fontSize: "0.875rem",
  } as const;

  return (
    <div style={{ display: "flex", justifyContent: "center", marginTop: "4rem" }}>
      <div
        style={{
          maxWidth: 400,
          width: "100%",
          backgroundColor: "#1a1a1a",
          border: "1px solid #2a2a2a",
          borderRadius: "8px",
          padding: "2rem",
        }}
      >
        {step === "credentials" ? (
          <>
            <h2 style={{ margin: "0 0 1.5rem", fontSize: "1.25rem" }}>
              Sign In to Patient Portal
            </h2>

            <form onSubmit={handleCredentials}>
              <div style={{ marginBottom: "1rem" }}>
                <label
                  htmlFor="email"
                  style={{ display: "block", fontSize: "0.75rem", color: "#999", marginBottom: 4 }}
                >
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  style={inputStyle}
                />
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label
                  htmlFor="password"
                  style={{ display: "block", fontSize: "0.75rem", color: "#999", marginBottom: 4 }}
                >
                  Password
                </label>
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  style={inputStyle}
                />
              </div>

              {error && (
                <div style={{ color: "#ef4444", fontSize: "0.8rem", marginBottom: 12 }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                style={{
                  width: "100%",
                  padding: "10px",
                  backgroundColor: "#3b82f6",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: loading ? "not-allowed" : "pointer",
                  opacity: loading ? 0.7 : 1,
                  fontSize: "0.875rem",
                }}
              >
                {loading ? "Signing in..." : "Sign In"}
              </button>
            </form>

            {isDev && (
              <p style={{ marginTop: "1rem", fontSize: "0.75rem", color: "#666", textAlign: "center" }}>
                Dev account: patient@carebridge.dev / password123
              </p>
            )}
          </>
        ) : (
          <>
            <h2 style={{ margin: "0 0 0.5rem", fontSize: "1.25rem" }}>
              Two-Factor Authentication
            </h2>
            <p style={{ fontSize: "0.8rem", color: "#999", marginBottom: "1.5rem", lineHeight: 1.5 }}>
              Enter the 6-digit code from your authenticator app, or a recovery code to complete sign-in.
            </p>

            <form onSubmit={handleMFA}>
              <div style={{ marginBottom: "1rem" }}>
                <label
                  htmlFor="totp-code"
                  style={{ display: "block", fontSize: "0.75rem", color: "#999", marginBottom: 4 }}
                >
                  Verification Code
                </label>
                <input
                  id="totp-code"
                  type="text"
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
                    ...inputStyle,
                    letterSpacing: "0.15em",
                    fontSize: "1.125rem",
                    textAlign: "center",
                  }}
                />
              </div>

              {error && (
                <div style={{ color: "#ef4444", fontSize: "0.8rem", marginBottom: 12 }}>
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading || totpCode.trim().length === 0}
                style={{
                  width: "100%",
                  padding: "10px",
                  backgroundColor: "#3b82f6",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: (loading || totpCode.trim().length === 0) ? "not-allowed" : "pointer",
                  opacity: (loading || totpCode.trim().length === 0) ? 0.7 : 1,
                  fontSize: "0.875rem",
                  marginBottom: 8,
                }}
              >
                {loading ? "Verifying..." : "Verify"}
              </button>

              <button
                type="button"
                onClick={handleBackToLogin}
                style={{
                  width: "100%",
                  padding: "10px",
                  backgroundColor: "transparent",
                  color: "#999",
                  border: "1px solid #2a2a2a",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "0.875rem",
                }}
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

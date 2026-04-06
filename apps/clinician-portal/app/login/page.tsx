"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpcVanilla } from "@/lib/trpc";

export default function LoginPage() {
  const [email, setEmail] = useState("dr.smith@carebridge.dev");
  const [password, setPassword] = useState("password123");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { setSession } = useAuth();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await trpcVanilla.auth.login.mutate({ email, password });
      setSession(result.user, result.session.id);
      router.push("/");
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Login failed. Please try again.";
      setError(message);
    } finally {
      setLoading(false);
    }
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
        <div className="detail-card-title" style={{ marginBottom: 24 }}>
          Sign In to CareBridge
        </div>

        <form onSubmit={handleSubmit}>
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
            <input
              id="password"
              type="password"
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
      </div>
    </div>
  );
}

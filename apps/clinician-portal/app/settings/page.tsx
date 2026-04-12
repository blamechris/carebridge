"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth";
import { trpcVanilla } from "@/lib/trpc";
import { AuthGuard } from "@/lib/auth-guard";

type EnrollStep = "idle" | "setup" | "verify" | "done";
type DisableStep = "idle" | "confirm";

function MFASection() {
  // ── Enrollment state ──────────────────────────────────────────────
  const [enrollStep, setEnrollStep] = useState<EnrollStep>("idle");
  const [setupData, setSetupData] = useState<{
    secret: string;
    uri: string;
    qrCodeDataUrl: string;
    recoveryCodes: string[];
  } | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [enrollLoading, setEnrollLoading] = useState(false);

  // ── Disable state ─────────────────────────────────────────────────
  const [disableStep, setDisableStep] = useState<DisableStep>("idle");
  const [disableCode, setDisableCode] = useState("");
  const [disableError, setDisableError] = useState<string | null>(null);
  const [disableLoading, setDisableLoading] = useState(false);

  // ── Initiate setup ────────────────────────────────────────────────
  async function handleStartSetup() {
    setEnrollError(null);
    setEnrollLoading(true);
    try {
      const data = await trpcVanilla.auth.mfaSetup.mutate();
      setSetupData(data);
      setEnrollStep("setup");
    } catch (err: unknown) {
      setEnrollError(
        err instanceof Error ? err.message : "Failed to start MFA setup."
      );
    } finally {
      setEnrollLoading(false);
    }
  }

  // ── Verify TOTP and enable MFA ────────────────────────────────────
  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setEnrollError(null);
    setEnrollLoading(true);
    try {
      await trpcVanilla.auth.mfaVerify.mutate({ code: verifyCode.trim() });
      setEnrollStep("done");
    } catch (err: unknown) {
      setEnrollError(
        err instanceof Error ? err.message : "Verification failed."
      );
      setVerifyCode("");
    } finally {
      setEnrollLoading(false);
    }
  }

  // ── Disable MFA ───────────────────────────────────────────────────
  async function handleDisable(e: React.FormEvent) {
    e.preventDefault();
    setDisableError(null);
    setDisableLoading(true);
    try {
      await trpcVanilla.auth.mfaDisable.mutate({ code: disableCode.trim() });
      setDisableStep("idle");
      setDisableCode("");
      // Reset enrollment state so the user can re-enable
      setEnrollStep("idle");
      setSetupData(null);
      setVerifyCode("");
    } catch (err: unknown) {
      setDisableError(
        err instanceof Error ? err.message : "Failed to disable MFA."
      );
      setDisableCode("");
    } finally {
      setDisableLoading(false);
    }
  }

  // ── After a successful disable the section returns to "idle" ──────
  // ── After a successful enrollment it shows the "done" state ──────

  if (enrollStep === "done") {
    return (
      <div className="detail-card" style={{ marginBottom: 20 }}>
        <div className="detail-card-title">Two-Factor Authentication</div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 16,
          }}
        >
          <span className="badge badge-success">Enabled</span>
          <span style={{ fontSize: 13, color: "var(--text-secondary)" }}>
            Your account is protected with TOTP two-factor authentication.
          </span>
        </div>

        {disableStep === "idle" ? (
          <button
            className="btn btn-danger btn-sm"
            onClick={() => setDisableStep("confirm")}
          >
            Disable MFA
          </button>
        ) : (
          <form onSubmit={handleDisable} style={{ maxWidth: 320 }}>
            <p
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                marginBottom: 12,
              }}
            >
              Enter your current TOTP code to confirm disabling MFA.
            </p>
            <div style={{ marginBottom: 12 }}>
              <input
                type="text"
                className="search-input"
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                placeholder="000000"
                inputMode="numeric"
                maxLength={6}
                autoFocus
                required
                style={{ letterSpacing: "0.15em", textAlign: "center" }}
              />
            </div>
            {disableError && (
              <div
                style={{
                  color: "var(--critical)",
                  fontSize: 13,
                  marginBottom: 12,
                }}
              >
                {disableError}
              </div>
            )}
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="submit"
                className="btn btn-danger btn-sm"
                disabled={disableLoading || disableCode.length !== 6}
              >
                {disableLoading ? "Disabling..." : "Confirm Disable"}
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => {
                  setDisableStep("idle");
                  setDisableCode("");
                  setDisableError(null);
                }}
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    );
  }

  return (
    <div className="detail-card" style={{ marginBottom: 20 }}>
      <div className="detail-card-title">Two-Factor Authentication</div>

      {enrollStep === "idle" && (
        <>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            Add an extra layer of security to your account. Once enabled, you
            will need a TOTP authenticator app (such as Google Authenticator or
            Authy) each time you sign in.
          </p>
          {enrollError && (
            <div
              style={{
                color: "var(--critical)",
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              {enrollError}
            </div>
          )}
          <button
            className="btn btn-primary btn-sm"
            onClick={handleStartSetup}
            disabled={enrollLoading}
          >
            {enrollLoading ? "Setting up..." : "Enable MFA"}
          </button>
        </>
      )}

      {enrollStep === "setup" && setupData && (
        <>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            Scan the QR code below with your authenticator app, then enter the
            6-digit code it shows to confirm setup.
          </p>

          {/* QR code generated server-side as a data URL so the TOTP secret
              never leaves our infrastructure via a third-party service.
              See issue #280. */}
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              marginBottom: 16,
            }}
          >
            <img
              src={setupData.qrCodeDataUrl}
              alt="Scan this QR code with your authenticator app"
              width={180}
              height={180}
              style={{
                border: "4px solid #fff",
                borderRadius: 8,
                background: "#fff",
              }}
            />
          </div>

          <div
            style={{
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 6,
              padding: "8px 12px",
              marginBottom: 16,
            }}
          >
            <div
              style={{
                fontSize: 11,
                color: "var(--text-muted)",
                marginBottom: 4,
                textTransform: "uppercase",
                letterSpacing: "0.04em",
              }}
            >
              Manual entry key
            </div>
            <code
              style={{
                fontSize: 13,
                color: "var(--text-secondary)",
                letterSpacing: "0.08em",
                wordBreak: "break-all",
              }}
            >
              {setupData.secret}
            </code>
          </div>

          <div
            style={{
              background: "var(--warning-bg)",
              border: "1px solid var(--warning-border)",
              borderRadius: 6,
              padding: "10px 14px",
              marginBottom: 20,
            }}
          >
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--warning)",
                marginBottom: 8,
              }}
            >
              Save your recovery codes
            </div>
            <p
              style={{
                fontSize: 12,
                color: "var(--text-secondary)",
                marginBottom: 8,
                lineHeight: 1.4,
              }}
            >
              Store these codes somewhere safe. Each code can be used once if
              you lose access to your authenticator app.
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 4,
              }}
            >
              {setupData.recoveryCodes.map((code) => (
                <code
                  key={code}
                  style={{
                    fontSize: 12,
                    color: "var(--text-primary)",
                    fontFamily: "monospace",
                  }}
                >
                  {code}
                </code>
              ))}
            </div>
          </div>

          <button
            className="btn btn-ghost btn-sm"
            style={{ marginBottom: 20 }}
            onClick={() => {
              setEnrollStep("verify");
            }}
          >
            I have saved my recovery codes — Continue
          </button>
        </>
      )}

      {enrollStep === "verify" && (
        <form onSubmit={handleVerify} style={{ maxWidth: 320 }}>
          <p
            style={{
              fontSize: 13,
              color: "var(--text-secondary)",
              marginBottom: 16,
              lineHeight: 1.5,
            }}
          >
            Enter the 6-digit code from your authenticator app to confirm and
            activate MFA.
          </p>
          <div style={{ marginBottom: 12 }}>
            <input
              type="text"
              className="search-input"
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              placeholder="000000"
              inputMode="numeric"
              maxLength={6}
              autoFocus
              required
              style={{
                letterSpacing: "0.15em",
                fontSize: 18,
                textAlign: "center",
              }}
            />
          </div>
          {enrollError && (
            <div
              style={{
                color: "var(--critical)",
                fontSize: 13,
                marginBottom: 12,
              }}
            >
              {enrollError}
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={enrollLoading || verifyCode.trim().length !== 6}
            >
              {enrollLoading ? "Activating..." : "Activate MFA"}
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                setEnrollStep("setup");
                setVerifyCode("");
                setEnrollError(null);
              }}
            >
              Back
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function SettingsContent() {
  const { user } = useAuth();

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Account Settings</h1>
        <p className="page-subtitle">Manage your account and security preferences.</p>
      </div>

      <div style={{ maxWidth: 600 }}>
        {/* Profile info (read-only for now) */}
        <div className="detail-card" style={{ marginBottom: 20 }}>
          <div className="detail-card-title">Profile</div>
          <div className="detail-row">
            <span className="detail-label">Name</span>
            <span className="detail-value">{user?.name ?? "—"}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Email</span>
            <span className="detail-value">{user?.email ?? "—"}</span>
          </div>
          <div className="detail-row">
            <span className="detail-label">Role</span>
            <span className="detail-value" style={{ textTransform: "capitalize" }}>
              {user?.role ?? "—"}
            </span>
          </div>
          {user?.specialty && (
            <div className="detail-row">
              <span className="detail-label">Specialty</span>
              <span className="detail-value">{user.specialty}</span>
            </div>
          )}
          {user?.department && (
            <div className="detail-row">
              <span className="detail-label">Department</span>
              <span className="detail-value">{user.department}</span>
            </div>
          )}
        </div>

        {/* MFA enrollment */}
        <MFASection />
      </div>
    </>
  );
}

export default function SettingsPage() {
  return (
    <AuthGuard>
      <SettingsContent />
    </AuthGuard>
  );
}

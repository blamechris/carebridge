"use client";

import { useState, useEffect } from "react";

export type FlagAction = "acknowledge" | "resolve" | "dismiss";

export interface FlagActionModalFlag {
  id: string;
  severity: string;
  summary: string;
  suggested_action?: string;
}

interface FlagActionModalProps {
  flag: FlagActionModalFlag | null;
  action: FlagAction | null;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
  isSubmitting?: boolean;
  isSuccess?: boolean;
}

/**
 * Confirmation modal for flag state transitions.
 *
 * Requires a reason for dismiss and resolve actions. Dismiss is irreversible
 * and surfaces a prominent warning. All actions are persisted via the server
 * so an audit trail (user_id + reason + timestamp) is retained.
 */
export function FlagActionModal({
  flag,
  action,
  onCancel,
  onConfirm,
  isSubmitting = false,
  isSuccess = false,
}: FlagActionModalProps) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    setReason("");
  }, [flag?.id, action]);

  if (!flag || !action) return null;

  const reasonRequired = action === "dismiss" || action === "resolve";
  const canSubmit = !reasonRequired || reason.trim().length > 0;

  const titles: Record<FlagAction, string> = {
    acknowledge: "Acknowledge Flag",
    resolve: "Resolve Flag",
    dismiss: "Dismiss Flag",
  };

  const confirmLabels: Record<FlagAction, string> = {
    acknowledge: "Acknowledge",
    resolve: "Resolve",
    dismiss: "Dismiss Permanently",
  };

  const confirmClass =
    action === "dismiss"
      ? "btn btn-danger"
      : action === "resolve"
      ? "btn btn-success"
      : "btn btn-primary";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="flag-action-modal-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSubmitting) onCancel();
      }}
    >
      <div
        style={{
          background: "var(--surface, #1a1a1a)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: 24,
          maxWidth: 520,
          width: "100%",
          boxShadow: "0 20px 40px rgba(0,0,0,0.4)",
        }}
      >
        <h2
          id="flag-action-modal-title"
          style={{ marginTop: 0, marginBottom: 12, fontSize: 18 }}
        >
          {titles[action]}
        </h2>

        <div style={{ marginBottom: 16 }}>
          <span className={`badge badge-${flag.severity}`}>
            {flag.severity.toUpperCase()}
          </span>
          <div style={{ marginTop: 8, fontWeight: 500 }}>{flag.summary}</div>
          {flag.suggested_action && (
            <div
              style={{
                marginTop: 4,
                fontSize: 13,
                color: "var(--text-muted)",
              }}
            >
              {flag.suggested_action}
            </div>
          )}
        </div>

        {action === "dismiss" && (
          <div
            style={{
              padding: 12,
              marginBottom: 16,
              background: "rgba(220, 38, 38, 0.1)",
              border: "1px solid var(--critical-border, #dc2626)",
              borderRadius: 6,
              color: "var(--critical, #fca5a5)",
              fontSize: 13,
            }}
          >
            <strong>Warning:</strong> Dismissing this flag is irreversible. The
            flag will be permanently marked as not actionable. Your user ID and
            the reason below will be recorded in the audit trail.
          </div>
        )}

        {reasonRequired && (
          <div style={{ marginBottom: 16 }}>
            <label
              htmlFor="flag-reason-input"
              style={{
                display: "block",
                marginBottom: 6,
                fontSize: 13,
                fontWeight: 500,
              }}
            >
              Reason <span style={{ color: "var(--critical)" }}>*</span>
            </label>
            <textarea
              id="flag-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              disabled={isSubmitting}
              placeholder={
                action === "dismiss"
                  ? "Explain why this flag is not clinically actionable..."
                  : "Describe how the concern was addressed..."
              }
              style={{
                width: "100%",
                padding: 10,
                background: "var(--bg, #0a0a0a)",
                color: "var(--text)",
                border: "1px solid var(--border)",
                borderRadius: 4,
                fontFamily: "inherit",
                fontSize: 13,
                resize: "vertical",
              }}
            />
          </div>
        )}

        {isSuccess ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              padding: "12px 0 4px",
              color: "var(--success, #22c55e)",
              fontWeight: 500,
              fontSize: 14,
            }}
            role="status"
            aria-live="polite"
          >
            <span aria-hidden="true" style={{ fontSize: 18 }}>{"\u2713"}</span>
            Flag {action === "acknowledge" ? "acknowledged" : action === "resolve" ? "resolved" : "dismissed"} successfully
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
            }}
          >
            <button
              type="button"
              className="btn btn-ghost"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              Cancel
            </button>
            <button
              type="button"
              className={confirmClass}
              onClick={() => canSubmit && onConfirm(reason.trim())}
              disabled={!canSubmit || isSubmitting}
            >
              {isSubmitting ? "Saving..." : confirmLabels[action]}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

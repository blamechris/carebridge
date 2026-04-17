import React from "react";

/**
 * StaleDataBanner — alerts clinicians that displayed clinical data
 * (vitals, labs, etc.) is outdated.
 *
 * Uses role="status" (polite live region) rather than role="alert"
 * (assertive): a chronic chart banner should not interrupt a
 * screen-reader mid-sentence every time the clinician opens a patient
 * with week-old data. Explicit aria-live="polite" belt-and-suspenders
 * in case any AT doesn't map role="status" to a polite region by
 * default. (Issue #525.)
 */

export interface StaleDataBannerProps {
  /** ISO 8601 timestamp of the most-recent data point. */
  lastRecordedAt: string;
  /** Human label for the data category, e.g. "vitals" or "labs". */
  label: string;
}

export function StaleDataBanner({
  lastRecordedAt,
  label,
}: StaleDataBannerProps) {
  const ageMs = Date.now() - new Date(lastRecordedAt).getTime();
  const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        background: "var(--color-warning-bg, #fff3cd)",
        border: "1px solid var(--color-warning-border, #ffc107)",
        color: "var(--color-warning-text, #856404)",
        padding: "12px 16px",
        borderRadius: 6,
        fontSize: 14,
      }}
    >
      <strong>Stale {label}:</strong> last recorded {ageDays} day
      {ageDays === 1 ? "" : "s"} ago (
      {new Date(lastRecordedAt).toLocaleString()}). Values shown may not
      reflect the patient&rsquo;s current state.
    </div>
  );
}

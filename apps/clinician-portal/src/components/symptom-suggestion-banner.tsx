"use client";

/**
 * SymptomSuggestionBanner — issue #1305.
 *
 * Surfaces structured-checkbox suggestions for symptoms a clinician has
 * already mentioned in the Chief Complaint free-text field. The banner
 * sits directly above the New Symptoms multiselect; the inline highlight
 * (driven by the same `detectSuggestions` output and rendered inside
 * GroupedMultiselect) catches users who skip the banner.
 *
 * Design pillars:
 *
 *   1. Detection only. Neither the banner nor the highlight modifies the
 *      ticked state — every change requires explicit user action.
 *   2. Negation-aware. We use `hasUnnegatedMention` from
 *      `@carebridge/medical-logic` so phrases like "no headache" or the
 *      ROS-style comma cascade ("no fever, no nausea") never surface a
 *      suggestion.
 *   3. Plural-tolerant. Because the helper does whole-token matching,
 *      "headaches" does not match "headache" directly. We also probe the
 *      naive "<term>s" form so common plurals still surface, while
 *      letting the helper's negation logic still apply (negation is
 *      checked against whichever surface form matched).
 *   4. Dismiss is sticky per Chief Complaint text. The parent passes a
 *      `dismissedForText` value; the banner hides itself when the
 *      currently-detected suggestions were dismissed against the same
 *      Chief Complaint text. Typing in CC naturally clears the dismissal
 *      because the equality check fails.
 *   5. Hide already-ticked. Suggestions that the user has already ticked
 *      are filtered out — keeping them in the banner would be visual
 *      noise (and "Tick all" would have nothing to do).
 */

import { useMemo } from "react";
import { hasUnnegatedMention } from "@carebridge/medical-logic";

export type SymptomSuggestionBannerProps = {
  /** Current Chief Complaint free-text value. */
  chiefComplaintText: string;
  /** All New Symptoms option strings. */
  allSymptomOptions: string[];
  /** Symptom strings the clinician has already ticked. */
  currentlyTicked: string[];
  /**
   * Chief Complaint text against which the user previously clicked
   * "Dismiss". When this equals the current `chiefComplaintText`, the
   * banner stays hidden. Pass `null` if no dismissal is active.
   */
  dismissedForText: string | null;
  /** Invoked when the user clicks "Tick all suggested". */
  onTickAll: (suggestions: string[]) => void;
  /** Invoked when the user clicks "Dismiss". */
  onDismiss: (chiefComplaintText: string) => void;
};

/**
 * Compute which options from `allSymptomOptions` are mentioned in
 * `chiefComplaintText` in a non-negated way. Used by both the banner
 * (to populate the suggestion list) and the parent page (to drive the
 * inline highlight on the matching checkboxes). Pulled out as a pure
 * function so the highlight and the banner stay in lockstep.
 *
 * Plural handling: the helper does whole-token matching, so "headaches"
 * does not match the option "headache" on its own. We try the bare
 * option first; if that fails AND the option does not already end in
 * "s", we retry with the naive "<term>s" plural. Negation lookback runs
 * against whichever surface form matched, so "no headaches" still
 * resolves to "not detected".
 */
export function detectSuggestions(
  chiefComplaintText: string,
  allSymptomOptions: string[],
): string[] {
  if (!chiefComplaintText || allSymptomOptions.length === 0) return [];
  const out: string[] = [];
  for (const opt of allSymptomOptions) {
    if (hasUnnegatedMention(chiefComplaintText, opt)) {
      out.push(opt);
      continue;
    }
    // Naive plural fallback: try "<opt>s". Skip if the option already
    // ends in "s" (the bare check would have caught it) or if it
    // contains a space (multi-word options pluralise the last token,
    // which the helper's whole-word match handles for us as long as we
    // probe the plural of the last word).
    if (opt.endsWith("s")) continue;
    if (opt.includes(" ")) {
      const parts = opt.split(" ");
      const pluralised = [...parts.slice(0, -1), `${parts[parts.length - 1]}s`].join(
        " ",
      );
      if (hasUnnegatedMention(chiefComplaintText, pluralised)) {
        out.push(opt);
      }
      continue;
    }
    if (hasUnnegatedMention(chiefComplaintText, `${opt}s`)) {
      out.push(opt);
    }
  }
  return out;
}

export function SymptomSuggestionBanner({
  chiefComplaintText,
  allSymptomOptions,
  currentlyTicked,
  dismissedForText,
  onTickAll,
  onDismiss,
}: SymptomSuggestionBannerProps) {
  const detected = useMemo(
    () => detectSuggestions(chiefComplaintText, allSymptomOptions),
    [chiefComplaintText, allSymptomOptions],
  );

  // Hide options the user has already ticked — there's nothing left to
  // suggest for them, and "Tick all" would be a no-op.
  const tickedSet = useMemo(() => new Set(currentlyTicked), [currentlyTicked]);
  const unticked = useMemo(
    () => detected.filter((d) => !tickedSet.has(d)),
    [detected, tickedSet],
  );

  // Dismissal: hide the banner only when the user dismissed THIS exact
  // CC text. Any subsequent edit to CC re-renders the banner.
  const isDismissed =
    dismissedForText !== null && dismissedForText === chiefComplaintText;

  if (isDismissed) return null;
  if (unticked.length === 0) return null;

  return (
    <div
      className="symptom-suggestion-banner"
      role="status"
      aria-live="polite"
      data-testid="symptom-suggestion-banner"
      style={{
        border: "1px solid var(--accent, #2b6cb0)",
        background: "var(--surface-2, rgba(43, 108, 176, 0.08))",
        borderRadius: 4,
        padding: 8,
        marginBottom: 6,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        <span aria-hidden="true">{"ⓘ"}</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <span style={{ fontWeight: 600 }}>Detected in Chief Complaint:</span>
          <span data-testid="symptom-suggestion-list">
            {unticked.join(", ")}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onTickAll(unticked)}
          style={{ fontSize: 12, padding: "2px 8px" }}
          data-testid="symptom-suggestion-tick-all"
        >
          Tick all suggested
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onDismiss(chiefComplaintText)}
          style={{ fontSize: 12, padding: "2px 8px" }}
          data-testid="symptom-suggestion-dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

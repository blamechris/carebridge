"use client";

/**
 * GroupedMultiselect — issue #1306.
 *
 * Renders a multiselect checkbox grid grouped by body system. Each
 * group is a collapsible section with a `▾`/`▸` toggle and (when
 * collapsed) a `(N)` count of ticked items.
 *
 * Used for the SOAP Subjective "New Symptoms" and "Review of Systems"
 * fields. The component is data-shape agnostic: the caller supplies
 * the option list plus a `groupOf(option)` function that maps each
 * raw option string to a body-system bucket. The caller also owns the
 * collapse state and the optional NS↔ROS link affordances.
 *
 * Mobile responsiveness (<600px) is driven by the `grouped-multiselect`
 * class hooks consumed by globals.css.
 */

import { type CSSProperties, useMemo } from "react";
import {
  type BodySystem,
  sortBodySystems,
} from "@/lib/symptom-systems";

export type GroupedMultiselectProps = {
  /** Identifier used to namespace ids (e.g. `new_symptoms`). */
  fieldKey: string;
  /** Raw options exactly as they appear in the template. */
  options: string[];
  /** Currently selected option strings. */
  selected: string[];
  /** Notified when the selection changes. */
  onChange: (next: string[]) => void;
  /**
   * Maps an option to its body-system bucket. The result drives both
   * grouping (which section a row belongs in) and the display label
   * (what the row shows in the row body).
   */
  groupOf: (option: string) => { system: BodySystem; display: string };
  /** Per-system collapsed state. Missing key → use `defaultExpanded`. */
  collapsed: Partial<Record<BodySystem, boolean>>;
  /** Toggle handler — flips the collapsed state for one system. */
  onToggleSection: (system: BodySystem) => void;
  /** Initial expansion state for sections not in `collapsed`. */
  defaultExpanded: boolean;
  /**
   * Linked indicator: when an option string appears in this set, a 🔗
   * indicator renders next to the row. Clicking the icon invokes
   * `onUnlink` for the option.
   */
  linkedOptions?: Set<string>;
  /** Click handler for the 🔗 icon. Receives the option string. */
  onUnlink?: (option: string) => void;
};

const linkButtonStyle: CSSProperties = {
  marginLeft: 4,
  padding: 0,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: 1,
};

export function GroupedMultiselect({
  fieldKey,
  options,
  selected,
  onChange,
  groupOf,
  collapsed,
  onToggleSection,
  defaultExpanded,
  linkedOptions,
  onUnlink,
}: GroupedMultiselectProps) {
  // Bucket options by body system, preserving original option order
  // within each bucket so the curated NS ordering survives.
  const buckets = useMemo(() => {
    const map = new Map<BodySystem, { option: string; display: string }[]>();
    for (const opt of options) {
      const { system, display } = groupOf(opt);
      const arr = map.get(system) ?? [];
      arr.push({ option: opt, display });
      map.set(system, arr);
    }
    return map;
  }, [options, groupOf]);

  const orderedSystems = useMemo(
    () => sortBodySystems([...buckets.keys()]),
    [buckets],
  );

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  function toggleOption(option: string, checked: boolean) {
    if (checked) {
      if (!selectedSet.has(option)) {
        onChange([...selected, option]);
      }
    } else {
      onChange(selected.filter((s) => s !== option));
    }
  }

  return (
    <div
      className="grouped-multiselect"
      data-field-key={fieldKey}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 8,
      }}
    >
      {orderedSystems.map((system) => {
        const rows = buckets.get(system) ?? [];
        const checkedCount = rows.filter((r) => selectedSet.has(r.option))
          .length;
        const isCollapsed =
          collapsed[system] !== undefined
            ? collapsed[system]!
            : !defaultExpanded;
        const headerId = `${fieldKey}-${system.replace(/[^a-zA-Z0-9]/g, "_")}-header`;
        const regionId = `${fieldKey}-${system.replace(/[^a-zA-Z0-9]/g, "_")}-region`;

        return (
          <section
            key={system}
            className="grouped-multiselect-section"
            data-system={system}
            style={{
              border: "1px solid var(--border)",
              borderRadius: 4,
              overflow: "hidden",
            }}
          >
            <button
              type="button"
              id={headerId}
              className="grouped-multiselect-header"
              aria-expanded={!isCollapsed}
              aria-controls={regionId}
              onClick={() => onToggleSection(system)}
              style={{
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 6,
                padding: "6px 8px",
                background: "var(--surface-2, transparent)",
                border: "none",
                borderBottom: isCollapsed
                  ? "none"
                  : "1px solid var(--border)",
                cursor: "pointer",
                fontSize: 13,
                fontWeight: 600,
                textAlign: "left",
              }}
            >
              <span aria-hidden="true" style={{ width: "1em" }}>
                {isCollapsed ? "▸" : "▾"}
              </span>
              <span>{system}</span>
              {isCollapsed && checkedCount > 0 && (
                <span
                  className="grouped-multiselect-count"
                  style={{
                    marginLeft: 4,
                    fontSize: 12,
                    color: "var(--text-muted)",
                    fontWeight: 400,
                  }}
                >
                  ({checkedCount})
                </span>
              )}
            </button>
            {!isCollapsed && (
              <div
                id={regionId}
                role="region"
                aria-labelledby={headerId}
                className="grouped-multiselect-options"
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  padding: 8,
                }}
              >
                {rows.map(({ option, display }) => {
                  const checked = selectedSet.has(option);
                  const linked = linkedOptions?.has(option) ?? false;
                  return (
                    <label
                      key={option}
                      className="grouped-multiselect-option"
                      style={{
                        fontSize: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          toggleOption(option, e.target.checked)
                        }
                      />
                      <span>{display}</span>
                      {linked && (
                        <button
                          type="button"
                          aria-label={`Unlink ${display} from the matching entry`}
                          title="Unlink this pair — each row will then track independently"
                          onClick={(e) => {
                            // Prevent the surrounding <label> from
                            // toggling the checkbox when the icon is
                            // clicked.
                            e.preventDefault();
                            e.stopPropagation();
                            onUnlink?.(option);
                          }}
                          style={linkButtonStyle}
                          data-linked-option={option}
                        >
                          <span aria-hidden="true">{"🔗"}</span>
                        </button>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

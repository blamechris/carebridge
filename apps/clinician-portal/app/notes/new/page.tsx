"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { AuthGuard } from "@/lib/auth-guard";
import { useAuth } from "@/lib/auth";
import { GroupedMultiselect } from "@/components/grouped-multiselect";
import {
  detectSuggestions,
  SymptomSuggestionBanner,
} from "@/components/symptom-suggestion-banner";
import {
  type BodySystem,
  getSymptomSystem,
  parseROSOption,
} from "@/lib/symptom-systems";
import {
  findNSOptionForROS,
  findROSOptionForSymptom,
} from "@/lib/symptom-normalization";
import {
  usePersistedRecord,
  usePersistedStringSet,
} from "@/lib/use-persisted-symptom-state";

type FieldType =
  | "text"
  | "textarea"
  | "select"
  | "multiselect"
  | "checkbox"
  | "number";

type NoteField = {
  key: string;
  label: string;
  value: string | string[] | boolean | number | null;
  field_type: FieldType;
  source: "new_entry" | "carried_forward" | "modified";
  options?: string[];
};

type NoteSection = {
  key: string;
  label: string;
  fields: NoteField[];
  free_text?: string;
};

type TemplateType = "soap" | "progress";

/**
 * NS and ROS field keys recognised by the SOAP template (see
 * services/clinical-notes/src/templates/soap.ts). Keeping these as
 * named constants lets the auto-mirror logic stay readable.
 */
const NEW_SYMPTOMS_KEY = "new_symptoms";
const ROS_KEY = "ros";
const CHIEF_COMPLAINT_KEY = "chief_complaint";

const NS_CAPTION = "Symptoms the patient is reporting today.";
const ROS_CAPTION =
  "Full systems review for the visit (“all systems negative” allowed).";

/**
 * Stable key for a NS-ROS pair (used as the unlinked-pair identifier).
 */
function pairKey(nsOption: string, rosOption: string): string {
  return `${nsOption}||${rosOption}`;
}

/**
 * localStorage keys for the persisted symptom UX state. A single global
 * key per slot (rather than per-draft) means a clinician's collapse and
 * unlink preferences follow them across drafts, which matches the
 * specialty-driven workflow the affordance was designed for. #1311.
 */
const COLLAPSE_STORAGE_KEY = "cb-symptom-collapse-state";
const UNLINKED_PAIRS_STORAGE_KEY = "cb-symptom-unlinked-pairs";

function FieldInput({
  field,
  onChange,
}: {
  field: NoteField;
  onChange: (value: NoteField["value"]) => void;
}) {
  if (field.field_type === "textarea") {
    return (
      <textarea
        className="search-input"
        style={{ width: "100%", minHeight: 80, padding: 8 }}
        value={(field.value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.field_type === "checkbox") {
    return (
      <input
        type="checkbox"
        checked={!!field.value}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.field_type === "number") {
    return (
      <input
        type="number"
        className="search-input"
        style={{ width: "100%" }}
        value={field.value === null ? "" : Number(field.value)}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
      />
    );
  }
  if (field.field_type === "multiselect" && field.options) {
    const selected = Array.isArray(field.value) ? field.value : [];
    return (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          maxHeight: 120,
          overflowY: "auto",
          padding: 8,
          border: "1px solid var(--border)",
          borderRadius: 4,
        }}
      >
        {field.options.map((opt) => {
          const checked = selected.includes(opt);
          return (
            <label
              key={opt}
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
                onChange={(e) => {
                  if (e.target.checked) {
                    onChange([...selected, opt]);
                  } else {
                    onChange(selected.filter((s) => s !== opt));
                  }
                }}
              />
              {opt}
            </label>
          );
        })}
      </div>
    );
  }
  if (field.field_type === "select" && field.options) {
    return (
      <select
        className="search-input"
        style={{ width: "100%" }}
        value={(field.value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {field.options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type="text"
      className="search-input"
      style={{ width: "100%" }}
      value={(field.value as string) ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NewNoteContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const [templateType, setTemplateType] = useState<TemplateType>("soap");
  // Pre-fill the patient when arriving from a patient-chart "+ New Note"
  // affordance (`/notes/new?patientId=...`). #1263.
  const [patientId, setPatientId] = useState<string>(
    () => searchParams.get("patientId") ?? "",
  );
  // Inline notice shown when a prefilled patientId is reconciled away
  // because the loaded patient list doesn't contain it (deleted, no
  // access, or malformed UUID). #1274.
  const [patientPrefillNotice, setPatientPrefillNotice] = useState<string>("");
  const [sections, setSections] = useState<NoteSection[]>([]);

  // Per-field collapsed state for body-system groups, keyed as
  // `{ [fieldKey]: { [BodySystem]: collapsed } }`. Persisted to
  // localStorage so the affordance survives template changes, remounts,
  // and tab reloads. #1311.
  const [sectionCollapseState, setSectionCollapseState] = usePersistedRecord<
    Record<string, Partial<Record<BodySystem, boolean>>>
  >(COLLAPSE_STORAGE_KEY, {});

  // Pairs the user has explicitly unlinked via the 🔗 icon. Stored as
  // `"<nsOption>||<rosOption>"` strings so the set is membership-cheap.
  // Persisted to localStorage so the unlink choice survives remounts
  // and reloads. #1311.
  const [unlinkedPairs, setUnlinkedPairs] = usePersistedStringSet(
    UNLINKED_PAIRS_STORAGE_KEY,
  );

  // Sticky dismiss state for the symptom-suggestion banner (#1305).
  // Holds the Chief Complaint text against which the user clicked
  // "Dismiss". The banner hides itself when the CC text still equals
  // this string; any subsequent edit clears the dismissal naturally
  // because the equality check fails.
  const [dismissedBannerText, setDismissedBannerText] = useState<string | null>(
    null,
  );

  const patientsQuery = trpc.patients.list.useQuery();
  const templateQuery = trpc.notes.templates.get.useQuery({ type: templateType });

  // Track the template type that produced the currently-loaded sections
  // so we only reset per-field UI state when the user actually switches
  // template type. On a fresh mount the template fetch resolves with
  // the SAME type that's already selected; without this guard the reset
  // would clobber persisted state restored from localStorage. #1311.
  const lastLoadedTemplateType = useRef<TemplateType | null>(null);

  useEffect(() => {
    if (!templateQuery.data) return;
    setSections(templateQuery.data as unknown as NoteSection[]);
    if (
      lastLoadedTemplateType.current !== null &&
      lastLoadedTemplateType.current !== templateType
    ) {
      // Switching templates resets per-field UI state so a draft with
      // a different field shape doesn't inherit stale toggles.
      setSectionCollapseState({});
      setUnlinkedPairs(new Set());
      setDismissedBannerText(null);
    }
    lastLoadedTemplateType.current = templateType;
  }, [
    templateQuery.data,
    templateType,
    setSectionCollapseState,
    setUnlinkedPairs,
  ]);

  // Reconcile a prefilled patientId against the loaded patient list. If
  // the id isn't present (deleted, not accessible, malformed), clear it
  // and surface a small inline notice so the user picks again instead of
  // submitting a value the server will 403. #1274.
  useEffect(() => {
    if (!patientsQuery.data || !patientId) return;
    if (!patientsQuery.data.some((p) => p.id === patientId)) {
      setPatientId("");
      setPatientPrefillNotice(
        "Patient not available — please pick another.",
      );
    }
  }, [patientsQuery.data, patientId]);

  const createMutation = trpc.notes.create.useMutation({
    onSuccess: (note) => {
      router.push(`/notes/${note.id}`);
    },
  });

  function updateField(
    sectionIdx: number,
    fieldIdx: number,
    value: NoteField["value"],
  ) {
    setSections((prev) => {
      const next = prev.map((s) => ({
        ...s,
        fields: s.fields.map((f) => ({ ...f })),
      }));
      next[sectionIdx].fields[fieldIdx].value = value;
      next[sectionIdx].fields[fieldIdx].source = "modified";
      return next;
    });
  }

  // Resolve which section + field index a key lives at. Used by the
  // NS↔ROS auto-mirror to update the paired field in one render.
  const fieldLocations = useMemo(() => {
    const out = new Map<string, { sIdx: number; fIdx: number }>();
    sections.forEach((s, sIdx) => {
      s.fields.forEach((f, fIdx) => {
        out.set(f.key, { sIdx, fIdx });
      });
    });
    return out;
  }, [sections]);

  /**
   * Resolve the current Chief Complaint free-text value out of the
   * sections array. Used by the symptom-suggestion banner (#1305) and
   * by the inline highlight that flags suggested checkboxes inside the
   * New Symptoms group. Returns an empty string when CC is absent so
   * downstream callers don't need to null-guard.
   */
  const chiefComplaintText = useMemo(() => {
    const loc = fieldLocations.get(CHIEF_COMPLAINT_KEY);
    if (!loc) return "";
    const field = sections[loc.sIdx]?.fields[loc.fIdx];
    if (!field) return "";
    return typeof field.value === "string" ? field.value : "";
  }, [fieldLocations, sections]);

  /**
   * NS ↔ ROS auto-mirror.
   *
   * When the user ticks a NS option (e.g. "headache"), look up the
   * matching ROS option ("neurological: headache") and tick that too,
   * unless the pair has been explicitly unlinked. Untick mirrors the
   * same way (positive on one side → positive on the other, untick on
   * one side → untick on the other). Either direction works.
   *
   * The save payload still contains two independent arrays — the link
   * is purely a UI affordance, so on submit the server sees whatever
   * the final ticked state was.
   */
  const handleMultiselectChange = useCallback(
    (
      sIdx: number,
      fIdx: number,
      field: NoteField,
      nextValue: string[],
    ) => {
      const prevValue = Array.isArray(field.value)
        ? (field.value as string[])
        : [];

      // Compute additions / removals on this field.
      const added = nextValue.filter((v) => !prevValue.includes(v));
      const removed = prevValue.filter((v) => !nextValue.includes(v));

      // Mirror only fires for the two known fields.
      const isNS = field.key === NEW_SYMPTOMS_KEY;
      const isROS = field.key === ROS_KEY;

      // Apply this field's own change first.
      setSections((prev) => {
        const next = prev.map((s) => ({
          ...s,
          fields: s.fields.map((f) => ({ ...f })),
        }));
        next[sIdx].fields[fIdx].value = nextValue;
        next[sIdx].fields[fIdx].source = "modified";

        if (!(isNS || isROS)) return next;

        // Find the paired field on the same section.
        const partnerKey = isNS ? ROS_KEY : NEW_SYMPTOMS_KEY;
        const loc = fieldLocations.get(partnerKey);
        if (!loc) return next;

        const partner = next[loc.sIdx].fields[loc.fIdx];
        const partnerOptions = partner.options ?? [];
        const partnerSelected = Array.isArray(partner.value)
          ? [...(partner.value as string[])]
          : [];

        for (const add of added) {
          const partnerOpt = isNS
            ? findROSOptionForSymptom(add, partnerOptions)
            : findNSOptionForROS(add, partnerOptions);
          if (!partnerOpt) continue;
          // The pair key is always nsOption||rosOption regardless of
          // which side we came from.
          const key = isNS
            ? pairKey(add, partnerOpt)
            : pairKey(partnerOpt, add);
          if (unlinkedPairs.has(key)) continue;
          if (!partnerSelected.includes(partnerOpt)) {
            partnerSelected.push(partnerOpt);
          }
        }
        for (const drop of removed) {
          const partnerOpt = isNS
            ? findROSOptionForSymptom(drop, partnerOptions)
            : findNSOptionForROS(drop, partnerOptions);
          if (!partnerOpt) continue;
          const key = isNS
            ? pairKey(drop, partnerOpt)
            : pairKey(partnerOpt, drop);
          if (unlinkedPairs.has(key)) continue;
          const idx = partnerSelected.indexOf(partnerOpt);
          if (idx >= 0) partnerSelected.splice(idx, 1);
        }

        next[loc.sIdx].fields[loc.fIdx] = {
          ...partner,
          value: partnerSelected,
          source: "modified",
        };
        return next;
      });
    },
    [fieldLocations, unlinkedPairs],
  );

  /**
   * Toggle one body-system group's collapsed state. Falls back to the
   * default expansion (NS expanded / ROS collapsed) on first touch so
   * the first click feels intentional rather than no-op.
   */
  const toggleSection = useCallback(
    (fieldKey: string, system: BodySystem, defaultExpanded: boolean) => {
      setSectionCollapseState((prev) => {
        const fieldState = prev[fieldKey] ?? {};
        const current =
          fieldState[system] !== undefined
            ? fieldState[system]!
            : !defaultExpanded;
        return {
          ...prev,
          [fieldKey]: {
            ...fieldState,
            [system]: !current,
          },
        };
      });
    },
    [setSectionCollapseState],
  );

  /**
   * Unlink a NS/ROS pair via the 🔗 icon. The icon dispatches the bare
   * option the user clicked on; we resolve the partner and record the
   * pair as unlinked. Future ticks on either side no longer mirror.
   */
  const handleUnlink = useCallback(
    (sourceField: NoteField, option: string) => {
      const isNS = sourceField.key === NEW_SYMPTOMS_KEY;
      const isROS = sourceField.key === ROS_KEY;
      if (!(isNS || isROS)) return;
      const partnerKey = isNS ? ROS_KEY : NEW_SYMPTOMS_KEY;
      const loc = fieldLocations.get(partnerKey);
      if (!loc) return;
      const partnerOptions =
        sections[loc.sIdx].fields[loc.fIdx].options ?? [];
      const partnerOpt = isNS
        ? findROSOptionForSymptom(option, partnerOptions)
        : findNSOptionForROS(option, partnerOptions);
      if (!partnerOpt) return;
      const key = isNS
        ? pairKey(option, partnerOpt)
        : pairKey(partnerOpt, option);
      setUnlinkedPairs((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
    },
    [fieldLocations, sections, setUnlinkedPairs],
  );

  /**
   * Compute the set of currently-linked option strings (within a given
   * field) for the 🔗 indicator. A row is "linked" when (a) it is
   * ticked, (b) the partner field also has its analog ticked, and (c)
   * the pair is not in `unlinkedPairs`.
   */
  function linkedOptionsFor(fieldKey: string): Set<string> {
    const out = new Set<string>();
    const nsLoc = fieldLocations.get(NEW_SYMPTOMS_KEY);
    const rosLoc = fieldLocations.get(ROS_KEY);
    if (!nsLoc || !rosLoc) return out;
    const nsField = sections[nsLoc.sIdx].fields[nsLoc.fIdx];
    const rosField = sections[rosLoc.sIdx].fields[rosLoc.fIdx];
    const nsSelected = Array.isArray(nsField.value)
      ? (nsField.value as string[])
      : [];
    const rosSelected = Array.isArray(rosField.value)
      ? (rosField.value as string[])
      : [];
    const rosOptions = rosField.options ?? [];
    const nsOptions = nsField.options ?? [];
    for (const ns of nsSelected) {
      const ros = findROSOptionForSymptom(ns, rosOptions);
      if (!ros) continue;
      if (!rosSelected.includes(ros)) continue;
      if (unlinkedPairs.has(pairKey(ns, ros))) continue;
      if (fieldKey === NEW_SYMPTOMS_KEY) out.add(ns);
      if (fieldKey === ROS_KEY) out.add(ros);
    }
    // Cover ROS-side selections that also have a NS analog — usually
    // the same pair the loop above already added, but guards against
    // ROS-only entries with a matching NS that the NS-side loop missed
    // due to ordering quirks.
    for (const ros of rosSelected) {
      const ns = findNSOptionForROS(ros, nsOptions);
      if (!ns) continue;
      if (!nsSelected.includes(ns)) continue;
      if (unlinkedPairs.has(pairKey(ns, ros))) continue;
      if (fieldKey === NEW_SYMPTOMS_KEY) out.add(ns);
      if (fieldKey === ROS_KEY) out.add(ros);
    }
    return out;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!patientId) {
      alert("Please select a patient.");
      return;
    }
    if (sections.length === 0) {
      alert("Template not loaded yet.");
      return;
    }
    createMutation.mutate({
      patient_id: patientId,
      provider_id: user.id,
      template_type: templateType,
      sections,
    });
  }

  const patients = patientsQuery.data ?? [];

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link href="/notes" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          &larr; Back to Notes
        </Link>
      </div>

      <div className="page-header">
        <h1 className="page-title">New Clinical Note</h1>
        <p className="page-subtitle">
          Create a new draft note using a structured template
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="detail-card" style={{ marginBottom: 16 }}>
          <div className="detail-card-title">Note Details</div>
          <div className="detail-row" style={{ flexDirection: "column", gap: 4 }}>
            <label className="detail-label">Patient</label>
            <select
              className="search-input"
              style={{ width: "100%" }}
              value={patientId}
              onChange={(e) => {
                setPatientId(e.target.value);
                if (patientPrefillNotice) setPatientPrefillNotice("");
              }}
              required
            >
              <option value="">Select a patient...</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.mrn ? `(${p.mrn})` : ""}
                </option>
              ))}
            </select>
            {patientPrefillNotice && (
              <div
                role="status"
                style={{
                  fontSize: 12,
                  color: "var(--text-muted)",
                  marginTop: 4,
                }}
              >
                {patientPrefillNotice}
              </div>
            )}
          </div>
          <div className="detail-row" style={{ flexDirection: "column", gap: 4 }}>
            <label className="detail-label">Template</label>
            <select
              className="search-input"
              style={{ width: "100%" }}
              value={templateType}
              onChange={(e) => setTemplateType(e.target.value as TemplateType)}
            >
              <option value="soap">SOAP (Subjective, Objective, Assessment, Plan)</option>
              <option value="progress">Progress Note</option>
            </select>
          </div>
        </div>

        {templateQuery.isLoading ? (
          <div style={{ padding: 24, color: "var(--text-muted)" }}>
            Loading template...
          </div>
        ) : (
          sections.map((section, sIdx) => (
            <div key={section.key} className="detail-card" style={{ marginBottom: 16 }}>
              <div className="detail-card-title">{section.label}</div>
              {section.fields.map((field, fIdx) => {
                const isNS = field.key === NEW_SYMPTOMS_KEY;
                const isROS = field.key === ROS_KEY;
                const isGrouped =
                  (isNS || isROS) &&
                  field.field_type === "multiselect" &&
                  Array.isArray(field.options);

                if (isGrouped) {
                  const defaultExpanded = isNS;
                  const selected = Array.isArray(field.value)
                    ? (field.value as string[])
                    : [];
                  const collapsed =
                    sectionCollapseState[field.key] ?? {};
                  const linked = linkedOptionsFor(field.key);
                  // Suggestions for the New Symptoms field only (#1305).
                  // Recompute here from the live CC text + options so the
                  // banner and the inline highlight stay in lockstep.
                  // Already-ticked items are excluded so the highlight
                  // disappears the moment a suggestion is accepted.
                  const suggestionsForField =
                    isNS && field.options
                      ? detectSuggestions(
                          chiefComplaintText,
                          field.options,
                        )
                      : [];
                  const selectedSet = new Set(selected);
                  const highlightedForField = new Set(
                    suggestionsForField.filter(
                      (s) => !selectedSet.has(s),
                    ),
                  );
                  return (
                    <div
                      key={field.key}
                      className="detail-row"
                      style={{
                        flexDirection: "column",
                        gap: 4,
                        alignItems: "stretch",
                      }}
                    >
                      <label className="detail-label">{field.label}</label>
                      <p
                        className="grouped-multiselect-caption"
                        style={{
                          fontSize: 12,
                          color: "var(--text-muted)",
                          margin: 0,
                        }}
                      >
                        {isNS ? NS_CAPTION : ROS_CAPTION}
                      </p>
                      {isNS && (
                        <SymptomSuggestionBanner
                          chiefComplaintText={chiefComplaintText}
                          allSymptomOptions={field.options ?? []}
                          currentlyTicked={selected}
                          dismissedForText={dismissedBannerText}
                          onTickAll={(suggestions) => {
                            // Union with current selection so existing
                            // ticks are preserved; the auto-mirror in
                            // handleMultiselectChange fans the change
                            // out to ROS.
                            const next = [...selected];
                            for (const s of suggestions) {
                              if (!next.includes(s)) next.push(s);
                            }
                            handleMultiselectChange(sIdx, fIdx, field, next);
                          }}
                          onDismiss={(text) => setDismissedBannerText(text)}
                        />
                      )}
                      <GroupedMultiselect
                        fieldKey={field.key}
                        options={field.options ?? []}
                        selected={selected}
                        onChange={(next) =>
                          handleMultiselectChange(sIdx, fIdx, field, next)
                        }
                        groupOf={
                          isNS
                            ? (opt) => ({
                                system: getSymptomSystem(opt),
                                display: opt,
                              })
                            : (opt) => {
                                const parsed = parseROSOption(opt);
                                return {
                                  system: parsed.system,
                                  display: parsed.symptom,
                                };
                              }
                        }
                        collapsed={collapsed}
                        onToggleSection={(system) =>
                          toggleSection(field.key, system, defaultExpanded)
                        }
                        defaultExpanded={defaultExpanded}
                        linkedOptions={linked}
                        onUnlink={(opt) => handleUnlink(field, opt)}
                        highlightedOptions={
                          isNS ? highlightedForField : undefined
                        }
                      />
                    </div>
                  );
                }

                return (
                  <div
                    key={field.key}
                    className="detail-row"
                    style={{ flexDirection: "column", gap: 4, alignItems: "stretch" }}
                  >
                    <label className="detail-label">{field.label}</label>
                    <FieldInput
                      field={field}
                      onChange={(v) => updateField(sIdx, fIdx, v)}
                    />
                  </div>
                );
              })}
            </div>
          ))
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={createMutation.isPending || !patientId}
          >
            {createMutation.isPending ? "Saving..." : "Save Draft"}
          </button>
          <Link href="/notes" className="btn btn-ghost">
            Cancel
          </Link>
          {createMutation.isError && (
            <span style={{ color: "var(--critical)", fontSize: 12, alignSelf: "center" }}>
              {createMutation.error.message}
            </span>
          )}
        </div>
      </form>
    </>
  );
}

export default function NewNotePage() {
  return (
    <AuthGuard>
      <NewNoteContent />
    </AuthGuard>
  );
}

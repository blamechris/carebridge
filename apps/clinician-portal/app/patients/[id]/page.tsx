"use client";

import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { AuthGuard } from "@/lib/auth-guard";
import { pickFreshest, mostRecentIso } from "@/lib/freshest";
import {
  FlagActionModal,
  type FlagAction,
  type FlagActionModalFlag,
} from "@/components/flag-action-modal";
import { VitalsTrendChart } from "@/components/vitals-trend-chart";
import {
  deriveAllergyDisplayState,
  parseAllergyStatus,
} from "@/lib/allergy-display";
import type { LabResult } from "@carebridge/shared-types";
import {
  formatAge,
  classifyStaleness,
  STALE_THRESHOLD_MS,
  type StalenessTier,
} from "@/lib/vitals-staleness";
import { formatReferenceRange } from "@/lib/formatting";
import { StaleDataBanner } from "@/components/stale-data-banner";
import {
  isOutOfRange as labIsOutOfRange,
  labValueColor,
  deriveInferredFlag,
} from "@/lib/lab-display";

const tabs = [
  { key: "overview", label: "Overview" },
  { key: "vitals", label: "Vitals" },
  { key: "labs", label: "Labs" },
  { key: "medications", label: "Medications" },
  { key: "flags", label: "AI Flags" },
];

function LoadingState({ label }: { label: string }) {
  return (
    <div className="loading-indicator" role="status" aria-label={`Loading ${label}`}>
      <div className="loading-spinner" aria-hidden="true" />
      <span>Loading {label}...</span>
    </div>
  );
}

function ErrorState({ label }: { label: string }) {
  return (
    <div className="error-indicator" role="alert">
      <div className="error-icon" aria-hidden="true">!</div>
      <span>Failed to load {label}. Is the API running?</span>
    </div>
  );
}

function stalenessStyles(tier: StalenessTier): {
  color?: string;
  background?: string;
  border?: string;
  note?: string;
} {
  switch (tier) {
    case "overdue":
      return {
        background: "var(--color-warning-bg, #fff8e1)",
        border: "1px solid var(--color-warning-border, #f0b429)",
        note: "recheck due",
      };
    case "stale":
      return {
        background: "var(--color-muted-bg, #f4f4f5)",
        color: "var(--text-muted)",
        border: "1px solid var(--color-muted-border, #d4d4d8)",
        note: "stale",
      };
    default:
      return {};
  }
}

function OverviewTab({ patientId }: { patientId: string }) {
  const patientQuery = trpc.patients.getById.useQuery({ id: patientId });
  const diagnosesQuery = trpc.patients.diagnoses.getByPatient.useQuery({ patientId });
  const allergiesQuery = trpc.patients.allergies.getByPatient.useQuery({ patientId });
  const careTeamQuery = trpc.patients.careTeam.getByPatient.useQuery({ patientId });

  const [showAllergyError, setShowAllergyError] = useState(false);

  const patient = patientQuery.data;
  const diagnoses = diagnosesQuery.data ?? [];
  const careTeam = careTeamQuery.data ?? [];

  if (patientQuery.isLoading) return <LoadingState label="overview" />;
  if (patientQuery.isError || !patient) return <ErrorState label="overview" />;

  // Issue #218: allergies must never silently fall back to "NKDA" on fetch
  // failure. deriveAllergyDisplayState() distinguishes loading / error /
  // the three empty variants (nkda, unknown, has_allergies) from a
  // populated list, using the same allergy_status semantics as
  // formatAllergies() in @carebridge/ai-prompts.
  const allergyState = deriveAllergyDisplayState(
    allergiesQuery,
    parseAllergyStatus(patient.allergy_status),
  );

  return (
    <div className="detail-grid">
      <div className="detail-card">
        <div className="detail-card-title">Demographics</div>
        <div className="detail-row">
          <span className="detail-label">Date of Birth</span>
          <span className="detail-value">{patient.date_of_birth}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Sex</span>
          <span className="detail-value">{patient.biological_sex}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">MRN</span>
          <span className="detail-value" style={{ fontFamily: "monospace" }}>
            {patient.mrn}
          </span>
        </div>
      </div>

      <div className="detail-card">
        <div className="detail-card-title">Active Diagnoses</div>
        {diagnosesQuery.isLoading ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>
        ) : diagnoses.length > 0 ? (
          diagnoses.map((dx, i) => (
            <div key={i} className="list-item">
              {dx.description} {dx.icd10_code ? `(${dx.icd10_code})` : ""}
            </div>
          ))
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            No active diagnoses
          </div>
        )}
      </div>

      <div className="detail-card" aria-live="polite">
        <div className="detail-card-title">Allergies</div>
        {allergyState.kind === "loading" ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Loading...
          </div>
        ) : allergyState.kind === "error" ? (
          // Clinical-safety critical (issue #218): on fetch failure we
          // explicitly surface that allergy data is UNAVAILABLE. We do
          // NOT render "NKDA" — a silent fallback could lead to
          // prescribing a contraindicated drug.
          <div role="alert" style={{ fontSize: 13 }}>
            <div style={{ color: "var(--critical)", fontWeight: 600 }}>
              {"\u26A0"} Allergy data unavailable — refresh before
              prescribing.
            </div>
            <button
              type="button"
              onClick={() => setShowAllergyError((v) => !v)}
              style={{
                marginTop: 6,
                background: "transparent",
                border: "none",
                padding: 0,
                color: "var(--text-muted)",
                fontSize: 12,
                textDecoration: "underline",
                cursor: "pointer",
              }}
              aria-expanded={showAllergyError}
            >
              {showAllergyError ? "Hide details" : "Show details"}
            </button>
            {showAllergyError ? (
              <div
                style={{
                  marginTop: 6,
                  color: "var(--text-muted)",
                  fontFamily: "monospace",
                  fontSize: 12,
                  wordBreak: "break-word",
                }}
              >
                {allergyState.message}
              </div>
            ) : null}
          </div>
        ) : allergyState.kind === "populated" ? (
          allergyState.allergies.map((allergy, i) => (
            <div
              key={i}
              className="list-item"
              style={{ color: "var(--critical)" }}
            >
              {allergy.allergen}
              {allergy.reaction ? ` (${allergy.reaction})` : ""}
            </div>
          ))
        ) : allergyState.kind === "nkda" ? (
          <div style={{ color: "var(--success)", fontSize: 13 }}>
            NKDA (confirmed)
          </div>
        ) : allergyState.kind === "has_allergies_undocumented" ? (
          // Status affirms allergies exist but none are on file — a
          // documentation gap. Distinct from "unknown" because somebody
          // has flagged the patient as allergic.
          <div
            role="status"
            style={{ color: "var(--warning)", fontSize: 13 }}
          >
            Has allergies — none documented (data gap)
          </div>
        ) : (
          // allergyState.kind === "unknown" — never assessed. Must NOT
          // be conflated with NKDA.
          <div
            role="status"
            style={{ color: "var(--warning)", fontSize: 13 }}
          >
            Allergy status unknown — not assessed
          </div>
        )}
      </div>

      <div className="detail-card">
        <div className="detail-card-title">Care Team</div>
        {careTeamQuery.isLoading ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>
        ) : careTeam.length > 0 ? (
          careTeam.map((member, i) => (
            <div key={i} className="detail-row">
              <span className="detail-label">{member.role}</span>
              <span className="detail-value">{member.provider_id}</span>
            </div>
          ))
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            No care team members assigned
          </div>
        )}
      </div>
    </div>
  );
}

function VitalsTab({ patientId }: { patientId: string }) {
  const latestQuery = trpc.clinicalData.vitals.getLatest.useQuery({ patientId });
  const historyQuery = trpc.clinicalData.vitals.getByPatient.useQuery({
    patientId,
  });

  const latest = latestQuery.data ?? [];
  const history = historyQuery.data ?? [];

  if (latestQuery.isLoading || historyQuery.isLoading)
    return <LoadingState label="vitals" />;
  if (latestQuery.isError || historyQuery.isError)
    return <ErrorState label="vitals" />;

  if (latest.length === 0) {
    return (
      <div className="empty-state" role="status">
        <div className="empty-state-text" style={{ fontWeight: 600 }}>
          No vitals have ever been recorded for this patient.
        </div>
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 13,
            marginTop: 4,
          }}
        >
          This does NOT mean vitals are normal. A clinical assessment is
          required.
        </div>
      </div>
    );
  }

  // Freshest recording across types — drives the staleness banner.
  // Use epoch-ms normalization (issue #529) rather than lexicographic
  // string compare: ISO strings that represent the same instant can
  // differ in suffix (`Z` vs `+00:00`) or sub-second precision and
  // sort wrong as plain strings.
  const mostRecent = pickFreshest<{ recorded_at: string }>(
    latest as Array<{ recorded_at: string }>,
    (v) => v.recorded_at,
  );
  // Fail-safe: when all timestamps are unparseable, pickFreshest returns
  // null and we cannot determine freshness. In that case we must still
  // surface a staleness warning — hiding it would be clinically unsafe
  // because the clinician would have no cue that displayed values may be
  // outdated. (PR #571 review finding.)
  const freshnessUnknown = mostRecent === null && latest.length > 0;
  const isStale = freshnessUnknown
    || (mostRecent !== null &&
        Date.now() - new Date(mostRecent.recorded_at).getTime() > STALE_THRESHOLD_MS);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {freshnessUnknown ? (
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
          <strong>Stale vitals:</strong> unable to determine data freshness
          &mdash; verify manually. Values shown may not reflect the
          patient&rsquo;s current state.
        </div>
      ) : isStale && mostRecent ? (
        <StaleDataBanner
          lastRecordedAt={mostRecent.recorded_at}
          label="vitals"
        />
      ) : null}
      <div className="detail-grid">
        {latest.map((vital, i) => {
          const tier = classifyStaleness(vital.recorded_at, vital.type);
          const s = stalenessStyles(tier);
          const age = formatAge(vital.recorded_at);
          const staleExplainId = tier === "stale" ? `stale-explain-${i}` : undefined;
          const ariaLabel = `${vital.type} ${vital.value_primary} ${vital.unit}, recorded ${age}${s.note ? `, ${s.note}` : ""}`;
          return (
            <div
              key={i}
              className="stat-card"
              style={{
                background: s.background,
                border: s.border,
                color: s.color,
              }}
              aria-label={ariaLabel}
              aria-describedby={staleExplainId}
            >
              <span className="stat-label">{vital.type}</span>
              <span
                className="stat-value"
                style={{
                  fontSize: 24,
                  color: s.color ?? "var(--text-primary)",
                }}
              >
                {vital.value_primary} {vital.unit}
              </span>
              <span className="stat-detail">
                {age}
                {s.note ? ` — ${s.note}` : ""}
              </span>
              <span
                className="stat-detail"
                style={{ fontSize: 11, opacity: 0.7 }}
              >
                {new Date(vital.recorded_at).toLocaleString()}
              </span>
              {tier === "overdue" && (
                <span className="sr-only">
                  This vital is overdue for recheck.
                </span>
              )}
              {staleExplainId && (
                <span id={staleExplainId} className="sr-only">
                  Older than 24 hours — do not treat as current.
                </span>
              )}
            </div>
          );
        })}
      </div>
      <VitalsTrendChart
        vitals={history.map((v) => ({
          id: v.id,
          recorded_at: v.recorded_at,
          type: v.type,
          value_primary: v.value_primary,
          value_secondary: v.value_secondary ?? null,
          unit: v.unit,
        }))}
      />
    </div>
  );
}

function LabsTab({ patientId }: { patientId: string }) {
  const labsQuery = trpc.clinicalData.labs.getByPatient.useQuery({ patientId });
  const panels = labsQuery.data ?? [];

  if (labsQuery.isLoading) return <LoadingState label="labs" />;
  if (labsQuery.isError) return <ErrorState label="labs" />;

  if (panels.length === 0) {
    return (
      <div className="empty-state" role="status">
        <div className="empty-state-text" style={{ fontWeight: 600 }}>
          No lab results have ever been recorded for this patient.
        </div>
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 13,
            marginTop: 4,
          }}
        >
          This does NOT imply normal labs. Order labs as clinically
          indicated.
        </div>
      </div>
    );
  }

  // Panels are returned ordered desc by collected_at, but we must still
  // normalize via Date.parse before comparing (issue #529): lab panels
  // from ingestion paths use mixed ISO suffixes (`Z` vs `+00:00`) and
  // lexicographic sort can pick the wrong panel as "most recent".
  const mostRecentPanelAt = mostRecentIso(
    panels.map((p) => p.panel.collected_at ?? p.panel.created_at),
  );
  const labsStale =
    mostRecentPanelAt !== null &&
    Date.now() - new Date(mostRecentPanelAt).getTime() > STALE_THRESHOLD_MS;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {labsStale && mostRecentPanelAt ? (
        <StaleDataBanner lastRecordedAt={mostRecentPanelAt} label="labs" />
      ) : null}
      {panels.map((panel, pi) => (
        <div key={pi} className="table-container">
          <div className="table-header">
            <span className="table-title">{panel.panel.panel_name}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {new Date(panel.panel.created_at).toLocaleDateString()}
            </span>
          </div>
          {panel.results && panel.results.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Test</th>
                  <th>Result</th>
                  <th>Unit</th>
                  <th>Reference Range</th>
                  <th>Flag</th>
                </tr>
              </thead>
              <tbody>
                {panel.results.map((r: LabResult, ri: number) => {
                  const flag = r.flag ?? "";
                  const value = r.value;
                  const refLow = r.reference_low;
                  const refHigh = r.reference_high;

                  const outOfRange = labIsOutOfRange(value, refLow, refHigh);
                  const valueColor = labValueColor(flag, outOfRange);
                  const referenceRange = formatReferenceRange(refLow, refHigh);
                  const inferredFlag = deriveInferredFlag(value, flag, refLow, refHigh);

                  // Dev-only: warn when the server flag and client-inferred
                  // direction disagree. This catches mapping bugs and stale
                  // reference ranges early without polluting production logs.
                  if (process.env.NODE_ENV !== "production" && flag && outOfRange && typeof value === "number") {
                    const clientDirection =
                      typeof refLow === "number" && value < refLow
                        ? "low"
                        : "high";
                    const serverNorm = flag.toLowerCase();
                    const disagrees =
                      (serverNorm === "h" && clientDirection === "low") ||
                      (serverNorm === "l" && clientDirection === "high") ||
                      (serverNorm === "high" && clientDirection === "low") ||
                      (serverNorm === "low" && clientDirection === "high");
                    if (disagrees) {
                      console.warn(
                        `[LabsTab] Server flag "${flag}" disagrees with client-inferred "${clientDirection}" for "${r.test_name}" (value=${value}, refLow=${refLow}, refHigh=${refHigh}). Review reference range or flag mapping.`,
                      );
                    }
                  }

                  return (
                    <tr key={ri}>
                      <td data-label="Test">{r.test_name}</td>
                      <td
                        data-label="Result"
                        style={{
                          fontWeight: 600,
                          color: valueColor,
                        }}
                      >
                        {r.value}
                      </td>
                      <td
                        data-label="Unit"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {r.unit}
                      </td>
                      <td
                        data-label="Reference Range"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {referenceRange}
                      </td>
                      <td data-label="Flag">
                        {flag ? (
                          <span
                            className={`badge ${
                              flag === "critical"
                                ? "badge-critical"
                                : "badge-warning"
                            }`}
                            role={flag === "critical" ? "alert" : "status"}
                            aria-label={`Lab value flag: ${flag}`}
                          >
                            {flag.toUpperCase()}
                          </span>
                        ) : inferredFlag ? (
                          <span
                            className="badge badge-inferred"
                            role="status"
                            aria-label={`Estimated lab flag (outside reference range): ${inferredFlag}`}
                          >
                            {inferredFlag.toUpperCase()}
                            {" (est.)"}
                          </span>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: 16, color: "var(--text-muted)" }}>
              Results pending
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface MedicationBadge {
  label: string;
  className: string;
  title?: string;
}

interface MedicationStatusSectionProps {
  medications: Array<{
    id: string;
    name: string;
    dose_amount?: string | number | null;
    dose_unit?: string | null;
    route?: string | null;
    frequency?: string | null;
  }>;
  title: string;
  titleColor?: string;
  textColor: string;
  badge: MedicationBadge;
}

function MedicationStatusSection({
  medications,
  title,
  titleColor,
  textColor,
  badge,
}: MedicationStatusSectionProps) {
  if (medications.length === 0) return null;

  return (
    <div className="table-container">
      <div className="table-header">
        <span
          className="table-title"
          style={titleColor ? { color: titleColor } : undefined}
        >
          {title}
        </span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Medication</th>
            <th>Dose</th>
            <th>Route</th>
            <th>Frequency</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {medications.map((med) => (
            <tr key={med.id}>
              <td
                data-label="Medication"
                style={{ fontWeight: 500, color: titleColor ?? undefined }}
              >
                {med.name}
              </td>
              <td data-label="Dose" style={{ color: textColor }}>
                {med.dose_amount} {med.dose_unit}
              </td>
              <td data-label="Route" style={{ color: textColor }}>
                {med.route}
              </td>
              <td data-label="Frequency" style={{ color: textColor }}>
                {med.frequency}
              </td>
              <td data-label="Status">
                <span className={badge.className} title={badge.title}>
                  {badge.label}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MedicationsTab({ patientId }: { patientId: string }) {
  const medsQuery = trpc.clinicalData.medications.getByPatient.useQuery({
    patientId,
  });
  const medications = medsQuery.data ?? [];

  if (medsQuery.isLoading) return <LoadingState label="medications" />;
  if (medsQuery.isError) return <ErrorState label="medications" />;

  const active = medications.filter((m) => m.status === "active");
  const held = medications.filter((m) => m.status === "held");
  const discontinued = medications.filter((m) => m.status === "discontinued");
  const completed = medications.filter((m) => m.status === "completed");

  if (medications.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-text">No medications recorded for this patient</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <MedicationStatusSection
        medications={active}
        title="Active Medications"
        textColor="var(--text-secondary)"
        badge={{ label: "Active", className: "badge badge-success" }}
      />
      <MedicationStatusSection
        medications={held}
        title="Held"
        textColor="var(--text-secondary)"
        badge={{
          label: "Held",
          className: "badge badge-warning",
          title: "Temporarily paused \u2014 intent to resume",
        }}
      />
      <MedicationStatusSection
        medications={discontinued}
        title="Discontinued"
        titleColor="var(--text-muted)"
        textColor="var(--text-muted)"
        badge={{
          label: "Discontinued",
          className: "badge badge-muted",
        }}
      />
      <MedicationStatusSection
        medications={completed}
        title="Completed"
        titleColor="var(--text-muted)"
        textColor="var(--text-muted)"
        badge={{
          label: "Completed",
          className: "badge badge-completed",
        }}
      />
    </div>
  );
}

function FlagsTab({ patientId }: { patientId: string }) {
  const utils = trpc.useUtils();
  const flagsQuery = trpc.aiOversight.flags.getByPatient.useQuery({
    patientId,
  });
  const flags = flagsQuery.data ?? [];

  const [activeFlag, setActiveFlag] = useState<FlagActionModalFlag | null>(
    null,
  );
  const [activeAction, setActiveAction] = useState<FlagAction | null>(null);

  const [showSuccess, setShowSuccess] = useState(false);

  const onSuccess = async () => {
    setShowSuccess(true);
    await utils.aiOversight.flags.getByPatient.invalidate({ patientId });
    await utils.aiOversight.flags.getOpenCount.invalidate({ patientId });
    await utils.aiOversight.flags.getAllOpen.invalidate();
    setTimeout(() => {
      setShowSuccess(false);
      setActiveFlag(null);
      setActiveAction(null);
    }, 1200);
  };

  const acknowledgeMutation =
    trpc.aiOversight.flags.acknowledge.useMutation({ onSuccess });
  const resolveMutation =
    trpc.aiOversight.flags.resolve.useMutation({ onSuccess });
  const dismissMutation =
    trpc.aiOversight.flags.dismiss.useMutation({ onSuccess });

  const isSubmitting =
    acknowledgeMutation.isPending ||
    resolveMutation.isPending ||
    dismissMutation.isPending;

  function openModal(flag: FlagActionModalFlag, action: FlagAction) {
    setActiveFlag(flag);
    setActiveAction(action);
  }

  function handleConfirm(reason: string) {
    if (!activeFlag || !activeAction) return;
    if (activeAction === "acknowledge") {
      acknowledgeMutation.mutate({ flagId: activeFlag.id });
    } else if (activeAction === "resolve") {
      resolveMutation.mutate({
        flagId: activeFlag.id,
        resolution_note: reason,
      });
    } else if (activeAction === "dismiss") {
      dismissMutation.mutate({
        flagId: activeFlag.id,
        dismiss_reason: reason,
      });
    }
  }

  if (flagsQuery.isLoading) return <LoadingState label="flags" />;
  if (flagsQuery.isError) return <ErrorState label="flags" />;

  if (flags.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">{"\u2713"}</div>
        <div className="empty-state-text">
          No open AI flags for this patient
        </div>
      </div>
    );
  }

  return (
    <div className="table-container">
      <div className="table-header">
        <span className="table-title">AI Flags</span>
      </div>
      <div
        className="flag-list"
        role="list"
        aria-live="polite"
        aria-label="Patient AI flags"
      >
        {flags.map((flag) => (
          <div key={flag.id} className="flag-item" role="listitem">
            <div className="flag-severity">
              <span
                className={`badge badge-${flag.severity}`}
                role={flag.severity === "critical" ? "alert" : "status"}
                aria-label={`Severity: ${flag.severity}`}
              >
                <span aria-hidden="true">{flag.severity.toUpperCase()}</span>
                <span className="sr-only">{flag.severity} severity</span>
              </span>
            </div>
            <div className="flag-content">
              <div className="flag-summary">{flag.summary}</div>
              <div className="flag-suggestion">{flag.suggested_action}</div>
              <div className="flag-time">
                {new Date(flag.created_at).toLocaleString()}
              </div>
            </div>
            <div className="flag-actions">
              <button
                className="btn btn-success btn-sm"
                onClick={() => openModal(flag, "acknowledge")}
                disabled={isSubmitting}
              >
                Acknowledge
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => openModal(flag, "resolve")}
                disabled={isSubmitting}
              >
                Resolve
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => openModal(flag, "dismiss")}
                disabled={isSubmitting}
              >
                Dismiss
              </button>
            </div>
          </div>
        ))}
      </div>
      <FlagActionModal
        flag={activeFlag}
        action={activeAction}
        onCancel={() => {
          if (isSubmitting || showSuccess) return;
          setActiveFlag(null);
          setActiveAction(null);
        }}
        onConfirm={handleConfirm}
        isSubmitting={isSubmitting}
        isSuccess={showSuccess}
      />
    </div>
  );
}

function PatientChartContent() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const patientId = params.id as string;
  const activeTab = searchParams.get("tab") || "overview";

  const patientQuery = trpc.patients.getById.useQuery({ id: patientId });
  const patient = patientQuery.data;

  function setTab(tab: string) {
    const url =
      tab === "overview"
        ? `/patients/${patientId}`
        : `/patients/${patientId}?tab=${tab}`;
    router.push(url);
  }

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link
          href="/patients"
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          &larr; Back to Patients
        </Link>
      </div>

      {patientQuery.isLoading ? (
        <LoadingState label="patient" />
      ) : patientQuery.isError || !patient ? (
        <ErrorState label="patient" />
      ) : (
        <>
          <div className="chart-header">
            <div className="chart-avatar">
              {patient.name
                .split(" ")
                .map((n) => n[0])
                .join("")}
            </div>
            <div>
              <div className="chart-patient-name">{patient.name}</div>
              <div className="chart-patient-meta">
                <span>{patient.mrn}</span>
                <span>DOB: {patient.date_of_birth}</span>
                <span>{patient.biological_sex}</span>
              </div>
            </div>
          </div>

          <div className="tabs">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                className={`tab ${activeTab === tab.key ? "active" : ""}`}
                aria-current={activeTab === tab.key ? "true" : undefined}
                onClick={() => setTab(tab.key)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === "overview" && <OverviewTab patientId={patientId} />}
          {activeTab === "vitals" && <VitalsTab patientId={patientId} />}
          {activeTab === "labs" && <LabsTab patientId={patientId} />}
          {activeTab === "medications" && (
            <MedicationsTab patientId={patientId} />
          )}
          {activeTab === "flags" && <FlagsTab patientId={patientId} />}
        </>
      )}
    </>
  );
}

export default function PatientChartPage() {
  return (
    <AuthGuard>
      <PatientChartContent />
    </AuthGuard>
  );
}

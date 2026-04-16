"use client";

import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { AuthGuard } from "@/lib/auth-guard";
import {
  FlagActionModal,
  type FlagAction,
  type FlagActionModalFlag,
} from "@/components/flag-action-modal";
import { VitalsTrendChart } from "@/components/vitals-trend-chart";

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

/** Minimum age (ms) at which a latest vital/lab is flagged as stale. 7 days. */
const STALE_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Distinguishes "data present but stale" from "data present and current".
 * Without this banner, a 30-day-old BP reading renders the same way as one
 * taken an hour ago — the clinician cannot tell at a glance that the
 * displayed number is not a current assessment.
 */
function StaleDataBanner({
  lastRecordedAt,
  label,
}: {
  lastRecordedAt: string;
  label: string;
}) {
  const ageMs = Date.now() - new Date(lastRecordedAt).getTime();
  const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
  // role="status" (polite live region) rather than role="alert" (assertive):
  // a chronic chart banner should not interrupt a screen-reader mid-sentence
  // every time the clinician opens a patient with week-old data.
  return (
    <div
      role="status"
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

/**
 * Compute a human-readable "N units ago" string for a clinical-data timestamp.
 * Fixed clinical thresholds (not locale-based) so the age string is
 * diagnostic at a glance: hours for <24h, days beyond that.
 */
function formatAge(recordedAtIso: string): string {
  const ageMs = Date.now() - new Date(recordedAtIso).getTime();
  if (ageMs < 60_000) return "just now";
  const mins = Math.round(ageMs / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(ageMs / 3_600_000);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(ageMs / 86_400_000);
  return `${days}d ago`;
}

/**
 * Classify a recorded-at timestamp into a staleness tier.
 *
 * Thresholds mirror the clinical expectation for acute-care inpatient
 * monitoring: vitals taken more than 4h ago are due for re-check, and
 * vitals older than 24h should not be read as "current" at all.
 *
 *  - "current":  <= 4h — no visual treatment
 *  - "overdue":  4h < age <= 24h — amber tint, "recheck due"
 *  - "stale":    > 24h — gray, "stale" label, reader should not trust
 */
type StalenessTier = "current" | "overdue" | "stale";

function classifyStaleness(recordedAtIso: string): StalenessTier {
  const ageMs = Date.now() - new Date(recordedAtIso).getTime();
  if (ageMs > 24 * 60 * 60 * 1000) return "stale";
  if (ageMs > 4 * 60 * 60 * 1000) return "overdue";
  return "current";
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

  const patient = patientQuery.data;
  const diagnoses = diagnosesQuery.data ?? [];
  const allergies = allergiesQuery.data ?? [];
  const careTeam = careTeamQuery.data ?? [];

  if (patientQuery.isLoading) return <LoadingState label="overview" />;
  if (patientQuery.isError || !patient) return <ErrorState label="overview" />;

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

      <div className="detail-card">
        <div className="detail-card-title">Allergies</div>
        {allergiesQuery.isLoading ? (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>Loading...</div>
        ) : allergies.length > 0 ? (
          allergies.map((allergy, i) => (
            <div
              key={i}
              className="list-item"
              style={{ color: "var(--critical)" }}
            >
              {allergy.allergen}
              {allergy.reaction ? ` (${allergy.reaction})` : ""}
            </div>
          ))
        ) : (
          <div style={{ color: "var(--success)", fontSize: 13 }}>NKDA</div>
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
  const mostRecent = latest.reduce((a, b) =>
    a.recorded_at > b.recorded_at ? a : b,
  );
  const isStale =
    Date.now() - new Date(mostRecent.recorded_at).getTime() > STALE_THRESHOLD_MS;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {isStale ? (
        <StaleDataBanner
          lastRecordedAt={mostRecent.recorded_at}
          label="vitals"
        />
      ) : null}
      <div className="detail-grid">
        {latest.map((vital, i) => {
          const tier = classifyStaleness(vital.recorded_at);
          const s = stalenessStyles(tier);
          return (
            <div
              key={i}
              className="stat-card"
              style={{
                background: s.background,
                border: s.border,
                color: s.color,
              }}
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
                {formatAge(vital.recorded_at)}
                {s.note ? ` — ${s.note}` : ""}
              </span>
              <span
                className="stat-detail"
                style={{ fontSize: 11, opacity: 0.7 }}
              >
                {new Date(vital.recorded_at).toLocaleString()}
              </span>
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

  // Panels come back ordered desc by collected_at; pick the freshest.
  const mostRecentPanelAt =
    panels
      .map((p) => p.panel.collected_at ?? p.panel.created_at)
      .filter((v): v is string => Boolean(v))
      .sort()
      .slice(-1)[0] ?? null;
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
                {panel.results.map((r: Record<string, unknown>, ri: number) => {
                  const flag = (r.flag as string) ?? "";
                  const value = r.value as number | null | undefined;
                  const refLow = r.reference_low as number | null | undefined;
                  const refHigh = r.reference_high as number | null | undefined;

                  // A value is out-of-range when it falls below reference_low or
                  // above reference_high. This catches "borderline abnormal"
                  // cases (e.g. K+ 3.2 with ref 3.5–5.0) that the server-side
                  // `flag` field often leaves unset — the lab instrument may
                  // only assign "critical" for extreme values, leaving
                  // clinically meaningful drift unmarked.
                  const isOutOfRange =
                    typeof value === "number" &&
                    ((typeof refLow === "number" && value < refLow) ||
                      (typeof refHigh === "number" && value > refHigh));

                  const valueColor =
                    flag === "critical"
                      ? "var(--critical)"
                      : flag === "high" || flag === "low"
                      ? "var(--warning)"
                      : isOutOfRange
                      ? "var(--warning)"
                      : "var(--text-primary)";

                  const referenceRange =
                    typeof refLow === "number" && typeof refHigh === "number"
                      ? `${refLow}\u2013${refHigh}`
                      : typeof refLow === "number"
                      ? `> ${refLow}`
                      : typeof refHigh === "number"
                      ? `< ${refHigh}`
                      : "\u2014";

                  // Out-of-range without a server flag — surface an inferred
                  // H/L badge so the clinician has the same visual cue they
                  // would for an instrument-flagged value.
                  const inferredFlag =
                    !flag && isOutOfRange && typeof value === "number"
                      ? typeof refLow === "number" && value < refLow
                        ? "low"
                        : "high"
                      : "";

                  return (
                    <tr key={ri}>
                      <td>{r.test_name as string}</td>
                      <td
                        style={{
                          fontWeight: 600,
                          color: valueColor,
                        }}
                      >
                        {String(r.value)}
                      </td>
                      <td style={{ color: "var(--text-secondary)" }}>
                        {r.unit as string}
                      </td>
                      <td style={{ color: "var(--text-secondary)" }}>
                        {referenceRange}
                      </td>
                      <td>
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
                            className="badge badge-warning"
                            role="status"
                            aria-label={`Inferred lab flag (out of reference range): ${inferredFlag}`}
                            title="Outside reference range (client-derived)"
                          >
                            {inferredFlag.toUpperCase()}
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

  if (medications.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-text">No medications recorded for this patient</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {active.length > 0 && (
        <div className="table-container">
          <div className="table-header">
            <span className="table-title">Active Medications</span>
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
              {active.map((med) => (
                <tr key={med.id}>
                  <td style={{ fontWeight: 500 }}>{med.name}</td>
                  <td style={{ color: "var(--text-secondary)" }}>
                    {med.dose_amount} {med.dose_unit}
                  </td>
                  <td style={{ color: "var(--text-secondary)" }}>{med.route}</td>
                  <td style={{ color: "var(--text-secondary)" }}>{med.frequency}</td>
                  <td>
                    <span className="badge badge-success">Active</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {held.length > 0 && (
        <div className="table-container">
          <div className="table-header">
            <span className="table-title">Held</span>
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
              {held.map((med) => (
                <tr key={med.id}>
                  <td style={{ fontWeight: 500 }}>{med.name}</td>
                  <td style={{ color: "var(--text-secondary)" }}>
                    {med.dose_amount} {med.dose_unit}
                  </td>
                  <td style={{ color: "var(--text-secondary)" }}>{med.route}</td>
                  <td style={{ color: "var(--text-secondary)" }}>{med.frequency}</td>
                  <td>
                    <span
                      className="badge badge-warning"
                      title="Temporarily paused — intent to resume"
                    >
                      Held
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {discontinued.length > 0 && (
        <div className="table-container">
          <div className="table-header">
            <span className="table-title" style={{ color: "var(--text-muted)" }}>
              Discontinued
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
              {discontinued.map((med) => (
                <tr key={med.id}>
                  <td style={{ color: "var(--text-muted)" }}>{med.name}</td>
                  <td style={{ color: "var(--text-muted)" }}>
                    {med.dose_amount} {med.dose_unit}
                  </td>
                  <td style={{ color: "var(--text-muted)" }}>{med.route}</td>
                  <td style={{ color: "var(--text-muted)" }}>{med.frequency}</td>
                  <td>
                    <span
                      className="badge"
                      style={{
                        background: "rgba(255,255,255,0.05)",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      Discontinued
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

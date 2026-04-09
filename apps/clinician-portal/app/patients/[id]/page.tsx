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
  { key: "problems", label: "Problem List" },
  { key: "notes", label: "All Notes" },
  { key: "vitals", label: "Vitals" },
  { key: "labs", label: "Labs" },
  { key: "medications", label: "Medications" },
  { key: "flags", label: "AI Flags" },
];

function LoadingState({ label }: { label: string }) {
  return (
    <div style={{ padding: 24, color: "var(--text-muted)" }}>
      Loading {label}...
    </div>
  );
}

function ErrorState({ label }: { label: string }) {
  return (
    <div style={{ padding: 24, color: "var(--critical)" }}>
      Failed to load {label}. Is the API running?
    </div>
  );
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
      <div className="empty-state">
        <div className="empty-state-text">No vitals recorded for this patient</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div className="detail-grid">
        {latest.map((vital, i) => (
          <div key={i} className="stat-card">
            <span className="stat-label">{vital.type}</span>
            <span
              className="stat-value"
              style={{ fontSize: 24, color: "var(--text-primary)" }}
            >
              {vital.value_primary} {vital.unit}
            </span>
            <span className="stat-detail">
              {new Date(vital.recorded_at).toLocaleString()}
            </span>
          </div>
        ))}
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
      <div className="empty-state">
        <div className="empty-state-text">No lab results for this patient</div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
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
                  return (
                    <tr key={ri}>
                      <td>{r.test_name as string}</td>
                      <td
                        style={{
                          fontWeight: 600,
                          color:
                            flag === "critical"
                              ? "var(--critical)"
                              : flag === "high" || flag === "low"
                              ? "var(--warning)"
                              : "var(--text-primary)",
                        }}
                      >
                        {String(r.value)}
                      </td>
                      <td style={{ color: "var(--text-secondary)" }}>
                        {r.unit as string}
                      </td>
                      <td style={{ color: "var(--text-secondary)" }}>
                        {r.reference_range as string}
                      </td>
                      <td>
                        {flag && (
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
                        )}
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

function ProblemsTab({ patientId }: { patientId: string }) {
  const problemsQuery = trpc.patients.problemList.getByPatient.useQuery({
    patientId,
  });
  const problems = problemsQuery.data ?? [];

  if (problemsQuery.isLoading) return <LoadingState label="problem list" />;
  if (problemsQuery.isError) return <ErrorState label="problem list" />;

  if (problems.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-text">
          No active problems recorded for this patient
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div
        style={{
          padding: "12px 16px",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontSize: 12,
          color: "var(--text-muted)",
          lineHeight: 1.5,
        }}
      >
        Unified view across every specialty on the care team. Problems
        with no recent activity are highlighted to surface orphaned care.
      </div>
      {problems.map((problem) => {
        const isStale = problem.stale_days >= 30;
        const hasOpenFlags = problem.open_flag_count > 0;
        return (
          <div
            key={problem.diagnosis_id}
            className="detail-card"
            style={{
              borderLeft: isStale
                ? "3px solid var(--warning)"
                : "3px solid var(--success)",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-start",
                gap: 12,
                marginBottom: 12,
              }}
            >
              <div style={{ flex: 1 }}>
                <div className="detail-card-title" style={{ marginBottom: 4 }}>
                  {problem.description}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    fontFamily: "monospace",
                  }}
                >
                  {problem.icd10_code ? `ICD-10 ${problem.icd10_code}` : null}
                  {problem.icd10_code && problem.snomed_code ? " · " : null}
                  {problem.snomed_code
                    ? `SNOMED ${problem.snomed_code}`
                    : null}
                  {problem.onset_date
                    ? ` · onset ${problem.onset_date}`
                    : null}
                </div>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <span
                  className={`badge ${
                    problem.status === "active"
                      ? "badge-success"
                      : problem.status === "chronic"
                      ? "badge-warning"
                      : ""
                  }`}
                >
                  {problem.status}
                </span>
                {hasOpenFlags && (
                  <span
                    className="badge badge-critical"
                    aria-label={`${problem.open_flag_count} open AI flags`}
                  >
                    {problem.open_flag_count} open flag
                    {problem.open_flag_count === 1 ? "" : "s"}
                  </span>
                )}
                {isStale && (
                  <span
                    className="badge badge-warning"
                    aria-label="Stale problem — no recent activity"
                  >
                    {problem.stale_days}d stale
                  </span>
                )}
              </div>
            </div>

            <div className="detail-row">
              <span className="detail-label">Managing specialists</span>
              <span className="detail-value">
                {problem.managing_specialists.length > 0
                  ? problem.managing_specialists
                      .map(
                        (s) =>
                          `${s.specialty ?? s.role} (${s.provider_id.slice(
                            0,
                            8,
                          )})`,
                      )
                      .join(", ")
                  : "None assigned"}
              </span>
            </div>

            <div className="detail-row">
              <span className="detail-label">Most recent note</span>
              <span className="detail-value">
                {problem.most_recent_note ? (
                  <>
                    {problem.most_recent_note.provider_specialty ??
                      "unattributed"}{" "}
                    · {problem.most_recent_note.template_type}
                    {problem.most_recent_note.signed_at
                      ? ` · ${new Date(
                          problem.most_recent_note.signed_at,
                        ).toLocaleDateString()}`
                      : ""}
                  </>
                ) : (
                  "No signed notes yet"
                )}
              </span>
            </div>

            <div className="detail-row">
              <span className="detail-label">Last touched</span>
              <span className="detail-value">
                {new Date(problem.last_touched_at).toLocaleDateString()}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function NotesTimelineTab({ patientId }: { patientId: string }) {
  const timelineQuery = trpc.notes.timelineByPatient.useQuery({
    patientId,
  });
  const entries = timelineQuery.data ?? [];

  if (timelineQuery.isLoading) return <LoadingState label="note timeline" />;
  if (timelineQuery.isError) return <ErrorState label="note timeline" />;

  if (entries.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-text">
          No clinical notes recorded for this patient
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div
        style={{
          padding: "12px 16px",
          background: "rgba(255,255,255,0.03)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          fontSize: 12,
          color: "var(--text-muted)",
          lineHeight: 1.5,
        }}
      >
        Every note from every specialty, newest first. Click through for
        the full text. AI-extracted highlights come from the Phase A1
        note-extractor and may lag the most recent save.
      </div>
      {entries.map((entry) => {
        const displayDate = entry.signed_at ?? entry.created_at;
        const isDraft = entry.status === "draft";
        return (
          <Link
            key={entry.id}
            href={`/notes/${entry.id}`}
            style={{
              textDecoration: "none",
              color: "inherit",
              display: "block",
            }}
          >
            <div
              className="detail-card"
              style={{
                cursor: "pointer",
                borderLeft: isDraft
                  ? "3px solid var(--text-muted)"
                  : "3px solid var(--success)",
              }}
            >
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "flex-start",
                  gap: 12,
                  marginBottom: 8,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      color: "var(--text-primary)",
                    }}
                  >
                    {entry.template_type.toUpperCase()} ·{" "}
                    {entry.provider_specialty ?? "unattributed specialty"}
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      color: "var(--text-muted)",
                      marginTop: 2,
                    }}
                  >
                    {entry.provider_name ?? entry.provider_id.slice(0, 8)} ·{" "}
                    {new Date(displayDate).toLocaleString()}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <span
                    className={`badge ${
                      entry.status === "signed" ||
                      entry.status === "cosigned"
                        ? "badge-success"
                        : "badge-warning"
                    }`}
                  >
                    {entry.status}
                  </span>
                  <span
                    className="badge"
                    style={{
                      background: "rgba(255,255,255,0.05)",
                      color: "var(--text-muted)",
                      border: "1px solid var(--border)",
                    }}
                  >
                    v{entry.version}
                  </span>
                  {entry.copy_forward_score !== null &&
                    entry.copy_forward_score >= 70 && (
                      <span
                        className="badge badge-warning"
                        aria-label="High copy-forward score"
                      >
                        {Math.round(entry.copy_forward_score)}% carried
                      </span>
                    )}
                </div>
              </div>
              {entry.assertion_preview ? (
                <div
                  style={{
                    borderTop: "1px solid var(--border)",
                    paddingTop: 8,
                    marginTop: 4,
                  }}
                >
                  {entry.assertion_preview.one_line_summary && (
                    <div
                      style={{
                        fontSize: 13,
                        color: "var(--text-secondary)",
                        marginBottom: 6,
                        fontStyle: "italic",
                      }}
                    >
                      &ldquo;{entry.assertion_preview.one_line_summary}&rdquo;
                    </div>
                  )}
                  {entry.assertion_preview.assessment_problems.length > 0 && (
                    <div style={{ fontSize: 12, marginBottom: 2 }}>
                      <span
                        style={{
                          color: "var(--text-muted)",
                          marginRight: 6,
                        }}
                      >
                        Problems:
                      </span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {entry.assertion_preview.assessment_problems.join(
                          " · ",
                        )}
                      </span>
                    </div>
                  )}
                  {entry.assertion_preview.top_plan_actions.length > 0 && (
                    <div style={{ fontSize: 12 }}>
                      <span
                        style={{
                          color: "var(--text-muted)",
                          marginRight: 6,
                        }}
                      >
                        Plan:
                      </span>
                      <span style={{ color: "var(--text-secondary)" }}>
                        {entry.assertion_preview.top_plan_actions.join(
                          " · ",
                        )}
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  style={{
                    fontSize: 12,
                    color: "var(--text-muted)",
                    fontStyle: "italic",
                    borderTop: "1px solid var(--border)",
                    paddingTop: 8,
                    marginTop: 4,
                  }}
                >
                  AI extraction pending
                </div>
              )}
            </div>
          </Link>
        );
      })}
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

  const onSuccess = async () => {
    await utils.aiOversight.flags.getByPatient.invalidate({ patientId });
    await utils.aiOversight.flags.getOpenCount.invalidate({ patientId });
    await utils.aiOversight.flags.getAllOpen.invalidate();
    setActiveFlag(null);
    setActiveAction(null);
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
              >
                Acknowledge
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => openModal(flag, "resolve")}
              >
                Resolve
              </button>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => openModal(flag, "dismiss")}
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
          if (isSubmitting) return;
          setActiveFlag(null);
          setActiveAction(null);
        }}
        onConfirm={handleConfirm}
        isSubmitting={isSubmitting}
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
          {activeTab === "problems" && <ProblemsTab patientId={patientId} />}
          {activeTab === "notes" && <NotesTimelineTab patientId={patientId} />}
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

"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import { useMyPatientRecord } from "@/lib/use-my-patient";

function severityColor(severity?: string | null): string {
  switch (severity) {
    case "severe": return "#ef4444";
    case "moderate": return "#f97316";
    case "mild": return "#22c55e";
    default: return "#666";
  }
}

function statusColor(status?: string | null): string {
  switch (status) {
    case "active": return "#3b82f6";
    case "chronic": return "#f97316";
    case "resolved": return "#22c55e";
    default: return "#666";
  }
}

export default function HealthSummaryPage() {
  const { user } = useAuth();
  const router = useRouter();

  const { patient: myRecord, isLoading: patientLoading, isUnlinked } = useMyPatientRecord();

  const diagnosesQuery = trpc.patients.diagnoses.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const allergiesQuery = trpc.patients.allergies.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const careTeamQuery = trpc.patients.careTeam.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  if (!user) {
    router.push("/login");
    return null;
  }

  const diagnoses = diagnosesQuery.data ?? [];
  const allergies = allergiesQuery.data ?? [];
  const careTeam = careTeamQuery.data ?? [];

  const activeDiagnoses = diagnoses.filter((d) => d.status === "active" || d.status === "chronic");
  const resolvedDiagnoses = diagnoses.filter((d) => d.status === "resolved");

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>My Health Summary</h2>
        <button
          onClick={() => router.push("/")}
          style={{ background: "none", border: "1px solid #444", color: "#999", padding: "0.5rem 1rem", borderRadius: 6, cursor: "pointer" }}
        >
          Back to Dashboard
        </button>
      </div>

      {isUnlinked && (
        <p style={{ color: "#ef4444" }}>
          Your account is not linked to a patient record. Please contact your care team.
        </p>
      )}

      {/* Active Diagnoses */}
      <section style={{ marginBottom: "2rem" }}>
        <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem", borderBottom: "1px solid #2a2a2a", paddingBottom: "0.5rem" }}>
          Active Conditions ({activeDiagnoses.length})
        </h3>

        {diagnosesQuery.isLoading ? (
          <p style={{ color: "#999" }}>Loading...</p>
        ) : activeDiagnoses.length === 0 ? (
          <p style={{ color: "#999", fontSize: "0.85rem" }}>No active diagnoses on file.</p>
        ) : (
          activeDiagnoses.map((dx) => (
            <div
              key={dx.id}
              style={{
                backgroundColor: "#1a1a1a",
                border: "1px solid #2a2a2a",
                borderRadius: 8,
                padding: "1rem",
                marginBottom: "0.5rem",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{dx.description}</span>
                <span style={{
                  fontSize: "0.7rem",
                  padding: "2px 6px",
                  borderRadius: 4,
                  backgroundColor: `${statusColor(dx.status)}20`,
                  color: statusColor(dx.status),
                  textTransform: "capitalize",
                }}>
                  {dx.status}
                </span>
              </div>
              <div style={{ fontSize: "0.8rem", color: "#666", marginTop: 4 }}>
                {dx.icd10_code && <span>ICD-10: {dx.icd10_code} &middot; </span>}
                {dx.onset_date && <span>Since {new Date(dx.onset_date).toLocaleDateString()}</span>}
              </div>
            </div>
          ))
        )}

        {resolvedDiagnoses.length > 0 && (
          <details style={{ marginTop: "0.75rem" }}>
            <summary style={{ color: "#666", fontSize: "0.85rem", cursor: "pointer" }}>
              {resolvedDiagnoses.length} resolved condition{resolvedDiagnoses.length !== 1 ? "s" : ""}
            </summary>
            <div style={{ marginTop: "0.5rem" }}>
              {resolvedDiagnoses.map((dx) => (
                <div key={dx.id} style={{ fontSize: "0.85rem", color: "#666", padding: "4px 0" }}>
                  {dx.description} — resolved {dx.resolved_date ? new Date(dx.resolved_date).toLocaleDateString() : ""}
                </div>
              ))}
            </div>
          </details>
        )}
      </section>

      {/* Allergies */}
      <section style={{ marginBottom: "2rem" }}>
        <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem", borderBottom: "1px solid #2a2a2a", paddingBottom: "0.5rem" }}>
          Allergies ({allergies.length})
        </h3>

        {allergiesQuery.isLoading ? (
          <p style={{ color: "#999" }}>Loading...</p>
        ) : allergies.length === 0 ? (
          <p style={{ color: "#999", fontSize: "0.85rem" }}>No known allergies on file.</p>
        ) : (
          allergies.map((allergy) => (
            <div
              key={allergy.id}
              style={{
                backgroundColor: "#1a1a1a",
                border: "1px solid #2a2a2a",
                borderRadius: 8,
                padding: "1rem",
                marginBottom: "0.5rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>{allergy.allergen}</span>
                {allergy.reaction && (
                  <div style={{ fontSize: "0.8rem", color: "#999", marginTop: 2 }}>
                    Reaction: {allergy.reaction}
                  </div>
                )}
              </div>
              {allergy.severity && (
                <span style={{
                  fontSize: "0.7rem",
                  fontWeight: 600,
                  padding: "2px 8px",
                  borderRadius: 4,
                  backgroundColor: `${severityColor(allergy.severity)}20`,
                  color: severityColor(allergy.severity),
                  textTransform: "capitalize",
                }}>
                  {allergy.severity}
                </span>
              )}
            </div>
          ))
        )}
      </section>

      {/* Care Team */}
      <section>
        <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem", borderBottom: "1px solid #2a2a2a", paddingBottom: "0.5rem" }}>
          My Care Team ({careTeam.length})
        </h3>

        {careTeamQuery.isLoading ? (
          <p style={{ color: "#999" }}>Loading...</p>
        ) : careTeam.length === 0 ? (
          <p style={{ color: "#999", fontSize: "0.85rem" }}>No care team members on file.</p>
        ) : (
          careTeam.map((member) => (
            <div
              key={member.id}
              style={{
                backgroundColor: "#1a1a1a",
                border: "1px solid #2a2a2a",
                borderRadius: 8,
                padding: "1rem",
                marginBottom: "0.5rem",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <span style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                  {member.role === "primary" ? "Primary Provider" : member.specialty ?? member.role}
                </span>
                <div style={{ fontSize: "0.8rem", color: "#999", marginTop: 2 }}>
                  {member.role} {member.specialty ? `- ${member.specialty}` : ""}
                </div>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}

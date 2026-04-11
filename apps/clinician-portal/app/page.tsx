"use client";

import Link from "next/link";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/lib/auth";
import { AuthGuard } from "@/lib/auth-guard";

function severityClass(severity: string) {
  switch (severity) {
    case "critical":
      return "badge-critical";
    case "warning":
      return "badge-warning";
    case "info":
      return "badge-info";
    default:
      return "badge-info";
  }
}

function DashboardContent() {
  const { user } = useAuth();
  const healthQuery = trpc.healthCheck.useQuery();
  const patientsQuery = trpc.patients.list.useQuery();

  const patientCount = patientsQuery.data?.length ?? 0;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">
          Good morning, {user?.name ?? "Clinician"}
        </h1>
        <p className="page-subtitle">
          Here is your clinical overview for today.
          {healthQuery.data && (
            <span style={{ marginLeft: 8, fontSize: 12, color: "var(--success)" }}>
              API: {healthQuery.data.status}
            </span>
          )}
          {healthQuery.isError && (
            <span style={{ marginLeft: 8, fontSize: 12, color: "var(--critical)" }}>
              API: offline
            </span>
          )}
        </p>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-label">Total Patients</span>
          <span className="stat-value info">
            {patientsQuery.isLoading ? "..." : patientCount}
          </span>
          <span className="stat-detail">in your panel</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">API Status</span>
          <span
            className="stat-value"
            style={{
              color: healthQuery.data
                ? "var(--success)"
                : healthQuery.isError
                ? "var(--critical)"
                : "var(--text-secondary)",
            }}
          >
            {healthQuery.isLoading
              ? "..."
              : healthQuery.data
              ? "OK"
              : "Down"}
          </span>
          <span className="stat-detail">
            {healthQuery.data?.timestamp
              ? `Last check: ${new Date(healthQuery.data.timestamp).toLocaleTimeString()}`
              : "Checking..."}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Unsigned Notes</span>
          <span className="stat-value warning">--</span>
          <span className="stat-detail">connect notes service</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Pending Orders</span>
          <span className="stat-value" style={{ color: "var(--text-primary)" }}>
            --
          </span>
          <span className="stat-detail">connect orders service</span>
        </div>
      </div>

      <div className="table-container">
        <div className="table-header">
          <span className="table-title">Recent Patients</span>
          <Link href="/patients" className="btn btn-ghost btn-sm">
            View All
          </Link>
        </div>
        {patientsQuery.isLoading ? (
          <div style={{ padding: 24, color: "var(--text-muted)" }}>
            Loading patients...
          </div>
        ) : patientsQuery.isError ? (
          <div style={{ padding: 24, color: "var(--critical)" }}>
            Failed to load patients. Is the API running on localhost:4000?
          </div>
        ) : patientsQuery.data && patientsQuery.data.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Patient Name</th>
                <th>MRN</th>
                <th>Date of Birth</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {patientsQuery.data.slice(0, 5).map((patient) => (
                <tr key={patient.id}>
                  <td>
                    <a
                      href={`/patients/${patient.id}`}
                      className="table-link"
                    >
                      {patient.name}
                    </a>
                  </td>
                  <td
                    style={{
                      color: "var(--text-secondary)",
                      fontFamily: "monospace",
                      fontSize: 12,
                    }}
                  >
                    {patient.mrn}
                  </td>
                  <td style={{ color: "var(--text-secondary)" }}>
                    {patient.date_of_birth}
                  </td>
                  <td>
                    <a
                      href={`/patients/${patient.id}`}
                      className="btn btn-ghost btn-sm"
                    >
                      Open Chart
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 24, color: "var(--text-muted)" }}>
            No patients found. Run <code>pnpm db:seed</code> to populate dev data.
          </div>
        )}
      </div>
    </>
  );
}

export default function DashboardPage() {
  return (
    <AuthGuard>
      <DashboardContent />
    </AuthGuard>
  );
}

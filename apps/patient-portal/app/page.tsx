"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import { useMyPatientRecord } from "@/lib/use-my-patient";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        backgroundColor: "#1a1a1a",
        border: "1px solid #2a2a2a",
        borderRadius: "8px",
        padding: "1.5rem",
      }}
    >
      <h3 style={{ margin: "0 0 0.75rem", fontSize: "1rem" }}>{title}</h3>
      {children}
    </div>
  );
}

function PatientDashboard() {
  const { user, clearSession } = useAuth();
  const router = useRouter();

  const healthQuery = trpc.healthCheck.useQuery();
  const { patient: myRecord, isLoading: patientLoading, isUnlinked } = useMyPatientRecord();

  const medsQuery = trpc.clinicalData.medications.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const vitalsQuery = trpc.clinicalData.vitals.getLatest.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const activeMeds = (medsQuery.data ?? []).filter((m) => m.status === "active");
  const vitals = vitalsQuery.data ?? [];

  function handleLogout() {
    clearSession();
    router.push("/login");
  }

  return (
    <main>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <div>
          <h2 style={{ fontSize: "1.25rem", margin: 0 }}>
            Welcome back, {user?.name ?? "Patient"}
          </h2>
          <p style={{ margin: "0.25rem 0 0", color: "#999", fontSize: "0.8rem" }}>
            {healthQuery.data ? (
              <span style={{ color: "#22c55e" }}>Connected to API</span>
            ) : healthQuery.isError ? (
              <span style={{ color: "#ef4444" }}>API offline</span>
            ) : (
              "Connecting..."
            )}
          </p>
        </div>
        <button
          onClick={handleLogout}
          style={{
            padding: "6px 14px",
            backgroundColor: "transparent",
            border: "1px solid #2a2a2a",
            borderRadius: "6px",
            color: "#999",
            cursor: "pointer",
            fontSize: "0.8rem",
          }}
        >
          Sign Out
        </button>
      </div>

      {isUnlinked && (
        <div
          style={{
            backgroundColor: "#7f1d1d",
            border: "1px solid #ef4444",
            borderRadius: "8px",
            padding: "1.25rem",
            marginBottom: "1rem",
            color: "#fca5a5",
            fontSize: "0.9rem",
          }}
        >
          <strong>Account not linked.</strong> Your account is not linked to a patient
          record. Please contact your care team or call the front desk to resolve this.
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "1rem",
        }}
      >
        <Card title="My Information">
          {myRecord ? (
            <div style={{ fontSize: "0.875rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#999" }}>Name</span>
                <span>{myRecord.name}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#999" }}>MRN</span>
                <span style={{ fontFamily: "monospace" }}>{myRecord.mrn}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                <span style={{ color: "#999" }}>DOB</span>
                <span>{myRecord.date_of_birth}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#999" }}>Sex</span>
                <span>{myRecord.biological_sex}</span>
              </div>
            </div>
          ) : patientLoading ? (
            <p style={{ margin: 0, color: "#999", fontSize: "0.875rem" }}>Loading...</p>
          ) : (
            <p style={{ margin: 0, color: "#999", fontSize: "0.875rem" }}>
              No patient record found. Contact your care team.
            </p>
          )}
        </Card>

        <Card title="Recent Vitals">
          {vitalsQuery.isLoading ? (
            <p style={{ margin: 0, color: "#999", fontSize: "0.875rem" }}>Loading...</p>
          ) : vitals.length > 0 ? (
            <div style={{ fontSize: "0.875rem" }}>
              {vitals.slice(0, 4).map((vital, i) => (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    marginBottom: 4,
                  }}
                >
                  <span style={{ color: "#999" }}>{vital.type}</span>
                  <span>
                    {vital.value_primary} {vital.unit}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ margin: 0, color: "#999", fontSize: "0.875rem" }}>
              No vitals recorded yet.
            </p>
          )}
        </Card>

        <Card title="Active Medications">
          {medsQuery.isLoading ? (
            <p style={{ margin: 0, color: "#999", fontSize: "0.875rem" }}>Loading...</p>
          ) : activeMeds.length > 0 ? (
            <div style={{ fontSize: "0.875rem" }}>
              {activeMeds.map((med) => (
                <div
                  key={med.id}
                  style={{ marginBottom: 6 }}
                >
                  <div>{med.name}</div>
                  <div style={{ color: "#999", fontSize: "0.75rem" }}>
                    {med.dose_amount} {med.dose_unit} &middot; {med.frequency}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ margin: 0, color: "#999", fontSize: "0.875rem" }}>
              No active medications.
            </p>
          )}
        </Card>

        <Card title="Lab Results">
          <p style={{ margin: 0, color: "#999", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
            View your lab test results and reference ranges.
          </p>
          <button
            onClick={() => router.push("/labs")}
            style={{
              padding: "6px 14px",
              backgroundColor: "#2563eb",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            View Lab Results
          </button>
        </Card>

        <Card title="Messages">
          <p style={{ margin: 0, color: "#999", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
            Send secure messages to your care team.
          </p>
          <button
            onClick={() => router.push("/messages")}
            style={{
              padding: "6px 14px",
              backgroundColor: "#2563eb",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            Open Messages
          </button>
        </Card>
      </div>
    </main>
  );
}

export default function PatientHome() {
  const { isAuthenticated, hydrated } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (hydrated && !isAuthenticated) {
      router.replace("/login");
    }
  }, [hydrated, isAuthenticated, router]);

  if (!hydrated || !isAuthenticated) {
    return (
      <main>
        <p style={{ color: "#999" }}>
          {hydrated ? "Redirecting to login..." : "Loading..."}
        </p>
      </main>
    );
  }

  return <PatientDashboard />;
}

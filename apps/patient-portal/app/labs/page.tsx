"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import { useMyPatientRecord } from "@/lib/use-my-patient";

function flagColor(flag?: string | null): string {
  switch (flag) {
    case "critical": return "#ef4444";
    case "high": return "#f97316";
    case "low": return "#3b82f6";
    default: return "#666";
  }
}

function flagLabel(flag?: string | null): string {
  if (!flag) return "";
  return flag.toUpperCase();
}

export default function LabsPage() {
  const { user } = useAuth();
  const router = useRouter();

  const { patient: myRecord, isLoading: patientLoading, isUnlinked } = useMyPatientRecord();

  const labsQuery = trpc.clinicalData.labs.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  if (!user) {
    router.push("/login");
    return null;
  }

  const panels = labsQuery.data ?? [];

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>Lab Results</h2>
        <button
          onClick={() => router.push("/")}
          style={{
            background: "none",
            border: "1px solid #444",
            color: "#999",
            padding: "0.5rem 1rem",
            borderRadius: 6,
            cursor: "pointer",
          }}
        >
          Back to Dashboard
        </button>
      </div>

      {isUnlinked && (
        <p style={{ color: "#ef4444" }}>
          Your account is not linked to a patient record. Please contact your care team.
        </p>
      )}

      {labsQuery.isLoading && (
        <p style={{ color: "#999" }}>Loading lab results...</p>
      )}

      {labsQuery.isError && (
        <p role="alert" style={{ color: "#ef4444" }}>Failed to load lab results.</p>
      )}

      {panels.length === 0 && !labsQuery.isLoading && (
        <p style={{ color: "#999" }}>No lab results available.</p>
      )}

      {panels.map((entry) => (
        <div
          key={entry.panel.id}
          style={{
            backgroundColor: "#1a1a1a",
            border: "1px solid #2a2a2a",
            borderRadius: 8,
            padding: "1.25rem",
            marginBottom: "1rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: "0.75rem" }}>
            <h3 style={{ margin: 0, fontSize: "1rem" }}>{entry.panel.panel_name}</h3>
            <span style={{ color: "#666", fontSize: "0.8rem" }}>
              {entry.panel.collected_at ? new Date(entry.panel.collected_at).toLocaleDateString() : ""}
            </span>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid #333", color: "#999", fontSize: "0.8rem", textAlign: "left" }}>
                <th style={{ padding: "0.5rem 0" }}>Test</th>
                <th style={{ padding: "0.5rem 0" }}>Value</th>
                <th style={{ padding: "0.5rem 0" }}>Reference Range</th>
                <th style={{ padding: "0.5rem 0" }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {(entry.results ?? []).map((result: {
                id: string;
                test_name: string;
                value: number;
                unit: string;
                reference_low?: number | null;
                reference_high?: number | null;
                flag?: string | null;
              }) => (
                <tr key={result.id} style={{ borderBottom: "1px solid #222" }}>
                  <td style={{ padding: "0.5rem 0", fontSize: "0.9rem" }}>
                    {result.test_name}
                  </td>
                  <td style={{
                    padding: "0.5rem 0",
                    fontSize: "0.9rem",
                    fontWeight: result.flag ? 600 : 400,
                    color: result.flag ? flagColor(result.flag) : "#ededed",
                  }}>
                    {result.value} {result.unit}
                  </td>
                  <td style={{ padding: "0.5rem 0", fontSize: "0.8rem", color: "#666" }}>
                    {result.reference_low != null && result.reference_high != null
                      ? `${result.reference_low} - ${result.reference_high} ${result.unit}`
                      : "—"}
                  </td>
                  <td style={{ padding: "0.5rem 0" }}>
                    {result.flag && (
                      <span style={{
                        fontSize: "0.7rem",
                        fontWeight: 600,
                        color: flagColor(result.flag),
                        backgroundColor: `${flagColor(result.flag)}20`,
                        padding: "2px 6px",
                        borderRadius: 4,
                      }}>
                        {flagLabel(result.flag)}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

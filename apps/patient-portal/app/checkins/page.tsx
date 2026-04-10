"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";

const cardStyle = {
  backgroundColor: "#1a1a1a",
  border: "1px solid #2a2a2a",
  borderRadius: "8px",
  padding: "1.5rem",
} as const;

const FREQUENCY_LABELS: Record<string, string> = {
  daily: "Daily",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  as_needed: "As needed",
};

const CONDITION_LABELS: Record<string, string> = {
  oncology: "Oncology",
  cardiac: "Cardiac",
  post_discharge: "Post-Discharge",
  general: "General",
};

export default function CheckInsPage() {
  const { isAuthenticated, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, router]);

  const patientsQuery = trpc.patients.list.useQuery();
  const myRecord = patientsQuery.data?.find(
    (p) => p.name === user?.name,
  ) ?? patientsQuery.data?.[0];

  const templatesQuery = trpc.checkins.templates.list.useQuery();
  const historyQuery = trpc.checkins.history.byPatient.useQuery(
    { patient_id: myRecord?.id ?? "", limit: 10 },
    { enabled: !!myRecord },
  );

  if (!isAuthenticated) {
    return (
      <main>
        <p style={{ color: "#999" }}>Redirecting to login...</p>
      </main>
    );
  }

  const templates = templatesQuery.data ?? [];
  const history = historyQuery.data ?? [];

  // Build a map from template_id to template name for the history view
  const templateMap = new Map(templates.map((t) => [t.id, t]));

  return (
    <main>
      <div style={{ marginBottom: "1.5rem" }}>
        <Link
          href="/"
          style={{ color: "#999", fontSize: "0.8rem", textDecoration: "none" }}
        >
          &larr; Dashboard
        </Link>
        <h2 style={{ fontSize: "1.25rem", margin: "0.5rem 0 0" }}>
          My Check-Ins
        </h2>
      </div>

      <section style={{ marginBottom: "2rem" }}>
        <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>
          Available Check-Ins
        </h3>
        {templatesQuery.isLoading ? (
          <p style={{ color: "#999", fontSize: "0.875rem" }}>Loading...</p>
        ) : templates.length === 0 ? (
          <p style={{ color: "#999", fontSize: "0.875rem" }}>
            No check-in templates are available right now.
          </p>
        ) : (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
              gap: "0.75rem",
            }}
          >
            {templates.map((tpl) => (
              <Link
                key={tpl.id}
                href={`/checkins/${tpl.id}`}
                style={{ textDecoration: "none", color: "inherit" }}
              >
                <div
                  style={{
                    ...cardStyle,
                    cursor: "pointer",
                    transition: "border-color 0.15s",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.borderColor = "#3b82f6")
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.borderColor = "#2a2a2a")
                  }
                >
                  <div
                    style={{
                      fontSize: "0.95rem",
                      fontWeight: 600,
                      marginBottom: 4,
                    }}
                  >
                    {tpl.name}
                  </div>
                  {tpl.description && (
                    <div
                      style={{
                        fontSize: "0.8rem",
                        color: "#999",
                        marginBottom: 8,
                      }}
                    >
                      {tpl.description}
                    </div>
                  )}
                  <div style={{ fontSize: "0.75rem", color: "#666" }}>
                    {CONDITION_LABELS[tpl.target_condition] ??
                      tpl.target_condition}{" "}
                    &middot;{" "}
                    {FREQUENCY_LABELS[tpl.frequency] ?? tpl.frequency}
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>
          Recent Submissions
        </h3>
        {historyQuery.isLoading ? (
          <p style={{ color: "#999", fontSize: "0.875rem" }}>Loading...</p>
        ) : history.length === 0 ? (
          <p style={{ color: "#999", fontSize: "0.875rem" }}>
            No check-ins submitted yet. Complete one above to get started.
          </p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            {history.map((entry) => {
              const tpl = templateMap.get(entry.template_id);
              const date = new Date(entry.submitted_at);
              const hasRedFlags = entry.red_flag_hits.length > 0;
              return (
                <div key={entry.id} style={cardStyle}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <div>
                      <div style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                        {tpl?.name ?? "Check-In"}
                      </div>
                      <div style={{ fontSize: "0.75rem", color: "#999" }}>
                        {date.toLocaleDateString()} at{" "}
                        {date.toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </div>
                    </div>
                    {hasRedFlags && (
                      <span
                        style={{
                          fontSize: "0.7rem",
                          backgroundColor: "#7f1d1d",
                          color: "#fca5a5",
                          padding: "2px 8px",
                          borderRadius: "4px",
                        }}
                      >
                        {entry.red_flag_hits.length} concern
                        {entry.red_flag_hits.length !== 1 ? "s" : ""} flagged
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </main>
  );
}

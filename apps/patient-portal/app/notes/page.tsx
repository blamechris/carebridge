"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import { useMyPatientRecord } from "@/lib/use-my-patient";

const NOTE_TYPE_LABELS: Record<string, string> = {
  soap: "SOAP Note",
  progress: "Progress Note",
  h_and_p: "History & Physical",
  discharge: "Discharge Summary",
  consult: "Consultation Note",
};

export default function NotesPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const { patient: myRecord, isLoading: patientLoading } = useMyPatientRecord();

  const notesQuery = trpc.notes.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  if (!user) {
    router.push("/login");
    return null;
  }

  // Only show signed and cosigned notes (not drafts) — Open Notes compliance
  const allNotes = notesQuery.data ?? [];
  const visibleNotes = allNotes.filter(
    (n) => n.status === "signed" || n.status === "cosigned",
  );

  return (
    <div style={{ maxWidth: 800, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>My Clinical Notes</h2>
        <button
          onClick={() => router.push("/")}
          style={{ background: "none", border: "1px solid #444", color: "#999", padding: "0.5rem 1rem", borderRadius: 6, cursor: "pointer" }}
        >
          Back to Dashboard
        </button>
      </div>

      <p style={{ color: "#999", fontSize: "0.85rem", marginBottom: "1.5rem" }}>
        These are your signed clinical notes from your care team. Under the 21st Century Cures Act,
        you have the right to access these documents.
      </p>

      {notesQuery.isLoading && <p style={{ color: "#999" }}>Loading notes...</p>}
      {notesQuery.isError && <p style={{ color: "#ef4444" }}>Failed to load notes.</p>}

      {visibleNotes.length === 0 && !notesQuery.isLoading && (
        <p style={{ color: "#999" }}>No signed clinical notes available.</p>
      )}

      {visibleNotes.map((note) => {
        const isExpanded = expandedId === note.id;
        // The persisted note schema stores each section as
        // { label, key, fields[], free_text? }. The patient view only renders
        // a section heading and a flattened text body, so map the structured
        // shape into the simple { heading, content } pairs the markup below
        // expects.
        const rawSections = note.sections ?? [];
        const sections = rawSections.map((section) => {
          const fieldText = section.fields
            .filter(
              (f) =>
                f.value !== null && f.value !== undefined && f.value !== "",
            )
            .map((f) => {
              const rendered = Array.isArray(f.value)
                ? f.value.join(", ")
                : String(f.value);
              return `${f.label}: ${rendered}`;
            })
            .join("\n");
          const content = [section.free_text, fieldText]
            .filter((part) => part && part.length > 0)
            .join("\n\n");
          return { heading: section.label, content };
        });

        return (
          <div
            key={note.id}
            style={{
              backgroundColor: "#1a1a1a",
              border: "1px solid #2a2a2a",
              borderRadius: 8,
              marginBottom: "0.75rem",
              overflow: "hidden",
            }}
          >
            <button
              onClick={() => setExpandedId(isExpanded ? null : note.id)}
              style={{
                width: "100%",
                padding: "1rem 1.25rem",
                background: "none",
                border: "none",
                color: "#ededed",
                textAlign: "left",
                cursor: "pointer",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>
                  {NOTE_TYPE_LABELS[note.template_type] ?? note.template_type}
                </div>
                <div style={{ fontSize: "0.8rem", color: "#666", marginTop: 2 }}>
                  {note.signed_at ? new Date(note.signed_at).toLocaleDateString() : ""} &middot; {note.status}
                </div>
              </div>
              <span style={{ color: "#666", fontSize: "1.2rem" }}>{isExpanded ? "\u25B2" : "\u25BC"}</span>
            </button>

            {isExpanded && sections.length > 0 && (
              <div style={{ padding: "0 1.25rem 1.25rem", borderTop: "1px solid #2a2a2a" }}>
                {sections.map((section, i) => (
                  <div key={i} style={{ marginTop: "1rem" }}>
                    <h4 style={{ margin: "0 0 0.25rem", fontSize: "0.85rem", color: "#999", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                      {section.heading}
                    </h4>
                    <p style={{ margin: 0, fontSize: "0.9rem", lineHeight: 1.5, whiteSpace: "pre-wrap" }}>
                      {section.content}
                    </p>
                  </div>
                ))}
              </div>
            )}

            {isExpanded && sections.length === 0 && (
              <div style={{ padding: "0 1.25rem 1.25rem", color: "#666", fontSize: "0.85rem" }}>
                Note content not available.
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

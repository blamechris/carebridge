"use client";

import Link from "next/link";
import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { AuthGuard } from "@/lib/auth-guard";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function statusBadgeClass(status: string): string {
  if (status === "signed" || status === "cosigned") return "badge badge-success";
  if (status === "amended") return "badge badge-warning";
  return "badge";
}

function NotesContent() {
  const patientsQuery = trpc.patients.list.useQuery();
  const patients = patientsQuery.data ?? [];

  const patientQueries = trpc.useQueries((t) =>
    patients.map((p) => t.notes.getByPatient({ patientId: p.id })),
  );

  const patientsById = useMemo(() => {
    const map = new Map<string, { name: string; mrn: string | null }>();
    for (const p of patients) {
      map.set(p.id, { name: p.name, mrn: p.mrn ?? null });
    }
    return map;
  }, [patients]);

  const allNotes = useMemo(() => {
    const combined: Array<{
      id: string;
      patient_id: string;
      provider_id: string;
      template_type: string;
      status: string;
      version: number;
      created_at: string;
    }> = [];
    for (const q of patientQueries) {
      if (q.data) combined.push(...q.data);
    }
    combined.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return combined;
  }, [patientQueries]);

  const isLoading =
    patientsQuery.isLoading || patientQueries.some((q) => q.isLoading);

  return (
    <>
      <div
        className="page-header"
        style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end" }}
      >
        <div>
          <h1 className="page-title">Clinical Notes</h1>
          <p className="page-subtitle">
            {isLoading
              ? "Loading..."
              : `${allNotes.length} notes across your patient panel`}
          </p>
        </div>
        <Link href="/notes/new" className="btn btn-primary">
          + New Note
        </Link>
      </div>

      {patientsQuery.isError ? (
        <div className="table-container" style={{ padding: 24, color: "var(--critical)" }}>
          Failed to load patients. Is the API running on localhost:4000?
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Type</th>
                <th>Status</th>
                <th>Version</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={6} style={{ color: "var(--text-muted)", textAlign: "center" }}>
                    Loading notes...
                  </td>
                </tr>
              ) : allNotes.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ color: "var(--text-muted)", textAlign: "center" }}>
                    No notes found. Create the first one using + New Note.
                  </td>
                </tr>
              ) : (
                allNotes.map((note) => {
                  const patient = patientsById.get(note.patient_id);
                  return (
                    <tr key={note.id}>
                      <td data-label="Patient">
                        <Link href={`/patients/${note.patient_id}`}>
                          {patient?.name ?? note.patient_id}
                        </Link>
                        {patient?.mrn && (
                          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                            {patient.mrn}
                          </div>
                        )}
                      </td>
                      <td
                        data-label="Type"
                        style={{ textTransform: "uppercase", fontSize: 12 }}
                      >
                        {note.template_type}
                      </td>
                      <td data-label="Status">
                        <span className={statusBadgeClass(note.status)}>
                          {note.status.toUpperCase()}
                        </span>
                      </td>
                      <td data-label="Version">v{note.version}</td>
                      <td
                        data-label="Created"
                        style={{ color: "var(--text-secondary)" }}
                      >
                        {formatDate(note.created_at)}
                      </td>
                      <td data-label="Actions">
                        <Link href={`/notes/${note.id}`} className="btn btn-ghost btn-sm">
                          Open
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function NotesPage() {
  return (
    <AuthGuard>
      <NotesContent />
    </AuthGuard>
  );
}

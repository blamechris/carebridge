"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { AuthGuard } from "@/lib/auth-guard";
import { useAuth } from "@/lib/auth";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

type NoteField = {
  key: string;
  label: string;
  value: string | string[] | boolean | number | null;
  field_type: string;
};

type NoteSection = {
  key: string;
  label: string;
  fields: NoteField[];
  free_text?: string;
};

function renderFieldValue(field: NoteField): string {
  const v = field.value;
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.length === 0 ? "—" : v.join(", ");
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

function SectionView({ section }: { section: NoteSection }) {
  return (
    <div className="detail-card" style={{ marginBottom: 16 }}>
      <div className="detail-card-title">{section.label}</div>
      {section.fields.map((field) => (
        <div
          key={field.key}
          className="detail-row"
          style={{ alignItems: "flex-start", flexDirection: "column", gap: 4 }}
        >
          <span className="detail-label">{field.label}</span>
          <span
            className="detail-value"
            style={{ whiteSpace: "pre-wrap", color: "var(--text-primary)" }}
          >
            {renderFieldValue(field)}
          </span>
        </div>
      ))}
      {section.free_text && (
        <div className="detail-row" style={{ flexDirection: "column", gap: 4 }}>
          <span className="detail-label">Additional Notes</span>
          <span className="detail-value" style={{ whiteSpace: "pre-wrap" }}>
            {section.free_text}
          </span>
        </div>
      )}
    </div>
  );
}

function NoteDetailContent() {
  const params = useParams();
  const { user } = useAuth();
  const noteId = params.id as string;

  const utils = trpc.useUtils();
  const noteQuery = trpc.notes.getById.useQuery({ id: noteId });
  const patientQuery = trpc.patients.getById.useQuery(
    { id: noteQuery.data?.note.patient_id ?? "" },
    { enabled: !!noteQuery.data?.note.patient_id },
  );

  const signMutation = trpc.notes.sign.useMutation({
    onSuccess: async () => {
      await utils.notes.getById.invalidate({ id: noteId });
    },
  });

  if (noteQuery.isLoading) {
    return <div style={{ padding: 24, color: "var(--text-muted)" }}>Loading note...</div>;
  }

  if (noteQuery.isError || !noteQuery.data) {
    return (
      <div style={{ padding: 24, color: "var(--critical)" }}>
        Failed to load note, or note not found.
      </div>
    );
  }

  const { note, versions } = noteQuery.data;
  const patient = patientQuery.data;
  const canSign = note.status === "draft" && !!user;

  function handleSign() {
    if (!user) return;
    if (!confirm("Sign this note? Signed notes become part of the permanent record.")) {
      return;
    }
    signMutation.mutate({ noteId, signed_by: user.id });
  }

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link href="/notes" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          &larr; Back to Notes
        </Link>
      </div>

      <div className="page-header">
        <h1 className="page-title" style={{ textTransform: "uppercase" }}>
          {note.template_type} Note
        </h1>
        <p className="page-subtitle">
          {patient ? (
            <>
              Patient: <Link href={`/patients/${note.patient_id}`}>{patient.name}</Link>
              {patient.mrn ? ` (${patient.mrn})` : ""}
            </>
          ) : (
            `Patient: ${note.patient_id}`
          )}
        </p>
      </div>

      <div className="detail-card" style={{ marginBottom: 16 }}>
        <div className="detail-card-title">Note Metadata</div>
        <div className="detail-row">
          <span className="detail-label">Status</span>
          <span className="detail-value">
            <span
              className={
                note.status === "signed" || note.status === "cosigned"
                  ? "badge badge-success"
                  : "badge"
              }
            >
              {note.status.toUpperCase()}
            </span>
          </span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Version</span>
          <span className="detail-value">v{note.version}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Author</span>
          <span className="detail-value" style={{ fontFamily: "monospace", fontSize: 12 }}>
            {note.provider_id}
          </span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Created</span>
          <span className="detail-value">{formatDate(note.created_at)}</span>
        </div>
        {note.signed_at && (
          <div className="detail-row">
            <span className="detail-label">Signed</span>
            <span className="detail-value">
              {formatDate(note.signed_at)}
              {note.signed_by ? ` by ${note.signed_by}` : ""}
            </span>
          </div>
        )}
        <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
          {canSign && (
            <button
              className="btn btn-primary btn-sm"
              onClick={handleSign}
              disabled={signMutation.isPending}
            >
              {signMutation.isPending ? "Signing..." : "Sign Note"}
            </button>
          )}
          {signMutation.isError && (
            <span style={{ color: "var(--critical)", fontSize: 12 }}>
              {signMutation.error.message}
            </span>
          )}
        </div>
      </div>

      {(note.sections as NoteSection[]).map((section) => (
        <SectionView key={section.key} section={section} />
      ))}

      {versions.length > 0 && (
        <div className="detail-card">
          <div className="detail-card-title">Version History</div>
          {versions.map((v) => (
            <div key={v.version} className="detail-row">
              <span className="detail-label">v{v.version}</span>
              <span className="detail-value">
                {formatDate(v.saved_at)} — {v.saved_by}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export default function NoteDetailPage() {
  return (
    <AuthGuard>
      <NoteDetailContent />
    </AuthGuard>
  );
}

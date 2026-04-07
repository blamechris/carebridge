"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc";
import { AuthGuard } from "@/lib/auth-guard";
import { useAuth } from "@/lib/auth";

type FieldType =
  | "text"
  | "textarea"
  | "select"
  | "multiselect"
  | "checkbox"
  | "number";

type NoteField = {
  key: string;
  label: string;
  value: string | string[] | boolean | number | null;
  field_type: FieldType;
  source: "new_entry" | "carried_forward" | "modified";
  options?: string[];
};

type NoteSection = {
  key: string;
  label: string;
  fields: NoteField[];
  free_text?: string;
};

type TemplateType = "soap" | "progress";

function FieldInput({
  field,
  onChange,
}: {
  field: NoteField;
  onChange: (value: NoteField["value"]) => void;
}) {
  if (field.field_type === "textarea") {
    return (
      <textarea
        className="search-input"
        style={{ width: "100%", minHeight: 80, padding: 8 }}
        value={(field.value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  if (field.field_type === "checkbox") {
    return (
      <input
        type="checkbox"
        checked={!!field.value}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (field.field_type === "number") {
    return (
      <input
        type="number"
        className="search-input"
        style={{ width: "100%" }}
        value={field.value === null ? "" : Number(field.value)}
        onChange={(e) =>
          onChange(e.target.value === "" ? null : Number(e.target.value))
        }
      />
    );
  }
  if (field.field_type === "multiselect" && field.options) {
    const selected = Array.isArray(field.value) ? field.value : [];
    return (
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          maxHeight: 120,
          overflowY: "auto",
          padding: 8,
          border: "1px solid var(--border)",
          borderRadius: 4,
        }}
      >
        {field.options.map((opt) => {
          const checked = selected.includes(opt);
          return (
            <label
              key={opt}
              style={{
                fontSize: 12,
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={(e) => {
                  if (e.target.checked) {
                    onChange([...selected, opt]);
                  } else {
                    onChange(selected.filter((s) => s !== opt));
                  }
                }}
              />
              {opt}
            </label>
          );
        })}
      </div>
    );
  }
  if (field.field_type === "select" && field.options) {
    return (
      <select
        className="search-input"
        style={{ width: "100%" }}
        value={(field.value as string) ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">—</option>
        {field.options.map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      type="text"
      className="search-input"
      style={{ width: "100%" }}
      value={(field.value as string) ?? ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function NewNoteContent() {
  const router = useRouter();
  const { user } = useAuth();
  const [templateType, setTemplateType] = useState<TemplateType>("soap");
  const [patientId, setPatientId] = useState<string>("");
  const [sections, setSections] = useState<NoteSection[]>([]);

  const patientsQuery = trpc.patients.list.useQuery();
  const templateQuery = trpc.notes.templates.get.useQuery({ type: templateType });

  useEffect(() => {
    if (templateQuery.data) {
      setSections(templateQuery.data as unknown as NoteSection[]);
    }
  }, [templateQuery.data]);

  const createMutation = trpc.notes.create.useMutation({
    onSuccess: (note) => {
      router.push(`/notes/${note.id}`);
    },
  });

  function updateField(
    sectionIdx: number,
    fieldIdx: number,
    value: NoteField["value"],
  ) {
    setSections((prev) => {
      const next = prev.map((s) => ({
        ...s,
        fields: s.fields.map((f) => ({ ...f })),
      }));
      next[sectionIdx].fields[fieldIdx].value = value;
      next[sectionIdx].fields[fieldIdx].source = "modified";
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    if (!patientId) {
      alert("Please select a patient.");
      return;
    }
    if (sections.length === 0) {
      alert("Template not loaded yet.");
      return;
    }
    createMutation.mutate({
      patient_id: patientId,
      provider_id: user.id,
      template_type: templateType,
      sections,
    });
  }

  const patients = patientsQuery.data ?? [];

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link href="/notes" style={{ fontSize: 12, color: "var(--text-muted)" }}>
          &larr; Back to Notes
        </Link>
      </div>

      <div className="page-header">
        <h1 className="page-title">New Clinical Note</h1>
        <p className="page-subtitle">
          Create a new draft note using a structured template
        </p>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="detail-card" style={{ marginBottom: 16 }}>
          <div className="detail-card-title">Note Details</div>
          <div className="detail-row" style={{ flexDirection: "column", gap: 4 }}>
            <label className="detail-label">Patient</label>
            <select
              className="search-input"
              style={{ width: "100%" }}
              value={patientId}
              onChange={(e) => setPatientId(e.target.value)}
              required
            >
              <option value="">Select a patient...</option>
              {patients.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} {p.mrn ? `(${p.mrn})` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="detail-row" style={{ flexDirection: "column", gap: 4 }}>
            <label className="detail-label">Template</label>
            <select
              className="search-input"
              style={{ width: "100%" }}
              value={templateType}
              onChange={(e) => setTemplateType(e.target.value as TemplateType)}
            >
              <option value="soap">SOAP (Subjective, Objective, Assessment, Plan)</option>
              <option value="progress">Progress Note</option>
            </select>
          </div>
        </div>

        {templateQuery.isLoading ? (
          <div style={{ padding: 24, color: "var(--text-muted)" }}>
            Loading template...
          </div>
        ) : (
          sections.map((section, sIdx) => (
            <div key={section.key} className="detail-card" style={{ marginBottom: 16 }}>
              <div className="detail-card-title">{section.label}</div>
              {section.fields.map((field, fIdx) => (
                <div
                  key={field.key}
                  className="detail-row"
                  style={{ flexDirection: "column", gap: 4, alignItems: "stretch" }}
                >
                  <label className="detail-label">{field.label}</label>
                  <FieldInput
                    field={field}
                    onChange={(v) => updateField(sIdx, fIdx, v)}
                  />
                </div>
              ))}
            </div>
          ))
        )}

        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={createMutation.isPending || !patientId}
          >
            {createMutation.isPending ? "Saving..." : "Save Draft"}
          </button>
          <Link href="/notes" className="btn btn-ghost">
            Cancel
          </Link>
          {createMutation.isError && (
            <span style={{ color: "var(--critical)", fontSize: 12, alignSelf: "center" }}>
              {createMutation.error.message}
            </span>
          )}
        </div>
      </form>
    </>
  );
}

export default function NewNotePage() {
  return (
    <AuthGuard>
      <NewNoteContent />
    </AuthGuard>
  );
}

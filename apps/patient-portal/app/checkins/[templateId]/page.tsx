"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter, useParams } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import type { CheckInQuestion, CheckInResponses } from "@carebridge/validators";

// ── Shared styles ────────────────────────────────────────────────

const inputStyle = {
  width: "100%",
  padding: "10px 12px",
  backgroundColor: "#1a1a1a",
  border: "1px solid #2a2a2a",
  borderRadius: "6px",
  color: "#ededed",
  fontSize: "0.875rem",
  boxSizing: "border-box" as const,
} as const;

const primaryButtonStyle = (disabled: boolean) =>
  ({
    width: "100%",
    padding: "12px",
    backgroundColor: "#3b82f6",
    color: "white",
    border: "none",
    borderRadius: "6px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.7 : 1,
    fontSize: "0.875rem",
    fontWeight: 600,
  }) as const;

const labelStyle = {
  display: "block",
  fontSize: "0.875rem",
  marginBottom: 6,
} as const;

const fieldWrap = {
  marginBottom: "1.25rem",
} as const;

// ── Question renderers ───────────────────────────────────────────

function BooleanField({
  question,
  value,
  onChange,
}: {
  question: CheckInQuestion;
  value: boolean | undefined;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={fieldWrap}>
      <label style={labelStyle}>{question.prompt}</label>
      <div style={{ display: "flex", gap: 8 }}>
        {[
          { label: "Yes", val: true },
          { label: "No", val: false },
        ].map(({ label, val }) => (
          <button
            key={label}
            type="button"
            onClick={() => onChange(val)}
            style={{
              flex: 1,
              padding: "8px 12px",
              border: "1px solid",
              borderColor: value === val ? "#3b82f6" : "#2a2a2a",
              backgroundColor: value === val ? "#1e3a5f" : "#1a1a1a",
              color: value === val ? "#93c5fd" : "#ededed",
              borderRadius: "6px",
              cursor: "pointer",
              fontSize: "0.875rem",
            }}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ScaleField({
  question,
  value,
  onChange,
}: {
  question: CheckInQuestion;
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  return (
    <div style={fieldWrap}>
      <label style={labelStyle}>
        {question.prompt}
        <span style={{ color: "#999", fontSize: "0.75rem", marginLeft: 6 }}>
          ({value ?? 0}/10)
        </span>
      </label>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {Array.from({ length: 11 }, (_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onChange(i)}
            style={{
              width: 36,
              height: 36,
              borderRadius: "6px",
              border: "1px solid",
              borderColor: value === i ? "#3b82f6" : "#2a2a2a",
              backgroundColor: value === i ? "#1e3a5f" : "#1a1a1a",
              color: value === i ? "#93c5fd" : "#ededed",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            {i}
          </button>
        ))}
      </div>
    </div>
  );
}

function NumberField({
  question,
  value,
  onChange,
}: {
  question: CheckInQuestion;
  value: number | undefined;
  onChange: (v: number) => void;
}) {
  return (
    <div style={fieldWrap}>
      <label style={labelStyle}>{question.prompt}</label>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!Number.isNaN(n)) onChange(n);
        }}
        style={inputStyle}
      />
    </div>
  );
}

function SelectField({
  question,
  value,
  onChange,
}: {
  question: CheckInQuestion;
  value: string | undefined;
  onChange: (v: string) => void;
}) {
  const options = question.options ?? [];
  return (
    <div style={fieldWrap}>
      <label style={labelStyle}>{question.prompt}</label>
      <select
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
        style={{ ...inputStyle, appearance: "auto" as const }}
      >
        <option value="" disabled>
          Select...
        </option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function MultiField({
  question,
  value,
  onChange,
}: {
  question: CheckInQuestion;
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const options = question.options ?? [];
  function toggle(optValue: string) {
    if (value.includes(optValue)) {
      onChange(value.filter((v) => v !== optValue));
    } else {
      onChange([...value, optValue]);
    }
  }
  return (
    <div style={fieldWrap}>
      <label style={labelStyle}>{question.prompt}</label>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {options.map((opt) => {
          const checked = value.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggle(opt.value)}
              style={{
                textAlign: "left",
                padding: "8px 12px",
                borderRadius: "6px",
                border: "1px solid",
                borderColor: checked ? "#3b82f6" : "#2a2a2a",
                backgroundColor: checked ? "#1e3a5f" : "#1a1a1a",
                color: checked ? "#93c5fd" : "#ededed",
                cursor: "pointer",
                fontSize: "0.875rem",
              }}
            >
              {checked ? "\u2611 " : "\u2610 "}{opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TextField({
  question,
  value,
  onChange,
}: {
  question: CheckInQuestion;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div style={fieldWrap}>
      <label style={labelStyle}>{question.prompt}</label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        maxLength={2000}
        style={{ ...inputStyle, resize: "vertical" }}
      />
    </div>
  );
}

// ── Main page ────────────────────────────────────────────────────

export default function CheckInFormPage() {
  const { isAuthenticated, user } = useAuth();
  const router = useRouter();
  const params = useParams<{ templateId: string }>();
  const templateId = params.templateId;

  const [responses, setResponses] = useState<CheckInResponses>({});
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, router]);

  const patientsQuery = trpc.patients.list.useQuery();
  const myRecord = patientsQuery.data?.find(
    (p) => p.name === user?.name,
  ) ?? patientsQuery.data?.[0];

  const templateQuery = trpc.checkins.templates.get.useQuery(
    { id: templateId },
    { enabled: !!templateId },
  );

  const submitMutation = trpc.checkins.submit.useMutation();

  const setField = useCallback(
    (questionId: string, value: boolean | number | string | string[]) => {
      setResponses((prev) => ({ ...prev, [questionId]: value }));
    },
    [],
  );

  if (!isAuthenticated) {
    return (
      <main>
        <p style={{ color: "#999" }}>Redirecting to login...</p>
      </main>
    );
  }

  if (templateQuery.isLoading) {
    return (
      <main>
        <p style={{ color: "#999" }}>Loading check-in...</p>
      </main>
    );
  }

  const template = templateQuery.data;
  if (!template) {
    return (
      <main>
        <Link
          href="/checkins"
          style={{ color: "#999", fontSize: "0.8rem", textDecoration: "none" }}
        >
          &larr; Check-Ins
        </Link>
        <p style={{ color: "#ef4444", marginTop: "1rem" }}>
          Check-in template not found.
        </p>
      </main>
    );
  }

  const questions = (template.questions ?? []) as CheckInQuestion[];

  if (submitted) {
    return (
      <main>
        <div
          style={{
            maxWidth: 480,
            margin: "2rem auto",
            backgroundColor: "#1a1a1a",
            border: "1px solid #2a2a2a",
            borderRadius: "8px",
            padding: "2rem",
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: "1.5rem", marginBottom: "0.75rem" }}>
            &#10003;
          </div>
          <h2 style={{ fontSize: "1.1rem", margin: "0 0 0.5rem" }}>
            Check-In Submitted
          </h2>
          <p style={{ color: "#999", fontSize: "0.875rem", marginBottom: "1.5rem" }}>
            Thank you for completing your {template.name.toLowerCase()}. Your
            care team will review your responses.
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <Link
              href="/checkins"
              style={{
                flex: 1,
                padding: "10px",
                backgroundColor: "transparent",
                border: "1px solid #2a2a2a",
                borderRadius: "6px",
                color: "#ededed",
                textDecoration: "none",
                fontSize: "0.875rem",
                textAlign: "center",
              }}
            >
              All Check-Ins
            </Link>
            <Link
              href="/"
              style={{
                flex: 1,
                padding: "10px",
                backgroundColor: "#3b82f6",
                border: "none",
                borderRadius: "6px",
                color: "white",
                textDecoration: "none",
                fontSize: "0.875rem",
                textAlign: "center",
              }}
            >
              Dashboard
            </Link>
          </div>
        </div>
      </main>
    );
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!myRecord) {
      setError("No patient record found. Contact your care team.");
      return;
    }
    try {
      await submitMutation.mutateAsync({
        patient_id: myRecord.id,
        template_id: template!.id,
        template_version: template!.version,
        responses,
      });
      setSubmitted(true);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Submission failed. Please try again.";
      setError(message);
    }
  }

  return (
    <main>
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        <Link
          href="/checkins"
          style={{ color: "#999", fontSize: "0.8rem", textDecoration: "none" }}
        >
          &larr; Check-Ins
        </Link>
        <h2 style={{ fontSize: "1.25rem", margin: "0.5rem 0 0.25rem" }}>
          {template.name}
        </h2>
        {template.description && (
          <p style={{ color: "#999", fontSize: "0.8rem", margin: "0 0 1.5rem" }}>
            {template.description}
          </p>
        )}

        <form onSubmit={handleSubmit}>
          {questions.map((q) => {
            switch (q.type) {
              case "boolean":
                return (
                  <BooleanField
                    key={q.id}
                    question={q}
                    value={responses[q.id] as boolean | undefined}
                    onChange={(v) => setField(q.id, v)}
                  />
                );
              case "scale":
                return (
                  <ScaleField
                    key={q.id}
                    question={q}
                    value={responses[q.id] as number | undefined}
                    onChange={(v) => setField(q.id, v)}
                  />
                );
              case "number":
                return (
                  <NumberField
                    key={q.id}
                    question={q}
                    value={responses[q.id] as number | undefined}
                    onChange={(v) => setField(q.id, v)}
                  />
                );
              case "select":
                return (
                  <SelectField
                    key={q.id}
                    question={q}
                    value={responses[q.id] as string | undefined}
                    onChange={(v) => setField(q.id, v)}
                  />
                );
              case "multi":
                return (
                  <MultiField
                    key={q.id}
                    question={q}
                    value={(responses[q.id] as string[]) ?? []}
                    onChange={(v) => setField(q.id, v)}
                  />
                );
              case "text":
                return (
                  <TextField
                    key={q.id}
                    question={q}
                    value={(responses[q.id] as string) ?? ""}
                    onChange={(v) => setField(q.id, v)}
                  />
                );
              default:
                return null;
            }
          })}

          {error && (
            <div
              style={{
                color: "#ef4444",
                fontSize: "0.8rem",
                marginBottom: 12,
              }}
            >
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitMutation.isPending}
            style={primaryButtonStyle(submitMutation.isPending)}
          >
            {submitMutation.isPending ? "Submitting..." : "Submit Check-In"}
          </button>
        </form>
      </div>
    </main>
  );
}

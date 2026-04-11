"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";

const OBSERVATION_TYPES = [
  { value: "pain", label: "Pain" },
  { value: "neurological", label: "Neurological (headache, dizziness, numbness)" },
  { value: "gastrointestinal", label: "Digestive (nausea, stomach pain)" },
  { value: "respiratory", label: "Breathing" },
  { value: "skin", label: "Skin (rash, bruising, swelling)" },
  { value: "cardiovascular", label: "Heart (palpitations, chest)" },
  { value: "general", label: "General (fatigue, fever, weight change)" },
  { value: "medication_side_effect", label: "Medication Side Effect" },
] as const;

const SEVERITY_OPTIONS = [
  { value: "mild", label: "Mild — noticeable but manageable" },
  { value: "moderate", label: "Moderate — affecting daily activities" },
  { value: "severe", label: "Severe — significant impact or concern" },
] as const;

type ObservationType = typeof OBSERVATION_TYPES[number]["value"];

export default function SymptomsPage() {
  const { user } = useAuth();
  const router = useRouter();
  const utils = trpc.useUtils();

  const patientsQuery = trpc.patients.list.useQuery();
  const myRecord = patientsQuery.data?.find(
    (p) => p.name === user?.name,
  ) ?? patientsQuery.data?.[0];

  const observationsQuery = trpc.patients.observations.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const createMutation = trpc.patients.observations.create.useMutation({
    onSuccess: () => {
      utils.patients.observations.getByPatient.invalidate();
      setDescription("");
      setSeverityScale(5);
      setLocation("");
      setDuration("");
      setSubmitted(true);
      setTimeout(() => setSubmitted(false), 3000);
    },
  });

  const [selectedType, setSelectedType] = useState<ObservationType>("general");
  const [description, setDescription] = useState("");
  const [severityAssessment, setSeverityAssessment] = useState<"mild" | "moderate" | "severe">("mild");
  const [severityScale, setSeverityScale] = useState(5);
  const [location, setLocation] = useState("");
  const [duration, setDuration] = useState("");
  const [submitted, setSubmitted] = useState(false);

  if (!user) {
    router.push("/login");
    return null;
  }

  function handleSubmit() {
    if (!myRecord || !description.trim()) return;

    createMutation.mutate({
      patientId: myRecord.id,
      observationType: selectedType,
      description: description.trim(),
      structuredData: {
        severity: severityScale,
        location: location || undefined,
        duration: duration || undefined,
      },
      severitySelfAssessment: severityAssessment,
    });
  }

  const observations = observationsQuery.data ?? [];

  const inputStyle = {
    width: "100%",
    padding: "0.5rem",
    backgroundColor: "#222",
    border: "1px solid #444",
    borderRadius: 6,
    color: "#ededed",
    fontSize: "0.9rem",
  };

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>How Are You Feeling?</h2>
        <button
          onClick={() => router.push("/")}
          style={{ background: "none", border: "1px solid #444", color: "#999", padding: "0.5rem 1rem", borderRadius: 6, cursor: "pointer" }}
        >
          Back to Dashboard
        </button>
      </div>

      <p style={{ color: "#999", fontSize: "0.85rem", marginBottom: "1.5rem" }}>
        Record your symptoms and observations. Your care team will be able to see these
        in a separate &quot;Patient Signals&quot; section — they won&apos;t clutter your clinical chart
        but will help ensure nothing important is missed.
      </p>

      {submitted && (
        <div style={{ backgroundColor: "#16a34a20", border: "1px solid #16a34a", borderRadius: 8, padding: "0.75rem", marginBottom: "1rem", color: "#16a34a" }}>
          Observation recorded. Your care team will be notified if any patterns are detected.
        </div>
      )}

      <div style={{ backgroundColor: "#1a1a1a", border: "1px solid #2a2a2a", borderRadius: 8, padding: "1.25rem", marginBottom: "2rem" }}>
        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: "0.85rem", color: "#999" }}>
            What type of symptom?
          </label>
          <select
            value={selectedType}
            onChange={(e) => setSelectedType(e.target.value as ObservationType)}
            style={{ ...inputStyle, cursor: "pointer" }}
          >
            {OBSERVATION_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>

        {(selectedType === "pain" || selectedType === "skin") && (
          <div style={{ marginBottom: "1rem" }}>
            <label style={{ display: "block", marginBottom: 4, fontSize: "0.85rem", color: "#999" }}>
              Where on your body?
            </label>
            <input
              type="text"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="e.g., lower back, left arm, chest"
              style={inputStyle}
            />
          </div>
        )}

        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: "0.85rem", color: "#999" }}>
            How severe? ({severityScale}/10)
          </label>
          <input
            type="range"
            min={1}
            max={10}
            value={severityScale}
            onChange={(e) => setSeverityScale(Number(e.target.value))}
            style={{ width: "100%" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.75rem", color: "#666" }}>
            <span>Barely noticeable</span>
            <span>Worst imaginable</span>
          </div>
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: "0.85rem", color: "#999" }}>
            Overall severity
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            {SEVERITY_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setSeverityAssessment(opt.value)}
                style={{
                  flex: 1,
                  padding: "0.5rem",
                  backgroundColor: severityAssessment === opt.value ? "#2563eb" : "#222",
                  border: `1px solid ${severityAssessment === opt.value ? "#2563eb" : "#444"}`,
                  borderRadius: 6,
                  color: severityAssessment === opt.value ? "#fff" : "#999",
                  cursor: "pointer",
                  fontSize: "0.8rem",
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: "0.85rem", color: "#999" }}>
            How long has this been going on?
          </label>
          <input
            type="text"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="e.g., since yesterday, 3 days, a few hours"
            style={inputStyle}
          />
        </div>

        <div style={{ marginBottom: "1rem" }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: "0.85rem", color: "#999" }}>
            Describe what you&apos;re experiencing
          </label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Tell us in your own words what's going on..."
            rows={4}
            style={{ ...inputStyle, resize: "vertical" }}
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={!description.trim() || createMutation.isPending}
          style={{
            width: "100%",
            padding: "0.75rem",
            backgroundColor: description.trim() ? "#2563eb" : "#333",
            border: "none",
            borderRadius: 6,
            color: description.trim() ? "#fff" : "#666",
            cursor: description.trim() ? "pointer" : "not-allowed",
            fontSize: "0.9rem",
            fontWeight: 600,
          }}
        >
          {createMutation.isPending ? "Submitting..." : "Submit Observation"}
        </button>
      </div>

      <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>Recent Observations</h3>

      {observations.length === 0 ? (
        <p style={{ color: "#999", fontSize: "0.85rem" }}>No observations recorded yet.</p>
      ) : (
        observations.map((obs) => (
          <div
            key={obs.id}
            style={{
              backgroundColor: "#1a1a1a",
              border: "1px solid #2a2a2a",
              borderRadius: 8,
              padding: "1rem",
              marginBottom: "0.75rem",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ fontSize: "0.85rem", fontWeight: 600, textTransform: "capitalize" }}>
                {obs.observation_type.replace(/_/g, " ")}
              </span>
              <span style={{ fontSize: "0.75rem", color: "#666" }}>
                {new Date(obs.created_at).toLocaleDateString()}
              </span>
            </div>
            <p style={{ margin: "4px 0 0", fontSize: "0.85rem", color: "#ccc" }}>
              {obs.description}
            </p>
            {obs.severity_self_assessment && (
              <span style={{
                display: "inline-block",
                marginTop: 6,
                fontSize: "0.7rem",
                padding: "2px 6px",
                borderRadius: 4,
                backgroundColor: obs.severity_self_assessment === "severe" ? "#ef444420" : obs.severity_self_assessment === "moderate" ? "#f9731620" : "#22c55e20",
                color: obs.severity_self_assessment === "severe" ? "#ef4444" : obs.severity_self_assessment === "moderate" ? "#f97316" : "#22c55e",
              }}>
                {obs.severity_self_assessment}
              </span>
            )}
          </div>
        ))
      )}
    </div>
  );
}

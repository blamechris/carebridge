"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import { useMyPatientRecord } from "@/lib/use-my-patient";
import {
  getDiagnosisEducation,
  getMedicationEducation,
  type EducationContent,
} from "@carebridge/medical-logic";
import { EducationCard } from "@/components/EducationCard";

/**
 * Patient education page (issue #328).
 *
 * Renders an educational card for each of the patient's active diagnoses
 * and medications. Content lives in @carebridge/medical-logic so it's
 * static (no loading spinner for the copy itself) and the same library
 * can power the clinician-portal if we choose to add clinician-side
 * talking points later.
 */
export default function HealthInfoPage() {
  const { user } = useAuth();
  const router = useRouter();

  const { patient: myRecord, isLoading: patientLoading, isUnlinked } = useMyPatientRecord();

  const diagnosesQuery = trpc.patients.diagnoses.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const medicationsQuery = trpc.clinicalData.medications.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  // Redirect to /login from an effect, not inline during render, so Next
  // doesn't warn about state updates while rendering and so the redirect
  // doesn't fire twice on Strict-Mode double-renders.
  useEffect(() => {
    if (!user) router.replace("/login");
  }, [user, router]);

  if (!user) return null;

  const diagnoses = diagnosesQuery.data ?? [];
  const medications = medicationsQuery.data ?? [];

  const activeDiagnoses = diagnoses.filter(
    (d) => d.status === "active" || d.status === "chronic",
  );
  const activeMeds = medications.filter((m) => m.status === "active" || m.status === "held");

  type Entry = { key: string; anchor: string; content: EducationContent };

  // Build a deduplicated list of education cards keyed on the content
  // title so a patient with two hypertension ICD-10 codes only sees one
  // High-Blood-Pressure card. React `key` is derived from the content
  // title too (not the originating dx/med row id) so adding or
  // reordering duplicate diagnosis rows doesn't force React to unmount
  // and remount the surviving card.
  const titleKey = (title: string) =>
    title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  const diagnosisEntries: Entry[] = [];
  for (const dx of activeDiagnoses) {
    const content = getDiagnosisEducation(dx.icd10_code, dx.description);
    if (content) {
      diagnosisEntries.push({
        key: `dx-${titleKey(content.title)}`,
        anchor: dx.description,
        content,
      });
    }
  }
  const diagnosisByTitle = new Map<string, Entry>();
  for (const entry of diagnosisEntries) {
    if (!diagnosisByTitle.has(entry.content.title)) {
      diagnosisByTitle.set(entry.content.title, entry);
    }
  }

  const medicationEntries: Entry[] = [];
  for (const med of activeMeds) {
    const content = getMedicationEducation(med.name);
    if (content) {
      medicationEntries.push({
        key: `med-${titleKey(content.title)}`,
        anchor: med.name,
        content,
      });
    }
  }
  const medicationByTitle = new Map<string, Entry>();
  for (const entry of medicationEntries) {
    if (!medicationByTitle.has(entry.content.title)) {
      medicationByTitle.set(entry.content.title, entry);
    }
  }

  const conditionCards = Array.from(diagnosisByTitle.values());
  const medicationCards = Array.from(medicationByTitle.values());

  const hasCoveredDiagnoses = conditionCards.length > 0;
  const hasCoveredMeds = medicationCards.length > 0;
  const hasAnyData = activeDiagnoses.length > 0 || activeMeds.length > 0;

  return (
    <div style={{ maxWidth: 900, margin: "0 auto" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: "1.5rem",
        }}
      >
        <h2 style={{ margin: 0 }}>Health Info for You</h2>
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

      <p style={{ color: "#bbb", fontSize: "0.9rem", marginBottom: "1rem" }}>
        These cards are written in plain language to help you understand the
        conditions and medications on your chart. They are not a replacement
        for talking to your care team about anything specific.
      </p>

      {isUnlinked && (
        <p role="alert" style={{ color: "#ef4444" }}>
          Your account is not linked to a patient record. Please contact your
          care team.
        </p>
      )}

      {patientLoading && <p style={{ color: "#999" }}>Loading your record…</p>}

      {/* Conditions */}
      <section style={{ marginTop: "1.5rem" }}>
        <h3
          style={{
            fontSize: "1rem",
            marginBottom: "0.75rem",
            borderBottom: "1px solid #2a2a2a",
            paddingBottom: "0.5rem",
          }}
        >
          About Your Conditions ({conditionCards.length})
        </h3>
        {diagnosesQuery.isLoading ? (
          <p style={{ color: "#999" }}>Loading your conditions…</p>
        ) : !hasCoveredDiagnoses ? (
          <p style={{ color: "#999", fontSize: "0.85rem" }}>
            {activeDiagnoses.length === 0
              ? "No active conditions on file."
              : "No patient-friendly summaries are available yet for your current conditions. Ask your care team for printed materials."}
          </p>
        ) : (
          conditionCards.map((entry) => (
            <EducationCard
              key={entry.key}
              content={entry.content}
              anchor={entry.anchor}
            />
          ))
        )}
      </section>

      {/* Medications */}
      <section style={{ marginTop: "2rem" }}>
        <h3
          style={{
            fontSize: "1rem",
            marginBottom: "0.75rem",
            borderBottom: "1px solid #2a2a2a",
            paddingBottom: "0.5rem",
          }}
        >
          About Your Medications ({medicationCards.length})
        </h3>
        {medicationsQuery.isLoading ? (
          <p style={{ color: "#999" }}>Loading your medications…</p>
        ) : !hasCoveredMeds ? (
          <p style={{ color: "#999", fontSize: "0.85rem" }}>
            {activeMeds.length === 0
              ? "No active medications on file."
              : "No patient-friendly summaries are available yet for your current medications. Your pharmacy prescription sheet is the next best source."}
          </p>
        ) : (
          medicationCards.map((entry) => (
            <EducationCard
              key={entry.key}
              content={entry.content}
              anchor={entry.anchor}
            />
          ))
        )}
      </section>

      {!hasAnyData && !patientLoading && !diagnosesQuery.isLoading && !medicationsQuery.isLoading && (
        <p style={{ color: "#999", marginTop: "2rem", fontSize: "0.85rem" }}>
          When your care team adds conditions or medications to your chart, you
          will see a card for each one here.
        </p>
      )}
    </div>
  );
}

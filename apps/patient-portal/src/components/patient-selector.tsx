"use client";

import { useActivePatient } from "@/lib/active-patient";

/**
 * Dropdown that lets a multi-patient caregiver switch which patient's
 * records they are viewing.
 *
 * Hidden when the user can only view a single patient (a patient account, or
 * a caregiver with exactly one linked patient) — the selector would be noise
 * in that common case.
 */
export function PatientSelector() {
  const { patients, activePatient, setActivePatientId, isMultiPatient } =
    useActivePatient();

  if (!isMultiPatient || !activePatient) return null;

  return (
    <div
      data-testid="patient-selector"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        marginBottom: "1rem",
      }}
    >
      <label
        htmlFor="active-patient"
        style={{ fontSize: "0.8rem", color: "#999" }}
      >
        Viewing:
      </label>
      <select
        id="active-patient"
        value={activePatient.id}
        onChange={(e) => setActivePatientId(e.target.value)}
        style={{
          backgroundColor: "#1a1a1a",
          color: "#ededed",
          border: "1px solid #2a2a2a",
          borderRadius: 6,
          padding: "0.4rem 0.6rem",
          fontSize: "0.875rem",
        }}
      >
        {patients.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
            {p.mrn ? ` (${p.mrn})` : ""}
          </option>
        ))}
      </select>
    </div>
  );
}

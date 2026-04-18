"use client";

import { useActivePatient } from "@/lib/active-patient";

/**
 * Banner rendered at the top of the portal whenever the signed-in user is
 * viewing another person's chart (i.e. a family_caregiver with an active
 * relationship, as opposed to a patient viewing themselves).
 *
 * Plain text — no icons / emojis — so screen readers announce it cleanly.
 * `role="status"` + `aria-live="polite"` makes selection changes audible
 * without interrupting the user mid-task.
 */
export function CaregiverIndicator() {
  const { activePatient, isViewingAsCaregiver } = useActivePatient();

  if (!isViewingAsCaregiver || !activePatient) return null;

  const relationshipLabel = humanizeRelationship(activePatient.relationship);

  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="caregiver-indicator"
      style={{
        backgroundColor: "#1e3a8a",
        border: "1px solid #3b82f6",
        color: "#bfdbfe",
        padding: "0.75rem 1rem",
        borderRadius: 8,
        marginBottom: "1rem",
        fontSize: "0.875rem",
      }}
    >
      <strong style={{ color: "#dbeafe" }}>
        Viewing as {relationshipLabel} for {activePatient.name}.
      </strong>{" "}
      You have read-only access to this patient&apos;s record. Symptom entries
      and clinical updates must be submitted by the patient.
    </div>
  );
}

/**
 * Turn a `family_relationships.relationship_type` value into something
 * readable. Exposed as a pure helper for unit tests.
 */
export function humanizeRelationship(relationship: string): string {
  switch (relationship) {
    case "spouse":
      return "spouse";
    case "parent":
      return "parent";
    case "child":
      return "child";
    case "sibling":
      return "sibling";
    case "healthcare_poa":
      return "healthcare proxy";
    case "other":
    case "caregiver":
      return "caregiver";
    default:
      return "caregiver";
  }
}

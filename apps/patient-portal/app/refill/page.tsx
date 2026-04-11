"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import { useMyPatientRecord } from "@/lib/use-my-patient";

export default function RefillPage() {
  const { user } = useAuth();
  const router = useRouter();

  const { patient: myRecord, isLoading: patientLoading } = useMyPatientRecord();

  const medsQuery = trpc.clinicalData.medications.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const careTeamQuery = trpc.patients.careTeam.getByPatient.useQuery(
    { patientId: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const createConvoMutation = trpc.messaging.createConversation.useMutation();
  const sendMutation = trpc.messaging.sendMessage.useMutation();

  const [submittingMedId, setSubmittingMedId] = useState<string | null>(null);
  const [successMedId, setSuccessMedId] = useState<string | null>(null);
  const [note, setNote] = useState("");

  if (!user) {
    router.push("/login");
    return null;
  }

  const activeMeds = (medsQuery.data ?? []).filter((m) => m.status === "active");
  const careTeam = careTeamQuery.data ?? [];

  // Find the prescribing provider or primary care team member
  function findRecipient(prescribedBy?: string | null): string | null {
    if (prescribedBy) {
      const match = careTeam.find((m) => m.provider_id === prescribedBy);
      if (match) return match.provider_id;
    }
    // Fallback to first active care team member
    const primary = careTeam.find((m) => m.role === "primary");
    return primary?.provider_id ?? careTeam[0]?.provider_id ?? null;
  }

  async function handleRequestRefill(med: {
    id: string;
    name: string;
    dose_amount?: number | null;
    dose_unit?: string | null;
    frequency?: string | null;
    prescribed_by?: string | null;
  }) {
    if (!user || !myRecord) return;

    const recipientId = findRecipient(med.prescribed_by);
    if (!recipientId) return;

    setSubmittingMedId(med.id);

    try {
      const convo = await createConvoMutation.mutateAsync({
        patientId: myRecord.id,
        subject: `Refill Request: ${med.name}`,
        participantIds: [recipientId],
      });

      const body =
        `Medication Refill Request\n\n` +
        `Medication: ${med.name}\n` +
        `Dose: ${med.dose_amount ?? ""} ${med.dose_unit ?? ""}\n` +
        `Frequency: ${med.frequency ?? ""}\n` +
        (note ? `\nPatient Note: ${note}\n` : "") +
        `\nPlease approve or deny this refill request.`;

      await sendMutation.mutateAsync({
        conversationId: convo.id,
        body,
        messageType: "refill_request",
      });

      setSuccessMedId(med.id);
      setNote("");
      setTimeout(() => setSuccessMedId(null), 3000);
    } finally {
      setSubmittingMedId(null);
    }
  }

  return (
    <div style={{ maxWidth: 700, margin: "0 auto" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "1.5rem" }}>
        <h2 style={{ margin: 0 }}>Request Medication Refill</h2>
        <button
          onClick={() => router.push("/")}
          style={{ background: "none", border: "1px solid #444", color: "#999", padding: "0.5rem 1rem", borderRadius: 6, cursor: "pointer" }}
        >
          Back to Dashboard
        </button>
      </div>

      <p style={{ color: "#999", fontSize: "0.85rem", marginBottom: "1.5rem" }}>
        Select a medication to request a refill. Your prescribing provider will receive
        the request and can approve or deny it.
      </p>

      {medsQuery.isLoading && <p style={{ color: "#999" }}>Loading medications...</p>}

      {activeMeds.length === 0 && !medsQuery.isLoading && (
        <p style={{ color: "#999" }}>No active medications found.</p>
      )}

      {activeMeds.map((med) => (
        <div
          key={med.id}
          style={{
            backgroundColor: "#1a1a1a",
            border: "1px solid #2a2a2a",
            borderRadius: 8,
            padding: "1rem",
            marginBottom: "0.75rem",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.9rem" }}>{med.name}</div>
              <div style={{ fontSize: "0.8rem", color: "#999", marginTop: 2 }}>
                {med.dose_amount} {med.dose_unit} &middot; {med.frequency}
              </div>
            </div>

            {successMedId === med.id ? (
              <span style={{ color: "#22c55e", fontSize: "0.8rem", fontWeight: 600 }}>
                Refill requested!
              </span>
            ) : (
              <button
                onClick={() => handleRequestRefill(med)}
                disabled={submittingMedId === med.id}
                style={{
                  padding: "6px 14px",
                  backgroundColor: "#2563eb",
                  border: "none",
                  borderRadius: 6,
                  color: "#fff",
                  cursor: submittingMedId === med.id ? "wait" : "pointer",
                  fontSize: "0.8rem",
                  opacity: submittingMedId === med.id ? 0.6 : 1,
                }}
              >
                {submittingMedId === med.id ? "Requesting..." : "Request Refill"}
              </button>
            )}
          </div>
        </div>
      ))}

      {activeMeds.length > 0 && (
        <div style={{ marginTop: "1rem" }}>
          <label style={{ display: "block", marginBottom: 4, fontSize: "0.85rem", color: "#999" }}>
            Optional note for your provider
          </label>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="e.g., Running low, need refill by next week"
            style={{
              width: "100%",
              padding: "8px 12px",
              backgroundColor: "#222",
              border: "1px solid #444",
              borderRadius: 6,
              color: "#ededed",
              fontSize: "0.85rem",
            }}
          />
        </div>
      )}
    </div>
  );
}

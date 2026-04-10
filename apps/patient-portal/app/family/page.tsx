"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { trpc } from "@/lib/trpc";

const cardStyle = {
  backgroundColor: "#1a1a1a",
  border: "1px solid #2a2a2a",
  borderRadius: "8px",
  padding: "1.5rem",
} as const;

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

const labelStyle = {
  display: "block",
  fontSize: "0.75rem",
  color: "#999",
  marginBottom: 4,
} as const;

const primaryButtonStyle = (disabled: boolean) =>
  ({
    padding: "10px 20px",
    backgroundColor: "#3b82f6",
    color: "white",
    border: "none",
    borderRadius: "6px",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.7 : 1,
    fontSize: "0.875rem",
    fontWeight: 500,
  }) as const;

const RELATIONSHIP_OPTIONS = [
  { value: "spouse", label: "Spouse / Partner" },
  { value: "adult_child", label: "Adult Child" },
  { value: "parent", label: "Parent" },
  { value: "healthcare_poa", label: "Healthcare Power of Attorney" },
  { value: "other", label: "Other" },
] as const;

const SCOPE_OPTIONS = [
  { value: "view_summary", label: "View health summary" },
  { value: "view_appointments", label: "View appointments" },
  { value: "submit_checkins", label: "Submit check-ins on my behalf" },
  { value: "view_checkins_history", label: "View check-in history" },
  { value: "view_flags", label: "View care alerts" },
] as const;

export default function FamilyAccessPage() {
  const { isAuthenticated, user } = useAuth();
  const router = useRouter();

  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRelationship, setInviteRelationship] = useState("spouse");
  const [inviteScopes, setInviteScopes] = useState<string[]>([
    "view_summary",
    "view_appointments",
    "submit_checkins",
    "view_checkins_history",
    "view_flags",
  ]);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSuccess, setInviteSuccess] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      router.replace("/login");
    }
  }, [isAuthenticated, router]);

  const patientsQuery = trpc.patients.list.useQuery();
  const myRecord = patientsQuery.data?.find(
    (p) => p.name === user?.name,
  ) ?? patientsQuery.data?.[0];

  const relationshipsQuery = trpc.familyAccess.listRelationships.useQuery(
    { patient_id: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const pendingInvitesQuery = trpc.familyAccess.listPendingInvites.useQuery(
    { patient_id: myRecord?.id ?? "" },
    { enabled: !!myRecord },
  );

  const createInviteMutation = trpc.familyAccess.createInvite.useMutation();
  const revokeAccessMutation = trpc.familyAccess.revokeAccess.useMutation();
  const cancelInviteMutation = trpc.familyAccess.cancelInvite.useMutation();

  if (!isAuthenticated) {
    return (
      <main>
        <p style={{ color: "#999" }}>Redirecting to login...</p>
      </main>
    );
  }

  const relationships = relationshipsQuery.data ?? [];
  const pendingInvites = pendingInvitesQuery.data ?? [];

  function toggleScope(scope: string) {
    setInviteScopes((prev) =>
      prev.includes(scope)
        ? prev.filter((s) => s !== scope)
        : [...prev, scope],
    );
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setInviteError(null);
    setInviteSuccess(false);

    if (!myRecord) {
      setInviteError("No patient record found.");
      return;
    }

    if (inviteScopes.length === 0) {
      setInviteError("Select at least one access scope.");
      return;
    }

    try {
      await createInviteMutation.mutateAsync({
        patient_id: myRecord.id,
        invitee_email: inviteEmail,
        relationship: inviteRelationship as "spouse" | "adult_child" | "parent" | "healthcare_poa" | "other",
        access_scopes: inviteScopes as ("view_summary" | "view_appointments" | "submit_checkins" | "view_checkins_history" | "view_flags")[],
      });
      setInviteSuccess(true);
      setInviteEmail("");
      setShowInviteForm(false);
      pendingInvitesQuery.refetch();
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : "Failed to send invite.";
      setInviteError(message);
    }
  }

  async function handleRevoke(relationshipId: string) {
    try {
      await revokeAccessMutation.mutateAsync({ relationship_id: relationshipId });
      relationshipsQuery.refetch();
    } catch {
      // silently handled — UI reflects stale state until refetch
    }
  }

  async function handleCancelInvite(inviteId: string) {
    try {
      await cancelInviteMutation.mutateAsync({ invite_id: inviteId });
      pendingInvitesQuery.refetch();
    } catch {
      // silently handled
    }
  }

  return (
    <main>
      <div style={{ marginBottom: "1.5rem" }}>
        <Link
          href="/"
          style={{ color: "#999", fontSize: "0.8rem", textDecoration: "none" }}
        >
          &larr; Dashboard
        </Link>
        <h2 style={{ fontSize: "1.25rem", margin: "0.5rem 0 0" }}>
          Family & Caregiver Access
        </h2>
        <p style={{ color: "#999", fontSize: "0.8rem", margin: "0.25rem 0 0" }}>
          Invite family members or caregivers to view your health information
          and submit check-ins on your behalf.
        </p>
      </div>

      {inviteSuccess && (
        <div
          style={{
            backgroundColor: "#052e16",
            border: "1px solid #166534",
            borderRadius: "6px",
            padding: "12px 16px",
            fontSize: "0.875rem",
            color: "#86efac",
            marginBottom: "1rem",
          }}
        >
          Invitation sent successfully. Your family member will receive an email
          with instructions to set up their account.
        </div>
      )}

      {/* Active relationships */}
      <section style={{ marginBottom: "2rem" }}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <h3 style={{ fontSize: "1rem", margin: 0 }}>
            Active Caregivers
          </h3>
          <button
            onClick={() => {
              setShowInviteForm(!showInviteForm);
              setInviteError(null);
              setInviteSuccess(false);
            }}
            style={{
              padding: "6px 14px",
              backgroundColor: showInviteForm ? "transparent" : "#3b82f6",
              border: showInviteForm ? "1px solid #2a2a2a" : "none",
              borderRadius: "6px",
              color: showInviteForm ? "#999" : "white",
              cursor: "pointer",
              fontSize: "0.8rem",
            }}
          >
            {showInviteForm ? "Cancel" : "Invite Caregiver"}
          </button>
        </div>

        {showInviteForm && (
          <div style={{ ...cardStyle, marginBottom: "1rem" }}>
            <h4 style={{ fontSize: "0.9rem", margin: "0 0 1rem" }}>
              Send an Invitation
            </h4>
            <form onSubmit={handleInvite}>
              <div style={{ marginBottom: "1rem" }}>
                <label htmlFor="invitee-email" style={labelStyle}>
                  Email Address
                </label>
                <input
                  id="invitee-email"
                  type="email"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  required
                  placeholder="family@example.com"
                  style={inputStyle}
                />
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label htmlFor="relationship" style={labelStyle}>
                  Relationship
                </label>
                <select
                  id="relationship"
                  value={inviteRelationship}
                  onChange={(e) => setInviteRelationship(e.target.value)}
                  style={{ ...inputStyle, appearance: "auto" as const }}
                >
                  {RELATIONSHIP_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>

              <div style={{ marginBottom: "1rem" }}>
                <label style={labelStyle}>Access Permissions</label>
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 6,
                  }}
                >
                  {SCOPE_OPTIONS.map((scope) => {
                    const checked = inviteScopes.includes(scope.value);
                    return (
                      <button
                        key={scope.value}
                        type="button"
                        onClick={() => toggleScope(scope.value)}
                        style={{
                          textAlign: "left",
                          padding: "8px 12px",
                          borderRadius: "6px",
                          border: "1px solid",
                          borderColor: checked ? "#3b82f6" : "#2a2a2a",
                          backgroundColor: checked ? "#1e3a5f" : "#111",
                          color: checked ? "#93c5fd" : "#ededed",
                          cursor: "pointer",
                          fontSize: "0.8rem",
                        }}
                      >
                        {checked ? "\u2611 " : "\u2610 "}{scope.label}
                      </button>
                    );
                  })}
                </div>
              </div>

              {inviteError && (
                <div
                  style={{
                    color: "#ef4444",
                    fontSize: "0.8rem",
                    marginBottom: 12,
                  }}
                >
                  {inviteError}
                </div>
              )}

              <button
                type="submit"
                disabled={createInviteMutation.isPending}
                style={primaryButtonStyle(createInviteMutation.isPending)}
              >
                {createInviteMutation.isPending
                  ? "Sending..."
                  : "Send Invitation"}
              </button>
            </form>
          </div>
        )}

        {relationshipsQuery.isLoading ? (
          <p style={{ color: "#999", fontSize: "0.875rem" }}>Loading...</p>
        ) : relationships.length === 0 ? (
          <p style={{ color: "#999", fontSize: "0.875rem" }}>
            No active caregivers. Use the button above to invite a family member.
          </p>
        ) : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            {relationships.map((rel) => (
              <div key={rel.id} style={cardStyle}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "flex-start",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "0.875rem", fontWeight: 500 }}>
                      {rel.family_user_name}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "#999" }}>
                      {rel.family_user_email} &middot;{" "}
                      {RELATIONSHIP_OPTIONS.find(
                        (o) => o.value === rel.relationship,
                      )?.label ?? rel.relationship}
                    </div>
                    <div
                      style={{
                        fontSize: "0.7rem",
                        color: "#666",
                        marginTop: 4,
                      }}
                    >
                      Access:{" "}
                      {rel.access_scopes
                        .map(
                          (s) =>
                            SCOPE_OPTIONS.find((o) => o.value === s)?.label ?? s,
                        )
                        .join(", ")}
                    </div>
                  </div>
                  <button
                    onClick={() => handleRevoke(rel.id)}
                    disabled={revokeAccessMutation.isPending}
                    style={{
                      padding: "4px 10px",
                      backgroundColor: "transparent",
                      border: "1px solid #7f1d1d",
                      borderRadius: "4px",
                      color: "#fca5a5",
                      cursor: "pointer",
                      fontSize: "0.75rem",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Revoke
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Pending invites */}
      {pendingInvites.length > 0 && (
        <section>
          <h3 style={{ fontSize: "1rem", marginBottom: "0.75rem" }}>
            Pending Invitations
          </h3>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            {pendingInvites.map((inv) => (
              <div key={inv.id} style={cardStyle}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                  }}
                >
                  <div>
                    <div style={{ fontSize: "0.875rem" }}>
                      {inv.invitee_email}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: "#999" }}>
                      {RELATIONSHIP_OPTIONS.find(
                        (o) => o.value === inv.relationship,
                      )?.label ?? inv.relationship}{" "}
                      &middot; expires{" "}
                      {new Date(inv.expires_at).toLocaleDateString()}
                    </div>
                  </div>
                  <button
                    onClick={() => handleCancelInvite(inv.id)}
                    disabled={cancelInviteMutation.isPending}
                    style={{
                      padding: "4px 10px",
                      backgroundColor: "transparent",
                      border: "1px solid #2a2a2a",
                      borderRadius: "4px",
                      color: "#999",
                      cursor: "pointer",
                      fontSize: "0.75rem",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

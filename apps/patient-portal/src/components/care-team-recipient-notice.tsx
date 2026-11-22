import type { CareTeamRecipientStatus } from "@/lib/use-care-team-recipients";

type Props = {
  status: CareTeamRecipientStatus;
  onRetry: () => void;
};

export function CareTeamRecipientNotice({ status, onRetry }: Props) {
  if (status === "loading") {
    return <p role="status" style={{ color: "#999", fontSize: "0.85rem" }}>Loading your care team...</p>;
  }

  if (status === "error") {
    return (
      <div style={{ marginBottom: "1rem", fontSize: "0.85rem" }}>
        <p role="alert" style={{ color: "#fca5a5", margin: "0 0 0.5rem" }}>
          We couldn’t load your care team.
        </p>
        <button
          type="button"
          onClick={() => onRetry()}
          style={{
            backgroundColor: "#222",
            border: "1px solid #555",
            borderRadius: 6,
            color: "#ededed",
            cursor: "pointer",
            padding: "6px 12px",
          }}
        >
          Try Again
        </button>
      </div>
    );
  }

  if (status === "empty") {
    return (
      <p role="status" style={{ color: "#999", fontSize: "0.85rem" }}>
        No care team members are available to message. Please contact your care team directly.
      </p>
    );
  }

  return null;
}

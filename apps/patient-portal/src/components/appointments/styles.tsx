/** Shared inline styles for the appointments UI. Keeps component files lean. */

export const modalOverlay: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.6)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

export const modalCard: React.CSSProperties = {
  backgroundColor: "#111",
  border: "1px solid #2a2a2a",
  borderRadius: 10,
  padding: "1.5rem",
  width: "min(560px, 94vw)",
  maxHeight: "90vh",
  overflowY: "auto",
};

export const btnPrimary = (enabled: boolean): React.CSSProperties => ({
  padding: "8px 16px",
  backgroundColor: enabled ? "#2563eb" : "#333",
  border: "none",
  borderRadius: 6,
  color: enabled ? "#fff" : "#666",
  cursor: enabled ? "pointer" : "not-allowed",
  fontSize: "0.85rem",
});

export const btnGhost: React.CSSProperties = {
  padding: "8px 16px",
  backgroundColor: "transparent",
  border: "1px solid #444",
  borderRadius: 6,
  color: "#ededed",
  cursor: "pointer",
  fontSize: "0.85rem",
};

export const btnRowSmall: React.CSSProperties = {
  padding: "6px 12px",
  backgroundColor: "transparent",
  border: "1px solid #444",
  borderRadius: 6,
  color: "#ededed",
  cursor: "pointer",
  fontSize: "0.8rem",
};

export const inputBase: React.CSSProperties = {
  padding: "8px 12px",
  backgroundColor: "#222",
  border: "1px solid #444",
  borderRadius: 6,
  color: "#ededed",
  fontSize: "0.9rem",
  boxSizing: "border-box",
};

export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
      <dt style={{ color: "#999" }}>{label}</dt>
      <dd style={{ margin: 0, textAlign: "right" }}>{value}</dd>
    </div>
  );
}

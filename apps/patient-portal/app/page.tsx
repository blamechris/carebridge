export default function PatientHome() {
  return (
    <main>
      <h2 style={{ fontSize: "1.25rem", marginBottom: "1.5rem" }}>Welcome back</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(250px, 1fr))", gap: "1rem" }}>
        <Card title="My Records" description="View your medical records, lab results, and vitals" />
        <Card title="Messages" description="Communicate with your care team" />
        <Card title="Appointments" description="View upcoming appointments" />
        <Card title="Medications" description="View your active prescriptions" />
      </div>
      <p style={{ marginTop: "2rem", color: "#999", fontSize: "0.875rem" }}>
        Full patient portal features coming soon. Use MedLens mobile app for photo capture and tracking.
      </p>
    </main>
  );
}

function Card({ title, description }: { title: string; description: string }) {
  return (
    <div style={{
      backgroundColor: "#1a1a1a",
      border: "1px solid #2a2a2a",
      borderRadius: "8px",
      padding: "1.5rem",
    }}>
      <h3 style={{ margin: "0 0 0.5rem", fontSize: "1rem" }}>{title}</h3>
      <p style={{ margin: 0, color: "#999", fontSize: "0.875rem" }}>{description}</p>
    </div>
  );
}

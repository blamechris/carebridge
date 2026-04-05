const recentFlags = [
  {
    id: "1",
    severity: "critical" as const,
    patient: "Maria Santos",
    summary: "Critical lab result: Potassium 6.2 mEq/L",
    suggestion: "Recommend STAT ECG and urgent potassium correction protocol",
    time: "12 min ago",
  },
  {
    id: "2",
    severity: "warning" as const,
    patient: "James Thompson",
    summary: "Medication interaction detected: Warfarin + new Amiodarone order",
    suggestion:
      "Consider reducing Warfarin dose by 30-50% and check INR in 3 days",
    time: "34 min ago",
  },
  {
    id: "3",
    severity: "info" as const,
    patient: "Aisha Johnson",
    summary: "HbA1c trending up: 7.1% -> 7.8% over 6 months",
    suggestion:
      "Consider medication adjustment or endocrinology referral at next visit",
    time: "1 hr ago",
  },
  {
    id: "4",
    severity: "warning" as const,
    patient: "Robert Kim",
    summary: "Missed follow-up: Post-discharge cardiology appointment overdue",
    suggestion:
      "Patient discharged 14 days ago, no cardiology follow-up scheduled",
    time: "2 hr ago",
  },
];

function severityClass(severity: string) {
  switch (severity) {
    case "critical":
      return "badge-critical";
    case "warning":
      return "badge-warning";
    case "info":
      return "badge-info";
    default:
      return "badge-info";
  }
}

export default function DashboardPage() {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Good morning, Dr. Patel</h1>
        <p className="page-subtitle">
          Here is your clinical overview for today.
        </p>
      </div>

      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-label">Open AI Flags</span>
          <span className="stat-value critical">3</span>
          <span className="stat-detail">1 critical, 2 warnings</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Patients Seen Today</span>
          <span className="stat-value info">7</span>
          <span className="stat-detail">of 14 scheduled</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Unsigned Notes</span>
          <span className="stat-value warning">4</span>
          <span className="stat-detail">oldest from 2 days ago</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Pending Orders</span>
          <span className="stat-value" style={{ color: "var(--text-primary)" }}>
            2
          </span>
          <span className="stat-detail">awaiting co-signature</span>
        </div>
      </div>

      <div className="table-container">
        <div className="table-header">
          <span className="table-title">Recent AI Flags</span>
          <a href="/inbox" className="btn btn-ghost btn-sm">
            View All
          </a>
        </div>
        <div className="flag-list">
          {recentFlags.map((flag) => (
            <div key={flag.id} className="flag-item">
              <div className="flag-severity">
                <span className={`badge ${severityClass(flag.severity)}`}>
                  {flag.severity.toUpperCase()}
                </span>
              </div>
              <div className="flag-content">
                <div className="flag-patient">{flag.patient}</div>
                <div className="flag-summary">{flag.summary}</div>
                <div className="flag-suggestion">{flag.suggestion}</div>
                <div className="flag-time">{flag.time}</div>
              </div>
              <div className="flag-actions">
                <button className="btn btn-ghost btn-sm">Review</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

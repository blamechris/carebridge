"use client";

import { useParams, useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";

const tabs = [
  { key: "overview", label: "Overview" },
  { key: "notes", label: "Notes" },
  { key: "labs", label: "Labs" },
  { key: "vitals", label: "Vitals" },
  { key: "medications", label: "Medications" },
  { key: "flags", label: "AI Flags" },
];

// Placeholder patient data keyed by ID
const patientData: Record<
  string,
  {
    name: string;
    mrn: string;
    dob: string;
    age: number;
    sex: string;
    diagnoses: string[];
    allergies: string[];
    careTeam: { role: string; name: string }[];
    flags: {
      severity: string;
      summary: string;
      suggestion: string;
      time: string;
    }[];
    vitals: { label: string; value: string; trend?: string }[];
    medications: { name: string; dose: string; status: string }[];
  }
> = {
  "pt-001": {
    name: "Maria Santos",
    mrn: "MRN-2847103",
    dob: "1958-03-14",
    age: 68,
    sex: "Female",
    diagnoses: [
      "Type 2 Diabetes Mellitus (E11.9)",
      "Essential Hypertension (I10)",
      "Chronic Kidney Disease, Stage 3 (N18.3)",
    ],
    allergies: ["Penicillin (rash)", "Sulfa drugs (anaphylaxis)"],
    careTeam: [
      { role: "PCP", name: "Dr. Sarah Patel" },
      { role: "Endocrinology", name: "Dr. Alan Chen" },
      { role: "Nephrology", name: "Dr. Priya Nair" },
      { role: "RN Care Manager", name: "Lisa Rodriguez, RN" },
    ],
    flags: [
      {
        severity: "critical",
        summary: "Critical lab result: Potassium 6.2 mEq/L",
        suggestion:
          "Recommend STAT ECG and urgent potassium correction protocol",
        time: "12 min ago",
      },
    ],
    vitals: [
      { label: "Blood Pressure", value: "148/92 mmHg", trend: "up" },
      { label: "Heart Rate", value: "78 bpm" },
      { label: "Temperature", value: "98.4 F" },
      { label: "SpO2", value: "97%" },
      { label: "Weight", value: "82.1 kg", trend: "up" },
      { label: "BMI", value: "31.2" },
    ],
    medications: [
      { name: "Metformin 1000mg", dose: "BID", status: "Active" },
      { name: "Lisinopril 20mg", dose: "Daily", status: "Active" },
      { name: "Amlodipine 10mg", dose: "Daily", status: "Active" },
      { name: "Atorvastatin 40mg", dose: "QHS", status: "Active" },
      { name: "Insulin Glargine 24u", dose: "QHS", status: "Active" },
      { name: "Glyburide 5mg", dose: "BID", status: "Discontinued" },
    ],
  },
};

// Fallback for unknown IDs
const defaultPatient = {
  name: "Unknown Patient",
  mrn: "MRN-0000000",
  dob: "N/A",
  age: 0,
  sex: "Unknown",
  diagnoses: [],
  allergies: [],
  careTeam: [],
  flags: [],
  vitals: [],
  medications: [],
};

function OverviewTab({
  patient,
}: {
  patient: (typeof patientData)[string];
}) {
  return (
    <div className="detail-grid">
      <div className="detail-card">
        <div className="detail-card-title">Demographics</div>
        <div className="detail-row">
          <span className="detail-label">Date of Birth</span>
          <span className="detail-value">{patient.dob}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Age</span>
          <span className="detail-value">{patient.age}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">Sex</span>
          <span className="detail-value">{patient.sex}</span>
        </div>
        <div className="detail-row">
          <span className="detail-label">MRN</span>
          <span className="detail-value" style={{ fontFamily: "monospace" }}>
            {patient.mrn}
          </span>
        </div>
      </div>

      <div className="detail-card">
        <div className="detail-card-title">Active Diagnoses</div>
        {patient.diagnoses.length > 0 ? (
          patient.diagnoses.map((dx, i) => (
            <div key={i} className="list-item">
              {dx}
            </div>
          ))
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            No active diagnoses
          </div>
        )}
      </div>

      <div className="detail-card">
        <div className="detail-card-title">Allergies</div>
        {patient.allergies.length > 0 ? (
          patient.allergies.map((allergy, i) => (
            <div
              key={i}
              className="list-item"
              style={{ color: "var(--critical)" }}
            >
              {allergy}
            </div>
          ))
        ) : (
          <div style={{ color: "var(--success)", fontSize: 13 }}>NKDA</div>
        )}
      </div>

      <div className="detail-card">
        <div className="detail-card-title">Care Team</div>
        {patient.careTeam.map((member, i) => (
          <div key={i} className="detail-row">
            <span className="detail-label">{member.role}</span>
            <span className="detail-value">{member.name}</span>
          </div>
        ))}
      </div>

      {patient.flags.length > 0 && (
        <div
          className="detail-card"
          style={{ gridColumn: "1 / -1" }}
        >
          <div className="detail-card-title">Open AI Flags</div>
          <div className="flag-list">
            {patient.flags.map((flag, i) => (
              <div key={i} className="flag-item" style={{ padding: "12px 0" }}>
                <div className="flag-severity">
                  <span
                    className={`badge badge-${flag.severity}`}
                  >
                    {flag.severity.toUpperCase()}
                  </span>
                </div>
                <div className="flag-content">
                  <div className="flag-summary">{flag.summary}</div>
                  <div className="flag-suggestion">{flag.suggestion}</div>
                  <div className="flag-time">{flag.time}</div>
                </div>
                <div className="flag-actions">
                  <button className="btn btn-success btn-sm">Acknowledge</button>
                  <button className="btn btn-ghost btn-sm">Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function NotesTab() {
  const notes = [
    {
      date: "2026-04-04",
      type: "Progress Note",
      author: "Dr. Sarah Patel",
      status: "Unsigned",
      snippet:
        "Patient presents for routine follow-up. Reports increased fatigue over past 2 weeks...",
    },
    {
      date: "2026-03-21",
      type: "Progress Note",
      author: "Dr. Sarah Patel",
      status: "Signed",
      snippet:
        "Diabetes management review. HbA1c 7.4%, up from 7.1%. Discussed dietary modifications...",
    },
    {
      date: "2026-03-07",
      type: "Telephone Encounter",
      author: "Lisa Rodriguez, RN",
      status: "Signed",
      snippet:
        "Patient called regarding medication side effects. Reports GI discomfort with Metformin...",
    },
  ];

  return (
    <div className="table-container">
      <div className="table-header">
        <span className="table-title">Clinical Notes</span>
        <button className="btn btn-primary btn-sm">New Note</button>
      </div>
      <table>
        <thead>
          <tr>
            <th>Date</th>
            <th>Type</th>
            <th>Author</th>
            <th>Status</th>
            <th>Summary</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((note, i) => (
            <tr key={i}>
              <td style={{ whiteSpace: "nowrap" }}>{note.date}</td>
              <td>{note.type}</td>
              <td>{note.author}</td>
              <td>
                <span
                  className={`badge ${
                    note.status === "Unsigned"
                      ? "badge-warning"
                      : "badge-success"
                  }`}
                >
                  {note.status}
                </span>
              </td>
              <td style={{ color: "var(--text-secondary)", maxWidth: 300 }}>
                {note.snippet}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LabsTab() {
  const labs = [
    {
      panel: "Basic Metabolic Panel",
      date: "2026-04-04",
      results: [
        { test: "Sodium", value: "139", unit: "mEq/L", range: "136-145", flag: "" },
        { test: "Potassium", value: "6.2", unit: "mEq/L", range: "3.5-5.0", flag: "critical" },
        { test: "Chloride", value: "101", unit: "mEq/L", range: "98-106", flag: "" },
        { test: "CO2", value: "21", unit: "mEq/L", range: "23-29", flag: "low" },
        { test: "BUN", value: "32", unit: "mg/dL", range: "7-20", flag: "high" },
        { test: "Creatinine", value: "1.8", unit: "mg/dL", range: "0.6-1.2", flag: "high" },
        { test: "Glucose", value: "187", unit: "mg/dL", range: "70-100", flag: "high" },
      ],
    },
    {
      panel: "HbA1c",
      date: "2026-03-21",
      results: [
        { test: "HbA1c", value: "7.4", unit: "%", range: "<7.0", flag: "high" },
      ],
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {labs.map((panel, pi) => (
        <div key={pi} className="table-container">
          <div className="table-header">
            <span className="table-title">{panel.panel}</span>
            <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
              {panel.date}
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Test</th>
                <th>Result</th>
                <th>Unit</th>
                <th>Reference Range</th>
                <th>Flag</th>
              </tr>
            </thead>
            <tbody>
              {panel.results.map((r, ri) => (
                <tr key={ri}>
                  <td>{r.test}</td>
                  <td
                    style={{
                      fontWeight: 600,
                      color: r.flag === "critical"
                        ? "var(--critical)"
                        : r.flag === "high" || r.flag === "low"
                        ? "var(--warning)"
                        : "var(--text-primary)",
                    }}
                  >
                    {r.value}
                  </td>
                  <td style={{ color: "var(--text-secondary)" }}>{r.unit}</td>
                  <td style={{ color: "var(--text-secondary)" }}>{r.range}</td>
                  <td>
                    {r.flag && (
                      <span
                        className={`badge ${
                          r.flag === "critical"
                            ? "badge-critical"
                            : "badge-warning"
                        }`}
                      >
                        {r.flag.toUpperCase()}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function VitalsTab({
  vitals,
}: {
  vitals: { label: string; value: string; trend?: string }[];
}) {
  return (
    <div className="detail-grid">
      {vitals.map((vital, i) => (
        <div key={i} className="stat-card">
          <span className="stat-label">{vital.label}</span>
          <span
            className="stat-value"
            style={{
              fontSize: 24,
              color: "var(--text-primary)",
            }}
          >
            {vital.value}
            {vital.trend && (
              <span
                style={{
                  fontSize: 14,
                  marginLeft: 8,
                  color:
                    vital.trend === "up"
                      ? "var(--warning)"
                      : "var(--success)",
                }}
              >
                {vital.trend === "up" ? "\u2191" : "\u2193"}
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

function MedicationsTab({
  medications,
}: {
  medications: { name: string; dose: string; status: string }[];
}) {
  const active = medications.filter((m) => m.status === "Active");
  const discontinued = medications.filter((m) => m.status === "Discontinued");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="table-container">
        <div className="table-header">
          <span className="table-title">Active Medications</span>
          <button className="btn btn-primary btn-sm">New Order</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>Medication</th>
              <th>Frequency</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {active.map((med, i) => (
              <tr key={i}>
                <td style={{ fontWeight: 500 }}>{med.name}</td>
                <td style={{ color: "var(--text-secondary)" }}>{med.dose}</td>
                <td>
                  <span className="badge badge-success">{med.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {discontinued.length > 0 && (
        <div className="table-container">
          <div className="table-header">
            <span className="table-title" style={{ color: "var(--text-muted)" }}>
              Discontinued Medications
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Medication</th>
                <th>Frequency</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {discontinued.map((med, i) => (
                <tr key={i}>
                  <td style={{ color: "var(--text-muted)" }}>{med.name}</td>
                  <td style={{ color: "var(--text-muted)" }}>{med.dose}</td>
                  <td>
                    <span
                      className="badge"
                      style={{
                        background: "rgba(255,255,255,0.05)",
                        color: "var(--text-muted)",
                        border: "1px solid var(--border)",
                      }}
                    >
                      {med.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FlagsTab({
  flags,
}: {
  flags: {
    severity: string;
    summary: string;
    suggestion: string;
    time: string;
  }[];
}) {
  if (flags.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">{"\u2713"}</div>
        <div className="empty-state-text">
          No open AI flags for this patient
        </div>
      </div>
    );
  }

  return (
    <div className="table-container">
      <div className="table-header">
        <span className="table-title">AI Flags</span>
      </div>
      <div className="flag-list">
        {flags.map((flag, i) => (
          <div key={i} className="flag-item">
            <div className="flag-severity">
              <span className={`badge badge-${flag.severity}`}>
                {flag.severity.toUpperCase()}
              </span>
            </div>
            <div className="flag-content">
              <div className="flag-summary">{flag.summary}</div>
              <div className="flag-suggestion">{flag.suggestion}</div>
              <div className="flag-time">{flag.time}</div>
            </div>
            <div className="flag-actions">
              <button className="btn btn-success btn-sm">Acknowledge</button>
              <button className="btn btn-danger btn-sm">Dismiss</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function PatientChartPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const patientId = params.id as string;
  const activeTab = searchParams.get("tab") || "overview";
  const patient = patientData[patientId] || defaultPatient;

  function setTab(tab: string) {
    const url = tab === "overview"
      ? `/patients/${patientId}`
      : `/patients/${patientId}?tab=${tab}`;
    router.push(url);
  }

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Link
          href="/patients"
          style={{ fontSize: 12, color: "var(--text-muted)" }}
        >
          &larr; Back to Patients
        </Link>
      </div>

      <div className="chart-header">
        <div className="chart-avatar">
          {patient.name
            .split(" ")
            .map((n) => n[0])
            .join("")}
        </div>
        <div>
          <div className="chart-patient-name">{patient.name}</div>
          <div className="chart-patient-meta">
            <span>{patient.mrn}</span>
            <span>DOB: {patient.dob}</span>
            <span>
              {patient.age}yo {patient.sex}
            </span>
            {patient.flags.length > 0 && (
              <span>
                <span className="badge badge-critical" style={{ marginLeft: 4 }}>
                  {patient.flags.length} Flag{patient.flags.length > 1 ? "s" : ""}
                </span>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="tabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            className={`tab ${activeTab === tab.key ? "active" : ""}`}
            onClick={() => setTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === "overview" && <OverviewTab patient={patient} />}
      {activeTab === "notes" && <NotesTab />}
      {activeTab === "labs" && <LabsTab />}
      {activeTab === "vitals" && <VitalsTab vitals={patient.vitals} />}
      {activeTab === "medications" && (
        <MedicationsTab medications={patient.medications} />
      )}
      {activeTab === "flags" && <FlagsTab flags={patient.flags} />}
    </>
  );
}

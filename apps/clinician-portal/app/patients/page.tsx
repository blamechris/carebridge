import Link from "next/link";

const patients = [
  {
    id: "pt-001",
    name: "Maria Santos",
    mrn: "MRN-2847103",
    dob: "1958-03-14",
    diagnosis: "Type 2 Diabetes, Hypertension, CKD Stage 3",
    flags: 1,
  },
  {
    id: "pt-002",
    name: "James Thompson",
    mrn: "MRN-1930284",
    dob: "1945-11-22",
    diagnosis: "Atrial Fibrillation, CHF (NYHA II)",
    flags: 1,
  },
  {
    id: "pt-003",
    name: "Aisha Johnson",
    mrn: "MRN-3748291",
    dob: "1972-07-08",
    diagnosis: "Type 2 Diabetes, Obesity, GERD",
    flags: 1,
  },
  {
    id: "pt-004",
    name: "Robert Kim",
    mrn: "MRN-4829103",
    dob: "1967-01-30",
    diagnosis: "CAD s/p PCI, Hyperlipidemia",
    flags: 0,
  },
  {
    id: "pt-005",
    name: "Dorothy Williams",
    mrn: "MRN-2019384",
    dob: "1940-09-12",
    diagnosis: "COPD, Osteoporosis, Depression",
    flags: 0,
  },
  {
    id: "pt-006",
    name: "Carlos Rivera",
    mrn: "MRN-5738201",
    dob: "1981-05-19",
    diagnosis: "Asthma, Allergic Rhinitis",
    flags: 0,
  },
  {
    id: "pt-007",
    name: "Helen Park",
    mrn: "MRN-1028374",
    dob: "1955-12-03",
    diagnosis: "Rheumatoid Arthritis, Hypothyroidism",
    flags: 0,
  },
];

export default function PatientsPage() {
  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Patients</h1>
        <p className="page-subtitle">
          Your active patient panel ({patients.length} patients)
        </p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by name, MRN, or diagnosis..."
          className="search-input"
          style={{ maxWidth: 400 }}
        />
      </div>

      <div className="table-container">
        <table>
          <thead>
            <tr>
              <th>Patient Name</th>
              <th>MRN</th>
              <th>Date of Birth</th>
              <th>Primary Diagnoses</th>
              <th>Flags</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {patients.map((patient) => (
              <tr key={patient.id}>
                <td>
                  <Link
                    href={`/patients/${patient.id}`}
                    className="table-link"
                  >
                    {patient.name}
                  </Link>
                </td>
                <td style={{ color: "var(--text-secondary)", fontFamily: "monospace", fontSize: 12 }}>
                  {patient.mrn}
                </td>
                <td style={{ color: "var(--text-secondary)" }}>
                  {patient.dob}
                </td>
                <td>{patient.diagnosis}</td>
                <td>
                  {patient.flags > 0 ? (
                    <span className="badge badge-warning">
                      {patient.flags}
                    </span>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>&mdash;</span>
                  )}
                </td>
                <td>
                  <Link
                    href={`/patients/${patient.id}`}
                    className="btn btn-ghost btn-sm"
                  >
                    Open Chart
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

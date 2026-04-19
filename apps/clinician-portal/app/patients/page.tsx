"use client";

import Link from "next/link";
import { useState } from "react";
import { trpc } from "@/lib/trpc";
import { AuthGuard } from "@/lib/auth-guard";

function PatientsContent() {
  const [search, setSearch] = useState("");
  const patientsQuery = trpc.patients.list.useQuery();

  const patients = patientsQuery.data ?? [];
  const filtered = search
    ? patients.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          (p.mrn ?? "").toLowerCase().includes(search.toLowerCase()),
      )
    : patients;

  return (
    <>
      <div className="page-header">
        <h1 className="page-title">Patients</h1>
        <p className="page-subtitle">
          {patientsQuery.isLoading
            ? "Loading..."
            : `Your active patient panel (${patients.length} patients)`}
        </p>
      </div>

      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search by name or MRN..."
          aria-label="Search by patient name or MRN"
          className="search-input"
          style={{ maxWidth: 400 }}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {patientsQuery.isError ? (
        <div
          className="table-container"
          style={{ padding: 24, color: "var(--critical)" }}
        >
          Failed to load patients. Is the API running on localhost:4000?
        </div>
      ) : (
        <div className="table-container">
          <table>
            <thead>
              <tr>
                <th>Patient Name</th>
                <th>MRN</th>
                <th>Date of Birth</th>
                <th>Sex</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {patientsQuery.isLoading ? (
                <tr>
                  <td
                    colSpan={5}
                    style={{ color: "var(--text-muted)", textAlign: "center" }}
                  >
                    Loading patients...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    style={{ color: "var(--text-muted)", textAlign: "center" }}
                  >
                    {search
                      ? "No patients match your search."
                      : "No patients found. Run pnpm db:seed to populate dev data."}
                  </td>
                </tr>
              ) : (
                filtered.map((patient) => (
                  <tr key={patient.id}>
                    <td data-label="Patient Name">
                      <Link
                        href={`/patients/${patient.id}`}
                        className="table-link"
                      >
                        {patient.name}
                      </Link>
                    </td>
                    <td
                      data-label="MRN"
                      style={{
                        color: "var(--text-secondary)",
                        fontFamily: "monospace",
                        fontSize: 12,
                      }}
                    >
                      {patient.mrn}
                    </td>
                    <td
                      data-label="Date of Birth"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {patient.date_of_birth}
                    </td>
                    <td
                      data-label="Sex"
                      style={{ color: "var(--text-secondary)" }}
                    >
                      {patient.biological_sex}
                    </td>
                    <td data-label="Actions">
                      <Link
                        href={`/patients/${patient.id}`}
                        className="btn btn-ghost btn-sm"
                      >
                        Open Chart
                      </Link>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

export default function PatientsPage() {
  return (
    <AuthGuard>
      <PatientsContent />
    </AuthGuard>
  );
}

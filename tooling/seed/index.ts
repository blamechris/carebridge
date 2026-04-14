/**
 * CareBridge seed data — including the DVT/headache scenario patient
 * that validates the AI oversight engine end-to-end.
 *
 * Run: pnpm db:seed
 */

import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "@carebridge/db-schema";
import { hmacForIndex } from "@carebridge/db-schema";
import crypto from "node:crypto";

const connectionString = process.env.DATABASE_URL
  ?? "postgresql://carebridge:carebridge_dev@localhost:5432/carebridge";

const client = postgres(connectionString);
const db = drizzle(client, { schema });

function uuid() { return crypto.randomUUID(); }
function now() { return new Date().toISOString(); }
function daysAgo(n: number) { return new Date(Date.now() - n * 86400000).toISOString(); }

/**
 * Hash a password using scrypt — same parameters as services/auth/src/password.ts.
 * Duplicated here so the seed has no runtime dependency on the auth service.
 */
function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) return reject(err);
      resolve(`scrypt:${salt.toString("hex")}:${key.toString("hex")}`);
    });
  });
}

async function seed() {
  console.log("Seeding CareBridge database...");
  const devPasswordHash = await hashPassword("password123");

  // ─── Users (dev accounts) ───────────────────────────────────────
  const drSmith = uuid();
  const drJones = uuid();
  const nurseRachel = uuid();
  const patientUser = uuid();

  // Generate dvtPatientId early so the patient user can reference it.
  const dvtPatientId = uuid();

  await db.insert(schema.users).values([
    {
      id: drSmith,
      email: "dr.smith@carebridge.dev",
      password_hash: devPasswordHash,
      name: "Dr. Sarah Smith",
      role: "physician",
      specialty: "Hematology/Oncology",
      department: "Oncology",
      is_active: true,
      created_at: now(),
      updated_at: now(),
    },
    {
      id: drJones,
      email: "dr.jones@carebridge.dev",
      password_hash: devPasswordHash,
      name: "Dr. Michael Jones",
      role: "specialist",
      specialty: "Interventional Radiology",
      department: "Radiology",
      is_active: true,
      created_at: now(),
      updated_at: now(),
    },
    {
      id: nurseRachel,
      email: "nurse.rachel@carebridge.dev",
      password_hash: devPasswordHash,
      name: "Rachel Torres, RN",
      role: "nurse",
      department: "Oncology",
      is_active: true,
      created_at: now(),
      updated_at: now(),
    },
    {
      id: patientUser,
      email: "patient@carebridge.dev",
      password_hash: devPasswordHash,
      name: "Demo Patient",
      role: "patient",
      patient_id: dvtPatientId,
      is_active: true,
      created_at: now(),
      updated_at: now(),
    },
  ]).onConflictDoNothing();

  // ─── The DVT Scenario Patient ───────────────────────────────────

  await db.insert(schema.patients).values({
    id: dvtPatientId,
    name: "Margaret Chen",
    date_of_birth: "1958-03-15",
    biological_sex: "female",
    diagnosis: "Stage III Breast Cancer, DVT right lower extremity",
    notes: "Cancer-associated hypercoagulable state. IVC filter placed Feb 2026.",
    mrn: "MCH-2026-0042",
    mrn_hmac: hmacForIndex("MCH-2026-0042"),
    primary_provider_id: drSmith,
    created_at: daysAgo(90),
    updated_at: now(),
  });

  // Diagnoses
  await db.insert(schema.diagnoses).values([
    {
      id: uuid(), patient_id: dvtPatientId, icd10_code: "C50.911",
      description: "Malignant neoplasm of unspecified site of right female breast, Stage III",
      status: "active", onset_date: "2025-12-01", diagnosed_by: drSmith, created_at: daysAgo(90),
    },
    {
      id: uuid(), patient_id: dvtPatientId, icd10_code: "I82.401",
      description: "Deep vein thrombosis, right lower extremity",
      status: "active", onset_date: "2026-01-20", diagnosed_by: drSmith, created_at: daysAgo(75),
    },
    {
      id: uuid(), patient_id: dvtPatientId, icd10_code: "Z95.828",
      description: "Presence of IVC filter",
      status: "active", onset_date: "2026-02-15", diagnosed_by: drJones, created_at: daysAgo(50),
    },
  ]);

  // Allergies
  await db.insert(schema.allergies).values([
    { id: uuid(), patient_id: dvtPatientId, allergen: "Sulfa drugs", reaction: "Rash", severity: "moderate", created_at: daysAgo(90) },
  ]);

  // Care Team
  await db.insert(schema.careTeamMembers).values([
    { id: uuid(), patient_id: dvtPatientId, provider_id: drSmith, role: "primary", specialty: "Hematology/Oncology", is_active: true, started_at: daysAgo(90), created_at: daysAgo(90) },
    { id: uuid(), patient_id: dvtPatientId, provider_id: drJones, role: "specialist", specialty: "Interventional Radiology", is_active: true, started_at: daysAgo(50), created_at: daysAgo(50) },
    { id: uuid(), patient_id: dvtPatientId, provider_id: nurseRachel, role: "nurse", is_active: true, started_at: daysAgo(90), created_at: daysAgo(90) },
  ]);

  // Care Team Assignments (for RBAC access scoping)
  await db.insert(schema.careTeamAssignments).values([
    { id: uuid(), user_id: drSmith, patient_id: dvtPatientId, role: "attending", assigned_at: daysAgo(90) },
    { id: uuid(), user_id: drJones, patient_id: dvtPatientId, role: "consulting", assigned_at: daysAgo(50) },
    { id: uuid(), user_id: nurseRachel, patient_id: dvtPatientId, role: "nursing", assigned_at: daysAgo(90) },
  ]);

  // Medications
  await db.insert(schema.medications).values([
    {
      id: uuid(), patient_id: dvtPatientId, name: "Capecitabine", brand_name: "Xeloda",
      dose_amount: 1000, dose_unit: "mg", route: "oral", frequency: "twice daily",
      status: "active", started_at: daysAgo(80), prescribed_by: "Dr. Smith",
      ordering_provider_id: drSmith, source_system: "internal",
      created_at: daysAgo(80), updated_at: daysAgo(80),
    },
    {
      id: uuid(), patient_id: dvtPatientId, name: "Enoxaparin", brand_name: "Lovenox",
      dose_amount: 80, dose_unit: "mg", route: "subcutaneous", frequency: "every 12 hours",
      status: "active", started_at: daysAgo(75), prescribed_by: "Dr. Smith",
      ordering_provider_id: drSmith, source_system: "internal",
      created_at: daysAgo(75), updated_at: daysAgo(75),
    },
    {
      id: uuid(), patient_id: dvtPatientId, name: "Ondansetron", brand_name: "Zofran",
      dose_amount: 8, dose_unit: "mg", route: "oral", frequency: "every 8 hours PRN",
      status: "active", started_at: daysAgo(80), prescribed_by: "Dr. Smith",
      ordering_provider_id: drSmith, source_system: "internal",
      created_at: daysAgo(80), updated_at: daysAgo(80),
    },
  ]);

  // Vitals
  await db.insert(schema.vitals).values([
    { id: uuid(), patient_id: dvtPatientId, recorded_at: daysAgo(1), type: "blood_pressure", loinc_code: "85354-9", value_primary: 138, value_secondary: 85, unit: "mmHg", provider_id: nurseRachel, source_system: "internal", created_at: daysAgo(1) },
    { id: uuid(), patient_id: dvtPatientId, recorded_at: daysAgo(1), type: "heart_rate", loinc_code: "8867-4", value_primary: 88, unit: "bpm", provider_id: nurseRachel, source_system: "internal", created_at: daysAgo(1) },
    { id: uuid(), patient_id: dvtPatientId, recorded_at: daysAgo(1), type: "o2_sat", loinc_code: "59408-5", value_primary: 96, unit: "%", provider_id: nurseRachel, source_system: "internal", created_at: daysAgo(1) },
    { id: uuid(), patient_id: dvtPatientId, recorded_at: daysAgo(1), type: "temperature", loinc_code: "8310-5", value_primary: 98.4, unit: "°F", provider_id: nurseRachel, source_system: "internal", created_at: daysAgo(1) },
  ]);

  // Lab Panel — recent CBC showing some chemo effects
  const cbcPanelId = uuid();
  await db.insert(schema.labPanels).values({
    id: cbcPanelId, patient_id: dvtPatientId, panel_name: "CBC",
    ordered_by: "Dr. Smith", collected_at: daysAgo(3), reported_at: daysAgo(3),
    ordering_provider_id: drSmith, source_system: "internal", created_at: daysAgo(3),
  });
  await db.insert(schema.labResults).values([
    { id: uuid(), panel_id: cbcPanelId, test_name: "WBC", test_code: "6690-2", value: 3.8, unit: "K/uL", reference_low: 4.5, reference_high: 11.0, flag: "L", created_at: daysAgo(3) },
    { id: uuid(), panel_id: cbcPanelId, test_name: "Hemoglobin", test_code: "718-7", value: 10.2, unit: "g/dL", reference_low: 12.0, reference_high: 17.5, flag: "L", created_at: daysAgo(3) },
    { id: uuid(), panel_id: cbcPanelId, test_name: "Platelets", test_code: "777-3", value: 198, unit: "K/uL", reference_low: 150, reference_high: 400, created_at: daysAgo(3) },
    { id: uuid(), panel_id: cbcPanelId, test_name: "ANC", test_code: "751-8", value: 1.8, unit: "K/uL", reference_low: 1.5, reference_high: 8.0, created_at: daysAgo(3) },
  ]);

  // Coagulation panel
  const coagPanelId = uuid();
  await db.insert(schema.labPanels).values({
    id: coagPanelId, patient_id: dvtPatientId, panel_name: "Coagulation",
    ordered_by: "Dr. Smith", collected_at: daysAgo(3), reported_at: daysAgo(3),
    ordering_provider_id: drSmith, source_system: "internal", created_at: daysAgo(3),
  });
  await db.insert(schema.labResults).values([
    { id: uuid(), panel_id: coagPanelId, test_name: "D-Dimer", test_code: "48066-5", value: 680, unit: "ng/mL", reference_low: 0, reference_high: 500, flag: "H", created_at: daysAgo(3) },
    { id: uuid(), panel_id: coagPanelId, test_name: "PT", test_code: "5902-2", value: 12.1, unit: "sec", reference_low: 11, reference_high: 13.5, created_at: daysAgo(3) },
    { id: uuid(), panel_id: coagPanelId, test_name: "INR", test_code: "6301-6", value: 1.0, unit: "", reference_low: 0.8, reference_high: 1.2, created_at: daysAgo(3) },
  ]);

  // ─── Second patient (simpler, for list variety) ─────────────────
  const patient2Id = uuid();
  await db.insert(schema.patients).values({
    id: patient2Id,
    name: "Robert Williams",
    date_of_birth: "1972-08-22",
    biological_sex: "male",
    diagnosis: "Type 2 Diabetes, Hypertension",
    mrn: "RWL-2026-0108",
    mrn_hmac: hmacForIndex("RWL-2026-0108"),
    primary_provider_id: drSmith,
    created_at: daysAgo(60),
    updated_at: now(),
  });

  await db.insert(schema.diagnoses).values([
    { id: uuid(), patient_id: patient2Id, icd10_code: "E11.9", description: "Type 2 diabetes mellitus without complications", status: "active", onset_date: "2020-03-01", created_at: daysAgo(60) },
    { id: uuid(), patient_id: patient2Id, icd10_code: "I10", description: "Essential hypertension", status: "active", onset_date: "2019-06-01", created_at: daysAgo(60) },
  ]);

  // Care Team Assignments for Robert Williams
  await db.insert(schema.careTeamAssignments).values([
    { id: uuid(), user_id: drSmith, patient_id: patient2Id, role: "attending", assigned_at: daysAgo(60) },
  ]);

  await db.insert(schema.medications).values([
    { id: uuid(), patient_id: patient2Id, name: "Metformin", dose_amount: 500, dose_unit: "mg", route: "oral", frequency: "twice daily", status: "active", started_at: daysAgo(60), prescribed_by: "Dr. Smith", ordering_provider_id: drSmith, source_system: "internal", created_at: daysAgo(60), updated_at: daysAgo(60) },
    { id: uuid(), patient_id: patient2Id, name: "Lisinopril", dose_amount: 10, dose_unit: "mg", route: "oral", frequency: "once daily", status: "active", started_at: daysAgo(60), prescribed_by: "Dr. Smith", ordering_provider_id: drSmith, source_system: "internal", created_at: daysAgo(60), updated_at: daysAgo(60) },
  ]);

  // ─── Link patient users to patient records ──────────────────────
  await db.update(schema.users)
    .set({ patient_id: dvtPatientId })
    .where(eq(schema.users.id, patientUser));

  console.log("Seed complete.");
  console.log(`  DVT scenario patient: ${dvtPatientId} (Margaret Chen, MRN: MCH-2026-0042)`);
  console.log(`  Second patient: ${patient2Id} (Robert Williams)`);
  console.log(`  Dev users: dr.smith@carebridge.dev / dr.jones@carebridge.dev / nurse.rachel@carebridge.dev`);
  console.log("  Password for all dev accounts: password123");

  await client.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

/**
 * MedLens Integration Types
 *
 * MedLens is a local-first React Native app that captures hospital/home care data
 * via OCR from IV bags, lab reports, and vitals monitors. It stores data in SQLite
 * on-device and can optionally sync with CareBridge.
 *
 * Integration model:
 *   - Patient-authorized: a patient uses CareBridge to generate a sync token,
 *     then enters it in MedLens to link the apps.
 *   - MedLens PULLS data from CareBridge (hospital records populate the app)
 *   - MedLens PUSHES data to CareBridge (patient-captured readings enrich the record)
 *   - All MedLens-sourced data is tagged source: "medlens" in CareBridge
 *
 * Data flow:
 *   CareBridge → MedLens: medications, vitals, labs (what the hospital ordered/resulted)
 *   MedLens → CareBridge: vitals, labs, events (what the patient observed at home)
 *
 * Privacy note:
 *   - MedLens operates Tier 1 (local-only) by default
 *   - Sync is patient-opt-in
 *   - The sync token scopes access to a single patient's record
 */

// ─── Sync Token ───────────────────────────────────────────────────────────────

export interface MedLensSyncToken {
  token: string;
  patient_id: string;
  scopes: MedLensSyncScope[];
  expires_at: string; // ISO 8601
  created_at: string;
}

export type MedLensSyncScope =
  | "read:medications"
  | "read:vitals"
  | "read:labs"
  | "write:vitals"
  | "write:labs"
  | "write:events";

// ─── Export Format (CareBridge → MedLens) ────────────────────────────────────

/**
 * The data bundle CareBridge sends to MedLens on pull requests.
 * Shaped to match MedLens's SQLite schema directly.
 */
export interface MedLensExportBundle {
  export_timestamp: string;
  patient_id: string; // CareBridge internal ID (for re-sync)
  schema_version: "1.0";

  medications: MedLensMedication[];
  vitals: MedLensVital[];
  lab_panels: MedLensLabPanel[];
}

export interface MedLensMedication {
  carebridge_id: string;
  name: string;
  brand_name: string | null;
  dose_amount: number | null;
  dose_unit: string | null;
  route: string | null;
  frequency: string | null;
  status: "active" | "discontinued" | "completed";
  started_at: string | null;
  ended_at: string | null;
  prescribed_by: string | null;
  notes: string | null;
  source: "carebridge";
}

export interface MedLensVital {
  carebridge_id: string;
  recorded_at: string;
  type: string;
  value_primary: number;
  value_secondary: number | null;
  unit: string;
  notes: string | null;
  source: "carebridge";
}

export interface MedLensLabPanel {
  carebridge_id: string;
  panel_name: string;
  collected_at: string | null;
  reported_at: string | null;
  ordered_by: string | null;
  results: MedLensLabResult[];
  source: "carebridge";
}

export interface MedLensLabResult {
  carebridge_id: string;
  test_name: string;
  test_code: string | null; // LOINC if available
  value: number;
  unit: string;
  reference_low: number | null;
  reference_high: number | null;
  flag: "H" | "L" | "critical" | null;
}

// ─── Import Format (MedLens → CareBridge) ────────────────────────────────────

/**
 * Data bundle MedLens sends to CareBridge when pushing patient-captured readings.
 * These are observations captured at home or during hospital stays via OCR.
 */
export interface MedLensImportBundle {
  import_timestamp: string;
  medlens_patient_id: string; // MedLens local patient UUID
  schema_version: "1.0";

  vitals: MedLensImportVital[];
  lab_panels: MedLensImportLabPanel[];
  events: MedLensImportEvent[];
}

export interface MedLensImportVital {
  medlens_id: string;
  recorded_at: string;
  type: string;
  value_primary: number;
  value_secondary: number | null;
  unit: string;
  notes: string | null;
  extraction_tier: "local" | "api-text" | "api-vision";
  confidence: number; // 0-1
}

export interface MedLensImportLabPanel {
  medlens_id: string;
  panel_name: string;
  collected_at: string | null;
  results: MedLensImportLabResult[];
  extraction_tier: "local" | "api-text" | "api-vision";
}

export interface MedLensImportLabResult {
  medlens_id: string;
  test_name: string;
  value: number;
  unit: string;
  reference_low: number | null;
  reference_high: number | null;
  flag: "H" | "L" | "critical" | null;
  confidence: number;
}

export interface MedLensImportEvent {
  medlens_id: string;
  occurred_at: string;
  category: string;
  title: string;
  body: string | null;
  severity: "info" | "warning" | "urgent";
}

// ─── Import Result ────────────────────────────────────────────────────────────

export interface MedLensImportResult {
  accepted: number;
  skipped: number;
  skipped_reasons: string[];
  carebridge_ids: {
    vitals: string[];
    lab_panels: string[];
    events: string[];
  };
}

/**
 * MedLens Bridge — integration layer for the MedLens wearable/mobile health
 * data platform. Handles scoped token management, confidence-gated imports,
 * and data export for the patient-facing MedLens app.
 *
 * MedLens devices submit vitals and lab readings with a confidence score
 * (0.0–1.0) reflecting sensor certainty. We gate imports on minimum
 * confidence thresholds to prevent noisy data from entering clinical records.
 */

import crypto from "node:crypto";
import { vitalRepo, labRepo } from "@carebridge/clinical-data";
import type { CreateVitalInput, CreateLabPanelInput } from "@carebridge/validators";

type VitalType = CreateVitalInput["type"];

const VITAL_TYPES: readonly VitalType[] = [
  "blood_pressure",
  "heart_rate",
  "o2_sat",
  "temperature",
  "weight",
  "respiratory_rate",
  "pain_level",
  "blood_glucose",
] as const;

function isVitalType(t: string): t is VitalType {
  return (VITAL_TYPES as readonly string[]).includes(t);
}

// ─── Types ──────────────────────────────────────────────────────────

export type MedLensScope =
  | "read:vitals"
  | "write:vitals"
  | "read:medications"
  | "read:labs"
  | "write:labs";

export interface MedLensToken {
  token: string;
  patientId: string;
  scopes: MedLensScope[];
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

export interface MedLensVital {
  type: string;
  value: number;
  unit: string;
  confidence: number;
  recordedAt: string;
  deviceId: string;
}

export interface MedLensLabResult {
  testName: string;
  value: number;
  unit: string;
  confidence: number;
  collectedAt: string;
  deviceId: string;
}

export interface ImportResult {
  accepted: number;
  rejected: number;
  rejectionReasons: string[];
}

// ─── Confidence thresholds ──────────────────────────────────────────

const VITAL_CONFIDENCE_THRESHOLD = 0.6;
const LAB_CONFIDENCE_THRESHOLD = 0.5;

// ─── Token store (in-memory for dev; production uses DB) ────────────

const tokenStore = new Map<string, MedLensToken>();

/**
 * Create a scoped access token for MedLens integration.
 */
export function createMedLensToken(
  patientId: string,
  scopes: MedLensScope[],
  ttlHours: number = 24,
): MedLensToken {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlHours * 60 * 60 * 1000);

  const token: MedLensToken = {
    token: `ml_${crypto.randomBytes(24).toString("hex")}`,
    patientId,
    scopes,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    revoked: false,
  };

  tokenStore.set(token.token, token);
  return token;
}

/**
 * Validate a MedLens token and check for required scope.
 * Returns the token if valid, or null.
 */
export function validateToken(
  tokenStr: string,
  requiredScope?: MedLensScope,
): MedLensToken | null {
  const token = tokenStore.get(tokenStr);
  if (!token) return null;
  if (token.revoked) return null;

  const now = new Date();
  if (new Date(token.expiresAt) < now) return null;

  if (requiredScope && !token.scopes.includes(requiredScope)) {
    return null;
  }

  return token;
}

/**
 * Revoke a MedLens token.
 */
export function revokeToken(tokenStr: string): boolean {
  const token = tokenStore.get(tokenStr);
  if (!token) return false;
  token.revoked = true;
  return true;
}

/**
 * Export patient medications (requires read:medications scope).
 */
export function exportMedications(
  tokenStr: string,
): { ok: true; data: unknown[] } | { ok: false; error: string } {
  const token = validateToken(tokenStr, "read:medications");
  if (!token) {
    return { ok: false, error: "Invalid or unauthorized token" };
  }

  // Stub: in production, query from DB
  return { ok: true, data: [] };
}

/**
 * Import vitals from MedLens devices.
 * Rejects entries below the confidence threshold.
 */
export async function importVitals(
  tokenStr: string,
  vitals: MedLensVital[],
): Promise<{ ok: true; result: ImportResult } | { ok: false; error: string }> {
  const token = validateToken(tokenStr, "write:vitals");
  if (!token) {
    return { ok: false, error: "Invalid or unauthorized token" };
  }

  const result: ImportResult = {
    accepted: 0,
    rejected: 0,
    rejectionReasons: [],
  };

  for (const vital of vitals) {
    if (vital.confidence < VITAL_CONFIDENCE_THRESHOLD) {
      result.rejected++;
      result.rejectionReasons.push(
        `${vital.type}: confidence ${vital.confidence} below threshold ${VITAL_CONFIDENCE_THRESHOLD}`,
      );
      continue;
    }

    if (!isVitalType(vital.type)) {
      result.rejected++;
      result.rejectionReasons.push(
        `${vital.type}: unsupported vital type`,
      );
      continue;
    }

    try {
      await vitalRepo.createVital({
        patient_id: token.patientId,
        recorded_at: vital.recordedAt,
        type: vital.type,
        value_primary: vital.value,
        unit: vital.unit,
        notes: `MedLens device ${vital.deviceId} (confidence ${vital.confidence.toFixed(2)})`,
      });
      result.accepted++;
    } catch (err) {
      result.rejected++;
      result.rejectionReasons.push(
        `${vital.type}: persistence failed (${err instanceof Error ? err.message : "unknown error"})`,
      );
    }
  }

  return { ok: true, result };
}

/**
 * Import lab results from MedLens devices.
 * Rejects entries below the confidence threshold.
 */
export async function importLabs(
  tokenStr: string,
  labs: MedLensLabResult[],
): Promise<{ ok: true; result: ImportResult } | { ok: false; error: string }> {
  const token = validateToken(tokenStr, "write:labs");
  if (!token) {
    return { ok: false, error: "Invalid or unauthorized token" };
  }

  const result: ImportResult = {
    accepted: 0,
    rejected: 0,
    rejectionReasons: [],
  };

  for (const lab of labs) {
    if (lab.confidence < LAB_CONFIDENCE_THRESHOLD) {
      result.rejected++;
      result.rejectionReasons.push(
        `${lab.testName}: confidence ${lab.confidence} below threshold ${LAB_CONFIDENCE_THRESHOLD}`,
      );
      continue;
    }

    try {
      const panelInput: CreateLabPanelInput = {
        patient_id: token.patientId,
        panel_name: `MedLens: ${lab.testName}`,
        collected_at: lab.collectedAt,
        reported_at: lab.collectedAt,
        notes: `MedLens device ${lab.deviceId} (confidence ${lab.confidence.toFixed(2)})`,
        results: [
          {
            test_name: lab.testName,
            test_code: "00000-0",
            value: lab.value,
            unit: lab.unit,
          },
        ],
      };
      await labRepo.createLabPanel(panelInput);
      result.accepted++;
    } catch (err) {
      result.rejected++;
      result.rejectionReasons.push(
        `${lab.testName}: persistence failed (${err instanceof Error ? err.message : "unknown error"})`,
      );
    }
  }

  return { ok: true, result };
}

/**
 * Clear the in-memory token store (for testing).
 */
export function clearTokenStore(): void {
  tokenStore.clear();
}

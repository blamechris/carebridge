/**
 * Patient-contributed observations (Symptom Journal).
 *
 * These are patient-reported symptoms and observations that feed into the
 * AI oversight engine. They do NOT appear in the clinical chart directly —
 * they live in a separate "Patient Signals" section visible to providers.
 *
 * This is a KEY differentiator from Epic MyChart: patients can contribute
 * structured observations that the AI monitors for dangerous patterns
 * (e.g., patient with DVT reporting persistent headaches).
 */

import { pgTable, text, index, jsonb } from "drizzle-orm/pg-core";
import { patients } from "./patients.js";
import { encryptedText } from "../encryption.js";

export type ObservationType =
  | "pain"
  | "neurological"
  | "gastrointestinal"
  | "respiratory"
  | "skin"
  | "cardiovascular"
  | "general"
  | "medication_side_effect";

export interface ObservationStructuredData {
  location?: string; // body location for pain/skin
  severity: number; // 1-10 scale
  duration?: string; // e.g., "2 days", "since yesterday"
  frequency?: string; // e.g., "constant", "intermittent", "once"
  associated_activities?: string; // e.g., "after eating", "at rest"
}

export const patientObservations = pgTable("patient_observations", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  observation_type: text("observation_type").notNull(), // ObservationType
  description: encryptedText("description").notNull(), // encrypted free text
  structured_data: jsonb("structured_data").$type<ObservationStructuredData>(),
  severity_self_assessment: text("severity_self_assessment"), // mild, moderate, severe
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
}, (table) => [
  index("idx_patient_observations_patient").on(table.patient_id, table.created_at),
  index("idx_patient_observations_type").on(table.observation_type),
]);

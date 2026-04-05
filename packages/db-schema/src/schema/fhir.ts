import { pgTable, text, jsonb, index } from "drizzle-orm/pg-core";
import { patients } from "./patients.js";

export const fhirResources = pgTable("fhir_resources", {
  id: text("id").primaryKey(),
  resource_type: text("resource_type").notNull(), // Patient, Observation, MedicationStatement, etc.
  resource_id: text("resource_id").notNull(), // FHIR resource.id
  patient_id: text("patient_id").references(() => patients.id),
  resource: jsonb("resource").notNull(), // Full FHIR R4 resource
  source_system: text("source_system"),
  internal_record_id: text("internal_record_id"), // FK to our normalized record
  imported_at: text("imported_at").notNull(),
}, (table) => [
  index("idx_fhir_patient").on(table.patient_id, table.resource_type),
]);

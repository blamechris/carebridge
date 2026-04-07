import { pgTable, text, index } from "drizzle-orm/pg-core";
import { encryptedText } from "../encryption.js";
import { patients } from "./patients.js";
import { users } from "./auth.js";

export const encounters = pgTable("encounters", {
  id: text("id").primaryKey(),
  patient_id: text("patient_id").notNull().references(() => patients.id),
  encounter_type: text("encounter_type").notNull(), // inpatient, outpatient, emergency, telehealth
  status: text("status").notNull(), // planned, arrived, in-progress, finished, cancelled
  start_time: text("start_time").notNull(),
  end_time: text("end_time"),
  provider_id: text("provider_id").references(() => users.id),
  location: text("location"),
  reason: text("reason"),
  notes: encryptedText("notes"),
  created_at: text("created_at").notNull(),
}, (table) => [
  index("idx_encounters_patient").on(table.patient_id),
  index("idx_encounters_start_time").on(table.start_time),
]);

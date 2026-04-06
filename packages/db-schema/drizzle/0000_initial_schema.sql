-- CareBridge initial schema migration
-- All tables in dependency order

-- ============================================
-- Auth tables (no FK dependencies)
-- ============================================

CREATE TABLE IF NOT EXISTS "users" (
  "id" text PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "password_hash" text NOT NULL,
  "name" text NOT NULL,
  "role" text NOT NULL,
  "specialty" text,
  "department" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "users_email_unique" UNIQUE("email")
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "expires_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_sessions_user" ON "sessions" USING btree ("user_id");

CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "action" text NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "details" text,
  "ip_address" text,
  "timestamp" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_audit_user" ON "audit_log" USING btree ("user_id","timestamp");
CREATE INDEX IF NOT EXISTS "idx_audit_resource" ON "audit_log" USING btree ("resource_type","resource_id");

-- ============================================
-- Patient tables
-- ============================================

CREATE TABLE IF NOT EXISTS "patients" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "date_of_birth" text,
  "biological_sex" text DEFAULT 'unknown',
  "diagnosis" text,
  "notes" text,
  "mrn" text,
  "insurance_id" text,
  "emergency_contact_name" text,
  "emergency_contact_phone" text,
  "primary_provider_id" text,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  CONSTRAINT "patients_mrn_unique" UNIQUE("mrn")
);

CREATE TABLE IF NOT EXISTS "diagnoses" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "icd10_code" text,
  "description" text NOT NULL,
  "status" text NOT NULL DEFAULT 'active',
  "onset_date" text,
  "resolved_date" text,
  "diagnosed_by" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_diagnoses_patient" ON "diagnoses" USING btree ("patient_id","status");

CREATE TABLE IF NOT EXISTS "allergies" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "allergen" text NOT NULL,
  "reaction" text,
  "severity" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_allergies_patient" ON "allergies" USING btree ("patient_id");

CREATE TABLE IF NOT EXISTS "care_team_members" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "provider_id" text NOT NULL,
  "role" text NOT NULL,
  "specialty" text,
  "is_active" boolean NOT NULL DEFAULT true,
  "started_at" text NOT NULL,
  "ended_at" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_care_team_patient" ON "care_team_members" USING btree ("patient_id","is_active");

-- ============================================
-- Clinical data tables
-- ============================================

CREATE TABLE IF NOT EXISTS "medications" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "name" text NOT NULL,
  "brand_name" text,
  "dose_amount" real,
  "dose_unit" text,
  "route" text,
  "frequency" text,
  "status" text NOT NULL DEFAULT 'active',
  "started_at" text,
  "ended_at" text,
  "prescribed_by" text,
  "notes" text,
  "rxnorm_code" text,
  "ordering_provider_id" text,
  "encounter_id" text,
  "source_system" text DEFAULT 'internal',
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_medications_patient" ON "medications" USING btree ("patient_id","status");

CREATE TABLE IF NOT EXISTS "med_logs" (
  "id" text PRIMARY KEY NOT NULL,
  "medication_id" text NOT NULL REFERENCES "medications"("id"),
  "administered_at" text NOT NULL,
  "dose_amount" real,
  "dose_unit" text,
  "administered_by" text,
  "notes" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_med_logs_med" ON "med_logs" USING btree ("medication_id","administered_at");

CREATE TABLE IF NOT EXISTS "vitals" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "recorded_at" text NOT NULL,
  "type" text NOT NULL,
  "value_primary" real NOT NULL,
  "value_secondary" real,
  "unit" text NOT NULL,
  "notes" text,
  "provider_id" text,
  "encounter_id" text,
  "source_system" text DEFAULT 'internal',
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_vitals_patient_type" ON "vitals" USING btree ("patient_id","type","recorded_at");

CREATE TABLE IF NOT EXISTS "lab_panels" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "panel_name" text NOT NULL,
  "ordered_by" text,
  "collected_at" text,
  "reported_at" text,
  "notes" text,
  "ordering_provider_id" text,
  "encounter_id" text,
  "source_system" text DEFAULT 'internal',
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_lab_panels_patient" ON "lab_panels" USING btree ("patient_id","collected_at");

CREATE TABLE IF NOT EXISTS "lab_results" (
  "id" text PRIMARY KEY NOT NULL,
  "panel_id" text NOT NULL REFERENCES "lab_panels"("id"),
  "test_name" text NOT NULL,
  "test_code" text,
  "value" real NOT NULL,
  "unit" text NOT NULL,
  "reference_low" real,
  "reference_high" real,
  "flag" text,
  "notes" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_lab_results_panel" ON "lab_results" USING btree ("panel_id");
CREATE INDEX IF NOT EXISTS "idx_lab_results_name" ON "lab_results" USING btree ("test_name","created_at");

CREATE TABLE IF NOT EXISTS "procedures" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "name" text NOT NULL,
  "cpt_code" text,
  "icd10_codes" text,
  "status" text NOT NULL DEFAULT 'scheduled',
  "performed_at" text,
  "performed_by" text,
  "provider_id" text,
  "encounter_id" text,
  "notes" text,
  "source_system" text DEFAULT 'internal',
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_procedures_patient" ON "procedures" USING btree ("patient_id","status");

CREATE TABLE IF NOT EXISTS "events" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "occurred_at" text NOT NULL,
  "category" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "severity" text NOT NULL DEFAULT 'info',
  "provider_id" text,
  "encounter_id" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_events_patient" ON "events" USING btree ("patient_id","occurred_at");

-- ============================================
-- Clinical notes tables
-- ============================================

CREATE TABLE IF NOT EXISTS "clinical_notes" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "provider_id" text NOT NULL,
  "encounter_id" text,
  "template_type" text NOT NULL,
  "sections" jsonb NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "status" text NOT NULL DEFAULT 'draft',
  "signed_at" text,
  "signed_by" text,
  "cosigned_at" text,
  "cosigned_by" text,
  "copy_forward_score" real,
  "source_system" text DEFAULT 'internal',
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_notes_patient" ON "clinical_notes" USING btree ("patient_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_notes_provider" ON "clinical_notes" USING btree ("provider_id","created_at");
CREATE INDEX IF NOT EXISTS "idx_notes_status" ON "clinical_notes" USING btree ("status");

CREATE TABLE IF NOT EXISTS "note_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "note_id" text NOT NULL REFERENCES "clinical_notes"("id"),
  "version" integer NOT NULL,
  "sections" jsonb NOT NULL,
  "saved_at" text NOT NULL,
  "saved_by" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_note_versions" ON "note_versions" USING btree ("note_id","version");

-- ============================================
-- AI oversight tables
-- ============================================

CREATE TABLE IF NOT EXISTS "clinical_flags" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "source" text NOT NULL,
  "severity" text NOT NULL,
  "category" text NOT NULL,
  "summary" text NOT NULL,
  "rationale" text NOT NULL,
  "suggested_action" text NOT NULL,
  "notify_specialties" jsonb DEFAULT '[]',
  "trigger_event_ids" jsonb DEFAULT '[]',
  "status" text NOT NULL DEFAULT 'open',
  "resolution_note" text,
  "acknowledged_by" text,
  "acknowledged_at" text,
  "resolved_by" text,
  "resolved_at" text,
  "dismissed_by" text,
  "dismissed_at" text,
  "dismiss_reason" text,
  "model_id" text,
  "prompt_version" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_flags_patient" ON "clinical_flags" USING btree ("patient_id","status");
CREATE INDEX IF NOT EXISTS "idx_flags_severity" ON "clinical_flags" USING btree ("severity","status");

CREATE TABLE IF NOT EXISTS "clinical_rules" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "conditions" jsonb NOT NULL,
  "severity" text NOT NULL,
  "category" text NOT NULL,
  "suggested_action" text NOT NULL,
  "rationale_template" text NOT NULL,
  "enabled" integer NOT NULL DEFAULT 1,
  "created_at" text NOT NULL
);

CREATE TABLE IF NOT EXISTS "review_jobs" (
  "id" text PRIMARY KEY NOT NULL,
  "patient_id" text NOT NULL REFERENCES "patients"("id"),
  "status" text NOT NULL DEFAULT 'pending',
  "trigger_event_type" text NOT NULL,
  "trigger_event_id" text NOT NULL,
  "context_hash" text,
  "rules_evaluated" jsonb DEFAULT '[]',
  "rules_fired" jsonb DEFAULT '[]',
  "llm_request_tokens" integer,
  "llm_response_tokens" integer,
  "flags_generated" jsonb DEFAULT '[]',
  "processing_time_ms" integer,
  "error" text,
  "completed_at" text,
  "created_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_review_jobs_patient" ON "review_jobs" USING btree ("patient_id","status");

-- ============================================
-- Notification tables
-- ============================================

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" text PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL REFERENCES "users"("id"),
  "type" text NOT NULL,
  "title" text NOT NULL,
  "body" text,
  "link" text,
  "related_flag_id" text,
  "is_read" boolean NOT NULL DEFAULT false,
  "created_at" text NOT NULL,
  "read_at" text
);

CREATE INDEX IF NOT EXISTS "idx_notifications_user" ON "notifications" USING btree ("user_id","is_read","created_at");

-- ============================================
-- FHIR tables
-- ============================================

CREATE TABLE IF NOT EXISTS "fhir_resources" (
  "id" text PRIMARY KEY NOT NULL,
  "resource_type" text NOT NULL,
  "resource_id" text NOT NULL,
  "patient_id" text REFERENCES "patients"("id"),
  "resource" jsonb NOT NULL,
  "source_system" text,
  "internal_record_id" text,
  "imported_at" text NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_fhir_patient" ON "fhir_resources" USING btree ("patient_id","resource_type");

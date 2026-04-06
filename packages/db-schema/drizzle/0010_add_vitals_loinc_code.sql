-- Add LOINC code column to vitals table for FHIR R4 Observation.code compliance
ALTER TABLE "vitals" ADD COLUMN "loinc_code" text;

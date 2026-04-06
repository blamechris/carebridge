-- Add SNOMED CT code to diagnoses
ALTER TABLE "diagnoses" ADD COLUMN "snomed_code" text;

-- Add SNOMED CT and RxNorm codes to allergies
ALTER TABLE "allergies" ADD COLUMN "snomed_code" text;
ALTER TABLE "allergies" ADD COLUMN "rxnorm_code" text;

-- Convert procedures.icd10_codes from text to jsonb
ALTER TABLE "procedures" ALTER COLUMN "icd10_codes" TYPE jsonb USING icd10_codes::jsonb;

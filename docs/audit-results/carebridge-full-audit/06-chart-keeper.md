# Chart Keeper's Audit: CareBridge Full Platform

**Agent**: Chart Keeper — FHIR R4, ICD-10/CPT, clinical data modeling, EHR interoperability
**Overall Rating**: 2 / 5
**Date**: 2026-04-05

## Section Ratings

### 1. FHIR R4 Compliance — 1/5
- `packages/fhir-utils/src/index.ts:4-12` — entire package is stubs + `FHIR_VERSION = "R4"` constant
- `services/fhir-gateway/src/router.ts:29` — `patient_id: null` on all imports — data permanently orphaned
- `exportPatient` always returns `entry: []`
- No Capability Statement, no SMART on FHIR, no search API
- No FHIR resource mappers anywhere in the codebase

### 2. ICD-10 / CPT Code Usage — 2.5/5
- Seed ICD-10 codes are clinically accurate (C50.911, I82.401, E11.9, I10)
- `procedures.icd10_codes` stored as `text("icd10_codes")` — JSON array in a text column, not `jsonb`
- No format validation on `icd10_code` fields — any string accepted
- `labResults.test_code` described as LOINC but never validated
- Lab tests identified by free-text `test_name` — interoperability depends on name-matching

### 3. Clinical Data Modeling — 3/5
- Normalized schema (panels/results, medications/logs, notes/versions) is sound
- **All timestamps are `text` — no database-level temporal validation**
- `real` (float32) for lab values — insufficient precision for troponin, INR, digoxin
- `patients.diagnosis` free-text field duplicates structured `diagnoses` table — no sync mechanism
- `allergies` table has no SNOMED CT coding — free text only
- No `encounters` table despite 5 tables referencing `encounter_id`

### 4. EHR Interoperability — 1.5/5
- No HL7 v2 message handling
- No FHIR MedicationRequest/Observation mappers
- No MRN → FHIR Patient resolution
- `source_system` columns exist but nothing populates them from external imports

### 5. HIPAA-Adjacent Patterns — 2.5/5
- Audit log schema is appropriate
- `clinicalFlags` tracks model_id and prompt_version (good AI governance)
- Note signing/co-signing with timestamps (good non-repudiation)
- Full PHI sent to Claude API without minimum-necessary controls
- No data retention/purge policy
- `insurance_id` stored in plaintext

## Top 5 Findings

1. **FHIR gateway non-functional** — all imports unlinked from patients; export always empty
2. **ICD-10 codes in `text` not `jsonb`** — `clinical-data.ts:96` — unqueryable, unvalidatable
3. **All timestamps are `text`** — universal across all schemas — temporal ordering is lexicographic, not chronological
4. **Full PHI to LLM without minimum-necessary controls** — care team names, diagnoses, meds, labs all transmitted to Claude
5. **No `encounters` table** — `encounter_id` is an orphaned string key in 5 tables

## Additional Observations

- Cross-specialty rules are clinically sound (ONCO-VTE-NEURO-001 correctly identifies stroke risk pattern)
- Critical values use 2× range heuristic — misses troponin 0.05 (1.25× range deviation, still critical)
- `LabFlag = "H" | "L" | "critical"` — "critical" has no HL7 equivalent; needs translation for FHIR
- `MedStatus` missing "on-hold" and "entered-in-error" — important for anticoagulants

## Overall Rating: 2/5

Thoughtfully designed relational model with clinically sound AI rules. But the FHIR gateway is entirely non-functional, all timestamps are stored as unvalidated text, and the LLM pipeline transmits unredacted PHI without minimum-necessary controls. Not production-ready from a data integrity or regulatory standpoint.

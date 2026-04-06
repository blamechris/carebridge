# Chart Keeper's Audit: CareBridge Clinical Data Layer

**Agent**: Chart Keeper — FHIR R4, ICD-10/LOINC/RxNorm, clinical data modeling, HIPAA-adjacent patterns
**Overall Rating**: 2.5 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Patient Data Schema | 2/5 | Missing critical FHIR Patient fields; flat diagnosis on patient record |
| Clinical Data Schema | 3/5 | Solid structural bones; no LOINC codes |
| FHIR Gateway | 1/5 | Export returns empty Bundle; import drops patient linkage |
| ICD-10 / SNOMED / Coding | 2/5 | ICD-10 optional/unvalidated; SNOMED completely absent |
| PHI Encryption | 4/5 | Strong AES-256-GCM; patient name gap |
| Lab Results | 3/5 | Reference ranges present; no LOINC; numeric-only values |
| Vital Signs | 3/5 | Reasonable ranges; no LOINC; temperature in Fahrenheit |
| Medication Data | 3/5 | RxNorm field exists but optional and unvalidated |
| DVT Seed Scenario | 4/5 | Clinically realistic; missing RxNorm/LOINC codes |

---

## Top 5 Findings

### Finding 1 — FHIR Export Is a Non-Functional Stub

**File:** `services/fhir-gateway/src/router.ts:48-53`

```ts
exportPatient: t.procedure.input(z.object({ patientId: z.string() })).query(async () => {
  return { resourceType: "Bundle", type: "collection", entry: [] };
}),
```

Always returns an empty Bundle. `patientId` is declared but not referenced. Any downstream consumer (another EHR, payer, HIE) receives a conformant-looking but empty response.

**Import drops patient linkage (lines 26-34):** `patient_id` is hardcoded to `null` for every imported row. Every FHIR resource imported is orphaned with no patient association.

**FHIR R4 conformance failures:**
- Bundle must include Patient resource as first entry with `fullUrl`
- Patient must carry `id`, `meta.profile`, `identifier` (MRN with system URI), `name` as HumanName, `birthDate` as date not datetime
- None of these transformations exist; `packages/fhir-utils/src/index.ts` is a stub

**Fix:** Build FHIR Patient, Observation, MedicationStatement, Condition, and AllergyIntolerance generators. The import path needs a patient-resolution pass matching `Patient.identifier` against `mrn_hmac`.

---

### Finding 2 — No LOINC Codes on Vitals or Lab Results

**Files:**
- `packages/db-schema/src/schema/clinical-data.ts:41-56` (vitals — no LOINC column at all)
- `packages/shared-types/src/clinical-data.ts:103` (`test_code?: string; // LOINC code` — optional, not enforced)
- `packages/validators/src/clinical-data.ts:69` (`test_code: z.string().max(20).optional()` — no regex)
- `tooling/seed/index.ts:192-208` — all lab inserts omit `test_code`

FHIR R4 Observation for vitals/labs requires `Observation.code` as a CodeableConcept with LOINC coding (system `http://loinc.org`) — this is **SHALL** per US Core Vital Signs profile.

Standard vital LOINC mappings absent: HR→8867-4, systolic BP→8480-6, diastolic→8462-4, O2 sat→59408-5, temperature→8310-5, RR→9279-1, weight→29463-7, glucose→2339-0.

**Fix:** Add `loinc_code text` to the `vitals` table with a mapping enum for each `VitalType`. Enforce LOINC format (`/^\d{1,5}-\d$/`) in the lab validator. Populate codes in seed data.

---

### Finding 3 — Patient Name Is PHI and Is Stored in Plaintext

**File:** `packages/db-schema/src/schema/patients.ts:6`

```ts
name: text("name").notNull(),  // plaintext — first of 18 HIPAA Safe Harbor identifiers
```

`date_of_birth`, `mrn`, `insurance_id`, `emergency_contact_name`, and `emergency_contact_phone` all use `encryptedText`. Patient name — the most identifying field — is unprotected at the database layer.

**Secondary gap:** `patients.diagnosis` free-text field (line 10) is plaintext and duplicates the normalized `diagnoses` table. PHI leak vector.

**Fix:** Wrap `name` in `encryptedText`. Add `name_hmac` column for searchability (same HMAC-for-index pattern as MRN). Deprecate `patients.diagnosis` free-text field.

---

### Finding 4 — ICD-10 Optional and Unvalidated; SNOMED Absent

**Files:**
- `packages/db-schema/src/schema/patients.ts:29` — `icd10_code: text("icd10_code")` (nullable)
- `packages/validators/src/clinical-data.ts:86-97` — `icd10_codes: z.array(z.string().max(10)).optional()` (no format check)
- `packages/db-schema/src/schema/clinical-data.ts:96` — `icd10_codes: text` stored as JSON-in-text

ICD-10-CM format: `[A-Z]\d{2}(\.\d{1,4})?`. Codebase accepts any string up to 10 chars.

FHIR R4 Condition SHOULD include SNOMED CT coding (system `http://snomed.info/sct`) per US Core. `diagnoses` table has no SNOMED column. `allergies` table has no allergen substance coding.

`procedures.icd10_codes` stored as JSON-in-text instead of `jsonb` bypasses Postgres type safety.

**Fix:** Add ICD-10 format validation regex to validators. Add `snomed_code` to `diagnoses` table. Add `snomed_code`/`rxnorm_code` to `allergies`. Change `procedures.icd10_codes` from `text` to `jsonb`.

---

### Finding 5 — MedLens Token Store Is In-Memory

**File:** `services/fhir-gateway/src/medlens-bridge.ts:62-84`

```ts
const tokenStore = new Map<string, MedLensToken>();  // in-memory for dev; production uses DB
```

Tokens are lost on every process restart. Multi-instance deployments can't share state. Revoked tokens (`revokeToken`) are only revoked on the instance that holds the entry. Since MedLens tokens grant `write:vitals` and `write:labs` scopes, failed revocation is a PHI access control issue.

**Fix:** Persist tokens to a `medlens_tokens` database table or Redis with TTL. Store HMAC of token, not raw token.

---

## Additional Observations

- **`date_of_birth` validator uses `z.string().datetime()`** (`packages/validators/src/patient.ts:7`) — FHIR `Patient.birthDate` is a `date` (YYYY-MM-DD), not a `dateTime`. `"1958-03-15"` fails this validator. Schema/validator mismatch.
- **Temperature in Fahrenheit** (`packages/shared-types/src/clinical-data.ts:63`) — FHIR UCUM uses `Cel`. Requires conversion for FHIR export.
- **Lab `value` is always numeric** (`packages/db-schema/src/schema/clinical-data.ts:79`) — qualitative results (culture positivity, pregnancy test) cannot be stored.
- **Missing FHIR Patient fields:** `address`, `telecom`, `communication`, US Core `birthsex` extension.
- **`insurance_id` is a flat encrypted string** — cannot round-trip to a FHIR R4 Coverage resource without structural parsing.

---

## DVT Scenario Assessment

**Rating: 4/5** — Clinically realistic and internally consistent.

- ICD-10 codes (`C50.911`, `I82.401`, `Z95.828`) are valid and appropriate
- Medications (capecitabine, enoxaparin, ondansetron) are correct for the scenario with realistic dosing
- Labs (WBC 3.8, Hgb 10.2, D-Dimer 680, INR 1.0) are coherent with cancer-associated VTE on LMWH
- Vitals are plausible for an oncology patient

**Gaps:** Missing RxNorm codes on all medications. No LOINC on any lab result. Missing weight (critical for chemo dosing) and respiratory rate.

---

## Overall Rating: 2.5/5

The CareBridge clinical data layer has strong encryption architecture and a clinically coherent DVT seed scenario. However it cannot claim FHIR R4 conformance in any operational sense: the export endpoint returns an empty Bundle, there are zero LOINC codes anywhere in the schema, SNOMED is entirely absent, and the FHIR utility package is a stub. Patient name — the first of the 18 HIPAA Safe Harbor identifiers — is stored in plaintext. ICD-10 codes are optional and format-unvalidated. Until LOINC mapping, SNOMED support, a real FHIR resource generator, and encrypted patient name are implemented, this system would fail an ONC certification audit.

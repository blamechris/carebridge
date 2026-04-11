# Chart Keeper Audit: Marathon Session Clinical Data Review

**Auditor Role:** Healthcare Data Architect (FHIR R4, ICD-10, Clinical Modeling, HIPAA)  
**Date:** 2026-04-10  
**Scope:** 19 PRs — clinical safety rules, patient observations, messaging, scheduling, emergency access

---

## Area Ratings (1-5, where 5 = production-ready for clinical use)

### 1. Patient Observations Schema — 3/5

**Strengths:**
- Encrypted free-text descriptions (HIPAA-aligned)
- Clear separation from clinical chart (documented as "Patient Signals")
- Structured data type with severity, location, duration, frequency

**Concerns:**
- `severity` in `ObservationStructuredData` uses a numeric 1-10 scale but there is no validation enforced at the schema level; patients could submit 0 or 99 (`patient-observations.ts:29`)
- No FHIR Observation resource alignment — missing `effectiveDateTime` vs `issued`, no `code` field for LOINC/SNOMED binding, no `status` field (registered/preliminary/final). FHIR R4 Observation requires a `status` and a `code`
- `observation_type` is a free text column with no DB-level constraint — the TypeScript type `ObservationType` is only compile-time enforcement (`patient-observations.ts:38`)
- No `reviewed_by` or `reviewed_at` field — no way to track whether a provider has acknowledged a patient-reported observation
- `duration` stored as free text ("2 days", "since yesterday") rather than ISO 8601 duration (P2D) — not machine-parseable for AI rules

### 2. Allergy-Medication Cross-Check — 4/5

**Strengths:**
- Comprehensive drug class mapping covering major clinical categories (penicillins, cephalosporins, sulfonamides, NSAIDs, opioids, fluoroquinolones, ACE inhibitors, statins, macrolides, tetracyclines, benzodiazepines, contrast, latex)
- Correctly models penicillin-cephalosporin cross-reactivity (~2% risk) as a separate entry (`allergy-medication.ts:38-41`)
- Appropriate severity escalation: unknown allergy severity defaults to critical (`allergy-medication.ts:112`)
- Pharmacy notification on all flags

**Concerns:**
- Module-level mutable `ruleSequence` counter (`allergy-medication.ts:116`) — not safe for concurrent workers or process restarts; rule IDs will collide across worker instances
- No RxNorm code-based matching despite the doc comment claiming it (`allergy-medication.ts:7`) — only regex pattern matching is implemented
- Missing carbapenem cross-reactivity with penicillins (clinically relevant ~1% cross-reactivity)
- `dapsone` listed under sulfonamide class (`allergy-medication.ts:44`) — dapsone is a sulfone, not a sulfonamide; cross-reactivity is debated and should at minimum be a lower-severity flag
- Celecoxib listed under NSAIDs (`allergy-medication.ts:49`) — celecoxib (COX-2 selective) has significantly lower cross-reactivity risk with non-selective NSAID allergies; should be differentiated

### 3. Message Screening Patterns — 4.5/5

**Strengths:**
- Clinically appropriate critical vs warning severity differentiation
- Excellent coverage: chest pain, dyspnea, thunderclap headache, bleeding, stroke (FAST criteria), suicidal ideation, anaphylaxis, febrile neutropenia awareness, falls (anticoagulant context), new weakness
- Appropriate specialty routing (cardiology, neurology, psychiatry, hematology, etc.)
- Correct: only screens patient-originated messages (`message-screening.ts:175`)
- Does NOT auto-reply to patients — only creates internal flags (`message-screening.ts:10`)

**Concerns:**
- Fever pattern `temperature\s*(of\s*)?(10[1-9]|1[1-9]\d)` (`message-screening.ts:126`) matches 101-199 but misses Celsius reports (38.5C) — international patients may report in Celsius
- No pattern for "overdose" / "took too many" / medication ingestion emergencies
- Suicidal ideation pattern (`message-screening.ts:99`) does not include "self-harm", "cutting myself", "hurt myself" which are common expressions requiring crisis response

### 4. Medication Reconciliation — 3.5/5

**Strengths:**
- Correct trigger point: fires on encounter status transition to "finished" (`medication-reconciliation.ts:34`)
- Catches both missing medications and dose changes
- Appropriate severity: missing meds get "warning", dose changes get "info"
- Excludes intentionally discontinued medications (`medication-reconciliation.ts:83`)

**Concerns:**
- Comparison logic is name-based (`toLowerCase()`) rather than RxNorm/NDC code-based (`medication-reconciliation.ts:80`). "Advil" vs "Ibuprofen 200mg" would appear as different medications
- Only compares against the single most recent prior encounter (`medication-reconciliation.ts:53-56`). A medication started 3 encounters ago but missing from the last encounter won't be caught
- No frequency change detection — only dose amount is compared (`medication-reconciliation.ts:109`). Changing from BID to QD is clinically significant
- Race condition: queries "active" medications at the moment the check runs rather than snapshotting the medication list at encounter time

### 5. Emergency Access (Break-the-Glass) — 4/5

**Strengths:**
- Time-limited access with explicit `expires_at` (`emergency-access.ts:20`)
- Revocation support with `revoked_at` and `revoked_by` (`emergency-access.ts:21-22`)
- Justification is encrypted at rest (appropriate — contains sensitive reasoning)
- Index on `expires_at` for efficient expired-access cleanup

**Concerns:**
- No `access_level` field — HIPAA emergency access provisions (45 CFR 164.312(a)(2)(ii)) recommend documenting the scope of access granted, not just that access occurred
- No `emergency_type` classification (life-threatening, urgent care coordination, disaster) — different emergency types warrant different audit review intensity
- Missing constraint or application-level enforcement of maximum access duration — a bug could grant indefinite access
- No explicit linkage to an audit trail entry — the `id` should cross-reference an `audit_log` entry for the access event

### 6. Scheduling — 3/5

**Strengths:**
- Covers core appointment lifecycle statuses (scheduled, confirmed, checked_in, completed, cancelled, no_show)
- Provider schedule templates with day-of-week recurrence
- Schedule blocks for vacations/meetings
- Cancellation tracking with reason, timestamp, and who cancelled

**Concerns:**
- No `recurring` or `series_id` for recurring appointments (common in oncology: weekly chemo, dialysis)
- No `priority` field — urgent/stat appointments need different handling than routine follow-ups
- No `department_id` or multi-provider support — many clinical appointments involve multiple providers (surgeon + anesthesiologist)
- `location` is free text — no structured reference to facility/room/telehealth-link; FHIR Schedule uses `actor` and `Location` references
- No `service_type` coded field — FHIR uses `serviceType` with standardized coding (SNOMED CT)
- `is_active` stored as text "true"/"false" rather than boolean (`scheduling.ts:43`) — error-prone

### 7. Notification Preferences — 3.5/5

**Strengths:**
- Per-type, per-channel granularity
- Quiet hours support
- Simple, clear schema

**Concerns:**
- No override mechanism for critical/escalated flags — a provider's quiet hours should NOT suppress critical clinical alerts (this is a patient safety issue)
- No `escalation_channel` — when quiet hours are active for in_app, critical flags should auto-route to SMS/phone
- No role-based defaults — every user must manually configure preferences; there should be role-based defaults (physicians get all ai-flags by default)
- Only three channels (in_app, email, sms) — no push notification or pager integration, which are standard in healthcare

---

## Top 5 Clinical Modeling Concerns

1. **No critical alert override for quiet hours** (`notification-preferences.ts:17-18`): A provider with quiet hours set could miss a critical escalation. HIPAA and Joint Commission standards require that life-safety notifications bypass user preferences. This is the highest-risk finding.

2. **Medication matching is name-based, not code-based** (`allergy-medication.ts:138`, `medication-reconciliation.ts:80`): Both the allergy cross-check and medication reconciliation rely on string matching of medication names. In real clinical data, the same drug appears as brand names, generics, with dose suffixes, and abbreviations. Without RxNorm/NDC normalization, both systems will have high false-negative rates.

3. **Patient observations lack FHIR alignment** (`patient-observations.ts:35-47`): No `status`, no `code` (LOINC/SNOMED), no `effectivePeriod`. If this data ever needs to flow to external systems (HIE, referrals, FHIR API), it will require a complete remodel. The current structure is not interoperable.

4. **Module-level mutable state in allergy rule** (`allergy-medication.ts:116`): `ruleSequence` is a module-global counter that increments on every call. In a BullMQ worker environment with potential restarts, this produces non-unique rule IDs. If two workers process events concurrently, IDs will collide. Rule IDs should be deterministic (e.g., hash of allergen + medication + patient).

5. **Emergency access has no maximum duration enforcement** (`emergency-access.ts:14-27`): The schema stores `expires_at` but nothing enforces a ceiling. A programmatic error or malicious actor could set `expires_at` to 100 years from now. HIPAA emergency access should have a hard maximum (typically 24-72 hours) enforced at the database constraint level.

---

## Recommendations for Clinical Safety Improvements

### Immediate (Patient Safety Risk)

1. **Add critical-alert bypass in notification routing.** When severity is "critical" or "escalated", ignore quiet hours and deliver via all available channels. File: `notification-preferences.ts` + notification dispatch worker logic.

2. **Replace module-level `ruleSequence`** with deterministic rule IDs (e.g., `ALLERGY-MED-${hash(patientId + allergen + medication)}`). File: `allergy-medication.ts:116`.

3. **Add "overdose/ingestion" and "self-harm" patterns** to message screening. These are common patient safety gaps. File: `message-screening.ts`.

### Short-Term (Clinical Correctness)

4. **Implement RxNorm ingredient-level matching** for allergy cross-checks and medication reconciliation. Even a static lookup table of RxNorm CUI to ingredient class would dramatically reduce false negatives.

5. **Add `reviewed_by`/`reviewed_at` to patient observations** — providers need to sign off on patient-reported data before it influences clinical decisions.

6. **Add database CHECK constraint on `expires_at`** for emergency access: `expires_at <= granted_at + interval '72 hours'`.

### Medium-Term (Interoperability & Standards)

7. **Align patient observations with FHIR Observation** resource structure: add `status`, `code` (LOINC), `effectiveDateTime`, `valueQuantity`.

8. **Add coded service types and structured locations** to scheduling schema. Reference FHIR `Appointment.serviceType` and `Appointment.participant`.

9. **Add frequency change detection** to medication reconciliation — dose is only one dimension of a prescribing change.

---

## Overall Rating: 3.5 / 5

**Verdict:** The marathon session produced a functionally coherent clinical safety layer with good architectural instincts — encrypted PHI, appropriate severity escalation, specialty-aware routing, and time-bounded emergency access. However, the implementation relies heavily on string-matching heuristics rather than standardized clinical terminologies (RxNorm, LOINC, SNOMED CT), which will produce unacceptable false-negative rates in production with real clinical data. The most urgent safety gap is the notification preference system's failure to exempt critical alerts from quiet hours — a provider sleeping through an escalated flag because their quiet hours suppressed it is a scenario that ends in patient harm. Before go-live, the platform needs terminology service integration, FHIR resource alignment for interoperability, and hard enforcement of emergency access duration limits.

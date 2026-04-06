# Master Assessment: CareBridge Post-Remediation Audit

**Date**: 2026-04-06
**Branch**: `main` (post 35-PR remediation)
**Agents**: 8 (4 core, 4 extended)
**Aggregate Rating**: **3.3 / 5**

---

## a. Auditor Panel

| Agent | Perspective | Rating | Key Contribution |
|---|---|---|---|
| Skeptic | Claims vs reality | 3.5/5 | BullMQ worker bypasses RBAC; HMAC key fallback |
| Builder | Implementability & wiring | 3.3/5 | FHIR export still stub; MedLens doesn't persist |
| Guardian | Security/HIPAA | 2.8/5 | Clinical narratives unencrypted; PHI redaction incomplete; no TLS |
| Minimalist | Complexity reduction | 2.2/5 | 6 duplicate FHIR types; fhir-utils still exists; repo over-abstraction |
| Adversary | Attack surface | 3.5/5 | FHIR gateway unprotected; dev auth exploitable; bundle injection |
| Chart Keeper | FHIR/clinical data | 4.0/5 | LOINC 100% correct; UCUM units need mapping; missing encounters |
| Oversight | LLM/AI safety | 3.5/5 | medication-safety missing from validator; semantic injection possible |
| Operator | Clinician UX | 3.2/5 | No confirmation on flag dismiss; no mobile; WCAG failures |

---

## b. Consensus Findings (5/8+ agents agree)

### C1 — FHIR Gateway Endpoints Have No Auth or RBAC
**Agreed by:** Skeptic, Builder, Guardian, Adversary, Operator (5/8)

All FHIR endpoints (exportPatient, getByPatient, importBundle) use bare `t.procedure` with no authentication. Any unauthenticated caller can read FHIR resources for any patient or inject arbitrary FHIR bundles. Direct HIPAA violation.

**Fix:** Add protectedProcedure + assertPatientAccess to all FHIR endpoints.

---

### C2 — Clinical Data Fields (medications, diagnoses, notes) Stored in Plaintext
**Agreed by:** Skeptic, Guardian, Adversary, Chart Keeper, Operator (5/8)

While patient demographics (name, DOB, MRN) are encrypted with AES-256-GCM, clinical narratives remain plaintext: medications.name, diagnoses.description, allergies.reaction, clinicalNotes.sections, and all *.notes fields. A database breach exposes clinical PHI.

**Fix:** Apply `encryptedText()` to sensitive clinical fields. Migration required.

---

### C3 — PHI Redaction Before Claude API Is Incomplete
**Agreed by:** Skeptic, Guardian, Adversary, Oversight (4/8)

The phi-sanitizer redacts provider names and patient ages, but patient names, MRNs, exact dates, facility names, and diagnosis codes flow verbatim to the external Claude API. The minimum-necessary principle is violated.

**Fix:** Expand redactor patterns to cover patient names, MRN formats, specific dates, facility names.

---

### C4 — No Confirmation Dialog on Critical Clinical Flag Actions
**Agreed by:** Builder, Guardian, Operator, Oversight (4/8)

A clinician can dismiss a critical clinical alert with a single click. No confirmation modal, no reason capture, no audit trail. Flag actions are client-only state — not persisted to the database.

**Fix:** Add confirmation modal with reason field. Persist flag status changes to DB with user_id and timestamp.

---

### C5 — No Mobile/Tablet Responsiveness in Clinical Portal
**Agreed by:** Operator, Builder, Guardian (3/8 — strong agreement from UX-focused agents)

Zero CSS media queries. Fixed 240px sidebar makes the app unusable on tablets at bedside. Clinical workflows demand mobile/tablet support.

**Fix:** Add responsive breakpoints; collapsible sidebar; touch-friendly targets.

---

## c. Contested Points

### Point 1: Should clinical data fields be encrypted?

**Guardian:** All PHI fields must be encrypted at rest per HIPAA 164.312(a)(2)(i). medications.name, diagnoses.description are plaintext PHI.

**Builder:** Field-level encryption on high-cardinality clinical data (vitals, labs) impacts query performance. Database-level encryption (pgcrypto or disk encryption) is sufficient for HIPAA compliance.

**Resolution:** Encrypt narrative/descriptive fields (diagnosis descriptions, medication names, notes). Leave numeric values (vital measurements, lab values) unencrypted but ensure database-level encryption at rest.

---

### Point 2: Repository abstraction — keep or collapse?

**Minimalist:** 4 repository files in clinical-data are over-abstraction. Inline into router.

**Builder:** Repository layer provides testability (mock at repo boundary). Keep for complex queries; inline trivial CRUD.

**Resolution:** Keep repositories but consolidate into fewer files. Remove identity-mapping functions.

---

## d. Factual Corrections

| Claim | Reality |
|---|---|
| "PHI is sanitized before reaching the LLM" | Only provider names and ages redacted; patient names, MRNs, dates pass through |
| "FHIR export returns populated Bundle" | exportPatient still returns empty Bundle on main (implementation in branch) |
| "All patient data endpoints enforce RBAC" | FHIR gateway endpoints have no auth at all |
| "medication-safety is a valid flag category" | Not in phi-sanitizer validator VALID_CATEGORIES or flagCategorySchema |

---

## e. Risk Heatmap

```
Impact
  HIGH | C2:PHI       C1:FHIR     C3:Redact  |
       | plaintext    no auth     incomplete |
       |                                     |
  MED  | cookies     .env in     no TLS     | C4:no confirm
       | no flags    git         no headers | C5:no mobile
       |                                     |
  LOW  | FHIR types  vitest      RBAC cache | UCUM units
       | duplicate   configs     60s stale  | route codes
       +-------------------------------------+
           LOW         MED         HIGH
                     Likelihood
```

---

## f. Recommended Action Plan

### P0 — Security Critical (Before Any Real PHI)

| # | Action | Files | Effort |
|---|---|---|---|
| 1 | Add auth + RBAC to all FHIR gateway endpoints | `services/fhir-gateway/src/router.ts` | 2h |
| 2 | Encrypt clinical narrative fields (meds, diagnoses, notes) | `packages/db-schema/src/schema/clinical-data.ts`, `notes.ts` + migration | 4h |
| 3 | Expand PHI redactor — patient names, MRNs, dates, facilities | `packages/phi-sanitizer/src/redactor.ts` | 3h |
| 4 | Add cookie security flags (HttpOnly, Secure, SameSite) | `services/api-gateway/src/middleware/auth.ts` | 1h |
| 5 | Remove .env from git; add to .gitignore | `.env`, `.gitignore` | 15m |
| 6 | Make PHI_HMAC_KEY mandatory in production | `packages/db-schema/src/encryption.ts` | 30m |
| 7 | Rate-limit refreshSession endpoint (5/min) | `services/api-gateway/src/server.ts` | 30m |
| 8 | Add "medication-safety" to validator enums | `packages/phi-sanitizer/src/llm-validator.ts`, `packages/validators/src/ai-flags.ts` | 15m |

### P1 — HIPAA Compliance / Clinical Safety

| # | Action | Files | Effort |
|---|---|---|---|
| 9 | Add security headers (HSTS, CSP, X-Content-Type-Options) | `services/api-gateway/src/server.ts` | 1h |
| 10 | Add confirmation modal for flag acknowledge/dismiss | `apps/clinician-portal/app/patients/[id]/page.tsx`, `inbox/page.tsx` | 4h |
| 11 | Persist flag actions to DB with audit trail | `services/ai-oversight/src/router.ts` + migration | 3h |
| 12 | Validate FHIR bundle schema on import | `services/fhir-gateway/src/router.ts` | 2h |
| 13 | Sanitize triggerEvent.data JSON fields before prompt | `services/ai-oversight/src/workers/context-builder.ts` | 1h |
| 14 | Handle Claude API rate-limit errors (respect Retry-After) | `services/ai-oversight/src/services/claude-client.ts` | 1h |
| 15 | Add audit log retention policy (6+ years for HIPAA) | Documentation + archival script | 2h |
| 16 | Reduce RBAC cache TTL from 60s to 5s | `services/api-gateway/src/middleware/rbac.ts` | 15m |

### P2 — UX / Quality / Clinical Data

| # | Action | Files | Effort |
|---|---|---|---|
| 17 | Add mobile responsive CSS (tablet breakpoints) | `apps/clinician-portal/app/globals.css` | 16h |
| 18 | Add ARIA labels and keyboard navigation | Multiple portal files | 8h |
| 19 | Add UCUM unit mapping for lab results | `services/fhir-gateway/src/generators/observation.ts` | 2h |
| 20 | Add SNOMED route coding to MedicationStatement | `services/fhir-gateway/src/generators/medication-statement.ts` | 1h |
| 21 | Consolidate FHIR type definitions (6 duplicates) | `services/fhir-gateway/src/generators/*.ts`, `types/` | 1h |
| 22 | Delete empty fhir-utils package | `packages/fhir-utils/` | 15m |
| 23 | Fix vitest config duplicate resolve blocks | `services/auth/vitest.config.ts`, `services/fhir-gateway/vitest.config.ts` | 15m |
| 24 | Rename CHEMO-NEUTRO-FEVER rule or add ANC check | `services/ai-oversight/src/rules/cross-specialty.ts` | 30m |
| 25 | Fix AllergyIntolerance criticality mapping | `services/fhir-gateway/src/generators/allergy-intolerance.ts` | 30m |
| 26 | Add encounters table to schema | `packages/db-schema/src/schema/` + migration | 3h |
| 27 | Fix patient portal MFA error | `apps/patient-portal/app/login/page.tsx` | 2h |
| 28 | Implement MedLens data persistence | `services/fhir-gateway/src/medlens-bridge.ts` | 3h |
| 29 | Add vitals trending graph | `apps/clinician-portal/app/patients/[id]/page.tsx` | 4h |
| 30 | Implement notes UI | `apps/clinician-portal/app/notes/` | 8h |

---

## g. Final Verdict

**Aggregate Rating: 3.3 / 5**
*(Core panel: 4 agents x 1.0x weight, avg 2.95; Extended panel: 4 agents x 0.8x weight, avg 3.55)*

CareBridge has made substantial progress from the initial 2.5/5 audit. The 35-PR remediation wave fixed the most critical architectural issues: ClinicalEvent type mismatch, RBAC enforcement on clinical data, CORS hardening, BullMQ retry/DLQ, and PHI sanitizer wiring. The codebase now has 200+ tests, FHIR R4 resource generators with 100% correct LOINC codes, and a functional MFA flow.

However, significant gaps remain for HIPAA production readiness. The FHIR gateway is completely unprotected — any unauthenticated caller can read patient FHIR data. Clinical narratives (medication names, diagnosis descriptions, clinical notes) are stored in plaintext. The PHI redactor only masks provider names and ages before sending to Claude, leaving patient names and MRNs exposed. The clinician portal has no confirmation dialogs for critical actions and is unusable on tablets. These P0/P1 items represent approximately 2-3 weeks of focused work before the system can safely handle real patient data.

---

## h. Appendix — Individual Reports

| Agent | File | Rating |
|---|---|---|
| Skeptic | [01-skeptic.md](./01-skeptic.md) | 3.5/5 |
| Builder | [02-builder.md](./02-builder.md) | 3.3/5 |
| Guardian | [03-guardian.md](./03-guardian.md) | 2.8/5 |
| Minimalist | [04-minimalist.md](./04-minimalist.md) | 2.2/5 |
| Adversary | [05-adversary.md](./05-adversary.md) | 3.5/5 |
| Chart Keeper | [06-chart-keeper.md](./06-chart-keeper.md) | 4.0/5 |
| Oversight | [07-oversight.md](./07-oversight.md) | 3.5/5 |
| Operator | [08-operator.md](./08-operator.md) | 3.2/5 |

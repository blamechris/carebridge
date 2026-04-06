# Skeptic's Audit: CareBridge Post-Remediation

**Agent**: Skeptic — Cynical systems engineer; claims vs reality
**Overall Rating**: 3.5 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Auth/Sessions | 4/5 | JWT via jose solid; HMAC key fallback to SESSION_SECRET risky |
| RBAC/Access Control | 4/5 | Enforced everywhere; refreshSession not rate-limited separately |
| PHI Encryption | 4/5 | AES-256-GCM correct; clinical data fields (meds, diagnoses) unencrypted |
| AI Oversight Pipeline | 3/5 | Worker fetches patient data with no RBAC; truncation silent |
| FHIR Gateway | 3/5 | Generators built; RBAC not enforced on FHIR endpoints |
| Audit Logging | 4/5 | Comprehensive; retention policy missing; worker events not logged |
| Error Handling | 3/5 | Generic auth errors good; async errors lack observability |

---

## Top 5 Findings

### Finding 1 — BullMQ Worker Fetches Patient Data Without RBAC
**File:** `services/ai-oversight/src/services/review-service.ts:246-281`
The review worker calls `buildPatientContextForRules()` which reads all diagnoses and medications for any patient_id from the queue — no RBAC check, no user context.

### Finding 2 — Refresh Token Endpoint Not Rate-Limited
**File:** `services/api-gateway/src/server.ts:70-86`
Global 100 req/min applies to refreshSession. Should be 5/min like login.

### Finding 3 — HMAC Key Falls Back to Encryption Key
**File:** `packages/db-schema/src/encryption.ts:116-124`
PHI_HMAC_KEY defaults to PHI_ENCRYPTION_KEY. Compromise of one compromises both.

### Finding 4 — Clinical Data Fields Not Encrypted
**File:** `packages/db-schema/src/schema/clinical-data.ts`
medications.name, diagnoses.description, all *.notes fields are plaintext.

### Finding 5 — No RBAC on FHIR Gateway Endpoints
**File:** `services/fhir-gateway/src/router.ts`
FHIR endpoints use bare t.procedure — no auth or patient access checks.

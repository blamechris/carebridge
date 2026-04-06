# Guardian's Audit: CareBridge Post-Remediation

**Agent**: Guardian — Paranoid security/SRE; HIPAA compliance
**Overall Rating**: 2.8 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| PHI at rest | 3.5/5 | Patient PII encrypted; clinical narratives plaintext |
| PHI in transit | 3/5 | No cookie security flags; no security headers |
| PHI to external (Claude) | 2.5/5 | Redacts providers/ages only; patient names/MRNs/dates leak |
| Session security | 3.5/5 | JWT+refresh solid; 15min idle too long for HIPAA |
| HIPAA audit trail | 4/5 | Comprehensive; not tamper-protected; no retention policy |
| Access control | 4.5/5 | Strong RBAC; minor cache staleness |
| Encryption key mgmt | 2.5/5 | Keys in .env; HMAC fallback; no rotation schedule |
| Network security | 2/5 | No TLS; no security headers (HSTS, CSP) |
| Error handling | 3/5 | Generic auth errors; worker logs may leak PHI |
| Backup/DR | 1.5/5 | No backup strategy; no replication; no PITR |

---

## Top 5 HIPAA Findings

### Finding 1 — Unencrypted Clinical Narratives
**Files:** `packages/db-schema/src/schema/clinical-data.ts`, `packages/db-schema/src/schema/notes.ts`
clinicalNotes.sections (JSONB), diagnoses.description, allergies.reaction, all *.notes fields are plaintext PHI.

### Finding 2 — Incomplete PHI Redaction Before Claude
**File:** `packages/phi-sanitizer/src/redactor.ts:59-143`
Only redacts provider names and ages. Patient names, MRNs, exact dates, diagnosis codes sent verbatim.

### Finding 3 — Secrets in Git-Tracked .env
**File:** `.env:16,22-23`
PHI_ENCRYPTION_KEY, JWT_SECRET, REDIS_PASSWORD committed. If .env exposed, all PHI compromised.

### Finding 4 — Missing Cookie Security Flags
**File:** `services/api-gateway/src/middleware/auth.ts:84-88`
Session cookies parsed without HttpOnly, Secure, SameSite flags. XSS can steal sessions.

### Finding 5 — Audit Log Not Tamper-Protected
**File:** `packages/db-schema/src/schema/auth.ts:34-49`
audit_log table has no immutability; any DB user can DELETE or UPDATE records.

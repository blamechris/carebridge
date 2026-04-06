# Adversary's Audit: CareBridge Post-Remediation

**Agent**: Adversary — Red-team specialist; exploitable vulnerabilities
**Overall Rating**: 3.5 / 5
**Date**: 2026-04-06

---

## Section Ratings

| Area | Rating | Notes |
|---|---|---|
| Authentication Bypass | 3/5 | Dev auth exploitable in staging; JWT key derivation weak |
| Authorization Bypass | 3/5 | FHIR gateway completely unprotected |
| Injection Attacks | 2/5 | Drizzle prevents SQLi; FHIR bundle accepts any JSON |
| Data Exfiltration | 4/5 | Multiple leak vectors via unprotected endpoints |
| Privilege Escalation | 2/5 | Role enforcement present |
| Denial of Service | 3/5 | Rate limiting exists but circumventable |
| Cryptographic Issues | 2/5 | AES-256-GCM correct; SHA-256 for JWT key derivation weak |
| Supply Chain | 2/5 | No obvious CVEs |

---

## Top 5 Exploitable Findings

### Finding 1 — FHIR Gateway Unprotected (CRITICAL)
**File:** `services/fhir-gateway/src/router.ts`
All FHIR endpoints use `publicProcedure`. getByPatient returns all FHIR resources for any patientId without auth. importBundle accepts arbitrary JSON.

### Finding 2 — Dev Auth Bypass Exploitable in Non-Production
**File:** `services/api-gateway/src/middleware/auth.ts:10-45`
Hardcoded DEV_USERS map with admin role. Header `x-dev-user-id: dev-admin` grants full admin access when CAREBRIDGE_DEV_AUTH=true.

### Finding 3 — FHIR Bundle Injection / Data Poisoning
**File:** `services/fhir-gateway/src/router.ts:12-37`
importBundle uses `z.any()` for bundle validation. Attacker can inject malicious FHIR resources including prompt injection payloads that flow to Claude via context builder.

### Finding 4 — JWT Key Derivation Uses Simple SHA-256
**File:** `services/auth/src/jwt.ts:6-13`
JWT_SECRET hashed with SHA-256 (no salt, no KDF). Short secrets have low entropy. REFRESH_TOKEN_HMAC_KEY falls back to hardcoded dev key.

### Finding 5 — RBAC Cache Race Condition (60s Window)
**File:** `services/api-gateway/src/middleware/rbac.ts:35-114`
60-second cache TTL means revoked care-team access persists for up to 60 seconds. No event-based invalidation.

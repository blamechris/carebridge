# Guardian's Audit: CareBridge Full Platform

**Agent**: Guardian — Paranoid SRE who designs for 3am pages
**Overall Rating**: 1.5 / 5
**Date**: 2026-04-05

## Section Ratings

### 1. Authentication & Session Management — 1/5
- `x-dev-user-id` bypass: `auth.ts:41` — live in any non-production env
- `services/auth/src/router.ts:39-47`: `"hashed:${password}"` — plaintext storage
- `createUser: publicProcedure` — unauthenticated admin self-registration
- Session cookies not set with HttpOnly/Secure/SameSite
- No brute-force protection

### 2. Authorization (RBAC) — 1/5
- `services/clinical-data/src/router.ts:17`: `initTRPC.create()` — no auth context
- All mutations and queries publicly callable
- `sign` procedure: `signed_by` is client-supplied — anyone can forge a physician signature
- No patient-provider relationship enforcement

### 3. Audit Logging — 2/5
- Fires `onResponse` — crash between response and DB write loses the audit record
- `resource_id` is always `""` for tRPC calls — no patient identified
- `details` column never populated
- No immutability — audit records can be deleted
- Failure silently swallowed: `audit.ts:84-86`

### 4. BullMQ / AI Oversight Failure Modes — 2/5
- Redis has no auth: `docker-compose.yml:8-14` — anyone can inject clinical events
- Hardcoded `localhost` in publishers: `clinical-data/src/events.ts:12`
- No DLQ; worker failure silently drops clinical events
- Race condition: two concurrent workers can both create the same flag

### 5. PHI Protection & Encryption — 1/5
- No column encryption — all PHI in plaintext
- No TLS on API or database
- Full PHI (diagnoses, meds, vitals, labs) sent to Claude API without BAA verification
- DB credentials hardcoded as fallback: `packages/db-schema/src/connection.ts:9-10`

## Top 5 Critical Findings

1. **Hardcoded auth bypass** — `auth.ts:41,56-83` — one header = full admin in any non-prod env
2. **Unauthenticated admin registration** — `auth/src/router.ts:139` — public endpoint, any role
3. **All clinical data endpoints unauthenticated** — `clinical-data/router.ts:17` — every record readable/writable
4. **PHI to external LLM without BAA** — `context-builder.ts:30-202` + `claude-client.ts:44-55`
5. **Redis unauthenticated, BullMQ hardcoded** — `docker-compose.yml`, `clinical-data/src/events.ts:12`

## Overall Rating: 1.5/5

NOT PRODUCTION-READY. Do not expose to real patient data. Passwords are plaintext. Admin self-registration is open. All clinical endpoints are unauthenticated. PHI goes to an external API without de-identification or guaranteed BAA. Redis is open. These are compounding failures, not individual gaps.
